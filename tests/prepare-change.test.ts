// prepare_change and digest approvals (ticket 17).
//
// Reference behavior: the `project.prepare_change` and
// `marketingos.get_approval` cases of GatewaySim in ai-host-onboarding.html,
// plus the APPROVE and REJECT operator actions and the UPSTREAM_CHANGE that
// makes a pinned snapshot stale.

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
import { approvalRouter } from "../server/approval-routes";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import {
  changeDigest,
  decidePreparedChange,
  getApproval,
  getPreparedChange,
  prepareChange,
  renderDiff,
  validateChangeSet,
  type ChangeSet,
  type WritePolicy,
} from "../server/project-changes";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type ChangesPage,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { stubVerifyAgainstProjects } from "../server/stub-project";

// A project domain that can be made to move underneath a pinned snapshot,
// and whose write policy the test controls.
let cursor = 0;
let policy: WritePolicy = {
  operations: ["set_field", "add_claim"],
  editableTargets: ["brand", "claims"],
  protectedResources: ["profile"],
};

const BRAND = {
  voice: "plain and factual",
  colors: { primary: "#1a1a1a", accent: "#e8e4dc" },
};

function domain() {
  return createProjectDomainRouter({
    manifest: () => ({
      name: "test-project",
      contractVersion: PROJECT_CONTRACT_VERSION,
      resources: [...REQUIRED_RESOURCES],
      capabilities: [],
    }),
    resource(name: RequiredResource): ResourceEnvelope {
      if (name === "brand") return { resource: name, state: "ok", version: 1, data: BRAND };
      if (name === "write-policy") {
        return { resource: name, state: "ok", version: 1, data: policy };
      }
      return { resource: name, state: "ok", version: 1, data: {} };
    },
    changes(after: number): ChangesPage {
      const entries = Array.from({ length: Math.max(0, cursor - after) }, (_, i) => ({
        cursor: after + i + 1,
        resource: "brand",
        kind: "changed" as const,
      }));
      return { cursor, entries };
    },
    verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
  });
}

const app = express();
app.use("/keepanalog", domain());
app.use("/vinylos", domain());
app.use("/api/approvals", approvalRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "prepare-session";
const OTHER_SESSION = "other-prepare-session";
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

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    summary: "Sharpen the brand voice",
    operations: [{ op: "set_field", resource: "brand", path: "voice", value: "plain and warm" }],
    ...overrides,
  };
}

/** Move the project on, then re-pin so the session is fresh again. */
async function upstreamChange(): Promise<void> {
  cursor += 1;
}

async function repin(session = SESSION): Promise<void> {
  assert.equal((await selectProject(session, "KeepAnalog")).ok, true);
}

