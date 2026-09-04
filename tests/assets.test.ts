// The image-result handoff (ticket 16).
//
// The four register_asset outcomes are a contract replay of GatewaySim
// walkthrough 3 in docs/issues/marketing-os/prototypes/ai-host-onboarding.html:
//   "register_asset without bytes → manual fallback"
//   "register_asset 4MB → over inline cap"
//   "register_asset 900KB base64 → accepted"
//   "register_asset with no origin → rights_missing"
//   "Operator manual upload (dashboard fallback)"

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
import { assetRouter } from "../server/asset-routes";
import {
  assetRef,
  getAssetById,
  listAssets,
  MAX_ASSET_BYTES,
  registerAsset,
  resolveAssetRef,
  sniffMediaType,
} from "../server/assets";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { currentKit } from "../server/brand-kit";
import { checkBrandDoc, refResolverFor } from "../server/checks";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import { applyEditBatch } from "../server/piece-edits";
import { createPiece, getPieceById, type PieceDoc, type PieceRecord } from "../server/pieces";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { findSecretShapedStrings } from "../server/response-lint";
import { assetResolverFor, renderPreview } from "../server/renderer";
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
app.use("/vinylos", router);
app.use("/api/assets", assetRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "asset-session";
const OTHER_SESSION = "other-asset-session";
let projectId = 0;
let otherProjectId = 0;
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

// A real PNG header followed by filler, so size is controllable and the
// media-type sniff has something true to find.
function png(bytes = 900 * 1024): Buffer {
  const buffer = Buffer.alloc(bytes, 0x42);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  return buffer;
}

function base64(bytes: Buffer): string {
  return bytes.toString("base64");
}

function storedAssets(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;
}

function doc(ref = "asset://1"): PieceDoc {
  return {
    format: "1:1",
    slides: [
      {
        layers: [
          { type: "text", text: "Press play on wax", role: "headline" },
          { type: "image", ref },
        ],
      },
    ],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
  };
}

function reload(id: number): PieceRecord {
  const piece = getPieceById(id);
  assert.ok(piece);
  return piece;
}

function makePiece(session: string, title: string, d: PieceDoc = doc()): PieceRecord {
  const created = createPiece(session, { title, doc: d });
  assert.equal(created.ok, true, JSON.stringify(created.response));
  return reload((created.response.piece as { id: number }).id);
}

async function api<T>(
  pathname: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

test.before(async () => {
  const keep = await registerProject("KeepAnalog", `http://127.0.0.1:${port}/keepanalog`, "test");
  const vinyl = await registerProject("VinylOS", `http://127.0.0.1:${port}/vinylos`, "test");
  projectId = keep.project.id;
  otherProjectId = vinyl.project.id;
  assert.equal((await selectProject(SESSION, "KeepAnalog")).ok, true);
  assert.equal((await selectProject(OTHER_SESSION, "VinylOS")).ok, true);
  cookie = operatorCookie();
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: the four outcomes, against the reference transcript

test("outcome 1 of 4: a 900KB base64 payload is accepted, with lineage recorded", () => {
  const piece = makePiece(SESSION, "accepted handoff");

  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    sourceAssets: ["asset://none"],
    rights: "generated for this project",
    bytesBase64: base64(png()),
    pieceId: piece.id,
  });

  assert.equal(result.ok, true, JSON.stringify(result.response));
  const asset = result.response.asset as {
    id: number;
    ref: string;
    origin: string;
    prompt: string;
    sourceAssets: string[];
    rights: string;
    mediaType: string;
    sizeBytes: number;
  };
  assert.equal(asset.origin, "ai_host");
  assert.equal(asset.prompt, "Grounded prompt v1");
  assert.deepEqual(asset.sourceAssets, ["asset://none"]);
  assert.equal(asset.rights, "generated for this project");
  assert.equal(asset.mediaType, "image/png");
  assert.equal(asset.sizeBytes, 900 * 1024);
  assert.equal(asset.ref, assetRef(asset.id));

  // The note is the whole point of this ticket.
  assert.match(String(result.response.note), /does not claim it generated this image/);

  // The piece now carries the asset, not a promise of one.
  assert.equal(reload(piece.id).imageState, `asset_attached:${asset.ref}`);
});

test("outcome 2 of 4: no binary payload drops the piece to prompt_prepared", () => {
  const piece = makePiece(SESSION, "no bytes");

  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    pieceId: piece.id,
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.error, "asset_bytes_missing");
  assert.match(String(result.response.message), /No binary payload arrived/);
  assert.match(String(result.response.message), /prompt prepared/);
  assert.match(String(result.response.next), /dashboard manual upload/);

  const after = reload(piece.id);
  assert.equal(after.imageState, "prompt_prepared");
  // The prompt is kept, because the manual upload records the same lineage.
  assert.equal(after.imagePrompt, "Grounded prompt v1");
});

test("outcome 3 of 4: a payload over the inline cap gets the same fallback", () => {
  const piece = makePiece(SESSION, "too large");
  const before = storedAssets();

  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    bytesBase64: base64(png(MAX_ASSET_BYTES + 1024)),
    pieceId: piece.id,
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.error, "asset_too_large");
  assert.match(String(result.response.message), /exceeds the 2048KB cap/);
  assert.match(String(result.response.next), /manual upload/);
  assert.equal(reload(piece.id).imageState, "prompt_prepared");

  // Nothing was stored: a refused registration writes no asset.
  assert.equal(storedAssets(), before);
});

