// Distribution deliveries (ticket 22; decisions:
// .scratch/marketing-os/issues/12-define-account-operations-workflow.md and
// the export bundle of ticket 11).
//
// Exported work reaches an account by hand. Nothing here posts anything;
// what it does is make the handoff verifiable at both ends.
//
// A Content Release is the immutable binding between a piece and the export
// bundle that left the building. Its digest is taken over the bundle's own
// manifest, so a release names not "the export" but exactly the bytes that
// were approved. Re-releasing the same bytes returns the release that
// already exists.
//
// A Delivery Target pairs one release with one Account Instance: an
// idempotency key, a position in the queue, a schedule window, and a state
// path from queued through released_to_operator, posting, proof_submitted,
// to verified_posted, with failure and retry.
//
// Three things this module refuses:
//
//   A second target for an idempotency key. A retried request returns the
//   delivery that already exists; it never becomes a second post.
//
//   Releasing work with the disclosure checklist unfinished. The platform's
//   own disclosure rules are acknowledged by a person first, every one of
//   them, or nothing is handed out.
//
//   verified_posted without the permalink. "It went up" is not a fact until
//   someone can open it.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  currentInstance,
  getInstanceById,
  getSlotById,
  type AccountInstance,
  type AccountSlot,
} from "./accounts";
import { audit } from "./audit";
import { getDb } from "./db";
import { getPieceById, type PieceRecord } from "./pieces";
import { policyFor } from "./platform-policy";
import {
  approveOrder,
  createOrder,
  currentAttempt,
  getOrderById,
  submitOrder,
  type WorkOrder,
} from "./work-orders";

