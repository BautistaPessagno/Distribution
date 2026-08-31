import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function dbPath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "marketingos.db");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL UNIQUE,
      recovery_code_hash TEXT NOT NULL,
      recovery_code_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      operator_id INTEGER NOT NULL REFERENCES operators(id),
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      operator_id INTEGER NOT NULL REFERENCES operators(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS host_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('oauth', 'static')),
      label TEXT NOT NULL,
      client_id TEXT,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT UNIQUE,
      access_secret_reference TEXT NOT NULL,
      refresh_secret_reference TEXT,
      access_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'unhealthy'
        CHECK (status IN ('healthy', 'unhealthy')),
      token_hash TEXT NOT NULL UNIQUE,
      token_secret_reference TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      last_conformance_at TEXT,
      last_conformance_report TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS run_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal TEXT NOT NULL,
      project TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'in_progress', 'done', 'abandoned')),
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS pieces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN ('backlog', 'drafting', 'review', 'approved', 'planned', 'exported', 'measured')),
      snapshot TEXT NOT NULL,
      doc TEXT NOT NULL,
      doc_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS secrets (
      reference TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      nonce BLOB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  d.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING"
  ).run();
}

export function checkDb(): { ok: boolean; detail: string } {
  try {
    const d = getDb();
    const mode = d.pragma("journal_mode", { simple: true }) as string;
    const row = d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (mode !== "wal") return { ok: false, detail: `journal_mode is ${mode}, expected wal` };
    if (!row) return { ok: false, detail: "meta table missing schema_version" };
    return { ok: true, detail: `wal, schema_version ${row.value}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
