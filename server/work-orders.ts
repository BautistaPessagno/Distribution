// Work Orders and the proof cycle (ticket 20; decisions:
// .scratch/marketing-os/issues/12-define-account-operations-workflow.md).
//
// MarketingOS never performs a platform action. Everything that touches a
// platform is a person's hand, so a Work Order is an instruction to that
// person and a place to put what came back. The lifecycle is kept whole
// even with a single Operator, because the shape is what makes inviting a
// second one a configuration change rather than a redesign.
//
//   draft -> awaiting_brand_approval -> queued -> claimed -> in_progress
//         -> proof_submitted -> under_review -> completed
//
// with changes_requested looping back to queued, and cancelled and failed
// as exits.
//
// Two rules hold the whole thing up:
//
//   Nothing completes without proof. Not "the Operator says it is done" —
//   the thing they did, written down, attached to the attempt that did it.
//
//   Attempts are append-only. A retry is attempt two, not an edit of
//   attempt one. The proof and the review of a rejected attempt survive it,
//   because what went wrong the first time is the part worth keeping.

import { z } from "zod";
import {
  currentInstance,
  getSlotById,
  markInstanceLost,
  READINESS_ITEMS,
  READINESS_LABELS,
  recordReadiness,
  type AccountInstance,
  type AccountSlot,
  type ReadinessItem,
} from "./accounts";
import { audit } from "./audit";
import { getDb } from "./db";
import { APPROVED_STATUSES, getPieceById } from "./pieces";
import { policyFor } from "./platform-policy";
import { releaseGate } from "./release-gate";

export const ORDER_KINDS = [
  "provision",
  "warmup",
  "post",
  "comment",
  "measure",
  "replace",
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATUSES = [
  "draft",
  "awaiting_brand_approval",
  "queued",
  "claimed",
  "in_progress",
  "proof_submitted",
  "under_review",
  "changes_requested",
  "completed",
  "cancelled",
  "failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Nothing moves out of these. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ["completed", "cancelled", "failed"];

export interface WorkOrder {
  id: number;
  projectId: number;
  slotId: number | null;
  instanceId: number | null;
  pieceId: number | null;
  kind: OrderKind;
  title: string;
  instruction: string;
  proofRequirement: string;
  readinessItem: ReadinessItem | null;
  /** The platform action a daily cap counts this order against, if any. */
  cappedAction: string | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: number;
  orderId: number;
  attemptNo: number;
  claimedBy: string;
  claimedAt: string;
  proof: { body: string; submittedBy: string; submittedAt: string } | null;
  review: {
    decision: "accepted" | "changes_requested" | "failed";
    note: string;
    reviewedBy: string;
    reviewedAt: string;
  } | null;
}

export interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  actor: string;
  note: string;
  at: string;
}

export class WorkOrderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "WorkOrderError";
  }
}

