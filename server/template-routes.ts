import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { listProjects } from "./projects";
import { listAllTemplates, templateSummary } from "./templates";

// Operator surface for Creative Templates. A template is not a piece — it is
// the structure a piece can be started from — so it gets its own path rather
// than living under /api/pieces.
//
// Read-only on purpose: saving a template is an act on a piece, and starting
// a piece from one needs a pinned Project Snapshot, which only a gateway
// session has. The host does that through marketingos.instantiate_template.
export function templateRouter(): Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/", (_req, res) => {
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    res.json({
      templates: listAllTemplates().map((template) => ({
        ...templateSummary(template),
        projectId: template.projectId,
        projectName: names.get(template.projectId) ?? `project #${template.projectId}`,
      })),
    });
  });

  return router;
}
