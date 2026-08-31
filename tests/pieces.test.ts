// Creative Pieces and the PieceDoc schema (ticket 09): a host creates a
// piece bound to the pinned Project Snapshot, the Operator surface lists it,
// cross-project piece access is refused, and all four formats plus the
// per-network captions map round-trip intact.

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
  CAPTION_NETWORKS,
  createPiece,
  getPiece,
  listAllPieces,
  listPieces,
  PIECE_FORMATS,
  type PieceDoc,
} from "../server/pieces";
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
app.use("/partnr", router);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const KEEPANALOG_SESSION = "pieces-session-keepanalog";
const PARTNR_SESSION = "pieces-session-partnr";

function doc(overrides: Partial<PieceDoc> = {}): PieceDoc {
  return {
    format: "4:5",
    slides: [
      {
        layers: [
          { type: "text", text: "Your notes deserve paper", role: "headline" },
          { type: "image", ref: "asset-1", alt: "Notebook on a desk" },
          { type: "shape", shape: "rect", fill: "#1A6B54" },
          { type: "logo", variant: "mark" },
        ],
      },
    ],
    captions: {
      instagram: "Paper wins. #keepanalog",
      x: "Paper wins.",
      linkedin: "Why paper notes improve recall.",
      tiktok: "POV: your notes survive the app graveyard.",
    },
    ...overrides,
  };
}

test.before(async () => {
  const a = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  const b = await registerProject("partnr", `http://127.0.0.1:${port}/partnr`, "test");
  assert.equal(a.project.status, "healthy");
  assert.equal(b.project.status, "healthy");
  assert.equal((await selectProject(KEEPANALOG_SESSION, "KeepAnalog")).ok, true);
  assert.equal((await selectProject(PARTNR_SESSION, "partnr")).ok, true);
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("piece calls before selection get the guiding error", () => {
  const cold = "pieces-cold-session";
  for (const result of [
    createPiece(cold, { title: "t", doc: doc() }),
    getPiece(cold, 1),
    listPieces(cold),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "no_project_selected");
  }
});

test("a host creates a piece bound to the current snapshot and the Operator surface lists it", () => {
  const snapshot = sessionContext(KEEPANALOG_SESSION).snapshot;
  const created = createPiece(KEEPANALOG_SESSION, {
    title: "KeepAnalog launch teaser",
    doc: doc(),
  });
  assert.equal(created.ok, true);
  const piece = created.response.piece as Record<string, unknown>;
  assert.equal(piece.status, "backlog");
  assert.equal(piece.snapshot, snapshot);

  const listed = listPieces(KEEPANALOG_SESSION);
  assert.equal(listed.ok, true);
  const pieces = listed.response.pieces as { id: number; status: string }[];
  assert.equal(pieces.some((p) => p.id === piece.id && p.status === "backlog"), true);

  // The Operator sees it in Studio: the dashboard surface reads across projects.
  const all = listAllPieces();
  assert.equal(all.some((p) => p.id === piece.id && p.snapshot === snapshot), true);
});

test("cross-project piece access is refused", () => {
  const created = createPiece(KEEPANALOG_SESSION, {
    title: "KeepAnalog carousel",
    doc: doc(),
  });
  assert.equal(created.ok, true);
  const id = (created.response.piece as { id: number }).id;

  const fromOtherProject = getPiece(PARTNR_SESSION, id);
  assert.equal(fromOtherProject.ok, false);
  assert.equal(fromOtherProject.response.error, "cross_project_refused");

  const otherList = listPieces(PARTNR_SESSION);
  assert.equal(otherList.ok, true);
  const ids = (otherList.response.pieces as { id: number }[]).map((p) => p.id);
  assert.equal(ids.includes(id), false);

  const sameProject = getPiece(KEEPANALOG_SESSION, id);
  assert.equal(sameProject.ok, true);
});

test("all four formats and the captions map round-trip intact", () => {
  assert.deepEqual([...PIECE_FORMATS], ["4:5", "1:1", "9:16", "16:9"]);
  assert.deepEqual([...CAPTION_NETWORKS], ["instagram", "x", "linkedin", "tiktok"]);
  for (const format of PIECE_FORMATS) {
    const input = doc({ format });
    const created = createPiece(KEEPANALOG_SESSION, { title: `format ${format}`, doc: input });
    assert.equal(created.ok, true);
    const id = (created.response.piece as { id: number }).id;
    const read = getPiece(KEEPANALOG_SESSION, id);
    assert.equal(read.ok, true);
    assert.deepEqual((read.response.piece as { doc: PieceDoc }).doc, input);
  }
});

test("documents outside the PieceDoc schema are refused with invalid_schema", () => {
  const tooManySlides = doc({ slides: Array.from({ length: 21 }, () => ({ layers: [] })) });
  const missingCaption = {
    ...doc(),
    captions: { instagram: "a", x: "b", linkedin: "c" },
  };
  const badFormat = { ...doc(), format: "3:2" };
  for (const bad of [
    { title: "too many slides", doc: tooManySlides },
    { title: "missing caption", doc: missingCaption },
    { title: "bad format", doc: badFormat },
    { title: "no slides", doc: doc({ slides: [] }) },
  ]) {
    const result = createPiece(KEEPANALOG_SESSION, bad);
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "invalid_schema");
  }
});
