import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { BrandKitError, currentKit, listKitVersions, updateKit } from "./brand-kit";
import { log } from "./log";
import { listProjects } from "./projects";

// Operator surface for the Brand Kit: read the token table one project
// renders through, and change a token. A change mints a new kit version and
// repaints backlog and drafting pieces; no piece document is touched.
export function brandKitRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  function projectOr404(req: Request, res: Response): { id: number; name: string } | null {
    const id = Number(req.params.projectId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid project id" });
      return null;
    }
    const project = listProjects().find((p) => p.id === id);
    if (!project) {
      res.status(404).json({ error: `No Connected Project #${id}` });
      return null;
    }
    return { id: project.id, name: project.name };
  }

  router.get("/", (_req, res) => {
    res.json({
      kits: listProjects().map((project) => ({
        projectId: project.id,
        projectName: project.name,
        kit: currentKit(project.id),
      })),
    });
  });

  router.get("/:projectId", (req, res) => {
    const project = projectOr404(req, res);
    if (!project) return;
    res.json({
      projectId: project.id,
      projectName: project.name,
      kit: currentKit(project.id),
      versions: listKitVersions(project.id),
    });
  });

  router.put("/:projectId", (req, res) => {
    const project = projectOr404(req, res);
    if (!project) return;
    try {
      const kit = updateKit(project.id, req.body, "operator");
      res.json({ projectId: project.id, projectName: project.name, kit });
    } catch (err) {
      if (err instanceof BrandKitError) {
        res.status(400).json({ error: err.message, detail: err.detail });
        return;
      }
      log("error", "brand kit route error", {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