interface OrderRow {
  id: number;
  project_id: number;
  slot_id: number | null;
  instance_id: number | null;
  piece_id: number | null;
  kind: OrderKind;
  title: string;
  instruction: string;
  proof_requirement: string;
  readiness_item: ReadinessItem | null;
  capped_action: string | null;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

function rowToOrder(row: OrderRow): WorkOrder {
  return {
    id: row.id,
    projectId: row.project_id,
    slotId: row.slot_id,
    instanceId: row.instance_id,
    pieceId: row.piece_id,
    kind: row.kind,
    title: row.title,
    instruction: row.instruction,
    proofRequirement: row.proof_requirement,
    readinessItem: row.readiness_item,
    cappedAction: row.capped_action,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reading

export function getOrderById(id: number): WorkOrder | null {
  const row = getDb().prepare("SELECT * FROM work_orders WHERE id = ?").get(id) as
    | OrderRow
    | undefined;
  return row ? rowToOrder(row) : null;
}

export function listOrders(filter: { projectId?: number; slotId?: number } = {}): WorkOrder[] {
  const where: string[] = [];
  const args: number[] = [];
  if (filter.projectId !== undefined) {
    where.push("project_id = ?");
    args.push(filter.projectId);
  }
  if (filter.slotId !== undefined) {
    where.push("slot_id = ?");
    args.push(filter.slotId);
  }
  const sql = `SELECT * FROM work_orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return (getDb().prepare(sql).all(...args) as OrderRow[]).map(rowToOrder);
}

export function attemptsFor(orderId: number): Attempt[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM work_order_attempts WHERE order_id = ? ORDER BY attempt_no ASC")
    .all(orderId) as {
    id: number;
    order_id: number;
    attempt_no: number;
    claimed_by: string;
    claimed_at: string;
  }[];
  return rows.map((row) => {
    const proof = db
      .prepare(
        "SELECT body, submitted_by, submitted_at FROM work_order_proofs WHERE attempt_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(row.id) as { body: string; submitted_by: string; submitted_at: string } | undefined;
    const review = db
      .prepare(
        "SELECT decision, note, reviewed_by, reviewed_at FROM work_order_reviews WHERE attempt_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(row.id) as
      | {
          decision: "accepted" | "changes_requested" | "failed";
          note: string;
          reviewed_by: string;
          reviewed_at: string;
        }
      | undefined;
    return {
      id: row.id,
      orderId: row.order_id,
      attemptNo: row.attempt_no,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      proof: proof
        ? { body: proof.body, submittedBy: proof.submitted_by, submittedAt: proof.submitted_at }
        : null,
      review: review
        ? {
            decision: review.decision,
            note: review.note,
            reviewedBy: review.reviewed_by,
            reviewedAt: review.reviewed_at,
          }
        : null,
    };
  });
}

/** The attempt currently in play: the last one opened. */
export function currentAttempt(orderId: number): Attempt | null {
  const all = attemptsFor(orderId);
  return all.length ? all[all.length - 1] : null;
}

export function transitionsFor(orderId: number): Transition[] {
  const rows = getDb()
    .prepare(
      "SELECT from_status, to_status, actor, note, at FROM work_order_transitions WHERE order_id = ? ORDER BY id ASC"
    )
    .all(orderId) as {
    from_status: OrderStatus;
    to_status: OrderStatus;
    actor: string;
    note: string;
    at: string;
  }[];
  return rows.map((row) => ({
    from: row.from_status,
    to: row.to_status,
    actor: row.actor,
    note: row.note,
    at: row.at,
  }));
}

// ---------------------------------------------------------------------------
// Creating

const KIND_PROOF: Record<OrderKind, string> = {
  provision:
    "The handle of the account you created, and how you confirmed it is the account this slot describes.",
  warmup: "What you did, on which account, and where — one line is enough.",
  post: "The permalink of the published post.",
  comment: "The permalink of the comment, and the post it sits under.",
  measure: "The numbers you read, and when you read them.",
  replace:
    "The handle of the replacement account, and how you confirmed the old one is gone.",
};

/**
 * Sentences in an instruction, counted the way a person reads them: a
 * terminator followed by whitespace and another word starts a new one, so a
 * trailing full stop and an abbreviation mid-sentence do not.
 */
function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/[.!?]+\s+(?=\S)/).filter((part) => part.trim().length > 0).length;
}

export const createOrderSchema = z.object({
  projectId: z.number().int(),
  kind: z.enum(ORDER_KINDS),
  title: z.string().min(1).max(160),
  instruction: z.string().min(1).max(2000),
  slotId: z.number().int().optional(),
  instanceId: z.number().int().optional(),
  pieceId: z.number().int().optional(),
  proofRequirement: z.string().min(1).max(500).optional(),
  readinessItem: z.enum(READINESS_ITEMS).optional(),
  /**
   * The platform action this order hands out. A posting or commenting order
   * is obvious enough to default; a warm-up order says which action it is,
   * because "warm up the account" covers a follow and a like alike.
   */
  cappedAction: z.string().min(1).max(40).optional(),
});

/** What a kind counts against when nobody said. */
const DEFAULT_CAPPED_ACTION: Partial<Record<OrderKind, string>> = {
  post: "post",
  comment: "comment",
};

/**
 * A Work Order starts as a draft. It names what a person is to do, and —
 * always, from the moment it exists — what will count as having done it.
 * Deciding the proof afterwards is how "it's basically done" gets recorded
 * as done.
 */
export function createOrder(input: unknown, actor = "operator"): WorkOrder {
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkOrderError(
      400,
      "The Work Order does not match the expected shape.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const spec = parsed.data;

  // The warm-up card is one instruction, so the order carries one. Checking
  // it here is what makes the format true rather than hoped for: a card
  // cannot render one sentence out of an instruction that holds three.
  if (spec.kind === "warmup" && sentenceCount(spec.instruction) > 1) {
    throw new WorkOrderError(
      400,
      "A warm-up order is one instruction. Split this into one order per thing to do.",
      [spec.instruction]
    );
  }
  if (spec.slotId !== undefined && !getSlotById(spec.slotId)) {
    throw new WorkOrderError(404, `No Account Slot #${spec.slotId}`);
  }
  if (spec.pieceId !== undefined && !getPieceById(spec.pieceId)) {
    throw new WorkOrderError(404, `No piece #${spec.pieceId}`);
  }
  // A readiness item is earned for an instance, so the order has to say
  // which one. Otherwise completion would have nowhere to put the evidence.
  if (spec.readinessItem !== undefined && spec.instanceId === undefined && spec.slotId === undefined) {
    throw new WorkOrderError(
      400,
      "An order that earns a readiness item names the slot or the instance it earns it for."
    );
  }

  const info = getDb()
    .prepare(
      `INSERT INTO work_orders
        (project_id, slot_id, instance_id, piece_id, kind, title, instruction,
         proof_requirement, readiness_item, capped_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      spec.projectId,
      spec.slotId ?? null,
      spec.instanceId ?? null,
      spec.pieceId ?? null,
      spec.kind,
      spec.title,
      spec.instruction,
      spec.proofRequirement ?? KIND_PROOF[spec.kind],
      spec.readinessItem ?? null,
      spec.cappedAction ?? DEFAULT_CAPPED_ACTION[spec.kind] ?? null
    );

  const order = getOrderById(Number(info.lastInsertRowid));
  if (!order) throw new Error("work order did not persist");
  audit(actor, "work_orders.created", {
    orderId: order.id,
    projectId: order.projectId,
    kind: order.kind,
    slotId: order.slotId,
  });
  return order;
}

// ---------------------------------------------------------------------------
// Moving
//
// One table names every legal move. A status is not something a caller
// nudges; it is the result of a named act with a named actor, and every one
// of them lands in work_order_transitions and in the audit log.

const MOVES = {
  submit: { from: ["draft"], to: "awaiting_brand_approval" },
  approve: { from: ["awaiting_brand_approval"], to: "queued" },
  claim: { from: ["queued"], to: "claimed" },
  start: { from: ["claimed"], to: "in_progress" },
  submit_proof: { from: ["in_progress"], to: "proof_submitted" },
  begin_review: { from: ["proof_submitted"], to: "under_review" },
  complete: { from: ["under_review"], to: "completed" },
  request_changes: { from: ["under_review"], to: "changes_requested" },
  retry: { from: ["changes_requested"], to: "queued" },
  release: { from: ["claimed", "in_progress"], to: "queued" },
  fail: { from: ["in_progress", "under_review"], to: "failed" },
  cancel: {
    from: [
      "draft",
      "awaiting_brand_approval",
      "queued",
      "claimed",
      "in_progress",
      "proof_submitted",
      "under_review",
      "changes_requested",
    ],
    to: "cancelled",
  },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>;

export type Move = keyof typeof MOVES;

function requireStatus(order: WorkOrder, move: Move): void {
  const allowed = MOVES[move].from as readonly OrderStatus[];
  if (!allowed.includes(order.status)) {
    throw new WorkOrderError(
      409,
      `${move} happens from ${allowed.join(" or ")}. Work Order #${order.id} is ${order.status}.`
    );
  }
}

/**
 * Write the new status, the transition, and the audit row together, so a
 * status that moved without a recorded actor and time is not a state this
 * module can reach.
 */
function transition(order: WorkOrder, move: Move, actor: string, note = ""): WorkOrder {
  const to = MOVES[move].to;
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "UPDATE work_orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(to, order.id);
    db.prepare(
      "INSERT INTO work_order_transitions (order_id, from_status, to_status, actor, note) VALUES (?, ?, ?, ?, ?)"
    ).run(order.id, order.status, to, actor, note);
  })();
  audit(actor, `work_orders.${move}`, { orderId: order.id, from: order.status, to, note });
  const updated = getOrderById(order.id);
  if (!updated) throw new Error("work order vanished mid-transition");
  return updated;
}

