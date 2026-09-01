// Work Orders and the proof cycle (ticket 20).
//
// Decisions under test:
//   .scratch/marketing-os/issues/12-define-account-operations-workflow.md
//     — the typed kinds, the full lifecycle kept whole for a solo Operator,
//       append-only attempts, self-review as a real step, replacement work

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
import { addInstance, createSlot, markInstanceLost, pauseSlot, readinessFor } from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { registerProject } from "../server/projects";
import { workOrderRouter } from "../server/work-order-routes";
import {
  approveOrder,
  attemptsFor,
  beginReview,
  cancelOrder,
  claimOrder,
  completeOrder,
  createOrder,
  currentAttempt,
  failOrder,
  getOrderById,
  listOrders,
  orderCard,
  orderView,
  releaseOrder,
  requestChanges,
  retryOrder,
  spawnReplacementOrder,
  startOrder,
  submitOrder,
  submitProof,
  transitionsFor,
  type WorkOrder,
} from "../server/work-orders";

const app = express();
app.use("/api/work-orders", workOrderRouter());
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

function slot(label: string) {
  return createSlot({
    projectId,
    platform: "x",
    label,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });
}

/** A moment inside the shipped default windows, so the clock is not a variable. */
function insideAllowedWindow(): Date {
  const when = new Date();
  when.setHours(10, 0, 0, 0);
  return when;
}

function order(overrides: Record<string, unknown> = {}): WorkOrder {
  return createOrder({
    projectId,
    kind: "warmup",
    title: "Read the niche for ten minutes",
    instruction: "Read ten posts from the stationery niche and note what the good ones do.",
    ...overrides,
  });
}