test("outcome 4 of 4: a registration with no origin fails with rights_missing", () => {
  const before = storedAssets();

  const noOrigin = registerAsset(SESSION, { bytesBase64: base64(png(100 * 1024)) });
  assert.equal(noOrigin.ok, false);
  assert.equal(noOrigin.response.error, "rights_missing");
  assert.equal(
    noOrigin.response.message,
    "origin is required (ai_host, operator_upload, or project_import)."
  );
  assert.match(String(noOrigin.response.next), /Resend with origin/);

  // An origin nobody recognises is no origin at all.
  const badOrigin = registerAsset(SESSION, {
    origin: "somewhere",
    bytesBase64: base64(png(100 * 1024)),
  });
  assert.equal(badOrigin.response.error, "rights_missing");

  // A generated asset with no prompt has no lineage to record.
  const noPrompt = registerAsset(SESSION, {
    origin: "ai_host",
    bytesBase64: base64(png(100 * 1024)),
  });
  assert.equal(noPrompt.response.error, "rights_missing");
  assert.match(String(noPrompt.response.message), /prompt and source-asset lineage/);

  assert.equal(storedAssets(), before, "no refused registration stored anything");
});

test("an asset with no rights notes is recorded as unreviewed, and says so", () => {
  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    bytesBase64: base64(png(10 * 1024)),
  });
  assert.equal(result.ok, true);
  assert.equal((result.response.asset as { rights: string }).rights, "unreviewed");
  assert.match(String(result.response.warning), /unreviewed/);
});

test("a payload that is not an image is refused rather than stored", () => {
  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    bytesBase64: Buffer.from("this is not a png").toString("base64"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.response.error, "invalid_schema");

  assert.equal(sniffMediaType(png()), "image/png");
  assert.equal(sniffMediaType(Buffer.from("nope")), null);
});

test("registering is project-scoped, and a piece of another project is not touched", () => {
  const mine = makePiece(SESSION, "mine");
  const theirs = makePiece(OTHER_SESSION, "theirs");

  assert.equal(registerAsset("no-project", { origin: "ai_host" }).response.error, "no_project_selected");

  // Naming another project's piece registers the asset but attaches nothing.
  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    bytesBase64: base64(png(10 * 1024)),
    pieceId: theirs.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.piece, null);
  assert.equal(reload(theirs.id).imageState, null);
  assert.equal(reload(mine.id).imageState, null);

  const listed = listAssets(SESSION);
  assert.equal(listed.ok, true);
  const refs = (listed.response.assets as { ref: string }[]).map((a) => a.ref);
  assert.ok(refs.includes((result.response.asset as { ref: string }).ref));

  const others = listAssets(OTHER_SESSION);
  assert.ok(
    !(others.response.assets as { ref: string }[]).some((a) =>
      refs.includes(a.ref)
    ),
    "each project sees only its own assets"
  );
});

// ---------------------------------------------------------------------------
// Criterion 2: the manual upload

