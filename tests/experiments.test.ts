// Predeclared Experiments and the measure orders they schedule (ticket 23).
//
// Decisions under test:
//   docs/issues/marketing-os/issues/13-define-measurement-learning-loop.md
//     — predeclaration, observation points, and the honesty of an ad-hoc
//       reading being labelled as one

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
  acknowledgeDisclosure,
  createTarget,
  disclosureChecklist,
  markPosting,
  releasePiece,
  releaseToOperator,
  submitDeliveryProof,
  verifyPosted,
} from "../server/deliveries";
import { deliveryRouter } from "../server/delivery-routes";
import {
  declareExperiment,
  enrollDelivery,
  experimentView,
  getExperimentById,
  measureAdHoc,
  observationsFor,
  scheduleObservations,
  scheduleOutstandingObservations,
  scheduledFor,
  stopExperiment,
  verifyAndObserve,
  type Experiment,
} from "../server/experiments";
import { experimentRouter } from "../server/experiment-routes";
import { registerProject } from "../server/projects";
import { claimOrder, getOrderById, orderView, startOrder, submitProof } from "../server/work-orders";

const app = express();
app.use("/api/deliveries", deliveryRouter());
app.use("/api/experiments", experimentRouter());
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

/** The full declaration, which every test varies from rather than builds up. */
function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId,
    name: `Hook length ${unique()}`,
    variable: "the first line of the caption: a question versus a claim",
    primaryMetric: "saves per impression",
    decisionRule:
      "Keep the question hook if its saves per impression beat the claim hook by more than 20% across the sample.",
    sampleTarget: 8,
    stopCondition: "Stop at 8 delivered posts, or sooner if either arm is removed by the platform.",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["impressions", "saves"], source: "the post's own analytics tab" },
      { label: "Day two", afterHours: 24, metrics: ["impressions", "saves", "follows"], source: "the account analytics export" },
    ],
    ...overrides,
  };
}

function experiment(overrides: Record<string, unknown> = {}): Experiment {
  return declareExperiment(declaration(overrides));
}

/** A delivery walked all the way to the edge of verification. */
function deliveryAtProof(): { targetId: number; orderId: number; permalink: string } {
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
    idempotencyKey: `experiment-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target;
  for (const item of disclosureChecklist(target)) acknowledgeDisclosure(target.id, item.rule);

  const { order } = releaseToOperator(target.id);
  markPosting(target.id);
  const permalink = `https://x.com/keepanalog/status/${1000000 + n}`;
  submitDeliveryProof(target.id, permalink);
  claimOrder(order.id, "operator", insideWindow());
  startOrder(order.id);
  submitProof({ orderId: order.id, proof: permalink });
  return { targetId: target.id, orderId: order.id, permalink };
}

