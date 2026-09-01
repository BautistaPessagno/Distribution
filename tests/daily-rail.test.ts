// The daily guided rail (ticket 27).
//
// The rail orders the day's real queue and holds back everything but the
// current item. Three things it must never do: invent work, hand over more
// than one thing per step, or file a host's proposed write as something the
// Operator planned.

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
import { addInstance, createSlot, pauseSlot, resumeSlot } from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { composeBrief, dailyRail, pendingInterruptions } from "../server/daily-rail";
import { getDb } from "../server/db";
import { declareExperiment, measureAdHoc } from "../server/experiments";
import { createTarget, releasePiece } from "../server/deliveries";
import { railRouter } from "../server/rail-routes";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";
import { approveOrder, createOrder, submitOrder, type WorkOrder } from "../server/work-orders";

const app = express();
app.use("/dev-stub", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
app.use("/api/rail", railRouter());
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

async function api<T>(pathname: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as T };
}

let seed = 0;
function unique(): number {
  seed += 1;
  return seed;
}

/** A moment inside the shipped default windows, so the clock is not a variable. */
function at(clock: string): Date {
  const [hours, minutes] = clock.split(":").map(Number);
  const when = new Date();
  when.setHours(hours, minutes, 0, 0);
  return when;
}

function filledSlot(label: string): number {
  const slot = createSlot({
    projectId,
    platform: "x",
    label,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
    allowedWindows: [{ start: "00:00", end: "23:59" }],
  });
  addInstance({ slotId: slot.id, handle: `@${label.replace(/\W/g, "").toLowerCase()}` });
  return slot.id;
}

function queuedOrder(overrides: Record<string, unknown> = {}): WorkOrder {
  const created = createOrder({
    projectId,
    kind: "warmup",
    title: `Warm up ${unique()}`,
    instruction: "Read ten posts from the stationery niche",
    ...overrides,
  });
  submitOrder(created.id);
  return approveOrder(created.id);
}

/** Put the day back to nothing due, so each test builds only what it means to. */
function clearQueue(): void {
  const db = getDb();
  db.prepare("DELETE FROM observation_orders").run();
  db.prepare("UPDATE work_orders SET status = 'cancelled'").run();
  db.prepare("UPDATE pieces SET status = 'backlog' WHERE status = 'review'").run();
  db.prepare("UPDATE experiments SET status = 'stopped' WHERE status IN ('predeclared', 'running')").run();
}

/** A Delivery Target, for the rows that have to hang off a real one. */
function deliveryTarget(): number {
  const n = unique();
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'exported', 'snap-1', ?, 1)"
    )
    .run(projectId, `Delivered ${n}`, JSON.stringify({ format: "1:1", slides: [], captions: {} }));
  const pieceId = Number(piece.lastInsertRowid);
  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, 1, 1, ?, ?)"
    )
    .run(pieceId, `data/exports/piece-${pieceId}-v1`, JSON.stringify({ pieceId, n }));
  return createTarget({
    releaseId: releasePiece(pieceId).id,
    slotId: filledSlot(`Delivery slot ${n}`),
    idempotencyKey: `rail-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target.id;
}

test.before(async () => {
  const registered = await registerProject(
    "KeepAnalog",
    `http://127.0.0.1:${port}/dev-stub`,
    "test"
  );
  projectId = registered.project.id;
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: the rail orders real due items, and an empty day says so

test("an empty day says so instead of inventing work", () => {
  clearQueue();
  const rail = dailyRail("positioning", at("10:00"));
  // The brief is real work and the only thing standing: there is a project
  // to brief about.
  assert.deepEqual(rail.steps.map((s) => s.kind), ["send_brief"]);

  // With no project at all, there is nothing whatsoever, and the rail says
  // that rather than filling the screen.
  const db = getDb();
  db.prepare("UPDATE projects SET status = 'unhealthy'").run();
  const bare = dailyRail("positioning", at("10:00"));
  assert.deepEqual(bare.steps, []);
  assert.equal(bare.current, null);
  assert.match(bare.emptyMessage ?? "", /Nothing is due/);
  assert.match(bare.emptyMessage ?? "", /nothing here to invent/);
  db.prepare("UPDATE projects SET status = 'healthy'").run();
});

test("the rail orders brief, drafts, platform work, then readings", () => {
  clearQueue();
  const slotId = filledSlot(`Ordered ${unique()}`);
  queuedOrder({ slotId, title: "Warm-up on the rail" });
  measureAdHoc({
    projectId,
    title: "Ad-hoc reading on the rail",
    instruction: "Read the follower count.",
  });
  getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, 'Draft awaiting review', 'review', 'snap-1', ?, 1)"
    )
    .run(projectId, JSON.stringify({ format: "1:1", slides: [], captions: {} }));

  const rail = dailyRail("positioning", at("10:00"));
  assert.deepEqual(
    rail.steps.map((s) => s.kind),
    ["send_brief", "review_draft", "do_work_order", "record_reading"]
  );
  // Positions are the order, and the current step is the first of them.
  assert.deepEqual(rail.steps.map((s) => s.position), [1, 2, 3, 4]);
  assert.equal(rail.current?.position, 1);
  assert.equal(rail.emptyMessage, null);
});

