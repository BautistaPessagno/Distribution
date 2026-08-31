import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { getRunPlan, listRunPlans } from "./methods";

// Operator inspection surface for persisted MarketingRunPlans: chained goals
// route here before any generation happens.
export function runPlanRouter(): Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/", (_req, res) => {
    res.json({ runPlans: listRunPlans() });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid run plan id" });
      return;
    }
    const runPlan = getRunPlan(id);
    if (!runPlan) {
      res.status(404).json({ error: `No run plan #${id}` });
      return;
    }
    res.json({ runPlan });
  });

  return router;
}
