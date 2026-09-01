import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import {
  acknowledgeCancellation,
  acknowledgeDisclosure,
  cancelDelivery,
  createTarget,
  DeliveryError,
  failDelivery,
  getReleaseById,
  getTargetById,
  listReleases,
  listTargets,
  markPosting,
  releasePiece,
  releaseToOperator,
  releaseView,
  submitDeliveryProof,
  targetView,
  verifyPosted,
  type DeliveryTarget,
} from "./deliveries";
import { log } from "./log";
import { orderView } from "./work-orders";

// The Operator surface for Content Releases and Delivery Targets. Every one
// of these is a person's act: MarketingOS publishes nothing and only records
// what a person did, against a permalink they can open.
export function deliveryRouter(): Router {
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
    if (err instanceof DeliveryError) {
      res.status(err.status).json({ error: err.message, detail: err.detail });
      return;
    }
    log("error", "delivery route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  router.get("/releases", (_req, res) => {
    res.json({ releases: listReleases().map(releaseView) });
  });

  router.post("/releases", (req, res) => {
    try {
      const release = releasePiece(Number(req.body?.pieceId), "operator");
      res.json({ release: releaseView(release) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.get("/releases/:id", (req, res) => {
    const release = getReleaseById(Number(req.params.id));
    if (!release) {
      res.status(404).json({ error: `No Content Release #${req.params.id}` });
      return;
    }
    res.json({
      release: releaseView(release),
      targets: listTargets({ releaseId: release.id }).map(targetView),
    });
  });

  router.get("/", (req, res) => {
    const slotId = req.query.slotId === undefined ? undefined : Number(req.query.slotId);
    if (slotId !== undefined && !Number.isInteger(slotId)) {
      res.status(400).json({ error: "Invalid slotId" });
      return;
    }
    res.json({ targets: listTargets({ slotId }).map(targetView) });
  });

  /**
   * Idempotent by the caller's key. A repeat is not an error and is not a
   * second delivery: it is the same delivery, answered again, and the
   * status code says which of the two happened.
   */
  router.post("/", (req, res) => {
    try {
      const { target, created } = createTarget(req.body, "operator");
      res.status(created ? 201 : 200).json({ target: targetView(target), created });
    } catch (err) {
      handle(res, err);
    }
  });

  function targetOr404(req: Request, res: Response): DeliveryTarget | null {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid Delivery Target id" });
      return null;
    }
    const target = getTargetById(id);
    if (!target) {
      res.status(404).json({ error: `No Delivery Target #${id}` });
      return null;
    }
    return target;
  }

  router.get("/:id", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    res.json({ target: targetView(target) });
  });

  router.post("/:id/disclosures", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      const rule = typeof req.body?.rule === "string" ? req.body.rule : "";
      const disclosures = acknowledgeDisclosure(target.id, rule, "operator");
      res.json({ disclosures, target: targetView(getTargetById(target.id)!) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/release", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      const outcome = releaseToOperator(target.id, "operator");
      res.json({ target: targetView(outcome.target), order: orderView(outcome.order) });
    } catch (err) {
      handle(res, err);
    }
  });

  const PLAIN_MOVES = { posting: markPosting, verify: verifyPosted } as const;
  for (const [path, move] of Object.entries(PLAIN_MOVES)) {
    router.post(`/:id/${path}`, (req, res) => {
      const target = targetOr404(req, res);
      if (!target) return;
      try {
        res.json({ target: targetView(move(target.id, "operator")) });
      } catch (err) {
        handle(res, err);
      }
    });
  }

  router.post("/:id/proof", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      const permalink = typeof req.body?.permalink === "string" ? req.body.permalink : "";
      res.json({ target: targetView(submitDeliveryProof(target.id, permalink, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/fail", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      res.json({ target: targetView(failDelivery(target.id, reason, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/cancel", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      const outcome = cancelDelivery(target.id, reason, "operator");
      res.json({
        target: targetView(outcome.target),
        cancelled: outcome.cancelled,
        message: outcome.message,
      });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/acknowledge-cancellation", (req, res) => {
    const target = targetOr404(req, res);
    if (!target) return;
    try {
      res.json({ target: targetView(acknowledgeCancellation(target.id, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  return router;
}
