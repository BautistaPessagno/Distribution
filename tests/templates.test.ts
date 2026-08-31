// Creative Templates (ticket 15; reference behavior: the SAVE_AS_TEMPLATE
// case of CreativePieceMachine in creative-piece-workflow.html and the
// "strip-and-save templates" step of walkthrough 5).
//
// The two things this ticket promises:
//   1. a saved template carries no campaign text, claims, captions, or dates
//   2. instantiating one creates a fresh backlog piece with the layout intact

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
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import {
  approvePiece,
  planPiece,
  startDrafting,
  submitForReview,
} from "../server/piece-lifecycle";
import { pieceRouter } from "../server/piece-routes";
import { templateRouter } from "../server/template-routes";
import { createPiece, getPieceById, type PieceDoc, type PieceRecord } from "../server/pieces";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { renderPreview } from "../server/renderer";
import { stubVerifyAgainstProjects } from "../server/stub-project";
import {
  getTemplateById,
  instantiateTemplate,
  listTemplates,
  saveAsTemplate,
  stripToTemplate,
} from "../server/templates";

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
app.use("/vinylos", router);
app.use("/api/pieces", pieceRouter());
app.use("/api/templates", templateRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "template-session";
const OTHER_SESSION = "other-project-session";
let cookie = "";

function operatorCookie(): string {
  const salt = randomBytes(16).toString("hex");
  const inserted = getDb()
    .prepare(
      "INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt) VALUES (?, ?, ?)"
    )
    .run("operator", hashRecoveryCode("AAAAA-AAAAA-AAAAA-AAAAA", salt), salt);
  const { token } = createSession(Number(inserted.lastInsertRowid));
  return `${SESSION_COOKIE}=${token}`;
}

// A campaign-shaped document: real copy, a claim needing a source, real
// captions, and layout worth keeping — frames, token references, a logo.
function campaignDoc(): PieceDoc {
  return {
    format: "4:5",
    slides: [
      {
        layers: [
          {
            type: "text",
            text: "Five reasons paper wins",
            role: "headline",
            color: "brand.ink",
            font: "font.display",
            frame: { x: 0.08, y: 0.1, w: 0.84, h: 0.2 },
          },
          {
            type: "text",
            text: "Rated best notebook of 2026 by [NEED: source]",
            frame: { x: 0.08, y: 0.34, w: 0.84, h: 0.1 },
          },
          {
            type: "shape",
            shape: "rect",
            fill: "brand.accent",
            frame: { x: 0.08, y: 0.5, w: 0.4, h: 0.06 },
          },
        ],
      },
      {
        layers: [
          { type: "image", ref: "asset://hero", alt: "A stack of notebooks" },
          { type: "logo", variant: "wordmark" },
        ],
      },
    ],
    captions: {
      instagram: "Our best seller is back in stock 📓",
      x: "Back in stock. Thread below.",
      linkedin: "Why we reprinted the 2026 edition",
      tiktok: "the notebook everyone asks about",
    },
  };
}

function reload(id: number): PieceRecord {
  const piece = getPieceById(id);
  assert.ok(piece);
  return piece;
}

function makePiece(session: string, title: string, doc = campaignDoc()): PieceRecord {
  const created = createPiece(session, { title, doc });
  assert.equal(created.ok, true, JSON.stringify(created.response));
  return reload((created.response.piece as { id: number }).id);
}

function saveTemplate(pieceId: number, name?: string): { id: number; doc: PieceDoc } {
  const saved = saveAsTemplate(SESSION, name ? { id: pieceId, name } : { id: pieceId });
  assert.equal(saved.ok, true, JSON.stringify(saved.response));
  return saved.response.template as { id: number; doc: PieceDoc };
}

test.before(async () => {
  for (const [name, mount] of [
    ["KeepAnalog", "keepanalog"],
    ["VinylOS", "vinylos"],
  ] as const) {
    const registered = await registerProject(name, `http://127.0.0.1:${port}/${mount}`, "test");
    assert.equal(registered.project.status, "healthy");
  }
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
  assert.equal((await selectProject(OTHER_SESSION, "VinylOS")).ok, true);
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: the strip

test("the strip empties every field a campaign writes prose into", () => {
  const original = campaignDoc();
  const stripped = stripToTemplate(original);

  // Every piece of campaign copy is gone, including the [NEED] claim token
  // and the alt text, which is prose a campaign writes like any other.
  const text = JSON.stringify(stripped);
  assert.ok(!text.includes("Five reasons paper wins"));
  assert.ok(!text.includes("[NEED"));
  assert.ok(!text.includes("Back in stock"));
  assert.ok(!text.includes("A stack of notebooks"));
  assert.deepEqual(Object.values(stripped.captions), ["", "", "", ""]);
  const image = stripped.slides[1].layers[0];
  assert.equal(image.type === "image" && image.alt, undefined);
  // The image still points at something, so the template renders as the
  // composition it was.
  assert.equal(image.type === "image" && image.ref, "asset://hero");

  // The layout is untouched: same format, same slides, same layer order and
  // types, same frames, same token references.
  assert.equal(stripped.format, original.format);
  assert.deepEqual(
    stripped.slides.map((s) => s.layers.map((l) => l.type)),
    original.slides.map((s) => s.layers.map((l) => l.type))
  );
  const headline = stripped.slides[0].layers[0];
  const originalHeadline = original.slides[0].layers[0];
  assert.deepEqual(headline.frame, originalHeadline.frame);
  assert.equal(headline.type === "text" && headline.color, "brand.ink");
  assert.equal(headline.type === "text" && headline.font, "font.display");
  const shape = stripped.slides[0].layers[2];
  assert.equal(shape.type === "shape" && shape.fill, "brand.accent");

  // The source document is not mutated.
  assert.deepEqual(original, campaignDoc());
});

test("a saved template carries no campaign text, claims, captions, or dates", () => {
  const piece = makePiece(SESSION, "KeepAnalog carousel");

  // Walk it all the way to planned, so there is planning data to leak.
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  // A [NEED] token blocks approval, so plant the plan directly: the point
  // here is that planning data never reaches the template.
  getDb()
    .prepare(
      "UPDATE pieces SET status = 'planned', planned_date = ?, pinned_kit_version = 1, outcome = ? WHERE id = ?"
    )
    .run("2026-09-05", "412 saves", piece.id);

  const template = saveTemplate(piece.id, "Carousel layout");
  const stored = getTemplateById(template.id);
  assert.ok(stored);

  const serialized = JSON.stringify(stored);
  for (const campaign of [
    "Five reasons paper wins",
    "[NEED",
    "Our best seller",
    "A stack of notebooks",
    "2026-09-05",
    "412 saves",
  ]) {
    assert.ok(!serialized.includes(campaign), `template still carries "${campaign}"`);
  }
  // A template holds a document, not a piece: no status, no date, no
  // approval, no version history of its own.
  assert.deepEqual(Object.keys(stored).sort(), [
    "createdAt",
    "doc",
    "fromPieceId",
    "id",
    "name",
    "projectId",
  ]);

  // Saving is a read of the piece: the piece itself is unchanged.
  const after = reload(piece.id);
  assert.equal(after.status, "planned");
  assert.equal(after.plannedDate, "2026-09-05");
  assert.deepEqual(after.doc, campaignDoc());
});

test("the template's name defaults to the piece it came from", () => {
  const piece = makePiece(SESSION, "Unnamed source");
  const template = saveTemplate(piece.id);
  assert.equal(getTemplateById(template.id)?.name, "Unnamed source layout");
});

// ---------------------------------------------------------------------------
// Criterion 2: instantiation

test("instantiating a template creates a fresh backlog piece with the layout intact", () => {
  const source = makePiece(SESSION, "source piece");
  const template = saveTemplate(source.id, "Reusable carousel");

  const result = instantiateTemplate(SESSION, { id: template.id, title: "September drop" });
  assert.equal(result.ok, true, JSON.stringify(result.response));
  const started = result.response.piece as { id: number; docVersion: number };

  const piece = reload(started.id);
  assert.equal(piece.title, "September drop");
  assert.equal(piece.status, "backlog");
  assert.equal(piece.docVersion, 1);
  // Fresh means fresh: nothing carried over from the source piece.
  assert.equal(piece.plannedDate, null);
  assert.equal(piece.pinnedKitVersion, null);
  assert.equal(piece.brandOutdated, false);
  assert.equal(piece.outcome, null);
  assert.notEqual(piece.id, source.id);

  // The layout arrived whole and the copy is empty, ready to be written.
  assert.deepEqual(piece.doc, stripToTemplate(campaignDoc()));
  assert.equal(piece.doc.slides[0].layers[0].type === "text" && piece.doc.slides[0].layers[0].text, "");

  // It renders, which is the point of keeping the layout.
  const preview = renderPreview(SESSION, { id: piece.id });
  assert.equal(preview.ok, true);
  assert.match((preview.response.preview as { slides: string[] }).slides[0], /data-piece-slide/);

  // Its history starts at version 1 and says where it came from.
  const versions = getDb()
    .prepare("SELECT version, summary FROM piece_versions WHERE piece_id = ?")
    .all(piece.id) as { version: number; summary: string }[];
  assert.deepEqual(versions.map((v) => v.version), [1]);
  assert.match(versions[0].summary, /Reusable carousel/);
});

test("a piece started from a template binds to the instantiating session's snapshot", async () => {
  const source = makePiece(SESSION, "snapshot source");
  const template = saveTemplate(source.id);

  // The world moves on and the session re-pins.
  const before = reload(source.id).snapshot;
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);

  const result = instantiateTemplate(SESSION, { id: template.id, title: "later piece" });
  assert.equal(result.ok, true);
  const piece = reload((result.response.piece as { id: number }).id);

  // The template carries layout across time, never the old project context.
  assert.equal(typeof piece.snapshot, "string");
  assert.ok(piece.snapshot.length > 0);
  assert.equal(piece.snapshot, (result.response.context as { snapshot: string }).snapshot);
  assert.notEqual(before, "");
});

test("templates are listable, project-scoped, and refuse cross-project use", () => {
  const mine = makePiece(SESSION, "mine");
  const template = saveTemplate(mine.id, "Mine only");

  const listed = listTemplates(SESSION);
  assert.equal(listed.ok, true);
  const names = (listed.response.templates as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes("Mine only"));

  // The other project sees none of it, and cannot start a piece from it.
  const theirs = listTemplates(OTHER_SESSION);
  assert.equal(theirs.ok, true);
  assert.ok(
    !(theirs.response.templates as { id: number }[]).some((t) => t.id === template.id)
  );

  const stolen = instantiateTemplate(OTHER_SESSION, { id: template.id, title: "nope" });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.response.error, "cross_project_refused");

  // And saving one is scoped the same way.
  const crossSave = saveAsTemplate(OTHER_SESSION, { id: mine.id });
  assert.equal(crossSave.ok, false);
  assert.equal(crossSave.response.error, "cross_project_refused");
});

test("template calls refuse without a project, and on unknown ids and bad input", () => {
  const piece = makePiece(SESSION, "refusals");
  const template = saveTemplate(piece.id);

  for (const result of [
    saveAsTemplate("no-project", { id: piece.id }),
    listTemplates("no-project"),
    instantiateTemplate("no-project", { id: template.id, title: "x" }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "no_project_selected");
  }

  assert.equal(saveAsTemplate(SESSION, { id: 424242 }).response.error, "unknown_piece");
  assert.equal(
    instantiateTemplate(SESSION, { id: 424242, title: "x" }).response.error,
    "unknown_template"
  );
  assert.equal(saveAsTemplate(SESSION, {}).response.error, "invalid_template");
  assert.equal(
    instantiateTemplate(SESSION, { id: template.id, title: "" }).response.error,
    "invalid_template"
  );
});

// ---------------------------------------------------------------------------
// The Operator surface

test("the Operator saves a layout as a template and reads the list over HTTP", async () => {
  const piece = makePiece(SESSION, "http template");
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);

  const saved = await fetch(`http://127.0.0.1:${port}/api/pieces/${piece.id}/save-as-template`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "From the dashboard" }),
  });
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()) as { note: string; template: { id: number } };
  assert.match(savedBody.note, /campaign text, claims, captions, and planning data stripped/);

  const listed = await fetch(`http://127.0.0.1:${port}/api/templates`, {
    headers: { cookie },
  });
  assert.equal(listed.status, 200);
  const body = (await listed.json()) as {
    templates: { id: number; name: string; projectName: string }[];
  };
  const row = body.templates.find((t) => t.id === savedBody.template.id);
  assert.equal(row?.name, "From the dashboard");
  assert.equal(row?.projectName, "KeepAnalog");

  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/pieces/424242/save-as-template`, {
        method: "POST",
        headers: { cookie },
      })
    ).status,
    404
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/templates`)).status, 401);

  // The list is a summary: a template's document is not sprayed at the
  // dashboard, which only needs to say what shape it is.
  assert.ok(!("doc" in (row as object)));
});

test("an approved piece can be templated without disturbing its approval", () => {
  const clean: PieceDoc = {
    format: "1:1",
    slides: [{ layers: [{ type: "text", text: "Slow tools, on purpose", role: "headline" }] }],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
  };
  const piece = makePiece(SESSION, "approved source", clean);
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  assert.equal(approvePiece(reload(piece.id), "operator").ok, true);
  assert.equal(planPiece(reload(piece.id), "2026-09-09", "operator").ok, true);

  const before = reload(piece.id);
  saveTemplate(piece.id, "Approved layout");
  const after = reload(piece.id);

  assert.equal(after.status, before.status);
  assert.equal(after.pinnedKitVersion, before.pinnedKitVersion);
  assert.equal(after.plannedDate, before.plannedDate);
  assert.equal(after.docVersion, before.docVersion);
});
