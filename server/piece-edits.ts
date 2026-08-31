// Atomic edit batches and version history for Creative Pieces (ticket 10;
// reference contract: CreativePieceMachine in creative-piece-workflow.html).
//
// A batch of typed edit operations (max 20) is bound to a baseVersion. A
// stale base returns version_conflict and changes nothing; any structural
// error rejects the whole batch; invalid cosmetic values fall back to a
// default with a warning. Every applied batch bumps the version and appends
// to the append-only version history. Restoring an old version creates a new
// one. Approved pieces reject edits until reopened to drafting.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  noProjectSelected,
  pinnedSession,
  sessionContext,
  type GatewayResult,
} from "./gateway";
import {
  CAPTION_NETWORKS,
  getPieceById,
  pieceDocSchema,
  pieceLayerSchema,
  type PieceDoc,
  type PieceRecord,
  type PieceStatus,
} from "./pieces";

export const MAX_BATCH_OPS = 20;

export const EDITABLE_STATUSES: readonly PieceStatus[] = ["backlog", "drafting"];

// The reopen path (review/approved/planned → drafting) lands with the
// lifecycle ticket; edit refusals name it so hosts know the way back.
export const REOPEN_PATH = "marketingos.reopen_piece";

const FILL_FALLBACK = "brand.ink";
const FILL_PATTERN = /^(#[0-9a-fA-F]{6}|brand\.\w+)$/;

const indexSchema = z.number().int().min(0);

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_text"), slide: indexSchema, layer: indexSchema, value: z.string() }),
  z.object({ op: z.literal("set_fill"), slide: indexSchema, layer: indexSchema, value: z.string() }),
  z.object({ op: z.literal("add_layer"), slide: indexSchema, layer: pieceLayerSchema }),
  z.object({ op: z.literal("remove_layer"), slide: indexSchema, layer: indexSchema }),
  z.object({ op: z.literal("set_caption"), network: z.enum(CAPTION_NETWORKS), value: z.string() }),
]);

export type EditOp = z.infer<typeof editOpSchema>;

export const applyEditBatchInputSchema = z.object({
  id: z.number().int(),
  baseVersion: z.number().int().min(1),
  ops: z.array(editOpSchema).min(1).max(MAX_BATCH_OPS),
});

export interface PieceVersionEntry {
  version: number;
  actor: string;
  summary: string;
  createdAt: string;
}

interface VersionRow {
  version: number;
  actor: string;
  summary: string;
  doc: string;
  created_at: string;
}

export function listVersionsForPiece(pieceId: number): PieceVersionEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT version, actor, summary, doc, created_at FROM piece_versions WHERE piece_id = ? ORDER BY version ASC"
    )
    .all(pieceId) as VersionRow[];
  return rows.map((row) => ({
    version: row.version,
    actor: row.actor,
    summary: row.summary,
    createdAt: row.created_at,
  }));
}

export function recordVersion(
  pieceId: number,
  version: number,
  actor: string,
  summary: string,
  doc: PieceDoc
): void {
  getDb()
    .prepare(
      "INSERT INTO piece_versions (piece_id, version, actor, summary, doc) VALUES (?, ?, ?, ?, ?)"
    )
    .run(pieceId, version, actor, summary, JSON.stringify(doc));
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function batchRejected(detail: string): GatewayResult {
  return errResult(
    "invalid_batch",
    `Batch rejected: ${detail} The whole batch was discarded; the piece is unchanged.`,
    `An edit batch is 1-${MAX_BATCH_OPS} typed operations (set_text, set_fill, add_layer, remove_layer, set_caption) bound to the baseVersion it was computed against.`
  );
}

export function scopedPiece(
  sessionKey: string,
  id: number
): { piece: PieceRecord } | { error: GatewayResult } {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return { error: noProjectSelected() };
  const piece = Number.isInteger(id) ? getPieceById(id) : null;
  if (!piece) {
    return {
      error: errResult(
        "unknown_piece",
        `No Creative Piece #${id}.`,
        "Call marketingos.list_pieces to see the pieces of the selected project."
      ),
    };
  }
  if (piece.projectId !== pinned.projectId) {
    return {
      error: errResult(
        "cross_project_refused",
        `Creative Piece #${id} belongs to a different Connected Project than '${pinned.projectName}'.`,
        "Select the project the piece belongs to with marketingos.select_project, then edit it there."
      ),
    };
  }
  return { piece };
}

function notEditable(piece: PieceRecord): GatewayResult {
  return errResult(
    "piece_not_editable",
    `Edits are refused while "${piece.title}" is ${piece.status}; approval means the Operator saw this exact document.`,
    `Reopen the piece to drafting first via ${REOPEN_PATH}, then edit and pass review again.`
  );
}

// Structural validation: any error here rejects the whole batch.
function structuralError(doc: PieceDoc, op: EditOp): string | null {
  if (op.op === "set_caption") return null;
  const slide = doc.slides[op.slide];
  if (!slide) return `operation targets slide ${op.slide}, which does not exist.`;
  if (op.op === "add_layer") return null;
  const layer = slide.layers[op.layer];
  if (!layer) return `operation targets layer ${op.layer} on slide ${op.slide}, which does not exist.`;
  if (op.op === "set_text" && layer.type !== "text")
    return `set_text targets a ${layer.type} layer (slide ${op.slide}, layer ${op.layer}); only text layers hold text.`;
  if (op.op === "set_fill" && layer.type !== "shape")
    return `set_fill targets a ${layer.type} layer (slide ${op.slide}, layer ${op.layer}); only shape layers hold a fill.`;
  return null;
}

function applyOps(
  doc: PieceDoc,
  ops: EditOp[]
): { doc: PieceDoc; summaries: string[]; warnings: string[] } {
  const next = JSON.parse(JSON.stringify(doc)) as PieceDoc;
  const summaries: string[] = [];
  const warnings: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "set_text": {
        const layer = next.slides[op.slide].layers[op.layer];
        if (layer.type === "text") layer.text = op.value;
        summaries.push(`text of slide ${op.slide} layer ${op.layer}`);
        break;
      }
      case "set_fill": {
        let fill = op.value;
        if (!FILL_PATTERN.test(fill)) {
          warnings.push(`Cosmetic value "${fill}" is invalid; fell back to ${FILL_FALLBACK}.`);
          fill = FILL_FALLBACK;
        }
        const layer = next.slides[op.slide].layers[op.layer];
        if (layer.type === "shape") layer.fill = fill;
        summaries.push(`fill of slide ${op.slide} layer ${op.layer}`);
        break;
      }
      case "add_layer": {
        next.slides[op.slide].layers.push(op.layer);
        summaries.push(`added ${op.layer.type} layer to slide ${op.slide}`);
        break;
      }
      case "remove_layer": {
        next.slides[op.slide].layers.splice(op.layer, 1);
        summaries.push(`removed layer ${op.layer} from slide ${op.slide}`);
        break;
      }
      case "set_caption": {
        next.captions[op.network] = op.value;
        summaries.push(`${op.network} caption`);
        break;
      }
    }
  }
  return { doc: next, summaries, warnings };
}

