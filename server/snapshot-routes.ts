import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import {
  deliveryEvidence,
  experimentEvidence,
  listSnapshots,
  readProjectFunnel,
  seriesFor,
  snapshotView,
  SnapshotError,
} from "./snapshots";

// The Operator surface for Metric Snapshots. Reading is free; writing
// happens through a measure Work Order or a funnel read, because a number
// with no source is not an observation.
export function snapshotRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  function handle(res: Response, err: unknown): void {
    if (err instanceof SnapshotError) {
      res.status(err.status).json({ error: err.message, detail: err.detail });
      return;
    }
    log("error", "snapshot route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  function numberQuery(req: Request, name: string): number | undefined {
    const raw = req.query[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) ? value : Number.NaN;
  }

  router.get("/", (req, res) => {
    const projectId = numberQuery(req, "projectId");
    const targetId = numberQuery(req, "targetId");
    const experimentId = numberQuery(req, "experimentId");
    if ([projectId, targetId, experimentId].some((v) => Number.isNaN(v))) {
      res.status(400).json({ error: "Filters take integer ids" });
      return;
    }
    const metric = typeof req.query.metric === "string" ? req.query.metric : undefined;
    res.json({
      snapshots: listSnapshots({ projectId, targetId, experimentId, metric }).map(snapshotView),
    });
  });

  /** One metric for one delivery, oldest first: the series, not a total. */
  router.get("/series", (req, res) => {
    const targetId = numberQuery(req, "targetId");
    const metric = typeof req.query.metric === "string" ? req.query.metric : "";
    if (targetId === undefined || Number.isNaN(targetId) || !metric) {
      res.status(400).json({ error: "A series names the delivery and the metric" });
      return;
    }
    res.json({ series: seriesFor(targetId, metric).map(snapshotView) });
  });

  router.get("/experiments/:id", (req, res) => {
    try {
      res.json({ evidence: experimentEvidence(Number(req.params.id)) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.get("/deliveries/:id", (req, res) => {
    try {
      res.json({ evidence: deliveryEvidence(Number(req.params.id)) });
    } catch (err) {
      handle(res, err);
    }
  });

  /** Read the project's own product funnel and file what it says. */
  router.post("/funnel-read", async (req, res) => {
    try {
      const outcome = await readProjectFunnel(Number(req.body?.projectId), "operator");
      res.json({
        snapshots: outcome.snapshots.map(snapshotView),
        provenance: outcome.provenance,
      });
    } catch (err) {
      handle(res, err);
    }
  });

  return router;
}
