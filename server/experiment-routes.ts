import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import {
  concludeWithDecision,
  correlationsFor,
  decisionView,
  DecisionError,
  getDecisionFor,
  highestRungAvailable,
  learningLogView,
  sampleState,
} from "./decisions";
import {
  declareExperiment,
  enrollDelivery,
  experimentView,
  ExperimentError,
  getExperimentById,
  listExperiments,
  measureAdHoc,
  scheduleOutstandingObservations,
  stopExperiment,
  type Experiment,
} from "./experiments";
import { log } from "./log";
import { orderView } from "./work-orders";

// The Operator surface for Experiments. Declaring one is a person's act and
// happens before any work ships; everything after it is the system holding
// that declaration to its word.
export function experimentRouter(): Router {
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
    if (err instanceof ExperimentError || err instanceof DecisionError) {
      res.status(err.status).json({ error: err.message, detail: err.detail });
      return;
    }
    log("error", "experiment route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  router.get("/", (_req, res) => {
    res.json({ experiments: listExperiments().map(experimentView) });
  });

  router.post("/", (req, res) => {
    try {
      res.json({ experiment: experimentView(declareExperiment(req.body, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  /** An ad-hoc reading. It is a measure order like any other, and unscheduled. */
  router.post("/ad-hoc", (req, res) => {
    try {
      res.json({ order: orderView(measureAdHoc(req.body, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  /** The safety net, exposed so nothing depends on one call site. */
  router.post("/sweep", (_req, res) => {
    res.json({ scheduled: scheduleOutstandingObservations("operator") });
  });

  function experimentOr404(req: Request, res: Response): Experiment | null {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid experiment id" });
      return null;
    }
    const experiment = getExperimentById(id);
    if (!experiment) {
      res.status(404).json({ error: `No experiment #${id}` });
      return null;
    }
    return experiment;
  }

  router.get("/:id", (req, res) => {
    const experiment = experimentOr404(req, res);
    if (!experiment) return;
    res.json({ experiment: experimentView(experiment) });
  });

  router.post("/:id/deliveries", (req, res) => {
    const experiment = experimentOr404(req, res);
    if (!experiment) return;
    try {
      const outcome = enrollDelivery(experiment.id, Number(req.body?.targetId), "operator");
      res.json({
        experiment: experimentView(outcome.experiment),
        scheduled: outcome.scheduled,
      });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/stop", (req, res) => {
    const experiment = experimentOr404(req, res);
    if (!experiment) return;
    try {
      res.json({ experiment: experimentView(stopExperiment(experiment.id, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  /**
   * Concluding is the decision record. There is no route that reaches
   * `concluded` without one, because the record is what holds the
   * experiment to the sample and stop condition it predeclared.
   */
  router.post("/:id/conclude", (req, res) => {
    const experiment = experimentOr404(req, res);
    if (!experiment) return;
    try {
      const outcome = concludeWithDecision(experiment.id, req.body, "operator");
      res.json({
        experiment: experimentView(outcome.experiment),
        decision: decisionView(outcome.record),
        sample: outcome.sample,
        evidenceAvailable: outcome.available,
      });
    } catch (err) {
      handle(res, err);
    }
  });

  /** What this experiment could honestly claim right now, before deciding. */
  router.get("/:id/evidence", (req, res) => {
    const experiment = experimentOr404(req, res);
    if (!experiment) return;
    res.json({
      sample: sampleState(experiment),
      available: highestRungAvailable(experiment),
      correlatedObservations: correlationsFor(experiment),
      decision: (() => {
        const record = getDecisionFor(experiment.id);
        return record ? decisionView(record) : null;
      })(),
    });
  });

  /** The per-project learning log, as the dashboard and the host both read it. */
  router.get("/log/:projectId", (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    res.json({ log: learningLogView(projectId) });
  });

  return router;
}
