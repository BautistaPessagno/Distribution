// The MVP acceptance pass (ticket 28).
//
// One loop, run for real, from brief to concluded decision record — and
// every gate the spec named fired at least once on the way, with the
// evidence it left behind asserted rather than assumed.
//
// The gates:
//   a digest approval          a host proposes, a person decides
//   a brand-error block        off-kit styling refuses approval
//   a [NEED] claim block       an unsupported claim refuses approval
//   a cap hit                  the queue refuses to release more today
//   a submitted proof          nothing completes on say-so
//   a scheduled snapshot       a reading the experiment asked for in advance
//   a concluded experiment     a decision with its evidence ceiling
//
// Plus the audit the second project depends on: nothing anywhere in the
// shipped code knows the name of the first one.

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
import { dailyRail } from "../server/daily-rail";
import { getDb } from "../server/db";
import { concludeWithDecision, learningLog } from "../server/decisions";
import {
  acknowledgeDisclosure,
  createTarget,
  disclosureChecklist,
  markPosting,
  releasePiece,
  releaseToOperator,
  submitDeliveryProof,
} from "../server/deliveries";
import { declareExperiment, enrollDelivery, verifyAndObserve } from "../server/experiments";
import { scheduleHabitCheck, habitCheckDue, answerHabitCheck } from "../server/habit-check";
import { approvePiece } from "../server/piece-lifecycle";
import { getPieceById, type PieceDoc, type PieceRecord } from "../server/pieces";
import { decidePreparedChangeSet, getPreparedChangeSet } from "../server/project-changes";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { completeMeasureOrder } from "../server/snapshots";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";
import {
  approveOrder,
  beginReview,
  claimOrder,
  completeOrder,
  createOrder,
  getOrderById,
  startOrder,
  submitOrder,
  submitProof,
} from "../server/work-orders";
import { runConformance } from "../server/conformance";
import { projectServiceToken } from "../server/projects";

const app = express();
const stub = createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash));
app.use("/dev-stub", stub);
// A second project domain, so onboarding a second project goes through the
// same path rather than through a special case for the test.
app.use("/second-stub", stub);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

let projectId = 0;
let projectBaseUrl = "";

/** Every gate, and the evidence that it fired. Filled in as the loop runs. */
const gates = new Map<string, string>();
function fired(gate: string, evidence: string): void {
  gates.set(gate, evidence);
}

function operator(): void {
  const salt = randomBytes(16).toString("hex");
  getDb()
    .prepare(
      "INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt) VALUES (?, ?, ?)"
    )
    .run("operator", hashRecoveryCode("AAAAA-AAAAA-AAAAA-AAAAA", salt), salt);
}

let seed = 0;
function unique(): number {
  seed += 1;
  return seed;
}

function at(clock: string): Date {
  const [hours, minutes] = clock.split(":").map(Number);
  const when = new Date();
  when.setHours(hours, minutes, 0, 0);
  return when;
}

function doc(overrides: Partial<PieceDoc> = {}): PieceDoc {
  return {
    format: "1:1",
    slides: [{ layers: [{ type: "text", text: "Five reasons paper wins", role: "headline" }] }],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
    ...overrides,
  } as PieceDoc;
}

function pieceInReview(title: string, body: PieceDoc): PieceRecord {
  const inserted = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'review', 'snap-1', ?, 1)"
    )
    .run(projectId, title, JSON.stringify(body));
  const piece = getPieceById(Number(inserted.lastInsertRowid));
  assert.ok(piece);
  return piece;
}