test("every step hands over exactly one prompt or one instruction", () => {
  const rail = dailyRail("positioning", at("10:00"));
  assert.ok(rail.steps.length > 1);
  for (const step of rail.steps) {
    const handedOver = [step.prompt, step.instruction].filter((v) => v !== null);
    assert.equal(handedOver.length, 1, `step ${step.position} hands over ${handedOver.length} things`);
    assert.ok((handedOver[0] as string).length > 0);
  }
  // Only the brief is a prompt; the rest are plain instructions.
  assert.deepEqual(
    rail.steps.map((s) => (s.prompt === null ? "instruction" : "prompt")),
    ["prompt", "instruction", "instruction", "instruction"]
  );
});

test("work behind a shut queue is not due, and comes back when it opens", () => {
  clearQueue();
  const slotId = filledSlot(`Halted ${unique()}`);
  queuedOrder({ slotId, title: "Behind the kill switch" });
  const workSteps = () =>
    dailyRail("positioning", at("10:00")).steps.filter((s) => s.kind === "do_work_order");

  assert.equal(workSteps().length, 1);
  // The caps and windows of ticket 21 just refused this; the rail does not
  // hand out what the queue would not release.
  pauseSlot(slotId);
  assert.deepEqual(workSteps(), []);
  resumeSlot(slotId);
  assert.equal(workSteps().length, 1);
});

test("a reading is due at the moment its observation point declared, not before", () => {
  clearQueue();
  const declared = declareExperiment({
    projectId,
    name: `Timing ${unique()}`,
    variable: "a question hook versus a claim hook",
    primaryMetric: "saves",
    decisionRule: "Keep the better hook.",
    sampleTarget: 1,
    stopCondition: "One post.",
    observations: [
      { label: "Day two", afterHours: 24, metrics: ["saves"], source: "the analytics tab" },
    ],
  });
  const order = queuedOrder({ kind: "measure", title: "Scheduled reading" });
  const observationId = (
    getDb()
      .prepare("SELECT id FROM experiment_observations WHERE experiment_id = ?")
      .get(declared.id) as { id: number }
  ).id;
  const dueAt = new Date(at("10:00").getTime() + 24 * 3600 * 1000).toISOString();
  getDb()
    .prepare(
      "INSERT INTO observation_orders (experiment_id, observation_id, target_id, order_id, due_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(declared.id, observationId, deliveryTarget(), order.id, dueAt);
  getDb().prepare("UPDATE work_orders SET observation_id = ? WHERE id = ?").run(observationId, order.id);

  const readings = (when: Date) =>
    dailyRail("positioning", when).steps.filter((s) => s.kind === "record_reading");

  assert.deepEqual(readings(at("10:00")), [], "a reading taken early is a reading of something else");
  const later = new Date(new Date(dueAt).getTime() + 60_000);
  const due = readings(later);
  assert.equal(due.length, 1);
  assert.match(due[0].title, /Day two — "Timing/);
});

// ---------------------------------------------------------------------------
// Criterion 2: the prompt composes from live state

test("the brief is composed from live state, not canned text", () => {
  clearQueue();
  const before = dailyRail("positioning", at("10:00")).steps[0].prompt ?? "";
  assert.match(before, /Working on KeepAnalog/);
  assert.match(before, /Method positioning v1, rubric frame-selection\.v1/);
  // The method's own steps, from the library rather than restated here.
  assert.match(before, /Generate candidate frames and reject the weak ones with reasons/);
  assert.match(before, /No experiment is running/);

  const declared = declareExperiment({
    projectId,
    name: `Live state ${unique()}`,
    variable: "the first line: a question versus a claim",
    primaryMetric: "saves per impression",
    decisionRule: "Keep the better hook.",
    sampleTarget: 6,
    stopCondition: "Six delivered posts.",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["saves"], source: "the analytics tab" },
    ],
  });

  const after = dailyRail("positioning", at("10:00")).steps[0].prompt ?? "";
  assert.notEqual(after, before, "the prompt did not move when the state did");
  assert.match(after, new RegExp(`"${declared.name}"`));
  assert.match(after, /varying the first line: a question versus a claim/);
  assert.match(after, /primary metric saves per impression; 6 posts/);
  assert.match(after, /stops when Six delivered posts/);
  assert.match(after, /Do not restate or reinterpret those declarations/);
});

