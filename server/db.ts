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

// Bumped whenever migrate() changes shape, so checkDb's report means
// something. 1: the tables through ticket 12. 2: the piece approval columns.
const SCHEMA_VERSION = "2";

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
    CREATE TABLE IF NOT EXISTS piece_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_id INTEGER NOT NULL REFERENCES pieces(id),
      version INTEGER NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (piece_id, version)
    );
    CREATE TRIGGER IF NOT EXISTS piece_versions_no_update
    BEFORE UPDATE ON piece_versions
    BEGIN
      SELECT RAISE(ABORT, 'piece_versions is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS piece_versions_no_delete
    BEFORE DELETE ON piece_versions
    BEGIN
      SELECT RAISE(ABORT, 'piece_versions is append-only');
    END;
    CREATE TABLE IF NOT EXISTS piece_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_id INTEGER NOT NULL REFERENCES pieces(id),
      doc_version INTEGER NOT NULL,
      kit_version INTEGER,
      bundle_path TEXT NOT NULL,
      manifest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS project_changes (
      digest TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      snapshot_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      summary TEXT NOT NULL,
      change_set TEXT NOT NULL,
      diff TEXT NOT NULL,
      validations TEXT NOT NULL DEFAULT '[]',
      warnings TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      decided_at TEXT,
      decided_by TEXT
    );
    CREATE TABLE IF NOT EXISTS write_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- One receipt per digest, enforced here rather than in code: an
      -- approval is single-use, so a second application is impossible even
      -- if something upstream tried.
      digest TEXT NOT NULL UNIQUE REFERENCES project_changes(digest),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      applied_operations INTEGER NOT NULL,
      resource_versions TEXT NOT NULL DEFAULT '[]',
      next_cursor INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS write_receipts_no_update
    BEFORE UPDATE ON write_receipts
    BEGIN
      SELECT RAISE(ABORT, 'a Write Receipt is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS write_receipts_no_delete
    BEFORE DELETE ON write_receipts
    BEGIN
      SELECT RAISE(ABORT, 'a Write Receipt is a permanent record');
    END;
    -- An approval is single-use at the storage level: once consumed, no
    -- statement anywhere can move it back to something appliable.
    CREATE TRIGGER IF NOT EXISTS project_changes_used_is_final
    BEFORE UPDATE ON project_changes
    WHEN old.status = 'used'
    BEGIN
      SELECT RAISE(ABORT, 'a consumed approval cannot be changed');
    END;
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      origin TEXT NOT NULL
        CHECK (origin IN ('ai_host', 'operator_upload', 'project_import')),
      prompt TEXT,
      source_assets TEXT NOT NULL DEFAULT '[]',
      rights TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS assets_no_update
    BEFORE UPDATE ON assets
    BEGIN
      SELECT RAISE(ABORT, 'assets are immutable; register a new one');
    END;
    CREATE TABLE IF NOT EXISTS creative_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      from_piece_id INTEGER REFERENCES pieces(id),
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS brand_kits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      version INTEGER NOT NULL,
      tokens TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (project_id, version)
    );
    CREATE TRIGGER IF NOT EXISTS brand_kits_no_update
    BEFORE UPDATE ON brand_kits
    BEGIN
      SELECT RAISE(ABORT, 'brand_kits is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS brand_kits_no_delete
    BEFORE DELETE ON brand_kits
    BEGIN
      SELECT RAISE(ABORT, 'brand_kits is append-only');
    END;
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
  // Columns added to an existing table after that table shipped. CREATE
  // TABLE IF NOT EXISTS never runs again on a live database, so new columns
  // need their own idempotent step.
  addColumn(d, "pieces", "pinned_kit_version", "INTEGER");
  addColumn(d, "pieces", "brand_outdated", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "pieces", "planned_date", "TEXT");
  addColumn(d, "pieces", "outcome", "TEXT");
  addColumn(d, "pieces", "image_state", "TEXT");
  addColumn(d, "pieces", "image_prompt", "TEXT");

  d.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SCHEMA_VERSION);
}

// SQLite cannot bind identifiers, so table, column, and definition are
// interpolated. Every caller must pass a literal written in this file; the
// assertion keeps that true if one ever stops being one.
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function addColumn(
  d: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  if (!SQL_IDENTIFIER.test(table) || !SQL_IDENTIFIER.test(column)) {
    throw new Error(`addColumn takes literal identifiers, not ${table}.${column}`);
  }
  const columns = d.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