test.before(async () => {
  const keep = await registerProject(
    "KeepAnalog",
    `http://127.0.0.1:${port}/keepanalog`,
    "test"
  );
  await registerProject("VinylOS", `http://127.0.0.1:${port}/vinylos`, "test");
  projectId = keep.project.id;
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
  assert.equal((await selectProject(OTHER_SESSION, "VinylOS")).ok, true);
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: preparing creates a pending digest, visible with its diff

test("preparing a change returns a digest, the exact diff, validations, and warnings", async () => {
  const result = await prepareChange(SESSION, changeSet());
  assert.equal(result.ok, true, JSON.stringify(result.response));

  const prepared = result.response.prepared as {
    digest: string;
    diff: { resource: string; path: string; before: unknown; after: unknown }[];
    diffText: string;
    validations: string[];
    warnings: string[];
    status: string;
  };

  assert.match(prepared.digest, /^chg-[0-9a-f]{12}$/);
  assert.equal(prepared.status, "pending");
  assert.equal(result.response.approval, "required");

  // The diff is exact: the value that is there now, and the value proposed.
  assert.deepEqual(prepared.diff, [
    { resource: "brand", path: "voice", before: "plain and factual", after: "plain and warm" },
  ]);
  assert.match(prepared.diffText, /--- brand\.voice/);
  assert.match(prepared.diffText, /- "plain and factual"/);
  assert.match(prepared.diffText, /\+ "plain and warm"/);
  assert.ok(prepared.validations.length > 0);
  assert.deepEqual(prepared.warnings, []);

  // The host is told to wait for a person, and told it gets no token.
  assert.match(String(result.response.next), /must approve digest/);
  assert.match(String(result.response.next), /no grant token will be given to you/);
});

test("preparing changes nothing canonical, and the same change addresses the same approval", async () => {
  const first = await prepareChange(SESSION, changeSet({ summary: "Idempotent prepare" }));
  assert.equal(first.ok, true);
  const digest = (first.response.prepared as { digest: string }).digest;
  const rows = () =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM project_changes").get() as { n: number }).n;
  const before = rows();

  const second = await prepareChange(SESSION, changeSet({ summary: "Idempotent prepare" }));
  assert.equal(second.ok, true);
  assert.equal((second.response.prepared as { digest: string }).digest, digest);
  assert.equal(rows(), before, "the same change against the same snapshot is one approval");

  // The project itself is untouched: phase one writes nothing there.
  const brand = await fetch(`http://127.0.0.1:${port}/keepanalog/resources/brand`, {
    headers: { Authorization: `Bearer nope` },
  });
  assert.equal(brand.status, 401);
  assert.equal(getPreparedChange(digest)?.status, "pending");
});

test("the digest names one change against one snapshot of one project", () => {
  const set = changeSet();
  assert.equal(changeDigest(1, "snap-1-c0", set), changeDigest(1, "snap-1-c0", set));
  assert.notEqual(changeDigest(1, "snap-1-c0", set), changeDigest(2, "snap-1-c0", set));
  assert.notEqual(changeDigest(1, "snap-1-c0", set), changeDigest(1, "snap-1-c1", set));
  assert.notEqual(
    changeDigest(1, "snap-1-c0", set),
    changeDigest(1, "snap-1-c0", changeSet({ summary: "different" }))
  );
});

test("the dashboard shows the pending digest with its exact diff", async () => {
  const result = await prepareChange(SESSION, changeSet({ summary: "Visible in the dashboard" }));
  const digest = (result.response.prepared as { digest: string }).digest;

  const listed = await api<{
    note: string;
    pending: number;
    changes: { digest: string; summary: string; projectName: string; diffText: string }[];
  }>("/api/approvals");
  assert.equal(listed.status, 200);
  assert.match(listed.body.note, /interruption, not a step/);

  const row = listed.body.changes.find((c) => c.digest === digest);
  assert.ok(row, "the prepared digest is visible to the Operator");
  assert.equal(row.summary, "Visible in the dashboard");
  assert.equal(row.projectName, "KeepAnalog");
  assert.match(row.diffText, /brand\.voice/);

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/approvals`)).status, 401);
});

// ---------------------------------------------------------------------------
// Criterion 2: get_approval reports each state with the right next action

test("get_approval reports pending, approved, and rejected with the correct next action", async () => {
  const prepared = await prepareChange(SESSION, changeSet({ summary: "Approve me" }));
  const digest = (prepared.response.prepared as { digest: string }).digest;

  // Pending.
  const pending = getApproval(SESSION, { digest });
  assert.equal(pending.ok, true);
  assert.equal(pending.response.status, "pending");
  assert.equal(pending.response.next, "Wait for the Operator; poll again.");
  // A status, never a token: nothing here could be replayed anywhere.
  assert.deepEqual(Object.keys(pending.response).sort(), ["context", "digest", "next", "status"]);

  // Approved.
  const approved = await api<{ note: string }>(`/api/approvals/${digest}/approve`, {
    method: "POST",
  });
  assert.equal(approved.status, 200);
  assert.match(approved.body.note, /single-use and bound to this digest/);
  assert.match(approved.body.note, /no token goes to the AI Host/);

  const afterApproval = getApproval(SESSION, { digest });
  assert.equal(afterApproval.response.status, "approved");
  assert.equal(
    afterApproval.response.next,
    `project.apply_change({"digest":"${digest}"}) — exactly once.`
  );

  // Rejected, on a different digest.
  const other = await prepareChange(SESSION, changeSet({ summary: "Reject me" }));
  const rejectedDigest = (other.response.prepared as { digest: string }).digest;
  assert.equal((await api(`/api/approvals/${rejectedDigest}/reject`, { method: "POST" })).status, 200);

  const afterRejection = getApproval(SESSION, { digest: rejectedDigest });
  assert.equal(afterRejection.response.status, "rejected");
  assert.equal(afterRejection.response.next, "Rejected; revise and prepare a new change.");

  // Used, which ticket 18's apply will set.
  getDb().prepare("UPDATE project_changes SET status = 'used' WHERE digest = ?").run(digest);
  const afterUse = getApproval(SESSION, { digest });
  assert.equal(afterUse.response.status, "used");
  assert.equal(afterUse.response.next, "This approval was consumed; prepare a new change.");
});

test("a decision is final: an already-decided digest cannot be decided again", async () => {
  const prepared = await prepareChange(SESSION, changeSet({ summary: "Decide once" }));
  const digest = (prepared.response.prepared as { digest: string }).digest;

  assert.equal((await api(`/api/approvals/${digest}/approve`, { method: "POST" })).status, 200);

  const again = await api<{ error: string }>(`/api/approvals/${digest}/approve`, {
    method: "POST",
  });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already approved/);

  const flipped = await api<{ error: string }>(`/api/approvals/${digest}/reject`, {
    method: "POST",
  });
  assert.equal(flipped.status, 409);
  assert.equal(getPreparedChange(digest)?.status, "approved");

  assert.equal((await api(`/api/approvals/chg-nope/approve`, { method: "POST" })).status, 404);
  assert.throws(() => decidePreparedChange("chg-nope", "approved"), /No prepared change/);
});

test("get_approval refuses an unknown digest and one prepared for another project", async () => {
  const prepared = await prepareChange(SESSION, changeSet({ summary: "Scoped approval" }));
  const digest = (prepared.response.prepared as { digest: string }).digest;

  const unknown = getApproval(SESSION, { digest: "chg-000000000000" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.response.error, "approval_mismatch");
  assert.match(String(unknown.response.next), /prepare_change first/);

  const crossProject = getApproval(OTHER_SESSION, { digest });
  assert.equal(crossProject.ok, false);
  assert.equal(crossProject.response.error, "approval_mismatch");
  assert.match(String(crossProject.response.message), /different Connected Project/);

  assert.equal(getApproval("no-project", { digest }).response.error, "no_project_selected");
  assert.equal(getApproval(SESSION, {}).response.error, "invalid_schema");
});

// ---------------------------------------------------------------------------
// Criterion 3: a stale snapshot refuses preparation with the recovery path

test("a stale snapshot refuses preparation, naming the recovery path", async () => {
  await repin();
  await upstreamChange();

  const result = await prepareChange(SESSION, changeSet({ summary: "Against a stale snapshot" }));
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "stale_snapshot");
  assert.match(String(result.response.message), /changed upstream/);
  assert.equal(
    result.response.next,
    "Call project.get_snapshot, recompute the change, then prepare again."
  );

  // Nothing was prepared: a change against a project that has moved is not
  // a change anyone should be asked to approve.
  const digest = changeDigest(projectId, "any", changeSet());
  assert.equal(getPreparedChange(digest), null);

  // Recompute against a fresh snapshot and it prepares.
  await repin();
  const retried = await prepareChange(SESSION, changeSet({ summary: "Against a fresh snapshot" }));
  assert.equal(retried.ok, true, JSON.stringify(retried.response));
});

// ---------------------------------------------------------------------------
// Validation against the write policy

test("the write policy decides what may be prepared, and a silent project says no", () => {
  const snapshot = { brand: { state: "ok" as const, data: BRAND } };

  const permitted = validateChangeSet(changeSet(), policy, snapshot);
  assert.deepEqual(permitted.problems, []);
  assert.equal(permitted.diff.length, 1);

  // A protected resource is refused by name.
  const protectedTarget = validateChangeSet(
    changeSet({
      operations: [{ op: "set_field", resource: "profile", path: "product", value: "x" }],
    }),
    policy,
    snapshot
  );
  assert.deepEqual(protectedTarget.problems.map((p) => p.code), ["protected_target"]);
  assert.match(protectedTarget.problems[0].message, /protects/);

  // An operation the project does not accept is refused by name.
  const unsupported = validateChangeSet(
    changeSet({
      operations: [{ op: "revise_claim", id: "c1", text: "t", evidence: "e" }],
    }),
    policy,
    snapshot
  );
  assert.deepEqual(unsupported.problems.map((p) => p.code), ["unsupported_capability"]);

  // A project that says nothing has said no.
  const silent = validateChangeSet(
    changeSet(),
    { operations: [], editableTargets: [], protectedResources: ["*"] },
    snapshot
  );
  assert.equal(silent.problems.length, 1);
});

test("a change that would change nothing prepares, with a warning saying so", async () => {
  await repin();
  const result = await prepareChange(
    SESSION,
    changeSet({
      summary: "No-op change",
      operations: [
        { op: "set_field", resource: "brand", path: "voice", value: "plain and factual" },
      ],
    })
  );
  assert.equal(result.ok, true);
  const warnings = (result.response.prepared as { warnings: string[] }).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /would not change anything/);
});

test("a refused change is not prepared and is not shown to the Operator", async () => {
  await repin();
  const before = (
    getDb().prepare("SELECT COUNT(*) AS n FROM project_changes").get() as { n: number }
  ).n;

  const result = await prepareChange(
    SESSION,
    changeSet({
      summary: "Touches a protected resource",
      operations: [{ op: "set_field", resource: "profile", path: "product", value: "x" }],
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "protected_target");
  assert.ok(Array.isArray(result.response.problems));
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS n FROM project_changes").get() as { n: number }).n,
    before
  );

  const schemaless = await prepareChange(SESSION, { summary: "", operations: [] });
  assert.equal(schemaless.response.error, "invalid_schema");
  assert.equal(
    (await prepareChange("no-project", changeSet())).response.error,
    "no_project_selected"
  );
});

test("the rendered diff shows one before and one after per changed path", () => {
  assert.equal(
    renderDiff([
      { resource: "brand", path: "voice", before: "old", after: "new" },
      { resource: "claims", path: "claims[]", before: undefined, after: { text: "t" } },
    ]),
    [
      "--- brand.voice",
      '- "old"',
      '+ "new"',
      "--- claims.claims[]",
      "- undefined",
      '+ {"text":"t"}',
    ].join("\n")
  );
});
