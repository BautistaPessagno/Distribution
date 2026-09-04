// Metric Snapshots (ticket 24).
//
// Decisions under test:
//   docs/issues/marketing-os/issues/13-define-measurement-learning-loop.md
//     — two observation sources, both labelled; provenance on funnel reads;
//       observations appended and never overwritten

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
} from "../server/deliveries";
import {
  declareExperiment,
  enrollDelivery,
  measureAdHoc,
  observationsFor,
  verifyAndObserve,
  type Experiment,
} from "../server/experiments";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";
import {
  completeMeasureOrder,
  deliveryEvidence,
  experimentEvidence,
  listSnapshots,
  readProjectFunnel,
  recordReadings,
  seriesFor,
  snapshotView,
} from "../server/snapshots";
import { snapshotRouter } from "../server/snapshot-routes";
import { beginReview, claimOrder, startOrder, submitProof } from "../server/work-orders";

const app = express();
app.use("/dev-stub", createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash)));
app.use("/api/snapshots", snapshotRouter());
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

function experiment(overrides: Record<string, unknown> = {}): Experiment {
  return declareExperiment({
    projectId,
    name: `Experiment ${unique()}`,
    variable: "a question hook versus a claim hook",
    primaryMetric: "saves",
    decisionRule: "Keep the hook whose saves beat the other by 20% across the sample.",
    sampleTarget: 4,
    stopCondition: "Stop at 4 delivered posts.",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["impressions", "saves"], source: "the post's analytics tab" },
    ],
    ...overrides,
  });
}

/** A delivery verified posted, so its observation orders exist. */
function verifiedDelivery(): { targetId: number; permalink: string } {
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
    idempotencyKey: `snapshot-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target;
  for (const item of disclosureChecklist(target)) acknowledgeDisclosure(target.id, item.rule);

  const { order } = releaseToOperator(target.id);
  markPosting(target.id);
  const permalink = `https://x.com/keepanalog/status/${2000000 + n}`;
  submitDeliveryProof(target.id, permalink);
  claimOrder(order.id, "operator", insideWindow());
  startOrder(order.id);
  submitProof({ orderId: order.id, proof: permalink });
  return { targetId: target.id, permalink };
}

