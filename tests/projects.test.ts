import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

import express from "express";
import { getDb } from "../server/db";
import { runConformance } from "../server/conformance";
import {
  isActiveProjectTokenHash,
  listProjects,
  ProjectError,
  registerProject,
  requireHealthyProject,
  rotateProjectToken,
  runConformanceFor,
} from "../server/projects";
import { createStubProjectRouter, stubVerifyAgainstProjects } from "../server/stub-project";

const app = express();
app.use(
  "/stub-project",
  createStubProjectRouter(stubVerifyAgainstProjects(isActiveProjectTokenHash))
);
// A deliberately broken project domain: no auth, no contract shape.
app.get("/broken-project/manifest", (_req, res) => {
  res.json({ contractVersion: "999" });
});

const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const stubUrl = `http://127.0.0.1:${port}/stub-project`;
const brokenUrl = `http://127.0.0.1:${port}/broken-project`;

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("registering the stub project mints a token, runs conformance, and goes healthy", async () => {
  const { token, project, report } = await registerProject("Dev Stub", stubUrl, "test");
  assert.match(token, /^mosproj_[0-9a-f]{48}$/);
  assert.equal(report.passed, true);
  assert.equal(project.status, "healthy");
  assert.equal(project.tokenVersion, 1);
  assert.ok(project.lastConformanceReport);
  assert.ok(project.lastConformanceReport.checks.length >= 9);
  assert.deepEqual(requireHealthyProject(project.id), project);
});

test("project service tokens live in the custody module, never in plaintext", async () => {
  const rows = getDb()
    .prepare("SELECT token_secret_reference, token_hash FROM projects")
    .all() as { token_secret_reference: string; token_hash: string }[];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.token_secret_reference, /^secretref_[0-9a-f]{32}$/);
  }
  const dump = getDb().serialize().toString("latin1");
  assert.ok(!dump.includes("mosproj_"));
});

test("a failing conformance run leaves the project unhealthy and unusable", async () => {
  const { project, report } = await registerProject("Broken", brokenUrl, "test");
  assert.equal(report.passed, false);
  assert.equal(project.status, "unhealthy");
  assert.throws(
    () => requireHealthyProject(project.id),
    (err: unknown) => err instanceof ProjectError && /unusable/.test(err.message)
  );
  const listed = listProjects().find((p) => p.id === project.id);
  assert.equal(listed?.status, "unhealthy");
  assert.ok(listed?.lastConformanceReport?.checks.some((c) => !c.passed));
});

test("token rotation works without re-registration", async () => {
  const stub = listProjects().find((p) => p.baseUrl === stubUrl);
  assert.ok(stub);
  const before = listProjects().length;

  const { token: newToken, project } = await rotateProjectToken(stub.id, "test");
  assert.equal(project.id, stub.id);
  assert.equal(project.tokenVersion, stub.tokenVersion + 1);
  assert.equal(listProjects().length, before);

  // The new token passes conformance against the stub; a stale token fails auth.
  const fresh = await runConformance(stubUrl, newToken);
  assert.equal(fresh.passed, true);
  const stale = await runConformance(stubUrl, `${newToken}old`);
  assert.equal(stale.passed, false);

  // The stored token was rotated in custody: a stored-token re-run still passes
  // and the project stays healthy.
  const rerun = await runConformanceFor(stub.id, "test");
  assert.equal(rerun.passed, true);
  assert.equal(requireHealthyProject(stub.id).status, "healthy");
});

test("registration and rotation are audited without leaking token values", async () => {
  const rows = getDb().prepare("SELECT action, detail FROM audit_log").all() as {
    action: string;
    detail: string;
  }[];
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes("project.registered"));
  assert.ok(actions.includes("project.conformance_run"));
  assert.ok(actions.includes("project.token_rotated"));
  for (const row of rows) {
    assert.ok(!row.detail.includes("mosproj_"));
  }
});

test("duplicate registration for the same domain is rejected", async () => {
  await assert.rejects(
    () => registerProject("Dup", stubUrl, "test"),
    (err: unknown) => err instanceof ProjectError && err.status === 409
  );
});
