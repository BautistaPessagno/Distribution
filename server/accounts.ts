// Account Slots, Account Instances, and readiness (ticket 19; decisions:
// docs/issues/marketing-os/issues/12-define-account-operations-workflow.md).
//
// A slot is durable capacity: this Connected Project has a presence on this
// platform, with this identity spec, these niche keywords, these disclosure
// rules, these caps, and these windows. It outlives whatever account is
// currently filling it.
//
// An instance is the replaceable platform identity in that slot. It holds a
// handle and a custody reference — never a credential. Losing an instance
// does not lose the slot: the instance archives read-only with its reason
// and its history, and the slot spawns a replacement that re-earns
// readiness from nothing.
//
// Readiness is an explicit six-item checklist and never elapsed time. Each
// item is checked only by a recorded fact, and the evidence is append-only,
// because "we waited a while" is not evidence of anything.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  DEFAULT_WINDOWS,
  identityRefusal,
  policyFor,
  PLATFORMS,
  type DailyCap,
  type IdentityKind,
  type Platform,
} from "./platform-policy";
import { isSecretReference } from "./secrets";

/**
 * The six items, each backed by a Work Order or a recorded fact. Nothing
 * here is time-based, deliberately: an account is ready because someone can
 * point at what makes it ready.
 */
export const READINESS_ITEMS = [
  "profile_complete",
  "identity_and_disclosure_approved",
  "observation_sessions_logged",
  "niche_interactions_evidenced",
  "platform_health_check_passed",
  "operator_sign_off",
] as const;
export type ReadinessItem = (typeof READINESS_ITEMS)[number];

export const READINESS_LABELS: Record<ReadinessItem, string> = {
  profile_complete: "Profile complete and truthful",
  identity_and_disclosure_approved: "Identity spec and disclosure rules approved",
  observation_sessions_logged: "Observation sessions logged",
  niche_interactions_evidenced: "Niche interactions evidenced by proof",
  platform_health_check_passed: "Platform health check passed",
  operator_sign_off: "Operator sign-off",
};

export const SLOT_STATUSES = [
  "requested",
  "provisioning",
  "warming",
  "ready",
  "active",
  "impaired",
  "replacing",
  "paused",
  "retired",
] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const INSTANCE_HEALTH = ["unverified", "healthy", "impaired", "lost"] as const;
export type InstanceHealth = (typeof INSTANCE_HEALTH)[number];

