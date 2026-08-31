// apply_change and Write Receipts (ticket 18).
//
// The last two tests are contract replays of GatewaySim in
// .scratch/marketing-os/prototypes/ai-host-onboarding.html:
//   walkthrough 4 "Two-phase write with approval"
//   walkthrough 5 "Stale & cross-project"
// Each step below is the step from that walkthrough, in order.

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
import { getSnapshot, selectProject } from "../server/gateway";
import {
  applyChange,
  decidePreparedChangeSet,
  getApproval,
  getPreparedChangeSet,
  getReceiptForDigest,
  listWriteReceipts,
  prepareChange,
  type ChangeSet,
} from "../server/project-changes";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type ApplyRequest,
  type ApplyResult,
  type ChangesPage,
  type ProjectDomainImpl,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { stubVerifyAgainstProjects } from "../server/stub-project";

// A writable project domain per mount, each with its own cursor and data,
// so a change to one cannot be mistaken for a change to the other.
interface FakeProject {
  cursor: number;
  version: number;
  brand: Record<string, unknown>;
  applyFails: boolean;
}

function makeProject(): { state: FakeProject; impl: ProjectDomainImpl } {
  const state: FakeProject = {
    cursor: 2,
    version: 1,
    brand: { voice: "plain and factual" },
    applyFails: false,
  };
  return {
    state,
    impl: {
      manifest: () => ({
        name: "test-project",
        contractVersion: PROJECT_CONTRACT_VERSION,
        resources: [...REQUIRED_RESOURCES],
        capabilities: ["apply"],
      }),
      resource(name: RequiredResource): ResourceEnvelope {
        if (name === "brand") {
          return { resource: name, state: "ok", version: state.version, data: state.brand };
        }
        if (name === "write-policy") {
          return {
            resource: name,
            state: "ok",
            version: 1,
            data: {
              operations: ["set_field"],
              editableTargets: ["brand"],
              protectedResources: ["profile"],
            },
          };
        }
        return { resource: name, state: "ok", version: 1, data: {} };
      },
      changes(after: number): ChangesPage {
        const entries = Array.from({ length: Math.max(0, state.cursor - after) }, (_, i) => ({
          cursor: after + i + 1,
          resource: "brand",
          kind: "changed" as const,
        }));
        return { cursor: state.cursor, entries };
      },
      apply({ operations }: ApplyRequest): ApplyResult {
        if (state.applyFails) throw new Error("the project refused the write");
        for (const raw of operations) {
          const op = raw as { path?: string; value?: unknown };
          if (op.path) state.brand[op.path] = op.value;
        }
        state.cursor += 1;
        state.version += 1;
        return {
          applied: operations.length,
          resources: [{ name: "brand", version: state.version }],
          cursor: state.cursor,
        };
      },
      verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
    },
  };
}

const keepAnalog = makeProject();
const partnr = makeProject();
// A project domain with no apply at all: it accepts no writes.
const readOnly = makeProject();
delete (readOnly.impl as { apply?: unknown }).apply;

