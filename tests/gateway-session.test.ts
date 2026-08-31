// Contract tests for the session ritual, replaying the GatewaySim reference
// transcripts from .scratch/marketing-os/prototypes/ai-host-onboarding.html:
// walkthrough 1 (cold start: guiding error, then onboard → select_project →
// pinned snapshot) and walkthrough 5 (stale & cross-project: upstream change
// blocks reads with stale_snapshot, get_snapshot re-pins, switching projects
// re-pins and reports notes, gaps surface as data).

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
import {
  getResource,
  getSnapshot,
  noProjectSelected,
  selectProject,
  sessionContext,
  SNAPSHOT_RESOURCES,
} from "../server/gateway";
import { CONTRACT_VERSION } from "../server/onboard";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type ChangesPage,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { stubVerifyAgainstProjects } from "../server/stub-project";

// A mutable project domain: `ship(resource)` simulates the Connected Project
// changing upstream, advancing the change cursor.
function mutableProjectDomain(data: Partial<Record<RequiredResource, unknown>>) {
  const entries: { cursor: number; resource: string; kind: "changed" }[] = [];
  let cursor = 0;
  const versions = new Map<RequiredResource, number>();
  const router = createProjectDomainRouter({
    manifest: () => ({
      name: "test-project",
      contractVersion: PROJECT_CONTRACT_VERSION,
      resources: [...REQUIRED_RESOURCES],
      capabilities: [],
    }),
    resource(name: RequiredResource): ResourceEnvelope {
      const value = data[name];
      const empty = value === undefined || (Array.isArray(value) && value.length === 0);
      return {
        resource: name,
        state: empty ? "empty" : "ok",
        version: versions.get(name) ?? 1,
        data: value ?? [],
      };
    },
    changes: (after: number): ChangesPage => ({
      cursor,
      entries: entries.filter((e) => e.cursor > after),
    }),
    verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
  });
  return {
    router,
    ship(resource: RequiredResource): void {
      cursor += 1;
      versions.set(resource, (versions.get(resource) ?? 1) + 1);
      entries.push({ cursor, resource, kind: "changed" });
    },
  };
}

const keepanalog = mutableProjectDomain({
  brand: { tokens: { "brand.primary": "#1A6B54" } },
  claims: [{ text: "Paper notes improve recall", status: "approved" }],
  profile: { product: "KeepAnalog", stage: "early" },
});
const partnr = mutableProjectDomain({
  brand: { tokens: { "brand.primary": "#1D5CA8" } },
  claims: [],
  profile: { product: "partnr", stage: "early" },
});

const app = express();
app.use("/keepanalog", keepanalog.router);
app.use("/partnr", partnr.router);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

test.before(async () => {
  const a = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  const b = await registerProject("partnr", `http://127.0.0.1:${port}/partnr`, "test");
  assert.equal(a.project.status, "healthy");
  assert.equal(b.project.status, "healthy");
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SESSION = "walkthrough-session";

// ---- Walkthrough 1 · Cold start ----

test("W1: a project-touching call before selection gets the guiding error with the corrective next call", async () => {
  for (const result of [
    await getResource(SESSION, "claims"),
    await getSnapshot(SESSION),
    noProjectSelected(),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "no_project_selected");
    assert.match(String(result.response.next), /marketingos\.select_project\(\{"project":/);
    assert.match(String(result.response.next), /"KeepAnalog"/);
  }
  assert.deepEqual(sessionContext(SESSION), {
    project: null,
    snapshot: null,
    contract: CONTRACT_VERSION,
  });
});

test("W1: select_project with an unknown project routes to the available list", async () => {
  const result = await selectProject(SESSION, "vinylos");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "unsupported_capability");
  assert.match(String(result.response.next), /KeepAnalog/);
  assert.match(String(result.response.next), /partnr/);
});

test("W1: select_project pins a snapshot and echoes {project, snapshot, contract}", async () => {
  const result = await selectProject(SESSION, "KeepAnalog");
  assert.equal(result.ok, true);
  const context = result.response.context as Record<string, unknown>;
  assert.equal(context.project, "KeepAnalog");
  assert.equal(context.contract, CONTRACT_VERSION);
  const snapshot = result.response.snapshot as Record<string, unknown>;
  assert.match(String(snapshot.id), /^snap-\d+-c\d+$/);
  assert.equal(context.snapshot, snapshot.id);
  assert.deepEqual(result.response.notes, []);
});

test("W1: get_resource returns snapshot data with provenance and echoes the context", async () => {
  const result = await getResource(SESSION, "claims");
  assert.equal(result.ok, true);
  assert.equal(result.response.state, "ok");
  const context = result.response.context as Record<string, unknown>;
  assert.equal(context.project, "KeepAnalog");
  const provenance = result.response.provenance as Record<string, unknown>;
  assert.equal(provenance.snapshot, context.snapshot);
  assert.equal(provenance.resource, "claims");
  assert.equal(typeof provenance.version, "number");
  assert.match(String(provenance.source), /\/resources\/claims$/);
});

test("W1: get_resource outside the snapshot surface routes to what is available", async () => {
  const result = await getResource(SESSION, "audiences");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "unsupported_capability");
  assert.match(String(result.response.next), new RegExp(SNAPSHOT_RESOURCES.join(", ")));
});

// ---- Walkthrough 5 · Stale & cross-project ----

test("W5: an upstream change makes reads refuse with stale_snapshot and the recovery path", async () => {
  keepanalog.ship("profile");
  const result = await getResource(SESSION, "profile");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "stale_snapshot");
  assert.match(String(result.response.message), /stale/);
  assert.match(String(result.response.next), /project\.get_snapshot/);
  const gaps = result.response.contextGaps as { state: string }[];
  assert.equal(gaps[0].state, "stale");
});

test("W5: get_snapshot re-pins a fresh snapshot and reads work again", async () => {
  const before = sessionContext(SESSION).snapshot;
  const refreshed = await getSnapshot(SESSION);
  assert.equal(refreshed.ok, true);
  const snapshot = refreshed.response.snapshot as Record<string, unknown>;
  assert.notEqual(snapshot.id, before);
  const read = await getResource(SESSION, "profile");
  assert.equal(read.ok, true);
  assert.equal(read.response.state, "ok");
  assert.equal((read.response.provenance as Record<string, unknown>).snapshot, snapshot.id);
});

test("W5: switching projects mid-session re-pins and reports notes about in-flight work", async () => {
  const previous = sessionContext(SESSION).snapshot;
  const result = await selectProject(SESSION, "partnr");
  assert.equal(result.ok, true);
  const context = result.response.context as Record<string, unknown>;
  assert.equal(context.project, "partnr");
  assert.notEqual(context.snapshot, previous);
  const notes = result.response.notes as string[];
  assert.equal(notes.length, 1);
  assert.match(notes[0], /KeepAnalog/);
  assert.match(notes[0], /[Ii]n-flight/);
});

test("W5: Context Gaps surface as data, not errors", async () => {
  const result = await getResource(SESSION, "claims");
  assert.equal(result.ok, true);
  assert.equal(result.response.state, "empty");
  const gaps = result.response.contextGaps as { resource: string; state: string }[];
  assert.deepEqual(gaps.map((g) => ({ resource: g.resource, state: g.state })), [
    { resource: "claims", state: "empty" },
  ]);
});

test("sessions are isolated: a fresh session still gets the guiding error", async () => {
  const result = await getSnapshot("fresh-session");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "no_project_selected");
});