test("the manual upload attaches the asset with lineage and clears prompt_prepared", async () => {
  const piece = makePiece(SESSION, "manual fallback");

  // The host tried and could not send bytes.
  const failed = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    pieceId: piece.id,
  });
  assert.equal(failed.ok, false);
  assert.equal(reload(piece.id).imageState, "prompt_prepared");

  // The Operator uploads the file the dashboard pointed them at.
  const uploaded = await api<{
    asset: { id: number; ref: string; origin: string; prompt: string; rights: string };
    piece: { id: number; imageState: string };
    note: string;
  }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId, pieceId: piece.id, bytesBase64: base64(png(50 * 1024)) }),
  });

  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.asset.origin, "operator_upload");
  // The same lineage the inline path would have recorded, carried off the
  // piece rather than retyped by the Operator.
  assert.equal(uploaded.body.asset.prompt, "Grounded prompt v1");
  assert.equal(uploaded.body.asset.rights, "operator_confirmed");
  assert.match(uploaded.body.note, /lineage recorded from the prepared prompt/);

  const after = reload(piece.id);
  assert.notEqual(after.imageState, "prompt_prepared");
  assert.equal(after.imageState, `asset_attached:${uploaded.body.asset.ref}`);
});

test("the upload refuses an empty file, an oversized one, and a foreign piece", async () => {
  const mine = makePiece(SESSION, "upload refusals");
  const theirs = makePiece(OTHER_SESSION, "not mine");

  const empty = await api<{ error: string }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId, bytesBase64: "" }),
  });
  assert.equal(empty.status, 400);

  const huge = await api<{ error: string }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId, bytesBase64: base64(png(MAX_ASSET_BYTES + 1024)) }),
  });
  assert.equal(huge.status, 413);

  const notAnImage = await api<{ error: string }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId, bytesBase64: Buffer.from("nope").toString("base64") }),
  });
  assert.equal(notAnImage.status, 400);

  const crossProject = await api<{ error: string }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId, pieceId: theirs.id, bytesBase64: base64(png(10 * 1024)) }),
  });
  assert.equal(crossProject.status, 409);

  const unknownProject = await api<{ error: string }>("/api/assets", {
    method: "POST",
    body: JSON.stringify({ projectId: 424242, bytesBase64: base64(png(10 * 1024)) }),
  });
  assert.equal(unknownProject.status, 400);

  assert.equal(reload(mine.id).imageState, null);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/assets`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
});

// ---------------------------------------------------------------------------
// Criterion 3: image layers reference registered assets by stable ID

test("an image layer references a registered asset by its stable id", () => {
  const registered = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    rights: "generated for this project",
    bytesBase64: base64(png(20 * 1024)),
  });
  const ref = (registered.response.asset as { ref: string }).ref;
  assert.match(ref, /^asset:\/\/\d+$/);

  const piece = makePiece(SESSION, "references an asset", doc(ref));

  // It resolves, and only within its own project.
  assert.ok(resolveAssetRef(ref, projectId));
  assert.equal(resolveAssetRef(ref, otherProjectId), null);

  // check_brand accepts a reference that resolves...
  assert.deepEqual(
    checkBrandDoc(piece.doc, currentKit(projectId).tokens, refResolverFor(projectId)),
    []
  );

  // ...and calls out one that does not, naming the layer and the reference.
  // As a warning: a Creative Template keeps its refs, so an unresolved one
  // must not make a template-started piece unapprovable.
  const dangling = checkBrandDoc(
    doc("asset://424242"),
    currentKit(projectId).tokens,
    refResolverFor(projectId)
  );
  assert.deepEqual(dangling.map((f) => f.code), ["unresolved_asset"]);
  assert.equal(dangling[0].severity, "warning");
  assert.equal(dangling[0].where, "slide 1, layer 1 (image)");
  assert.match(dangling[0].message, /asset:\/\/424242/);

  // A layer naming nothing at all is still the ticket 12 error it was.
  const empty = checkBrandDoc(doc(""), currentKit(projectId).tokens, refResolverFor(projectId));
  assert.deepEqual(empty.map((f) => f.code), ["missing_asset"]);
  assert.equal(empty[0].severity, "error");

  // The reference is stable: the asset it names never changes underneath it.
  const asset = getAssetById(Number(ref.slice("asset://".length)));
  assert.ok(asset);
  assert.throws(
    () => getDb().prepare("UPDATE assets SET rights = 'changed' WHERE id = ?").run(asset.id),
    /immutable/
  );
});

test("a referenced asset renders as itself, in the preview and the export alike", () => {
  const registered = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    rights: "generated for this project",
    bytesBase64: base64(png(4 * 1024)),
  });
  const ref = (registered.response.asset as { ref: string }).ref;
  const piece = makePiece(SESSION, "renders the asset", doc(ref));

  const preview = renderPreview(SESSION, { id: piece.id });
  assert.equal(preview.ok, true);
  const html = (preview.response.preview as { slides: string[] }).slides[0];
  const id = Number(ref.slice("asset://".length));
  // The markup carries the asset's URL, not its bytes. The export
  // screenshots this same HTML and serves those bytes into the page, so
  // preview equals export while the response stays small.
  assert.match(html, new RegExp(`<img src="/api/assets/${id}/bytes"`));
  assert.ok(!html.includes("base64,"), "no image bytes inlined into the response");
  assert.ok(!html.includes(`image: ${ref}`), "no placeholder where a real image resolved");

  // And small enough to survive the gateway's custody lint, which treats a
  // long high-entropy run — exactly what base64 image data looks like — as
  // secret-shaped and blocks the response.
  assert.deepEqual(findSecretShapedStrings(html), []);

  // One resolver call per distinct ref, however many layers use it.
  const resolve = assetResolverFor(projectId);
  assert.equal(resolve(ref), `/api/assets/${id}/bytes`);
  assert.equal(resolve("asset://424242"), null);

  // An unresolvable reference still renders, as the placeholder that names it.
  const unresolved = makePiece(SESSION, "dangling", doc("asset://424242"));
  const fallback = renderPreview(SESSION, { id: unresolved.id });
  assert.match(
    (fallback.response.preview as { slides: string[] }).slides[0],
    /image: asset:\/\/424242/
  );
});

test("an edit batch can point an image layer at a newly registered asset", () => {
  const piece = makePiece(SESSION, "repoint the image", doc("asset://424242"));
  const registered = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    rights: "generated for this project",
    bytesBase64: base64(png(8 * 1024)),
    pieceId: piece.id,
  });
  const ref = (registered.response.asset as { ref: string }).ref;

  const applied = applyEditBatch(SESSION, {
    id: piece.id,
    baseVersion: 1,
    ops: [
      { op: "remove_layer", slide: 0, layer: 1 },
      { op: "add_layer", slide: 0, layer: { type: "image", ref } },
    ],
  });
  assert.equal(applied.ok, true, JSON.stringify(applied.response));

  assert.deepEqual(
    checkBrandDoc(reload(piece.id).doc, currentKit(projectId).tokens, refResolverFor(projectId)),
    []
  );
});

test("a real image is served with its own sniffed type and no room to reinterpret it", async () => {
  const registered = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    rights: "generated for this project",
    bytesBase64: base64(png(4 * 1024)),
  });
  const id = (registered.response.asset as { id: number }).id;

  const res = await fetch(`http://127.0.0.1:${port}/api/assets/${id}/bytes`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  // The bytes came from outside; a browser must not go looking for a better
  // idea of what they are.
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(String(res.headers.get("content-security-policy")), /sandbox/);
  assert.equal((await res.arrayBuffer()).byteLength, 4 * 1024);

  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/assets/${id}/bytes`)).status,
    401
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/assets/424242/bytes`, { headers: { cookie } }))
      .status,
    404
  );
});

