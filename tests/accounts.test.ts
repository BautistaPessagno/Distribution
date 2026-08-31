// Account Slots, Account Instances, and readiness (ticket 19).
//
// Decisions under test:
//   .scratch/marketing-os/issues/12-define-account-operations-workflow.md
//     — the six-item checklist, the slot lifecycle, loss and replacement
//   .scratch/marketing-os/issues/19-research-platform-policies-for-warmup.md
//     — LinkedIn Page-not-persona, and caps as judgment calls

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

import express from "express";
import { accountRouter } from "../server/account-routes";
import {
  AccountError,
  activateSlot,
  addInstance,
  createSlot,
  currentInstance,
  getSlotById,
  instanceView,
  listSlots,
  markInstanceLost,
  markReady,
  outstandingReadiness,
  pauseSlot,
  readinessFor,
  recordReadiness,
  resumeSlot,
  slotView,
  READINESS_ITEMS,
} from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import {
  identityRefusal,
  judgmentCallCaps,
  PLATFORM_POLICIES,
  policyFor,
} from "../server/platform-policy";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { findSecretShapedStrings } from "../server/response-lint";
import { storeSecret } from "../server/secrets";
import { stubVerifyAgainstProjects } from "../server/stub-project";

const router = createProjectDomainRouter({
  manifest: () => ({
    name: "test-project",
    contractVersion: PROJECT_CONTRACT_VERSION,
    resources: [...REQUIRED_RESOURCES],
    capabilities: [],
  }),
  resource(name: RequiredResource): ResourceEnvelope {
    return { resource: name, state: "ok", version: 1, data: {} };
  },
  changes: () => ({ cursor: 0, entries: [] }),
  verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
});