export const DELIVERY_STATUSES = [
  "queued",
  "released_to_operator",
  "posting",
  "proof_submitted",
  "verified_posted",
  "failed",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Once the work is with a person, we can ask it to stop. We cannot stop it. */
export const RELEASED_STATUSES: readonly DeliveryStatus[] = [
  "released_to_operator",
  "posting",
  "proof_submitted",
];

export interface ContentRelease {
  id: number;
  projectId: number;
  pieceId: number;
  exportId: number;
  /** Over the bundle manifest, so the release names exact bytes. */
  digest: string;
  bundlePath: string;
  manifest: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export interface DeliveryTarget {
  id: number;
  releaseId: number;
  instanceId: number;
  slotId: number;
  idempotencyKey: string;
  queuePosition: number;
  window: { start: string; end: string };
  status: DeliveryStatus;
  cancellationRequested: boolean;
  cancellationNote: string | null;
  workOrderId: number | null;
  permalink: string | null;
  failureReason: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DisclosureItem {
  rule: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export class DeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

interface ReleaseRow {
  id: number;
  project_id: number;
  piece_id: number;
  export_id: number;
  digest: string;
  bundle_path: string;
  manifest: string;
  created_by: string;
  created_at: string;
}

function rowToRelease(row: ReleaseRow): ContentRelease {
  return {
    id: row.id,
    projectId: row.project_id,
    pieceId: row.piece_id,
    exportId: row.export_id,
    digest: row.digest,
    bundlePath: row.bundle_path,
    manifest: JSON.parse(row.manifest) as Record<string, unknown>,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface TargetRow {
  id: number;
  release_id: number;
  instance_id: number;
  slot_id: number;
  idempotency_key: string;
  queue_position: number;
  window_start: string;
  window_end: string;
  status: DeliveryStatus;
  cancellation_requested: number;
  cancellation_note: string | null;
  work_order_id: number | null;
  permalink: string | null;
  failure_reason: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

function rowToTarget(row: TargetRow): DeliveryTarget {
  return {
    id: row.id,
    releaseId: row.release_id,
    instanceId: row.instance_id,
    slotId: row.slot_id,
    idempotencyKey: row.idempotency_key,
    queuePosition: row.queue_position,
    window: { start: row.window_start, end: row.window_end },
    status: row.status,
    cancellationRequested: row.cancellation_requested === 1,
    cancellationNote: row.cancellation_note,
    workOrderId: row.work_order_id,
    permalink: row.permalink,
    failureReason: row.failure_reason,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reading

export function getReleaseById(id: number): ContentRelease | null {
  const row = getDb().prepare("SELECT * FROM content_releases WHERE id = ?").get(id) as
    | ReleaseRow
    | undefined;
  return row ? rowToRelease(row) : null;
}

export function listReleases(projectId?: number): ContentRelease[] {
  const db = getDb();
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT * FROM content_releases ORDER BY id DESC").all()
      : db.prepare("SELECT * FROM content_releases WHERE project_id = ? ORDER BY id DESC").all(projectId)
  ) as ReleaseRow[];
  return rows.map(rowToRelease);
}

export function getTargetById(id: number): DeliveryTarget | null {
  const row = getDb().prepare("SELECT * FROM delivery_targets WHERE id = ?").get(id) as
    | TargetRow
    | undefined;
  return row ? rowToTarget(row) : null;
}

export function targetByKey(key: string): DeliveryTarget | null {
  const row = getDb().prepare("SELECT * FROM delivery_targets WHERE idempotency_key = ?").get(key) as
    | TargetRow
    | undefined;
  return row ? rowToTarget(row) : null;
}

/** The queue for one slot, in the order the Operator works it. */
export function listTargets(filter: { releaseId?: number; slotId?: number } = {}): DeliveryTarget[] {
  const where: string[] = [];
  const args: number[] = [];
  if (filter.releaseId !== undefined) {
    where.push("release_id = ?");
    args.push(filter.releaseId);
  }
  if (filter.slotId !== undefined) {
    where.push("slot_id = ?");
    args.push(filter.slotId);
  }
  const sql = `SELECT * FROM delivery_targets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY queue_position ASC, id ASC`;
  return (getDb().prepare(sql).all(...args) as TargetRow[]).map(rowToTarget);
}

/**
 * The checklist: every disclosure rule the platform imposes on this slot,
 * and who acknowledged it. The rules come from the slot and from the
 * platform policy together, because a slot may add its own and may never
 * drop the platform's.
 */
export function disclosureChecklist(target: DeliveryTarget): DisclosureItem[] {
  const slot = getSlotById(target.slotId);
  const rules = requiredDisclosures(slot);
  const acknowledged = new Map(
    (
      getDb()
        .prepare("SELECT rule, acknowledged_by, acknowledged_at FROM delivery_disclosures WHERE target_id = ?")
        .all(target.id) as { rule: string; acknowledged_by: string; acknowledged_at: string }[]
    ).map((row) => [row.rule, row])
  );
  return rules.map((rule) => {
    const row = acknowledged.get(rule);
    return {
      rule,
      acknowledgedBy: row?.acknowledged_by ?? null,
      acknowledgedAt: row?.acknowledged_at ?? null,
    };
  });
}

function requiredDisclosures(slot: AccountSlot | null): string[] {
  if (!slot) return [];
  const platformRule = policyFor(slot.platform).disclosureRule;
  // The platform's rule is never optional, so it is in the list whether or
  // not the slot happened to copy it in.
  return [...new Set([platformRule, ...slot.disclosureRules])];
}

export function outstandingDisclosures(target: DeliveryTarget): string[] {
  return disclosureChecklist(target)
    .filter((item) => item.acknowledgedBy === null)
    .map((item) => item.rule);
}

// ---------------------------------------------------------------------------
// Content Releases

interface ExportRow {
  id: number;
  piece_id: number;
  doc_version: number;
  kit_version: number | null;
  bundle_path: string;
  manifest: string;
}

/**
 * Bind a release to the piece's most recent export bundle. The digest is
 * over the manifest, which already carries the source hash of every
 * rendered slide — so two releases of the same bytes have the same digest,
 * and a release of different bytes cannot pretend to be this one.
 *
 * A piece must have reached the far end of its own lifecycle first: only
 * work that was approved and exported has bytes to release at all.
 */
export function releasePiece(pieceId: number, actor = "operator"): ContentRelease {
  const piece = getPieceById(pieceId);
  if (!piece) throw new DeliveryError(404, `No piece #${pieceId}`);
  if (piece.status !== "exported" && piece.status !== "measured") {
    throw new DeliveryError(
      409,
      `"${piece.title}" is ${piece.status}. A Content Release binds to an export bundle, so the piece is approved and exported first.`
    );
  }

  const row = getDb()
    .prepare("SELECT * FROM piece_exports WHERE piece_id = ? ORDER BY id DESC LIMIT 1")
    .get(pieceId) as ExportRow | undefined;
  if (!row) {
    throw new DeliveryError(409, `"${piece.title}" has no export bundle to release.`);
  }

  const digest = createHash("sha256").update(row.manifest).digest("hex");
  const existing = getDb()
    .prepare("SELECT * FROM content_releases WHERE digest = ?")
    .get(digest) as ReleaseRow | undefined;
  // The same bytes are the same release. Minting a second one would give
  // two names to one artifact, and deliveries would stop being countable.
  if (existing) return rowToRelease(existing);

  const info = getDb()
    .prepare(
      `INSERT INTO content_releases
        (project_id, piece_id, export_id, digest, bundle_path, manifest, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(piece.projectId, piece.id, row.id, digest, row.bundle_path, row.manifest, actor);

  const release = getReleaseById(Number(info.lastInsertRowid));
  if (!release) throw new Error("content release did not persist");
  audit(actor, "releases.created", {
    releaseId: release.id,
    pieceId: piece.id,
    exportId: row.id,
    digest,
  });
  return release;
}

/**
 * Whether the bundle a release names still hashes to the release's digest.
 * A release is immutable by construction; this is how a surface can say so
 * out loud rather than asking to be believed.
 */
export function releaseIsIntact(release: ContentRelease): boolean {
  const row = getDb()
    .prepare("SELECT manifest FROM piece_exports WHERE id = ?")
    .get(release.exportId) as { manifest: string } | undefined;
  if (!row) return false;
  return createHash("sha256").update(row.manifest).digest("hex") === release.digest;
}

// ---------------------------------------------------------------------------
// Delivery Targets

export const createTargetSchema = z.object({
  releaseId: z.number().int(),
  slotId: z.number().int(),
  /**
   * The caller's own key for this delivery. Two requests carrying the same
   * key are the same delivery, however many times they arrive.
   */
  idempotencyKey: z.string().min(8).max(120),
  queuePosition: z.number().int().min(0).max(10000).optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
});

export interface TargetOutcome {
  target: DeliveryTarget;
  /** False when the key had already created this delivery. */
  created: boolean;
}

/**
 * Pair a release with the account currently filling a slot. Idempotent by
 * the caller's key: the second call with a key returns the first call's
 * delivery, and the unique index is the floor under that promise.
 */
export function createTarget(input: unknown, actor = "operator"): TargetOutcome {
  const parsed = createTargetSchema.safeParse(input);
  if (!parsed.success) {
    throw new DeliveryError(
      400,
      "A Delivery Target names the release, the slot, and an idempotency key.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const spec = parsed.data;

  const existing = targetByKey(spec.idempotencyKey);
  if (existing) return { target: existing, created: false };

  const release = getReleaseById(spec.releaseId);
  if (!release) throw new DeliveryError(404, `No Content Release #${spec.releaseId}`);
  const slot = getSlotById(spec.slotId);
  if (!slot) throw new DeliveryError(404, `No Account Slot #${spec.slotId}`);
  if (slot.projectId !== release.projectId) {
    throw new DeliveryError(
      409,
      `"${slot.label}" belongs to another Connected Project than this release.`
    );
  }
  const instance = currentInstance(slot.id);
  if (!instance) {
    throw new DeliveryError(
      409,
      `"${slot.label}" holds no account to deliver to. Fill the slot first.`
    );
  }

  const window = spec.window ?? slot.allowedWindows[0] ?? { start: "09:00", end: "12:00" };
  const position = spec.queuePosition ?? nextQueuePosition(slot.id);

  let info;
  try {
    info = getDb()
      .prepare(
        `INSERT INTO delivery_targets
          (release_id, instance_id, slot_id, idempotency_key, queue_position, window_start, window_end)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(release.id, instance.id, slot.id, spec.idempotencyKey, position, window.start, window.end);
  } catch (err) {
    // Two callers raced on one key. The unique index decided; whoever lost
    // gets the delivery that exists, which is what they asked for anyway.
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      const raced = targetByKey(spec.idempotencyKey);
      if (raced) return { target: raced, created: false };
    }
    throw err;
  }

  const target = getTargetById(Number(info.lastInsertRowid));
  if (!target) throw new Error("delivery target did not persist");
  audit(actor, "deliveries.created", {
    targetId: target.id,
    releaseId: release.id,
    slotId: slot.id,
    instanceId: instance.id,
    idempotencyKey: spec.idempotencyKey,
  });
  return { target, created: true };
}

function nextQueuePosition(slotId: number): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(queue_position), -1) AS top FROM delivery_targets WHERE slot_id = ?")
    .get(slotId) as { top: number };
  return row.top + 1;
}

function setTarget(
  targetId: number,
  columns: Record<string, string | number | null>,
  actor: string,
  action: string
): DeliveryTarget {
  const keys = Object.keys(columns);
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  getDb()
    .prepare(
      `UPDATE delivery_targets SET ${assignments}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    )
    .run(...keys.map((key) => columns[key]), targetId);
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  audit(actor, action, { targetId, status: target.status });
  return target;
}

export function acknowledgeDisclosure(
  targetId: number,
  rule: string,
  actor = "operator"
): DisclosureItem[] {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  const required = disclosureChecklist(target).map((item) => item.rule);
  if (!required.includes(rule)) {
    throw new DeliveryError(
      400,
      "That is not one of this delivery's disclosure rules.",
      required
    );
  }
  try {
    getDb()
      .prepare("INSERT INTO delivery_disclosures (target_id, rule, acknowledged_by) VALUES (?, ?, ?)")
      .run(targetId, rule, actor);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      throw new DeliveryError(409, "That rule is already acknowledged for this delivery.");
    }
    throw err;
  }
  audit(actor, "deliveries.disclosure_acknowledged", { targetId, rule });
  return disclosureChecklist(target);
}

// ---------------------------------------------------------------------------
// The state path
//
// queued -> released_to_operator -> posting -> proof_submitted ->
// verified_posted, with failed as an exit that retry reopens.

export interface ReleaseToOperatorOutcome {
  target: DeliveryTarget;
  order: WorkOrder;
}

/**
 * Hand the delivery to a person, as a post Work Order carrying the bundle
 * and the disclosure checklist. Two things are checked first and neither
 * merely warns: the release still hashes to the bytes it bound to, and
 * every disclosure rule is acknowledged.
 */
export function releaseToOperator(
  targetId: number,
  actor = "operator"
): ReleaseToOperatorOutcome {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (target.status !== "queued" && target.status !== "failed") {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} is ${target.status}. Only a queued or failed delivery is released to the Operator.`
    );
  }
  if (target.cancellationRequested) {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} has a cancellation request outstanding. Settle that before releasing it.`
    );
  }

  const release = getReleaseById(target.releaseId);
  if (!release) throw new DeliveryError(404, `No Content Release #${target.releaseId}`);
  if (!releaseIsIntact(release)) {
    throw new DeliveryError(
      409,
      `Content Release #${release.id} no longer matches the bundle it bound to. Nothing is handed out against bytes that moved.`
    );
  }

  const outstanding = outstandingDisclosures(target);
  if (outstanding.length > 0) {
    throw new DeliveryError(
      409,
      `${outstanding.length} disclosure rule(s) are unacknowledged. The checklist is completed before the work is handed out, not after.`,
      outstanding
    );
  }

  const instance = getInstanceById(target.instanceId);
  const order = postOrderFor(target, release, instance, actor);
  const moved = setTarget(
    target.id,
    {
      status: "released_to_operator",
      work_order_id: order.id,
      attempt_count: target.attemptCount + 1,
      failure_reason: null,
    },
    actor,
    "deliveries.released_to_operator"
  );
  return { target: moved, order };
}

function postOrderFor(
  target: DeliveryTarget,
  release: ContentRelease,
  instance: AccountInstance | null,
  actor: string
): WorkOrder {
  const piece = getPieceById(release.pieceId);
  const checklist = disclosureChecklist(target)
    .map((item, index) => `${index + 1}. ${item.rule}`)
    .join("\n");
  const draft = createOrder(
    {
      projectId: release.projectId,
      slotId: target.slotId,
      instanceId: target.instanceId,
      pieceId: release.pieceId,
      kind: "post",
      title: `Publish "${piece?.title ?? `piece #${release.pieceId}`}"${instance ? ` as ${instance.handle}` : ""}`,
      instruction:
        `Publish the bundle at ${release.bundlePath} (Content Release #${release.id}, digest ${release.digest.slice(0, 12)}…) ` +
        `between ${target.window.start} and ${target.window.end}. ` +
        `Disclosures already acknowledged for this delivery, which the post must satisfy:\n${checklist}`,
      proofRequirement:
        "The permalink of the published post. Nothing verifies without a link someone can open.",
      cappedAction: "post",
    },
    actor
  );
  submitOrder(draft.id, actor);
  return approveOrder(draft.id, actor);
}

/** The Operator has started publishing. */
export function markPosting(targetId: number, actor = "operator"): DeliveryTarget {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (target.status !== "released_to_operator") {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} is ${target.status}. Posting starts from released_to_operator.`
    );
  }
  return setTarget(targetId, { status: "posting" }, actor, "deliveries.posting");
}

const PERMALINK = /^https:\/\/[^\s]+$/;

/**
 * The proof, which for a delivery is the destination permalink. The
 * delivery's own Work Order holds the same proof on its attempt; this is
 * the copy that makes the delivery itself checkable without walking to the
 * order first.
 */
export function submitDeliveryProof(
  targetId: number,
  permalink: string,
  actor = "operator"
): DeliveryTarget {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (target.status !== "posting" && target.status !== "released_to_operator") {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} is ${target.status}. Proof arrives while the delivery is with the Operator.`
    );
  }
  const link = permalink.trim();
  if (!PERMALINK.test(link)) {
    throw new DeliveryError(
      400,
      "A delivery's proof is the destination permalink: an https link to the published post."
    );
  }
  return setTarget(
    targetId,
    { status: "proof_submitted", permalink: link },
    actor,
    "deliveries.proof_submitted"
  );
}

/**
 * The last step, and the one this module exists for: a delivery is verified
 * only against a permalink, and only when the Work Order that carried it
 * holds the same link in its own proof. Two records that agree, or nothing.
 */
export function verifyPosted(targetId: number, actor = "operator"): DeliveryTarget {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (target.status !== "proof_submitted") {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} is ${target.status}. Verification happens on submitted proof.`
    );
  }
  if (!target.permalink || !PERMALINK.test(target.permalink)) {
    throw new DeliveryError(
      409,
      "A delivery is verified against the destination permalink. There is none on this delivery."
    );
  }
  if (target.workOrderId !== null) {
    const attempt = currentAttempt(target.workOrderId);
    if (!attempt?.proof) {
      throw new DeliveryError(
        409,
        `Work Order #${target.workOrderId} carries no proof yet, so there is nothing to verify the delivery against.`
      );
    }
    if (!attempt.proof.body.includes(target.permalink)) {
      throw new DeliveryError(
        409,
        `Work Order #${target.workOrderId} records a different destination than this delivery. Verification needs the two to agree.`,
        [`Delivery: ${target.permalink}`, `Work Order: ${attempt.proof.body}`]
      );
    }
  }
  return setTarget(targetId, { status: "verified_posted" }, actor, "deliveries.verified_posted");
}

export function failDelivery(targetId: number, reason: string, actor = "operator"): DeliveryTarget {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (target.status === "verified_posted" || target.status === "cancelled") {
    throw new DeliveryError(409, `Delivery #${targetId} is ${target.status} and is over.`);
  }
  if (!reason.trim()) throw new DeliveryError(400, "A failed delivery records why it failed.");
  return setTarget(
    targetId,
    { status: "failed", failure_reason: reason.trim() },
    actor,
    "deliveries.failed"
  );
}

// ---------------------------------------------------------------------------
// Cancellation
//
// Before the work is released, cancelling is a decision. After it, someone
// may already be halfway through publishing, so it is a request — and the
// system says which of the two it is rather than pretending both are the
// same act.

export interface CancellationOutcome {
  target: DeliveryTarget;
  /** True when the delivery stopped; false when we could only ask. */
  cancelled: boolean;
  message: string;
}

export function cancelDelivery(
  targetId: number,
  reason: string,
  actor = "operator"
): CancellationOutcome {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (!reason.trim()) throw new DeliveryError(400, "A cancellation records why.");
  if (target.status === "cancelled") {
    throw new DeliveryError(409, `Delivery #${targetId} is already cancelled.`);
  }
  if (target.status === "verified_posted") {
    throw new DeliveryError(
      409,
      `Delivery #${targetId} is posted. What is published cannot be un-published from here.`
    );
  }

  if (RELEASED_STATUSES.includes(target.status)) {
    const asked = setTarget(
      targetId,
      { cancellation_requested: 1, cancellation_note: reason.trim() },
      actor,
      "deliveries.cancellation_requested"
    );
    return {
      target: asked,
      cancelled: false,
      message: `Delivery #${targetId} is already with the Operator, so this is a request rather than a stop. It holds until the request is acknowledged.`,
    };
  }

  return {
    target: setTarget(
      targetId,
      { status: "cancelled", cancellation_note: reason.trim() },
      actor,
      "deliveries.cancelled"
    ),
    cancelled: true,
    message: `Delivery #${targetId} is cancelled.`,
  };
}

/** The person holding the work has seen the request and stopped. */
export function acknowledgeCancellation(targetId: number, actor = "operator"): DeliveryTarget {
  const target = getTargetById(targetId);
  if (!target) throw new DeliveryError(404, `No Delivery Target #${targetId}`);
  if (!target.cancellationRequested) {
    throw new DeliveryError(409, `Delivery #${targetId} has no cancellation request outstanding.`);
  }
  if (target.status === "cancelled") {
    throw new DeliveryError(409, `Delivery #${targetId} is already cancelled.`);
  }
  return setTarget(targetId, { status: "cancelled" }, actor, "deliveries.cancelled");
}

// ---------------------------------------------------------------------------
// The shape every surface sees

export function releaseView(release: ContentRelease): Record<string, unknown> {
  return {
    id: release.id,
    projectId: release.projectId,
    pieceId: release.pieceId,
    exportId: release.exportId,
    digest: release.digest,
    bundlePath: release.bundlePath,
    manifest: release.manifest,
    // Said rather than assumed: the bundle still hashes to what was bound.
    intact: releaseIsIntact(release),
    createdBy: release.createdBy,
    createdAt: release.createdAt,
    note: "A Content Release binds immutably to one export bundle. Its digest is over the bundle manifest, so it names exact bytes rather than the idea of an export.",
  };
}

export function targetView(target: DeliveryTarget): Record<string, unknown> {
  const checklist = disclosureChecklist(target);
  const outstanding = checklist.filter((item) => item.acknowledgedBy === null);
  const order = target.workOrderId !== null ? getOrderById(target.workOrderId) : null;
  return {
    id: target.id,
    releaseId: target.releaseId,
    slotId: target.slotId,
    instanceId: target.instanceId,
    idempotencyKey: target.idempotencyKey,
    queuePosition: target.queuePosition,
    window: target.window,
    status: target.status,
    disclosures: checklist,
    outstandingDisclosures: outstanding.map((item) => item.rule),
    workOrderId: target.workOrderId,
    workOrderStatus: order?.status ?? null,
    permalink: target.permalink,
    failureReason: target.failureReason,
    attemptCount: target.attemptCount,
    cancellationRequested: target.cancellationRequested,
    cancellationNote: target.cancellationNote,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    note: "MarketingOS posts nothing. A delivery is the record of a person publishing one release as one account, and it is verified against the permalink they came back with.",
  };
}
