// Caps, the kill switch, and replacement (ticket 21).
//
// Decisions under test:
//   docs/issues/marketing-os/issues/12-define-account-operations-workflow.md
//     — caps and windows block rather than warn, a per-slot pause halts all
//       of its work instantly, and a lost instance archives read-only while
//       the slot spawns a replacement

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
import {
  addInstance,
  createSlot,
  currentInstance,
  getInstanceById,
  instanceView,
  lastArchivedInstance,
  listInstances,
  pauseSlot,
  replacementOf,
  resumeSlot,
  type AccountSlot,
} from "../server/accounts";
import { accountRouter } from "../server/account-routes";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { registerProject } from "../server/projects";
import {
  insideWindow,
  nextWindowOpening,
  releasedToday,
  releaseGate,
} from "../server/release-gate";
import { workOrderRouter } from "../server/work-order-routes";
import {
  approveOrder,
  claimOrder,
  createOrder,
  loseInstanceAndReplace,
  orderView,
  releaseOrder,
  submitOrder,
  type WorkOrder,
} from "../server/work-orders";

const app = express();
app.use("/api/slots", accountRouter());
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

/** A clock time today, so no test depends on when the suite runs. */
function at(clock: string): Date {
  const [hours, minutes] = clock.split(":").map(Number);
  const when = new Date();
  when.setHours(hours, minutes, 0, 0);
  return when;
}

function slot(label: string, overrides: Record<string, unknown> = {}): AccountSlot {
  return createSlot({
    projectId,
    platform: "x",
    label,
    identitySpec: { kind: "business_account", displayName: "KeepAnalog" },
    ...overrides,
  });
}

/** A slot that is open all day, so window rules are only tested where meant. */
function openSlot(label: string, overrides: Record<string, unknown> = {}): AccountSlot {
  return slot(label, { allowedWindows: [{ start: "00:00", end: "23:59" }], ...overrides });
}

