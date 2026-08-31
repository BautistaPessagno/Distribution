// Creative Pieces and the PieceDoc schema (ticket 09; reference lifecycle:
// CreativePieceMachine in creative-piece-workflow.html).
//
// A PieceDoc is the versioned JSON document behind a Creative Piece: 1-20
// slides of text/image/shape/logo layers, one of four formats, and a
// per-network captions map. Every piece is bound at creation to the Project
// Snapshot pinned on the creating session, and every read is scoped to the
// selected Connected Project: cross-project piece access is refused.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  noProjectSelected,
  pinnedSession,
  registerInFlight,
  sessionContext,
  type GatewayResult,
} from "./gateway";

export const PIECE_FORMATS = ["4:5", "1:1", "9:16", "16:9"] as const;
export type PieceFormat = (typeof PIECE_FORMATS)[number];

export const CAPTION_NETWORKS = ["instagram", "x", "linkedin", "tiktok"] as const;
export type CaptionNetwork = (typeof CAPTION_NETWORKS)[number];

export const PIECE_STATUSES = [
  "backlog",
  "drafting",
  "review",
  "approved",
  "planned",
  "exported",
  "measured",
] as const;
export type PieceStatus = (typeof PIECE_STATUSES)[number];

/**
 * The statuses whose rendering is pinned to the Brand Kit version approval
 * ran against, and which therefore go brand-outdated when the kit moves on.
 */
export const PINNED_STATUSES: readonly PieceStatus[] = ["approved", "planned"];

const frameSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .optional();

export const pieceLayerSchema = z.discriminatedUnion("type", [
  // `color` and `font` name Brand Kit tokens (brand.<name>, font.<name>).
  // Raw values parse — the renderer still paints them — but check_brand
  // reports them as off-kit errors (ticket 12).
  z.object({
    type: z.literal("text"),
    text: z.string(),
    role: z.string().optional(),
    color: z.string().optional(),
    font: z.string().optional(),
    frame: frameSchema,
  }),
  z.object({ type: z.literal("image"), ref: z.string(), alt: z.string().optional(), frame: frameSchema }),
  z.object({ type: z.literal("shape"), shape: z.string(), fill: z.string().optional(), frame: frameSchema }),
  z.object({ type: z.literal("logo"), variant: z.string().optional(), frame: frameSchema }),
]);

export type PieceLayer = z.infer<typeof pieceLayerSchema>;

const slideSchema = z.object({
  layers: z.array(pieceLayerSchema),
});

const captionsSchema = z.object({
  instagram: z.string(),
  x: z.string(),
  linkedin: z.string(),
  tiktok: z.string(),
});

export const pieceDocSchema = z.object({
  format: z.enum(PIECE_FORMATS),
  slides: z.array(slideSchema).min(1).max(20),
  captions: captionsSchema,
});

export type PieceDoc = z.infer<typeof pieceDocSchema>;

export const createPieceInputSchema = z.object({
  title: z.string().min(1),
  doc: pieceDocSchema,
});

export interface PieceRecord {
  id: number;
  projectId: number;
  title: string;
  status: PieceStatus;
  snapshot: string;
  doc: PieceDoc;
  docVersion: number;
  /** The Brand Kit version approval pinned the rendering to, or null. */
  pinnedKitVersion: number | null;
  /** Set when the kit moved on after approval; blocks export until re-approval. */
  brandOutdated: boolean;
  /** A plan, never a publishing queue. Cleared by reopen. */
  plannedDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PieceRow {
  id: number;
  project_id: number;
  title: string;
  status: PieceStatus;
  snapshot: string;
  doc: string;
  doc_version: number;
  pinned_kit_version: number | null;
  brand_outdated: number;
  planned_date: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: PieceRow): PieceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    snapshot: row.snapshot,
    doc: JSON.parse(row.doc) as PieceDoc,
    docVersion: row.doc_version,
    pinnedKitVersion: row.pinned_kit_version,
    brandOutdated: row.brand_outdated === 1,
    plannedDate: row.planned_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPiecesForProject(projectId: number): PieceRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM pieces WHERE project_id = ? ORDER BY id DESC")
    .all(projectId) as PieceRow[];
  return rows.map(rowToRecord);
}

