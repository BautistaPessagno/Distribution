// Decision records and the learning log (ticket 25).
//
// Decisions under test:
//   docs/issues/marketing-os/issues/13-define-measurement-learning-loop.md
//     — an experiment concludes at its stop condition and nowhere earlier;
//       every conclusion carries its ladder rung and its ceiling; funnel
//       movements are correlations and never proof

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
import { addInstance, createSlot } from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import {
  concludeWithDecision,
  correlationsFor,
  getDecisionFor,
  highestRungAvailable,
  learningLog,
  learningLogView,
  sampleState,
} from "../server/decisions";
import {
  acknowledgeDisclosure,
  createTarget,
  disclosureChecklist,
  markPosting,
  releasePiece,
  releaseToOperator,
  submitDeliveryProof,
} from "../server/deliveries";
import {
  declareExperiment,
  enrollDelivery,
  getExperimentById,
  verifyAndObserve,
  type Experiment,
} from "../server/experiments";
import { experimentRouter } from "../server/experiment-routes";
import { selectProject } from "../server/gateway";
import { recordPieceOutcome } from "../server/piece-lifecycle";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";
import { completeMeasureOrder, readProjectFunnel } from "../server/snapshots";
import { beginReview, claimOrder, startOrder, submitProof } from "../server/work-orders";

const app = express();
app.use("/dev-stub", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
app.use("/api/experiments", experimentRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const HOST_SESSION = "decision-host-session";
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

async function api<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

let seed = 0;
function unique(): number {
  seed += 1;
  return seed;
}

function insideWindow(): Date {
  const when = new Date();
  when.setHours(10, 0, 0, 0);
  return when;
}

function experiment(overrides: Record<string, unknown> = {}): Experiment {
  return declareExperiment({
    projectId,
    name: `Experiment ${unique()}`,
    variable: "a question hook versus a claim hook",
    primaryMetric: "saves",
    decisionRule: "Keep the hook whose saves beat the other by 20% across the sample.",
    sampleTarget: 2,
    stopCondition: "Stop at 2 delivered posts.",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["saves"], source: "the post's analytics tab" },
    ],
    ...overrides,
  });
}

/** A delivery verified posted and enrolled in the experiment. */
function deliver(experimentId: number): { targetId: number; orderIds: number[] } {
  const n = unique();
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'exported', 'snap', '{}', 1)"
    )
    .run(projectId, `Carousel ${n}`);
  const pieceId = Number(piece.lastInsertRowid);
  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, 1, 1, ?, ?)"
    )
    .run(pieceId, `data/exports/piece-${pieceId}-v1`, JSON.stringify({ pieceId, n }));

  const release = releasePiece(pieceId);
  const slot = createSlot({
    projectId,
    platform: "x",
    label: `Slot ${n}`,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });
  addInstance({ slotId: slot.id, handle: `@slot${n}` });
  const target = createTarget({
    releaseId: release.id,
    slotId: slot.id,
    idempotencyKey: `decision-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target;
  for (const item of disclosureChecklist(target)) acknowledgeDisclosure(target.id, item.rule);

  const { order } = releaseToOperator(target.id);
  markPosting(target.id);
  const permalink = `https://x.com/keepanalog/status/${3000000 + n}`;
  submitDeliveryProof(target.id, permalink);
  claimOrder(order.id, "operator", insideWindow());
  startOrder(order.id);
  submitProof({ orderId: order.id, proof: permalink });

  enrollDelivery(experimentId, target.id);
  const scheduled = verifyAndObserve(target.id).scheduled;
  return { targetId: target.id, orderIds: scheduled.map((s) => s.orderId) };
}

/** File the numbers for every observation order a delivery earned. */
function read(orderIds: number[], value: number): void {
  for (const orderId of orderIds) {
    claimOrder(orderId, "operator", insideWindow());
    startOrder(orderId);
    submitProof({ orderId, proof: "Read off the analytics tab." });
    beginReview(orderId);
    completeMeasureOrder(orderId, [{ metric: "saves", value }]);
  }
}

/** An experiment with its full predeclared sample delivered and read. */
function readyToConclude(overrides: Record<string, unknown> = {}): Experiment {
  const declared = experiment(overrides);
  for (const value of [40, 62]) {
    read(deliver(declared.id).orderIds, value);
  }
  return declared;
}

function conclusion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: "repeat",
    supports:
      "The question hook took more saves than the claim hook across both delivered posts.",
    doesNotSupport:
      "Nothing about reach, about other platforms, or about whether the effect holds past two posts.",
    ladderRung: "controlled_experiment",
    cheapestNextObservation: "Run the same two hooks on the other account, at the same hour.",
    stopConditionMet: "Both predeclared posts went up and were read at the one-hour point.",
    ...overrides,
  };
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
// Criterion 1: no winner before the predeclared sample and stop condition

