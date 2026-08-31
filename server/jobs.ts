import { getDb } from "./db";
import { log } from "./log";

type JobRow = {
  id: number;
  kind: string;
  payload: string;
};

type JobHandler = (payload: unknown) => Promise<void>;

const handlers: Record<string, JobHandler> = {
  noop: async () => {},
};

const POLL_INTERVAL_MS = 5_000;
let timer: NodeJS.Timeout | null = null;

export function startJobRunner(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  log("info", "job runner started", { pollIntervalMs: POLL_INTERVAL_MS });
}

export function stopJobRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  const db = getDb();
  const job = db
    .prepare("SELECT id, kind, payload FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1")
    .get() as JobRow | undefined;
  if (!job) return;
  db.prepare(
    "UPDATE jobs SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ).run(job.id);
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`no handler for job kind '${job.kind}'`);
    await handler(JSON.parse(job.payload));
    db.prepare(
      "UPDATE jobs SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(message, job.id);
    log("error", "job failed", { jobId: job.id, kind: job.kind, error: message });
  }
}
