// Atomic edit batches and version history (ticket 10). Property tests hold
// the invariants — no lost human writes, append-only history, restore-as-
// new-version — and contract tests replay the CreativePieceMachine
// stale-write and unknown-op scenarios.

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
import { selectProject } from "../server/gateway";
import {
  applyEditBatch,
  listVersions,
  MAX_BATCH_OPS,
  REOPEN_PATH,
  restoreVersion,
  type EditOp,
} from "../server/piece-edits";
import { createPiece, getPiece, type PieceDoc } from "../server/pieces";
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

const SESSION = "edits-session-keepanalog";
const OTHER_SESSION = "edits-session-partnr";

function doc(): PieceDoc {
  return {
    format: "4:5",
    slides: [
      {
        layers: [
          { type: "text", text: "Headline", role: "headline" },
          { type: "shape", shape: "rect", fill: "#1A6B54" },
        ],
      },
      { layers: [{ type: "text", text: "Second slide" }] },
    ],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
  };
}

function makePiece(title: string): { id: number; doc: PieceDoc } {
  const created = createPiece(SESSION, { title, doc: doc() });
  assert.equal(created.ok, true);
  const piece = created.response.piece as { id: number; doc: PieceDoc };
  return { id: piece.id, doc: piece.doc };
}

function readPiece(id: number): { doc: PieceDoc; docVersion: number } {
  const read = getPiece(SESSION, id);
  assert.equal(read.ok, true);
  return read.response.piece as { doc: PieceDoc; docVersion: number };
}

// Small deterministic PRNG so the property runs are reproducible.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test.before(async () => {
  const a = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  const b = await registerProject("partnr", `http://127.0.0.1:${port}/partnr`, "test");
  assert.equal(a.project.status, "healthy");
  assert.equal(b.project.status, "healthy");
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
  assert.equal((await selectProject(OTHER_SESSION, "partnr")).ok, true);
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Property tests

test("property: no lost human writes — stale batches change nothing across random interleavings", () => {
  const rand = prng(101);
  const { id } = makePiece("property no lost writes");
  let version = 1;
  let expected = readPiece(id).doc;

  for (let i = 0; i < 60; i++) {
    const value = `edit ${i}`;
    const op: EditOp =
      rand() < 0.5
        ? { op: "set_text", slide: 0, layer: 0, value }
        : { op: "set_caption", network: "instagram", value };
    const stale = rand() < 0.4 && version > 1;
    const baseVersion = stale ? Math.max(1, version - 1) : version;
    const result = applyEditBatch(SESSION, { id, baseVersion, ops: [op] });

    if (stale) {
      assert.equal(result.ok, false);
      assert.equal(result.response.error, "version_conflict");
      const after = readPiece(id);
      assert.equal(after.docVersion, version);
      assert.deepEqual(after.doc, expected);
    } else {
      assert.equal(result.ok, true);
      version += 1;
      if (op.op === "set_text") {
        const layer = expected.slides[0].layers[0];
        if (layer.type === "text") layer.text = value;
      } else {
        expected.captions.instagram = value;
      }
      const after = readPiece(id);
      assert.equal(after.docVersion, version);
      assert.deepEqual(after.doc, expected);
    }
  }
});

test("property: history is append-only — versions only grow, old entries never change, and the table refuses rewrites", () => {
  const rand = prng(202);
  const { id } = makePiece("property append-only");
  const seen = new Map<number, string>();

  const record = () => {
    const listed = listVersions(SESSION, id);
    assert.equal(listed.ok, true);
    const versions = listed.response.versions as { version: number; summary: string }[];
    for (let i = 0; i < versions.length; i++) {
      assert.equal(versions[i].version, i + 1); // dense, ascending, starting at 1
      const prior = seen.get(versions[i].version);
      if (prior !== undefined) assert.equal(versions[i].summary, prior);
      seen.set(versions[i].version, versions[i].summary);
    }
    return versions.length;
  };

  let count = record();
  assert.equal(count, 1); // creation seeds version 1

  for (let i = 0; i < 40; i++) {
    const { docVersion } = readPiece(id);
    if (rand() < 0.3 && count > 1) {
      const target: number = 1 + Math.floor(rand() * count);
      assert.equal(restoreVersion(SESSION, { id, version: target }).ok, true);
    } else {
      const result = applyEditBatch(SESSION, {
        id,
        baseVersion: docVersion,
        ops: [{ op: "set_caption", network: "x", value: `v${i}` }],
      });
      assert.equal(result.ok, true);
    }
    const next = record();
    assert.equal(next, count + 1);
    count = next;
  }

  assert.throws(
    () => getDb().prepare("UPDATE piece_versions SET summary = 'rewritten' WHERE piece_id = ?").run(id),
    /append-only/
  );
  assert.throws(
    () => getDb().prepare("DELETE FROM piece_versions WHERE piece_id = ?").run(id),
    /append-only/
  );
});