/** A measure order walked to the point where its numbers can be filed. */
function measureOrderAtReview(orderId: number): void {
  claimOrder(orderId, "operator", insideWindow());
  startOrder(orderId);
  submitProof({ orderId, proof: "Read them off the analytics tab at 10:04." });
  beginReview(orderId);
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
// Criterion 1: completing a measure order records a snapshot tied to its
// target and experiment

test("completing a measure order records snapshots tied to its target and experiment", () => {
  const declared = experiment({ name: "Tied" });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const scheduled = verifyAndObserve(delivery.targetId).scheduled;
  const orderId = scheduled[0].orderId;
  measureOrderAtReview(orderId);

  const { order, snapshots } = completeMeasureOrder(orderId, [
    { metric: "impressions", value: 4120 },
    { metric: "saves", value: 61 },
  ]);
  assert.equal(order.status, "completed");
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.source, "operator_reading");
    assert.equal(snapshot.targetId, delivery.targetId);
    assert.equal(snapshot.experimentId, declared.id);
    assert.equal(snapshot.observationId, observationsFor(declared.id)[0].id);
    assert.match(snapshot.collectionMethod, /Read by hand and filed against Work Order/);
    assert.match(snapshot.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(
    listSnapshots({ targetId: delivery.targetId }).map((s) => [s.metric, s.value]),
    [
      ["impressions", 4120],
      ["saves", 61],
    ]
  );
});

test("completion and the snapshot are one act: neither happens without the other", () => {
  const declared = experiment({ name: "Atomic" });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const orderId = verifyAndObserve(delivery.targetId).scheduled[0].orderId;
  measureOrderAtReview(orderId);

  assert.throws(
    () => completeMeasureOrder(orderId, []),
    /at least one metric with its value/
  );
  // The order did not complete on the way past.
  assert.equal(
    (getDb().prepare("SELECT status FROM work_orders WHERE id = ?").get(orderId) as {
      status: string;
    }).status,
    "under_review"
  );
  assert.deepEqual(listSnapshots({ targetId: delivery.targetId }), []);
});

test("an order that was never completable is refused for that, not for its numbers", () => {
  const declared = experiment({ name: "Not yet" });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const orderId = verifyAndObserve(delivery.targetId).scheduled[0].orderId;
  assert.throws(
    () => completeMeasureOrder(orderId, [{ metric: "saves", value: 1 }]),
    /complete happens from under_review/
  );
});

test("readings are filed against a measure order, and only after its proof", () => {
  const delivery = verifiedDelivery();
  const postingOrderId = (
    getDb()
      .prepare("SELECT work_order_id AS id FROM delivery_targets WHERE id = ?")
      .get(delivery.targetId) as { id: number }
  ).id;
  assert.throws(
    () => recordReadings({ orderId: postingOrderId, readings: [{ metric: "saves", value: 1 }] }),
    /is a post order\. Readings are filed against a measure order/
  );

  const adHoc = measureAdHoc({
    projectId,
    title: "No proof yet",
    instruction: "Read the follower count.",
  });
  assert.throws(
    () => recordReadings({ orderId: adHoc.id, readings: [{ metric: "followers", value: 10 }] }),
    /carries no proof yet\. The numbers and the record of having read them are one act/
  );
});

test("an ad-hoc reading belongs to no experiment, and says so by belonging nowhere", () => {
  const adHoc = measureAdHoc({
    projectId,
    title: "Ad-hoc follower check",
    instruction: "Read the follower count off the profile.",
  });
  measureOrderAtReview(adHoc.id);
  const { snapshots } = completeMeasureOrder(adHoc.id, [{ metric: "followers", value: 812 }]);
  assert.deepEqual(
    {
      target: snapshots[0].targetId,
      experiment: snapshots[0].experimentId,
      observation: snapshots[0].observationId,
    },
    { target: null, experiment: null, observation: null }
  );
  assert.equal(snapshots[0].source, "operator_reading");
});

// ---------------------------------------------------------------------------
// Criterion 2: funnel reads record their project snapshot provenance

test("a funnel read records the project's own snapshot id and version", async () => {
  const outcome = await readProjectFunnel(projectId);
  assert.ok(outcome.snapshots.length >= 3);
  assert.match(outcome.provenance.snapshotId, /^dev-stub-funnel-/);
  assert.equal(typeof outcome.provenance.version, "number");

  for (const snapshot of outcome.snapshots) {
    assert.equal(snapshot.source, "project_funnel");
    assert.equal(snapshot.projectSnapshotId, outcome.provenance.snapshotId);
    assert.equal(snapshot.projectSnapshotVersion, outcome.provenance.version);
    // The project's own words for how it got them, not ours.
    assert.equal(snapshot.collectionMethod, outcome.provenance.collectionMethod);
    assert.equal(snapshot.observedAt, outcome.provenance.observedAt);
    // A funnel read belongs to the project, not to any one post.
    assert.equal(snapshot.targetId, null);
  }

  const view = snapshotView(outcome.snapshots[0]) as {
    sourceLabel: string;
    provenance: { projectSnapshotId: string };
  };
  assert.equal(view.sourceLabel, "read from the project's product funnel");
  assert.equal(view.provenance.projectSnapshotId, outcome.provenance.snapshotId);
});

test("two funnel reads carry different provenance, because they are two reads", async () => {
  const first = await readProjectFunnel(projectId);
  const second = await readProjectFunnel(projectId);
  assert.notEqual(second.provenance.snapshotId, first.provenance.snapshotId);
});

test("a project with no funnel is refused as unsupported, not filled in", async () => {
  const bare = express();
  bare.get("/capabilities/metrics", (_req, res) => {
    res.status(404).json({
      error: {
        code: "unsupported_capability",
        message: "no funnel here",
        retryable: false,
        recovery: "consult the manifest",
      },
    });
  });
  const bareServer = bare.listen(0);
  const barePort = (bareServer.address() as AddressInfo).port;
  try {
    const registered = await registerProject(
      "NoFunnel",
      `http://127.0.0.1:${barePort}`,
      "test"
    ).catch(() => null);
    // Registration runs conformance against a domain that serves nothing
    // else, so the project may be unhealthy; either way no snapshot is
    // invented for it.
    const id = registered?.project.id;
    if (id !== undefined) {
      await assert.rejects(readProjectFunnel(id), /publishes no product funnel|could not be reached|unhealthy/);
    }
    assert.deepEqual(listSnapshots({ projectId: id ?? -1 }), []);
  } finally {
    bareServer.close();
  }
});

test("conformance holds a project to what it declared about its funnel", async () => {
  // The stub declares `metrics` and serves it, which is what the registered
  // project's own conformance report should say.
  const report = (
    getDb().prepare("SELECT last_conformance_report AS r FROM projects WHERE id = ?").get(projectId) as
      | { r: string | null }
      | undefined
  )?.r;
  assert.ok(report);
  const parsed = JSON.parse(report) as {
    passed: boolean;
    checks: { name: string; passed: boolean; detail: string }[];
  };
  const funnelCheck = parsed.checks.find((c) => c.name.includes("metrics"));
  assert.equal(
    funnelCheck?.name,
    "declared 'metrics' capability serves a bundle with provenance"
  );
  assert.equal(funnelCheck?.passed, true);
  assert.match(funnelCheck?.detail ?? "", /^snapshot dev-stub-funnel-/);
});

// ---------------------------------------------------------------------------
// Criterion 3: a second observation appends; nothing updates in place

test("a second reading of the same metric appends, and the series survives", () => {
  const declared = experiment({
    name: "Series",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["saves"], source: "the analytics tab" },
      { label: "Day two", afterHours: 24, metrics: ["saves"], source: "the analytics tab" },
    ],
  });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const scheduled = verifyAndObserve(delivery.targetId).scheduled;

  measureOrderAtReview(scheduled[0].orderId);
  completeMeasureOrder(scheduled[0].orderId, [{ metric: "saves", value: 12 }]);
  measureOrderAtReview(scheduled[1].orderId);
  completeMeasureOrder(scheduled[1].orderId, [{ metric: "saves", value: 47 }]);

  const series = seriesFor(delivery.targetId, "saves");
  assert.deepEqual(series.map((s) => s.value), [12, 47]);
  // Two rows, two observation points, two moments. Nothing collapsed.
  assert.notEqual(series[0].observationId, series[1].observationId);
  assert.notEqual(series[0].id, series[1].id);
});

