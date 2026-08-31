// Two-phase project writes, phase one (ticket 17; reference behavior: the
// `project.prepare_change` and `marketingos.get_approval` cases of
// GatewaySim in ai-host-onboarding.html, and walkthroughs 4 and 5).
//
// Nothing reaches a Connected Project without a person seeing exactly what
// would change. `prepare_change` validates a Project Change Set against the
// pinned Project Snapshot and writes nothing canonical: it returns the
// digest, the exact diff, the validations it ran, and any warnings. The
// Operator approves or rejects that digest in the dashboard. The host polls
// `get_approval(digest)` and is told the status and the one next call.
//
// No grant token ever transits the host. The approval is a row here, keyed
// by digest, and the host never holds anything it could replay elsewhere.
//
// Phase two (ticket 18) is `apply_change(digest)`: it walks the refusal
// matrix, consumes the approval, applies the change atomically at the
// project, and returns a Write Receipt. An approval is single-use at the
// storage level — a trigger forbids a consumed one from ever changing
// again, and one receipt per digest is a uniqueness constraint — so
// "exactly once" does not depend on this file being careful.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  fetchJson,
  noProjectSelected,
  pinnedDetail,
  sessionContext,
  staleSnapshotRefusal,
  SNAPSHOT_RESOURCES,
  type GatewayResult,
  type SnapshotResource,
} from "./gateway";
import { projectServiceToken } from "./projects";

/** The operations a Project Change Set may be built from. */
export const CHANGE_OPERATIONS = ["set_field", "add_claim", "revise_claim"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

const changeOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_field"),
    resource: z.string(),
    path: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("add_claim"), text: z.string().min(1), evidence: z.string().min(1) }),
  z.object({
    op: z.literal("revise_claim"),
    id: z.string().min(1),
    text: z.string().min(1),
    evidence: z.string().min(1),
  }),
]);

export type ChangeOp = z.infer<typeof changeOpSchema>;

export const changeSetSchema = z.object({
  summary: z.string().min(1).max(200),
  operations: z.array(changeOpSchema).min(1).max(50),
});

export type ChangeSet = z.infer<typeof changeSetSchema>;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used";

export interface DiffEntry {
  resource: string;
  path: string;
  before: unknown;
  after: unknown;
}