const app = express();
app.use("/keepanalog", createProjectDomainRouter(keepAnalog.impl));
app.use("/partnr", createProjectDomainRouter(partnr.impl));
app.use("/readonly", createProjectDomainRouter(readOnly.impl));
app.use("/api/approvals", approvalRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "apply-session";
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

function changeSet(summary: string, value = "plain and warm"): ChangeSet {
  return {
    summary,
    operations: [{ op: "set_field", resource: "brand", path: "voice", value }],
  };
}

async function pin(project: string, session = SESSION): Promise<void> {
  assert.equal((await selectProject(session, project)).ok, true);
}

async function prepared(summary: string, session = SESSION): Promise<string> {
  const result = await prepareChange(session, changeSet(summary));
  assert.equal(result.ok, true, JSON.stringify(result.response));
  return (result.response.prepared as { digest: string }).digest;
}

async function approvedDigest(summary: string, session = SESSION): Promise<string> {
  const digest = await prepared(summary, session);
  decidePreparedChangeSet(digest, "approved");
  return digest;
}

test.before(async () => {
  for (const [name, mount] of [
    ["KeepAnalog", "keepanalog"],
    ["partnr", "partnr"],
    ["ReadOnly", "readonly"],
  ] as const) {
    const registered = await registerProject(name, `http://127.0.0.1:${port}/${mount}`, "test");
    assert.equal(registered.project.status, "healthy", `${name} should register healthy`);
  }
  await pin("KeepAnalog");
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: a successful apply returns a receipt and advances the revision

test("a successful apply returns a Write Receipt and advances the snapshot revision", async () => {
  await pin("KeepAnalog");
  const cursorBefore = keepAnalog.state.cursor;
  const digest = await approvedDigest("Sharpen the voice");

  const result = await applyChange(SESSION, { digest });
  assert.equal(result.ok, true, JSON.stringify(result.response));

  const receipt = result.response.writeReceipt as {
    receiptId: string;
    digest: string;
    appliedOperations: number;
    resourceVersions: { name: string; version: number }[];
    nextCursor: number;
  };
  assert.match(receipt.receiptId, /^rcpt-\d+$/);
  assert.equal(receipt.digest, digest);
  assert.equal(receipt.appliedOperations, 1);
  assert.deepEqual(receipt.resourceVersions, [{ name: "brand", version: 2 }]);
  assert.equal(receipt.nextCursor, cursorBefore + 1);

  // The change actually landed in the project.
  assert.equal(keepAnalog.state.brand.voice, "plain and warm");
  // And the revision moved, so the pinned snapshot is now behind.
  assert.equal(keepAnalog.state.cursor, cursorBefore + 1);
  // The session is re-pinned to the revision the apply produced, rather
  // than being left behind for the host to discover on its next call.
  assert.match(String(result.response.note), /pinned to the new revision/);
  assert.equal((result.response.snapshot as { cursor: number }).cursor, receipt.nextCursor);

  const refreshed = await getSnapshot(SESSION);
  assert.equal(refreshed.ok, true);
  assert.equal(
    (refreshed.response.snapshot as { cursor: number }).cursor,
    receipt.nextCursor
  );
});

test("the receipt is a permanent record: one per digest, never rewritten", async () => {
  await pin("KeepAnalog");
  const digest = await approvedDigest("Permanent record");
  assert.equal((await applyChange(SESSION, { digest })).ok, true);

  const receipt = getReceiptForDigest(digest);
  assert.ok(receipt);
  assert.ok(listWriteReceipts().some((r) => r.digest === digest));

  assert.throws(
    () => getDb().prepare("UPDATE write_receipts SET applied_operations = 99 WHERE digest = ?").run(digest),
    /permanent record/
  );
  assert.throws(
    () => getDb().prepare("DELETE FROM write_receipts WHERE digest = ?").run(digest),
    /permanent record/
  );
  // A second receipt for the same digest is impossible at the storage level.
  assert.throws(
    () =>
      getDb()
        .prepare(
          "INSERT INTO write_receipts (digest, project_id, applied_operations, next_cursor) VALUES (?, 1, 1, 1)"
        )
        .run(digest),
    /UNIQUE/
  );
});

// ---------------------------------------------------------------------------
// Criterion 3: approvals are single-use at the storage level

test("an approval is single-use at the storage level, not by convention", async () => {
  await pin("KeepAnalog");
  const digest = await approvedDigest("Single use");
  assert.equal((await applyChange(SESSION, { digest })).ok, true);
  assert.equal(getPreparedChangeSet(digest)?.status, "used");

  // Not "the code checks first": the database refuses to move a consumed
  // approval anywhere at all, so no path can make it appliable again.
  assert.throws(
    () =>
      getDb()
        .prepare("UPDATE project_changes SET status = 'approved' WHERE digest = ?")
        .run(digest),
    /consumed approval cannot be changed/
  );
  assert.throws(
    () => decidePreparedChangeSet(digest, "approved"),
    /already used/
  );

  await pin("KeepAnalog");
  const again = await applyChange(SESSION, { digest });
  assert.equal(again.ok, false);
  assert.equal(again.response.error, "approval_mismatch");
  assert.equal(again.response.message, "This single-use approval was already consumed.");
});

// ---------------------------------------------------------------------------
// Criterion 2: every refusal case

test("applying before approval refuses, and applying a rejected digest refuses", async () => {
  await pin("KeepAnalog");

  const pendingDigest = await prepared("Not approved yet");
  const early = await applyChange(SESSION, { digest: pendingDigest });
  assert.equal(early.ok, false);
  assert.equal(early.response.error, "approval_required");
  assert.equal(early.response.message, `Digest ${pendingDigest} is not approved yet.`);
  assert.equal(early.response.next, "Poll marketingos.get_approval and wait for the Operator.");

  const rejectedDigest = await prepared("Will be rejected");
  decidePreparedChangeSet(rejectedDigest, "rejected");
  const refused = await applyChange(SESSION, { digest: rejectedDigest });
  assert.equal(refused.response.error, "approval_required");
  assert.equal(refused.response.message, "The Operator rejected this digest.");
  assert.equal(refused.response.next, "Revise the change and prepare again.");

  // Neither refusal wrote anything or consumed anything.
  assert.equal(getPreparedChangeSet(pendingDigest)?.status, "pending");
  assert.equal(getReceiptForDigest(pendingDigest), null);
});

test("an unknown digest, and one prepared for another project, both refuse", async () => {
  await pin("KeepAnalog");

  const unknown = await applyChange(SESSION, { digest: "chg-000000000000" });
  assert.equal(unknown.response.error, "approval_mismatch");
  assert.equal(unknown.response.message, "No prepared change with digest chg-000000000000.");
  assert.equal(unknown.response.next, "project.prepare_change first.");

  const digest = await approvedDigest("Belongs to KeepAnalog");

  // The host switches project mid-flight, as walkthrough 5 has it.
  await pin("partnr");
  const crossProject = await applyChange(SESSION, { digest });
  assert.equal(crossProject.ok, false);
  assert.equal(crossProject.response.error, "approval_mismatch");
  // The refusal names where the digest came from as well as where the host
  // is: the origin project is what it needs to recover.
  assert.equal(
    crossProject.response.message,
    `Digest ${digest} was prepared for KeepAnalog, but partnr is selected.`
  );
  assert.equal(
    crossProject.response.next,
    "Select the original project or prepare a new change here."
  );

  // Refused means untouched: still approved, still appliable at home.
  assert.equal(getPreparedChangeSet(digest)?.status, "approved");
  assert.equal(partnr.state.brand.voice, "plain and factual");

  await pin("KeepAnalog");
  assert.equal((await applyChange(SESSION, { digest })).ok, true);

  assert.equal(
    (await applyChange("no-project", { digest })).response.error,
    "no_project_selected"
  );
  assert.equal((await applyChange(SESSION, {})).response.error, "invalid_schema");
});

test("a project that moved after approval refuses the apply, even though it is approved", async () => {
  await pin("KeepAnalog");
  const digest = await approvedDigest("Approved before the world moved");

  // The project ships something upstream.
  keepAnalog.state.cursor += 1;

  const result = await applyChange(SESSION, { digest });
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "stale_snapshot");
  assert.equal(
    result.response.next,
    "project.get_snapshot, recompute, prepare again, get a fresh approval."
  );

  // The approval was not spent on a change nobody can vouch for any more.
  assert.equal(getPreparedChangeSet(digest)?.status, "approved");
  assert.equal(getReceiptForDigest(digest), null);
});

test("a project that cannot apply spends the approval and says so plainly", async () => {
  await pin("KeepAnalog");
  const digest = await approvedDigest("The project will refuse");
  keepAnalog.state.applyFails = true;
  try {
    const result = await applyChange(SESSION, { digest });
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "temporarily_unavailable");
    // It does not claim to know whether the change landed, because from
    // here it cannot: a request that never arrived and one that arrived and
    // then timed out look identical.
    assert.match(String(result.response.message), /This approval is spent/);
    assert.match(String(result.response.message), /whether the change landed is unknown/);
    assert.match(String(result.response.next), /get_snapshot first and read the result/);

    // Spent, and honest about it: better a wasted approval than a change
    // that might have been applied twice.
    assert.equal(getPreparedChangeSet(digest)?.status, "used");
    assert.equal(getReceiptForDigest(digest), null);
  } finally {
    keepAnalog.state.applyFails = false;
  }
});

test("a project domain with no write surface accepts nothing", async () => {
  await pin("ReadOnly");
  const result = await prepareChange(SESSION, changeSet("Nowhere to write"));
  // Its write policy still permits it, so preparation succeeds; the apply
  // is where a project with no write surface says no.
  assert.equal(result.ok, true, JSON.stringify(result.response));
  const digest = (result.response.prepared as { digest: string }).digest;
  decidePreparedChangeSet(digest, "approved");

  const applied = await applyChange(SESSION, { digest });
  assert.equal(applied.ok, false);
  assert.equal(applied.response.error, "temporarily_unavailable");
  assert.match(String(applied.response.message), /does not accept writes/);

  await pin("KeepAnalog");
});

// ---------------------------------------------------------------------------
// Contract replays

test("contract replay, walkthrough 4: prepare, refuse, approve, apply, refuse again", async () => {
  await pin("KeepAnalog");

  // "prepare_change → digest + exact diff"
  const digest = await prepared("Add approved claim");

  // "apply_change now → approval_required"
  const early = await applyChange(SESSION, { digest });
  assert.equal(early.response.error, "approval_required");

  // "get_approval → still pending"
  assert.equal(getApproval(SESSION, { digest }).response.status, "pending");

  // "Operator approves the digest →"
  const approved = await fetch(`http://127.0.0.1:${port}/api/approvals/${digest}/approve`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(approved.status, 200);

  // "get_approval → approved, apply exactly once"
  const status = getApproval(SESSION, { digest });
  assert.equal(status.response.status, "approved");
  assert.equal(status.response.next, `project.apply_change({"digest":"${digest}"}) — exactly once.`);

  // "apply_change → Write Receipt"
  const applied = await applyChange(SESSION, { digest });
  assert.equal(applied.ok, true, JSON.stringify(applied.response));
  assert.ok(applied.response.writeReceipt);

  // "apply_change again → single-use, refused"
  const twice = await applyChange(SESSION, { digest });
  assert.equal(twice.ok, false);
  assert.equal(twice.response.message, "This single-use approval was already consumed.");
  assert.equal(twice.response.next, "Prepare a new change and get a fresh approval.");
});

test("contract replay, walkthrough 5: stale after approval, then cross-project", async () => {
  await pin("KeepAnalog");

  // "prepare_change → digest pending"
  const digest = await prepared("Update profile copy");

  // "KeepAnalog ships a change upstream"
  keepAnalog.state.cursor += 1;

  // "Operator approves anyway"
  decidePreparedChangeSet(digest, "approved");

  // "apply_change → stale_snapshot, blocked"
  const blocked = await applyChange(SESSION, { digest });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.response.error, "stale_snapshot");
  assert.match(String(blocked.response.next), /prepare again, get a fresh approval/);

  // "get_snapshot → fresh pin"
  assert.equal((await getSnapshot(SESSION)).ok, true);

  // "prepare_change again → new digest"
  const recomputed = await prepared("Update profile copy (recomputed)");
  assert.notEqual(recomputed, digest);
  decidePreparedChangeSet(recomputed, "approved");

  // "Host switches to partnr mid-flight"
  await pin("partnr");

  // "apply_change from partnr → approval_mismatch"
  const crossProject = await applyChange(SESSION, { digest: recomputed });
  assert.equal(crossProject.ok, false);
  assert.equal(crossProject.response.error, "approval_mismatch");

  // Nothing merged silently anywhere.
  assert.equal(getReceiptForDigest(recomputed), null);
  assert.equal(getPreparedChangeSet(recomputed)?.status, "approved");
});

// ---------------------------------------------------------------------------
// The Operator sees what actually landed

test("the dashboard shows the Write Receipt against the change it came from", async () => {
  await pin("KeepAnalog");
  const digest = await approvedDigest("Visible receipt");
  assert.equal((await applyChange(SESSION, { digest })).ok, true);

  const res = await fetch(`http://127.0.0.1:${port}/api/approvals`, { headers: { cookie } });
  const body = (await res.json()) as {
    changes: {
      digest: string;
      status: string;
      receipt: { receiptId: string; appliedOperations: number } | null;
    }[];
  };
  const row = body.changes.find((c) => c.digest === digest);
  assert.equal(row?.status, "used");
  assert.equal(row?.receipt?.appliedOperations, 1);

  // An approved change that was never applied has no receipt to show. The
  // apply above moved the project, so re-pin first — which is exactly the
  // recovery the stale refusal names.
  await pin("KeepAnalog");
  const unapplied = await approvedDigest("Approved but never applied");
  const after = await fetch(`http://127.0.0.1:${port}/api/approvals`, { headers: { cookie } });
  const afterBody = (await after.json()) as {
    changes: { digest: string; receipt: unknown }[];
  };
  assert.equal(afterBody.changes.find((c) => c.digest === unapplied)?.receipt, null);
});

// ---------------------------------------------------------------------------
// What the review of this branch turned up

test("apply is idempotent on the digest at the project, so a retry cannot write twice", async () => {
  // MarketingOS consumes the approval before calling apply, and cannot tell
  // a request that never arrived from one that landed and then timed out.
  // The contract closes that window by asking the project to be idempotent
  // on the digest, and the dev stub is.
  const { createStubProjectRouter } = await import("../server/stub-project");
  const stubApp = express();
  stubApp.use("/one", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
  stubApp.use("/two", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
  const stubServer = stubApp.listen(0);
  try {
    const stubPort = (stubServer.address() as AddressInfo).port;
    const token = (await registerProject("StubOne", `http://127.0.0.1:${stubPort}/one`, "test"))
      .token;
    await registerProject("StubTwo", `http://127.0.0.1:${stubPort}/two`, "test");

    const applyTwice = async (): Promise<unknown[]> => {
      const results: unknown[] = [];
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`http://127.0.0.1:${stubPort}/one/apply`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            digest: "chg-retry",
            operations: [
              { op: "set_field", resource: "brand", path: "voice", value: "warmer" },
            ],
          }),
        });
        results.push(await res.json());
      }
      return results;
    };
    const [first, second] = await applyTwice();
    assert.deepEqual(first, second, "the same digest twice is the same result");
    assert.equal((first as { cursor: number }).cursor, 3, "the cursor moved exactly once");

    // And two stub projects are two projects, not one shared blob.
    const other = await fetch(`http://127.0.0.1:${stubPort}/two/resources/brand`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const brand = (await other.json()) as { data: { voice: string }; version: number };
    assert.equal(brand.data.voice, "plain and factual");
    assert.equal(brand.version, 1);
  } finally {
    stubServer.close();
  }
});