function persistNewVersion(
  piece: PieceRecord,
  doc: PieceDoc,
  actor: string,
  summary: string
): number {
  const db = getDb();
  const newVersion = piece.docVersion + 1;
  db.transaction(() => {
    db.prepare(
      "UPDATE pieces SET doc = ?, doc_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(JSON.stringify(doc), newVersion, piece.id);
    recordVersion(piece.id, newVersion, actor, summary, doc);
  })();
  return newVersion;
}

export function applyEditBatch(
  sessionKey: string,
  input: unknown,
  actor = "ai-host"
): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = applyEditBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return batchRejected(`${detail}.`);
  }
  const { id, baseVersion, ops } = parsed.data;

  const scoped = scopedPiece(sessionKey, id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  if (!EDITABLE_STATUSES.includes(piece.status)) return notEditable(piece);

  if (baseVersion !== piece.docVersion) {
    return errResult(
      "version_conflict",
      `The batch was computed against version ${baseVersion}, but "${piece.title}" is at version ${piece.docVersion}. Nothing changed.`,
      "Re-read the piece with marketingos.get_piece and retry the batch against the current version."
    );
  }

  for (const op of ops) {
    const problem = structuralError(piece.doc, op);
    if (problem) return batchRejected(problem);
  }

  const applied = applyOps(piece.doc, ops);
  const finalDoc = pieceDocSchema.safeParse(applied.doc);
  if (!finalDoc.success) {
    const detail = finalDoc.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return batchRejected(`the result would leave the PieceDoc invalid (${detail}).`);
  }

  const newVersion = persistNewVersion(
    piece,
    finalDoc.data,
    actor,
    `Edit batch by ${actor}: ${applied.summaries.join(", ")}`
  );

  audit("ai-host", "pieces.edit_batch_applied", {
    pieceId: piece.id,
    projectId: piece.projectId,
    ops: ops.length,
    fromVersion: baseVersion,
    toVersion: newVersion,
    warnings: applied.warnings.length,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, docVersion: newVersion, doc: finalDoc.data },
      applied: ops.length,
      warnings: applied.warnings,
    },
  };
}

export function listVersions(sessionKey: string, id: number): GatewayResult {
  const scoped = scopedPiece(sessionKey, id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, docVersion: piece.docVersion },
      versions: listVersionsForPiece(piece.id),
    },
  };
}

export function restoreVersion(
  sessionKey: string,
  input: unknown,
  actor = "ai-host"
): GatewayResult {
  const parsed = z
    .object({ id: z.number().int(), version: z.number().int().min(1) })
    .safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_restore",
      "A restore names the piece id and the version to restore.",
      "Call marketingos.list_versions to see the version history of the piece."
    );
  }
  const { id, version } = parsed.data;

  const scoped = scopedPiece(sessionKey, id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  if (!EDITABLE_STATUSES.includes(piece.status)) return notEditable(piece);

  const row = getDb()
    .prepare("SELECT doc FROM piece_versions WHERE piece_id = ? AND version = ?")
    .get(piece.id, version) as { doc: string } | undefined;
  if (!row) {
    return errResult(
      "unknown_version",
      `No version ${version} in the history of "${piece.title}".`,
      "Call marketingos.list_versions to see the versions that exist."
    );
  }

  const doc = pieceDocSchema.parse(JSON.parse(row.doc));
  const newVersion = persistNewVersion(
    piece,
    doc,
    actor,
    `Restored the document of version ${version}`
  );

  audit("ai-host", "pieces.version_restored", {
    pieceId: piece.id,
    projectId: piece.projectId,
    restoredVersion: version,
    newVersion,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: { id: piece.id, title: piece.title, docVersion: newVersion, doc },
      restoredVersion: version,
    },
  };
}
