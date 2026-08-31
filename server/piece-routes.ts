import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { listVersionsForPiece } from "./piece-edits";
import { getPieceById, listAllPieces } from "./pieces";
import { listProjects } from "./projects";

// Operator surface for Creative Pieces: Studio lists every piece across
// Connected Projects and shows one piece's PieceDoc detail.
export function pieceRouter(): Router {
  const router = express.Router();

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

  router.get("/", (_req, res) => {
    const names = projectNames();
    res.json({
      pieces: listAllPieces().map((piece) => ({
        ...piece,
        projectName: names.get(piece.projectId) ?? `project #${piece.projectId}`,
      })),
    });
  });

  router.get("/:id/versions", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid piece id" });
      return;
    }
    const piece = getPieceById(id);
    if (!piece) {
      res.status(404).json({ error: `No piece #${id}` });
      return;
    }
    res.json({ versions: listVersionsForPiece(id) });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid piece id" });
      return;
    }
    const piece = getPieceById(id);
    if (!piece) {
      res.status(404).json({ error: `No piece #${id}` });
      return;
    }
    const names = projectNames();
    res.json({
      piece: {
        ...piece,
        projectName: names.get(piece.projectId) ?? `project #${piece.projectId}`,
      },
    });
  });

  return router;
}
