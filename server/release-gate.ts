// The safety rails on handing work out (ticket 21; decisions:
// .scratch/marketing-os/issues/12-define-account-operations-workflow.md).
//
// Three things can shut the queue for one Account Slot, and all three block
// rather than warn. A warning that the Operator can click past is not a
// cap; it is a suggestion with a cap's name on it.
//
//   The kill switch. A paused slot hands out nothing, now, with no
//   exception and nothing to acknowledge.
//
//   The daily cap. Per slot, per platform action, counted over the orders
//   released today. When it is spent, the queue says so and names when it
//   opens again.
//
//   The allowed windows. Outside them the queue is shut, and the refusal
//   names the next opening rather than leaving the Operator to work it out.
//
// None of this automates a platform action. Caps govern only what
// MarketingOS hands to a person; the person is still the one who acts.

import { getDb } from "./db";
import { currentInstance, getSlotById, type AccountSlot } from "./accounts";
import type { WorkOrder } from "./work-orders";

export interface ReleaseGate {
  /** Whether work may be handed out for this slot right now. */
  open: boolean;
  /** What is shut, when something is. */
  reason:
    | null
    | "paused"
    | "retired"
    | "no_instance"
    | "outside_window"
    | "cap_spent";
  /** Said plainly, for a person to read. */
  message: string;
  /** When the queue opens again, in the slot's own local time. */
  nextOpensAt: string | null;
  /** The cap this order counts against, and how much of it is spent. */
  cap: { action: string; perDay: number; releasedToday: number } | null;
}

const OPEN: ReleaseGate = {
  open: true,
  reason: null,
  message: "The queue is open for this slot.",
  nextOpensAt: null,
  cap: null,
};

/** "HH:MM" as minutes past midnight, or null when it is not a time at all. */
function minutesOf(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

function clockOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

interface Window {
  start: number;
  end: number;
}

function windowsOf(slot: AccountSlot): Window[] {
  return slot.allowedWindows
    .map((w) => ({ start: minutesOf(w.start), end: minutesOf(w.end) }))
    .filter((w): w is Window => w.start !== null && w.end !== null && w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

export function insideWindow(slot: AccountSlot, now: Date): boolean {
  const windows = windowsOf(slot);
  // A slot with no usable window is not a slot that is always shut; it is a
  // slot nobody restricted.
  if (windows.length === 0) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return windows.some((w) => minutes >= w.start && minutes < w.end);
}

/**
 * When the next window opens, said as a day and a clock time. `null` when
 * the slot has no windows at all, because then nothing is waiting to open.
 */
export function nextWindowOpening(slot: AccountSlot, now: Date): string | null {
  const windows = windowsOf(slot);
  if (windows.length === 0) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const later = windows.find((w) => w.start > minutes);
  return later ? `today at ${clockOf(later.start)}` : `tomorrow at ${clockOf(windows[0].start)}`;
}

/** The slot's local calendar day, which is the day a cap counts over. */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * How much of today's cap is spent: the distinct orders for this slot and
 * this action that were released to a person today. Releasing is what the
 * cap governs — not completing, because an order handed out and abandoned
 * still put a person in front of the platform.
 *
 * An order released, returned to the queue, and taken up again the same day
 * counts once. It is one piece of work.
 */
export function releasedToday(slotId: number, action: string, now: Date): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT o.id) AS n
         FROM work_orders o
         JOIN work_order_attempts a ON a.order_id = o.id
        WHERE o.slot_id = ?
          AND o.capped_action = ?
          AND date(a.claimed_at, 'localtime') = ?`
    )
    .get(slotId, action, localDay(now)) as { n: number };
  return row.n;
}

/**
 * Everything that has to hold before an order is handed to a person. The
 * order of the checks is the order of severity: the kill switch first,
 * because a paused slot should never be told it is merely outside its
 * window.
 */
export function releaseGate(order: WorkOrder, now = new Date()): ReleaseGate {
  if (order.slotId === null) return OPEN;
  const slot = getSlotById(order.slotId);
  if (!slot) return OPEN;

  if (slot.status === "paused") {
    return {
      open: false,
      reason: "paused",
      message: `"${slot.label}" is paused. Nothing is handed out for this slot until you resume it.`,
      nextOpensAt: null,
      cap: null,
    };
  }
  if (slot.status === "retired") {
    return {
      open: false,
      reason: "retired",
      message: `"${slot.label}" is retired. It hands out no further work.`,
      nextOpensAt: null,
      cap: null,
    };
  }

  // Work that acts as the account needs an account to act as. Provisioning
  // and replacement are how a slot gets one, so they are exempt.
  const needsInstance = order.kind !== "provision" && order.kind !== "replace";
  if (needsInstance && !currentInstance(slot.id)) {
    return {
      open: false,
      reason: "no_instance",
      message: `"${slot.label}" holds no account right now. Fill the slot before handing out work that acts as it.`,
      nextOpensAt: null,
      cap: null,
    };
  }

  if (!insideWindow(slot, now)) {
    const opens = nextWindowOpening(slot, now);
    return {
      open: false,
      reason: "outside_window",
      message: `"${slot.label}" is outside its allowed windows${opens ? `. The queue opens ${opens}` : ""}.`,
      nextOpensAt: opens,
      cap: null,
    };
  }

  if (order.cappedAction !== null) {
    const cap = slot.dailyCaps.find((c) => c.action === order.cappedAction);
    if (cap) {
      const spent = releasedToday(slot.id, order.cappedAction, now);
      if (spent >= cap.perDay) {
        const opens = nextDayOpening(slot, now);
        return {
          open: false,
          reason: "cap_spent",
          message:
            `"${slot.label}" has released ${spent} of ${cap.perDay} ${cap.action} orders today, which is the cap. ` +
            `The queue opens ${opens}. This cap is a MarketingOS judgment call, not a platform-sanctioned volume.`,
          nextOpensAt: opens,
          cap: { action: cap.action, perDay: cap.perDay, releasedToday: spent },
        };
      }
      return {
        ...OPEN,
        cap: { action: cap.action, perDay: cap.perDay, releasedToday: spent },
      };
    }
  }

  return OPEN;
}

/** A spent cap opens with tomorrow's first window, not at midnight. */
function nextDayOpening(slot: AccountSlot, now: Date): string {
  const windows = windowsOf(slot);
  return windows.length === 0 ? "tomorrow" : `tomorrow at ${clockOf(windows[0].start)}`;
}
