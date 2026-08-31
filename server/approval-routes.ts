import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import {
  ApprovalError,
  decidePreparedChangeSet,
  listPreparedChangeSets,
  renderDiff,
  type ApprovalStatus,
  type PreparedChangeSet,
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

  /** One project-name lookup per response, not one per change. */
  function decorator(): (prepared: PreparedChangeSet) => Record<string, unknown> {
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    return (prepared) => ({
      ...prepared,
      projectName: names.get(prepared.projectId) ?? `project #${prepared.projectId}`,
      diffText: renderDiff(prepared.diff),
    });
  }

  const STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "rejected", "used"];

  router.get("/", (req, res) => {
    const asked = typeof req.query.status === "string" ? req.query.status : undefined;
    if (asked !== undefined && !STATUSES.includes(asked as ApprovalStatus)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      return;
    }
    const changes = listPreparedChangeSets(asked as ApprovalStatus | undefined);
    res.json({
      note: "A prepared change is an interruption, not a step. Nothing reaches a Connected Project until you approve the exact diff below.",
      pending: changes.filter((c) => c.status === "pending").length,
      changes: changes.map(decorator()),
    });
  });

  for (const decision of ["approve", "reject"] as const) {
    router.post(`/:digest/${decision}`, (req, res) => {
      try {
        const prepared = decidePreparedChangeSet(
          req.params.digest,
          decision === "approve" ? "approved" : "rejected",
          "operator"
        );
        res.json({
          change: decorator()(prepared),
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
