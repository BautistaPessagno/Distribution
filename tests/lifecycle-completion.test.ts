// Lifecycle completion (ticket 14): the Content Backlog, the calendar,
// export from planned, the exported and measured states, and brand-outdated
// blocking export until re-approval.
//
// Reference behavior: the PLAN, UNPLAN, EXPORT, and RECORD_OUTCOME cases of
// CreativePieceMachine in creative-piece-workflow.html, plus walkthrough 5
// "Illegal moves" (planning before approval, exporting from drafting) and
// the two export steps of walkthrough 4.

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
process.env.EXPORTS_PATH = path.join(tmpDir, "exports");

import express from "express";
import { createSession, hashRecoveryCode, SESSION_COOKIE } from "../server/auth";
import { updateKit } from "../server/brand-kit";
import { getDb } from "../server/db";
import { selectProject } from "../server/gateway";
import {
  approvePiece,
  availableOperatorMoves,
  exportRefusal,
  isCalendarDate,
  planPiece,
  reapprovePiece,
  recordOutcome,
  reopenPiece,
  startDrafting,
  submitForReview,
  unplanPiece,
} from "../server/piece-lifecycle";
import { pieceRouter } from "../server/piece-routes";
import {
  createPiece,
  getPieceById,
  listBacklog,
  listPlanned,
  type PieceDoc,
  type PieceRecord,
} from "../server/pieces";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type RequiredResource,
  type ResourceEnvelope,
} from "../server/project-domain-sdk";
import { isActiveProjectTokenHash, registerProject } from "../server/projects";
import { closeRenderer, exportPiece, exportPieceRecord } from "../server/renderer";
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

const SESSION = "lifecycle-session";
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

function doc(): PieceDoc {
  return {
    format: "1:1",
    slides: [{ layers: [{ type: "text", text: "Five reasons paper wins", role: "headline" }] }],
    captions: { instagram: "ig", x: "x", linkedin: "li", tiktok: "tt" },
  };
}

function reload(id: number): PieceRecord {
  const piece = getPieceById(id);
  assert.ok(piece);
  return piece;
}

function makePiece(title: string): PieceRecord {
  const created = createPiece(SESSION, { title, doc: doc() });
  assert.equal(created.ok, true, JSON.stringify(created.response));
  return reload((created.response.piece as { id: number }).id);
}

function approved(title: string): PieceRecord {
  const piece = makePiece(title);
  assert.equal(startDrafting(SESSION, { id: piece.id }).ok, true);
  assert.equal(submitForReview(SESSION, { id: piece.id }).ok, true);
  assert.equal(approvePiece(reload(piece.id), "operator").ok, true);
  return reload(piece.id);
}

