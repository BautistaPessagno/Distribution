import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import {
  answerHabitCheck,
  habitCheckDue,
  habitCheckView,
  HabitCheckError,
  outstandingHabitCheck,
  scheduleHabitCheck,
} from "./habit-check";
import { log } from "./log";

// The habit check's surface. Small on purpose: schedule it, see whether it
// is due, answer it once.
export function habitRouter(): Router {
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
    if (err instanceof HabitCheckError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    log("error", "habit check route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  router.get("/:projectId", (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const outstanding = outstandingHabitCheck(projectId);
    res.json({
      check: outstanding ? habitCheckView(outstanding) : null,
      due: habitCheckDue(projectId) !== null,
    });
  });

  router.post("/:projectId", (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    res.json({ check: habitCheckView(scheduleHabitCheck(projectId, new Date(), "operator")) });
  });

  router.post("/:projectId/answer", (req, res) => {
    try {
      const id = Number(req.body?.id);
      const answer = typeof req.body?.answer === "string" ? req.body.answer : "";
      res.json({ check: habitCheckView(answerHabitCheck(id, answer, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  return router;
}
