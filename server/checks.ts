// Deterministic checks over a PieceDoc (ticket 12; reference behavior:
// `checkBrand` and `checkQuality` in CreativePieceMachine,
// creative-piece-workflow.html).
//
// Two passes, and the difference between them is the whole point:
//
//   check_brand   deterministic facts about the document against the Brand
//                 Kit — off-kit colors and fonts, empty text layers,
//                 missing assets (errors) and overflow risk (warnings).
//                 Its errors are what gate approval (ticket 13).
//
//   check_quality heuristics about composition. Every finding is advisory
//                 and labelled as such; nothing here ever blocks anything.
//
// Both are pure functions of (document, kit): same input, same findings.

import { z } from "zod";
import { resolveAssetRef } from "./assets";
import { currentKit, type BrandKit } from "./brand-kit";
import { sessionContext, type GatewayResult } from "./gateway";
import { scopedPiece } from "./piece-edits";
import { getPieceById, type PieceDoc } from "./pieces";
import {
  FORMAT_DIMENSIONS,
  intrinsicLayerHeight,
  isColorToken,
  isFontToken,
  layerBox,
  slideContentBox,
  stackGap,
  textSize,
  TEXT_LINE_HEIGHT,
  type BrandTokens,
  type RenderLayer,
} from "../render/piece-slide";

export type CheckSeverity = "error" | "warning" | "advisory";

/** Where a finding is, in the coordinates the Operator and the edit ops use. */
export interface LayerLocation {
  /** 1-based slide number, or null for a finding about the whole document. */
  slide: number | null;
  /** 0-based layer index within the slide, or null for a whole-slide finding. */
  layer: number | null;
  /** Human label naming what the finding is about. */
  where: string;
}

export interface CheckFinding extends LayerLocation {
  code: string;
  severity: CheckSeverity;
  message: string;
}

export interface BrandCheckReport {
  kitVersion: number;
  docVersion: number;
  errors: CheckFinding[];
  warnings: CheckFinding[];
}

export interface QualityCheckReport {
  docVersion: number;
  /** Always true: quality findings advise, they never block. */
  advisory: true;
  findings: CheckFinding[];
}

function at(slideIndex: number, layerIndex: number, layer: RenderLayer): LayerLocation {
  return {
    slide: slideIndex + 1,
    layer: layerIndex,
    where: `slide ${slideIndex + 1}, layer ${layerIndex} (${layer.type})`,
  };
}

function atSlide(slideIndex: number): LayerLocation {
  return { slide: slideIndex + 1, layer: null, where: `slide ${slideIndex + 1}` };
}

const WHOLE_DOCUMENT: LayerLocation = { slide: null, layer: null, where: "captions" };

function finding(
  code: string,
  severity: CheckSeverity,
  location: LayerLocation,
  message: string
): CheckFinding {
  return { code, severity, ...location, message };
}

// A token reference is on-kit only when it names a token this kit holds. A
// raw value renders (so the Operator can see the piece) but is an error:
// pieces reference tokens, never copied values.
function offKitFindings(
  value: string | undefined,
  field: "fill" | "color" | "font",
  tokens: BrandTokens,
  location: LayerLocation
): CheckFinding[] {
  if (value === undefined) return [];
  const isToken = field === "font" ? isFontToken(value) : isColorToken(value);
  if (isToken) {
    if (value in tokens) return [];
    return [
      finding(
        "off_kit_token",
        "error",
        location,
        `${location.where} sets ${field} to "${value}", which is not a token in this Brand Kit.`
      ),
    ];
  }
  const kind = field === "font" ? "font family" : "color";
  return [
    finding(
      field === "font" ? "off_kit_font" : "off_kit_color",
      "error",
      location,
      `${location.where} sets ${field} to the raw ${kind} "${value}" instead of a Brand Kit token.`
    ),
  ];
}

// The height a text layer needs inside a box of the given width, at the type
// size and line height the renderer lays it out with.
function textHeight(layer: RenderLayer, format: string, boxWidth: number): number {
  const text = layer.text ?? "";
  if (text.trim() === "") return 0;
  const canvas = FORMAT_DIMENSIONS[format] ?? FORMAT_DIMENSIONS["1:1"];
  const size = textSize(layer.role, canvas.height);
  const charsPerLine = Math.max(1, Math.floor(boxWidth / (size * 0.55)));
  const lines = text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return Math.ceil(lines * size * TEXT_LINE_HEIGHT);
}

// A framed layer overflows its own frame. Unframed layers all stack in the
// one slide content box, so they overflow together or not at all — checking
// them one at a time against the whole canvas would never fire.
function overflowFindings(slide: { layers: RenderLayer[] }, format: string, slideIndex: number): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const content = slideContentBox(format);
  let stacked = 0;
  let unframed = 0;

  slide.layers.forEach((layer, layerIndex) => {
    if (layer.frame) {
      if (layer.type !== "text") return;
      const box = layerBox(layer, format);
      const needed = textHeight(layer, format, box.width);
      if (needed > box.height) {
        findings.push(
          finding(
            "text_overflow",
            "warning",
            at(slideIndex, layerIndex, layer),
            `${at(slideIndex, layerIndex, layer).where} needs about ${needed}px of height but its frame is ${box.height}px tall; the text may overflow.`
          )
        );
      }
      return;
    }
    unframed += 1;
    stacked +=
      layer.type === "text"
        ? textHeight(layer, format, content.width)
        : intrinsicLayerHeight(layer, format);
  });

  if (unframed > 1) stacked += (unframed - 1) * stackGap(format);
  if (unframed > 0 && stacked > content.height) {
    findings.push(
      finding(
        "slide_overflow",
        "warning",
        atSlide(slideIndex),
        `slide ${slideIndex + 1} stacks ${unframed} unframed layer(s) needing about ${stacked}px inside a ${content.height}px canvas; the content may overflow.`
      )
    );
  }
  return findings;
}