const app = express();
app.use("/keepanalog", router);
app.use("/api/slots", accountRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

let projectId = 0;
let cookie = "";

function operatorCookie(): string {
  const salt = randomBytes(16).toString("hex");
  const inserted = getDb()
    .prepare(
      "INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt) VALUES (?, ?, ?)"
    )
    .run("operator", hashRecoveryCode("AAAAA-AAAAA-AAAAA-AAAAA", salt), salt);
  const { token } = createSession(Number(inserted.lastInsertRowid));
  return `${SESSION_COOKIE}=${token}`;
}

async function api<T>(
  pathname: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

function slot(overrides: Record<string, unknown> = {}) {
  return createSlot({
    projectId,
    platform: "x",
    label: "KeepAnalog on X",
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
    nicheKeywords: ["stationery", "notebooks"],
    ...overrides,
  });
}

/** Evidence every item, the only way to readiness. */
function evidenceAll(instanceId: number): void {
  for (const item of READINESS_ITEMS) {
    recordReadiness({ instanceId, item, evidence: `fact for ${item}` });
  }
}

test.before(async () => {
  const registered = await registerProject(
    "KeepAnalog",
    `http://127.0.0.1:${port}/keepanalog`,
    "test"
  );
  projectId = registered.project.id;
  assert.equal((await selectProject("slot-session", "KeepAnalog")).ok, true);
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: requested to ready only when all six items hold evidence

test("a slot walks to ready only when all six checklist items hold evidence", () => {
  const created = slot({ label: "Readiness walk" });
  assert.equal(created.status, "requested");

  // Nothing to make ready yet.
  assert.throws(() => markReady(created.id), /holds no instance/);

  const instance = addInstance({ slotId: created.id, handle: "@keepanalog" });
  assert.equal(getSlotById(created.id)?.status, "warming");
  assert.deepEqual(outstandingReadiness(instance.id), [...READINESS_ITEMS]);

  // Five of six is not ready. Nothing about "close enough" or time passing.
  for (const item of READINESS_ITEMS.slice(0, 5)) {
    recordReadiness({ instanceId: instance.id, item, evidence: `fact for ${item}` });
  }
  assert.throws(
    () => markReady(created.id),
    (err: unknown) =>
      err instanceof AccountError &&
      /1 readiness item\(s\) hold no evidence/.test(err.message) &&
      /never by elapsed time/.test(err.message) &&
      err.detail.length === 1
  );
  assert.equal(getSlotById(created.id)?.status, "warming");

  recordReadiness({
    instanceId: instance.id,
    item: "operator_sign_off",
    evidence: "Reviewed and signed off",
  });
  const outcome = markReady(created.id);
  assert.equal(outcome.slot.status, "ready");
  assert.deepEqual(outcome.outstanding, []);
  assert.ok(outcome.checklist.every((r) => r.evidence !== null));
  assert.equal(currentInstance(created.id)?.health, "healthy");

  // Only a ready slot goes active.
  assert.equal(activateSlot(created.id).status, "active");
});

test("readiness evidence is append-only, and time alone never checks an item", () => {
  const created = slot({ label: "Evidence is permanent" });
  const instance = addInstance({ slotId: created.id, handle: "@permanent" });

  recordReadiness({
    instanceId: instance.id,
    item: "profile_complete",
    evidence: "Bio, link, and avatar set on 2026-09-01",
  });

  // Recorded once. Re-recording would rewrite why the account was trusted.
  assert.throws(
    () =>
      recordReadiness({
        instanceId: instance.id,
        item: "profile_complete",
        evidence: "something else",
      }),
    /already evidenced/
  );
  assert.throws(
    () =>
      getDb()
        .prepare("UPDATE readiness_evidence SET evidence = 'rewritten' WHERE instance_id = ?")
        .run(instance.id),
    /append-only/
  );
  assert.throws(
    () => getDb().prepare("DELETE FROM readiness_evidence WHERE instance_id = ?").run(instance.id),
    /append-only/
  );

  // There is no elapsed-time route: the only column that could stand in for
  // one is a timestamp on the evidence itself.
  const record = readinessFor(instance.id).find((r) => r.item === "profile_complete");
  assert.ok(record?.recordedAt);
  assert.equal(record?.recordedBy, "operator");
  assert.throws(() => markReady(created.id), /hold no evidence/);
});

test("a replacement instance earns readiness from nothing, and the loss is kept", () => {
  const created = slot({ label: "Loss and replacement" });
  const first = addInstance({ slotId: created.id, handle: "@first" });
  evidenceAll(first.id);
  assert.equal(markReady(created.id).slot.status, "ready");

  const { instance: archived, slot: afterLoss } = markInstanceLost(
    first.id,
    "Suspended for a policy the account did not break"
  );
  assert.equal(archived.archived, true);
  assert.equal(archived.health, "lost");
  assert.equal(archived.lostReason, "Suspended for a policy the account did not break");
  assert.ok(archived.archivedAt);
  // The slot survives; the capacity was never the account.
  assert.equal(afterLoss.status, "replacing");
  assert.equal(currentInstance(created.id), null);

  // Its history is still attached, read-only.
  assert.equal(readinessFor(first.id).filter((r) => r.evidence !== null).length, 6);
  assert.throws(
    () => recordReadiness({ instanceId: first.id, item: "profile_complete", evidence: "x" }),
    /archived/
  );

  // And the replacement starts from nothing.
  const second = addInstance({ slotId: created.id, handle: "@second" });
  assert.deepEqual(outstandingReadiness(second.id), [...READINESS_ITEMS]);
  assert.throws(() => markReady(created.id), /hold no evidence/);
  assert.throws(() => markInstanceLost(first.id, "again"), /already archived/);
  assert.throws(() => markInstanceLost(second.id, "  "), /records why/);
});

test("the kill switch pauses a slot, and resuming restores what it had earned", () => {
  const created = slot({ label: "Kill switch" });
  const instance = addInstance({ slotId: created.id, handle: "@paused" });
  evidenceAll(instance.id);
  markReady(created.id);

  assert.equal(pauseSlot(created.id).status, "paused");
  assert.equal(resumeSlot(created.id).status, "ready");
  assert.throws(() => resumeSlot(created.id), /not paused/);

  // A slot that had not earned readiness comes back to warming, not ready.
  const unready = slot({ label: "Paused while warming" });
  addInstance({ slotId: unready.id, handle: "@warming" });
  pauseSlot(unready.id);
  assert.equal(resumeSlot(unready.id).status, "warming");
});

// ---------------------------------------------------------------------------
// Criterion 2: credentials exist only as custody references

test("credentials exist only as custody references, and no surface carries one", async () => {
  const created = slot({ label: "Custody" });
  const secret = "hunter2-this-is-the-actual-password-value";
  const reference = await storeSecret("account-credential", secret, "operator");

  const instance = addInstance({
    slotId: created.id,
    handle: "@custody",
    credentialsReference: reference,
  });
  evidenceAll(instance.id);
  markReady(created.id);

  // A credential pasted in where a reference belongs is refused outright.
  const other = slot({ label: "Refuses a raw credential" });
  assert.throws(
    () => addInstance({ slotId: other.id, handle: "@raw", credentialsReference: secret }),
    /custody reference, never as a value/
  );

  const auditRows = JSON.stringify(
    getDb().prepare("SELECT actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 200").all()
  );

  // Every account surface: the views, the host tool's payload, and the HTTP
  // responses. None carries the credential, and none carries even the
  // custody reference — nothing downstream of this module needs it.
  const surfaces: string[] = [
    JSON.stringify(instanceView(instance)),
    JSON.stringify(slotView(getSlotById(created.id)!)),
    JSON.stringify(listSlots(projectId).map(slotView)),
    JSON.stringify((await api("/api/slots")).body),
    JSON.stringify((await api(`/api/slots/${created.id}`)).body),
    auditRows,
  ];
  for (const [index, surface] of surfaces.entries()) {
    assert.ok(!surface.includes(secret), `surface ${index} leaked the credential`);
    // Nothing secret-shaped got in by another route either.
    assert.deepEqual(findSecretShapedStrings(surface), [], `surface ${index} looks secret-shaped`);
  }
  for (const [index, surface] of surfaces.slice(0, -1).entries()) {
    assert.ok(!surface.includes(reference), `surface ${index} leaked the custody reference`);
  }

  // The audit log is the exception, and deliberately: a custody reference
  // is a lookup key, not a credential, and the trail of which reference was
  // minted for whom is the point of having one. What this module writes
  // there is only whether a reference exists at all.
  assert.ok(auditRows.includes(reference), "the secrets store records the reference it minted");
  const instanceAudit = getDb()
    .prepare("SELECT detail FROM audit_log WHERE action = 'instances.added' ORDER BY id DESC LIMIT 1")
    .get() as { detail: string };
  assert.ok(!instanceAudit.detail.includes(reference));
  assert.match(instanceAudit.detail, /"hasCredentialReference":true/);

  // What a surface does say is only that one is held.
  assert.equal(
    (instanceView(instance) as { credentials: string }).credentials,
    "held in the secrets store"
  );
  // The reference itself is still in the row, because that is how the
  // credential is found again — it simply never leaves this process.
  assert.equal(currentInstance(created.id)?.credentialsReference, reference);
});

// ---------------------------------------------------------------------------
// Criterion 3: non-X default caps are visibly labeled judgment calls

test("non-X default caps are labeled judgment calls with no platform number behind them", () => {
  for (const platform of ["instagram", "tiktok", "linkedin"] as const) {
    const policy = policyFor(platform);
    assert.ok(policy.defaultCaps.length > 0, `${platform} ships caps`);
    for (const cap of policy.defaultCaps) {
      assert.equal(cap.basis, "judgment_call", `${platform} ${cap.action}`);
      assert.equal(
        cap.platformAnchor,
        null,
        `${platform} publishes no number for ${cap.action}, so no anchor may be claimed`
      );
    }
    assert.equal(judgmentCallCaps(policy.defaultCaps).length, policy.defaultCaps.length);
  }

  // X is the one platform that publishes numbers, and even there the
  // shipped cap is ours and sits well below the published ceiling.
  const x = policyFor("x");
  const follow = x.defaultCaps.find((c) => c.action === "follow");
  assert.ok(follow?.platformAnchor);
  assert.equal(follow.basis, "judgment_call");
  assert.equal(follow.platformAnchor.value, 400);
  assert.ok(follow.perDay < follow.platformAnchor.value / 10);
  assert.match(follow.platformAnchor.source, /^https:\/\/help\.x\.com\//);
  assert.match(follow.platformAnchor.observedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(follow.platformAnchor.note, /not a safe|still breaks the rules/);
});

test("every slot surface says out loud that its caps are ours", async () => {
  const created = slot({ label: "Caps are ours", platform: "instagram" });
  const view = slotView(getSlotById(created.id)!) as { capsNote: string; dailyCaps: unknown[] };
  assert.match(view.capsNote, /judgment calls, not platform-sanctioned/);

  const policies = await api<{ note: string; policies: typeof PLATFORM_POLICIES }>(
    "/api/slots/policies"
  );
  assert.equal(policies.status, 200);
  assert.match(policies.body.note, /judgment call/);
  assert.match(policies.body.note, /the date it was read/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/slots/policies`)).status, 401);
});

test("an Operator's own cap is still a judgment call, not a platform fact", () => {
  const created = slot({
    label: "Operator override",
    platform: "instagram",
    dailyCaps: [{ action: "follow", perDay: 3 }],
  });
  assert.deepEqual(getSlotById(created.id)?.dailyCaps, [
    { action: "follow", perDay: 3, basis: "judgment_call", platformAnchor: null },
  ]);
});

// ---------------------------------------------------------------------------
// The LinkedIn rule

test("a LinkedIn slot must be a Page, and a persona profile is refused by the rule", () => {
  assert.throws(
    () =>
      slot({
        label: "LinkedIn persona",
        platform: "linkedin",
        identitySpec: { kind: "profile", displayName: "KeepAnalog" },
      }),
    (err: unknown) =>
      err instanceof AccountError &&
      err.status === 409 &&
      /exactly one real-name member profile/.test(err.message) &&
      /never a persona profile/.test(err.message)
  );

  const page = slot({
    label: "LinkedIn Page",
    platform: "linkedin",
    identitySpec: { kind: "page", displayName: "KeepAnalog" },
  });
  assert.equal(page.platform, "linkedin");
  assert.equal(page.identitySpec.kind, "page");
  // And the rule travels with the slot, so a person sees why.
  assert.match(
    String((slotView(page) as { identityRule: string }).identityRule),
    /must be a Page/
  );

  assert.equal(identityRefusal("linkedin", "page"), null);
  assert.ok(identityRefusal("linkedin", "business_account"));
  assert.equal(identityRefusal("x", "business_account"), null);
});

// ---------------------------------------------------------------------------
// The Operator surface

test("the Operator creates a slot, fills it, evidences it, and readies it over HTTP", async () => {
  const created = await api<{ slot: { id: number; status: string } }>("/api/slots", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      platform: "tiktok",
      label: "KeepAnalog on TikTok",
      identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
    }),
  });
  assert.equal(created.status, 200);
  const slotId = created.body.slot.id;

  const filled = await api<{ instance: { id: number }; slot: { status: string } }>(
    `/api/slots/${slotId}/instances`,
    { method: "POST", body: JSON.stringify({ handle: "@keepanalog" }) }
  );
  assert.equal(filled.status, 200);
  assert.equal(filled.body.slot.status, "warming");
  const instanceId = filled.body.instance.id;

  // Not ready yet, and the refusal names what is outstanding.
  const early = await api<{ error: string; detail: string[] }>(`/api/slots/${slotId}/ready`, {
    method: "POST",
  });
  assert.equal(early.status, 409);
  assert.equal(early.body.detail.length, 6);

  for (const item of READINESS_ITEMS) {
    const recorded = await api(`/api/slots/${slotId}/readiness`, {
      method: "POST",
      body: JSON.stringify({ instanceId, item, evidence: `fact for ${item}` }),
    });
    assert.equal(recorded.status, 200);
  }

  const ready = await api<{ slot: { status: string } }>(`/api/slots/${slotId}/ready`, {
    method: "POST",
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.slot.status, "ready");

  // The lifecycle renders: every slot carries its state and its checklist.
  const listed = await api<{ slots: { id: number; status: string; readiness: unknown[] }[] }>(
    "/api/slots"
  );
  const row = listed.body.slots.find((s) => s.id === slotId);
  assert.equal(row?.status, "ready");
  assert.equal(row?.readiness.length, 6);

  assert.equal((await api("/api/slots/424242")).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/slots`)).status, 401);

  const malformed = await api<{ detail: string[] }>("/api/slots", {
    method: "POST",
    body: JSON.stringify({ projectId, platform: "myspace", label: "x" }),
  });
  assert.equal(malformed.status, 400);
  assert.ok(malformed.body.detail.length > 0);
});

test("a slot holds one instance at a time", () => {
  const created = slot({ label: "One at a time" });
  addInstance({ slotId: created.id, handle: "@first" });
  assert.throws(
    () => addInstance({ slotId: created.id, handle: "@second" }),
    /already holds an instance/
  );
  assert.throws(() => addInstance({ slotId: 424242, handle: "@nowhere" }), /No Account Slot/);
});
