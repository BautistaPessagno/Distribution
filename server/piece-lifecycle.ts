// The review and approval gate (ticket 13; reference behavior: the
// SUBMIT_REVIEW, REQUEST_CHANGES, APPROVE, REOPEN, and REAPPROVE cases of
// CreativePieceMachine in creative-piece-workflow.html).
//
// backlog → drafting → review → approved, with changes-requested looping
// review back to drafting and reopen returning review, approved, or planned
// work to drafting.
//
// Approval is the Operator's act and it means one thing: the Operator saw
// THIS document rendered through THIS Brand Kit. So approval
//   - refuses while check_brand reports an error or the copy still carries
//     an unsupported-claim [NEED: ...] token, naming every blocker;
//   - never refuses for a check_quality finding, which only advises;
//   - pins the kit version the piece was approved against.
// A later kit change flags approved and planned work brand-outdated. The
// preview still repaints — that is how the Operator sees what changed — but
// the export renders through the pinned kit, so the artifact that leaves is
// the one that was approved. Re-approval re-pins without disturbing status
// or planned date.

import { z } from "zod";
import { audit } from "./audit";
import { currentKit } from "./brand-kit";
import { brandReport, qualityReport, type CheckFinding } from "./checks";
import { getDb } from "./db";
import { sessionContext, type GatewayResult } from "./gateway";
import { scopedPiece } from "./piece-edits";
import { getPieceById, type PieceDoc, type PieceRecord, type PieceStatus } from "./pieces";

/** A piece can be reopened to drafting from any of these. */
export const REOPENABLE_STATUSES: readonly PieceStatus[] = ["review", "approved", "planned"];

// An unsupported claim renders as a visible [NEED: ...] token. Deterministic,
// like the brand check: the copy either still carries one or it does not.
const NEED_TOKEN = /\[NEED(?::[^\]]*)?\]/g;

export interface NeedToken {
  where: string;
  token: string;
}