export interface PreparedChangeSet {
  digest: string;
  projectId: number;
  snapshotId: string;
  cursor: number;
  summary: string;
  changeSet: ChangeSet;
  diff: DiffEntry[];
  validations: string[];
  warnings: string[];
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface ChangeRow {
  digest: string;
  project_id: number;
  snapshot_id: string;
  cursor: number;
  summary: string;
  change_set: string;
  diff: string;
  validations: string;
  warnings: string;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function rowToPrepared(row: ChangeRow): PreparedChangeSet {
  return {
    digest: row.digest,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    cursor: row.cursor,
    summary: row.summary,
    changeSet: JSON.parse(row.change_set) as ChangeSet,
    diff: JSON.parse(row.diff) as DiffEntry[],
    validations: JSON.parse(row.validations) as string[],
    warnings: JSON.parse(row.warnings) as string[],
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function getPreparedChangeSet(digest: string): PreparedChangeSet | null {
  const row = getDb().prepare("SELECT * FROM project_changes WHERE digest = ?").get(digest) as
    | ChangeRow
    | undefined;
  return row ? rowToPrepared(row) : null;
}

export function listPreparedChangeSets(status?: ApprovalStatus): PreparedChangeSet[] {
  const db = getDb();
  const rows = (
    status
      ? db
          .prepare("SELECT * FROM project_changes WHERE status = ? ORDER BY created_at DESC")
          .all(status)
      : db.prepare("SELECT * FROM project_changes ORDER BY created_at DESC").all()
  ) as ChangeRow[];
  return rows.map(rowToPrepared);
}

// ---------------------------------------------------------------------------
// The digest

/**
 * A digest names one change against one snapshot of one project, and
 * nothing else. It is derived, not random, so preparing the same change
 * twice against the same snapshot addresses the same approval rather than
 * quietly creating a second one — and so a digest can never be made to
 * stand for a change the Operator did not see.
 */
export function changeDigest(projectId: number, snapshotId: string, changeSet: ChangeSet): string {
  const canonical = JSON.stringify({
    projectId,
    snapshotId,
    summary: changeSet.summary,
    operations: changeSet.operations,
  });
  return `chg-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Validation and the diff

export interface WritePolicy {
  operations: string[];
  editableTargets: string[];
  protectedResources: string[];
}

const DEFAULT_POLICY: WritePolicy = {
  operations: [],
  editableTargets: [],
  protectedResources: ["*"],
};

/**
 * The Connected Project decides what may be written. A project that says
 * nothing has said no: the default refuses everything, so a project domain
 * cannot become writable by omission.
 *
 * An outage is not a policy. A project that cannot be reached throws, so
 * the caller reports temporarily_unavailable rather than telling the
 * Operator to widen a write policy it never managed to read.
 *
 * The MVP reads three fields. A write policy also declares accepted
 * formats, size limits, project-supplied validators, and approval classes
 * (ticket 08); running those is deferred, and no change here pretends to
 * have run them.
 */
export async function readWritePolicy(projectId: number, baseUrl: string): Promise<WritePolicy> {
  const token = await projectServiceToken(projectId, "ai-host");
  const res = await fetchJson(`${baseUrl}/resources/write-policy`, token);
  // 404 is an answer: this project domain exposes no write policy, which
  // is a refusal, not a failure.
  if (res.status === 404) return DEFAULT_POLICY;
  if (res.status !== 200) {
    throw new Error(`the project domain answered status ${res.status} for write-policy`);
  }
  const data = ((res.body ?? {}) as { data?: Partial<WritePolicy> }).data ?? {};
  return {
    operations: Array.isArray(data.operations) ? data.operations : [],
    editableTargets: Array.isArray(data.editableTargets) ? data.editableTargets : [],
    protectedResources: Array.isArray(data.protectedResources) ? data.protectedResources : ["*"],
  };
}

function isProtected(policy: WritePolicy, resource: string): boolean {
  return policy.protectedResources.some((p) => p === "*" || p === resource);
}

/** Which snapshot resource an operation writes to. */
export function targetResource(op: ChangeOp): string {
  return op.op === "set_field" ? op.resource : "claims";
}

function targetPath(op: ChangeOp): string {
  switch (op.op) {
    case "set_field":
      return op.path;
    case "add_claim":
      return "claims[]";
    case "revise_claim":
      return `claims[${op.id}]`;
  }
}

function valueAt(data: unknown, path: string): unknown {
  let cursor: unknown = data;
  for (const key of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function proposedValue(op: ChangeOp): unknown {
  switch (op.op) {
    case "set_field":
      return op.value;
    case "add_claim":
      return { text: op.text, evidence: op.evidence };
    case "revise_claim":
      return { id: op.id, text: op.text, evidence: op.evidence };
  }
}

export interface ValidationOutcome {
  validations: string[];
  warnings: string[];
  problems: { code: string; message: string; next: string }[];
  diff: DiffEntry[];
}

/**
 * Validate a change set against the pinned snapshot and the project's write
 * policy, and compute the exact diff. Reads only: this is the whole point
 * of phase one, so nothing here touches canonical project state.
 */
export function validateChangeSet(
  changeSet: ChangeSet,
  policy: WritePolicy,
  snapshotResources: Partial<Record<SnapshotResource, { state: "ok" | "empty"; data: unknown }>>
): ValidationOutcome {
  const validations: string[] = [];
  const warnings: string[] = [];
  const problems: ValidationOutcome["problems"] = [];
  const diff: DiffEntry[] = [];

  validations.push(`${changeSet.operations.length} operation(s) parsed against the change schema`);

  for (const [index, op] of changeSet.operations.entries()) {
    const resource = targetResource(op);
    const path = targetPath(op);
    const where = `operation ${index} (${op.op} on ${resource})`;

    if (!policy.operations.includes(op.op)) {
      problems.push({
        code: "unsupported_capability",
        message: `${where} is not an operation this Connected Project accepts.`,
        next: `Read project.get_resource('write-policy') for what this project permits: ${
          policy.operations.join(", ") || "no write operations at all"
        }.`,
      });
      continue;
    }
    if (isProtected(policy, resource)) {
      problems.push({
        code: "protected_target",
        message: `${where} targets '${resource}', which this Connected Project protects.`,
        next: "Choose an editable target, or ask the Operator to widen the project's write policy.",
      });
      continue;
    }
    if (!policy.editableTargets.includes(resource)) {
      problems.push({
        code: "protected_target",
        message: `${where} targets '${resource}', which is not among this project's editable targets.`,
        next: `Editable targets: ${policy.editableTargets.join(", ") || "none"}.`,
      });
      continue;
    }

    const captured = (SNAPSHOT_RESOURCES as readonly string[]).includes(resource)
      ? snapshotResources[resource as SnapshotResource]
      : undefined;
    if (!captured) {
      // The change can still be prepared: the project, not the snapshot, is
      // the authority on what exists. But the Operator should know the diff
      // is being shown against nothing.
      warnings.push(
        `${where} targets '${resource}', which this session's snapshot did not capture; the before-value is unknown.`
      );
    }

    const before = captured ? valueAt(captured.data, path) : undefined;
    const after = proposedValue(op);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      warnings.push(`${where} would not change anything; the value is already what it proposes.`);
    }
    diff.push({ resource, path, before, after });
    validations.push(`${where} is permitted by the write policy`);
  }

  return { validations, warnings, problems, diff };
}