export interface AccountSlot {
  id: number;
  projectId: number;
  platform: Platform;
  label: string;
  identitySpec: { kind: IdentityKind; displayName: string; notes?: string };
  nicheKeywords: string[];
  disclosureRules: string[];
  riskPolicy: Record<string, unknown>;
  dailyCaps: DailyCap[];
  allowedWindows: { start: string; end: string }[];
  status: SlotStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInstance {
  id: number;
  slotId: number;
  handle: string;
  /** A custody reference, or null. Never a credential. */
  credentialsReference: string | null;
  health: InstanceHealth;
  lostReason: string | null;
  /** The instance this one stands in for, when it replaced a lost account. */
  replacesInstanceId: number | null;
  archived: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface ReadinessRecord {
  item: ReadinessItem;
  label: string;
  evidence: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

interface SlotRow {
  id: number;
  project_id: number;
  platform: Platform;
  label: string;
  identity_spec: string;
  niche_keywords: string;
  disclosure_rules: string;
  risk_policy: string;
  daily_caps: string;
  allowed_windows: string;
  status: SlotStatus;
  created_at: string;
  updated_at: string;
}

interface InstanceRow {
  id: number;
  slot_id: number;
  handle: string;
  credentials_reference: string | null;
  health: InstanceHealth;
  lost_reason: string | null;
  replaces_instance_id: number | null;
  archived: number;
  created_at: string;
  archived_at: string | null;
}

function rowToSlot(row: SlotRow): AccountSlot {
  return {
    id: row.id,
    projectId: row.project_id,
    platform: row.platform,
    label: row.label,
    identitySpec: JSON.parse(row.identity_spec) as AccountSlot["identitySpec"],
    nicheKeywords: JSON.parse(row.niche_keywords) as string[],
    disclosureRules: JSON.parse(row.disclosure_rules) as string[],
    riskPolicy: JSON.parse(row.risk_policy) as Record<string, unknown>,
    dailyCaps: JSON.parse(row.daily_caps) as DailyCap[],
    allowedWindows: JSON.parse(row.allowed_windows) as { start: string; end: string }[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInstance(row: InstanceRow): AccountInstance {
  return {
    id: row.id,
    slotId: row.slot_id,
    handle: row.handle,
    credentialsReference: row.credentials_reference,
    health: row.health,
    lostReason: row.lost_reason,
    replacesInstanceId: row.replaces_instance_id,
    archived: row.archived === 1,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "AccountError";
  }
}

// ---------------------------------------------------------------------------
// Reading

export function getSlotById(id: number): AccountSlot | null {
  const row = getDb().prepare("SELECT * FROM account_slots WHERE id = ?").get(id) as
    | SlotRow
    | undefined;
  return row ? rowToSlot(row) : null;
}

export function listSlots(projectId?: number): AccountSlot[] {
  const db = getDb();
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT * FROM account_slots ORDER BY id DESC").all()
      : db.prepare("SELECT * FROM account_slots WHERE project_id = ? ORDER BY id DESC").all(projectId)
  ) as SlotRow[];
  return rows.map(rowToSlot);
}

export function listInstances(slotId: number): AccountInstance[] {
  const rows = getDb()
    .prepare("SELECT * FROM account_instances WHERE slot_id = ? ORDER BY id DESC")
    .all(slotId) as InstanceRow[];
  return rows.map(rowToInstance);
}

/** The instance currently filling the slot, if any is still in place. */
export function currentInstance(slotId: number): AccountInstance | null {
  const row = getDb()
    .prepare("SELECT * FROM account_instances WHERE slot_id = ? AND archived = 0 ORDER BY id DESC LIMIT 1")
    .get(slotId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

/** The most recently archived instance of a slot, if the slot has lost one. */
export function lastArchivedInstance(slotId: number): AccountInstance | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM account_instances WHERE slot_id = ? AND archived = 1 ORDER BY id DESC LIMIT 1"
    )
    .get(slotId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

/** The instance that stands in for this one, when a replacement arrived. */
export function replacementOf(instanceId: number): AccountInstance | null {
  const row = getDb()
    .prepare("SELECT * FROM account_instances WHERE replaces_instance_id = ? ORDER BY id ASC LIMIT 1")
    .get(instanceId) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function getInstanceById(id: number): AccountInstance | null {
  const row = getDb().prepare("SELECT * FROM account_instances WHERE id = ?").get(id) as
    | InstanceRow
    | undefined;
  return row ? rowToInstance(row) : null;
}

/** The checklist for one instance: every item, and what earned it or not. */
export function readinessFor(instanceId: number): ReadinessRecord[] {
  const rows = getDb()
    .prepare("SELECT item, evidence, recorded_by, recorded_at FROM readiness_evidence WHERE instance_id = ?")
    .all(instanceId) as {
    item: ReadinessItem;
    evidence: string;
    recorded_by: string;
    recorded_at: string;
  }[];
  const byItem = new Map(rows.map((r) => [r.item, r]));
  return READINESS_ITEMS.map((item) => {
    const row = byItem.get(item);
    return {
      item,
      label: READINESS_LABELS[item],
      evidence: row?.evidence ?? null,
      recordedBy: row?.recorded_by ?? null,
      recordedAt: row?.recorded_at ?? null,
    };
  });
}

export function outstandingReadiness(instanceId: number): ReadinessItem[] {
  return readinessFor(instanceId)
    .filter((record) => record.evidence === null)
    .map((record) => record.item);
}

// ---------------------------------------------------------------------------
// Creating a slot

const identitySpecSchema = z.object({
  kind: z.enum(["page", "business_account", "profile"]),
  displayName: z.string().min(1).max(120),
  notes: z.string().max(500).optional(),
});

export const createSlotSchema = z.object({
  projectId: z.number().int(),
  platform: z.enum(PLATFORMS),
  label: z.string().min(1).max(120),
  identitySpec: identitySpecSchema,
  nicheKeywords: z.array(z.string().min(1)).max(50).optional(),
  disclosureRules: z.array(z.string().min(1)).max(20).optional(),
  riskPolicy: z.record(z.string(), z.unknown()).optional(),
  dailyCaps: z
    .array(
      z.object({
        action: z.string().min(1),
        perDay: z.number().int().min(0).max(1000),
      })
    )
    .optional(),
  allowedWindows: z
    .array(z.object({ start: z.string(), end: z.string() }))
    .max(6)
    .optional(),
});

/**
 * Fold the Operator's numbers into the shipped caps. Every action the
 * platform policy caps stays capped; an override changes a number, and an
 * action the defaults never mentioned is added. Nothing here is ever a
 * platform-sanctioned volume.
 */
function mergeCaps(
  defaults: DailyCap[],
  overrides: { action: string; perDay: number }[] | undefined
): DailyCap[] {
  if (!overrides || overrides.length === 0) return defaults;
  const byAction = new Map<string, DailyCap>(defaults.map((cap) => [cap.action, { ...cap }]));
  for (const override of overrides) {
    const shipped = byAction.get(override.action);
    byAction.set(override.action, {
      action: override.action,
      perDay: override.perDay,
      basis: "judgment_call",
      platformAnchor: shipped?.platformAnchor ?? null,
    });
  }
  return [...byAction.values()];
}

/**
 * Create an Account Slot. The platform's own identity rule is enforced
 * here, before anything exists: a LinkedIn slot must be a Page, because
 * LinkedIn allows exactly one real-name member profile per person and a
 * persona profile is a policy violation rather than a risk to weigh.
 */
export function createSlot(input: unknown, actor = "operator"): AccountSlot {
  const parsed = createSlotSchema.safeParse(input);
  if (!parsed.success) {
    throw new AccountError(
      400,
      "The Account Slot does not match the expected shape.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const spec = parsed.data;
  const policy = policyFor(spec.platform);

  const refusal = identityRefusal(spec.platform, spec.identitySpec.kind);
  if (refusal) throw new AccountError(409, refusal);

  // A cap the Operator sets is still a judgment call; overriding a number
  // does not turn it into a platform fact. Overrides are merged onto the
  // shipped defaults rather than replacing the list, because naming one
  // action must never leave the other actions uncapped.
  const caps: DailyCap[] = mergeCaps(policy.defaultCaps, spec.dailyCaps);

  const info = getDb()
    .prepare(
      `INSERT INTO account_slots
        (project_id, platform, label, identity_spec, niche_keywords, disclosure_rules,
         risk_policy, daily_caps, allowed_windows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      spec.projectId,
      spec.platform,
      spec.label,
      JSON.stringify(spec.identitySpec),
      JSON.stringify(spec.nicheKeywords ?? []),
      JSON.stringify(spec.disclosureRules ?? [policy.disclosureRule]),
      JSON.stringify(spec.riskPolicy ?? {}),
      JSON.stringify(caps),
      JSON.stringify(spec.allowedWindows ?? DEFAULT_WINDOWS)
    );

  const slot = getSlotById(Number(info.lastInsertRowid));
  if (!slot) throw new Error("account slot did not persist");
  audit(actor, "slots.created", {
    slotId: slot.id,
    projectId: slot.projectId,
    platform: slot.platform,
    identityKind: slot.identitySpec.kind,
  });
  return slot;
}

/**
 * A paused slot is the kill switch held down, and a retired slot is over.
 * Neither is a state a lifecycle move may walk out of sideways: resuming is
 * the only way back from paused, and nothing comes back from retired.
 */
function refuseIfHalted(slot: AccountSlot, doing: string): void {
  if (slot.status === "paused") {
    throw new AccountError(
      409,
      `Account Slot #${slot.id} is paused. Resume it before ${doing}.`
    );
  }
  if (slot.status === "retired") {
    throw new AccountError(409, `Account Slot #${slot.id} is retired, so ${doing} does nothing.`);
  }
}

function setSlotStatus(slotId: number, status: SlotStatus, actor: string, why: string): AccountSlot {
  getDb()
    .prepare(
      "UPDATE account_slots SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    )
    .run(status, slotId);
  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  audit(actor, "slots.status", { slotId, status, why });
  return slot;
}

// ---------------------------------------------------------------------------
// Instances

export const addInstanceSchema = z.object({
  slotId: z.number().int(),
  handle: z.string().min(1).max(120),
  /**
   * A custody reference minted by the secrets store, never a credential.
   * The plaintext has no route into this module at all.
   */
  credentialsReference: z.string().optional(),
});

export function addInstance(input: unknown, actor = "operator"): AccountInstance {
  const parsed = addInstanceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AccountError(
      400,
      "The Account Instance does not match the expected shape.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const { slotId, handle, credentialsReference } = parsed.data;

  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  refuseIfHalted(slot, "filling it");
  if (currentInstance(slotId)) {
    throw new AccountError(
      409,
      `Account Slot #${slotId} already holds an instance. Mark the current one lost before filling the slot again.`
    );
  }
  // The one check that keeps the custody boundary honest: what arrives here
  // must look like a reference the secrets store minted, so a credential
  // pasted into this field is refused rather than stored.
  if (credentialsReference !== undefined && !isSecretReference(credentialsReference)) {
    throw new AccountError(
      400,
      "Credentials are held as a custody reference, never as a value. Store the credential in the secrets store first and pass its reference."
    );
  }

  // A slot's history is a chain, not a pile. When this instance is filling
  // the space a lost one left, it says which one — so the archived account
  // keeps everything it did and stays reachable from the account that
  // stands in for it.
  const replaced = lastArchivedInstance(slotId);

  const info = getDb()
    .prepare(
      "INSERT INTO account_instances (slot_id, handle, credentials_reference, replaces_instance_id) VALUES (?, ?, ?, ?)"
    )
    .run(slotId, handle, credentialsReference ?? null, replaced?.id ?? null);

  const instance = getInstanceById(Number(info.lastInsertRowid));
  if (!instance) throw new Error("account instance did not persist");

  setSlotStatus(slotId, "warming", actor, `instance #${instance.id} added`);
  audit(actor, "instances.added", {
    slotId,
    instanceId: instance.id,
    handle,
    replacesInstanceId: replaced?.id ?? null,
    // The reference, never the credential — and only whether one exists.
    hasCredentialReference: credentialsReference !== undefined,
  });
  return instance;
}

export const recordEvidenceSchema = z.object({
  instanceId: z.number().int(),
  item: z.enum(READINESS_ITEMS),
  evidence: z.string().min(1).max(2000),
});

/**
 * Check one item off, with the fact that checks it. Evidence is
 * append-only: a checklist item is earned once, and re-recording it would
 * be rewriting the reason an account was trusted.
 */
export function recordReadiness(input: unknown, actor = "operator"): ReadinessRecord[] {
  const parsed = recordEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AccountError(
      400,
      "Readiness evidence names the instance, the checklist item, and the fact.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const { instanceId, item, evidence } = parsed.data;

  const instance = getInstanceById(instanceId);
  if (!instance) throw new AccountError(404, `No Account Instance #${instanceId}`);
  if (instance.archived) {
    throw new AccountError(409, `Account Instance #${instanceId} is archived and earns nothing more`);
  }
  try {
    getDb()
      .prepare(
        "INSERT INTO readiness_evidence (instance_id, item, evidence, recorded_by) VALUES (?, ?, ?, ?)"
      )
      .run(instanceId, item, evidence, actor);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      throw new AccountError(409, `${READINESS_LABELS[item]} is already evidenced for this instance`);
    }
    throw err;
  }

  audit(actor, "readiness.recorded", { instanceId, slotId: instance.slotId, item });
  return readinessFor(instanceId);
}

export interface ReadinessOutcome {
  slot: AccountSlot;
  checklist: ReadinessRecord[];
  outstanding: ReadinessItem[];
}

/**
 * Walk the slot to ready. This is the only route to `ready`, and it opens
 * only when all six items hold evidence — never because time passed.
 */
export function markReady(slotId: number, actor = "operator"): ReadinessOutcome {
  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  refuseIfHalted(slot, "walking it to ready");

  const instance = currentInstance(slotId);
  if (!instance) {
    throw new AccountError(409, `Account Slot #${slotId} holds no instance to make ready`);
  }

  const outstanding = outstandingReadiness(instance.id);
  if (outstanding.length > 0) {
    throw new AccountError(
      409,
      `${outstanding.length} readiness item(s) hold no evidence yet. Readiness is earned item by item, never by elapsed time.`,
      outstanding.map((item) => READINESS_LABELS[item])
    );
  }

  const ready = setSlotStatus(slotId, "ready", actor, "all six readiness items evidenced");
  getDb()
    .prepare("UPDATE account_instances SET health = 'healthy' WHERE id = ?")
    .run(instance.id);

  return { slot: ready, checklist: readinessFor(instance.id), outstanding: [] };
}

/**
 * The instance is gone. It archives read-only with its reason and keeps
 * everything attached to it; the slot survives and goes to replacing, and
 * the next instance earns readiness from nothing.
 */
export function markInstanceLost(
  instanceId: number,
  reason: string,
  actor = "operator"
): { instance: AccountInstance; slot: AccountSlot } {
  const instance = getInstanceById(instanceId);
  if (!instance) throw new AccountError(404, `No Account Instance #${instanceId}`);
  if (instance.archived) throw new AccountError(409, "That instance is already archived");
  if (!reason.trim()) throw new AccountError(400, "A lost instance records why it was lost");

  getDb()
    .prepare(
      `UPDATE account_instances
       SET health = 'lost', lost_reason = ?, archived = 1,
           archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
    .run(reason.trim(), instanceId);

  // Losing an account is a fact, not an Operator move, so it is always
  // recorded — but it must not lift a kill switch or revive a retired slot.
  // Those slots stay where they are and keep the loss on the record.
  const owner = getSlotById(instance.slotId);
  if (!owner) throw new AccountError(404, `No Account Slot #${instance.slotId}`);
  const slot =
    owner.status === "paused" || owner.status === "retired"
      ? owner
      : setSlotStatus(instance.slotId, "replacing", actor, `instance #${instanceId} lost`);
  audit(actor, "instances.lost", { instanceId, slotId: instance.slotId, reason: reason.trim() });

  const archived = getInstanceById(instanceId);
  if (!archived) throw new Error("archived instance vanished");
  return { instance: archived, slot };
}

/** The kill switch: everything for this slot stops now. Ticket 21 enforces it. */
export function pauseSlot(slotId: number, actor = "operator"): AccountSlot {
  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  return setSlotStatus(slotId, "paused", actor, "paused by the Operator");
}

export function resumeSlot(slotId: number, actor = "operator"): AccountSlot {
  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  if (slot.status !== "paused") throw new AccountError(409, `Account Slot #${slotId} is not paused`);
  const instance = currentInstance(slotId);
  const restored: SlotStatus = instance
    ? outstandingReadiness(instance.id).length === 0
      ? "ready"
      : "warming"
    : // No instance in place: a slot that never held one is still merely
      // requested, and one whose instance was lost still needs a replacement.
      listInstances(slotId).length === 0
      ? "requested"
      : "replacing";
  return setSlotStatus(slotId, restored, actor, "resumed by the Operator");
}

export function activateSlot(slotId: number, actor = "operator"): AccountSlot {
  const slot = getSlotById(slotId);
  if (!slot) throw new AccountError(404, `No Account Slot #${slotId}`);
  if (slot.status !== "ready") {
    throw new AccountError(409, `Only a ready slot goes active. Slot #${slotId} is ${slot.status}.`);
  }
  return setSlotStatus(slotId, "active", actor, "activated by the Operator");
}

// ---------------------------------------------------------------------------
// The shape every surface sees
//
// One function builds it, so there is exactly one place where a field could
// have been added that should not leave this process.

export function slotView(slot: AccountSlot): Record<string, unknown> {
  const instance = currentInstance(slot.id);
  const policy = policyFor(slot.platform);
  return {
    id: slot.id,
    projectId: slot.projectId,
    platform: slot.platform,
    label: slot.label,
    identitySpec: slot.identitySpec,
    identityRule: policy.identityRule,
    nicheKeywords: slot.nicheKeywords,
    disclosureRules: slot.disclosureRules,
    riskPolicy: slot.riskPolicy,
    dailyCaps: slot.dailyCaps,
    allowedWindows: slot.allowedWindows,
    // Said out loud on every surface: these numbers are ours, not the
    // platform's, unless an anchor names the page they came from.
    capsNote:
      "Daily caps are MarketingOS judgment calls, not platform-sanctioned volumes. Where a platform publishes a number, it is recorded as an anchor and the shipped cap sits well below it.",
    status: slot.status,
    createdAt: slot.createdAt,
    instance: instance ? instanceView(instance) : null,
    readiness: instance ? readinessFor(instance.id) : [],
    outstandingReadiness: instance ? outstandingReadiness(instance.id) : [...READINESS_ITEMS],
  };
}

/**
 * An instance as anything outside this module may see it. `credentials`
 * reports only whether a custody reference exists — the reference itself is
 * a lookup key into the secrets store, and nothing downstream needs it.
 */
export function instanceView(instance: AccountInstance): Record<string, unknown> {
  return {
    id: instance.id,
    slotId: instance.slotId,
    handle: instance.handle,
    credentials: instance.credentialsReference ? "held in the secrets store" : "none recorded",
    health: instance.health,
    lostReason: instance.lostReason,
    archived: instance.archived,
    // Both directions of the chain, so neither end of a replacement is a
    // dead link on any surface.
    replaces: instance.replacesInstanceId,
    replacedBy: replacementOf(instance.id)?.id ?? null,
    createdAt: instance.createdAt,
    archivedAt: instance.archivedAt,
  };
}