export function needTokens(doc: PieceDoc): NeedToken[] {
  const found: NeedToken[] = [];
  const scan = (text: string, where: string): void => {
    for (const match of text.matchAll(NEED_TOKEN)) {
      found.push({ where, token: match[0] });
    }
  };
  doc.slides.forEach((slide, slideIndex) => {
    slide.layers.forEach((layer, layerIndex) => {
      if (layer.type === "text") {
        scan(layer.text, `slide ${slideIndex + 1}, layer ${layerIndex} (text)`);
      }
    });
  });
  for (const [network, caption] of Object.entries(doc.captions)) {
    scan(caption, `the ${network} caption`);
  }
  return found;
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function wrongStatus(piece: PieceRecord, action: string, expected: string): GatewayResult {
  return errResult(
    "wrong_status",
    `${action} happens from ${expected}. "${piece.title}" is ${piece.status}.`,
    `Read the piece with marketingos.get_piece to see where it is in the lifecycle.`
  );
}

/**
 * What a move writes alongside the status. Naming each shape is what keeps
 * the writes honest: a move touches these columns and nothing else.
 */
type RowWrite =
  /** Move the status; leave pin, flag, and planned date exactly as they are. */
  | { kind: "keep" }
  /** Approval or re-approval: pin this kit version and clear the flag. */
  | { kind: "pin"; kitVersion: number }
  /** Reopen: the approval and the plan it carried are gone. */
  | { kind: "clear" }
  /** Plan or unplan: set or drop the date, touching nothing else. */
  | { kind: "plan"; date: string | null }
  /** Record what was observed once the piece had run. */
  | { kind: "outcome"; note: string };

function writeStatus(
  piece: PieceRecord,
  status: PieceStatus,
  write: RowWrite
): PieceRecord {
  const assignments = ["status = ?", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const values: (string | number | null)[] = [status];
  if (write.kind === "pin") {
    assignments.push("pinned_kit_version = ?", "brand_outdated = 0");
    values.push(write.kitVersion);
  } else if (write.kind === "clear") {
    assignments.push("pinned_kit_version = NULL", "brand_outdated = 0", "planned_date = NULL");
  } else if (write.kind === "plan") {
    assignments.push("planned_date = ?");
    values.push(write.date);
  } else if (write.kind === "outcome") {
    assignments.push("outcome = ?");
    values.push(write.note);
  }
  getDb()
    .prepare(`UPDATE pieces SET ${assignments.join(", ")} WHERE id = ?`)
    .run(...values, piece.id);
  const updated = getPieceById(piece.id);
  if (!updated) throw new Error("piece update did not persist");
  return updated;
}

export interface ApprovalBlockers {
  brandErrors: CheckFinding[];
  needTokens: NeedToken[];
}

/** True when anything at all stands between this piece and approval. */
export function isBlocked(blockers: ApprovalBlockers): boolean {
  return blockers.brandErrors.length > 0 || blockers.needTokens.length > 0;
}

/** Everything that stands between a piece and approval, right now. */
export function approvalBlockers(piece: PieceRecord): ApprovalBlockers {
  const kit = currentKit(piece.projectId);
  return {
    brandErrors: brandReport(piece.doc, piece.docVersion, kit).errors,
    needTokens: needTokens(piece.doc),
  };
}

function blockedResult(
  piece: PieceRecord,
  blockers: ApprovalBlockers,
  verb: "Approval" | "Re-approval"
): GatewayResult {
  const reasons = [
    ...blockers.brandErrors.map((f) => f.message),
    ...blockers.needTokens.map(
      (n) => `${n.where} still carries the unsupported-claim token ${n.token}.`
    ),
  ];
  // Reopening a piece clears its planned date, which is exactly what
  // re-approval exists to preserve — so only the first-approval path is
  // told to reopen.
  const next =
    verb === "Approval"
      ? "Reopen the piece to drafting, fix every blocker, and submit for review again. Quality findings are advisory and never block."
      : "Fix the Brand Kit or reopen the piece to drafting to edit it — reopening clears the planned date. Quality findings are advisory and never block.";
  return {
    ok: false,
    response: {
      error: "approval_blocked",
      message: `${verb} refused for "${piece.title}": ${reasons.length} blocker(s). ${reasons.join(" ")}`,
      next,
      blockers: {
        brandErrors: blockers.brandErrors,
        needTokens: blockers.needTokens,
      },
    },
  };
}

/** The lifecycle state of a piece, as every response reports it. */
function lifecycleSummary(piece: PieceRecord): Record<string, unknown> {
  return {
    id: piece.id,
    title: piece.title,
    status: piece.status,
    docVersion: piece.docVersion,
    pinnedKitVersion: piece.pinnedKitVersion,
    brandOutdated: piece.brandOutdated,
    plannedDate: piece.plannedDate,
    outcome: piece.outcome,
  };
}

function lifecycleResponse(piece: PieceRecord, note: string): GatewayResult {
  return {
    ok: true,
    response: {
      piece: lifecycleSummary(piece),
      note,
      // Reported, never enforced: heuristics advise.
      qualityFindings: qualityReport(piece.doc, piece.docVersion).findings,
      operatorMoves: availableOperatorMoves(piece),
    },
  };
}

// ---------------------------------------------------------------------------
// Transitions, as functions of a piece the caller has already scoped

export function startDraftingPiece(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "backlog") return wrongStatus(piece, "Start drafting", "backlog");
  const updated = writeStatus(piece, "drafting", { kind: "keep" });
  audit(actor, "pieces.drafting", { pieceId: piece.id, from: "backlog" });
  return lifecycleResponse(updated, `"${piece.title}" moved backlog → drafting.`);
}

export function submitPieceForReview(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "drafting") return wrongStatus(piece, "Submitting for review", "drafting");
  const updated = writeStatus(piece, "review", { kind: "keep" });
  audit(actor, "pieces.submitted", { pieceId: piece.id, docVersion: piece.docVersion });
  return lifecycleResponse(
    updated,
    `"${piece.title}" moved drafting → review at version ${piece.docVersion}.`
  );
}

export function requestPieceChanges(
  piece: PieceRecord,
  actor: string,
  reason?: string
): GatewayResult {
  if (piece.status !== "review") return wrongStatus(piece, "Requesting changes", "review");
  const updated = writeStatus(piece, "drafting", { kind: "keep" });
  audit(actor, "pieces.changes_requested", { pieceId: piece.id, reason: reason ?? null });
  return lifecycleResponse(
    updated,
    `Changes requested; "${piece.title}" moved review → drafting.${reason ? ` ${reason}` : ""}`
  );
}

export function approvePiece(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "review") return wrongStatus(piece, "Approval", "review");

  const blockers = approvalBlockers(piece);
  if (isBlocked(blockers)) {
    audit(actor, "pieces.approval_blocked", {
      pieceId: piece.id,
      brandErrors: blockers.brandErrors.length,
      needTokens: blockers.needTokens.length,
    });
    return blockedResult(piece, blockers, "Approval");
  }

  const kit = currentKit(piece.projectId);
  const updated = writeStatus(piece, "approved", { kind: "pin", kitVersion: kit.version });
  audit(actor, "pieces.approved", {
    pieceId: piece.id,
    docVersion: piece.docVersion,
    kitVersion: kit.version,
  });
  return lifecycleResponse(
    updated,
    `"${piece.title}" approved at version ${piece.docVersion}, rendering pinned to Brand Kit v${kit.version}.`
  );
}