test("property: restore creates a new version whose document equals the restored one", () => {
  const rand = prng(303);
  const { id } = makePiece("property restore");
  const docsByVersion = new Map<number, PieceDoc>();
  docsByVersion.set(1, readPiece(id).doc);

  for (let i = 0; i < 10; i++) {
    const { docVersion } = readPiece(id);
    assert.equal(
      applyEditBatch(SESSION, {
        id,
        baseVersion: docVersion,
        ops: [{ op: "set_text", slide: 1, layer: 0, value: `body ${i}` }],
      }).ok,
      true
    );
    docsByVersion.set(docVersion + 1, readPiece(id).doc);
  }

  for (let i = 0; i < 10; i++) {
    const before = readPiece(id).docVersion;
    const target = 1 + Math.floor(rand() * before);
    const restored = restoreVersion(SESSION, { id, version: target });
    assert.equal(restored.ok, true);
    const after = readPiece(id);
    assert.equal(after.docVersion, before + 1); // new version, nothing rewritten
    assert.deepEqual(after.doc, docsByVersion.get(target));
    docsByVersion.set(after.docVersion, after.doc);
  }
});

// ---------------------------------------------------------------------------
// Contract tests: CreativePieceMachine scenarios

test("contract: stale write — the operator saves first, the stale host batch is rejected, the retry succeeds", () => {
  const { id } = makePiece("contract stale write");

  // Operator saves an edit (v1 → v2).
  const operator = applyEditBatch(
    SESSION,
    { id, baseVersion: 1, ops: [{ op: "set_text", slide: 0, layer: 0, value: "Operator headline" }] },
    "operator"
  );
  assert.equal(operator.ok, true);

  // AI Host writes against stale v1 → rejected, nothing changed.
  const stale = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_text", slide: 0, layer: 0, value: "Host headline" }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.response.error, "version_conflict");
  const after = readPiece(id);
  assert.equal(after.docVersion, 2);
  const headline = after.doc.slides[0].layers[0];
  assert.equal(headline.type === "text" && headline.text, "Operator headline");

  // AI Host retries against the fresh version → applied.
  const retry = applyEditBatch(SESSION, {
    id,
    baseVersion: 2,
    ops: [{ op: "set_text", slide: 0, layer: 0, value: "Host headline" }],
  });
  assert.equal(retry.ok, true);
  assert.equal(readPiece(id).docVersion, 3);
});

test("contract: unknown op — the whole batch is discarded and the piece is unchanged", () => {
  const { id } = makePiece("contract unknown op");
  const before = readPiece(id);

  const result = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [
      { op: "set_caption", network: "instagram", value: "would be lost" },
      { op: "rotate_layer", slide: 0, layer: 0, degrees: 90 },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "invalid_batch");

  const after = readPiece(id);
  assert.equal(after.docVersion, before.docVersion);
  assert.deepEqual(after.doc, before.doc);
});

test("structural errors reject the whole batch: missing targets, unknown networks, too many ops", () => {
  const { id } = makePiece("structural rejects");
  const before = readPiece(id);

  const missingLayer = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [
      { op: "set_caption", network: "x", value: "fine" },
      { op: "set_text", slide: 0, layer: 9, value: "no such layer" },
    ],
  });
  assert.equal(missingLayer.ok, false);
  assert.equal(missingLayer.response.error, "invalid_batch");

  const missingSlide = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "remove_layer", slide: 7, layer: 0 }],
  });
  assert.equal(missingSlide.ok, false);

  const unknownNetwork = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_caption", network: "myspace", value: "hi" }],
  });
  assert.equal(unknownNetwork.ok, false);

  const tooMany = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({
      op: "set_caption",
      network: "x",
      value: "spam",
    })),
  });
  assert.equal(tooMany.ok, false);

  const after = readPiece(id);
  assert.equal(after.docVersion, before.docVersion);
  assert.deepEqual(after.doc, before.doc);
});

test("invalid cosmetic values fall back with a warning instead of rejecting the batch", () => {
  const { id } = makePiece("cosmetic fallback");

  const result = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_fill", slide: 0, layer: 1, value: "hot pink!!" }],
  });
  assert.equal(result.ok, true);
  const warnings = result.response.warnings as string[];
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fell back/);

  const fill = readPiece(id).doc.slides[0].layers[1];
  assert.equal(fill.type === "shape" && fill.fill, "brand.ink");

  const valid = applyEditBatch(SESSION, {
    id,
    baseVersion: 2,
    ops: [{ op: "set_fill", slide: 0, layer: 1, value: "#112233" }],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.response.warnings, []);
});

test("editing an approved piece is refused with the reopen path named", () => {
  const { id } = makePiece("approved lockdown");
  getDb().prepare("UPDATE pieces SET status = 'approved' WHERE id = ?").run(id);

  const edit = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_caption", network: "x", value: "sneaky" }],
  });
  assert.equal(edit.ok, false);
  assert.equal(edit.response.error, "piece_not_editable");
  assert.match(String(edit.response.next), new RegExp(REOPEN_PATH.replace(/\./g, "\\.")));

  const restore = restoreVersion(SESSION, { id, version: 1 });
  assert.equal(restore.ok, false);
  assert.equal(restore.response.error, "piece_not_editable");

  assert.equal(readPiece(id).docVersion, 1);
});

test("edit surfaces stay project-scoped: cross-project batches, history reads, and restores are refused", () => {
  const { id } = makePiece("cross project edits");
  for (const result of [
    applyEditBatch(OTHER_SESSION, {
      id,
      baseVersion: 1,
      ops: [{ op: "set_caption", network: "x", value: "nope" }],
    }),
    listVersions(OTHER_SESSION, id),
    restoreVersion(OTHER_SESSION, { id, version: 1 }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "cross_project_refused");
  }
});
