// Method Library and goal routing (ticket 08): each of the six capabilities
// has a versioned method retrievable by goal, unknown goals route with
// closest-goal suggestions instead of failing, and chained goals persist a
// MarketingRunPlan the Operator can inspect before generation.

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
import { selectProject, sessionContext } from "../server/gateway";
import {
  CHAINS,
  closestGoals,
  getMethod,
  getRunPlan,
  listRunPlans,
  METHODS,
} from "../server/methods";
import { METHOD_LIBRARY_VERSION, ONBOARD_GUIDE } from "../server/onboard";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { stubVerifyAgainstProjects } from "../server/stub-project";

const router = createProjectDomainRouter({
  manifest: () => ({
    name: "test-project",
    contractVersion: PROJECT_CONTRACT_VERSION,
    resources: [...REQUIRED_RESOURCES],
    capabilities: [],
  }),
  resource(name: RequiredResource): ResourceEnvelope {
    return { resource: name, state: "ok", version: 1, data: {} };
  },
  changes: () => ({ cursor: 0, entries: [] }),
  verifyToken: stubVerifyAgainstProjects(isActiveProjectTokenHash),
});

const app = express();
app.use("/keepanalog", router);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "method-library-session";
const CAPABILITIES = ["positioning", "audit", "copy", "hooks", "social", "experiments"];

test.before(async () => {
  const a = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  assert.equal(a.project.status, "healthy");
  const selected = await selectProject(SESSION, "KeepAnalog");
  assert.equal(selected.ok, true);
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("get_method before selection gets the guiding error", () => {
  const result = getMethod("fresh-method-session", "positioning");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "no_project_selected");
});

test("each of the six capabilities has a versioned method retrievable by goal", () => {
  const covered = new Set<string>();
  for (const [goal, method] of Object.entries(METHODS)) {
    const result = getMethod(SESSION, goal);
    assert.equal(result.ok, true, `goal ${goal}`);
    assert.equal(result.response.goal, goal);
    assert.equal(result.response.methodLibraryVersion, METHOD_LIBRARY_VERSION);
    assert.match(String(result.response.version), /^\d+$/);
    assert.ok((result.response.steps as string[]).length >= 3, `steps for ${goal}`);
    assert.ok(String(result.response.rubric).length > 0, `rubric for ${goal}`);
    assert.ok(
      Object.keys(result.response.outputSchema as Record<string, string>).length > 0,
      `output schema for ${goal}`
    );
    covered.add(method.capability);
  }
  assert.deepEqual([...covered].sort(), [...CAPABILITIES].sort());
});

test("get_method returns exactly one method and echoes the session context", () => {
  const result = getMethod(SESSION, "draft_copy");
  assert.equal(result.ok, true);
  assert.equal(result.response.goal, "draft_copy");
  assert.equal(result.response.runPlan, undefined);
  assert.deepEqual(result.response.context, sessionContext(SESSION));
});

test("unknown goals route with unknown_goal and closest-goal suggestions", () => {
  const result = getMethod(SESSION, "positining");
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "unknown_goal");
  const suggestions = result.response.suggestions as string[];
  assert.ok(suggestions.includes("positioning"));
  assert.match(String(result.response.next), /positioning/);
});

test("closest-goal ranking prefers containment matches", () => {
  assert.equal(closestGoals("audit")[0], "audit_website");
});

test("a chained goal persists a MarketingRunPlan naming modules, evidence inputs, artifacts, and gates", () => {
  const before = listRunPlans().length;
  const result = getMethod(SESSION, "positioning_to_social");
  assert.equal(result.ok, true);
  const runPlan = result.response.runPlan as {
    id: number;
    goal: string;
    project: string;
    snapshot: string;
    status: string;
    plan: {
      summary: string;
      modules: {
        goal: string;
        evidenceInputs: string[];
        expectedArtifact: string;
        approvalGates: string[];
      }[];
    };
  };
  assert.equal(runPlan.goal, "positioning_to_social");
  assert.equal(runPlan.project, "KeepAnalog");
  assert.equal(runPlan.snapshot, sessionContext(SESSION).snapshot);
  assert.equal(runPlan.status, "proposed");
  assert.deepEqual(
    runPlan.plan.modules.map((m) => m.goal),
    CHAINS.positioning_to_social.modules
  );
  for (const moduleEntry of runPlan.plan.modules) {
    assert.ok(moduleEntry.evidenceInputs.length > 0);
    assert.ok(moduleEntry.expectedArtifact.length > 0);
    assert.ok(moduleEntry.approvalGates.length > 0);
  }

  // Persisted for Operator inspection before generation.
  assert.equal(listRunPlans().length, before + 1);
  const stored = getRunPlan(runPlan.id);
  assert.ok(stored);
  assert.deepEqual(stored, runPlan);
});

test("every known chain resolves to existing methods", () => {
  for (const [goal, chain] of Object.entries(CHAINS)) {
    assert.ok(chain.modules.length >= 2, `chain ${goal}`);
    for (const moduleGoal of chain.modules) {
      assert.ok(METHODS[moduleGoal], `chain ${goal} module ${moduleGoal}`);
    }
  }
});

test("the onboarding guide announces the Method Library version and get_method", () => {
  assert.equal(ONBOARD_GUIDE.methodLibraryVersion, METHOD_LIBRARY_VERSION);
  assert.match(ONBOARD_GUIDE.tools["marketingos.get_method"], /Method Library/);
});