function queued(overrides: Record<string, unknown> = {}): WorkOrder {
  const created = createOrder({
    projectId,
    kind: "post",
    title: "Publish the thing",
    instruction: "Publish the approved carousel.",
    ...overrides,
  });
  submitOrder(created.id);
  return approveOrder(created.id);
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
// Criterion 1: the cap blocks, and names the next window

test("a spent cap blocks the next release and says when the queue opens", () => {
  // Two posts a day, so the cap is reachable inside one test.
  const capped = openSlot("Capped", { dailyCaps: [{ action: "post", perDay: 2 }] });
  addInstance({ slotId: capped.id, handle: "@capped" });
  const noon = at("12:00");

  for (const title of ["First", "Second"]) {
    const order = queued({ slotId: capped.id, title });
    assert.equal(claimOrder(order.id, "operator", noon).status, "claimed");
  }
  assert.equal(releasedToday(capped.id, "post", noon), 2);

  const third = queued({ slotId: capped.id, title: "Third" });
  assert.throws(
    () => claimOrder(third.id, "operator", noon),
    (err: Error) => {
      assert.match(err.message, /released 2 of 2 post orders today/);
      assert.match(err.message, /The queue opens tomorrow at 00:00/);
      // Said every time the cap is named: it is ours.
      assert.match(err.message, /judgment call, not a platform-sanctioned volume/);
      return true;
    }
  );
  // It blocked. The third order did not move and opened no attempt.
  assert.equal(getOrderStatus(third.id), "queued");
});

function getOrderStatus(orderId: number): string {
  return (getDb().prepare("SELECT status FROM work_orders WHERE id = ?").get(orderId) as {
    status: string;
  }).status;
}

test("the cap counts one piece of work once, however often it is picked up", () => {
  const capped = openSlot("Recount", { dailyCaps: [{ action: "post", perDay: 2 }] });
  addInstance({ slotId: capped.id, handle: "@recount" });
  const noon = at("12:00");

  const order = queued({ slotId: capped.id, title: "Picked up twice" });
  claimOrder(order.id, "operator", noon);
  releaseOrder(order.id);
  claimOrder(order.id, "operator", noon);
  assert.equal(releasedToday(capped.id, "post", noon), 1);
});

test("only the capped action is counted, and an uncapped order is not volume", () => {
  const capped = openSlot("Only posts", { dailyCaps: [{ action: "post", perDay: 1 }] });
  addInstance({ slotId: capped.id, handle: "@onlyposts" });
  const noon = at("12:00");

  claimOrder(queued({ slotId: capped.id, title: "The one post" }).id, "operator", noon);

  // A measuring order hands out no platform action, so no cap governs it.
  const measuring = queued({ slotId: capped.id, kind: "measure", title: "Read the numbers" });
  assert.equal(claimOrder(measuring.id, "operator", noon).status, "claimed");
  assert.equal(releasedToday(capped.id, "post", noon), 1);
});

test("a cap on another slot is another slot's cap", () => {
  const mine = openSlot("Mine", { dailyCaps: [{ action: "post", perDay: 1 }] });
  const theirs = openSlot("Theirs", { dailyCaps: [{ action: "post", perDay: 1 }] });
  addInstance({ slotId: mine.id, handle: "@mine" });
  addInstance({ slotId: theirs.id, handle: "@theirs" });
  const noon = at("12:00");

  claimOrder(queued({ slotId: mine.id, title: "Mine" }).id, "operator", noon);
  assert.equal(
    claimOrder(queued({ slotId: theirs.id, title: "Theirs" }).id, "operator", noon).status,
    "claimed"
  );
});

// ---------------------------------------------------------------------------
// Windows

test("outside its windows the queue is shut, and the refusal names the next opening", () => {
  const windowed = slot("Windowed", {
    allowedWindows: [
      { start: "09:00", end: "12:00" },
      { start: "17:00", end: "20:00" },
    ],
  });
  addInstance({ slotId: windowed.id, handle: "@windowed" });

  assert.equal(insideWindow(windowed, at("10:00")), true);
  assert.equal(insideWindow(windowed, at("12:00")), false, "the end of a window is not inside it");
  assert.equal(insideWindow(windowed, at("13:00")), false);
  assert.equal(nextWindowOpening(windowed, at("13:00")), "today at 17:00");
  assert.equal(nextWindowOpening(windowed, at("21:00")), "tomorrow at 09:00");

  const order = queued({ slotId: windowed.id, title: "Too early" });
  assert.throws(
    () => claimOrder(order.id, "operator", at("08:00")),
    /outside its allowed windows. The queue opens today at 09:00/
  );
  assert.equal(claimOrder(order.id, "operator", at("09:30")).status, "claimed");
});

test("a slot nobody restricted is open, not permanently shut", () => {
  const unrestricted = slot("No windows", { allowedWindows: [] });
  addInstance({ slotId: unrestricted.id, handle: "@anytime" });
  assert.equal(insideWindow(unrestricted, at("03:00")), true);
  assert.equal(nextWindowOpening(unrestricted, at("03:00")), null);
  assert.equal(
    claimOrder(queued({ slotId: unrestricted.id, title: "Any time" }).id, "operator", at("03:00"))
      .status,
    "claimed"
  );
});

// ---------------------------------------------------------------------------
// Criterion 2: the kill switch stops releases immediately and visibly

test("pausing a slot stops its releases at once, and says so before anyone tries", () => {
  const halted = openSlot("Kill switch");
  addInstance({ slotId: halted.id, handle: "@halted" });
  const order = queued({ slotId: halted.id, title: "Halted work" });
  const noon = at("12:00");

  assert.equal(releaseGate(order, noon).open, true);
  pauseSlot(halted.id);

  // Immediately: the order that was releasable a moment ago is not.
  const gate = releaseGate(order, noon);
  assert.equal(gate.open, false);
  assert.equal(gate.reason, "paused");
  assert.match(gate.message, /is paused\. Nothing is handed out for this slot/);
  assert.throws(() => claimOrder(order.id, "operator", noon), /is paused/);
  assert.equal(getOrderStatus(order.id), "queued");

  // Visibly: the order's own view carries the reason without a move being
  // attempted.
  const view = orderView(order) as { release: { open: boolean; reason: string } };
  assert.deepEqual({ open: view.release.open, reason: view.release.reason }, {
    open: false,
    reason: "paused",
  });

  // Warming, not ready: resuming restores what the slot had earned, and
  // this instance has evidenced nothing yet.
  assert.equal(resumeSlot(halted.id).status, "warming");
  assert.equal(claimOrder(order.id, "operator", noon).status, "claimed");
});

test("the kill switch outranks the window and the cap in what it says", () => {
  const halted = slot("Precedence", {
    allowedWindows: [{ start: "09:00", end: "12:00" }],
    dailyCaps: [{ action: "post", perDay: 0 }],
  });
  addInstance({ slotId: halted.id, handle: "@precedence" });
  pauseSlot(halted.id);
  const order = queued({ slotId: halted.id, title: "Everything is shut" });
  // A paused slot is never told it is merely outside its window.
  assert.equal(releaseGate(order, at("23:00")).reason, "paused");
});

test("work that acts as the account waits for the account", () => {
  const empty = openSlot("Empty");
  const order = queued({ slotId: empty.id, title: "Nobody to post as" });
  const gate = releaseGate(order, at("12:00"));
  assert.equal(gate.reason, "no_instance");
  assert.throws(() => claimOrder(order.id, "operator", at("12:00")), /holds no account/);

  // Provisioning is how the slot gets one, so it is not made to wait for it.
  const provisioning = queued({ slotId: empty.id, kind: "provision", title: "Create it" });
  assert.equal(releaseGate(provisioning, at("12:00")).open, true);
});

test("an order with no slot is governed by no slot's rails", () => {
  assert.equal(releaseGate(queued({ title: "Slotless" }), at("03:00")).open, true);
});

// ---------------------------------------------------------------------------
// Criterion 3: replacement preserves the archived instance and links it

test("a replacement keeps the archived instance and links to it both ways", () => {
  const losing = openSlot("Replacement");
  const lost = addInstance({ slotId: losing.id, handle: "@first" });
  const outcome = loseInstanceAndReplace(lost.id, "suspended for automation");

  // Archived read-only, with its reason and its history intact.
  const archived = getInstanceById(lost.id)!;
  assert.equal(archived.archived, true);
  assert.equal(archived.health, "lost");
  assert.equal(archived.lostReason, "suspended for automation");
  assert.equal(archived.handle, "@first");
  assert.equal(outcome.slot.status, "replacing");
  assert.equal(outcome.replacement?.kind, "replace");
  assert.equal(outcome.replacement?.status, "queued");

  const replacement = addInstance({ slotId: losing.id, handle: "@second" });
  assert.equal(replacement.replacesInstanceId, lost.id);
  assert.equal(replacementOf(lost.id)?.id, replacement.id);
  assert.equal(lastArchivedInstance(losing.id)?.id, lost.id);

  // Both ends of the chain are reachable from either surface.
  assert.equal((instanceView(replacement) as { replaces: number | null }).replaces, lost.id);
  assert.equal(
    (instanceView(archived) as { replacedBy: number | null }).replacedBy,
    replacement.id
  );

  // The slot keeps both: losing an account does not lose what it did.
  assert.deepEqual(
    listInstances(losing.id).map((i) => i.handle),
    ["@second", "@first"]
  );
  assert.equal(currentInstance(losing.id)?.id, replacement.id);
});

test("a first instance replaces nothing", () => {
  const fresh = openSlot("Fresh");
  assert.equal(addInstance({ slotId: fresh.id, handle: "@fresh" }).replacesInstanceId, null);
});

// ---------------------------------------------------------------------------
// The HTTP surface

test("the rails are readable over HTTP before a move is attempted", async () => {
  const halted = openSlot("HTTP rails");
  addInstance({ slotId: halted.id, handle: "@httprails" });
  const order = queued({ slotId: halted.id, title: "HTTP halted" });
  pauseSlot(halted.id);

  const gate = await api<{ release: { open: boolean; reason: string; message: string } }>(
    `/api/work-orders/${order.id}/release`
  );
  assert.equal(gate.status, 200);
  assert.equal(gate.body.release.open, false);
  assert.equal(gate.body.release.reason, "paused");

  const claimed = await api<{ error: string }>(`/api/work-orders/${order.id}/claim`, {
    method: "POST",
  });
  assert.equal(claimed.status, 409);
  assert.match(claimed.body.error, /is paused/);
});

test("losing an instance over HTTP archives it and queues the replacement", async () => {
  const losing = openSlot("HTTP loss");
  const lost = addInstance({ slotId: losing.id, handle: "@httplost" });
  const res = await api<{
    instance: { archived: boolean; lostReason: string; replacedBy: number | null };
    slot: { status: string };
    replacementOrder: { kind: string; status: string } | null;
  }>(`/api/slots/${losing.id}/lost`, {
    method: "POST",
    body: JSON.stringify({ instanceId: lost.id, reason: "handle was taken over" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.instance.archived, true);
  assert.equal(res.body.instance.lostReason, "handle was taken over");
  assert.equal(res.body.slot.status, "replacing");
  assert.deepEqual(
    { kind: res.body.replacementOrder?.kind, status: res.body.replacementOrder?.status },
    { kind: "replace", status: "queued" }
  );
});

test("a halted slot queues no replacement work at all", async () => {
  const halted = openSlot("Halted loss");
  const lost = addInstance({ slotId: halted.id, handle: "@haltedloss" });
  pauseSlot(halted.id);
  const res = await api<{ replacementOrder: unknown; note: string }>(
    `/api/slots/${halted.id}/lost`,
    { method: "POST", body: JSON.stringify({ instanceId: lost.id, reason: "gone while paused" }) }
  );
  assert.equal(res.body.replacementOrder, null);
  assert.match(res.body.note, /no replacement work was queued/);
});
