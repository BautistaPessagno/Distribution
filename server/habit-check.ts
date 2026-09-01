// The week-four habit check (ticket 28).
//
// The MVP's real question is not whether the loop runs once but whether the
// Operator is still running it a month later. So the date is recorded when
// the acceptance pass completes, and the system surfaces it when it comes
// due rather than trusting anyone to remember.
//
// It is a commitment, not a task: what it asks is whether the habit held,
// and the answer is recorded either way. A check that only records success
// would tell us nothing we did not already assume.

import { audit } from "./audit";
import { getDb } from "./db";

export const HABIT_CHECK_WEEKS = 4;

export interface HabitCheck {
  id: number;
  projectId: number;
  dueAt: string;
  scheduledBy: string;
  scheduledAt: string;
  /** The Operator's own answer, once the date arrives. Either way. */
  answer: string | null;
  answeredAt: string | null;
}

interface Row {
  id: number;
  project_id: number;
  due_at: string;
  scheduled_by: string;
  scheduled_at: string;
  answer: string | null;
  answered_at: string | null;
}

function toCheck(row: Row): HabitCheck {
  return {
    id: row.id,
    projectId: row.project_id,
    dueAt: row.due_at,
    scheduledBy: row.scheduled_by,
    scheduledAt: row.scheduled_at,
    answer: row.answer,
    answeredAt: row.answered_at,
  };
}

export class HabitCheckError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HabitCheckError";
  }
}

/** The one question it asks, fixed so the answer is comparable across runs. */
export const HABIT_QUESTION =
  "Four weeks on: are you still running the daily loop? Say what you actually did last week, including if the answer is nothing.";

export function scheduleHabitCheck(
  projectId: number,
  from = new Date(),
  actor = "operator"
): HabitCheck {
  const existing = getDb()
    .prepare("SELECT * FROM habit_checks WHERE project_id = ? AND answer IS NULL")
    .get(projectId) as Row | undefined;
  // One outstanding check per project: a second would let the first be
  // quietly replaced with a later date every time it came due.
  if (existing) return toCheck(existing);

  const dueAt = new Date(from.getTime() + HABIT_CHECK_WEEKS * 7 * 24 * 3600 * 1000).toISOString();
  const info = getDb()
    .prepare("INSERT INTO habit_checks (project_id, due_at, scheduled_by) VALUES (?, ?, ?)")
    .run(projectId, dueAt, actor);
  audit(actor, "habit_check.scheduled", { projectId, dueAt });

  const row = getDb().prepare("SELECT * FROM habit_checks WHERE id = ?").get(
    Number(info.lastInsertRowid)
  ) as Row | undefined;
  if (!row) throw new Error("habit check did not persist");
  return toCheck(row);
}

export function outstandingHabitCheck(projectId: number): HabitCheck | null {
  const row = getDb()
    .prepare("SELECT * FROM habit_checks WHERE project_id = ? AND answer IS NULL ORDER BY due_at ASC LIMIT 1")
    .get(projectId) as Row | undefined;
  return row ? toCheck(row) : null;
}

/** Due, and therefore worth putting in front of someone. */
export function habitCheckDue(projectId: number, now = new Date()): HabitCheck | null {
  const check = outstandingHabitCheck(projectId);
  if (!check) return null;
  return new Date(check.dueAt).getTime() <= now.getTime() ? check : null;
}

/**
 * The answer, whatever it is. "I stopped after week two" is the answer this
 * check exists to catch, so it is recorded exactly as readily as the other
 * kind.
 */
export function answerHabitCheck(id: number, answer: string, actor = "operator"): HabitCheck {
  const row = getDb().prepare("SELECT * FROM habit_checks WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new HabitCheckError(404, `No habit check #${id}`);
  if (row.answer !== null) throw new HabitCheckError(409, "That check is already answered.");
  if (!answer.trim()) {
    throw new HabitCheckError(400, "The check records what actually happened, including nothing.");
  }
  getDb()
    .prepare(
      "UPDATE habit_checks SET answer = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    )
    .run(answer.trim(), id);
  audit(actor, "habit_check.answered", { habitCheckId: id, projectId: row.project_id });

  const updated = getDb().prepare("SELECT * FROM habit_checks WHERE id = ?").get(id) as Row;
  return toCheck(updated);
}

export function habitCheckView(check: HabitCheck): Record<string, unknown> {
  return {
    id: check.id,
    projectId: check.projectId,
    question: HABIT_QUESTION,
    dueAt: check.dueAt,
    scheduledBy: check.scheduledBy,
    scheduledAt: check.scheduledAt,
    answer: check.answer,
    answeredAt: check.answeredAt,
    note: "Scheduled when the acceptance pass completed. The MVP's question is whether the loop is still running a month later, so the answer is recorded either way.",
  };
}
