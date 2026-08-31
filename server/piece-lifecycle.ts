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
// A later kit change flags approved and planned work brand-outdated rather
// than silently repainting it, and re-approval re-pins the kit without
// disturbing status or planned date.

import { z } from "zod";
import { audit } from "./audit";
import { currentKit } from "./brand-kit";
import { brandReport, qualityReport, type CheckFinding } from "./checks";
import { getDb } from "./db";
import { sessionContext, type GatewayResult } from "./gateway";
import { scopedPiece } from "./piece-edits";
import { getPieceById, type PieceDoc, type PieceRecord, type PieceStatus } from "./pieces";

export { PINNED_STATUSES, flagBrandOutdated } from "./pieces";

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

function setStatus(
  piece: PieceRecord,
  status: PieceStatus,
  extra: Partial<{
    pinnedKitVersion: number | null;
    brandOutdated: boolean;
    plannedDate: string | null;
  }> = {}
): PieceRecord {
  const assignments = ["status = ?", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const values: (string | number | null)[] = [status];
  if ("pinnedKitVersion" in extra) {
    assignments.push("pinned_kit_version = ?");
    values.push(extra.pinnedKitVersion ?? null);
  }
  if ("brandOutdated" in extra) {
    assignments.push("brand_outdated = ?");
    values.push(extra.brandOutdated ? 1 : 0);
  }
  if ("plannedDate" in extra) {
    assignments.push("planned_date = ?");
    values.push(extra.plannedDate ?? null);
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

/** Everything that stands between a piece and approval, right now. */
export function approvalBlockers(piece: PieceRecord): ApprovalBlockers {
  const kit = currentKit(piece.projectId);
  return {
    brandErrors: brandReport(piece.doc, piece.docVersion, kit).errors,
    needTokens: needTokens(piece.doc),
  };
}

function blockedResult(piece: PieceRecord, blockers: ApprovalBlockers, verb: string): GatewayResult {
  const reasons = [
    ...blockers.brandErrors.map((f) => f.message),
    ...blockers.needTokens.map(
      (n) => `${n.where} still carries the unsupported-claim token ${n.token}.`
    ),
  ];
  return {
    ok: false,
    response: {
      error: "approval_blocked",
      message: `${verb} refused for "${piece.title}": ${reasons.length} blocker(s). ${reasons.join(" ")}`,
      next: "Reopen the piece to drafting, fix every blocker, and submit for review again. Quality findings are advisory and never block.",
      blockers: {
        brandErrors: blockers.brandErrors,
        needTokens: blockers.needTokens,
      },
    },
  };
}

function lifecycleResponse(
  sessionKey: string | null,
  piece: PieceRecord,
  note: string
): GatewayResult {
  const quality = qualityReport(piece.doc, piece.docVersion);
  return {
    ok: true,
    response: {
      ...(sessionKey === null ? {} : { context: sessionContext(sessionKey) }),
      piece: {
        id: piece.id,
        title: piece.title,
        status: piece.status,
        docVersion: piece.docVersion,
        pinnedKitVersion: piece.pinnedKitVersion,
        brandOutdated: piece.brandOutdated,
        plannedDate: piece.plannedDate,
      },
      note,
      // Reported, never enforced: heuristics advise.
      qualityFindings: quality.findings,
    },
  };
}

// ---------------------------------------------------------------------------
// Transitions, as functions of a piece the caller has already scoped

export function startDraftingPiece(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "backlog") return wrongStatus(piece, "Start drafting", "backlog");
  const updated = setStatus(piece, "drafting");
  audit(actor, "pieces.drafting", { pieceId: piece.id, from: "backlog" });
  return lifecycleResponse(null, updated, `"${piece.title}" moved backlog → drafting.`);
}

export function submitPieceForReview(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "drafting") return wrongStatus(piece, "Submitting for review", "drafting");
  const updated = setStatus(piece, "review");
  audit(actor, "pieces.submitted", { pieceId: piece.id, docVersion: piece.docVersion });
  return lifecycleResponse(
    null,
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
  const updated = setStatus(piece, "drafting");
  audit(actor, "pieces.changes_requested", { pieceId: piece.id, reason: reason ?? null });
  return lifecycleResponse(
    null,
    updated,
    `Changes requested; "${piece.title}" moved review → drafting.${reason ? ` ${reason}` : ""}`
  );
}

export function approvePiece(piece: PieceRecord, actor: string): GatewayResult {
  if (piece.status !== "review") return wrongStatus(piece, "Approval", "review");

  const blockers = approvalBlockers(piece);
  if (blockers.brandErrors.length > 0 || blockers.needTokens.length > 0) {
    audit(actor, "pieces.approval_blocked", {
      pieceId: piece.id,
      brandErrors: blockers.brandErrors.length,
      needTokens: blockers.needTokens.length,
    });
    return blockedResult(piece, blockers, "Approval");
  }

  const kit = currentKit(piece.projectId);
  const updated = setStatus(piece, "approved", {
    pinnedKitVersion: kit.version,
    brandOutdated: false,
  });
  audit(actor, "pieces.approved", {
    pieceId: piece.id,
    docVersion: piece.docVersion,
    kitVersion: kit.version,
  });
  return lifecycleResponse(
    null,
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
  if (blockers.brandErrors.length > 0 || blockers.needTokens.length > 0) {
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
  const updated = setStatus(piece, piece.status, {
    pinnedKitVersion: kit.version,
    brandOutdated: false,
  });
  audit(actor, "pieces.reapproved", {
    pieceId: piece.id,
    kitVersion: kit.version,
    status: piece.status,
  });
  return lifecycleResponse(
    null,
    updated,
    `"${piece.title}" re-approved; rendering re-pinned to Brand Kit v${kit.version}. Its status (${piece.status}) and planned date are unchanged.`
  );
}

export function reopenPiece(piece: PieceRecord, actor: string): GatewayResult {
  if (!REOPENABLE_STATUSES.includes(piece.status)) {
    return wrongStatus(piece, "Reopening", REOPENABLE_STATUSES.join(", "));
  }
  const from = piece.status;
  const updated = setStatus(piece, "drafting", {
    pinnedKitVersion: null,
    brandOutdated: false,
    plannedDate: null,
  });
  audit(actor, "pieces.reopened", { pieceId: piece.id, from });
  return lifecycleResponse(
    null,
    updated,
    `"${piece.title}" reopened ${from} → drafting. Approval and planned date were cleared; it must pass review again.`
  );
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
      piece: {
        id: piece.id,
        title: piece.title,
        status: piece.status,
        docVersion: piece.docVersion,
        pinnedKitVersion: piece.pinnedKitVersion,
        brandOutdated: piece.brandOutdated,
      },
      approval: {
        blocked: blockers.brandErrors.length > 0 || blockers.needTokens.length > 0,
        brandErrors: blockers.brandErrors,
        needTokens: blockers.needTokens,
        qualityFindings: quality.findings,
        note: "Brand errors and [NEED: ...] tokens block approval. Quality findings advise; they never block. The Operator approves, in the dashboard.",
      },
    },
  };
}