/**
 * Whether an image layer's reference points at something. Passing a
 * resolver is optional: without one, only an empty ref is an error, because
 * nothing here can tell whether a reference resolves.
 */
export type RefResolver = (ref: string) => boolean;

/** An image layer may only point at an asset registered to its own project. */
export function refResolverFor(projectId: number): RefResolver {
  return (ref) => resolveAssetRef(ref, projectId) !== null;
}

export function checkBrandDoc(
  doc: PieceDoc,
  tokens: BrandTokens,
  refExists?: RefResolver
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  doc.slides.forEach((slide, slideIndex) => {
    const layers = slide.layers as RenderLayer[];
    layers.forEach((layer, layerIndex) => {
      const location = at(slideIndex, layerIndex, layer);

      findings.push(...offKitFindings(layer.fill, "fill", tokens, location));
      findings.push(...offKitFindings(layer.color, "color", tokens, location));
      findings.push(...offKitFindings(layer.font, "font", tokens, location));

      if (layer.type === "text" && (layer.text ?? "").trim() === "") {
        findings.push(
          finding("empty_text", "error", location, `${location.where} is an empty text layer.`)
        );
      }
      if (layer.type === "image") {
        const ref = (layer.ref ?? "").trim();
        if (ref === "") {
          findings.push(
            finding("missing_asset", "error", location, `${location.where} names no asset.`)
          );
        } else if (refExists && !refExists(ref)) {
          findings.push(
            finding(
              "missing_asset",
              "error",
              location,
              `${location.where} references ${ref}, which is not a registered asset of this project.`
            )
          );
        }
      }
    });
    findings.push(...overflowFindings({ layers }, doc.format, slideIndex));
  });
  return findings;
}

export function checkQualityDoc(doc: PieceDoc): CheckFinding[] {
  const findings: CheckFinding[] = [];
  doc.slides.forEach((slide, slideIndex) => {
    const location = atSlide(slideIndex);
    if (slide.layers.length === 0) {
      findings.push(finding("empty_slide", "advisory", location, `${location.where} is empty.`));
      return;
    }
    if (slide.layers.length > 5) {
      findings.push(
        finding(
          "crowded_slide",
          "advisory",
          location,
          `${location.where} has ${slide.layers.length} layers; the composition looks crowded.`
        )
      );
    }
    if (!slide.layers.some((layer) => layer.type === "text")) {
      findings.push(
        finding(
          "no_text",
          "advisory",
          location,
          `${location.where} has no text layer; the hierarchy is unclear.`
        )
      );
    }
  });
  const emptyCaptions = Object.entries(doc.captions)
    .filter(([, caption]) => caption.trim() === "")
    .map(([network]) => network);
  if (emptyCaptions.length > 0) {
    findings.push(
      finding(
        "empty_caption",
        "advisory",
        WHOLE_DOCUMENT,
        `No caption written for ${emptyCaptions.join(", ")}.`
      )
    );
  }
  return findings;
}

export function brandReport(
  doc: PieceDoc,
  docVersion: number,
  kit: BrandKit,
  refExists?: RefResolver
): BrandCheckReport {
  const findings = checkBrandDoc(doc, kit.tokens, refExists);
  return {
    kitVersion: kit.version,
    docVersion,
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
  };
}

export function qualityReport(doc: PieceDoc, docVersion: number): QualityCheckReport {
  return { docVersion, advisory: true, findings: checkQualityDoc(doc) };
}

/** Both passes for one piece, for Studio and for the approval gate. */
export function reportsForPiece(
  pieceId: number
): { brand: BrandCheckReport; quality: QualityCheckReport } | null {
  const piece = getPieceById(pieceId);
  if (!piece) return null;
  const kit = currentKit(piece.projectId);
  return {
    brand: brandReport(piece.doc, piece.docVersion, kit, refResolverFor(piece.projectId)),
    quality: qualityReport(piece.doc, piece.docVersion),
  };
}

// ---------------------------------------------------------------------------
// Host surface

const checkInputSchema = z.object({ id: z.number().int() });

function invalidCheck(tool: string): GatewayResult {
  return {
    ok: false,
    response: {
      error: "invalid_check",
      message: "A check names the piece id.",
      next: `Call ${tool} with {id}.`,
    },
  };
}

export function checkBrand(sessionKey: string, input: unknown): GatewayResult {
  const parsed = checkInputSchema.safeParse(input);
  if (!parsed.success) return invalidCheck("marketingos.check_brand");

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  const report = brandReport(
    piece.doc,
    piece.docVersion,
    currentKit(piece.projectId),
    refResolverFor(piece.projectId)
  );
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, status: piece.status },
      check: {
        ...report,
        blocksApproval: report.errors.length > 0,
        summary: `${report.errors.length} error(s), ${report.warnings.length} warning(s). Errors block approval; warnings do not.`,
      },
    },
  };
}

export function checkQuality(sessionKey: string, input: unknown): GatewayResult {
  const parsed = checkInputSchema.safeParse(input);
  if (!parsed.success) return invalidCheck("marketingos.check_quality");

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  const report = qualityReport(piece.doc, piece.docVersion);
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, status: piece.status },
      check: {
        ...report,
        blocksApproval: false,
        summary: `${report.findings.length} advisory finding(s). Quality findings advise; they never block.`,
      },
    },
  };
}