function orderOr404(orderId: number): WorkOrder {
  const order = getOrderById(orderId);
  if (!order) throw new WorkOrderError(404, `No Work Order #${orderId}`);
  return order;
}

/** Send a draft for approval. */
export function submitOrder(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "submit");
  return transition(order, "submit", actor);
}

/**
 * Approve an order onto the queue. An order that carries a piece cannot be
 * released until that piece is approved: the brand gate of ticket 13 is the
 * gate here too, rather than a second opinion about the same document.
 */
export function approveOrder(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "approve");
  if (order.pieceId !== null) {
    const piece = getPieceById(order.pieceId);
    if (!piece) throw new WorkOrderError(404, `No piece #${order.pieceId}`);
    if (!APPROVED_STATUSES.includes(piece.status)) {
      throw new WorkOrderError(
        409,
        `"${piece.title}" is ${piece.status}. A Work Order that publishes a piece waits for the piece to be approved.`
      );
    }
  }
  return transition(order, "approve", actor);
}

/**
 * Claim the order. This is the moment work is handed to a person, so it is
 * the moment the safety rails apply: a paused slot, a shut window, or a
 * spent cap refuses here, and the refusal says when the queue opens again.
 * They block. Nothing in this path merely warns.
 */
export function claimOrder(orderId: number, actor = "operator", now = new Date()): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "claim");

  const gate = releaseGate(order, now);
  if (!gate.open) {
    throw new WorkOrderError(
      409,
      gate.message,
      gate.nextOpensAt ? [`The queue opens ${gate.nextOpensAt}.`] : []
    );
  }

  const next = (currentAttempt(orderId)?.attemptNo ?? 0) + 1;
  getDb()
    .prepare("INSERT INTO work_order_attempts (order_id, attempt_no, claimed_by) VALUES (?, ?, ?)")
    .run(orderId, next, actor);
  return transition(order, "claim", actor, `attempt ${next}`);
}

