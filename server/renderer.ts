// Deterministic renderer and PNG export (ticket 11).
//
// Preview equals export by construction: the Studio live preview and this
// server-side renderer render the same shared React component
// (render/piece-slide.tsx). `renderPreview` returns the rendered slide HTML
// for any version in a piece's history; `exportPiece` screenshots that same
// HTML in headless Chromium, one PNG per slide, plus a captions file, into a
// bundle recorded with the doc version and kit version it was rendered from.
// Rendering resolves Brand Kit tokens at render time (ticket 12), so the
// bundle records the kit version it was rendered through alongside the doc
// version.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import { currentKit } from "./brand-kit";
import { sessionContext, type GatewayResult } from "./gateway";
import { scopedPiece } from "./piece-edits";
import { pieceDocSchema, type PieceDoc, type PieceRecord } from "./pieces";
import { FORMAT_DIMENSIONS, SlideView, type BrandTokens } from "../render/piece-slide";

export function renderSlideMarkup(
  doc: PieceDoc,
  slideIndex: number,
  tokens?: BrandTokens
): string {
  return renderToStaticMarkup(
    createElement(SlideView, { slide: doc.slides[slideIndex], format: doc.format, tokens })
  );
}

// A full standalone HTML document for one slide — what Chromium screenshots.
export function renderSlideHtml(
  doc: PieceDoc,
  slideIndex: number,
  tokens?: BrandTokens
): string {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}</style></head><body>',
    renderSlideMarkup(doc, slideIndex, tokens),
    "</body></html>",
  ].join("");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function docAtVersion(pieceId: number, version: number): PieceDoc | null {
  const row = getDb()
    .prepare("SELECT doc FROM piece_versions WHERE piece_id = ? AND version = ?")
    .get(pieceId, version) as { doc: string } | undefined;
  if (!row) return null;
  return pieceDocSchema.parse(JSON.parse(row.doc));
}

function unknownVersion(piece: PieceRecord, version: number): GatewayResult {
  return errResult(
    "unknown_version",
    `No version ${version} in the history of "${piece.title}".`,
    "Call marketingos.list_versions to see the versions that exist."
  );
}

const renderPreviewInputSchema = z.object({
  id: z.number().int(),
  version: z.number().int().min(1).optional(),
});

export function renderPreview(sessionKey: string, input: unknown): GatewayResult {
  const parsed = renderPreviewInputSchema.safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_preview",
      "A preview names the piece id and optionally the version to render.",
      "Call marketingos.render_preview with {id} for the current version or {id, version} for a historical one."
    );
  }
  const { id, version } = parsed.data;

  const scoped = scopedPiece(sessionKey, id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  const target = version ?? piece.docVersion;
  const doc = docAtVersion(piece.id, target);
  if (!doc) return unknownVersion(piece, target);

  // Tokens are resolved now, not stored: a kit change repaints the piece
  // without the document changing at all.
  const kit = currentKit(piece.projectId);

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, docVersion: piece.docVersion },
      preview: {
        version: target,
        kitVersion: kit.version,
        format: doc.format,
        dimensions: FORMAT_DIMENSIONS[doc.format],
        slides: doc.slides.map((_slide, index) => renderSlideHtml(doc, index, kit.tokens)),
      },
    },
  };
}

// One lazily-launched headless Chromium shared by every export.
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch();
  return browserPromise;
}

export async function closeRenderer(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

export function exportsRoot(): string {
  return process.env.EXPORTS_PATH ?? path.join(process.cwd(), "data", "exports");
}

export interface ExportManifest {
  pieceId: number;
  title: string;
  docVersion: number;
  kitVersion: number | null;
  format: string;
  files: { name: string; kind: "png" | "captions"; slide?: number; sourceHtmlSha256?: string }[];
  createdAt: string;
}

async function renderPng(
  doc: PieceDoc,
  slideIndex: number,
  tokens: BrandTokens
): Promise<Buffer> {
  const { width, height } = FORMAT_DIMENSIONS[doc.format];
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(renderSlideHtml(doc, slideIndex, tokens), { waitUntil: "load" });
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await page.close();
  }
}

export async function exportPiece(sessionKey: string, input: unknown): Promise<GatewayResult> {
  const parsed = z.object({ id: z.number().int() }).safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_export",
      "An export names the piece id.",
      "Call marketingos.export_piece with {id}."
    );
  }

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  const doc = docAtVersion(piece.id, piece.docVersion) ?? piece.doc;
  const kit = currentKit(piece.projectId);
  const kitVersion: number | null = kit.version;
  const bundleName = `piece-${piece.id}-v${piece.docVersion}`;
  const bundleDir = path.join(exportsRoot(), bundleName);
  fs.mkdirSync(bundleDir, { recursive: true });

  const formatSlug = doc.format.replace(":", "x");
  const files: ExportManifest["files"] = [];
  for (let index = 0; index < doc.slides.length; index += 1) {
    const name = `slide-${String(index + 1).padStart(2, "0")}-${formatSlug}.png`;
    const png = await renderPng(doc, index, kit.tokens);
    fs.writeFileSync(path.join(bundleDir, name), png);
    files.push({
      name,
      kind: "png",
      slide: index + 1,
      sourceHtmlSha256: sha256(renderSlideHtml(doc, index, kit.tokens)),
    });
  }

  const captionsName = "captions.json";
  fs.writeFileSync(path.join(bundleDir, captionsName), JSON.stringify(doc.captions, null, 2));
  files.push({ name: captionsName, kind: "captions" });

  const manifest: ExportManifest = {
    pieceId: piece.id,
    title: piece.title,
    docVersion: piece.docVersion,
    kitVersion,
    format: doc.format,
    files,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, ?, ?, ?, ?)"
    )
    .run(piece.id, piece.docVersion, kitVersion, path.join("data", "exports", bundleName), JSON.stringify(manifest));

  audit("ai-host", "pieces.exported", {
    pieceId: piece.id,
    projectId: piece.projectId,
    docVersion: piece.docVersion,
    kitVersion,
    slides: doc.slides.length,
    bundle: bundleName,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, docVersion: piece.docVersion },
      bundle: { name: bundleName, path: path.join("data", "exports", bundleName), manifest },
    },
  };
}
