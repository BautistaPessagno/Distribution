import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { dailyRail } from "./daily-rail";
import { knownGoals } from "./methods";

// The daily rail's surface. Read-only: the rail composes what is due and
// hands over one thing; doing the thing happens on the surface that owns
// it, which is why every step carries where that is.
export function railRouter(): Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/", (req, res) => {
    const goal = typeof req.query.goal === "string" ? req.query.goal : "positioning";
    if (!knownGoals().includes(goal)) {
      res.status(400).json({
        error: `"${goal}" is not a goal the Method Library has.`,
        detail: knownGoals(),
      });
      return;
    }
    res.json({ rail: dailyRail(goal), goals: knownGoals() });
  });

  return router;
}