export function startOrder(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "start");
  return transition(order, "start", actor);
}

/** Put the order back on the queue without spending the attempt's proof. */
export function releaseOrder(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "release");
  return transition(order, "release", actor, "released back to the queue");
}

export const submitProofSchema = z.object({
  orderId: z.number().int(),
  proof: z.string().min(1).max(4000),
});

/**
 * The proof. It attaches to the attempt that produced it and is never
 * revised: a second proof on the same attempt is refused, because "let me
 * put a better one" is how the record stops matching what happened. What a
 * second try produces belongs to a second attempt.
 */
export function submitProof(input: unknown, actor = "operator"): { order: WorkOrder; attempt: Attempt } {
  const parsed = submitProofSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkOrderError(
      400,
      "Proof names the Work Order and what you did.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const order = orderOr404(parsed.data.orderId);
  requireStatus(order, "submit_proof");

  // One proof per attempt, and the status machine is what guarantees it:
  // nothing returns to in_progress once proof has been submitted, and the
  // only way back to work is a retry, whose claim opens a fresh attempt.
  const attempt = currentAttempt(order.id);
  if (!attempt) throw new WorkOrderError(409, `Work Order #${order.id} has no open attempt`);

  getDb()
    .prepare("INSERT INTO work_order_proofs (attempt_id, body, submitted_by) VALUES (?, ?, ?)")
    .run(attempt.id, parsed.data.proof.trim(), actor);

  const moved = transition(order, "submit_proof", actor, `attempt ${attempt.attemptNo}`);
  const withProof = currentAttempt(order.id);
  if (!withProof) throw new Error("attempt vanished");
  return { order: moved, attempt: withProof };
}

/**
 * Review is a real step, not a formality skipped because the reviewer and
 * the worker are the same person. Reading your own proof back is where the
 * learning loop gets its material.
 */
export function beginReview(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "begin_review");
  return transition(order, "begin_review", actor);
}

/**
 * The attempt a review lands on. One review per attempt, guaranteed the
 * same way one proof is: completed is terminal, and requesting changes
 * routes back through a retry that opens the next attempt.
 */
function reviewedAttempt(order: WorkOrder): Attempt {
  const attempt = currentAttempt(order.id);
  if (!attempt) throw new WorkOrderError(409, `Work Order #${order.id} has no attempt under review`);
  return attempt;
}

function recordReview(
  attemptId: number,
  decision: "accepted" | "changes_requested" | "failed",
  note: string,
  actor: string
): void {
  getDb()
    .prepare(
      "INSERT INTO work_order_reviews (attempt_id, decision, note, reviewed_by) VALUES (?, ?, ?, ?)"
    )
    .run(attemptId, decision, note.trim(), actor);
}

