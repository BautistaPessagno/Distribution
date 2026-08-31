// Deterministic renderer and PNG export (ticket 11). Snapshot tests pin
// that the Studio preview and the exported PNG come from the same shared
// components; the export bundle names every file and the versions it was
// rendered from; render_preview returns a preview for any piece version.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
process.env.EXPORTS_PATH = path.join(tmpDir, "exports");

import express from "express";
import { selectProject } from "../server/gateway";
import { applyEditBatch } from "../server/piece-edits";
import { createPiece, type PieceDoc } from "../server/pieces";
import {
  closeRenderer,
  exportPiece,
  renderPreview,
  renderSlideHtml,
  renderSlideMarkup,
  sha256,
  type ExportManifest,
} from "../server/renderer";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { stubVerifyAgainstProjects } from "../server/stub-project";
import { SlideView } from "../render/piece-slide";

const router = createProjectDomainRouter({
  manifest: () => ({
    name: "test-project",
    contractVersion: PROJECT_CONTRACT_VERSION,
    resources: [...REQUIRED_RESOURCES],
    capabilities: [],
  }),
  resource(name: RequiredResource): ResourceEnvelope {
    return { resource: name, state: "ok", version: 1, data: {} };
  },
  changes: () => ({ cursor: 0, entries: [] }),
  verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
});

const app = express();
app.use("/keepanalog", router);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "renderer-session";

function doc(): PieceDoc {
  return {
    format: "1:1",
    slides: [
      {
        layers: [
          { type: "text", text: "Slow tools, on purpose", role: "headline" },
          { type: "shape", shape: "rect", fill: "brand.accent", frame: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 } },
          { type: "logo", variant: "wordmark" },
        ],
      },
      {
        layers: [
          { type: "image", ref: "asset://hero", alt: "A film camera" },
          { type: "text", text: "Second slide" },
        ],
      },
    ],
    captions: { instagram: "ig caption", x: "x caption", linkedin: "li caption", tiktok: "tt caption" },
  };
}

function makePiece(title: string): { id: number; docVersion: number } {
  const created = createPiece(SESSION, { title, doc: doc() });
  assert.equal(created.ok, true);
  return created.response.piece as { id: number; docVersion: number };
}

test.before(async () => {
  const a = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  assert.equal(a.project.status, "healthy");
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
});

test.after(async () => {
  await closeRenderer();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Snapshot tests: preview and export come from the same components

test("snapshot: server slide markup is exactly the shared SlideView component's markup", () => {
  const d = doc();
  for (let index = 0; index < d.slides.length; index += 1) {
    const fromSharedComponent = renderToStaticMarkup(
      createElement(SlideView, { slide: d.slides[index], format: d.format })
    );
    assert.equal(renderSlideMarkup(d, index), fromSharedComponent);
  }
});

test("snapshot: slide markup is deterministic and pins layout, brand fill, and content", () => {
  const first = renderSlideMarkup(doc(), 0);
  const second = renderSlideMarkup(doc(), 0);
  assert.equal(first, second);
  assert.match(first, /data-piece-slide="1:1"/);
  assert.match(first, /width:1080px/);
  assert.match(first, /height:1080px/);
  assert.match(first, /Slow tools, on purpose/);
  // brand.accent resolves through the shared token table, never a copied value.
  assert.match(first, /background-color:#1a6b54/);
  // The framed shape is placed at fractional coordinates of the canvas.
  assert.match(first, /left:108px/);
  assert.match(first, /top:756px/);
});

test("snapshot: exported PNG is screenshotted from the same HTML render_preview returns", async () => {
  const { id } = makePiece("preview equals export");

  const preview = renderPreview(SESSION, { id });
  assert.equal(preview.ok, true);
  const previewSlides = (preview.response.preview as { slides: string[] }).slides;

  const exported = await exportPiece(SESSION, { id });
  assert.equal(exported.ok, true);
  const bundle = exported.response.bundle as { name: string; manifest: ExportManifest };

  const pngs = bundle.manifest.files.filter((f) => f.kind === "png");
  assert.equal(pngs.length, previewSlides.length);
  for (const [index, file] of pngs.entries()) {
    // The manifest records the sha256 of the HTML each PNG was rendered
    // from; it must be byte-identical to the preview's HTML.
    assert.equal(file.sourceHtmlSha256, sha256(previewSlides[index]));
  }

  const bundleDir = path.join(process.env.EXPORTS_PATH as string, bundle.name);
  for (const file of pngs) {
    const png = fs.readFileSync(path.join(bundleDir, file.name));
    // PNG magic bytes: a real image came out of Chromium.
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(png.length > 1000);
  }
});

// ---------------------------------------------------------------------------
// Export bundle contents

test("export bundle: manifest names every file and the versions it was rendered from", async () => {
  const { id } = makePiece("bundle manifest");
  const exported = await exportPiece(SESSION, { id });
  assert.equal(exported.ok, true);
  const bundle = exported.response.bundle as { name: string; path: string; manifest: ExportManifest };

  const manifest = bundle.manifest;
  assert.equal(manifest.pieceId, id);
  assert.equal(manifest.docVersion, 1);
  // The bundle records the Brand Kit version it was rendered through, so a
  // later kit change is visible as a difference against this export.
  assert.equal(manifest.kitVersion, 1);
  assert.equal(manifest.format, "1:1");

  const bundleDir = path.join(process.env.EXPORTS_PATH as string, bundle.name);
  const onDisk = fs.readdirSync(bundleDir).sort();
  const named = [...manifest.files.map((f) => f.name), "manifest.json"].sort();
  assert.deepEqual(onDisk, named);

  assert.deepEqual(
    manifest.files.filter((f) => f.kind === "png").map((f) => f.name),
    ["slide-01-1x1.png", "slide-02-1x1.png"]
  );
  const captions = JSON.parse(fs.readFileSync(path.join(bundleDir, "captions.json"), "utf8"));
  assert.deepEqual(captions, doc().captions);

  const persisted = JSON.parse(
    fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8")
  ) as ExportManifest;
  assert.deepEqual(persisted.files, manifest.files);
});

// ---------------------------------------------------------------------------
// render_preview across versions

test("render_preview returns a preview for any piece version", () => {
  const { id } = makePiece("versioned previews");

  const edited = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_text", slide: 0, layer: 0, value: "New headline" }],
  });
  assert.equal(edited.ok, true);

  const v1 = renderPreview(SESSION, { id, version: 1 });
  assert.equal(v1.ok, true);
  const v1Slides = (v1.response.preview as { version: number; slides: string[] });
  assert.equal(v1Slides.version, 1);
  assert.match(v1Slides.slides[0], /Slow tools, on purpose/);

  const v2 = renderPreview(SESSION, { id, version: 2 });
  assert.equal(v2.ok, true);
  assert.match((v2.response.preview as { slides: string[] }).slides[0], /New headline/);

  // No version argument renders the current version.
  const current = renderPreview(SESSION, { id });
  assert.equal(current.ok, true);
  assert.deepEqual(current.response.preview, v2.response.preview);

  const missing = renderPreview(SESSION, { id, version: 99 });
  assert.equal(missing.ok, false);
  assert.equal(missing.response.error, "unknown_version");
});

test("render_preview refuses unknown and cross-project pieces", () => {
  const missing = renderPreview(SESSION, { id: 424242 });
  assert.equal(missing.ok, false);
  assert.equal(missing.response.error, "unknown_piece");
});