test.before(async () => {
  projectBaseUrl = `http://127.0.0.1:${port}/dev-stub`;
  const registered = await registerProject("Acceptance Project", projectBaseUrl, "test");
  projectId = registered.project.id;
  operator();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 2: the conformance suite passes for the registered domain

test("the conformance suite passes for the registered project domain", async () => {
  const token = await projectServiceToken(projectId, "acceptance");
  const report = await runConformance(projectBaseUrl, token);
  const failed = report.checks.filter((c) => !c.passed);
  assert.deepEqual(failed, [], `failing checks: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(report.passed, true);
  assert.ok(report.checks.length >= 8, "the suite ran, rather than passing vacuously");
});

// ---------------------------------------------------------------------------
// Criterion 1: every gate fires during a genuine loop

test("gate: a brand error blocks approval", () => {
  const offKit = pieceInReview(
    "Off-kit styling",
    doc({
      slides: [
        {
          layers: [
            { type: "text", text: "Five reasons paper wins", role: "headline", color: "#ff0000" },
          ],
        },
      ],
    } as Partial<PieceDoc>)
  );
  const result = approvePiece(offKit, "operator");
  assert.equal(result.ok, false);
  const message = JSON.stringify(result.response);
  assert.match(message, /is not a token in this Brand Kit|instead of a Brand Kit token/);
  assert.equal(getPieceById(offKit.id)?.status, "review", "a blocked approval moves nothing");

  const audited = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pieces.approval_blocked' AND json_extract(detail, '$.pieceId') = ?"
    )
    .get(offKit.id) as { n: number };
  assert.equal(audited.n, 1);
  fired("brand_error_block", `piece #${offKit.id}, audit pieces.approval_blocked`);
});

test("gate: an unsupported [NEED] claim blocks approval", () => {
  const unsupported = pieceInReview(
    "Unsupported claim",
    doc({
      captions: {
        instagram: "Used by [NEED: how many?] designers",
        x: "x",
        linkedin: "li",
        tiktok: "tt",
      },
    } as Partial<PieceDoc>)
  );
  const result = approvePiece(unsupported, "operator");
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.response), /unsupported-claim token \[NEED/);
  assert.equal(getPieceById(unsupported.id)?.status, "review");
  fired("need_claim_block", `piece #${unsupported.id}, [NEED] token in the instagram caption`);
});

test("gate: a clean piece approves, and that is the same gate letting work through", () => {
  const clean = pieceInReview("Clean piece", doc());
  const result = approvePiece(clean, "operator");
  assert.equal(result.ok, true, JSON.stringify(result.response));
  assert.equal(getPieceById(clean.id)?.status, "approved");
});

test("gate: a host's digest waits for a person, who decides it", () => {
  const digest = `acceptance-digest-${unique()}`;
  getDb()
    .prepare(
      `INSERT INTO project_changes (digest, project_id, snapshot_id, cursor, summary, change_set, diff)
       VALUES (?, ?, 'snap-1', 1, 'Tighten the hero line', ?, '[]')`
    )
    .run(digest, projectId, JSON.stringify({ operations: [{ op: "set_field" }] }));

  // It interrupts, and it is not a step of the day's work.
  const rail = dailyRail("positioning", at("10:00"));
  assert.equal(rail.interruptions.some((i) => i.digest === digest), true);
  assert.equal(rail.steps.some((s) => s.subject.kind === "change"), false);

  assert.equal(getPreparedChangeSet(digest)?.status, "pending");
  decidePreparedChangeSet(digest, "approved", "operator");
  assert.equal(getPreparedChangeSet(digest)?.status, "approved");

  // And it stops interrupting once decided.
  assert.equal(
    dailyRail("positioning", at("10:00")).interruptions.some((i) => i.digest === digest),
    false
  );
  fired("digest_approval", `digest ${digest}, decided by the Operator`);
});

test("gate: a cap hit refuses the next release and names when it opens", () => {
  const slot = createSlot({
    projectId,
    platform: "x",
    label: `Capped slot ${unique()}`,
    identitySpec: { kind: "business_account", displayName: "Acceptance" },
    allowedWindows: [{ start: "00:00", end: "23:59" }],
    dailyCaps: [{ action: "post", perDay: 1 }],
  });
  addInstance({ slotId: slot.id, handle: "@capped" });

  const queued = (title: string) => {
    const created = createOrder({
      projectId,
      slotId: slot.id,
      kind: "post",
      title,
      instruction: "Publish the approved piece.",
    });
    submitOrder(created.id);
    return approveOrder(created.id);
  };

  const noon = at("12:00");
  claimOrder(queued("First post of the day").id, "operator", noon);
  const second = queued("One post too many");
  assert.throws(
    () => claimOrder(second.id, "operator", noon),
    (err: Error) => {
      assert.match(err.message, /released 1 of 1 post orders today/);
      assert.match(err.message, /The queue opens tomorrow/);
      return true;
    }
  );
  assert.equal(getOrderById(second.id)?.status, "queued", "a capped order does not move");
  // And the rail does not hand out what the cap just refused.
  assert.equal(
    dailyRail("positioning", noon).steps.some(
      (s) => s.subject.kind === "work_order" && s.subject.id === second.id
    ),
    false
  );
  fired("cap_hit", `slot #${slot.id}, order #${second.id} refused at 1 of 1`);
});

test("gate: nothing completes on say-so; proof is what completes it", () => {
  const created = createOrder({
    projectId,
    kind: "warmup",
    title: "Read the niche for ten minutes",
    instruction: "Read ten posts from the niche and note what the good ones do",
  });
  submitOrder(created.id);
  approveOrder(created.id);
  claimOrder(created.id, "operator", at("10:00"));
  startOrder(created.id);

  assert.throws(() => completeOrder(created.id), /complete happens from under_review/);
  submitProof({ orderId: created.id, proof: "Read twelve posts; noted three hook shapes." });
  beginReview(created.id);
  const completed = completeOrder(created.id, "reads well");
  assert.equal(completed.order.status, "completed");
  assert.equal(completed.attempt.proof?.body, "Read twelve posts; noted three hook shapes.");
  fired("submitted_proof", `Work Order #${created.id}, attempt ${completed.attempt.attemptNo}`);
});

// ---------------------------------------------------------------------------
// The long half of the loop: delivery, scheduled reading, conclusion

test("gate: a scheduled reading and a concluded experiment close the loop", () => {
  const experiment = declareExperiment({
    projectId,
    name: "Acceptance hook test",
    variable: "the first line of the caption: a question versus a claim",
    primaryMetric: "saves",
    decisionRule: "Keep the question hook if its saves beat the claim hook across the sample.",
    sampleTarget: 1,
    stopCondition: "Stop at one delivered post.",
    observations: [
      { label: "One hour in", afterHours: 1, metrics: ["saves"], source: "the post's analytics tab" },
    ],
  });

  // A real delivery, all the way through its own gates.
  const n = unique();
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'exported', 'snap-1', ?, 1)"
    )
    .run(projectId, `Delivered piece ${n}`, JSON.stringify(doc()));
  const pieceId = Number(piece.lastInsertRowid);
  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, 1, 1, ?, ?)"
    )
    .run(pieceId, `data/exports/piece-${pieceId}-v1`, JSON.stringify({ pieceId, n }));

  const slot = createSlot({
    projectId,
    platform: "x",
    label: `Delivery slot ${n}`,
    identitySpec: { kind: "business_account", displayName: "Acceptance" },
    allowedWindows: [{ start: "00:00", end: "23:59" }],
  });
  addInstance({ slotId: slot.id, handle: "@delivery" });

  const target = createTarget({
    releaseId: releasePiece(pieceId).id,
    slotId: slot.id,
    idempotencyKey: `acceptance-key-${n}-${randomBytes(4).toString("hex")}`,
  }).target;

  // The disclosure checklist gate: nothing is handed out before it is done.
  assert.throws(() => releaseToOperator(target.id), /unacknowledged/);
  for (const item of disclosureChecklist(target)) acknowledgeDisclosure(target.id, item.rule);

  const { order: postOrder } = releaseToOperator(target.id);
  markPosting(target.id);
  const permalink = `https://x.com/acceptance/status/${4000000 + n}`;
  submitDeliveryProof(target.id, permalink);
  claimOrder(postOrder.id, "operator", at("10:00"));
  startOrder(postOrder.id);
  submitProof({ orderId: postOrder.id, proof: `Published: ${permalink}` });

  enrollDelivery(experiment.id, target.id);
  const { scheduled } = verifyAndObserve(target.id);
  assert.equal(scheduled.length, 1, "the observation point scheduled itself");
  const readingOrder = scheduled[0].orderId;
  assert.match(
    getOrderById(readingOrder)?.instruction ?? "",
    /Read saves from the post's analytics tab/
  );

  claimOrder(readingOrder, "operator", at("10:00"));
  startOrder(readingOrder);
  submitProof({ orderId: readingOrder, proof: "Read saves off the analytics tab at 11:04." });
  beginReview(readingOrder);
  const { snapshots } = completeMeasureOrder(readingOrder, [{ metric: "saves", value: 61 }]);
  assert.equal(snapshots[0].experimentId, experiment.id);
  assert.equal(snapshots[0].targetId, target.id);
  assert.equal(snapshots[0].source, "operator_reading");
  fired(
    "scheduled_snapshot",
    `experiment #${experiment.id}, observation order #${readingOrder}, snapshot #${snapshots[0].id}`
  );

  // And the conclusion, held to its own predeclaration.
  const { record } = concludeWithDecision(experiment.id, {
    decision: "repeat",
    supports: "The question hook took 61 saves on the one delivered post.",
    doesNotSupport:
      "Nothing about reach, about other platforms, or about whether one post generalises.",
    ladderRung: "controlled_experiment",
    cheapestNextObservation: "Run the same two hooks on a second account at the same hour.",
    stopConditionMet: "The one predeclared post went up and was read at the one-hour point.",
  });
  assert.equal(record.decision, "repeat");
  assert.equal(record.ladderRung, "controlled_experiment");

  const logged = learningLog(projectId).find((e) => e.experimentId === experiment.id);
  assert.ok(logged);
  assert.match(logged.doesNotSupport, /Nothing about reach/);
  fired("concluded_experiment", `experiment #${experiment.id}, decision record #${record.id}`);
});