export function reapprovePiece(piece: PieceRecord, actor: string): GatewayResult {
  if (!piece.brandOutdated) {
    return errResult(
      "not_brand_outdated",
      `"${piece.title}" is not brand-outdated; there is nothing to re-pin.`,
      "Re-approval exists for work whose Brand Kit changed after approval."
    );
  }

  const blockers = approvalBlockers(piece);
  if (isBlocked(blockers)) {
    audit(actor, "pieces.reapproval_blocked", {
      pieceId: piece.id,
      brandErrors: blockers.brandErrors.length,
      needTokens: blockers.needTokens.length,
    });
    return blockedResult(piece, blockers, "Re-approval");
  }

  const kit = currentKit(piece.projectId);
  // Status and planned date are deliberately untouched: re-approval is about
  // the rendering the Operator saw, not about where the piece is.
  const updated = writeStatus(piece, piece.status, { kind: "pin", kitVersion: kit.version });
  audit(actor, "pieces.reapproved", {
    pieceId: piece.id,
    kitVersion: kit.version,
    status: piece.status,
  });
  return lifecycleResponse(
    updated,
    `"${piece.title}" re-approved; rendering re-pinned to Brand Kit v${kit.version}. Its status (${piece.status}) and planned date are unchanged.`
  );
}

export function reopenPiece(piece: PieceRecord, actor: string): GatewayResult {
  if (!REOPENABLE_STATUSES.includes(piece.status)) {
    return wrongStatus(piece, "Reopening", REOPENABLE_STATUSES.join(", "));
  }
  const from = piece.status;
  const updated = writeStatus(piece, "drafting", { kind: "clear" });
  audit(actor, "pieces.reopened", { pieceId: piece.id, from });
  return lifecycleResponse(
    updated,
    `"${piece.title}" reopened ${from} → drafting. Approval and planned date were cleared; it must pass review again.`
  );
}

/** The Operator moves this piece can take right now, in the order Studio shows them. */
export const OPERATOR_MOVES = [
  "approve",
  "request-changes",
  "reapprove",
  "plan",
  "unplan",
  "export",
  "reopen",
] as const;
export type OperatorMove = (typeof OPERATOR_MOVES)[number];

export function availableOperatorMoves(piece: PieceRecord): OperatorMove[] {
  return OPERATOR_MOVES.filter((move) => {
    switch (move) {
      case "approve":
      case "request-changes":
        return piece.status === "review";
      case "reapprove":
        return piece.brandOutdated;
      case "plan":
        return piece.status === "approved";
      case "unplan":
        return piece.status === "planned";
      case "export":
        return piece.status === "planned";
      case "reopen":
        return REOPENABLE_STATUSES.includes(piece.status);
    }
  });
}

// ---------------------------------------------------------------------------
// Planning, export readiness, and the recorded outcome (ticket 14)

// A planned date is an ISO calendar day. It says when the Operator intends
// to do the work; nothing anywhere publishes on it.
const PLANNED_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!PLANNED_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function planPiece(piece: PieceRecord, date: unknown, actor: string): GatewayResult {
  if (piece.status !== "approved") return wrongStatus(piece, "Planning a date", "approved");
  if (typeof date !== "string" || !isCalendarDate(date)) {
    return errResult(
      "invalid_date",
      `"${String(date)}" is not a calendar date.`,
      "Pass a date as YYYY-MM-DD. A planned date is a plan; nothing publishes on it."
    );
  }
  const updated = writeStatus(piece, "planned", { kind: "plan", date });
  audit(actor, "pieces.planned", { pieceId: piece.id, date });
  return lifecycleResponse(
    updated,
    `"${piece.title}" planned for ${date}. A planned date is a plan; nothing publishes automatically.`
  );
}

export function unplanPiece(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "planned") return wrongStatus(piece, "Unplanning", "planned");
  const updated = writeStatus(piece, "approved", { kind: "plan", date: null });
  audit(actor, "pieces.unplanned", { pieceId: piece.id });
  return lifecycleResponse(
    updated,
    `"${piece.title}" unplanned; back to approved and undated. The approval still stands.`
  );
}

/**
 * Why this piece cannot be exported, or null when it can. Export is the one
 * step that produces an artifact for the outside world, so it happens only
 * from planned and only while the approved rendering is still current.
 */
