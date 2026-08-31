// Brand Kit and deterministic checks (ticket 12; reference behavior:
// CreativePieceMachine walkthrough 3 "off-kit color blocks approval" and
// the `UPDATE_BRAND_KIT` reducer in creative-piece-workflow.html).
//
// The three things this ticket promises:
//   1. changing a kit token repaints a drafting piece and touches no document
//   2. an off-kit raw color is a check_brand error naming the layer
//   3. quality findings are labelled advisory and never block

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
import { brandKitRouter } from "../server/brand-kit-routes";
import { pieceRouter } from "../server/piece-routes";
import {
  BrandKitError,
  currentKit,
  kitAtVersion,
  listKitVersions,
  updateKit,
  validateTokens,
} from "../server/brand-kit";
import {
  checkBrand,
  checkBrandDoc,
  checkQuality,
  checkQualityDoc,
  reportsForPiece,
  type CheckFinding,
} from "../server/checks";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import { applyEditBatch } from "../server/piece-edits";
import { createPiece, getPieceById, type PieceDoc } from "../server/pieces";
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
import { DEFAULT_BRAND_TOKENS } from "../render/piece-slide";

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
// The two Operator surfaces Studio reads, mounted exactly as main.ts mounts
// them, so the Studio wiring is exercised and not only the modules under it.
app.use("/api/pieces", pieceRouter());
app.use("/api/brand-kits", brandKitRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

// An Operator session, so the authenticated Studio routes can be called.
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

interface JsonResponse<T> {
  status: number;
  body: T;
}

async function get<T>(pathname: string): Promise<JsonResponse<T>> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as T };
}

