// Creative Templates (ticket 15; reference behavior: the SAVE_AS_TEMPLATE
// case of CreativePieceMachine in creative-piece-workflow.html).
//
// A Creative Template is a reusable structure and visual treatment, without
// the campaign it came from. Saving one copies the PieceDoc and strips it:
// every text layer is emptied, every caption is emptied, and no planning
// data comes along — a template has no status, no date, no version history,
// no approval, and no outcome. Layout survives whole: slides, layer order,
// frames, formats, and every Brand Kit token reference.
//
// Instantiating a template is the mirror image: a fresh backlog piece bound
// to the snapshot pinned on the session doing the instantiating, never the
// snapshot the template was saved from.

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
import { scopedPiece } from "./piece-edits";
import {
  CAPTION_NETWORKS,
  pieceDocSchema,
  type PieceDoc,
  type PieceRecord,
} from "./pieces";

export interface CreativeTemplate {
  id: number;
  projectId: number;
  name: string;
  fromPieceId: number | null;
  doc: PieceDoc;
  createdAt: string;
}

interface TemplateRow {
  id: number;
  project_id: number;
  name: string;
  from_piece_id: number | null;
  doc: string;
  created_at: string;
}

function rowToTemplate(row: TemplateRow): CreativeTemplate {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    fromPieceId: row.from_piece_id,
    doc: JSON.parse(row.doc) as PieceDoc,
    createdAt: row.created_at,
  };
}

/**
 * The strip. Everything a campaign wrote goes; everything that makes the
 * piece look the way it looks stays.
 *
 * Emptied: text layer copy (which is where claims and [NEED: ...] tokens
 * live) and all four captions. Kept: the format, the slides, the layer
 * order and types, every frame, and every `brand.*` / `font.*` token
 * reference. Planning data is not stripped so much as never copied — a
 * template holds a document, not a piece.
 */
export function stripToTemplate(doc: PieceDoc): PieceDoc {
  const copy = JSON.parse(JSON.stringify(doc)) as PieceDoc;
  for (const slide of copy.slides) {
    for (const layer of slide.layers) {
      if (layer.type === "text") layer.text = "";
    }
  }
  for (const network of CAPTION_NETWORKS) copy.captions[network] = "";
  return copy;
}

export function listTemplatesForProject(projectId: number): CreativeTemplate[] {
  const rows = getDb()
    .prepare("SELECT * FROM creative_templates WHERE project_id = ? ORDER BY id DESC")
    .all(projectId) as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function listAllTemplates(): CreativeTemplate[] {
  const rows = getDb()
    .prepare("SELECT * FROM creative_templates ORDER BY id DESC")
    .all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

export function getTemplateById(id: number): CreativeTemplate | null {
  const row = getDb().prepare("SELECT * FROM creative_templates WHERE id = ?").get(id) as
    | TemplateRow
    | undefined;
  return row ? rowToTemplate(row) : null;
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function templateSummary(template: CreativeTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    format: template.doc.format,
    slides: template.doc.slides.length,
    layers: template.doc.slides.reduce((total, slide) => total + slide.layers.length, 0),
    fromPieceId: template.fromPieceId,
    createdAt: template.createdAt,
  };
}

export const saveAsTemplateInputSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(200).optional(),
});

/**
 * Save a Creative Piece's structure as a Creative Template. The piece is
 * untouched: this reads its document and writes a stripped copy.
 */
export function saveAsTemplate(
  sessionKey: string,
  input: unknown,
  actor = "ai-host"
): GatewayResult {
  const parsed = saveAsTemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_template",
      "Saving a template names the piece to take the layout from.",
      "Call marketingos.save_as_template with {id} or {id, name}."
    );
  }

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;

  const result = saveAsTemplateFor(scoped.piece, parsed.data.name, actor);
  if (!result.ok) return result;
  return { ok: true, response: { context: sessionContext(sessionKey), ...result.response } };
}

/** The save itself, for the Operator surface, which has no gateway session. */
export function saveAsTemplateFor(
  piece: PieceRecord,
  requestedName: string | undefined,
  actor: string
): GatewayResult {
  const name = requestedName ?? `${piece.title} layout`;
  const doc = stripToTemplate(piece.doc);
  const info = getDb()
    .prepare(
      "INSERT INTO creative_templates (project_id, name, from_piece_id, doc) VALUES (?, ?, ?, ?)"
    )
    .run(piece.projectId, name, piece.id, JSON.stringify(doc));

  const template = getTemplateById(Number(info.lastInsertRowid));
  if (!template) throw new Error("template insert did not persist");

  audit(actor, "templates.saved", {
    templateId: template.id,
    fromPieceId: piece.id,
    projectId: piece.projectId,
  });

  return {
    ok: true,
    response: {
      template: { ...templateSummary(template), doc: template.doc },
      note: `Saved Creative Template "${name}": layout and token references kept; campaign text, claims, captions, and planning data stripped.`,
    },
  };
}

export function listTemplates(sessionKey: string): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      templates: listTemplatesForProject(pinned.projectId).map(templateSummary),
    },
  };
}

export const instantiateTemplateInputSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
});

/**
 * Start a new Creative Piece from a template. The piece is bound to the
 * snapshot pinned on THIS session, not the one the template came from: a
 * template carries layout across time, never stale project context.
 */
export function instantiateTemplate(
  sessionKey: string,
  input: unknown,
  actor = "ai-host"
): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = instantiateTemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_template",
      "Starting a piece from a template names the template and the new piece's title.",
      "Call marketingos.instantiate_template with {id, title}."
    );
  }

  const template = getTemplateById(parsed.data.id);
  if (!template) {
    return errResult(
      "unknown_template",
      `No Creative Template #${parsed.data.id}.`,
      "Call marketingos.list_templates to see the templates of the selected project."
    );
  }
  if (template.projectId !== pinned.projectId) {
    return errResult(
      "cross_project_refused",
      `Creative Template #${template.id} belongs to a different Connected Project than '${pinned.projectName}'.`,
      "Select the project the template belongs to with marketingos.select_project, then start a piece there."
    );
  }

  // Parsing on the way out as well as in: a template that predates a schema
  // change should fail loudly here, not produce a malformed piece.
  const doc = pieceDocSchema.parse(template.doc);
  const db = getDb();
  const info = db.transaction(() => {
    const inserted = db
      .prepare("INSERT INTO pieces (project_id, title, snapshot, doc) VALUES (?, ?, ?, ?)")
      .run(pinned.projectId, parsed.data.title, pinned.snapshotId, JSON.stringify(doc));
    db.prepare(
      "INSERT INTO piece_versions (piece_id, version, actor, summary, doc) VALUES (?, 1, ?, ?, ?)"
    ).run(
      Number(inserted.lastInsertRowid),
      actor,
      `Created from Creative Template "${template.name}"`,
      JSON.stringify(doc)
    );
    return inserted;
  })();

  const pieceId = Number(info.lastInsertRowid);
  registerInFlight(sessionKey, `piece #${pieceId} "${parsed.data.title}"`);
  audit(actor, "templates.instantiated", {
    templateId: template.id,
    pieceId,
    projectId: pinned.projectId,
    snapshot: pinned.snapshotId,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: {
        id: pieceId,
        title: parsed.data.title,
        status: "backlog",
        format: doc.format,
        slides: doc.slides.length,
        snapshot: pinned.snapshotId,
        docVersion: 1,
        doc,
      },
      note: `Started "${parsed.data.title}" from Creative Template "${template.name}". The layout is in place; the copy and captions are yours to write.`,
    },
  };
}
