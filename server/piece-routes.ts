import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { currentKit } from "./brand-kit";
import { reportsForPiece } from "./checks";
import { listVersionsForPiece } from "./piece-edits";
import {
  approvalBlockers,
  approvePiece,
  reapprovePiece,
  reopenPiece,
  requestPieceChanges,
} from "./piece-lifecycle";
import { getPieceById, listAllPieces } from "./pieces";
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
    const names = projectNames();
    // Pieces hold token references; the kit holds the values. Studio needs
    // both to paint a piece, and a kit change repaints it with no document
    // change at all.
    const kits = new Map<number, ReturnType<typeof currentKit>>();
    res.json({
      pieces: listAllPieces().map((piece) => {
        let kit = kits.get(piece.projectId);
        if (!kit) {
          kit = currentKit(piece.projectId);
          kits.set(piece.projectId, kit);
        }
        return {
          ...piece,
          projectName: names.get(piece.projectId) ?? `project #${piece.projectId}`,
          kit,
        };
      }),
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
  const OPERATOR_MOVES = {
    approve: approvePiece,
    reapprove: reapprovePiece,
    reopen: reopenPiece,
  } as const;

  for (const [path, move] of Object.entries(OPERATOR_MOVES)) {
    router.post(`/:id/${path}`, (req, res) => {
      const piece = pieceOr404(req, res);
      if (!piece) return;
      const result = move(piece, "operator");
      res.status(result.ok ? 200 : 409).json(result.response);
    });
  }

  router.post("/:id/request-changes", (req, res) => {
    const piece = pieceOr404(req, res);
    if (!piece) return;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : undefined;
    const result = requestPieceChanges(piece, "operator", reason || undefined);
    res.status(result.ok ? 200 : 409).json(result.response);
  });

  router.get("/:id", (req, res) => {
    const piece = pieceOr404(req, res);
    if (!piece) return;
    const names = projectNames();
    res.json({
      piece: {
        ...piece,
        projectName: names.get(piece.projectId) ?? `project #${piece.projectId}`,
      },
      kit: currentKit(piece.projectId),
    });
  });

  return router;
}
