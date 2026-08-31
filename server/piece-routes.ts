import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { currentKit } from "./brand-kit";
import { reportsForPiece } from "./checks";
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

  // check_brand and check_quality for one piece, so Studio shows what gates
  // approval and what only advises.
  router.get("/:id/checks", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid piece id" });
      return;
    }
    const reports = reportsForPiece(id);
    if (!reports) {
      res.status(404).json({ error: `No piece #${id}` });
      return;
    }
    res.json(reports);
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
      kit: currentKit(piece.projectId),
    });
  });

  return router;
}
