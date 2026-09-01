// The first-run setup rail (ticket 26).
//
// The shape is the feature: one step on screen, each step one action, and
// nothing in the whole rail that writes to a Connected Project.

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
delete process.env.PUBLIC_URL;

import express from "express";
import { createSlot } from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { mintStaticHostToken } from "../server/host-auth";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import {
  connectorInstruction,
  resumeStep,
  SETUP_STEPS,
  setupRail,
  skipStep,
} from "../server/setup-rail";
import { setupRouter } from "../server/setup-routes";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";

const app = express();
app.use("/dev-stub", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
app.use("/api/setup", setupRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

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

async function api<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Every table a write to a Connected Project would have to leave a mark in. */
function projectWriteTraces(): Record<string, number> {
  const db = getDb();
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    preparedChanges: count("project_changes"),
    writeReceipts: count("write_receipts"),
    writeAudits: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'changes.%' OR action LIKE 'receipts.%' OR action LIKE 'approvals.%'"
        )
        .get() as { n: number }
    ).n,
  };
}

test.before(() => {
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: a fresh workspace walks the three steps

test("a fresh workspace shows one step, and only the first", () => {
  const rail = setupRail();
  assert.equal(rail.complete, false);
  assert.equal(rail.current?.step, "connect_project");
  assert.equal(rail.current?.position, 1);
  // The rail knows all three, but exactly one is the one to do.
  assert.deepEqual(rail.steps.map((s) => s.step), [...SETUP_STEPS]);
  assert.deepEqual(rail.steps.map((s) => s.done), [false, false, false]);
  // Each step is one action, not a list of things to consider.
  for (const step of rail.steps) {
    assert.ok(step.action.length > 0);
    assert.equal(step.action.split(". ").length, 1, `"${step.action}" is more than one action`);
  }
});

test("the rail walks the three steps to a connected, slot-holding state", async () => {
  // Step one.
  const registered = await registerProject(
    "KeepAnalog",
    `http://127.0.0.1:${port}/dev-stub`,
    "test"
  );
  let rail = setupRail();
  assert.equal(rail.steps[0].done, true);
  assert.match(rail.steps[0].doneDetail ?? "", /Connected: KeepAnalog/);
  assert.equal(rail.current?.step, "connect_host");

  // Step two.
  await mintStaticHostToken("Claude Desktop", "operator");
  rail = setupRail();
  assert.equal(rail.steps[1].done, true);
  assert.match(rail.steps[1].doneDetail ?? "", /Claude Desktop/);
  assert.equal(rail.current?.step, "create_slot");

  // Step three.
  createSlot({
    projectId: registered.project.id,
    platform: "x",
    label: "KeepAnalog on X",
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });
  rail = setupRail();
  assert.equal(rail.steps[2].done, true);
  assert.match(rail.steps[2].doneDetail ?? "", /KeepAnalog on X \(x\)/);

  // Nothing left on screen, and the done screen says what setup did not do.
  assert.equal(rail.current, null);
  assert.equal(rail.complete, true);
  assert.match(rail.doneMessage, /changed nothing in your project/);
  assert.match(rail.doneMessage, /without you seeing the exact diff and approving it/);
  assert.match(rail.doneMessage, /hands you one thing at a time/);
});

test("the host step hands over one copyable instruction, built from where the server is", () => {
  const rail = setupRail("https://marketingos.example.com/");
  const host = rail.steps.find((s) => s.step === "connect_host")!;
  assert.match(host.copyable ?? "", /https:\/\/marketingos\.example\.com\/mcp/);
  assert.match(host.copyable ?? "", /marketingos\.onboard/);
  // Only that step has something to copy; the others are one action each.
  assert.deepEqual(
    rail.steps.map((s) => s.copyable === null),
    [true, false, true]
  );
  assert.match(connectorInstruction(), /http:\/\/localhost:3000\/mcp/);
});

// ---------------------------------------------------------------------------
// Criterion 2: no step performs or requests a project write

test("no step of the rail performs or requests a write to a Connected Project", async () => {
  const before = projectWriteTraces();

  // Walk the whole rail through its own surface, including both skip moves.
  const read = await api<{ rail: { steps: { writesToProject: boolean }[]; note: string } }>(
    "/api/setup"
  );
  assert.equal(read.status, 200);
  for (const step of read.body.rail.steps) {
    assert.equal(step.writesToProject, false);
  }
  assert.match(read.body.rail.note, /No step of setup performs or requests a write/);

  await api("/api/setup/create_slot/skip", { method: "POST" });
  await api("/api/setup/create_slot/resume", { method: "POST" });

  // Nothing anywhere behind it: no prepared change, no approval, no receipt.
  assert.deepEqual(projectWriteTraces(), before);
  assert.deepEqual(before, { preparedChanges: 0, writeReceipts: 0, writeAudits: 0 });
});

test("the setup surface has no route that could write to a project", async () => {
  for (const path of ["/api/setup/apply", "/api/setup/changes", "/api/setup/connect_project/apply"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 404, `${path} answered ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Criterion 3: skipping is possible and visibly resumable

test("a skipped step is passed over, stays visible, and resumes in place", () => {
  // Start from a rail with nothing done, by clearing what the other tests
  // built — this test is about ordering, not about state elsewhere.
  const db = getDb();
  db.prepare("DELETE FROM account_slots").run();

  let rail = setupRail();
  assert.equal(rail.current?.step, "create_slot");

  rail = skipStep("create_slot");
  // Passed over: nothing is on screen, because there is nothing left to do.
  assert.equal(rail.current, null);
  assert.equal(rail.complete, false, "a skipped step is not a finished one");

  // Still visible, and named as skipped rather than gone.
  const skippedStep = rail.steps.find((s) => s.step === "create_slot")!;
  assert.equal(skippedStep.skipped, true);
  assert.match(skippedStep.skippedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rail.skipped, ["create_slot"]);
  assert.equal(rail.steps.length, 3, "a skipped step is not removed from the rail");

  // And one action brings it back, in its own place in the order.
  rail = resumeStep("create_slot");
  assert.equal(rail.current?.step, "create_slot");
  assert.equal(rail.current?.position, 3);
  assert.deepEqual(rail.skipped, []);
});

test("resuming a step nobody skipped says so, and an unknown step is not a step", () => {
  assert.throws(() => resumeStep("create_slot"), /was not skipped/);
  assert.throws(() => skipStep("connect_the_dots"), /There is no "connect_the_dots" step/);
});

test("a step that got done stops counting as skipped", async () => {
  skipStep("create_slot");
  assert.equal(setupRail().steps[2].skipped, true);

  const project = (
    getDb().prepare("SELECT id FROM projects LIMIT 1").get() as { id: number }
  ).id;
  createSlot({
    projectId: project,
    platform: "tiktok",
    label: "Resumed by doing it",
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });

  const rail = setupRail();
  assert.deepEqual(
    { done: rail.steps[2].done, skipped: rail.steps[2].skipped },
    { done: true, skipped: false }
  );
  assert.equal(rail.complete, true);
});

test("the setup routes need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/setup")).status, 401);
  assert.equal((await api("/api/setup/create_slot/skip", { method: "POST" })).status, 401);
  cookie = saved;
});
