// Distribution deliveries (ticket 22).
//
// Decisions under test:
//   docs/issues/marketing-os/issues/12-define-account-operations-workflow.md
//     — exported work reaches an account by hand, verifiably
//
// The export bundle itself belongs to ticket 11 and is covered by the
// renderer tests. Here the bundle is inserted directly, because what these
// tests are about is the binding to it and the handoff after it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

import express from "express";
import { addInstance, createSlot, type AccountSlot } from "../server/accounts";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import {
  acknowledgeCancellation,
  acknowledgeDisclosure,
  cancelDelivery,
  createTarget,
  disclosureChecklist,
  failDelivery,
  getTargetById,
  listTargets,
  markPosting,
  outstandingDisclosures,
  releaseIsIntact,
  releasePiece,
  releaseToOperator,
  releaseView,
  submitDeliveryProof,
  targetByKey,
  targetView,
  verifyPosted,
  type ContentRelease,
} from "../server/deliveries";
import { deliveryRouter } from "../server/delivery-routes";
import { registerProject } from "../server/projects";
import {
  claimOrder,
  getOrderById,
  startOrder,
  submitProof,
  beginReview,
  completeOrder,
} from "../server/work-orders";

const app = express();
app.use("/api/deliveries", deliveryRouter());
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

let uniqueTitle = 0;

/** A piece that reached the far end of its lifecycle, with a bundle behind it. */
function exportedPiece(bytes = "the rendered bundle"): { pieceId: number; manifest: string } {
  uniqueTitle += 1;
  const piece = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc, doc_version) VALUES (?, ?, 'exported', 'snap', ?, 1)"
    )
    .run(projectId, `Carousel ${uniqueTitle}`, JSON.stringify({ slides: [], captions: {} }));
  const pieceId = Number(piece.lastInsertRowid);
  const manifest = JSON.stringify({ pieceId, docVersion: 1, files: [{ name: bytes }] });
  getDb()
    .prepare(
      "INSERT INTO piece_exports (piece_id, doc_version, kit_version, bundle_path, manifest) VALUES (?, 1, 1, ?, ?)"
    )
    .run(pieceId, `data/exports/piece-${pieceId}-v1`, manifest);
  return { pieceId, manifest };
}

function slot(label: string): AccountSlot {
  return createSlot({
    projectId,
    platform: "x",
    label,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
  });
}

function filledSlot(label: string): AccountSlot {
  const created = slot(label);
  addInstance({ slotId: created.id, handle: `@${label.replace(/\W/g, "").toLowerCase()}` });
  return created;
}

let keySeed = 0;
function key(): string {
  keySeed += 1;
  return `delivery-key-${keySeed}-${randomBytes(4).toString("hex")}`;
}

/** A delivery with its disclosure checklist finished. */
function readyTarget(label: string): { release: ContentRelease; targetId: number } {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const target = createTarget({
    releaseId: release.id,
    slotId: filledSlot(label).id,
    idempotencyKey: key(),
  }).target;
  for (const item of disclosureChecklist(target)) {
    acknowledgeDisclosure(target.id, item.rule);
  }
  return { release, targetId: target.id };
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
// Content Releases bind immutably to a bundle

test("a release binds to the export bundle by a digest over its manifest", () => {
  const { pieceId, manifest } = exportedPiece();
  const release = releasePiece(pieceId);
  assert.equal(release.digest, createHash("sha256").update(manifest).digest("hex"));
  assert.equal(release.pieceId, pieceId);
  assert.equal(releaseIsIntact(release), true);
  assert.match((releaseView(release) as { bundlePath: string }).bundlePath, /data\/exports\/piece-/);
});

test("the same bytes are the same release, never a second one", () => {
  const { pieceId } = exportedPiece();
  const first = releasePiece(pieceId);
  const second = releasePiece(pieceId);
  assert.equal(second.id, first.id);
});

test("a release is immutable at the storage level", () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const db = getDb();
  assert.throws(
    () => db.prepare("UPDATE content_releases SET digest = 'something else' WHERE id = ?").run(release.id),
    /binds immutably/
  );
  assert.throws(
    () => db.prepare("DELETE FROM content_releases WHERE id = ?").run(release.id),
    /binds immutably/
  );
});

test("a piece with no export, or one that never got there, has nothing to release", () => {
  const drafting = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc) VALUES (?, 'Still drafting', 'drafting', 'snap', '{}')"
    )
    .run(projectId);
  assert.throws(
    () => releasePiece(Number(drafting.lastInsertRowid)),
    /is drafting.*approved and exported first/s
  );

  const noBundle = getDb()
    .prepare(
      "INSERT INTO pieces (project_id, title, status, snapshot, doc) VALUES (?, 'No bundle', 'exported', 'snap', '{}')"
    )
    .run(projectId);
  assert.throws(() => releasePiece(Number(noBundle.lastInsertRowid)), /no export bundle to release/);
});