test("every gate on the list fired at least once, with its evidence", () => {
  const required = [
    "digest_approval",
    "brand_error_block",
    "need_claim_block",
    "cap_hit",
    "submitted_proof",
    "scheduled_snapshot",
    "concluded_experiment",
  ];
  const missing = required.filter((gate) => !gates.has(gate));
  assert.deepEqual(missing, [], `gates that never fired: ${missing.join(", ")}`);
  for (const gate of required) {
    assert.ok((gates.get(gate) ?? "").length > 0, `${gate} fired with no evidence recorded`);
  }
});

// ---------------------------------------------------------------------------
// Criterion 4: the week-four habit check

test("the week-four habit check is scheduled, and answered either way", () => {
  const scheduled = scheduleHabitCheck(projectId, new Date("2026-09-01T09:00:00.000Z"), "operator");
  assert.equal(scheduled.dueAt, "2026-09-29T09:00:00.000Z");
  assert.equal(scheduled.answer, null);

  // One outstanding check per project, so it cannot be quietly pushed back.
  assert.equal(
    scheduleHabitCheck(projectId, new Date("2026-09-15T09:00:00.000Z"), "operator").id,
    scheduled.id
  );

  assert.equal(habitCheckDue(projectId, new Date("2026-09-20T09:00:00.000Z")), null);
  assert.equal(habitCheckDue(projectId, new Date("2026-09-30T09:00:00.000Z"))?.id, scheduled.id);

  // The answer this check exists to catch is the discouraging one, and it
  // is recorded exactly as readily.
  const answered = answerHabitCheck(scheduled.id, "Stopped after week two; the posting step stalled.");
  assert.match(answered.answer ?? "", /Stopped after week two/);
  assert.equal(habitCheckDue(projectId, new Date("2026-09-30T09:00:00.000Z")), null);
  assert.throws(() => answerHabitCheck(scheduled.id, "actually it went fine"), /already answered/);
});

