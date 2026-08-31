import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import {
  ApprovalError,
  decidePreparedChange,
  listPreparedChanges,
  renderDiff,
  type ApprovalStatus,
  type PreparedChange,
} from "./project-changes";
import { listProjects } from "./projects";

// The Operator's side of a two-phase project write. A prepared digest is an
// explicit interruption, never a step on the guided rail: it appears
// because a host asked to change a Connected Project, and it waits for a
// person to look at the exact diff and say yes or no.
export function approvalRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  function decorate(prepared: PreparedChange, names: Map<number, string>) {
    return {
      ...prepared,
      projectName: names.get(prepared.projectId) ?? `project #${prepared.projectId}`,
      diffText: renderDiff(prepared.diff),
    };
  }

  router.get("/", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    const changes = listPreparedChanges(status as ApprovalStatus | undefined);
    res.json({
      note: "A prepared change is an interruption, not a step. Nothing reaches a Connected Project until you approve the exact diff below.",
      pending: changes.filter((c) => c.status === "pending").length,
      changes: changes.map((c) => decorate(c, names)),
    });
  });

  for (const decision of ["approve", "reject"] as const) {
    router.post(`/:digest/${decision}`, (req, res) => {
      try {
        const prepared = decidePreparedChange(
          req.params.digest,
          decision === "approve" ? "approved" : "rejected",
          "operator"
        );
        const names = new Map(listProjects().map((p) => [p.id, p.name]));
        res.json({
          change: decorate(prepared, names),
          note:
            decision === "approve"
              ? `Approved digest ${prepared.digest}. The approval is single-use and bound to this digest; no token goes to the AI Host.`
              : `Rejected digest ${prepared.digest}. Nothing was written, and the host is told to revise and prepare again.`,
        });
      } catch (err) {
        if (err instanceof ApprovalError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        log("error", "approval decision failed", {
          digest: req.params.digest,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
        res.status(500).json({ error: "Internal error" });
      }
    });
  }

  return router;
}