test("the brief changes with the goal it was asked for", () => {
  const positioning = dailyRail("positioning", at("10:00")).steps[0].prompt ?? "";
  const other = dailyRail("content-strategy", at("10:00")).steps[0].prompt ?? "";
  assert.notEqual(other, positioning);
  assert.match(other, /Goal: content-strategy/);
});

test("the brief names the pinned snapshot, and says so when there is none", () => {
  const withSnapshot = composeBrief({
    projectId,
    projectName: "KeepAnalog",
    snapshotId: "snap-42",
    goal: "positioning",
    openExperiments: [],
  });
  assert.match(withSnapshot, /pinned Project Snapshot snap-42/);

  const without = composeBrief({
    projectId,
    projectName: "KeepAnalog",
    snapshotId: null,
    goal: "positioning",
    openExperiments: [],
  });
  assert.match(without, /No Project Snapshot is pinned yet/);
  assert.match(without, /marketingos\.select_project/);
});

test("the brief tells the host it never applies a write", () => {
  const prompt = dailyRail("positioning", at("10:00")).steps[0].prompt ?? "";
  assert.match(prompt, /You never apply one; the diff comes to me and I approve it/);
});

// ---------------------------------------------------------------------------
// Criterion 3: a pending digest interrupts without becoming a step

test("a pending digest interrupts without becoming a numbered step", () => {
  clearQueue();
  const before = dailyRail("positioning", at("10:00"));
  assert.deepEqual(before.interruptions, []);

  getDb()
    .prepare(
      `INSERT INTO project_changes (digest, project_id, snapshot_id, cursor, summary, change_set, diff)
       VALUES ('digest-abc', ?, 'snap-1', 1, 'Tighten the hero line', ?, '[]')`
    )
    .run(projectId, JSON.stringify({ operations: [{ op: "set_field" }, { op: "set_field" }] }));

  const rail = dailyRail("positioning", at("10:00"));
  assert.equal(rail.interruptions.length, 1);
  assert.deepEqual(
    {
      digest: rail.interruptions[0].digest,
      project: rail.interruptions[0].projectName,
      operations: rail.interruptions[0].operations,
    },
    { digest: "digest-abc", project: "KeepAnalog", operations: 2 }
  );
  assert.match(rail.interruptions[0].why, /rail is exactly where you left it/);

  // And the rail itself did not move: no step gained, none renumbered.
  assert.deepEqual(
    rail.steps.map((s) => [s.position, s.kind]),
    before.steps.map((s) => [s.position, s.kind])
  );
  assert.equal(rail.steps.some((s) => s.subject.kind === "change"), false);
  assert.equal(rail.current?.kind, before.current?.kind);
});

test("a decided digest stops interrupting", () => {
  getDb().prepare("UPDATE project_changes SET status = 'approved' WHERE digest = 'digest-abc'").run();
  assert.deepEqual(pendingInterruptions(), []);
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the Operator reads the rail over HTTP, for a goal the library has", async () => {
  const res = await api<{
    rail: { steps: { kind: string }[]; note: string };
    goals: string[];
  }>("/api/rail?goal=positioning");
  assert.equal(res.status, 200);
  assert.equal(res.body.rail.steps[0].kind, "send_brief");
  assert.match(res.body.rail.note, /One step at a time, from what is actually due/);
  assert.ok(res.body.goals.includes("positioning"));

  const unknown = await api<{ error: string; detail: string[] }>("/api/rail?goal=vibes");
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /is not a goal the Method Library has/);
  assert.ok(unknown.body.detail.length > 0);
});

test("the rail needs a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/rail")).status, 401);
  cookie = saved;
});