async function put<T>(pathname: string, payload: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const SESSION = "brand-kit-session";
let projectId = 0;

function doc(overrides: Partial<PieceDoc> = {}): PieceDoc {
  return {
    format: "1:1",
    slides: [
      {
        layers: [
          { type: "text", text: "Slow tools, on purpose", role: "headline" },
          {
            type: "shape",
            shape: "rect",
            fill: "brand.accent",
            frame: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
          },
        ],
      },
    ],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
    ...overrides,
  };
}

function makePiece(title: string, d: PieceDoc = doc()): number {
  const created = createPiece(SESSION, { title, doc: d });
  assert.equal(created.ok, true, JSON.stringify(created.response));
  return (created.response.piece as { id: number }).id;
}

function previewHtml(id: number): string[] {
  const preview = renderPreview(SESSION, { id });
  assert.equal(preview.ok, true);
  return (preview.response.preview as { slides: string[] }).slides;
}

function messages(findings: CheckFinding[]): string {
  return findings.map((f) => f.message).join(" | ");
}

test.before(async () => {
  const registered = await registerProject(
    "KeepAnalog",
    `http://127.0.0.1:${port}/keepanalog`,
    "test"
  );
  assert.equal(registered.project.status, "healthy");
  projectId = registered.project.id;
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The kit itself

test("a project's kit is seeded at v1 with the default tokens and versions append", () => {
  const kit = currentKit(projectId);
  assert.equal(kit.version, 1);
  assert.deepEqual(kit.tokens, DEFAULT_BRAND_TOKENS);

  const next = updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");
  assert.equal(next.version, 2);
  assert.equal(next.tokens["brand.accent"], "#8a4fff");
  // Unchanged tokens carry forward: a kit change is a merge, not a replace.
  assert.equal(next.tokens["brand.ink"], DEFAULT_BRAND_TOKENS["brand.ink"]);

  // History is append-only: v1 still renders exactly as it did.
  const v1 = kitAtVersion(projectId, 1);
  assert.equal(v1?.tokens["brand.accent"], DEFAULT_BRAND_TOKENS["brand.accent"]);
  assert.deepEqual(
    listKitVersions(projectId).map((k) => k.version),
    [1, 2]
  );
  assert.throws(
    () => getDb().prepare("UPDATE brand_kits SET tokens = '{}' WHERE version = 1").run(),
    /append-only/
  );

  // Restore the default so later tests read a predictable kit.
  const restored = updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
  assert.equal(restored.version, 3);
});

test("a kit change that sets nothing new does not mint a version", () => {
  const before = currentKit(projectId);
  const same = updateKit(projectId, { tokens: { "brand.ink": before.tokens["brand.ink"] } });
  assert.equal(same.version, before.version);
});

test("invalid tokens are refused and the kit is unchanged", () => {
  const before = currentKit(projectId);

  assert.throws(
    () => updateKit(projectId, { tokens: { "brand.accent": "hot pink" } }),
    (err: unknown) => err instanceof BrandKitError && /#rrggbb/.test(err.detail.join(" "))
  );
  assert.throws(
    () => updateKit(projectId, { tokens: { "color.accent": "#112233" } }),
    (err: unknown) => err instanceof BrandKitError && /not a Brand Kit token/.test(err.detail.join(" "))
  );
  assert.throws(() => updateKit(projectId, { tokens: {} }), BrandKitError);

  assert.deepEqual(currentKit(projectId), before);
  assert.deepEqual(validateTokens(DEFAULT_BRAND_TOKENS), []);
  assert.match(
    validateTokens({ "brand.ink": "#000000" }).join(" "),
    /"brand.paper" is required/
  );
});

// ---------------------------------------------------------------------------
// Criterion 1: a kit change repaints a drafting piece, document untouched

test("changing a kit token repaints a drafting piece without touching its stored document", () => {
  const id = makePiece("repaint me");
  // The drafting transition arrives with the approval gate (ticket 13); the
  // repaint rule is about the status, so set it directly to test it here.
  getDb().prepare("UPDATE pieces SET status = 'drafting' WHERE id = ?").run(id);
  const before = getPieceById(id);
  assert.ok(before);
  assert.equal(before.status, "drafting");

  const beforeHtml = previewHtml(id);
  const kitBefore = currentKit(projectId);
  assert.match(beforeHtml[0], new RegExp(kitBefore.tokens["brand.accent"]));

  const kit = updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");
  const afterHtml = previewHtml(id);

  // The rendering changed…
  assert.notEqual(afterHtml[0], beforeHtml[0]);
  assert.match(afterHtml[0], /background-color:#8a4fff/);
  // …and the document did not: same doc, same version, same history.
  const after = getPieceById(id);
  assert.ok(after);
  assert.deepEqual(after.doc, before.doc);
  assert.equal(after.docVersion, before.docVersion);
  assert.equal(after.updatedAt, before.updatedAt);
  // The layer still holds the token name, never the resolved value.
  const shape = after.doc.slides[0].layers[1];
  assert.equal(shape.type === "shape" && shape.fill, "brand.accent");

  // The preview reports which kit it was painted through.
  const preview = renderPreview(SESSION, { id });
  assert.equal((preview.response.preview as { kitVersion: number }).kitVersion, kit.version);

  updateKit(projectId, { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } });
});

// ---------------------------------------------------------------------------
// Criterion 2: an off-kit raw color is an error naming the layer

test("an off-kit raw color yields a check_brand error naming the layer", () => {
  const id = makePiece("off-kit color");
  const applied = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [{ op: "set_fill", slide: 0, layer: 1, value: "#ff00aa" }],
  });
  assert.equal(applied.ok, true);

  const result = checkBrand(SESSION, { id });
  assert.equal(result.ok, true);
  const check = result.response.check as {
    errors: CheckFinding[];
    warnings: CheckFinding[];
    blocksApproval: boolean;
    kitVersion: number;
  };

  assert.equal(check.errors.length, 1);
  const [error] = check.errors;
  assert.equal(error.code, "off_kit_color");
  assert.equal(error.severity, "error");
  assert.equal(error.slide, 1);
  assert.equal(error.layer, 1);
  assert.equal(error.where, "slide 1, layer 1 (shape)");
  assert.match(error.message, /#ff00aa/);
  assert.match(error.message, /slide 1, layer 1 \(shape\)/);
  assert.equal(check.blocksApproval, true);
  assert.equal(check.kitVersion, currentKit(projectId).version);

  // A token that names nothing in this kit is off-kit too.
  const unknownToken = checkBrandDoc(
    doc({
      slides: [{ layers: [{ type: "shape", shape: "rect", fill: "brand.neon" }] }],
    }),
    currentKit(projectId).tokens
  );
  assert.equal(unknownToken.length, 1);
  assert.equal(unknownToken[0].code, "off_kit_token");

  // Adding the token to the kit clears the error — nothing about the piece
  // changed, only the kit it is read against.
  const widened = updateKit(projectId, { tokens: { "brand.neon": "#ff00aa" } });
  assert.deepEqual(
    checkBrandDoc(
      doc({ slides: [{ layers: [{ type: "shape", shape: "rect", fill: "brand.neon" }] }] }),
      widened.tokens
    ),
    []
  );
});

test("check_brand reports off-kit fonts, empty text layers, and missing assets as errors", () => {
  const tokens = currentKit(projectId).tokens;
  const findings = checkBrandDoc(
    doc({
      slides: [
        {
          layers: [
            { type: "text", text: "Headline", role: "headline", font: "Comic Sans MS" },
            { type: "text", text: "   " },
            { type: "text", text: "Fine", font: "font.body" },
            { type: "image", ref: "" },
          ],
        },
      ],
    }),
    tokens
  );

  const errors = findings.filter((f) => f.severity === "error");
  assert.deepEqual(
    errors.map((f) => f.code).sort(),
    ["empty_text", "missing_asset", "off_kit_font"]
  );
  assert.match(messages(errors), /slide 1, layer 0 \(text\)/);
  assert.match(messages(errors), /Comic Sans MS/);
  assert.match(messages(errors), /slide 1, layer 3 \(image\)/);
});

test("overflow is a warning, not an error, and tracks the layer's own box", () => {
  const tokens = currentKit(projectId).tokens;
  const long = "overflowing headline ".repeat(20);

  const framed = checkBrandDoc(
    doc({
      slides: [
        {
          layers: [
            {
              type: "text",
              text: long,
              role: "headline",
              frame: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
            },
          ],
        },
      ],
    }),
    tokens
  );
  assert.deepEqual(framed.map((f) => f.code), ["text_overflow"]);
  assert.equal(framed[0].severity, "warning");
  assert.match(framed[0].message, /may overflow/);

  const roomy = checkBrandDoc(
    doc({ slides: [{ layers: [{ type: "text", text: "Short", role: "headline" }] }] }),
    tokens
  );
  assert.deepEqual(roomy, []);
});

test("check_brand is a pure function of document and kit", () => {
  const tokens = currentKit(projectId).tokens;
  const d = doc({
    slides: [{ layers: [{ type: "text", text: "", role: "headline" }] }],
  });
  assert.deepEqual(checkBrandDoc(d, tokens), checkBrandDoc(d, tokens));
});

// ---------------------------------------------------------------------------
// Criterion 3: quality findings are advisory

test("quality findings are labelled advisory and never block", () => {
  const id = makePiece(
    "crowded",
    doc({
      slides: [
        {
          layers: [
            { type: "shape", shape: "rect", fill: "brand.accent" },
            { type: "shape", shape: "rect", fill: "brand.accent" },
            { type: "shape", shape: "rect", fill: "brand.accent" },
            { type: "shape", shape: "rect", fill: "brand.accent" },
            { type: "shape", shape: "rect", fill: "brand.accent" },
            { type: "shape", shape: "rect", fill: "brand.accent" },
          ],
        },
        { layers: [] },
      ],
      captions: { instagram: "", x: "x", linkedin: "li", tiktok: "" },
    })
  );

  const result = checkQuality(SESSION, { id });
  assert.equal(result.ok, true);
  const check = result.response.check as {
    advisory: true;
    blocksApproval: boolean;
    findings: CheckFinding[];
    summary: string;
  };

  assert.equal(check.advisory, true);
  assert.equal(check.blocksApproval, false);
  assert.match(check.summary, /never block/);
  assert.ok(check.findings.every((f) => f.severity === "advisory"));
  assert.deepEqual(
    check.findings.map((f) => f.code).sort(),
    ["crowded_slide", "empty_caption", "empty_slide", "no_text"]
  );
  assert.match(messages(check.findings), /instagram, tiktok/);

  // The same document is brand-clean: heuristics and facts are separate passes.
  const piece = getPieceById(id);
  assert.ok(piece);
  assert.deepEqual(checkBrandDoc(piece.doc, currentKit(projectId).tokens), []);
  assert.deepEqual(checkQualityDoc(doc()), []);
});

// ---------------------------------------------------------------------------
// Host and Operator surfaces

test("both checks are project-scoped and refuse unknown pieces", () => {
  const id = makePiece("scoped checks");
  for (const result of [
    checkBrand("other-session", { id }),
    checkQuality("other-session", { id }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "no_project_selected");
  }
  for (const result of [
    checkBrand(SESSION, { id: 424242 }),
    checkQuality(SESSION, { id: 424242 }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "unknown_piece");
  }
  for (const result of [checkBrand(SESSION, {}), checkQuality(SESSION, { id: "one" })]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "invalid_check");
  }
});

test("Studio reads both reports for one piece in a single call", () => {
  const id = makePiece("studio reports");
  const reports = reportsForPiece(id);
  assert.ok(reports);
  assert.equal(reports.brand.docVersion, 1);
  assert.equal(reports.brand.kitVersion, currentKit(projectId).version);
  assert.equal(reports.quality.advisory, true);
  assert.equal(reportsForPiece(424242), null);
});

// ---------------------------------------------------------------------------
// Repair path, removal, and stacked overflow

test("set_fill puts an off-kit text color back on the kit, and set_font its family", () => {
  const id = makePiece(
    "repairable",
    doc({
      slides: [{ layers: [{ type: "text", text: "Headline", role: "headline", color: "#ff00aa", font: "Comic Sans MS" }] }],
    })
  );
  const before = checkBrand(SESSION, { id }).response.check as { errors: CheckFinding[] };
  assert.deepEqual(before.errors.map((f) => f.code).sort(), ["off_kit_color", "off_kit_font"]);

  const repaired = applyEditBatch(SESSION, {
    id,
    baseVersion: 1,
    ops: [
      { op: "set_fill", slide: 0, layer: 0, value: "brand.accent" },
      { op: "set_font", slide: 0, layer: 0, value: "font.display" },
    ],
  });
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.response.warnings, []);

  const after = checkBrand(SESSION, { id }).response.check as { errors: CheckFinding[] };
  assert.deepEqual(after.errors, []);

  // An unpaintable value still falls back with a warning rather than failing.
  const nonsense = applyEditBatch(SESSION, {
    id,
    baseVersion: 2,
    ops: [{ op: "set_font", slide: 0, layer: 0, value: "!!!" }],
  });
  assert.equal(nonsense.ok, true);
  assert.match((nonsense.response.warnings as string[])[0], /fell back/);
});

test("a token added by mistake can be removed, but a required one cannot", () => {
  const added = updateKit(projectId, { tokens: { "brand.typo": "#010101" } });
  assert.ok("brand.typo" in added.tokens);

  const removed = updateKit(projectId, { tokens: { "brand.typo": null } });
  assert.equal(removed.version, added.version + 1);
  assert.ok(!("brand.typo" in removed.tokens));

  assert.throws(
    () => updateKit(projectId, { tokens: { "brand.ink": null } }),
    (err: unknown) => err instanceof BrandKitError && /"brand.ink" is required/.test(err.detail.join(" "))
  );
  assert.ok("brand.ink" in currentKit(projectId).tokens);
});

test("unframed layers overflow together, because that is how they are laid out", () => {
  const tokens = currentKit(projectId).tokens;
  const paragraph = "A long line of body copy that keeps going and going. ".repeat(6);

  // Each of these alone fits the canvas; stacked, they do not. Measuring one
  // layer at a time against the whole canvas would report nothing.
  const stacked = checkBrandDoc(
    doc({
      slides: [
        {
          layers: [
            { type: "text", text: paragraph },
            { type: "text", text: paragraph },
            { type: "text", text: paragraph },
            { type: "image", ref: "asset://hero" },
          ],
        },
      ],
    }),
    tokens
  );
  assert.deepEqual(stacked.map((f) => f.code), ["slide_overflow"]);
  assert.equal(stacked[0].severity, "warning");
  assert.equal(stacked[0].slide, 1);
  assert.equal(stacked[0].layer, null);

  const fits = checkBrandDoc(
    doc({ slides: [{ layers: [{ type: "text", text: "Short", role: "headline" }] }] }),
    tokens
  );
  assert.deepEqual(fits, []);
});

// ---------------------------------------------------------------------------
// The Operator surfaces Studio reads

test("Studio reads a piece's checks and its project's kit over HTTP", async () => {
  const id = makePiece("studio surfaces");

  const checks = await get<{
    brand: { kitVersion: number };
    quality: { advisory: boolean };
  }>(`/api/pieces/${id}/checks`);
  assert.equal(checks.status, 200);
  assert.equal(checks.body.brand.kitVersion, currentKit(projectId).version);
  assert.equal(checks.body.quality.advisory, true);

  // Every piece in the list carries the kit it renders through, so Studio can
  // paint it without a second round trip.
  const list = await get<{ pieces: { id: number; kit: { version: number } }[] }>("/api/pieces");
  assert.equal(list.status, 200);
  const listed = list.body.pieces.find((p) => p.id === id);
  assert.equal(listed?.kit.version, currentKit(projectId).version);

  const kit = await get<{
    projectName: string;
    kit: { version: number };
    versions: unknown[];
  }>(`/api/brand-kits/${projectId}`);
  assert.equal(kit.status, 200);
  assert.equal(kit.body.projectName, "KeepAnalog");
  assert.equal(kit.body.versions.length, kit.body.kit.version);

  assert.equal((await get<unknown>("/api/pieces/424242/checks")).status, 404);
  assert.equal((await get<unknown>("/api/brand-kits/424242")).status, 404);
});

test("the Operator changes a token over HTTP and the piece repaints, unedited", async () => {
  const id = makePiece("http repaint");
  const before = getPieceById(id);
  assert.ok(before);
  const beforeHtml = previewHtml(id);

  const saved = await put<{ kit: { tokens: Record<string, string> } }>(
    `/api/brand-kits/${projectId}`,
    { tokens: { "brand.accent": "#123456" } }
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.kit.tokens["brand.accent"], "#123456");

  assert.notEqual(previewHtml(id)[0], beforeHtml[0]);
  assert.deepEqual(getPieceById(id)?.doc, before.doc);
  assert.equal(getPieceById(id)?.docVersion, before.docVersion);

  const rejected = await put<{ detail: string[] }>(`/api/brand-kits/${projectId}`, {
    tokens: { "brand.accent": "not a color" },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.detail.join(" "), /#rrggbb/);
  assert.equal(currentKit(projectId).tokens["brand.accent"], "#123456");

  await put<unknown>(`/api/brand-kits/${projectId}`, {
    tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] },
  });
});

test("the Studio routes refuse an unauthenticated caller", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/brand-kits/${projectId}`);
  assert.equal(res.status, 401);
});