test("a release whose bundle moved is no longer intact, and hands out nothing", () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const target = createTarget({
    releaseId: release.id,
    slotId: filledSlot("Moved bytes").id,
    idempotencyKey: key(),
  }).target;
  for (const item of disclosureChecklist(target)) acknowledgeDisclosure(target.id, item.rule);

  // piece_exports is not append-only, so this is a real thing that can
  // happen. The release notices.
  getDb()
    .prepare("UPDATE piece_exports SET manifest = ? WHERE id = ?")
    .run(JSON.stringify({ tampered: true }), release.exportId);
  assert.equal(releaseIsIntact(release), false);
  assert.throws(() => releaseToOperator(target.id), /no longer matches the bundle it bound to/);
});

// ---------------------------------------------------------------------------
// Criterion 1: the same idempotency key can never create a second target

test("the same idempotency key can never create a second target", () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const slotId = filledSlot("Idempotent").id;
  const idempotencyKey = key();

  const first = createTarget({ releaseId: release.id, slotId, idempotencyKey });
  assert.equal(first.created, true);

  // Again, and again with different details: the key decides, not the body.
  const second = createTarget({ releaseId: release.id, slotId, idempotencyKey });
  const third = createTarget({
    releaseId: release.id,
    slotId: filledSlot("Somewhere else").id,
    idempotencyKey,
    queuePosition: 99,
  });
  assert.deepEqual(
    [second.created, third.created],
    [false, false]
  );
  assert.equal(second.target.id, first.target.id);
  assert.equal(third.target.id, first.target.id);
  assert.equal(third.target.slotId, first.target.slotId);
  assert.equal(listTargets({ releaseId: release.id }).length, 1);
  assert.equal(targetByKey(idempotencyKey)?.id, first.target.id);
});

test("the unique index is the floor under the promise, not the code path", () => {
  const { targetId } = readyTarget("Floor");
  const target = getTargetById(targetId)!;
  assert.throws(
    () =>
      getDb()
        .prepare(
          "INSERT INTO delivery_targets (release_id, instance_id, slot_id, idempotency_key, queue_position, window_start, window_end) VALUES (?, ?, ?, ?, 5, '09:00', '12:00')"
        )
        .run(target.releaseId, target.instanceId, target.slotId, target.idempotencyKey),
    /UNIQUE/
  );
});

test("deliveries queue in order, and a slot with no account takes none", () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const queueSlot = filledSlot("Ordered");
  const first = createTarget({ releaseId: release.id, slotId: queueSlot.id, idempotencyKey: key() });
  const { pieceId: other } = exportedPiece("a second bundle");
  const second = createTarget({
    releaseId: releasePiece(other).id,
    slotId: queueSlot.id,
    idempotencyKey: key(),
  });
  assert.deepEqual(
    [first.target.queuePosition, second.target.queuePosition],
    [0, 1]
  );
  assert.deepEqual(
    listTargets({ slotId: queueSlot.id }).map((t) => t.id),
    [first.target.id, second.target.id]
  );

  assert.throws(
    () =>
      createTarget({
        releaseId: release.id,
        slotId: slot("Empty slot").id,
        idempotencyKey: key(),
      }),
    /holds no account to deliver to/
  );
});

// ---------------------------------------------------------------------------
// Criterion 2: no post order releases without an intact release and a
// completed disclosure checklist

test("nothing is handed out until every disclosure rule is acknowledged", () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const target = createTarget({
    releaseId: release.id,
    slotId: filledSlot("Disclosures").id,
    idempotencyKey: key(),
  }).target;

  const checklist = disclosureChecklist(target);
  // The platform's own rule is on the list whether or not the slot copied it.
  assert.ok(checklist.some((item) => /Paid Partnership/.test(item.rule)));
  assert.equal(outstandingDisclosures(target).length, checklist.length);

  assert.throws(
    () => releaseToOperator(target.id),
    (err: Error) => {
      assert.match(err.message, /disclosure rule\(s\) are unacknowledged/);
      assert.match(err.message, /completed before the work is handed out, not after/);
      return true;
    }
  );
  assert.equal(getTargetById(target.id)?.status, "queued");
  assert.equal(getTargetById(target.id)?.workOrderId, null);

  // Acknowledge all but the last, and it still refuses.
  for (const item of checklist.slice(0, -1)) acknowledgeDisclosure(target.id, item.rule);
  assert.throws(() => releaseToOperator(target.id), /unacknowledged/);

  acknowledgeDisclosure(target.id, checklist[checklist.length - 1].rule);
  const { order } = releaseToOperator(target.id);
  assert.equal(getTargetById(target.id)?.status, "released_to_operator");
  assert.equal(order.kind, "post");
  assert.equal(order.status, "queued");
});