export function exportRefusal(piece: PieceRecord): GatewayResult | null {
  if (piece.status !== "planned") {
    return errResult(
      "not_exportable",
      `Export happens from planned. "${piece.title}" is ${piece.status}.`,
      piece.status === "approved"
        ? "Give the piece a planned date first with marketingos.plan_piece."
        : "Take the piece through review and approval, then plan it."
    );
  }
  if (piece.brandOutdated) {
    return errResult(
      "brand_outdated",
      `Export refused: the Brand Kit changed after "${piece.title}" was approved against v${piece.pinnedKitVersion}. Approval means the Operator saw that exact rendering.`,
      "Re-approve the piece so the Operator sees the current rendering, then export."
    );
  }
  return null;
}

/**
 * Called by the exporter once a bundle exists. The exporter writes the audit
 * row for the export itself, so this only moves the status.
 */
export function markExported(piece: PieceRecord): PieceRecord {
  return writeStatus(piece, "exported", { kind: "keep" });
}

export function recordOutcome(piece: PieceRecord, note: unknown, actor: string): GatewayResult {
  if (piece.status !== "exported") return wrongStatus(piece, "Recording an outcome", "exported");
  if (typeof note !== "string" || note.trim() === "") {
    return errResult(
      "invalid_outcome",
      "An outcome records what was observed.",
      "Pass a short note describing what happened when the piece ran."
    );
  }
  const updated = writeStatus(piece, "measured", { kind: "outcome", note: note.trim() });
  audit(actor, "pieces.measured", { pieceId: piece.id });
  return lifecycleResponse(updated, `Outcome recorded for "${piece.title}".`);
}

// ---------------------------------------------------------------------------
// Host surface
//
// The AI Host moves a piece it is drafting up to review. It cannot approve:
// approval means the Operator saw the document, so approve, request changes,
// reopen, and re-approve are Operator acts on the dashboard.

const pieceIdSchema = z.object({ id: z.number().int() });

function invalidTransition(tool: string): GatewayResult {
  return errResult(
    "invalid_transition",
    "A lifecycle move names the piece id.",
    `Call ${tool} with {id}.`
  );
}

function hostTransition(
  sessionKey: string,
  input: unknown,
  tool: string,
  move: (piece: PieceRecord, actor: string) => GatewayResult
): GatewayResult {
  const parsed = pieceIdSchema.safeParse(input);
  if (!parsed.success) return invalidTransition(tool);

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;

  const result = move(scoped.piece, "ai-host");
  if (!result.ok) return result;
  return {
    ok: true,
    response: { context: sessionContext(sessionKey), ...result.response },
  };
}

export function startDrafting(sessionKey: string, input: unknown): GatewayResult {
  return hostTransition(sessionKey, input, "marketingos.start_drafting", startDraftingPiece);
}

export function submitForReview(sessionKey: string, input: unknown): GatewayResult {
  return hostTransition(sessionKey, input, "marketingos.submit_for_review", submitPieceForReview);
}

export function recordPieceOutcome(sessionKey: string, input: unknown): GatewayResult {
  const parsed = z.object({ id: z.number().int(), outcome: z.string() }).safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_transition",
      "Recording an outcome names the piece id and what was observed.",
      "Call marketingos.record_outcome with {id, outcome}."
    );
  }
  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;
  const result = recordOutcome(scoped.piece, parsed.data.outcome, "ai-host");
  if (!result.ok) return result;
  return { ok: true, response: { context: sessionContext(sessionKey), ...result.response } };
}

// Reopening is not undoing an approval on the Operator's behalf: it moves
// work back to drafting, where nothing can be planned or exported. The edit
// refusal in piece-edits.ts names this tool as the way back.
export function reopen(sessionKey: string, input: unknown): GatewayResult {
  return hostTransition(sessionKey, input, "marketingos.reopen_piece", reopenPiece);
}

/**
 * What stands between a piece and approval, for the host to read before it
 * hands work to the Operator.
 */
export function approvalStatus(sessionKey: string, input: unknown): GatewayResult {
  const parsed = pieceIdSchema.safeParse(input);
  if (!parsed.success) return invalidTransition("marketingos.approval_status");

  const scoped = scopedPiece(sessionKey, parsed.data.id);
  if ("error" in scoped) return scoped.error;
  const { piece } = scoped;

  const blockers = approvalBlockers(piece);
  const quality = qualityReport(piece.doc, piece.docVersion);
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      piece: lifecycleSummary(piece),
      approval: {
        blocked: isBlocked(blockers),
        brandErrors: blockers.brandErrors,
        needTokens: blockers.needTokens,
        qualityFindings: quality.findings,
        note: "Brand errors and [NEED: ...] tokens block approval. Quality findings advise; they never block. The Operator approves, in the dashboard.",
      },
    },
  };
}
