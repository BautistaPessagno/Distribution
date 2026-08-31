import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import {
  listProjects,
  ProjectError,
  registerProject,
  rotateProjectToken,
  runConformanceFor,
} from "./projects";

function handleError(res: Response, err: unknown): void {
  if (err instanceof ProjectError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  log("error", "project route error", {
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  res.status(500).json({ error: "Internal error" });
}

export function projectRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/", (_req, res) => {
    try {
      res.json({ projects: listProjects() });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
      if (!name) {
        res.status(400).json({ error: "A project name is required" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        res.status(400).json({ error: "The project domain must be a valid URL" });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(400).json({ error: "The project domain must be an http(s) URL" });
        return;
      }
      const { token, project, report } = await registerProject(name, baseUrl, "operator");
      res.json({ token, project, report });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/:id/conformance", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid project id" });
        return;
      }
      const report = await runConformanceFor(id, "operator");
      res.json({ report });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/:id/rotate-token", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid project id" });
        return;
      }
      const { token, project } = await rotateProjectToken(id, "operator");
      res.json({ token, project });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