test("the post order carries the bundle and the checklist it was released against", () => {
  const { release, targetId } = readyTarget("Carried");
  const { order } = releaseToOperator(targetId);
  assert.match(order.instruction, new RegExp(release.bundlePath.replace(/\//g, "\\/")));
  assert.match(order.instruction, new RegExp(release.digest.slice(0, 12)));
  assert.match(order.instruction, /Paid Partnership/);
  assert.match(order.proofRequirement, /permalink/);
  assert.equal(order.cappedAction, "post");
});

test("an acknowledgement is a permanent record, and only of a real rule", () => {
  const { targetId } = readyTarget("Permanent");
  const target = getTargetById(targetId)!;
  assert.throws(
    () => acknowledgeDisclosure(targetId, "a rule nobody imposed"),
    /not one of this delivery's disclosure rules/
  );
  assert.throws(
    () => acknowledgeDisclosure(targetId, disclosureChecklist(target)[0].rule),
    /already acknowledged/
  );
  assert.throws(
    () => getDb().prepare("DELETE FROM delivery_disclosures WHERE target_id = ?").run(targetId),
    /permanent record/
  );
});

// ---------------------------------------------------------------------------
// Criterion 3: verified_posted requires proof including the permalink

test("a delivery is verified only against the destination permalink", () => {
  const { targetId } = readyTarget("Verified");
  releaseToOperator(targetId);
  markPosting(targetId);

  assert.throws(() => verifyPosted(targetId), /Verification happens on submitted proof/);
  assert.throws(
    () => submitDeliveryProof(targetId, "I posted it, trust me"),
    /the destination permalink: an https link/
  );
  assert.equal(getTargetById(targetId)?.status, "posting");

  const permalink = "https://x.com/keepanalog/status/1234567890";
  assert.equal(submitDeliveryProof(targetId, permalink).status, "proof_submitted");

  // The Work Order has to record the same destination, or the two records
  // do not agree and nothing is verified.
  const orderId = getTargetById(targetId)!.workOrderId!;
  claimOrder(orderId, "operator", insideWindow());
  startOrder(orderId);
  submitProof({ orderId, proof: "https://x.com/keepanalog/status/9999999999" });
  assert.throws(() => verifyPosted(targetId), /records a different destination/);

  assert.equal(getTargetById(targetId)?.status, "proof_submitted");
});

/** A moment inside the shipped default windows, so the clock is not a variable. */
function insideWindow(): Date {
  const when = new Date();
  when.setHours(10, 0, 0, 0);
  return when;
}

test("a delivery walks the whole path when both records agree", () => {
  const { targetId } = readyTarget("Whole path");
  const { order } = releaseToOperator(targetId);
  assert.equal(markPosting(targetId).status, "posting");

  const permalink = "https://x.com/keepanalog/status/5555555555";
  submitDeliveryProof(targetId, permalink);
  claimOrder(order.id, "operator", insideWindow());
  startOrder(order.id);
  submitProof({ orderId: order.id, proof: `Published: ${permalink}` });
  beginReview(order.id);
  completeOrder(order.id);

  const verified = verifyPosted(targetId);
  assert.equal(verified.status, "verified_posted");
  assert.equal(verified.permalink, permalink);
  assert.equal(getOrderById(order.id)?.status, "completed");
});

test("a failed delivery records why, and a retry is the next attempt", () => {
  const { targetId } = readyTarget("Retry");
  releaseToOperator(targetId);
  assert.equal(getTargetById(targetId)?.attemptCount, 1);

  assert.throws(() => failDelivery(targetId, "  "), /records why it failed/);
  const failed = failDelivery(targetId, "the account was rate-limited mid-post");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureReason, "the account was rate-limited mid-post");

  const retried = releaseToOperator(targetId);
  assert.equal(retried.target.status, "released_to_operator");
  assert.equal(retried.target.attemptCount, 2);
  assert.equal(retried.target.failureReason, null);
  // A second post order, not a rewrite of the first.
  assert.notEqual(retried.target.workOrderId, failed.workOrderId);
});

// ---------------------------------------------------------------------------
// Cancellation after release-to-operator is a request

test("cancelling before release stops the delivery; after release it only asks", () => {
  const early = readyTarget("Cancel early");
  const stopped = cancelDelivery(early.targetId, "the campaign was pulled");
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.target.status, "cancelled");

  const late = readyTarget("Cancel late");
  releaseToOperator(late.targetId);
  const asked = cancelDelivery(late.targetId, "the claim did not survive legal");
  assert.equal(asked.cancelled, false);
  assert.match(asked.message, /a request rather than a stop/);
  // The delivery does not move on its own: someone is holding it.
  assert.equal(asked.target.status, "released_to_operator");
  assert.equal(asked.target.cancellationRequested, true);
  assert.equal(asked.target.cancellationNote, "the claim did not survive legal");

  // Nor is it quietly re-released while the request stands. Even after the
  // attempt in flight fails, the outstanding request has to be settled
  // before anything is handed out again.
  failDelivery(late.targetId, "the Operator stopped when they saw the request");
  assert.throws(() => releaseToOperator(late.targetId), /cancellation request outstanding/);

  assert.equal(acknowledgeCancellation(late.targetId).status, "cancelled");
});

test("what is published cannot be cancelled from here", () => {
  const { targetId } = readyTarget("Published");
  const { order } = releaseToOperator(targetId);
  const permalink = "https://x.com/keepanalog/status/7777777777";
  submitDeliveryProof(targetId, permalink);
  claimOrder(order.id, "operator", insideWindow());
  startOrder(order.id);
  submitProof({ orderId: order.id, proof: permalink });
  verifyPosted(targetId);

  assert.throws(() => cancelDelivery(targetId, "too late"), /cannot be un-published from here/);
  assert.throws(() => failDelivery(targetId, "too late"), /is verified_posted and is over/);
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the delivery routes need a session", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await api("/api/deliveries")).status, 401);
  assert.equal((await api("/api/deliveries/releases")).status, 401);
  cookie = saved;
});

test("a repeated create is answered as the same delivery, not a second one", async () => {
  const { pieceId } = exportedPiece();
  const release = releasePiece(pieceId);
  const body = JSON.stringify({
    releaseId: release.id,
    slotId: filledSlot("HTTP idempotent").id,
    idempotencyKey: key(),
  });

  const first = await api<{ target: { id: number }; created: boolean }>("/api/deliveries", {
    method: "POST",
    body,
  });
  const second = await api<{ target: { id: number }; created: boolean }>("/api/deliveries", {
    method: "POST",
    body,
  });
  assert.deepEqual([first.status, second.status], [201, 200]);
  assert.deepEqual([first.body.created, second.body.created], [true, false]);
  assert.equal(second.body.target.id, first.body.target.id);
});

test("the Operator walks a delivery end to end over HTTP", async () => {
  const { pieceId } = exportedPiece();
  const created = await api<{ release: { id: number } }>("/api/deliveries/releases", {
    method: "POST",
    body: JSON.stringify({ pieceId }),
  });
  assert.equal(created.status, 200);

  const target = await api<{ target: { id: number; outstandingDisclosures: string[] } }>(
    "/api/deliveries",
    {
      method: "POST",
      body: JSON.stringify({
        releaseId: created.body.release.id,
        slotId: filledSlot("HTTP walk").id,
        idempotencyKey: key(),
      }),
    }
  );
  const id = target.body.target.id;

  // Releasing is refused while the checklist stands open.
  const early = await api<{ error: string }>(`/api/deliveries/${id}/release`, { method: "POST" });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /unacknowledged/);

  for (const rule of target.body.target.outstandingDisclosures) {
    const ack = await api(`/api/deliveries/${id}/disclosures`, {
      method: "POST",
      body: JSON.stringify({ rule }),
    });
    assert.equal(ack.status, 200);
  }

  const released = await api<{ target: { status: string }; order: { id: number } }>(
    `/api/deliveries/${id}/release`,
    { method: "POST" }
  );
  assert.equal(released.body.target.status, "released_to_operator");
  await api(`/api/deliveries/${id}/posting`, { method: "POST" });

  const permalink = "https://x.com/keepanalog/status/8888888888";
  const bad = await api<{ error: string }>(`/api/deliveries/${id}/proof`, {
    method: "POST",
    body: JSON.stringify({ permalink: "posted it" }),
  });
  assert.equal(bad.status, 400);

  await api(`/api/deliveries/${id}/proof`, {
    method: "POST",
    body: JSON.stringify({ permalink }),
  });
  const orderId = released.body.order.id;
  claimOrder(orderId, "operator", insideWindow());
  startOrder(orderId);
  submitProof({ orderId, proof: permalink });

  const verified = await api<{ target: { status: string; permalink: string } }>(
    `/api/deliveries/${id}/verify`,
    { method: "POST" }
  );
  assert.equal(verified.body.target.status, "verified_posted");
  assert.equal(verified.body.target.permalink, permalink);
});

test("the delivery view says what it is and what it is not", () => {
  const { targetId } = readyTarget("View");
  const view = targetView(getTargetById(targetId)!) as {
    disclosures: unknown[];
    outstandingDisclosures: string[];
    note: string;
  };
  assert.equal(view.outstandingDisclosures.length, 0);
  assert.ok(view.disclosures.length > 0);
  assert.match(view.note, /MarketingOS posts nothing/);
});
