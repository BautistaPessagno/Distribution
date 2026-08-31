// The review and approval gate (ticket 13).
//
// The last two tests are contract replays of the approved reference
// implementation, CreativePieceMachine in
// .scratch/marketing-os/prototypes/creative-piece-workflow.html:
//   walkthrough 3 "Brand errors gate approval"
//   walkthrough 4 "Brand Kit change after approval"
// Each step below is the step from that walkthrough, in order.

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
import { currentKit, kitAtVersion, updateKit } from "../server/brand-kit";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import { applyEditBatch } from "../server/piece-edits";
import {
  approvalStatus,
  approvePiece,
  availableOperatorMoves,
  planPiece,
  needTokens,
  reapprovePiece,
  reopen,
  reopenPiece,
  requestPieceChanges,
  startDrafting,
  submitForReview,
} from "../server/piece-lifecycle";
import { pieceRouter } from "../server/piece-routes";
import { createPiece, getPieceById, type PieceDoc, type PieceRecord } from "../server/pieces";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { renderPreview, renderSlideHtml } from "../server/renderer";
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
app.use("/api/pieces", pieceRouter());
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

const SESSION = "approval-session";
let projectId = 0;
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

async function post(
  pathname: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { cookie },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function doc(overrides: Partial<PieceDoc> = {}): PieceDoc {
  return {
    format: "1:1",
    slides: [
      {
        layers: [
          { type: "text", text: "Press play on wax", role: "headline" },
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

function makePiece(title: string, d: PieceDoc = doc()): PieceRecord {
  const created = createPiece(SESSION, { title, doc: d });
  assert.equal(created.ok, true, JSON.stringify(created.response));
  const piece = getPieceById((created.response.piece as { id: number }).id);
  assert.ok(piece);
  return piece;
}

function reload(id: number): PieceRecord {
  const piece = getPieceById(id);
  assert.ok(piece);
  return piece;
}

/** Walk a fresh piece to review, the way the host would. */
function toReview(title: string, d: PieceDoc = doc()): PieceRecord {
  const piece = makePiece(title, d);
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  return reload(piece.id);
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
// The route through the lifecycle

test("a piece walks backlog to drafting to review, and changes-requested loops back", () => {
  const piece = makePiece("the route");
  assert.equal(piece.status, "backlog");

  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.equal(reload(piece.id).status, "drafting");

  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  assert.equal(reload(piece.id).status, "review");

  const looped = requestPieceChanges(reload(piece.id), "operator", "Tighten the headline.");
  assert.equal(looped.ok, true);
  assert.match(String((looped.response as { note: string }).note), /review → drafting/);
  assert.match(String((looped.response as { note: string }).note), /Tighten the headline\./);
  assert.equal(reload(piece.id).status, "drafting");
});

test("every move refuses from the wrong status and changes nothing", () => {
  const piece = makePiece("wrong status");

  // Approval happens in review, not in backlog.
  const early = approvePiece(piece, "operator");
  assert.equal(early.ok, false);
  assert.equal(early.response.error, "wrong_status");
  assert.match(String(early.response.message), /is backlog/);

  for (const result of [
    submitForReview(SESSION, { id: piece.id }),
    reopen(SESSION, { id: piece.id }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "wrong_status");
  }
  assert.equal(reload(piece.id).status, "backlog");

  // A piece that was never approved has no kit pin to re-pin.
  const notOutdated = reapprovePiece(piece, "operator");
  assert.equal(notOutdated.ok, false);
  assert.equal(notOutdated.response.error, "not_brand_outdated");
});

test("lifecycle moves are project-scoped and refuse unknown pieces", () => {
  const piece = makePiece("scoped moves");
  for (const result of [
    startDrafting("other-session", { id: piece.id }),
    submitForReview("other-session", { id: piece.id }),
    approvalStatus("other-session", { id: piece.id }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.response.error, "no_project_selected");
  }
  assert.equal(startDrafting(SESSION, { id: 424242 }).response.error, "unknown_piece");
  assert.equal(startDrafting(SESSION, {}).response.error, "invalid_transition");
});

// ---------------------------------------------------------------------------
// Criterion 1: approval refused while a brand error or [NEED] token exists

test("[NEED] tokens are found in text layers and in every caption", () => {
  const found = needTokens(
    doc({
      slides: [
        {
          layers: [
            { type: "text", text: "Trusted by [NEED: customer count] teams", role: "headline" },
            { type: "text", text: "No claim here" },
          ],
        },
      ],
      captions: { instagram: "[NEED]", x: "fine", linkedin: "fine", tiktok: "fine" },
    })
  );
  assert.deepEqual(
    found.map((n) => n.where),
    ["slide 1, layer 0 (text)", "the instagram caption"]
  );
  assert.equal(found[0].token, "[NEED: customer count]");
  assert.equal(found[1].token, "[NEED]");
  assert.deepEqual(needTokens(doc()), []);
});

test("approval is refused while a brand error or a [NEED] token exists, naming each blocker", () => {
  const piece = toReview(
    "blocked",
    doc({
      slides: [
        {
          layers: [
            { type: "text", text: "Loved by [NEED: review count] listeners", role: "headline" },
            { type: "shape", shape: "rect", fill: "#ff2d95" },
          ],
        },
      ],
    })
  );

  const blocked = approvePiece(piece, "operator");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.response.error, "approval_blocked");

  const blockers = blocked.response.blockers as {
    brandErrors: { code: string; where: string }[];
    needTokens: { where: string; token: string }[];
  };
  // Both kinds of blocker are named, each pointing at where it lives.
  assert.deepEqual(blockers.brandErrors.map((f) => f.code), ["off_kit_color"]);
  assert.equal(blockers.brandErrors[0].where, "slide 1, layer 1 (shape)");
  assert.deepEqual(blockers.needTokens.map((n) => n.token), ["[NEED: review count]"]);
  assert.match(String(blocked.response.message), /#ff2d95/);
  assert.match(String(blocked.response.message), /\[NEED: review count\]/);

  // Refused means unchanged: still in review, still unpinned.
  const after = reload(piece.id);
  assert.equal(after.status, "review");
  assert.equal(after.pinnedKitVersion, null);

  // The host can read the same blockers before handing work over.
  const status = approvalStatus(SESSION, { id: piece.id });
  assert.equal(status.ok, true);
  const approval = status.response.approval as { blocked: boolean; needTokens: unknown[] };
  assert.equal(approval.blocked, true);
  assert.equal(approval.needTokens.length, 1);
});

test("a quality finding never blocks approval", () => {
  // Six layers on one slide: crowded, which check_quality calls out — and a
  // slide with no text, which it also calls out. Neither gates anything.
  const crowded = doc({
    slides: [
      {
        layers: Array.from({ length: 6 }, () => ({
          type: "shape" as const,
          shape: "rect",
          fill: "brand.accent",
        })),
      },
    ],
  });
  const piece = toReview("advisory only", crowded);

  const approved = approvePiece(piece, "operator");
  assert.equal(approved.ok, true, JSON.stringify(approved.response));
  assert.equal(reload(piece.id).status, "approved");

  // The findings are reported with the approval, not suppressed by it.
  const findings = approved.response.qualityFindings as { code: string; severity: string }[];
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.severity === "advisory"));
});

// ---------------------------------------------------------------------------
// Criterion 2: approval pins the kit; a kit change flags approved work

test("approval pins the kit version, and reopen clears approval and the planned date", () => {
  const piece = toReview("pin and reopen");
  const kitAtApproval = currentKit(projectId).version;

  const approved = approvePiece(piece, "operator");
  assert.equal(approved.ok, true);
  assert.match(String((approved.response as { note: string }).note), /pinned to Brand Kit v/);

  let current = reload(piece.id);
  assert.equal(current.status, "approved");
  assert.equal(current.pinnedKitVersion, kitAtApproval);
  assert.equal(current.brandOutdated, false);

  // Ticket 14 owns the plan transition; set the date directly so reopen's
  // promise to clear it can be tested here.
  getDb().prepare("UPDATE pieces SET status = 'planned', planned_date = ? WHERE id = ?").run(
    "2026-09-05",
    piece.id
  );

  const reopened = reopenPiece(reload(piece.id), "operator");
  assert.equal(reopened.ok, true);
  assert.match(String((reopened.response as { note: string }).note), /planned → drafting/);

  current = reload(piece.id);
  assert.equal(current.status, "drafting");
  assert.equal(current.pinnedKitVersion, null);
  assert.equal(current.plannedDate, null);
  assert.equal(current.brandOutdated, false);
});

test("a kit change flags approved and planned work, and leaves drafting work alone", () => {
  const approved = toReview("flagged approved");
  assert.equal(approvePiece(approved, "operator").ok, true);

  const planned = toReview("flagged planned");
  assert.equal(approvePiece(planned, "operator").ok, true);
  getDb().prepare("UPDATE pieces SET status = 'planned' WHERE id = ?").run(planned.id);

  const drafting = makePiece("untouched draft");
  assert.equal(startDrafting(SESSION, { id: drafting.id }).ok, true);

  const pinnedAt = reload(approved.id).pinnedKitVersion;
  updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");

  for (const id of [approved.id, planned.id]) {
    const piece = reload(id);
    assert.equal(piece.brandOutdated, true, `piece ${id} should be brand-outdated`);
    // The pin itself does not move: it still records what was approved.
    assert.equal(piece.pinnedKitVersion, pinnedAt);
  }
  assert.equal(reload(drafting.id).brandOutdated, false);

  updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
});

// ---------------------------------------------------------------------------
// Criterion 3: contract replays of CreativePieceMachine walkthroughs 3 and 4

test("contract replay, walkthrough 3: brand errors gate approval, quality findings advise", () => {
  // "Create piece"
  const piece = makePiece("VinylOS drop announcement", doc({ format: "9:16" }));

  // "Start drafting"
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);

  // "AI Host adds an off-brand pink layer" (plus three on-kit ones, which is
  // what tips the slide into the crowded-composition finding)
  const added = applyEditBatch(SESSION, {
    id: piece.id,
    baseVersion: 1,
    ops: [
      { op: "add_layer", slide: 0, layer: { type: "shape", shape: "rect", fill: "#ff2d95" } },
      { op: "add_layer", slide: 0, layer: { type: "shape", shape: "rect", fill: "brand.paper" } },
      { op: "add_layer", slide: 0, layer: { type: "shape", shape: "rect", fill: "brand.paper" } },
      { op: "add_layer", slide: 0, layer: { type: "shape", shape: "rect", fill: "brand.paper" } },
    ],
  });
  assert.equal(added.ok, true);

  // "Run checks: 1 brand error + crowded-slide finding" — the prototype's
  // RUN_CHECKS, read here through approval_status, while still drafting.
  const status = approvalStatus(SESSION, { id: piece.id });
  const approval = status.response.approval as {
    brandErrors: { code: string }[];
    qualityFindings: { code: string }[];
  };
  assert.deepEqual(approval.brandErrors.map((f) => f.code), ["off_kit_color"]);
  assert.ok(approval.qualityFindings.some((f) => f.code === "crowded_slide"));

  // "Submit for review"
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);

  // "Try to approve → blocked by brand error"
  const blocked = approvePiece(reload(piece.id), "operator");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.response.error, "approval_blocked");
  assert.equal(reload(piece.id).status, "review");

  // "Request changes (back to drafting)"
  assert.equal(requestPieceChanges(reload(piece.id), "operator").ok, true);
  assert.equal(reload(piece.id).status, "drafting");

  // "Fix: recolor the pink layer to a token"
  const fixed = applyEditBatch(SESSION, {
    id: piece.id,
    baseVersion: reload(piece.id).docVersion,
    ops: [{ op: "set_fill", slide: 0, layer: 2, value: "brand.accent" }],
  });
  assert.equal(fixed.ok, true);

  // "Submit again", then "Approve → passes, quality finding stays advisory"
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  const approved = approvePiece(reload(piece.id), "operator");
  assert.equal(approved.ok, true, JSON.stringify(approved.response));
  assert.equal(reload(piece.id).status, "approved");
  const stillOpen = approved.response.qualityFindings as { code: string }[];
  assert.ok(stillOpen.some((f) => f.code === "crowded_slide"));
});

test("contract replay, walkthrough 4: a kit change after approval flags, and re-approval re-pins", () => {
  // "Create piece" / "Start drafting" / "Submit for review"
  const piece = toReview("KeepAnalog carousel", doc({ format: "4:5" }));

  // "Approve (pins kit v1)"
  assert.equal(approvePiece(piece, "operator").ok, true);
  const pinnedAt = reload(piece.id).pinnedKitVersion;
  assert.equal(pinnedAt, currentKit(projectId).version);

  // "Plan for Sep 5" — ticket 14 owns the transition; the date is what
  // walkthrough 4 needs, to prove re-approval does not disturb it.
  getDb()
    .prepare("UPDATE pieces SET status = 'planned', planned_date = ? WHERE id = ?")
    .run("2026-09-05", piece.id);

  // "Brand Kit primary changes → preview repaints, piece flagged"
  const beforeHtml = (renderPreview(SESSION, { id: piece.id }).response.preview as {
    slides: string[];
  }).slides[0];
  const newKit = updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");
  const afterHtml = (renderPreview(SESSION, { id: piece.id }).response.preview as {
    slides: string[];
  }).slides[0];
  assert.notEqual(afterHtml, beforeHtml);

  let current = reload(piece.id);
  assert.equal(current.brandOutdated, true);
  assert.equal(current.pinnedKitVersion, pinnedAt);
  assert.equal(current.status, "planned");

  // "Re-approve → re-pins to kit v2"
  const reapproved = reapprovePiece(current, "operator");
  assert.equal(reapproved.ok, true, JSON.stringify(reapproved.response));
  assert.match(String((reapproved.response as { note: string }).note), /re-pinned/);

  current = reload(piece.id);
  assert.equal(current.pinnedKitVersion, newKit.version);
  assert.equal(current.brandOutdated, false);
  // Status and planned date are untouched by re-approval.
  assert.equal(current.status, "planned");
  assert.equal(current.plannedDate, "2026-09-05");

  // The walkthrough's remaining two steps are "Try to export → blocked while
  // brand-outdated" and "Export → succeeds". Refusing an export while
  // brand-outdated is ticket 14's criterion, so it is not asserted here.
  // What ticket 13 owes is that the pin means something, which the export
  // test below checks directly.

  updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
});

test("an approved piece exports through the kit its approval pinned, not the current one", () => {
  const piece = toReview("pinned export");
  assert.equal(approvePiece(piece, "operator").ok, true);
  const pinned = reload(piece.id).pinnedKitVersion;
  assert.ok(pinned !== null);

  const approvedHtml = (renderPreview(SESSION, { id: piece.id }).response.preview as {
    slides: string[];
  }).slides[0];

  updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");

  // The preview repaints, which is how the Operator sees what changed...
  const repainted = (renderPreview(SESSION, { id: piece.id }).response.preview as {
    slides: string[];
  }).slides[0];
  assert.notEqual(repainted, approvedHtml);
  assert.equal(reload(piece.id).brandOutdated, true);

  // ...but the export renders through the pinned kit, so the artifact that
  // leaves is the one the Operator signed off on.
  const doc = reload(piece.id).doc;
  const pinnedKit = kitAtVersion(projectId, pinned);
  assert.ok(pinnedKit);
  assert.equal(renderSlideHtml(doc, 0, pinnedKit.tokens), approvedHtml);
  assert.notEqual(pinnedKit.tokens["brand.accent"], currentKit(projectId).tokens["brand.accent"]);

  updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
});

test("re-approval is refused while a blocker exists, and the piece stays flagged", () => {
  updateKit(projectId, { tokens: { "brand.spot": "#204060" } }, "operator");
  const piece = toReview(
    "re-approval blocked",
    doc({ slides: [{ layers: [{ type: "shape", shape: "rect", fill: "brand.spot" }] }] })
  );
  assert.equal(approvePiece(piece, "operator").ok, true);

  // The kit moves on, and the token this piece leans on leaves with it. The
  // piece is now both brand-outdated and off-kit.
  updateKit(projectId, { tokens: { "brand.spot": null } }, "operator");
  const outdated = reload(piece.id);
  assert.equal(outdated.brandOutdated, true);

  const refused = reapprovePiece(outdated, "operator");
  assert.equal(refused.ok, false);
  assert.equal(refused.response.error, "approval_blocked");
  assert.match(String(refused.response.message), /Re-approval refused/);
  assert.match(String(refused.response.message), /brand\.spot/);
  // Refused leaves the flag up: the Operator has not seen the new rendering.
  assert.equal(reload(piece.id).brandOutdated, true);
  assert.equal(reload(piece.id).status, "approved");
});

// ---------------------------------------------------------------------------
// The Operator surface

test("the Operator approves over HTTP; the host has no approve tool at all", async () => {
  const piece = toReview("http approval");

  const approved = await post(`/api/pieces/${piece.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal((approved.body.piece as { status: string }).status, "approved");
  assert.equal(reload(piece.id).pinnedKitVersion, currentKit(projectId).version);

  // A refused move answers 409 and changes nothing.
  const again = await post(`/api/pieces/${piece.id}/approve`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "wrong_status");
  assert.equal(reload(piece.id).status, "approved");

  const reopened = await post(`/api/pieces/${piece.id}/reopen`);
  assert.equal(reopened.status, 200);
  assert.equal(reload(piece.id).status, "drafting");
  assert.equal(reload(piece.id).pinnedKitVersion, null);

  assert.equal((await post("/api/pieces/424242/approve")).status, 404);

  const unauthenticated = await fetch(
    `http://127.0.0.1:${port}/api/pieces/${piece.id}/approve`,
    { method: "POST" }
  );
  assert.equal(unauthenticated.status, 401);
});

test("Studio reads the approval blockers alongside both check reports", async () => {
  const piece = toReview(
    "studio blockers",
    doc({
      slides: [{ layers: [{ type: "text", text: "Rated best by [NEED: source]", role: "headline" }] }],
    })
  );
  const res = await fetch(`http://127.0.0.1:${port}/api/pieces/${piece.id}/checks`, {
    headers: { cookie },
  });
  const body = (await res.json()) as {
    brand: { errors: unknown[] };
    quality: { advisory: boolean };
    approval: { brandErrors: unknown[]; needTokens: { token: string }[] };
  };
  assert.equal(res.status, 200);
  assert.deepEqual(body.approval.brandErrors, body.brand.errors);
  assert.deepEqual(body.approval.needTokens.map((n) => n.token), ["[NEED: source]"]);
  assert.equal(body.quality.advisory, true);
});

test("Studio is told which Operator moves apply, and the list follows the status", async () => {
  const piece = makePiece("available moves");
  const res = await fetch(`http://127.0.0.1:${port}/api/pieces`, { headers: { cookie } });
  const body = (await res.json()) as {
    pieces: { id: number; operatorMoves: string[] }[];
  };
  const listed = body.pieces.find((p) => p.id === piece.id);
  // Nothing to approve or reopen in the backlog.
  assert.deepEqual(listed?.operatorMoves, []);

  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.deepEqual(availableOperatorMoves(reload(piece.id)), []);

  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  assert.deepEqual(availableOperatorMoves(reload(piece.id)), [
    "approve",
    "request-changes",
    "reopen",
  ]);

  // Approved: a date can go on, and the piece can still be reopened.
  assert.equal(approvePiece(reload(piece.id), "operator").ok, true);
  assert.deepEqual(availableOperatorMoves(reload(piece.id)), ["plan", "reopen"]);

  // Planned: the date can come off, and the bundle can be exported.
  assert.equal(planPiece(reload(piece.id), "2026-09-05", "operator").ok, true);
  assert.deepEqual(availableOperatorMoves(reload(piece.id)), ["unplan", "export", "reopen"]);

  updateKit(projectId, { tokens: { "brand.accent": "#334455" } }, "operator");
  assert.deepEqual(availableOperatorMoves(reload(piece.id)), [
    "reapprove",
    "unplan",
    "export",
    "reopen",
  ]);

  updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
});