// ---------------------------------------------------------------------------
// Criterion 3: no project-specific identity, vocabulary, or assets

test("no shipped code knows the name of the first project", () => {
  const roots = ["server", "app", "render", "scripts"];
  const offenders: string[] = [];

  // The first project's identity, and the vocabulary of its niche. A second
  // project onboards with zero code changes only if none of this is in here.
  const forbidden = /keepanalog|keep analog|stationery|acceptance project/i;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|css|json|html|md)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      text.split("\n").forEach((line, index) => {
        if (forbidden.test(line)) offenders.push(`${full}:${index + 1}: ${line.trim()}`);
      });
    }
  };

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root);
  }
  assert.deepEqual(offenders, [], `project-specific text in shipped code:\n${offenders.join("\n")}`);
});

test("a second project onboards through the same path, with no code touched", async () => {
  const second = await registerProject(
    "Second Project",
    `http://127.0.0.1:${port}/second-stub`,
    "acceptance"
  );
  assert.equal(second.project.status, "healthy");
  assert.notEqual(second.project.id, projectId);
  assert.equal(second.report.passed, true);

  // Everything is scoped by project: the second one starts empty rather
  // than inheriting the first one's world.
  assert.deepEqual(learningLog(second.project.id), []);
  const slots = getDb()
    .prepare("SELECT COUNT(*) AS n FROM account_slots WHERE project_id = ?")
    .get(second.project.id) as { n: number };
  assert.equal(slots.n, 0);

  // And it can hold its own capacity immediately, with no code change.
  const slot = createSlot({
    projectId: second.project.id,
    platform: "linkedin",
    label: "Second project on LinkedIn",
    identitySpec: { kind: "page", displayName: "Second Project" },
  });
  assert.equal(slot.projectId, second.project.id);
});
