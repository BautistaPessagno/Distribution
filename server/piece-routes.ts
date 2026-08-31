import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { currentKit } from "./brand-kit";
import { log } from "./log";
import type { GatewayResult } from "./gateway";
import { reportsForPiece } from "./checks";
import { listVersionsForPiece } from "./piece-edits";
import {
  approvalBlockers,
  approvePiece,
  availableOperatorMoves,
  planPiece,
  reapprovePiece,
  reopenPiece,
  requestPieceChanges,
  unplanPiece,
  type OperatorMove,
} from "./piece-lifecycle";
import { exportPieceRecord } from "./renderer";
import {
  getPieceById,
  listAllPieces,
  listBacklog,
  listPlanned,
  type PieceRecord,
} from "./pieces";
import { listProjects } from "./projects";

// Operator surface for Creative Pieces: Studio lists every piece across
// Connected Projects and shows one piece's PieceDoc detail.
export function pieceRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  function projectNames(): Map<number, string> {
    return new Map(listProjects().map((p) => [p.id, p.name]));
  }

  /**
   * Everything the dashboard needs to paint a piece: its project, the kit it
   * renders through, and the Operator moves it can take right now. Project
   * names and kits are looked up once per response, not once per piece —
   * currentKit seeds a default kit on first read, so a list read would
   * otherwise write once per row.
   */
  function decorator(): (piece: PieceRecord) => Record<string, unknown> {
    const names = projectNames();
    const kits = new Map<number, ReturnType<typeof currentKit>>();
    return (piece) => {
      let kit = kits.get(piece.projectId);
      if (!kit) {
        kit = currentKit(piece.projectId);
        kits.set(piece.projectId, kit);
      }
      return {
        ...piece,
        projectName: names.get(piece.projectId) ?? `project #${piece.projectId}`,
        kit,
        operatorMoves: availableOperatorMoves(piece),
      };
    };
  }

  function pieceOr404(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid piece id" });
      return null;
    }
    const piece = getPieceById(id);
    if (!piece) {
      res.status(404).json({ error: `No piece #${id}` });
      return null;
    }
    return piece;
  }

  router.get("/", (_req, res) => {
    res.json({ pieces: listAllPieces().map(decorator()) });
  });

  // The Content Backlog and the calendar. Both read the same pieces table,
  // so they reflect a lifecycle move the moment it lands. Registered ahead
  // of /:id so the words are not read as piece ids.
  router.get("/backlog", (_req, res) => {
    res.json({ pieces: listBacklog().map(decorator()) });
  });

  router.get("/calendar", (_req, res) => {
    const planned = listPlanned().map(decorator());
    const days = new Map<string, Record<string, unknown>[]>();
    for (const piece of planned) {
      const day = piece.plannedDate as string;
      days.set(day, [...(days.get(day) ?? []), piece]);
    }
    res.json({
      note: "A planned date is a plan. Nothing on this calendar publishes automatically.",
      days: [...days.entries()].map(([date, pieces]) => ({ date, pieces })),
    });
  });

  router.get("/:id/versions", (req, res) => {
    const piece = pieceOr404(req, res);
    if (!piece) return;
    res.json({ versions: listVersionsForPiece(piece.id) });
  });

  // check_brand and check_quality for one piece, so Studio shows what gates
  // approval and what only advises.
  router.get("/:id/checks", (req, res) => {
    const piece = pieceOr404(req, res);
    if (!piece) return;
    const reports = reportsForPiece(piece.id);
    if (!reports) {
      res.status(404).json({ error: `No piece #${piece.id}` });
      return;
    }
    // Brand errors and [NEED: ...] tokens are what gate approval; quality
    // findings ride along so Studio can show both in one place.
    res.json({ ...reports, approval: approvalBlockers(piece) });
  });

  // Approval is the Operator's act: it means a person saw this exact
  // document rendered through this Brand Kit. The AI Host can draft, submit,
  // and reopen; it can never approve.
  // Studio renders its buttons from availableOperatorMoves, so the lifecycle
  // rules live in one place instead of being re-derived client-side.
  const MOVE_HANDLERS: Record<
    OperatorMove,
    (piece: PieceRecord, req: Request) => GatewayResult | Promise<GatewayResult>
  > = {
    approve: (piece) => approvePiece(piece, "operator"),
    "request-changes": (piece, req) => {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      return requestPieceChanges(piece, "operator", reason || undefined);
    },
    reapprove: (piece) => reapprovePiece(piece, "operator"),
    plan: (piece, req) => planPiece(piece, req.body?.date, "operator"),
    unplan: (piece) => unplanPiece(piece, "operator"),
    export: (piece) => exportPieceRecord(piece, "operator"),
    reopen: (piece) => reopenPiece(piece, "operator"),
  };

  for (const [path, move] of Object.entries(MOVE_HANDLERS)) {
    router.post(`/:id/${path}`, async (req, res) => {
      const piece = pieceOr404(req, res);
      if (!piece) return;
      try {
        const result = await move(piece, req);
        res.status(result.ok ? 200 : 409).json(result.response);
      } catch (err) {
        log("error", "piece move failed", {
          move: path,
          pieceId: piece.id,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
        res.status(500).json({ error: "Internal error" });
      }
    });
  }

  router.get("/:id", (req, res) => {
    const piece = pieceOr404(req, res);
    if (!piece) return;
    res.json({ piece: decorator()(piece) });
  });

  return router;
}