/** Walk an order to where a person is holding it, mid-work. */
function inProgress(overrides: Record<string, unknown> = {}): WorkOrder {
  const created = order(overrides);
  submitOrder(created.id);
  approveOrder(created.id);
  claimOrder(created.id);
  return startOrder(created.id);
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
// The lifecycle, kept whole

test("an order walks the whole lifecycle, and every state is a named act", () => {
  const created = order({ title: "Full walk" });
  assert.equal(created.status, "draft");
  assert.equal(submitOrder(created.id).status, "awaiting_brand_approval");
  assert.equal(approveOrder(created.id).status, "queued");
  assert.equal(claimOrder(created.id).status, "claimed");
  assert.equal(startOrder(created.id).status, "in_progress");
  assert.equal(
    submitProof({ orderId: created.id, proof: "Read ten posts, noted three hooks." }).order.status,
    "proof_submitted"
  );
  assert.equal(beginReview(created.id).status, "under_review");
  assert.equal(completeOrder(created.id).order.status, "completed");

  assert.deepEqual(
    transitionsFor(created.id).map((t) => t.to),
    [
      "awaiting_brand_approval",
      "queued",
      "claimed",
      "in_progress",
      "proof_submitted",
      "under_review",
      "completed",
    ]
  );
});

test("a status only moves from where the move says it moves from", () => {
  const created = order({ title: "Out of order" });
  assert.throws(() => claimOrder(created.id), /claim happens from queued/);
  assert.throws(() => completeOrder(created.id), /complete happens from under_review/);
  submitOrder(created.id);
  assert.throws(() => submitOrder(created.id), /submit happens from draft/);
});

test("a completed order is finished: nothing moves it again", () => {
  const created = inProgress({ title: "Terminal" });
  submitProof({ orderId: created.id, proof: "done, here is the link" });
  beginReview(created.id);
  completeOrder(created.id);
  assert.throws(() => cancelOrder(created.id, "changed my mind"), /cancel happens from/);
  assert.throws(() => claimOrder(created.id), /claim happens from queued/);
});

test("cancelling and failing say why, and both are exits", () => {
  const cancelled = order({ title: "Cancelled" });
  assert.throws(() => cancelOrder(cancelled.id, "   "), /records why/);
  assert.equal(cancelOrder(cancelled.id, "the campaign was pulled").status, "cancelled");

  const failing = inProgress({ title: "Failed" });
  assert.throws(() => failOrder(failing.id, ""), /records why it failed/);
  assert.equal(failOrder(failing.id, "the account was locked mid-session").status, "failed");
  // The reason survives on the attempt, not only in the transition note.
  assert.equal(currentAttempt(failing.id)?.review?.decision, "failed");
});

// ---------------------------------------------------------------------------
// Criterion 1: no completion without proof; retries are new attempts

test("no Work Order completes without proof on the attempt being completed", () => {
  const created = inProgress({ title: "No proof" });
  // The path to completion runs through proof_submitted, so there is no
  // route to under_review that skipped it.
  assert.throws(() => beginReview(created.id), /begin_review happens from proof_submitted/);
  assert.throws(() => completeOrder(created.id), /complete happens from under_review/);

  // And the check is made again at the moment of completion, against the
  // attempt itself rather than against the status.
  submitProof({ orderId: created.id, proof: "the link" });
  beginReview(created.id);
  const db = getDb();
  const attemptId = currentAttempt(created.id)!.id;
  assert.throws(
    () => db.prepare("DELETE FROM work_order_proofs WHERE attempt_id = ?").run(attemptId),
    /permanent record/
  );
});

test("a retry is a new attempt, and the rejected one survives intact", () => {
  const created = inProgress({ title: "Retry" });
  submitProof({ orderId: created.id, proof: "a screenshot of the wrong account" });
  beginReview(created.id);
  assert.throws(() => requestChanges(created.id, "  "), /say what needs to be different/);
  assert.equal(requestChanges(created.id, "wrong account — redo on @keepanalog").status, "changes_requested");

  assert.equal(retryOrder(created.id).status, "queued");
  claimOrder(created.id);
  startOrder(created.id);
  submitProof({ orderId: created.id, proof: "https://x.com/keepanalog/status/2" });
  beginReview(created.id);
  completeOrder(created.id);

  const attempts = attemptsFor(created.id);
  assert.equal(attempts.length, 2);
  // Attempt one is exactly what it was: its own proof, and the review that
  // rejected it.
  assert.equal(attempts[0].proof?.body, "a screenshot of the wrong account");
  assert.equal(attempts[0].review?.decision, "changes_requested");
  assert.match(attempts[0].review?.note ?? "", /wrong account/);
  assert.equal(attempts[1].proof?.body, "https://x.com/keepanalog/status/2");
  assert.equal(attempts[1].review?.decision, "accepted");
});

test("an attempt is never rewritten, at the storage level", () => {
  const created = inProgress({ title: "Append only" });
  submitProof({ orderId: created.id, proof: "the first thing I said" });
  const attemptId = currentAttempt(created.id)!.id;
  const db = getDb();

  assert.throws(
    () => db.prepare("UPDATE work_order_proofs SET body = 'a better story' WHERE attempt_id = ?").run(attemptId),
    /permanent record/
  );
  assert.throws(
    () => db.prepare("UPDATE work_order_attempts SET claimed_by = 'someone else' WHERE id = ?").run(attemptId),
    /permanent record/
  );
  assert.throws(
    () => db.prepare("DELETE FROM work_order_transitions WHERE order_id = ?").run(created.id),
    /permanent record/
  );

  // Nor through the module: an attempt gets one proof, because nothing
  // returns to in_progress once that proof is in.
  assert.throws(
    () => submitProof({ orderId: created.id, proof: "actually, this one" }),
    /submit_proof happens from in_progress/
  );
});

test("review is a real step even when the reviewer is the worker", () => {
  const created = inProgress({ title: "Self review" });
  submitProof({ orderId: created.id, proof: "https://x.com/keepanalog/status/9" });
  beginReview(created.id);
  completeOrder(created.id, "reads well, hook landed");
  const attempt = currentAttempt(created.id)!;
  assert.equal(attempt.review?.decision, "accepted");
  assert.equal(attempt.review?.note, "reads well, hook landed");
  assert.equal(attempt.review?.reviewedBy, "operator");
});

test("releasing a claimed order returns it to the queue without spending the attempt", () => {
  const created = inProgress({ title: "Released" });
  assert.equal(releaseOrder(created.id).status, "queued");
  assert.equal(attemptsFor(created.id).length, 1);
  claimOrder(created.id);
  assert.equal(attemptsFor(created.id).length, 2);
});

// ---------------------------------------------------------------------------
// Criterion 2: every transition is audited with actor and timestamp

test("every transition is audited with its actor and its timestamp", () => {
  const created = order({ title: "Audited" });
  submitOrder(created.id, "operator");
  approveOrder(created.id, "operator");
  cancelOrder(created.id, "not this week", "operator");

  for (const move of transitionsFor(created.id)) {
    assert.equal(move.actor, "operator");
    assert.match(move.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(move.from !== move.to);
  }

  const audited = getDb()
    .prepare(
      "SELECT actor, action, at, detail FROM audit_log WHERE action LIKE 'work_orders.%' AND json_extract(detail, '$.orderId') = ?"
    )
    .all(created.id) as { actor: string; action: string; at: string; detail: string }[];
  assert.deepEqual(
    audited.map((row) => row.action),
    ["work_orders.created", "work_orders.submit", "work_orders.approve", "work_orders.cancel"]
  );
  for (const row of audited) {
    assert.equal(row.actor, "operator");
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("a status cannot move without leaving a transition behind", () => {
  const created = order({ title: "Traceable" });
  submitOrder(created.id);
  const moves = transitionsFor(created.id);
  assert.equal(moves.length, 1);
  assert.deepEqual(
    { from: moves[0].from, to: moves[0].to },
    { from: "draft", to: "awaiting_brand_approval" }
  );
});

// ---------------------------------------------------------------------------
// Criterion 3: a warm-up order is one instruction and a proof field

test("a warm-up order renders as one plain instruction plus a proof field", () => {
  const warming = slot("Warm-up slot");
  addInstance({ slotId: warming.id, handle: "@keepanalog" });
  const created = order({
    kind: "warmup",
    slotId: warming.id,
    title: "Ten minutes of reading",
    instruction: "Read ten posts from the stationery niche and note what the good ones do",
  });

  const card = orderCard(created);
  assert.equal(
    card.instruction,
    "On @keepanalog on x, read ten posts from the stationery niche and note what the good ones do."
  );
  // One instruction, and nothing else on the card asks for work.
  assert.equal(card.instruction.split(". ").length, 1);
  assert.equal(card.reminder, null);
  assert.deepEqual(card.proofField, {
    label: "Proof",
    placeholder: "What you did, on which account, and where — one line is enough.",
  });
  assert.deepEqual(Object.keys(card).sort(), [
    "instruction",
    "kind",
    "orderId",
    "proofField",
    "reminder",
    "title",
  ]);
});

test("a warm-up order that holds more than one instruction is refused", () => {
  assert.throws(
    () =>
      order({
        kind: "warmup",
        instruction: "Read ten posts from the niche. Then leave two comments.",
      }),
    /one instruction/
  );
  // A trailing full stop is not a second sentence.
  assert.equal(
    order({ kind: "warmup", instruction: "Read ten posts from the niche." }).kind,
    "warmup"
  );
  // The rule is the warm-up card's, not every order's: a posting order may
  // carry the context a person needs.
  assert.equal(
    order({
      kind: "post",
      instruction: "Publish the approved carousel. The caption is already in the piece.",
    }).kind,
    "post"
  );
});

test("a posting order carries the platform's own disclosure rule; a warm-up does not", () => {
  const posting = slot("Posting slot");
  addInstance({ slotId: posting.id, handle: "@keepanalog" });
  const post = order({
    kind: "post",
    slotId: posting.id,
    title: "Publish the carousel",
    instruction: "Publish the approved carousel.",
  });
  assert.match(orderCard(post).reminder ?? "", /Paid Partnership/);
  assert.equal(orderCard(order({ kind: "warmup", slotId: posting.id })).reminder, null);
});

// ---------------------------------------------------------------------------
// Where a Work Order meets the rest of the system

test("a completed order checks off the readiness item it was standing behind", () => {
  const earning = slot("Readiness slot");
  const instance = addInstance({ slotId: earning.id, handle: "@earning" });
  const created = order({
    kind: "warmup",
    slotId: earning.id,
    instanceId: instance.id,
    title: "Log an observation session",
    instruction: "Spend ten minutes reading the niche.",
    readinessItem: "observation_sessions_logged",
  });
  submitOrder(created.id);
  approveOrder(created.id);
  // The slot's allowed windows gate the claim (ticket 21), so this one is
  // taken inside one rather than whenever the suite happens to run.
  claimOrder(created.id, "operator", insideAllowedWindow());
  startOrder(created.id);
  submitProof({ orderId: created.id, proof: "Read for twelve minutes, noted four accounts." });
  beginReview(created.id);
  const outcome = completeOrder(created.id);

  assert.deepEqual(outcome.readiness, {
    item: "observation_sessions_logged",
    recorded: true,
    why: `Evidenced by Work Order #${created.id}.`,
  });
  const item = readinessFor(instance.id).find((r) => r.item === "observation_sessions_logged");
  assert.match(item?.evidence ?? "", new RegExp(`Work Order #${created.id}`));
  assert.match(item?.evidence ?? "", /noted four accounts/);
});

test("an order that earns readiness names the slot or instance it earns it for", () => {
  assert.throws(
    () => order({ readinessItem: "operator_sign_off" }),
    /names the slot or the instance/
  );
});

test("losing an instance queues the replacement work, unless the slot is halted", () => {
  const losing = slot("Loss slot");
  const instance = addInstance({ slotId: losing.id, handle: "@gone" });
  markInstanceLost(instance.id, "suspended for automation");
  const replacement = spawnReplacementOrder(losing.id, "suspended for automation");
  assert.equal(replacement?.kind, "replace");
  assert.equal(replacement?.status, "queued");
  assert.match(replacement?.instruction ?? "", /suspended for automation/);
  // It earns no checklist item: the instance that would earn one does not
  // exist until this order is done.
  assert.equal(replacement?.readinessItem, null);

  const halted = slot("Halted slot");
  const doomed = addInstance({ slotId: halted.id, handle: "@halted" });
  pauseSlot(halted.id);
  markInstanceLost(doomed.id, "lost while paused");
  assert.equal(spawnReplacementOrder(halted.id, "lost while paused"), null);
});

test("an order that publishes a piece waits for the piece to be approved", () => {
  const inserted = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc) VALUES (?, ?, 'drafting', 'snap', ?)"
    )
    .run(projectId, "Unapproved carousel", JSON.stringify({ slides: [], captions: {} }));
  const pieceId = Number(inserted.lastInsertRowid);
  const created = order({ kind: "post", pieceId, title: "Publish it" });
  submitOrder(created.id);
  assert.throws(() => approveOrder(created.id), /waits for the piece to be approved/);

  getDb().prepare("UPDATE pieces SET status = 'approved' WHERE id = ?").run(pieceId);
  assert.equal(approveOrder(created.id).status, "queued");
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the Work Order routes need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/work-orders")).status, 401);
  assert.equal(
    (await api("/api/work-orders", { method: "POST", body: JSON.stringify({}) })).status,
    401
  );
  cookie = saved;
});

test("the Operator walks an order end to end over HTTP", async () => {
  const created = await api<{ order: { id: number; status: string } }>("/api/work-orders", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      kind: "measure",
      title: "Read yesterday's numbers",
      instruction: "Open the analytics tab and read the reach of yesterday's post.",
    }),
  });
  assert.equal(created.status, 200);
  const id = created.body.order.id;

  for (const move of ["submit", "approve", "claim", "start"]) {
    const res = await api<{ order: { status: string } }>(`/api/work-orders/${id}/${move}`, {
      method: "POST",
    });
    assert.equal(res.status, 200, `${move} failed`);
  }

  // Completion is refused while the attempt holds no proof.
  const early = await api<{ error: string }>(`/api/work-orders/${id}/complete`, { method: "POST" });
  assert.equal(early.status, 409);

  await api(`/api/work-orders/${id}/proof`, {
    method: "POST",
    body: JSON.stringify({ proof: "Reach 1,204, read at 09:10." }),
  });
  await api(`/api/work-orders/${id}/review`, { method: "POST" });
  // A measure order files its numbers as it completes (ticket 24), so
  // completing one without them is refused.
  const numberless = await api<{ error: string }>(`/api/work-orders/${id}/complete`, {
    method: "POST",
    body: JSON.stringify({ note: "ok" }),
  });
  assert.equal(numberless.status, 400);
  assert.match(numberless.body.error, /at least one metric with its value/);

  const done = await api<{
    order: { status: string; attemptCount: number };
    snapshots: { metric: string; value: number }[];
  }>(`/api/work-orders/${id}/complete`, {
    method: "POST",
    body: JSON.stringify({ note: "ok", readings: [{ metric: "reach", value: 1204 }] }),
  });
  assert.equal(done.body.order.status, "completed");
  assert.equal(done.body.order.attemptCount, 1);
  assert.deepEqual(done.body.snapshots.map((s) => [s.metric, s.value]), [["reach", 1204]]);

  const listed = await api<{ orders: { id: number; projectName: string }[] }>("/api/work-orders");
  assert.ok(listed.body.orders.some((o) => o.id === id && o.projectName === "KeepAnalog"));
});

test("the order view carries the card, the attempts, and the history", () => {
  const created = inProgress({ title: "View" });
  submitProof({ orderId: created.id, proof: "here is the link" });
  const view = orderView(getOrderById(created.id)!) as {
    card: { instruction: string };
    attempts: { proof: { body: string } | null }[];
    history: unknown[];
    note: string;
  };
  assert.equal(view.attempts[0].proof?.body, "here is the link");
  assert.equal(view.history.length, 5);
  assert.match(view.note, /never performs a platform action/);
  assert.ok(view.card.instruction.length > 0);
});

test("orders can be listed by the slot they belong to", () => {
  const a = slot("Slot A");
  const b = slot("Slot B");
  const forA = order({ slotId: a.id, title: "A work" });
  order({ slotId: b.id, title: "B work" });
  const listed = listOrders({ slotId: a.id });
  assert.deepEqual(listed.map((o) => o.id), [forA.id]);
});
