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
// something.
//   1  the tables through ticket 12
//   2  the piece approval columns
//   3  the recorded outcome of a measured piece
//   4  Creative Templates
//   5  Marketing Assets and the piece image handoff state
//   6  prepared Project Change Sets
//   7  Write Receipts and single-use approvals
//   8  Account Slots, Account Instances, and readiness evidence
//   9  Work Orders, their attempts, proofs, reviews, and transitions
//  10  the capped action a Work Order hands out, and instance replacement
//  11  Content Releases, Delivery Targets, and the disclosure checklist
//  12  predeclared Experiments, observation points, and measure orders
//  13  Metric Snapshots from both observation sources
//  14  decision records and the per-project learning log
//  15  setup rail step skips
//  16  the week-four habit check
const SCHEMA_VERSION = "16";

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
    CREATE TABLE IF NOT EXISTS account_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      platform TEXT NOT NULL
        CHECK (platform IN ('instagram', 'tiktok', 'x', 'linkedin')),
      label TEXT NOT NULL,
      identity_spec TEXT NOT NULL,
      niche_keywords TEXT NOT NULL DEFAULT '[]',
      disclosure_rules TEXT NOT NULL DEFAULT '[]',
      risk_policy TEXT NOT NULL DEFAULT '{}',
      daily_caps TEXT NOT NULL DEFAULT '[]',
      allowed_windows TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'provisioning', 'warming', 'ready',
                          'active', 'impaired', 'replacing', 'paused', 'retired')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS account_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES account_slots(id),
      handle TEXT NOT NULL,
      -- A custody reference and never a credential. Nothing in this row,
      -- or anywhere downstream of it, holds the secret itself.
      credentials_reference TEXT,
      health TEXT NOT NULL DEFAULT 'unverified'
        CHECK (health IN ('unverified', 'healthy', 'impaired', 'lost')),
      lost_reason TEXT,
      -- The instance this one replaced, so a slot's history is a chain
      -- rather than a pile: the archived one keeps everything it did, and
      -- the replacement says which account it stands in for.
      replaces_instance_id INTEGER REFERENCES account_instances(id),
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      archived_at TEXT
    );
    -- Readiness is earned per instance, item by item, each with the fact
    -- that earned it. Append-only: evidence is not something to revise.
    CREATE TABLE IF NOT EXISTS readiness_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL REFERENCES account_instances(id),
      item TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (instance_id, item)
    );
    CREATE TRIGGER IF NOT EXISTS readiness_evidence_no_update
    BEFORE UPDATE ON readiness_evidence
    BEGIN
      SELECT RAISE(ABORT, 'readiness evidence is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS readiness_evidence_no_delete
    BEFORE DELETE ON readiness_evidence
    BEGIN
      SELECT RAISE(ABORT, 'readiness evidence is append-only');
    END;
    -- Work Orders: the human-work lifecycle, kept whole even with one
    -- Operator. MarketingOS never performs a platform action; an order is
    -- an instruction to a person and a place to put what came back.
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      slot_id INTEGER REFERENCES account_slots(id),
      instance_id INTEGER REFERENCES account_instances(id),
      piece_id INTEGER REFERENCES pieces(id),
      kind TEXT NOT NULL
        CHECK (kind IN ('provision', 'warmup', 'post', 'comment', 'measure', 'replace')),
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      proof_requirement TEXT NOT NULL,
      -- The readiness checklist item this order earns, when it earns one.
      readiness_item TEXT,
      -- The observation point that scheduled this measure order, when one
      -- did. Null means nobody scheduled it: an ad-hoc reading, which every
      -- surface says out loud rather than letting it pass for planned work.
      observation_id INTEGER REFERENCES experiment_observations(id),
      -- The platform action this order hands out, when it hands one out.
      -- This is what a daily cap counts; an order with no capped action
      -- (provisioning, measuring) is not platform volume and is not counted.
      capped_action TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'awaiting_brand_approval', 'queued', 'claimed',
                          'in_progress', 'proof_submitted', 'under_review',
                          'changes_requested', 'completed', 'cancelled', 'failed')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- One attempt is one claim-to-review pass. A retry is the next attempt,
    -- never an edit of the last one, so all three of these tables are
    -- insert-only and the triggers below are what make that true rather
    -- than a convention the next writer can forget.
    CREATE TABLE IF NOT EXISTS work_order_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES work_orders(id),
      attempt_no INTEGER NOT NULL,
      claimed_by TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (order_id, attempt_no)
    );
    CREATE TABLE IF NOT EXISTS work_order_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES work_order_attempts(id),
      body TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS work_order_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES work_order_attempts(id),
      decision TEXT NOT NULL CHECK (decision IN ('accepted', 'changes_requested', 'failed')),
      note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- Every transition, with its actor and its timestamp. The audit log
    -- carries the same fact; this table is what the order's own history
    -- renders from.
    CREATE TABLE IF NOT EXISTS work_order_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES work_orders(id),
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS work_order_attempts_no_update
    BEFORE UPDATE ON work_order_attempts
    BEGIN
      SELECT RAISE(ABORT, 'a Work Order attempt is a permanent record; a retry is a new attempt');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_attempts_no_delete
    BEFORE DELETE ON work_order_attempts
    BEGIN
      SELECT RAISE(ABORT, 'a Work Order attempt is a permanent record; a retry is a new attempt');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_proofs_no_update
    BEFORE UPDATE ON work_order_proofs
    BEGIN
      SELECT RAISE(ABORT, 'proof is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_proofs_no_delete
    BEFORE DELETE ON work_order_proofs
    BEGIN
      SELECT RAISE(ABORT, 'proof is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_reviews_no_update
    BEFORE UPDATE ON work_order_reviews
    BEGIN
      SELECT RAISE(ABORT, 'a review is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_reviews_no_delete
    BEFORE DELETE ON work_order_reviews
    BEGIN
      SELECT RAISE(ABORT, 'a review is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_transitions_no_update
    BEFORE UPDATE ON work_order_transitions
    BEGIN
      SELECT RAISE(ABORT, 'a transition is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS work_order_transitions_no_delete
    BEFORE DELETE ON work_order_transitions
    BEGIN
      SELECT RAISE(ABORT, 'a transition is a permanent record');
    END;
    -- A Content Release is the immutable binding between a piece and the
    -- export bundle that left the building. The digest is over the bundle's
    -- own manifest, so a release names not just "the export" but exactly
    -- the bytes that were approved. Insert-only, and the triggers below are
    -- what make that true.
    CREATE TABLE IF NOT EXISTS content_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      piece_id INTEGER NOT NULL REFERENCES pieces(id),
      export_id INTEGER NOT NULL REFERENCES piece_exports(id),
      -- One release per export bundle: re-releasing the same bytes returns
      -- the release that already exists rather than minting a second one.
      digest TEXT NOT NULL UNIQUE,
      bundle_path TEXT NOT NULL,
      manifest TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- A Delivery Target pairs one release with one Account Instance. The
    -- idempotency key is unique across the whole table, so a retried
    -- request can never become a second delivery of the same thing.
    CREATE TABLE IF NOT EXISTS delivery_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_id INTEGER NOT NULL REFERENCES content_releases(id),
      instance_id INTEGER NOT NULL REFERENCES account_instances(id),
      slot_id INTEGER NOT NULL REFERENCES account_slots(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      queue_position INTEGER NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'released_to_operator', 'posting',
                          'proof_submitted', 'verified_posted', 'failed',
                          'cancelled')),
      -- Once the work has left our hands, a cancellation is a request and
      -- says so: the flag is set, and only an acknowledgement ends it.
      cancellation_requested INTEGER NOT NULL DEFAULT 0,
      cancellation_note TEXT,
      work_order_id INTEGER REFERENCES work_orders(id),
      permalink TEXT,
      failure_reason TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- The disclosure checklist: one row per rule the slot's platform
    -- imposes, acknowledged by a person before the work is released.
    CREATE TABLE IF NOT EXISTS delivery_disclosures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL REFERENCES delivery_targets(id),
      rule TEXT NOT NULL,
      acknowledged_by TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (target_id, rule)
    );
    CREATE TRIGGER IF NOT EXISTS content_releases_no_update
    BEFORE UPDATE ON content_releases
    BEGIN
      SELECT RAISE(ABORT, 'a Content Release binds immutably to its export bundle');
    END;
    CREATE TRIGGER IF NOT EXISTS content_releases_no_delete
    BEFORE DELETE ON content_releases
    BEGIN
      SELECT RAISE(ABORT, 'a Content Release binds immutably to its export bundle');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_disclosures_no_update
    BEFORE UPDATE ON delivery_disclosures
    BEGIN
      SELECT RAISE(ABORT, 'a disclosure acknowledgement is a permanent record');
    END;
    CREATE TRIGGER IF NOT EXISTS delivery_disclosures_no_delete
    BEFORE DELETE ON delivery_disclosures
    BEGIN
      SELECT RAISE(ABORT, 'a disclosure acknowledgement is a permanent record');
    END;
    -- An Experiment is predeclared: one variable, one primary metric, the
    -- decision rule, the sample target, and the stop condition, all fixed
    -- before any work ships. The trigger below is what makes "predeclared"
    -- mean something — the declaration cannot be edited afterwards, only
    -- the status moves.
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      variable TEXT NOT NULL,
      primary_metric TEXT NOT NULL,
      decision_rule TEXT NOT NULL,
      sample_target INTEGER NOT NULL,
      stop_condition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'predeclared'
        CHECK (status IN ('predeclared', 'running', 'stopped', 'concluded')),
      declared_by TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS experiments_declaration_is_fixed
    BEFORE UPDATE ON experiments
    WHEN old.variable <> new.variable
      OR old.primary_metric <> new.primary_metric
      OR old.decision_rule <> new.decision_rule
      OR old.sample_target <> new.sample_target
      OR old.stop_condition <> new.stop_condition
      OR old.project_id <> new.project_id
    BEGIN
      SELECT RAISE(ABORT, 'an Experiment is predeclared; its declaration cannot be edited');
    END;
    CREATE TRIGGER IF NOT EXISTS experiments_no_delete
    BEFORE DELETE ON experiments
    BEGIN
      SELECT RAISE(ABORT, 'an Experiment is a permanent record');
    END;
    -- When to look, at what, and where to read it. Declared with the
    -- experiment, so nobody decides after the fact which moment counted.
    CREATE TABLE IF NOT EXISTS experiment_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      position INTEGER NOT NULL,
      label TEXT NOT NULL,
      after_hours INTEGER NOT NULL,
      metrics TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE (experiment_id, position)
    );
    CREATE TRIGGER IF NOT EXISTS experiment_observations_no_update
    BEFORE UPDATE ON experiment_observations
    BEGIN
      SELECT RAISE(ABORT, 'an observation point is declared with its experiment');
    END;
    CREATE TRIGGER IF NOT EXISTS experiment_observations_no_delete
    BEFORE DELETE ON experiment_observations
    BEGIN
      SELECT RAISE(ABORT, 'an observation point is declared with its experiment');
    END;
    -- Which deliveries this experiment is watching.
    CREATE TABLE IF NOT EXISTS experiment_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      target_id INTEGER NOT NULL REFERENCES delivery_targets(id),
      enrolled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (experiment_id, target_id)
    );
    -- One measure Work Order per observation point per delivery. The unique
    -- index is why scheduling can run again without ever double-booking a
    -- person for the same reading.
    CREATE TABLE IF NOT EXISTS observation_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      observation_id INTEGER NOT NULL REFERENCES experiment_observations(id),
      target_id INTEGER NOT NULL REFERENCES delivery_targets(id),
      order_id INTEGER NOT NULL REFERENCES work_orders(id),
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (observation_id, target_id)
    );
    -- Metric Snapshots. Two sources reach this table and both say which
    -- they were: a person reading numbers off a platform through a measure
    -- Work Order, and a product-funnel read from the project's own metrics
    -- capability. Every row carries where it came from, how it was
    -- collected, and when.
    --
    -- Insert-only, deliberately. A second observation of the same metric is
    -- another row, because two readings an hour apart are two facts and
    -- overwriting the first would destroy the only thing that makes a
    -- series a series.
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      source TEXT NOT NULL CHECK (source IN ('operator_reading', 'project_funnel')),
      collection_method TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      -- Where this reading belongs, when it belongs anywhere.
      target_id INTEGER REFERENCES delivery_targets(id),
      experiment_id INTEGER REFERENCES experiments(id),
      observation_id INTEGER REFERENCES experiment_observations(id),
      order_id INTEGER REFERENCES work_orders(id),
      -- The project's own name for the state a funnel read came out of.
      project_snapshot_id TEXT,
      project_snapshot_version INTEGER,
      -- When the numbers were true, which is not when we wrote them down.
      observed_at TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS metric_snapshots_no_update
    BEFORE UPDATE ON metric_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'an observation is never overwritten; a further reading is another row');
    END;
    CREATE TRIGGER IF NOT EXISTS metric_snapshots_no_delete
    BEFORE DELETE ON metric_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'an observation is never deleted');
    END;
    CREATE INDEX IF NOT EXISTS metric_snapshots_by_target
      ON metric_snapshots (target_id, metric, observed_at);
    -- The typed decision an experiment concluded with, and the assessment
    -- of what its evidence can and cannot carry. One per experiment, and
    -- permanent: a conclusion that could be rewritten after the next
    -- campaign would not be a record of what was believed at the time.
    CREATE TABLE IF NOT EXISTS decision_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL UNIQUE REFERENCES experiments(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      decision TEXT NOT NULL CHECK (decision IN ('repeat', 'change', 'stop')),
      -- What the evidence can support, and — said just as explicitly —
      -- what it cannot.
      supports TEXT NOT NULL,
      does_not_support TEXT NOT NULL,
      ladder_rung TEXT NOT NULL
        CHECK (ladder_rung IN ('controlled_experiment', 'within_account_comparison',
                               'pre_post_observation', 'correlated_observation',
                               'anecdote')),
      cheapest_next_observation TEXT NOT NULL,
      -- How the predeclared stop condition was met, in the Operator's words.
      stop_condition_met TEXT NOT NULL,
      sample_at_conclusion INTEGER NOT NULL,
      sample_target INTEGER NOT NULL,
      -- Funnel movements observed alongside, carried as correlations and
      -- never as the reason for the decision.
      correlated_observations TEXT NOT NULL DEFAULT '[]',
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS decision_records_no_update
    BEFORE UPDATE ON decision_records
    BEGIN
      SELECT RAISE(ABORT, 'a decision record is what was believed at the time; it is not revised');
    END;
    CREATE TRIGGER IF NOT EXISTS decision_records_no_delete
    BEFORE DELETE ON decision_records
    BEGIN
      SELECT RAISE(ABORT, 'a decision record is permanent');
    END;
    -- Steps of the setup rail the Operator chose to pass over. Skipping is
    -- a real choice and a reversible one, so it is recorded rather than
    -- inferred, and a skipped step stays on screen as skipped rather than
    -- disappearing.
    CREATE TABLE IF NOT EXISTS setup_skips (
      step TEXT PRIMARY KEY,
      skipped_by TEXT NOT NULL,
      skipped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    -- The week-four habit check. Scheduled when the acceptance pass
    -- completes and surfaced when it comes due, because the MVP's real
    -- question is whether the loop is still running a month later.
    CREATE TABLE IF NOT EXISTS habit_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      due_at TEXT NOT NULL,
      scheduled_by TEXT NOT NULL,
      scheduled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      answer TEXT,
      answered_at TEXT
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
      actor TEXT NOT NULL DEFAULT 'ai-host',
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
  addColumn(d, "work_orders", "capped_action", "TEXT");
  addColumn(
    d,
    "work_orders",
    "observation_id",
    "INTEGER REFERENCES experiment_observations(id)"
  );
  addColumn(
    d,
    "account_instances",
    "replaces_instance_id",
    "INTEGER REFERENCES account_instances(id)"
  );

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