export interface CompletionOutcome {
  order: WorkOrder;
  attempt: Attempt;
  /** What the completion did, or did not do, to the readiness checklist. */
  readiness: { item: ReadinessItem; recorded: boolean; why: string } | null;
}

/**
 * Complete the order. The proof check is the point of the whole module:
 * there is no path from here to `completed` that does not go through a
 * recorded proof on the attempt being completed.
 */
export function completeOrder(orderId: number, note = "", actor = "operator"): CompletionOutcome {
  const order = orderOr404(orderId);
  requireStatus(order, "complete");
  const attempt = reviewedAttempt(order);
  if (!attempt.proof) {
    throw new WorkOrderError(
      409,
      `Attempt ${attempt.attemptNo} carries no proof. A Work Order completes on what was done, never on the say-so that it was.`
    );
  }

  recordReview(attempt.id, "accepted", note, actor);
  const completed = transition(order, "complete", actor, `attempt ${attempt.attemptNo}`);
  const readiness = earnReadiness(order, attempt, actor);
  const reviewed = currentAttempt(order.id);
  if (!reviewed) throw new Error("attempt vanished");
  return { order: completed, attempt: reviewed, readiness };
}

/**
 * The checklist item this order was standing behind, checked off by the
 * proof that just landed — the "backed by a Work Order" half of readiness.
 * A completion is never blocked by this: the work happened either way, so
 * the outcome is reported rather than thrown.
 */
function earnReadiness(order: WorkOrder, attempt: Attempt, actor: string): CompletionOutcome["readiness"] {
  if (!order.readinessItem || !attempt.proof) return null;
  const instanceId =
    order.instanceId ?? (order.slotId !== null ? (currentInstance(order.slotId)?.id ?? null) : null);
  if (instanceId === null) {
    return {
      item: order.readinessItem,
      recorded: false,
      why: "The slot holds no instance to earn it.",
    };
  }
  try {
    recordReadiness(
      {
        instanceId,
        item: order.readinessItem,
        evidence: `Work Order #${order.id} (${order.title}), attempt ${attempt.attemptNo}: ${attempt.proof.body}`,
      },
      actor
    );
    return {
      item: order.readinessItem,
      recorded: true,
      why: `Evidenced by Work Order #${order.id}.`,
    };
  } catch (err) {
    return {
      item: order.readinessItem,
      recorded: false,
      why: err instanceof Error ? err.message : "The evidence could not be recorded.",
    };
  }
}

export function requestChanges(orderId: number, note: string, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "request_changes");
  if (!note.trim()) {
    throw new WorkOrderError(400, "Requested changes say what needs to be different.");
  }
  const attempt = reviewedAttempt(order);
  recordReview(attempt.id, "changes_requested", note, actor);
  return transition(order, "request_changes", actor, note.trim());
}

/** Back onto the queue. The next claim opens a fresh attempt. */
export function retryOrder(orderId: number, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "retry");
  return transition(order, "retry", actor, "retried after requested changes");
}

export function failOrder(orderId: number, reason: string, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "fail");
  if (!reason.trim()) throw new WorkOrderError(400, "A failed Work Order records why it failed.");
  const attempt = currentAttempt(order.id);
  if (attempt && !attempt.review) recordReview(attempt.id, "failed", reason, actor);
  return transition(order, "fail", actor, reason.trim());
}

export function cancelOrder(orderId: number, reason: string, actor = "operator"): WorkOrder {
  const order = orderOr404(orderId);
  requireStatus(order, "cancel");
  if (!reason.trim()) throw new WorkOrderError(400, "A cancelled Work Order records why.");
  return transition(order, "cancel", actor, reason.trim());
}

// ---------------------------------------------------------------------------
// The card a person actually works from
//
// The guided rail (ticket 27) consumes this. A warm-up card is deliberately
// the smallest thing that can be handed to a person: one instruction and
// one box to put the proof in. Not a checklist, not a plan for the session
// — one thing to do, and somewhere to say you did it.

export interface OrderCard {
  orderId: number;
  kind: OrderKind;
  title: string;
  /** Exactly one instruction. Nothing else on the card asks for work. */
  instruction: string;
  proofField: { label: string; placeholder: string };
  /**
   * The platform's own rule, where one bears on this kind of order. Null on
   * a warm-up card, which carries the instruction and nothing else.
   */
  reminder: string | null;
}