test("no winner is declared before the predeclared sample is delivered", () => {
  const declared = experiment({ name: "Too early" });
  const first = deliver(declared.id);
  read(first.orderIds, 55);
  assert.deepEqual(sampleState(declared), { target: 2, delivered: 1, short: 1, met: false });

  assert.throws(
    () => concludeWithDecision(declared.id, conclusion()),
    (err: Error) => {
      assert.match(err.message, /predeclared a sample of 2 and 1 have been delivered/);
      assert.match(err.message, /No winner is declared 1 short of the sample/);
      return true;
    }
  );
  assert.equal(getDecisionFor(declared.id), null);
  assert.equal(getExperimentById(declared.id)?.status, "running");

  // The second delivery is what opens the door, not the passage of time.
  read(deliver(declared.id).orderIds, 71);
  assert.equal(sampleState(getExperimentById(declared.id)!).met, true);
  assert.equal(concludeWithDecision(declared.id, conclusion()).record.decision, "repeat");
});

test("an enrolled delivery that never went up is not sample", () => {
  const declared = experiment({ name: "Not delivered", sampleTarget: 1, stopCondition: "One." });

  // Enrolled while still sitting in the queue: the delivery exists and has
  // told us nothing, so it counts for nothing.
  const parked = queuedDelivery();
  enrollDelivery(declared.id, parked);
  assert.deepEqual(sampleState(getExperimentById(declared.id)!), {
    target: 1,
    delivered: 0,
    short: 1,
    met: false,
  });
  assert.throws(() => concludeWithDecision(declared.id, conclusion()), /No winner is declared 1 short/);

  // The same delivery, once it has actually gone up, is sample.
  read(deliver(declared.id).orderIds, 44);
  assert.equal(sampleState(getExperimentById(declared.id)!).delivered, 1);
});