test("an observation is never overwritten or deleted, at the storage level", () => {
  const adHoc = measureAdHoc({
    projectId,
    title: "Immutable reading",
    instruction: "Read the follower count.",
  });
  measureOrderAtReview(adHoc.id);
  const { snapshots } = completeMeasureOrder(adHoc.id, [{ metric: "followers", value: 100 }]);
  const db = getDb();
  assert.throws(
    () => db.prepare("UPDATE metric_snapshots SET value = 999 WHERE id = ?").run(snapshots[0].id),
    /never overwritten; a further reading is another row/
  );
  assert.throws(
    () => db.prepare("DELETE FROM metric_snapshots WHERE id = ?").run(snapshots[0].id),
    /never deleted/
  );
});

// ---------------------------------------------------------------------------
// Reading the evidence back

test("an experiment's evidence names its primary metric among the rest", () => {
  const declared = experiment({ name: "Evidence", primaryMetric: "saves" });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const orderId = verifyAndObserve(delivery.targetId).scheduled[0].orderId;
  measureOrderAtReview(orderId);
  completeMeasureOrder(orderId, [
    { metric: "impressions", value: 3000 },
    { metric: "saves", value: 30 },
  ]);

  const evidence = experimentEvidence(declared.id) as {
    primaryMetric: string;
    series: { metric: string; isPrimary: boolean; readings: unknown[] }[];
    observations: { collected: number }[];
    note: string;
  };
  assert.equal(evidence.primaryMetric, "saves");
  assert.equal(evidence.series.find((s) => s.metric === "saves")?.isPrimary, true);
  assert.equal(evidence.series.find((s) => s.metric === "impressions")?.isPrimary, false);
  assert.equal(evidence.observations[0].collected, 2);
  assert.match(evidence.note, /appended, never an updated total/);

  const perDelivery = deliveryEvidence(delivery.targetId) as {
    permalink: string;
    readings: unknown[];
  };
  assert.equal(perDelivery.permalink, delivery.permalink);
  assert.equal(perDelivery.readings.length, 2);
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the snapshot routes need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/snapshots")).status, 401);
  cookie = saved;
});

test("the Operator reads snapshots, series, and a funnel over HTTP", async () => {
  const declared = experiment({ name: "HTTP evidence" });
  const delivery = verifiedDelivery();
  enrollDelivery(declared.id, delivery.targetId);
  const orderId = verifyAndObserve(delivery.targetId).scheduled[0].orderId;
  measureOrderAtReview(orderId);
  completeMeasureOrder(orderId, [{ metric: "saves", value: 9 }]);

  const series = await api<{ series: { value: number; sourceLabel: string }[] }>(
    `/api/snapshots/series?targetId=${delivery.targetId}&metric=saves`
  );
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.series.map((s) => s.value), [9]);
  assert.equal(series.body.series[0].sourceLabel, "read by hand");

  const funnel = await api<{
    snapshots: { sourceLabel: string }[];
    provenance: { snapshotId: string };
  }>("/api/snapshots/funnel-read", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
  assert.equal(funnel.status, 200);
  assert.match(funnel.body.provenance.snapshotId, /^dev-stub-funnel-/);
  assert.equal(funnel.body.snapshots[0].sourceLabel, "read from the project's product funnel");

  const evidence = await api<{ evidence: { primaryMetric: string } }>(
    `/api/snapshots/experiments/${declared.id}`
  );
  assert.equal(evidence.body.evidence.primaryMetric, "saves");

  const bad = await api<{ error: string }>("/api/snapshots/series?targetId=abc&metric=saves");
  assert.equal(bad.status, 400);
});