test("a project domain answers in its own error shape, even for an oversized change", async () => {
  const oversized = await fetch(`http://127.0.0.1:${port}/keepanalog/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest: "chg-big", operations: [{ pad: "x".repeat(300 * 1024) }] }),
  });
  // Unauthenticated, so the bearer check answers first — and in the
  // contract's shape, which is the point.
  assert.equal(oversized.status, 401);
  const unauthorized = (await oversized.json()) as { error: { code: string } };
  assert.equal(unauthorized.error.code, "invalid_token");
});

test("a project refusal and a project fault are told apart", async () => {
  await pin("KeepAnalog");
  // The stub throws a ProjectError for something its policy forbids, and a
  // plain Error for a fault. They must not look the same to a caller.
  const { createStubProjectRouter } = await import("../server/stub-project");
  const stubApp = express();
  stubApp.use("/refuses", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
  const stubServer = stubApp.listen(0);
  try {
    const stubPort = (stubServer.address() as AddressInfo).port;
    const { token } = await registerProject(
      "StubRefuses",
      `http://127.0.0.1:${stubPort}/refuses`,
      "test"
    );
    const res = await fetch(`http://127.0.0.1:${stubPort}/refuses/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        digest: "chg-refused",
        operations: [{ op: "set_field", resource: "profile", path: "product", value: "x" }],
      }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "protected_target");
    assert.equal(body.error.retryable, false);
  } finally {
    stubServer.close();
  }
});