/** The diff as the dashboard renders it, one line per changed path. */
export function renderDiff(diff: DiffEntry[]): string {
  return diff
    .flatMap((entry) => [
      `--- ${entry.resource}.${entry.path}`,
      `- ${JSON.stringify(entry.before) ?? "undefined"}`,
      `+ ${JSON.stringify(entry.after) ?? "undefined"}`,
    ])
    .join("\n");
}

// ---------------------------------------------------------------------------
// Host surface

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function preparedPayload(prepared: PreparedChangeSet): Record<string, unknown> {
  return {
    digest: prepared.digest,
    summary: prepared.summary,
    snapshot: prepared.snapshotId,
    diff: prepared.diff,
    diffText: renderDiff(prepared.diff),
    validations: prepared.validations,
    warnings: prepared.warnings,
    status: prepared.status,
    createdAt: prepared.createdAt,
  };
}

export async function prepareChange(sessionKey: string, input: unknown): Promise<GatewayResult> {
  const pinned = pinnedDetail(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = changeSetSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return errResult(
      "invalid_schema",
      `The Project Change Set does not match the schema: ${detail}`,
      `A change set is a summary plus 1-50 operations of ${CHANGE_OPERATIONS.join(", ")}.`
    );
  }
  const changeSet = parsed.data;

  // A change computed against a snapshot the world has moved past describes
  // a project that no longer exists. Refuse before validating anything.
  const stale = await staleSnapshotRefusal(
    sessionKey,
    [...new Set(changeSet.operations.map(targetResource))],
    "project.prepare_change",
    "Call project.get_snapshot, recompute the change, then prepare again."
  );
  if (stale) return stale;

  let policy: WritePolicy;
  try {
    policy = await readWritePolicy(pinned.projectId, pinned.baseUrl);
  } catch (err) {
    return errResult(
      "temporarily_unavailable",
      `The Connected Project's write policy could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "Retry project.prepare_change, or ask the Operator to check the Connected Project."
    );
  }

  const outcome = validateChangeSet(changeSet, policy, pinned.resources);
  if (outcome.problems.length > 0) {
    const [first] = outcome.problems;
    return {
      ok: false,
      response: {
        error: first.code,
        message: `The change was not prepared: ${outcome.problems
          .map((p) => p.message)
          .join(" ")}`,
        next: first.next,
        validations: outcome.validations,
        problems: outcome.problems,
      },
    };
  }

  const digest = changeDigest(pinned.projectId, pinned.snapshotId, changeSet);
  const existing = getPreparedChangeSet(digest);
  if (existing) {
    // A digest is derived, so the same change against the same snapshot
    // lands here. Belt and braces on the derivation: a digest is never
    // allowed to address another project's change.
    if (existing.projectId !== pinned.projectId) {
      return errResult(
        "approval_mismatch",
        `Digest ${digest} already names a change to a different Connected Project.`,
        "Prepare this change with a distinct summary."
      );
    }
    if (existing.status === "pending") {
      // It addresses the approval already waiting rather than making a
      // second one the Operator would have to review twice.
      return {
        ok: true,
        response: {
          context: sessionContext(sessionKey),
          prepared: preparedPayload(existing),
          approval: "required",
          next: nextForStatus(existing),
        },
      };
    }
    // Already decided. Re-preparing it is not a preparation: the Operator
    // said something about this exact change, and saying it again would
    // not change their answer.
    return {
      ok: false,
      response: {
        error: "approval_mismatch",
        message: `This exact change was already ${existing.status} as digest ${digest}.`,
        next: nextForStatus(existing),
        prepared: preparedPayload(existing),
      },
    };
  }

  getDb()
    .prepare(
      `INSERT INTO project_changes
        (digest, project_id, snapshot_id, cursor, summary, change_set, diff, validations, warnings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      digest,
      pinned.projectId,
      pinned.snapshotId,
      pinned.cursor,
      changeSet.summary,
      JSON.stringify(changeSet),
      JSON.stringify(outcome.diff),
      JSON.stringify(outcome.validations),
      JSON.stringify(outcome.warnings)
    );

  const prepared = getPreparedChangeSet(digest);
  if (!prepared) throw new Error("prepared change did not persist");

  audit("ai-host", "changes.prepared", {
    digest,
    projectId: pinned.projectId,
    snapshot: pinned.snapshotId,
    operations: changeSet.operations.length,
    warnings: outcome.warnings.length,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      prepared: preparedPayload(prepared),
      approval: "required",
      next: `The Operator must approve digest ${digest} in the MarketingOS dashboard. Poll marketingos.get_approval — no grant token will be given to you.`,
    },
  };
}

function nextForStatus(prepared: PreparedChangeSet): string {
  switch (prepared.status) {
    case "approved":
      return `project.apply_change({"digest":"${prepared.digest}"}) — exactly once.`;
    case "pending":
      return "Wait for the Operator; poll again.";
    case "used":
      return "This approval was consumed; prepare a new change.";
    case "rejected":
      return "Rejected; revise and prepare a new change.";
  }
}

/**
 * The host asks what the Operator decided. It gets a status and a next
 * call — never a token, never anything it could present anywhere else as
 * proof of approval.
 */
export function getApproval(sessionKey: string, input: unknown): GatewayResult {
  const pinned = pinnedDetail(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = z.object({ digest: z.string().min(1) }).safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_schema",
      "Reading an approval names the digest.",
      'Call marketingos.get_approval with {"digest":"chg-…"}.'
    );
  }

  const prepared = getPreparedChangeSet(parsed.data.digest);
  if (!prepared) {
    return errResult(
      "approval_mismatch",
      `No prepared change with digest ${parsed.data.digest}.`,
      "project.prepare_change first."
    );
  }
  if (prepared.projectId !== pinned.projectId) {
    return errResult(
      "approval_mismatch",
      `Digest ${prepared.digest} was prepared for a different Connected Project than '${pinned.projectName}'.`,
      "Select the project the change was prepared for, or prepare a new change here."
    );
  }

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      digest: prepared.digest,
      status: prepared.status,
      next: nextForStatus(prepared),
    },
  };
}