test.before(async () => {
  const registered = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  projectId = registered.project.id;
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: no experiment without its full predeclaration

test("an experiment cannot be created without its full predeclaration", () => {
  const before = countExperiments();
  const full = declaration();
  for (const missing of [
    "variable",
    "primaryMetric",
    "decisionRule",
    "sampleTarget",
    "stopCondition",
    "observations",
  ]) {
    const partial = { ...full };
    delete partial[missing];
    assert.throws(
      () => declareExperiment(partial),
      (err: Error) => {
        assert.match(err.message, /declared in full before any work ships, or not at all/);
        return true;
      },
      `a declaration missing ${missing} was accepted`
    );
  }

  // Nothing was saved along the way: a refused declaration leaves no draft
  // to be finished after the numbers arrive.
  assert.equal(countExperiments(), before);
});

function countExperiments(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM experiments").get() as { n: number }).n;
}

test("every gap is named at once, not one refusal at a time", () => {
  assert.throws(
    () => declareExperiment({ projectId, name: "Half an idea" }),
    (err: Error) => {
      for (const part of [
        "the one variable being changed",
        "the primary metric",
        "the rule that will decide it",
        "the sample it needs",
        "the condition that stops it",
        "at least one observation point",
      ]) {
        assert.ok(err.message.includes(part), `missing "${part}" from the refusal`);
      }
      return true;
    }
  );
});

test("an observation point is not a point without when, what, and where", () => {
  for (const broken of [
    { label: "No metrics", afterHours: 1, metrics: [], source: "somewhere" },
    { label: "No source", afterHours: 1, metrics: ["saves"], source: "" },
    { label: "", afterHours: 1, metrics: ["saves"], source: "somewhere" },
  ]) {
    assert.throws(() => declareExperiment(declaration({ observations: [broken] })), /missing/);
  }
});

test("the declaration is fixed once it exists", () => {
  const declared = experiment();
  const db = getDb();
  for (const [column, value] of [
    ["variable", "something easier to win"],
    ["primary_metric", "impressions"],
    ["decision_rule", "whatever looks best"],
    ["sample_target", 2],
    ["stop_condition", "when I feel like it"],
  ] as const) {
    assert.throws(
      () => db.prepare(`UPDATE experiments SET ${column} = ? WHERE id = ?`).run(value, declared.id),
      /predeclared; its declaration cannot be edited/,
      `${column} was editable`
    );
  }
  // The status still moves, which is the only thing that should.
  assert.equal(stopExperiment(declared.id).status, "stopped");
  assert.throws(
    () => db.prepare("DELETE FROM experiments WHERE id = ?").run(declared.id),
    /permanent record/
  );
  // And the schedule declared with it is just as fixed.
  const point = observationsFor(declared.id)[0];
  assert.throws(
    () => db.prepare("UPDATE experiment_observations SET after_hours = 999 WHERE id = ?").run(point.id),
    /declared with its experiment/
  );
});

// ---------------------------------------------------------------------------
// Criterion 2: observation points schedule themselves

test("verifying a delivery schedules every observation point, with no one scheduling it", () => {
  const declared = experiment({ name: "Auto schedule" });
  const delivery = deliveryAtProof();
  enrollDelivery(declared.id, delivery.targetId);

  // Nothing yet: the delivery is not verified, so there is nothing published
  // to read numbers off.
  assert.deepEqual(scheduledFor(declared.id), []);

  const { scheduled } = verifyAndObserve(delivery.targetId);
  const points = observationsFor(declared.id);
  assert.equal(scheduled.length, points.length);

  const orders = scheduled.map((s) => getOrderById(s.orderId)!);
  assert.deepEqual(
    orders.map((o) => o.kind),
    ["measure", "measure"]
  );
  // Each one is already on the queue: nobody has to approve it into being.
  assert.deepEqual(
    orders.map((o) => o.status),
    ["queued", "queued"]
  );

  // Each says exactly which numbers, from where, for which post.
  const hourOne = orders[0];
  assert.match(hourOne.instruction, /Read impressions, saves from the post's own analytics tab/);
  assert.match(hourOne.instruction, new RegExp(delivery.permalink));
  assert.match(hourOne.instruction, /1 hours after it went up/);
  assert.match(hourOne.instruction, /primary metric is saves per impression/);
  assert.equal(hourOne.observationId, points[0].id);

  // Due at the declared offset from the moment it was verified.
  const verifiedAt = new Date(scheduled[0].dueAt).getTime() - 1 * 3600 * 1000;
  assert.equal(
    new Date(scheduled[1].dueAt).getTime() - verifiedAt,
    24 * 3600 * 1000
  );
});

test("scheduling never books the same reading twice", () => {
  const declared = experiment({ name: "Idempotent schedule" });
  const delivery = deliveryAtProof();
  enrollDelivery(declared.id, delivery.targetId);
  const first = verifyAndObserve(delivery.targetId).scheduled;

  // Again, by every route that can trigger it.
  assert.deepEqual(scheduleObservations(delivery.targetId), []);
  assert.deepEqual(scheduleOutstandingObservations(), []);
  enrollDelivery(declared.id, delivery.targetId);
  assert.equal(scheduledFor(declared.id).length, first.length);
});

test("enrolling a delivery that is already verified does not lose its readings", () => {
  const declared = experiment({ name: "Late enrolment" });
  const delivery = deliveryAtProof();
  verifyPosted(delivery.targetId);

  const { scheduled } = enrollDelivery(declared.id, delivery.targetId);
  assert.equal(scheduled.length, observationsFor(declared.id).length);
});

test("the sweep catches a verified delivery whose readings were never scheduled", () => {
  const declared = experiment({ name: "Sweep" });
  const delivery = deliveryAtProof();
  enrollDelivery(declared.id, delivery.targetId);
  // Verified without going through the scheduler at all.
  verifyPosted(delivery.targetId);
  assert.deepEqual(scheduledFor(declared.id), []);

  const swept = scheduleOutstandingObservations();
  assert.equal(swept.filter((s) => s.targetId === delivery.targetId).length, 2);
});

test("enrolment starts the experiment, and a halted one takes nothing on", () => {
  const declared = experiment({ name: "Lifecycle" });
  assert.equal(declared.status, "predeclared");
  const delivery = deliveryAtProof();
  assert.equal(enrollDelivery(declared.id, delivery.targetId).experiment.status, "running");

  // Reaching `concluded` goes through the decision record of ticket 25 and
  // is covered there; stopping is the other way an experiment closes.
  stopExperiment(declared.id);
  const another = deliveryAtProof();
  assert.throws(
    () => enrollDelivery(declared.id, another.targetId),
    /is stopped and takes on no further deliveries/
  );
});

// ---------------------------------------------------------------------------
// Criterion 3: an unscheduled reading is visibly unscheduled

test("an ad-hoc reading is visibly not a scheduled one", () => {
  const adHoc = measureAdHoc({
    projectId,
    title: "Check yesterday's reach",
    instruction: "Open the analytics tab and read yesterday's reach.",
  });
  assert.equal(adHoc.kind, "measure");
  assert.equal(adHoc.observationId, null);
  assert.equal((orderView(adHoc) as { scheduling: string }).scheduling, "unscheduled");

  const declared = experiment({ name: "Contrast" });
  const delivery = deliveryAtProof();
  enrollDelivery(declared.id, delivery.targetId);
  const planned = getOrderById(verifyAndObserve(delivery.targetId).scheduled[0].orderId)!;
  assert.equal((orderView(planned) as { scheduling: string }).scheduling, "scheduled");

  // The distinction is only ever made about readings.
  const posting = getOrderById(delivery.orderId)!;
  assert.equal((orderView(posting) as { scheduling: string | null }).scheduling, null);
});

test("an ad-hoc reading still says what to read and where", () => {
  assert.throws(
    () => measureAdHoc({ projectId, title: "Vague" }),
    /still names the project, what to read, and where/
  );
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the experiment routes need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/experiments")).status, 401);
  cookie = saved;
});

test("the Operator declares, enrols, and verifies over HTTP", async () => {
  const declared = await api<{ experiment: { id: number; status: string } }>("/api/experiments", {
    method: "POST",
    body: JSON.stringify(declaration({ name: "HTTP experiment" })),
  });
  assert.equal(declared.status, 200);
  const experimentId = declared.body.experiment.id;

  const partial = await api<{ error: string }>("/api/experiments", {
    method: "POST",
    body: JSON.stringify({ projectId, name: "Not enough" }),
  });
  assert.equal(partial.status, 400);
  assert.match(partial.body.error, /in full before any work ships/);

  const delivery = deliveryAtProof();
  const enrolled = await api<{ experiment: { status: string } }>(
    `/api/experiments/${experimentId}/deliveries`,
    { method: "POST", body: JSON.stringify({ targetId: delivery.targetId }) }
  );
  assert.equal(enrolled.body.experiment.status, "running");

  // Verifying through the delivery surface schedules the readings in the
  // same act, so no separate scheduling call exists to be forgotten.
  const verified = await api<{
    target: { status: string };
    scheduled: { orderId: number }[];
  }>(`/api/deliveries/${delivery.targetId}/verify`, { method: "POST" });
  assert.equal(verified.body.target.status, "verified_posted");
  assert.equal(verified.body.scheduled.length, 2);

  const read = await api<{
    experiment: {
      declaration: { variable: string; sampleTarget: number };
      observations: unknown[];
      sampleProgress: { target: number; enrolled: number };
      note: string;
    };
  }>(`/api/experiments/${experimentId}`);
  assert.match(read.body.experiment.declaration.variable, /a question versus a claim/);
  assert.equal(read.body.experiment.observations.length, 2);
  assert.deepEqual(read.body.experiment.sampleProgress, { target: 8, enrolled: 1 });
  assert.match(read.body.experiment.note, /cannot be edited/);
});

test("an ad-hoc reading over HTTP is labelled unscheduled", async () => {
  const res = await api<{ order: { scheduling: string; kind: string } }>(
    "/api/experiments/ad-hoc",
    {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title: "Ad-hoc over HTTP",
        instruction: "Read the follower count.",
      }),
    }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    { kind: res.body.order.kind, scheduling: res.body.order.scheduling },
    { kind: "measure", scheduling: "unscheduled" }
  );
});

test("the experiment view carries the whole declaration", () => {
  const declared = experiment({ name: "View" });
  const view = experimentView(declared) as {
    declaration: Record<string, unknown>;
    observations: { label: string }[];
  };
  assert.deepEqual(Object.keys(view.declaration).sort(), [
    "decisionRule",
    "declaredAt",
    "declaredBy",
    "primaryMetric",
    "sampleTarget",
    "stopCondition",
    "variable",
  ]);
  assert.deepEqual(
    view.observations.map((o) => o.label),
    ["One hour in", "Day two"]
  );
});