export function orderCard(order: WorkOrder): OrderCard {
  const slot = order.slotId !== null ? getSlotById(order.slotId) : null;
  const instance = order.slotId !== null ? currentInstance(order.slotId) : null;
  const where = instance ? `${instance.handle} on ${slot?.platform ?? "the platform"}` : null;

  const instruction =
    order.kind === "warmup" && where
      ? // One sentence: where, then the single thing to do.
        `On ${where}, ${lowerFirst(order.instruction.trim().replace(/\.$/, ""))}.`
      : order.instruction.trim();

  return {
    orderId: order.id,
    kind: order.kind,
    title: order.title,
    instruction,
    proofField: {
      label: "Proof",
      placeholder: order.proofRequirement,
    },
    reminder:
      order.kind === "post" || order.kind === "comment"
        ? (slot ? policyFor(slot.platform).disclosureRule : null)
        : null,
  };
}

function lowerFirst(text: string): string {
  // Only when the first word is not already a name or a handle, so
  // "@keepanalog" and "TikTok" survive being folded into a sentence.
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

export interface LossOutcome {
  instance: AccountInstance;
  slot: AccountSlot;
  /** The work the loss created, or null when the slot hands out none. */
  replacement: WorkOrder | null;
}

/**
 * Lose an instance and queue the work its loss created, in one act. Keeping
 * the two together is what stops a slot from quietly sitting empty: the
 * replacement is real work someone has to do, so it goes on the queue
 * rather than waiting to be remembered.
 */
export function loseInstanceAndReplace(
  instanceId: number,
  reason: string,
  actor = "operator"
): LossOutcome {
  const { instance, slot } = markInstanceLost(instanceId, reason, actor);
  return { instance, slot, replacement: spawnReplacementOrder(slot.id, reason, actor) };
}

/**
 * A slot whose instance is gone needs a replacement, and the replacement is
 * a person's work like everything else. Spawned already queued: the Operator
 * did not choose to lose the account, and there is nothing to approve.
 */
export function spawnReplacementOrder(
  slotId: number,
  why: string,
  actor = "operator"
): WorkOrder | null {
  const slot = getSlotById(slotId);
  if (!slot) throw new WorkOrderError(404, `No Account Slot #${slotId}`);
  // A paused slot is the kill switch held down and a retired slot is over.
  // Neither hands out work, so neither spawns any.
  if (slot.status === "paused" || slot.status === "retired") return null;
  const draft = createOrder(
    {
      projectId: slot.projectId,
      slotId,
      kind: "replace",
      title: `Replace the ${slot.platform} account in "${slot.label}"`,
      instruction: `Create a replacement ${slot.identitySpec.kind} for "${slot.label}" on ${slot.platform} by hand, matching the slot's identity spec. Reason the last one is gone: ${why}`,
      // No readiness item: the instance that would earn it does not exist
      // until this order is done, and the replacement earns the checklist
      // from nothing once it is in place.
    },
    actor
  );
  const submitted = submitOrder(draft.id, actor);
  return approveOrder(submitted.id, actor);
}

// ---------------------------------------------------------------------------
// The shape every surface sees

export function orderView(order: WorkOrder): Record<string, unknown> {
  const attempts = attemptsFor(order.id);
  return {
    id: order.id,
    projectId: order.projectId,
    slotId: order.slotId,
    instanceId: order.instanceId,
    pieceId: order.pieceId,
    kind: order.kind,
    title: order.title,
    status: order.status,
    card: orderCard(order),
    readinessItem: order.readinessItem,
    readinessLabel: order.readinessItem ? READINESS_LABELS[order.readinessItem] : null,
    // Every try, in order, with what it produced and what review said of
    // it. A rejected attempt stays here; that is the point of it.
    attempts,
    attemptCount: attempts.length,
    cappedAction: order.cappedAction,
    // Visible before anyone tries: why the queue is shut for this order, and
    // when it opens again.
    release: TERMINAL_STATUSES.includes(order.status) ? null : releaseGate(order),
    history: transitionsFor(order.id),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    note: "MarketingOS never performs a platform action. A Work Order is an instruction to a person and a place to record what came back.",
  };
}