/** A delivery that exists and is still waiting to be published. */
function queuedDelivery(): number {
  const n = unique();
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'exported', 'snap', '{}', 1)"
    )
    .run(projectId, `Parked ${n}`);
  const pieceId = Number(piece.lastInsertRowid);
  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, 1, 1, ?, ?)"
    )
    .run(pieceId, `data/exports/parked-${pieceId}`, JSON.stringify({ pieceId, n }));
  const slot = createSlot({
    projectId,
    platform: "x",
    label: `Parked slot ${n}`,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });
  addInstance({ slotId: slot.id, handle: `@parked${n}` });
  return createTarget({
    releaseId: releasePiece(pieceId).id,
    slotId: slot.id,
    idempotencyKey: `parked-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target.id;
}

test("a conclusion states all of it or none of it", () => {
  const declared = readyToConclude({ name: "Whole assessment" });
  const full = conclusion();
  for (const missing of [
    "decision",
    "supports",
    "doesNotSupport",
    "ladderRung",
    "cheapestNextObservation",
    "stopConditionMet",
  ]) {
    const partial = { ...full };
    delete partial[missing];
    assert.throws(
      () => concludeWithDecision(declared.id, partial),
      /states all of it or none of it/,
      `a conclusion missing ${missing} was accepted`
    );
  }
  assert.equal(getDecisionFor(declared.id), null);
});

test("the stop condition has to be said to have been met, in words", () => {
  const declared = readyToConclude({ name: "Stop condition" });
  assert.throws(
    () => concludeWithDecision(declared.id, conclusion({ stopConditionMet: "" })),
    /how the predeclared stop condition was met/
  );
});

test("a conclusion is what was believed at the time and is not revised", () => {
  const declared = readyToConclude({ name: "Not revised" });
  const { record } = concludeWithDecision(declared.id, conclusion());
  assert.throws(
    () => concludeWithDecision(declared.id, conclusion({ decision: "stop" })),
    /already concluded.*is not revised/s
  );
  const db = getDb();
  assert.throws(
    () => db.prepare("UPDATE decision_records SET decision = 'stop' WHERE id = ?").run(record.id),
    /what was believed at the time; it is not revised/
  );
  assert.throws(
    () => db.prepare("DELETE FROM decision_records WHERE id = ?").run(record.id),
    /permanent/
  );
});

// ---------------------------------------------------------------------------
// Criterion 2: every conclusion carries its rung; funnel movements are
// labelled correlated

test("the ladder rung is enforced, not claimed", () => {
  // Read nothing on the posts: whatever moved, moved alongside.
  const unread = experiment({ name: "Nothing read", sampleTarget: 1, stopCondition: "One post." });
  deliver(unread.id);
  const available = highestRungAvailable(getExperimentById(unread.id)!);
  assert.equal(available.rung, "correlated_observation");
  assert.match(available.why, /Nothing was read for "saves" on the posts themselves/);

  assert.throws(
    () => concludeWithDecision(unread.id, conclusion({ ladderRung: "controlled_experiment" })),
    (err: Error) => {
      assert.match(err.message, /reaches correlated observation, not controlled experiment/);
      return true;
    }
  );

  // Claiming the rung the evidence reaches — or a lower one — is accepted.
  const { record } = concludeWithDecision(
    unread.id,
    conclusion({ ladderRung: "anecdote" })
  );
  assert.equal(record.ladderRung, "anecdote");
});

test("a sample short of the predeclared one caps the rung at a before-and-after", () => {
  // A three-post experiment concluded on two would be pre/post at best —
  // but the sample gate refuses it first, which is the stronger guarantee.
  const declared = experiment({ name: "Short sample", sampleTarget: 3, stopCondition: "Three." });
  read(deliver(declared.id).orderIds, 20);
  assert.equal(highestRungAvailable(getExperimentById(declared.id)!).rung, "pre_post_observation");
  assert.throws(() => concludeWithDecision(declared.id, conclusion()), /No winner is declared/);
});

test("a full sample read at every declared point reaches a controlled experiment", () => {
  const declared = readyToConclude({ name: "Controlled" });
  const available = highestRungAvailable(getExperimentById(declared.id)!);
  assert.equal(available.rung, "controlled_experiment");
  assert.match(available.why, /One variable was declared in advance, 2 of 2 posts were delivered/);

  const { record } = concludeWithDecision(declared.id, conclusion());
  assert.equal(record.ladderRung, "controlled_experiment");
});

test("funnel movements ride alongside the decision, labelled correlated", async () => {
  await readProjectFunnel(projectId);
  const declared = readyToConclude({ name: "Correlations" });

  const correlations = correlationsFor(getExperimentById(declared.id)!);
  assert.ok(correlations.length > 0);
  for (const correlation of correlations) {
    assert.equal(correlation.source, "project_funnel");
    assert.match(correlation.label, /Correlated observation/);
    assert.match(correlation.label, /nothing here says the experiment moved it/);
    assert.match(correlation.label, /never stands as proof/);
  }

  const { record } = concludeWithDecision(declared.id, conclusion());
  // They are on the record, and they are not the decision.
  assert.deepEqual(
    record.correlatedObservations.map((c) => c.metric).sort(),
    correlations.map((c) => c.metric).sort()
  );
  assert.match(record.supports, /question hook took more saves/);
});

// ---------------------------------------------------------------------------
// Criterion 3: the learning log

test("a concluded record appends to the project's learning log with its ceiling", () => {
  const declared = readyToConclude({ name: "Logged" });
  concludeWithDecision(declared.id, conclusion());

  const log = learningLog(projectId);
  const entry = log.find((e) => e.experimentId === declared.id);
  assert.ok(entry);
  assert.equal(entry.decision, "repeat");
  assert.equal(entry.ladderRung, "controlled_experiment");
  assert.match(entry.ladderMeaning, /One variable was isolated/);
  // The ceiling travels with the claim, not in a footnote somewhere else.
  assert.match(entry.doesNotSupport, /Nothing about reach/);
  assert.match(entry.cheapestNextObservation, /the other account/);
  assert.deepEqual(entry.sample, { delivered: 2, target: 2 });
  assert.equal(entry.variable, "a question hook versus a claim hook");
  assert.deepEqual(entry.observationPoints, ["One hour in"]);

  // Newest first, so a host reading the top of the log reads the latest.
  const second = readyToConclude({ name: "Logged later" });
  concludeWithDecision(second.id, conclusion({ decision: "change" }));
  assert.equal(learningLog(projectId)[0].experimentId, second.id);
});

test("the log a host reads carries the ladder and what a correlation is worth", () => {
  const view = learningLogView(projectId) as {
    entries: unknown[];
    ladder: { rung: string; meaning: string }[];
    note: string;
  };
  assert.deepEqual(
    view.ladder.map((r) => r.rung),
    [
      "controlled_experiment",
      "within_account_comparison",
      "pre_post_observation",
      "correlated_observation",
      "anecdote",
    ]
  );
  assert.match(view.note, /never proof of what caused it/);
  assert.ok(view.entries.length > 0);
});

// ---------------------------------------------------------------------------
// The host end of criterion 3
//
// The point of the log is that the next brief starts from measured
// learning instead of re-reasoning from scratch, so the host has to be
// able to read it and to close the loop on a piece it ran.

test("a host reads the learning log and records an outcome, end to end", async () => {
  assert.equal((await selectProject(HOST_SESSION, "KeepAnalog")).ok, true);

  const declared = readyToConclude({ name: "Host loop" });
  concludeWithDecision(declared.id, conclusion({ decision: "change" }));

  // The host reads what was learned, with the ceiling attached.
  const log = learningLogView(projectId) as {
    entries: { name: string; decision: string; ladderRung: string; doesNotSupport: string }[];
    note: string;
  };
  const entry = log.entries.find((e) => e.name === "Host loop");
  assert.ok(entry);
  assert.equal(entry.decision, "change");
  assert.equal(entry.ladderRung, "controlled_experiment");
  assert.ok(entry.doesNotSupport.length > 0, "a conclusion without a ceiling is not one");

  // And closes the loop on a piece it ran.
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, 'Host outcome', 'exported', 'snap', ?, 1)"
    )
    .run(projectId, JSON.stringify({ format: "1:1", slides: [], captions: {} }));
  const pieceId = Number(piece.lastInsertRowid);

  const recorded = recordPieceOutcome(HOST_SESSION, {
    id: pieceId,
    outcome: "62 saves at the one-hour point, against 40 for the claim hook.",
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded.response));
  const stored = getDb()
    .prepare("SELECT status, outcome FROM pieces WHERE id = ?")
    .get(pieceId) as { status: string; outcome: string };
  assert.equal(stored.status, "measured");
  assert.match(stored.outcome, /62 saves at the one-hour point/);

  // A piece the host never exported has no outcome to record.
  const drafting = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, 'Still drafting', 'drafting', 'snap', ?, 1)"
    )
    .run(projectId, JSON.stringify({ format: "1:1", slides: [], captions: {} }));
  const refused = recordPieceOutcome(HOST_SESSION, {
    id: Number(drafting.lastInsertRowid),
    outcome: "it went well",
  });
  assert.equal(refused.ok, false);
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the Operator sees what the evidence can carry before deciding", async () => {
  const declared = readyToConclude({ name: "HTTP evidence" });
  const before = await api<{
    sample: { delivered: number; target: number; met: boolean };
    available: { rung: string; why: string };
    decision: unknown;
  }>(`/api/experiments/${declared.id}/evidence`);
  assert.equal(before.status, 200);
  assert.deepEqual(
    { delivered: before.body.sample.delivered, met: before.body.sample.met },
    { delivered: 2, met: true }
  );
  assert.equal(before.body.available.rung, "controlled_experiment");
  assert.equal(before.body.decision, null);

  const overclaimed = await api<{ error: string }>(`/api/experiments/${declared.id}/conclude`, {
    method: "POST",
    body: JSON.stringify(conclusion({ ladderRung: "controlled_experiment" })),
  });
  assert.equal(overclaimed.status, 200, "the rung it reaches is accepted");

  const after = await api<{ decision: { ladderRung?: string } }>(
    `/api/experiments/${declared.id}/evidence`
  );
  assert.equal(
    (after.body.decision as { evidence: { ladderRung: string } }).evidence.ladderRung,
    "controlled_experiment"
  );
});

test("concluding over HTTP is refused for the sample, not for the paperwork", async () => {
  const declared = experiment({ name: "HTTP too early" });
  read(deliver(declared.id).orderIds, 12);
  const early = await api<{ error: string }>(`/api/experiments/${declared.id}/conclude`, {
    method: "POST",
    body: JSON.stringify(conclusion()),
  });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /No winner is declared 1 short/);
});

test("the learning log is readable over HTTP", async () => {
  const res = await api<{ log: { entries: { decision: string }[]; note: string } }>(
    `/api/experiments/log/${projectId}`
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.log.entries.length > 0);
  assert.match(res.body.log.note, /never proof/);

  const bad = await api("/api/experiments/log/not-a-number");
  assert.equal(bad.status, 400);
});

test("the experiment routes still need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api(`/api/experiments/log/${projectId}`)).status, 401);
  cookie = saved;
});
