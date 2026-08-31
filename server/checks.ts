// Deterministic checks over a PieceDoc (ticket 12; reference behavior:
// `checkBrand` and `checkQuality` in CreativePieceMachine,
// creative-piece-workflow.html).
//
// Two passes, and the difference between them is the whole point:
//
//   check_brand   deterministic facts about the document against the Brand
//                 Kit — off-kit colours and fonts, empty text layers,
//                 missing assets (errors) and overflow risk (warnings).
//                 Its errors are what gate approval (ticket 13).
//
//   check_quality heuristics about composition. Every finding is advisory
//                 and labelled as such; nothing here ever blocks anything.
//
// Both are pure functions of (document, kit): same input, same findings.

import { z } from "zod";
import { currentKit, type BrandKit } from "./brand-kit";
import { sessionContext, type GatewayResult } from "./gateway";
import { scopedPiece } from "./piece-edits";
import { getPieceById, type PieceDoc } from "./pieces";
import {
  FORMAT_DIMENSIONS,
  isColorToken,
  isFontToken,
  textLayerBox,
  textSize,
  type BrandTokens,
  type RenderLayer,
} from "../render/piece-slide";

export type CheckSeverity = "error" | "warning" | "advisory";

export interface CheckFinding {
  code: string;
  severity: CheckSeverity;
  /** 1-based slide number, as the Operator counts slides. */
  slide: number;
  /** 0-based layer index within the slide, as the edit ops address them. */
  layer: number | null;
  /** Human label naming the layer the finding is about. */
  where: string;
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

function layerLabel(slideIndex: number, layerIndex: number, layer: RenderLayer): string {
  return `slide ${slideIndex + 1}, layer ${layerIndex} (${layer.type})`;
}

function finding(
  code: string,
  severity: CheckSeverity,
  slideIndex: number,
  layerIndex: number | null,
  where: string,
  message: string
): CheckFinding {
  return { code, severity, slide: slideIndex + 1, layer: layerIndex, where, message };
}

// A colour reference is on-kit only when it names a kit token. A raw hex
// value renders (so the Operator can see it) but is an error: pieces
// reference tokens, never copied values.
function colorFindings(
  value: string | undefined,
  field: string,
  tokens: BrandTokens,
  slideIndex: number,
  layerIndex: number,
  where: string
): CheckFinding[] {
  if (value === undefined) return [];
  if (isColorToken(value)) {
    if (value in tokens) return [];
    return [
      finding(
        "off_kit_token",
        "error",
        slideIndex,
        layerIndex,
        where,
        `${where} sets ${field} to "${value}", which is not a token in this Brand Kit.`
      ),
    ];
  }
  return [
    finding(
      "off_kit_color",
      "error",
      slideIndex,
      layerIndex,
      where,
      `${where} sets ${field} to the raw colour "${value}" instead of a Brand Kit token.`
    ),
  ];
}

function fontFindings(
  value: string | undefined,
  tokens: BrandTokens,
  slideIndex: number,
  layerIndex: number,
  where: string
): CheckFinding[] {
  if (value === undefined) return [];
  if (isFontToken(value)) {
    if (value in tokens) return [];
    return [
      finding(
        "off_kit_token",
        "error",
        slideIndex,
        layerIndex,
        where,
        `${where} sets font to "${value}", which is not a token in this Brand Kit.`
      ),
    ];
  }
  return [
    finding(
      "off_kit_font",
      "error",
      slideIndex,
      layerIndex,
      where,
      `${where} sets font to the raw family "${value}" instead of a Brand Kit token.`
    ),
  ];
}

// Deterministic overflow estimate in the same box, at the same type size,
// the renderer lays the layer out in — so the warning tracks what the
// Operator actually sees.
function overflows(layer: RenderLayer, format: string): { lines: number; needed: number; box: number } | null {
  const text = layer.text ?? "";
  if (text.trim() === "") return null;
  const { height } = FORMAT_DIMENSIONS[format] ?? FORMAT_DIMENSIONS["1:1"];
  const size = textSize(layer.role, height);
  const box = textLayerBox(layer, format);
  const charsPerLine = Math.max(1, Math.floor(box.width / (size * 0.55)));
  const lines = text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const needed = Math.ceil(lines * size * 1.25);
  return needed > box.height ? { lines, needed, box: box.height } : null;
}

export function checkBrandDoc(doc: PieceDoc, tokens: BrandTokens): CheckFinding[] {
  const findings: CheckFinding[] = [];
  doc.slides.forEach((slide, slideIndex) => {
    slide.layers.forEach((layer, layerIndex) => {
      const where = layerLabel(slideIndex, layerIndex, layer as RenderLayer);
      const l = layer as RenderLayer;

      findings.push(...colorFindings(l.fill, "fill", tokens, slideIndex, layerIndex, where));
      findings.push(...colorFindings(l.color, "colour", tokens, slideIndex, layerIndex, where));
      findings.push(...fontFindings(l.font, tokens, slideIndex, layerIndex, where));

      if (l.type === "text") {
        if ((l.text ?? "").trim() === "") {
          findings.push(
            finding("empty_text", "error", slideIndex, layerIndex, where, `${where} is an empty text layer.`)
          );
        }
        const over = overflows(l, doc.format);
        if (over) {
          findings.push(
            finding(
              "text_overflow",
              "warning",
              slideIndex,
              layerIndex,
              where,
              `${where} needs about ${over.needed}px across ${over.lines} lines but its box is ${over.box}px tall; the text may overflow.`
            )
          );
        }
        // A token that resolves to the same colour as the background is
        // legal but invisible — worth a warning, never a block.
        if (l.color && tokens[l.color] && tokens[l.color] === tokens["brand.paper"]) {
          findings.push(
            finding(
              "invisible_text",
              "warning",
              slideIndex,
              layerIndex,
              where,
              `${where} uses ${l.color}, the same colour as the slide background.`
            )
          );
        }
      }

      if (l.type === "image" && (l.ref ?? "").trim() === "") {
        findings.push(
          finding("missing_asset", "error", slideIndex, layerIndex, where, `${where} names no asset.`)
        );
      }
    });
  });
  return findings;
}

export function checkQualityDoc(doc: PieceDoc): CheckFinding[] {
  const findings: CheckFinding[] = [];
  doc.slides.forEach((slide, slideIndex) => {
    const where = `slide ${slideIndex + 1}`;
    if (slide.layers.length === 0) {
      findings.push(finding("empty_slide", "advisory", slideIndex, null, where, `${where} is empty.`));
      return;
    }
    if (slide.layers.length > 5) {
      findings.push(
        finding(
          "crowded_slide",
          "advisory",
          slideIndex,
          null,
          where,
          `${where} has ${slide.layers.length} layers; the composition looks crowded.`
        )
      );
    }
    if (!slide.layers.some((layer) => layer.type === "text")) {
      findings.push(
        finding(
          "no_text",
          "advisory",
          slideIndex,
          null,
          where,
          `${where} has no text layer; the hierarchy is unclear.`
        )
      );
    }
  });
  const emptyCaptions = Object.entries(doc.captions)
    .filter(([, caption]) => caption.trim() === "")
    .map(([network]) => network);
  if (emptyCaptions.length > 0) {
    findings.push({
      code: "empty_caption",
      severity: "advisory",
      slide: 0,
      layer: null,
      where: "captions",
      message: `No caption written for ${emptyCaptions.join(", ")}.`,
    });
  }
  return findings;
}

export function brandReport(doc: PieceDoc, docVersion: number, kit: BrandKit): BrandCheckReport {
  const findings = checkBrandDoc(doc, kit.tokens);
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
    brand: brandReport(piece.doc, piece.docVersion, kit),
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

  const report = brandReport(piece.doc, piece.docVersion, currentKit(piece.projectId));
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