// ---------------------------------------------------------------------------
// Operator surface

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * The Operator's decision on one digest. Only a pending change can be
 * decided: an approval that was already consumed, or already refused, is
 * not something to change one's mind about — prepare a new change.
 */
export function decidePreparedChangeSet(
  digest: string,
  decision: "approved" | "rejected",
  actor = "operator"
): PreparedChangeSet {
  const prepared = getPreparedChangeSet(digest);
  if (!prepared) throw new ApprovalError(404, `No prepared change with digest ${digest}`);
  if (prepared.status !== "pending") {
    throw new ApprovalError(
      409,
      `Digest ${digest} is already ${prepared.status}; prepare a new change instead`
    );
  }

  // The status check above is a read; this is the one that decides. Two
  // decisions racing means exactly one row changes, and the loser is told
  // so rather than being handed back the winner's outcome as its own.
  const written = getDb()
    .prepare(
      `UPDATE project_changes
       SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), decided_by = ?
       WHERE digest = ? AND status = 'pending'`
    )
    .run(decision, actor, digest);
  if (written.changes !== 1) {
    throw new ApprovalError(409, `Digest ${digest} was decided by someone else first`);
  }

  const updated = getPreparedChangeSet(digest);
  if (!updated) throw new Error("prepared change vanished while being decided");

  audit(actor, `changes.${decision}`, {
    digest,
    projectId: prepared.projectId,
    summary: prepared.summary,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Phase two: apply

export interface WriteReceipt {
  receiptId: string;
  digest: string;
  projectId: number;
  appliedOperations: number;
  resourceVersions: { name: string; version: number }[];
  nextCursor: number;
  createdAt: string;
}

interface ReceiptRow {
  id: number;
  digest: string;
  project_id: number;
  applied_operations: number;
  resource_versions: string;
  next_cursor: number;
  created_at: string;
}

function rowToReceipt(row: ReceiptRow): WriteReceipt {
  return {
    receiptId: `rcpt-${row.id}`,
    digest: row.digest,
    projectId: row.project_id,
    appliedOperations: row.applied_operations,
    resourceVersions: JSON.parse(row.resource_versions) as { name: string; version: number }[],
    nextCursor: row.next_cursor,
    createdAt: row.created_at,
  };
}

export function getReceiptForDigest(digest: string): WriteReceipt | null {
  const row = getDb().prepare("SELECT * FROM write_receipts WHERE digest = ?").get(digest) as
    | ReceiptRow
    | undefined;
  return row ? rowToReceipt(row) : null;
}

export function listWriteReceipts(): WriteReceipt[] {
  const rows = getDb()
    .prepare("SELECT * FROM write_receipts ORDER BY id DESC")
    .all() as ReceiptRow[];
  return rows.map(rowToReceipt);
}

/**
 * Consume the approval. This is the moment "exactly once" is decided, and
 * it is decided by the database: the UPDATE only matches a row that is
 * still `approved`, and a trigger forbids a `used` row from ever changing
 * again. Two callers racing means one row changes and the other is told no.
 */
function consumeApproval(digest: string): boolean {
  const written = getDb()
    .prepare(
      `UPDATE project_changes
       SET status = 'used', decided_at = decided_at
       WHERE digest = ? AND status = 'approved'`
    )
    .run(digest);
  return written.changes === 1;
}

interface ApplyResponse {
  applied: number;
  resources: { name: string; version: number }[];
  cursor: number;
}

async function applyAtProject(
  projectId: number,
  baseUrl: string,
  prepared: PreparedChangeSet
): Promise<ApplyResponse> {
  const token = await projectServiceToken(projectId, "ai-host");
  const res = await fetch(`${baseUrl}/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      digest: prepared.digest,
      operations: prepared.changeSet.operations,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as
    | (ApplyResponse & { error?: { message?: string } })
    | null;
  if (!res.ok || !body || typeof body.cursor !== "number") {
    const detail = body?.error?.message ?? `status ${res.status}`;
    throw new Error(detail);
  }
  return { applied: body.applied, resources: body.resources ?? [], cursor: body.cursor };
}

/**
 * Phase two. The refusal matrix comes first and in this order, because a
 * host that gets here with the wrong thing should be told which wrong thing
 * it is — see GatewaySim walkthroughs 4 and 5.
 */
export async function applyChange(sessionKey: string, input: unknown): Promise<GatewayResult> {
  const pinned = pinnedDetail(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = z.object({ digest: z.string().min(1) }).safeParse(input);
  if (!parsed.success) {
    return errResult(
      "invalid_schema",
      "Applying a change names the approved digest.",
      'Call project.apply_change with {"digest":"chg-…"}.'
    );
  }
  const { digest } = parsed.data;

  const prepared = getPreparedChangeSet(digest);
  if (!prepared) {
    return errResult(
      "approval_mismatch",
      `No prepared change with digest ${digest}.`,
      "project.prepare_change first."
    );
  }
  if (prepared.projectId !== pinned.projectId) {
    return errResult(
      "approval_mismatch",
      `Digest ${digest} was prepared for a different Connected Project than '${pinned.projectName}'.`,
      "Select the original project or prepare a new change here."
    );
  }
  if (prepared.status === "used") {
    return errResult(
      "approval_mismatch",
      "This single-use approval was already consumed.",
      "Prepare a new change and get a fresh approval."
    );
  }
  if (prepared.status === "rejected") {
    return errResult(
      "approval_required",
      "The Operator rejected this digest.",
      "Revise the change and prepare again."
    );
  }
  if (prepared.status === "pending") {
    return errResult(
      "approval_required",
      `Digest ${digest} is not approved yet.`,
      "Poll marketingos.get_approval and wait for the Operator."
    );
  }

  // An approval is a person saying yes to a diff against a specific state
  // of the project. If the project moved after that, the approval no longer
  // describes anything anyone agreed to — even though it says "approved".
  const stale = await staleSnapshotRefusal(
    sessionKey,
    [...new Set(prepared.changeSet.operations.map(targetResource))],
    "project.apply_change",
    "project.get_snapshot, recompute, prepare again, get a fresh approval."
  );
  if (stale) return stale;
  if (prepared.cursor !== pinned.cursor) {
    return errResult(
      "stale_snapshot",
      "The project changed after this change was prepared; the approval no longer matches reality.",
      "project.get_snapshot, recompute, prepare again, get a fresh approval."
    );
  }

  // Consume before applying, deliberately. If the project write then fails,
  // an approval has been spent and nothing was written — the host prepares
  // again and a person looks again. The other order risks applying a change
  // twice, and a wasted approval is the cheaper failure by far.
  if (!consumeApproval(digest)) {
    return errResult(
      "approval_mismatch",
      "This single-use approval was already consumed.",
      "Prepare a new change and get a fresh approval."
    );
  }

  let result: ApplyResponse;
  try {
    result = await applyAtProject(pinned.projectId, pinned.baseUrl, prepared);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    audit("ai-host", "changes.apply_failed", { digest, projectId: pinned.projectId, detail });
    return errResult(
      "temporarily_unavailable",
      `The Connected Project did not apply the change: ${detail}. Nothing was written, and this approval is spent.`,
      "project.get_snapshot, prepare the change again, and ask the Operator for a fresh approval."
    );
  }

  const info = getDb()
    .prepare(
      `INSERT INTO write_receipts
        (digest, project_id, applied_operations, resource_versions, next_cursor)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      digest,
      pinned.projectId,
      result.applied,
      JSON.stringify(result.resources),
      result.cursor
    );
  const receipt = getReceiptForDigest(digest);
  if (!receipt) throw new Error("write receipt did not persist");

  audit("ai-host", "changes.applied", {
    digest,
    projectId: pinned.projectId,
    receiptId: `rcpt-${Number(info.lastInsertRowid)}`,
    applied: result.applied,
    nextCursor: result.cursor,
  });

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      writeReceipt: receipt,
      note: "The change is applied and the approval is spent. Call project.get_snapshot to pin the new revision before reading or writing again.",
    },
  };
}
