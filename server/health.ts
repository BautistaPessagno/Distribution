import { checkDb } from "./db";

const LITESTREAM_METRICS_URL =
  process.env.LITESTREAM_METRICS_URL ?? "http://127.0.0.1:9090/metrics";

export type HealthReport = {
  status: "ok" | "degraded";
  app: { ok: boolean; version: string; uptimeSeconds: number };
  database: { ok: boolean; detail: string };
  replication: { ok: boolean; mode: "litestream" | "disabled"; detail: string };
};

export async function getHealth(): Promise<HealthReport> {
  const database = checkDb();
  const replication = await checkReplication();
  const app = {
    ok: true,
    version: process.env.APP_VERSION ?? "0.1.0",
    uptimeSeconds: Math.round(process.uptime()),
  };
  const ok = app.ok && database.ok && replication.ok;
  return { status: ok ? "ok" : "degraded", app, database, replication };
}

async function checkReplication(): Promise<HealthReport["replication"]> {
  if (process.env.LITESTREAM_ENABLED !== "1") {
    return {
      ok: true,
      mode: "disabled",
      detail: "replication disabled (LITESTREAM_ENABLED != 1); acceptable in development only",
    };
  }
  try {
    const res = await fetch(LITESTREAM_METRICS_URL, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) {
      return { ok: false, mode: "litestream", detail: `metrics endpoint returned ${res.status}` };
    }
    const body = await res.text();
    const synced = /litestream_replica_wal_index\{[^}]*\}\s+\d+/.test(body);
    return synced
      ? { ok: true, mode: "litestream", detail: "litestream replicating (wal index reported)" }
      : { ok: false, mode: "litestream", detail: "litestream up but no replica wal index yet" };
  } catch (err) {
    return {
      ok: false,
      mode: "litestream",
      detail: `litestream metrics unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
