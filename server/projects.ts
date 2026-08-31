// Connected Project registration and service-token custody.
//
// Registration mints a dedicated scoped service token via the custody module,
// runs the conformance suite v0 against the project domain, and marks the
// project healthy only on pass. Rotation re-mints the token in place, without
// re-registration. An unhealthy project is unusable until conformance passes.

import { createHash, randomBytes } from "node:crypto";
import { audit } from "./audit";
import { runConformance, type ConformanceReport } from "./conformance";
import { getDb } from "./db";
import { resolveSecret, rotateSecret, storeSecret } from "./secrets";

export class ProjectError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newProjectToken(): string {
  return `mosproj_${randomBytes(24).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ProjectRow {
  id: number;
  name: string;
  base_url: string;
  status: "healthy" | "unhealthy";
  token_hash: string;
  token_secret_reference: string;
  token_version: number;
  last_conformance_at: string | null;
  last_conformance_report: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectedProject {
  id: number;
  name: string;
  baseUrl: string;
  status: "healthy" | "unhealthy";
  tokenVersion: number;
  lastConformanceAt: string | null;
  lastConformanceReport: ConformanceReport | null;
  createdAt: string;
}

function toProject(row: ProjectRow): ConnectedProject {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    status: row.status,
    tokenVersion: row.token_version,
    lastConformanceAt: row.last_conformance_at,
    lastConformanceReport: row.last_conformance_report
      ? (JSON.parse(row.last_conformance_report) as ConformanceReport)
      : null,
    createdAt: row.created_at,
  };
}

function getRow(id: number): ProjectRow {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as
    | ProjectRow
    | undefined;
  if (!row) throw new ProjectError("Unknown Connected Project", 404);
  return row;
}

export function listProjects(): ConnectedProject[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY created_at DESC, id DESC")
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function isActiveProjectTokenHash(hash: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM projects WHERE token_hash = ?")
    .get(hash) as { id: number } | undefined;
  return row !== undefined;
}

// Gate for every project.* consumer: an unhealthy project is unusable.
export function requireHealthyProject(id: number): ConnectedProject {
  const project = toProject(getRow(id));
  if (project.status !== "healthy") {
    throw new ProjectError(
      `Connected Project '${project.name}' is unhealthy and unusable until it passes conformance`,
      409
    );
  }
  return project;
}

export async function registerProject(
  name: string,
  baseUrl: string,
  actor: string
): Promise<{ token: string; project: ConnectedProject; report: ConformanceReport }> {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM projects WHERE base_url = ?")
    .get(baseUrl) as { id: number } | undefined;
  if (existing) {
    throw new ProjectError("A project is already registered for this domain", 409);
  }

  const token = newProjectToken();
  const reference = await storeSecret("project-service-token", token, actor);
  const info = db
    .prepare(
      `INSERT INTO projects (name, base_url, token_hash, token_secret_reference)
       VALUES (?, ?, ?, ?)`
    )
    .run(name, baseUrl, hashToken(token), reference);
  const id = Number(info.lastInsertRowid);
  audit(actor, "project.registered", { projectId: id, name, baseUrl });

  const report = await runConformanceFor(id, actor);
  return { token, project: toProject(getRow(id)), report };
}

// Resolves a project's service token from custody for in-process consumers
// (e.g. the MCP gateway reading the project domain). Never expose it outward.
export async function projectServiceToken(id: number, actor: string): Promise<string> {
  const row = getRow(id);
  return resolveSecret(row.token_secret_reference, actor);
}

export async function runConformanceFor(
  id: number,
  actor: string
): Promise<ConformanceReport> {
  const row = getRow(id);
  const token = await resolveSecret(row.token_secret_reference, actor);
  const report = await runConformance(row.base_url, token);
  getDb()
    .prepare(
      `UPDATE projects
       SET status = ?, last_conformance_at = ?, last_conformance_report = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      report.passed ? "healthy" : "unhealthy",
      report.ranAt,
      JSON.stringify(report),
      nowIso(),
      id
    );
  audit(actor, "project.conformance_run", {
    projectId: id,
    passed: report.passed,
    failed: report.checks.filter((c) => !c.passed).map((c) => c.name),
  });
  return report;
}

// Rotation mints a fresh token in place: same project row, same secret
// reference, no re-registration. The old token stops verifying immediately.
export async function rotateProjectToken(
  id: number,
  actor: string
): Promise<{ token: string; project: ConnectedProject }> {
  const row = getRow(id);
  const token = newProjectToken();
  await rotateSecret(row.token_secret_reference, token, actor);
  getDb()
    .prepare(
      "UPDATE projects SET token_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?"
    )
    .run(hashToken(token), nowIso(), id);
  audit(actor, "project.token_rotated", { projectId: id, version: row.token_version + 1 });
  return { token, project: toProject(getRow(id)) };
}
