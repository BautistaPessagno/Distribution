import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

import { getDb } from "../server/db";
import {
  storeSecret,
  resolveSecret,
  rotateSecret,
  revokeSecret,
  isSecretReference,
} from "../server/secrets";

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("storing a secret returns an opaque reference and seals the value", async () => {
  const ref = await storeSecret("service-token", "hunter2-token-value", "test");
  assert.ok(isSecretReference(ref));
  const row = getDb()
    .prepare("SELECT ciphertext, nonce FROM secrets WHERE reference = ?")
    .get(ref) as { ciphertext: Buffer; nonce: Buffer };
  assert.ok(!row.ciphertext.toString("utf8").includes("hunter2-token-value"));
  assert.equal(await resolveSecret(ref, "test"), "hunter2-token-value");
});

test("rotating a secret keeps the reference and bumps the version", async () => {
  const ref = await storeSecret("service-token", "old-value", "test");
  await rotateSecret(ref, "new-value", "test");
  assert.equal(await resolveSecret(ref, "test"), "new-value");
  const row = getDb()
    .prepare("SELECT version FROM secrets WHERE reference = ?")
    .get(ref) as { version: number };
  assert.equal(row.version, 2);
});

test("a revoked secret can no longer be resolved or rotated", async () => {
  const ref = await storeSecret("service-token", "doomed-value", "test");
  await revokeSecret(ref, "test");
  await assert.rejects(() => resolveSecret(ref, "test"), /revoked/);
  await assert.rejects(() => rotateSecret(ref, "x", "test"), /revoked/);
  const row = getDb()
    .prepare("SELECT status, length(ciphertext) AS len FROM secrets WHERE reference = ?")
    .get(ref) as { status: string; len: number };
  assert.equal(row.status, "revoked");
  assert.equal(row.len, 0);
});

test("custody operations write audit rows", async () => {
  const before = (
    getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }
  ).n;
  const ref = await storeSecret("service-token", "audited-value", "test");
  await resolveSecret(ref, "test");
  await rotateSecret(ref, "audited-value-2", "test");
  await revokeSecret(ref, "test");
  const rows = getDb()
    .prepare("SELECT action FROM audit_log WHERE id > ? ORDER BY id")
    .all(before === 0 ? 0 : before) as { action: string }[];
  const actions = rows.map((r) => r.action);
  assert.deepEqual(actions.slice(-4), [
    "secret.stored",
    "secret.resolved",
    "secret.rotated",
    "secret.revoked",
  ]);
});

test("audit rows never contain the secret value", async () => {
  await storeSecret("service-token", "must-never-leak-9876", "test");
  const rows = getDb().prepare("SELECT detail FROM audit_log").all() as { detail: string }[];
  for (const row of rows) {
    assert.ok(!row.detail.includes("must-never-leak-9876"));
  }
});