function planned(title: string, date = "2026-09-05"): PieceRecord {
  const piece = approved(title);
  assert.equal(planPiece(piece, date, "operator").ok, true);
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

test.after(async () => {
  await closeRenderer();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Criterion 1: only approved pieces accept a date; only planned ones export

test("only an approved piece accepts a planned date", () => {
  const backlog = makePiece("plan too early");

  // Walkthrough 5, "Try to plan while in backlog → refused".
  const early = planPiece(backlog, "2026-09-10", "operator");
  assert.equal(early.ok, false);
  assert.equal(early.response.error, "wrong_status");
  assert.equal(reload(backlog.id).plannedDate, null);

  assert.equal(startDrafting(SESSION, { id: backlog.id }).ok, true);
  assert.equal(planPiece(reload(backlog.id), "2026-09-10", "operator").ok, false);
  assert.equal(reload(backlog.id).status, "drafting");

  const ready = approved("plans fine");
  const ok = planPiece(ready, "2026-09-05", "operator");
  assert.equal(ok.ok, true);
  assert.match(String((ok.response as { note: string }).note), /nothing publishes automatically/);

  const now = reload(ready.id);
  assert.equal(now.status, "planned");
  assert.equal(now.plannedDate, "2026-09-05");
  // The approval it was planned from is untouched.
  assert.equal(now.pinnedKitVersion, ready.pinnedKitVersion);
});

test("a planned date must be a real calendar day", () => {
  const piece = approved("bad dates");
  for (const date of ["tomorrow", "2026-9-5", "05-09-2026", "2026-02-30", "", 20260905]) {
    const result = planPiece(reload(piece.id), date, "operator");
    assert.equal(result.ok, false, `${String(date)} should be refused`);
    assert.equal(result.response.error, "invalid_date");
  }
  assert.equal(reload(piece.id).status, "approved");

  assert.equal(isCalendarDate("2026-09-05"), true);
  assert.equal(isCalendarDate("2026-02-30"), false);
});

test("unplanning returns a piece to approved and undated, approval intact", () => {
  const piece = planned("unplan me");
  const result = unplanPiece(piece, "operator");
  assert.equal(result.ok, true);

  const now = reload(piece.id);
  assert.equal(now.status, "approved");
  assert.equal(now.plannedDate, null);
  assert.equal(now.pinnedKitVersion, piece.pinnedKitVersion);

  assert.equal(unplanPiece(now, "operator").ok, false);
});

test("only a planned piece exports", async () => {
  const backlog = makePiece("export too early");
  // Walkthrough 5, "Try to export while drafting → refused".
  assert.equal(startDrafting(SESSION, { id: backlog.id }).ok, true);
  const early = await exportPieceRecord(reload(backlog.id), "operator");
  assert.equal(early.ok, false);
  assert.equal(early.response.error, "not_exportable");
  assert.match(String(early.response.message), /is drafting/);

  const ready = approved("export needs a date");
  const undated = await exportPieceRecord(ready, "operator");
  assert.equal(undated.ok, false);
  assert.equal(undated.response.error, "not_exportable");
  // The refusal names the actual next step, not just the rule.
  assert.match(String(undated.response.next), /plan_piece/);

  assert.equal(reload(ready.id).status, "approved");
});

test("an export from planned produces the bundle and moves the piece to exported", async () => {
  const piece = planned("exports cleanly");

  const result = await exportPieceRecord(piece, "operator");
  assert.equal(result.ok, true, JSON.stringify(result.response));

  const bundle = result.response.bundle as { name: string; manifest: { kitVersion: number } };
  assert.equal(bundle.manifest.kitVersion, piece.pinnedKitVersion);
  assert.ok(fs.existsSync(path.join(process.env.EXPORTS_PATH as string, bundle.name)));

  const now = reload(piece.id);
  assert.equal(now.status, "exported");
  // Exported work is out of the backlog and off the calendar's open work.
  assert.ok(!listBacklog().some((p) => p.id === piece.id));

  // A second export is refused: the piece has already left.
  const again = await exportPieceRecord(now, "operator");
  assert.equal(again.ok, false);
  assert.equal(again.response.error, "not_exportable");
});

// ---------------------------------------------------------------------------
// Criterion 2: export refuses while brand-outdated, naming re-approval

test("export refuses while brand-outdated and names re-approval as the path", async () => {
  const piece = planned("outdated before export");

  updateKit(projectId, { tokens: { "brand.accent": "#8a4fff" } }, "operator");
  const outdated = reload(piece.id);
  assert.equal(outdated.brandOutdated, true);

  const refused = await exportPieceRecord(outdated, "operator");
  assert.equal(refused.ok, false);
  assert.equal(refused.response.error, "brand_outdated");
  assert.match(String(refused.response.message), /saw that exact rendering/);
  assert.match(String(refused.response.next), /Re-approve/);
  assert.equal(reload(piece.id).status, "planned");

  // Walkthrough 4's last two steps: re-approve, then export succeeds.
  assert.equal(reapprovePiece(reload(piece.id), "operator").ok, true);
  const exported = await exportPieceRecord(reload(piece.id), "operator");
  assert.equal(exported.ok, true, JSON.stringify(exported.response));
  assert.equal(reload(piece.id).status, "exported");

  updateKit(
    projectId,
    { tokens: { "brand.accent": DEFAULT_BRAND_TOKENS["brand.accent"] } },
    "operator"
  );
});

test("exportRefusal is the single reason export is or is not allowed", () => {
  const backlogPiece = makePiece("refusal reasons");
  assert.equal(exportRefusal(backlogPiece)?.response.error, "not_exportable");

  const readyPiece = planned("refusal reasons planned");
  assert.equal(exportRefusal(readyPiece), null);
});

// ---------------------------------------------------------------------------
// Exported and measured

test("an exported piece records an outcome and becomes measured", async () => {
  const piece = planned("measure me");
  assert.equal((await exportPieceRecord(piece, "operator")).ok, true);

  const tooEarly = recordOutcome(planned("not exported yet"), "nope", "operator");
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.response.error, "wrong_status");

  const blank = recordOutcome(reload(piece.id), "   ", "operator");
  assert.equal(blank.ok, false);
  assert.equal(blank.response.error, "invalid_outcome");

  const recorded = recordOutcome(reload(piece.id), "412 saves, 9 replies", "operator");
  assert.equal(recorded.ok, true);

  const now = reload(piece.id);
  assert.equal(now.status, "measured");
  assert.equal(now.outcome, "412 saves, 9 replies");
});

// ---------------------------------------------------------------------------
// Criterion 3: the backlog and the calendar reflect state changes immediately

test("the backlog holds undated work and the calendar holds dated work, moving between them", () => {
  const piece = approved("moves between views");

  const inBacklog = () => listBacklog().some((p) => p.id === piece.id);
  const onCalendar = () => listPlanned().some((p) => p.id === piece.id);

  assert.equal(inBacklog(), true);
  assert.equal(onCalendar(), false);

  assert.equal(planPiece(reload(piece.id), "2026-09-05", "operator").ok, true);
  assert.equal(inBacklog(), false);
  assert.equal(onCalendar(), true);

  assert.equal(unplanPiece(reload(piece.id), "operator").ok, true);
  assert.equal(inBacklog(), true);
  assert.equal(onCalendar(), false);

  // Reopening a planned piece clears the date, so it lands back in the
  // backlog without anyone unplanning it.
  assert.equal(planPiece(reload(piece.id), "2026-09-06", "operator").ok, true);
  assert.equal(onCalendar(), true);
  assert.equal(reopenPiece(reload(piece.id), "operator").ok, true);
  assert.equal(onCalendar(), false);
  assert.equal(inBacklog(), true);
});

test("the calendar groups by day, soonest first, and says what a date means", async () => {
  const late = planned("later piece", "2026-10-01");
  const early = planned("earlier piece", "2026-09-02");

  const { status, body } = await api<{
    note: string;
    days: { date: string; pieces: { id: number; operatorMoves: string[] }[] }[];
  }>("/api/pieces/calendar");
  assert.equal(status, 200);
  assert.match(body.note, /nothing.*publishes automatically/i);

  const dates = body.days.map((d) => d.date);
  assert.deepEqual([...dates].sort(), dates);
  assert.ok(dates.indexOf("2026-09-02") < dates.indexOf("2026-10-01"));

  const earlyDay = body.days.find((d) => d.date === "2026-09-02");
  assert.ok(earlyDay?.pieces.some((p) => p.id === early.id));
  assert.ok(body.days.find((d) => d.date === "2026-10-01")?.pieces.some((p) => p.id === late.id));

  // The calendar carries the moves it can offer, decided server-side.
  const row = earlyDay?.pieces.find((p) => p.id === early.id);
  assert.deepEqual(row?.operatorMoves, ["unplan", "export", "reopen"]);
});

test("the Operator plans, unplans, and exports over HTTP, and the views follow", async () => {
  const piece = approved("http planning");

  const badDate = await api<{ error: string }>(`/api/pieces/${piece.id}/plan`, {
    method: "POST",
    body: JSON.stringify({ date: "next tuesday" }),
  });
  assert.equal(badDate.status, 409);
  assert.equal(badDate.body.error, "invalid_date");

  const plannedRes = await api<{ piece: { status: string; plannedDate: string } }>(
    `/api/pieces/${piece.id}/plan`,
    { method: "POST", body: JSON.stringify({ date: "2026-09-09" }) }
  );
  assert.equal(plannedRes.status, 200);
  assert.equal(plannedRes.body.piece.plannedDate, "2026-09-09");

  const backlogAfterPlan = await api<{ pieces: { id: number }[] }>("/api/pieces/backlog");
  assert.ok(!backlogAfterPlan.body.pieces.some((p) => p.id === piece.id));

  const exported = await api<{ bundle: { name: string } }>(`/api/pieces/${piece.id}/export`, {
    method: "POST",
  });
  assert.equal(exported.status, 200);
  assert.ok(exported.body.bundle.name.startsWith(`piece-${piece.id}-`));
  assert.equal(reload(piece.id).status, "exported");

  assert.deepEqual(availableOperatorMoves(reload(piece.id)), []);
});

test("the host exports through the gateway, scoped to its selected project", async () => {
  const piece = planned("host export");

  const crossProject = await exportPiece("other-session", { id: piece.id });
  assert.equal(crossProject.ok, false);
  assert.equal(crossProject.response.error, "no_project_selected");

  const result = await exportPiece(SESSION, { id: piece.id });
  assert.equal(result.ok, true, JSON.stringify(result.response));
  assert.ok(result.response.context, "the gateway echoes its session context");
  assert.equal(reload(piece.id).status, "exported");
});
