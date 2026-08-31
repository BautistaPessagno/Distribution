import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");

import { getDb } from "../server/db";
import {
  createSession,
  destroySession,
  generateRecoveryCode,
  hashRecoveryCode,
  isPublicPath,
  operatorExists,
  validateSession,
  verifyRecoveryCode,
} from "../server/auth";

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertOperator(recoveryCode: string): number {
  const salt = randomBytes(16).toString("hex");
  const info = getDb()
    .prepare(
      "INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt) VALUES (?, ?, ?)"
    )
    .run("operator", hashRecoveryCode(recoveryCode, salt), salt);
  return Number(info.lastInsertRowid);
}

test("recovery codes are long, grouped, and unambiguous", () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.ok(!/[ILO01]/.test(code));
  assert.notEqual(code, generateRecoveryCode());
});

test("no operator exists until one is created", () => {
  assert.equal(operatorExists(), false);
  assert.equal(verifyRecoveryCode("AAAAA-AAAAA-AAAAA-AAAAA"), null);
  insertOperator(generateRecoveryCode());
  assert.equal(operatorExists(), true);
});

test("recovery code verification tolerates formatting and rejects wrong codes", () => {
  const code = generateRecoveryCode();
  getDb().prepare("DELETE FROM operators").run();
  const id = insertOperator(code);
  const operator = verifyRecoveryCode(code.toLowerCase().replace(/-/g, " "));
  assert.equal(operator?.id, id);
  assert.equal(verifyRecoveryCode("AAAAA-AAAAA-AAAAA-AAAAA"), null);
});

test("sessions validate until destroyed", () => {
  getDb().prepare("DELETE FROM operators").run();
  const id = insertOperator(generateRecoveryCode());
  const { token } = createSession(id);
  assert.equal(validateSession(token), id);
  assert.equal(validateSession("not-a-token"), null);
  assert.equal(validateSession(undefined), null);
  destroySession(token);
  assert.equal(validateSession(token), null);
});

test("expired sessions are rejected and cleaned up", () => {
  getDb().prepare("DELETE FROM operators").run();
  const id = insertOperator(generateRecoveryCode());
  const { token } = createSession(id);
  getDb()
    .prepare("UPDATE sessions SET expires_at = ?")
    .run(new Date(Date.now() - 1000).toISOString());
  assert.equal(validateSession(token), null);
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  assert.equal(row.n, 0);
});

test("route guard protects dashboard routes and leaves service routes open", () => {
  assert.equal(isPublicPath("/login"), true);
  assert.equal(isPublicPath("/api/auth/status"), true);
  assert.equal(isPublicPath("/health"), true);
  assert.equal(isPublicPath("/mcp"), true);
  assert.equal(isPublicPath("/_next/static/chunk.js"), true);
  assert.equal(isPublicPath("/"), false);
  assert.equal(isPublicPath("/dashboard"), false);
  assert.equal(isPublicPath("/loginx"), false);
});
