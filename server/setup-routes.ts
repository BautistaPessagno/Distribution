import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import { resumeStep, setupRail, SetupError, skipStep } from "./setup-rail";

// The setup rail's surface. Read the rail, skip a step, resume a skipped
// one. There is deliberately nothing here that touches a Connected Project:
// setup never writes, so the surface has no route that could.
export function setupRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  function handle(res: Response, err: unknown): void {
    if (err instanceof SetupError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    log("error", "setup route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  /** The rail, built from live state rather than from remembered progress. */
  router.get("/", (req, res) => {
    res.json({ rail: setupRail(publicBase(req)) });
  });

  router.post("/:step/skip", (req, res) => {
    try {
      res.json({ rail: skipStep(req.params.step, "operator") });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:step/resume", (req, res) => {
    try {
      res.json({ rail: resumeStep(req.params.step, "operator") });
    } catch (err) {
      handle(res, err);
    }
  });

  return router;
}

/**
 * Where this server actually is, so the connector instruction is one a
 * person can paste rather than one they have to correct.
 */
function publicBase(req: Request): string | undefined {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : undefined;
}