test("a RIFF container that is not a WebP is refused", () => {
  // RIFF alone is WAV, AVI, and much else. Accepting it would let a
  // non-image be stored and later served from the dashboard's own origin.
  const riff = Buffer.alloc(64, 0);
  riff.write("RIFF", 0, "ascii");
  riff.write("AVI ", 8, "ascii");
  assert.equal(sniffMediaType(riff), null);

  const webp = Buffer.alloc(64, 0);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  assert.equal(sniffMediaType(webp), "image/webp");

  const result = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Grounded prompt v1",
    bytesBase64: base64(riff),
  });
  assert.equal(result.response.error, "invalid_schema");
});

test("an accepted asset records its own prompt, not one left over from an earlier try", () => {
  const piece = makePiece(SESSION, "lineage wins");

  // A first attempt fails and leaves its prompt on the piece.
  registerAsset(SESSION, { origin: "ai_host", prompt: "First prompt", pieceId: piece.id });
  assert.equal(reload(piece.id).imagePrompt, "First prompt");

  // The second attempt lands with a different prompt — and that is the one
  // that actually made this image.
  const second = registerAsset(SESSION, {
    origin: "ai_host",
    prompt: "Second prompt",
    rights: "generated for this project",
    bytesBase64: base64(png(4 * 1024)),
    pieceId: piece.id,
  });
  assert.equal(second.ok, true);
  assert.equal((second.response.asset as { prompt: string }).prompt, "Second prompt");
  assert.equal(reload(piece.id).imagePrompt, "Second prompt");
});
