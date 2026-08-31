import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-audit-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

import { getDb } from "../server/db";
import { audit } from "../server/audit";

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("audit rows can be inserted", () => {
  audit("test", "test.event", { note: "append" });
  const row = getDb()
    .prepare("SELECT actor, action FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { actor: string; action: string };
  assert.equal(row.actor, "test");
  assert.equal(row.action, "test.event");
});

test("updating an audit row is impossible at the schema level", () => {
  audit("test", "test.immutable");
  assert.throws(
    () => getDb().prepare("UPDATE audit_log SET action = 'tampered'").run(),
    /append-only/
  );
});

test("deleting an audit row is impossible at the schema level", () => {
  audit("test", "test.immutable");
  assert.throws(() => getDb().prepare("DELETE FROM audit_log").run(), /append-only/);
});