export function listAllPieces(): PieceRecord[] {
  const rows = getDb().prepare("SELECT * FROM pieces ORDER BY id DESC").all() as PieceRow[];
  return rows.map(rowToRecord);
}

/**
 * Flag every piece of a project whose rendering approval pinned. Called when
 * the Brand Kit changes: backlog and drafting pieces repaint freely, but
 * approved and planned work keeps the rendering the Operator signed off on
 * and says so. Returns the ids it flagged.
 */
export function flagBrandOutdated(projectId: number): number[] {
  const db = getDb();
  const placeholders = PINNED_STATUSES.map(() => "?").join(", ");
  const affected = db
    .prepare(
      `SELECT id FROM pieces
       WHERE project_id = ? AND brand_outdated = 0 AND status IN (${placeholders})`
    )
    .all(projectId, ...PINNED_STATUSES) as { id: number }[];
  if (affected.length === 0) return [];
  db.prepare(
    `UPDATE pieces SET brand_outdated = 1 WHERE id IN (${affected.map(() => "?").join(", ")})`
  ).run(...affected.map((row) => row.id));
  return affected.map((row) => row.id);
}

export function getPieceById(id: number): PieceRecord | null {
  const row = getDb().prepare("SELECT * FROM pieces WHERE id = ?").get(id) as
    | PieceRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function pieceSummary(piece: PieceRecord): Record<string, unknown> {
  return {
    id: piece.id,
    title: piece.title,
    status: piece.status,
    format: piece.doc.format,
    slides: piece.doc.slides.length,
    snapshot: piece.snapshot,
    docVersion: piece.docVersion,
    pinnedKitVersion: piece.pinnedKitVersion,
    brandOutdated: piece.brandOutdated,
    plannedDate: piece.plannedDate,
    createdAt: piece.createdAt,
  };
}

export function createPiece(sessionKey: string, input: unknown): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = createPieceInputSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return errResult(
      "invalid_schema",
      `The piece does not match the PieceDoc schema: ${detail}`,
      `A PieceDoc has 1-20 slides of text/image/shape/logo layers, format one of ${PIECE_FORMATS.join(
        ", "
      )}, and captions for ${CAPTION_NETWORKS.join(", ")}.`
    );
  }

  const { title, doc } = parsed.data;
  const db = getDb();
  const info = db.transaction(() => {
    const inserted = db
      .prepare(
        "INSERT INTO pieces (project_id, title, snapshot, doc) VALUES (?, ?, ?, ?)"
      )
      .run(pinned.projectId, title, pinned.snapshotId, JSON.stringify(doc));
    db.prepare(
      "INSERT INTO piece_versions (piece_id, version, actor, summary, doc) VALUES (?, 1, 'ai-host', 'Created', ?)"
    ).run(Number(inserted.lastInsertRowid), JSON.stringify(doc));
    return inserted;
  })();
  const piece = getPieceById(Number(info.lastInsertRowid));
  if (!piece) throw new Error("piece insert did not persist");

  registerInFlight(sessionKey, `piece #${piece.id} "${piece.title}"`);
  audit("ai-host", "pieces.created", {
    pieceId: piece.id,
    projectId: pinned.projectId,
    snapshot: pinned.snapshotId,
    format: doc.format,
    slides: doc.slides.length,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { ...pieceSummary(piece), doc: piece.doc },
    },
  };
}

export function getPiece(sessionKey: string, id: number): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  const piece = Number.isInteger(id) ? getPieceById(id) : null;
  if (!piece) {
    return errResult(
      "unknown_piece",
      `No Creative Piece #${id}.`,
      "Call marketingos.list_pieces to see the pieces of the selected project."
    );
  }
  // Every piece is bound to one Connected Project; cross-project access is refused.
  if (piece.projectId !== pinned.projectId) {
    return errResult(
      "cross_project_refused",
      `Creative Piece #${id} belongs to a different Connected Project than '${pinned.projectName}'.`,
      "Select the project the piece belongs to with marketingos.select_project, then read it there."
    );
  }

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { ...pieceSummary(piece), doc: piece.doc },
    },
  };
}

export function listPieces(sessionKey: string): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      pieces: listPiecesForProject(pinned.projectId).map(pieceSummary),
    },
  };
}
