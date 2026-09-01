import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import { listProjects } from "./projects";
import { releaseGate } from "./release-gate";
import { completeMeasureOrder, snapshotView, SnapshotError } from "./snapshots";
import {
  approveOrder,
  beginReview,
  cancelOrder,
  claimOrder,
  completeOrder,
  createOrder,
  failOrder,
  getOrderById,
  listOrders,
  orderView,
  releaseOrder,
  requestChanges,
  retryOrder,
  startOrder,
  submitOrder,
  submitProof,
  WorkOrderError,
  type WorkOrder,
} from "./work-orders";

// The Operator surface for Work Orders. All of it is here and none of it is
// on the host surface: an AI host may read what work is outstanding, but
// claiming work, doing it, and reviewing the proof are a person's acts.
export function workOrderRouter(): Router {
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
    if (err instanceof WorkOrderError || err instanceof SnapshotError) {
      res.status(err.status).json({ error: err.message, detail: err.detail });
      return;
    }
    log("error", "work order route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  function decorated(): (order: WorkOrder) => Record<string, unknown> {
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    return (order) => ({
      ...orderView(order),
      projectName: names.get(order.projectId) ?? `project #${order.projectId}`,
    });
  }

  router.get("/", (req, res) => {
    const slotId = req.query.slotId === undefined ? undefined : Number(req.query.slotId);
    if (slotId !== undefined && !Number.isInteger(slotId)) {
      res.status(400).json({ error: "Invalid slotId" });
      return;
    }
    res.json({ orders: listOrders({ slotId }).map(decorated()) });
  });

  router.post("/", (req, res) => {
    try {
      res.json({ order: orderView(createOrder(req.body, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  function orderOr404(req: Request, res: Response): WorkOrder | null {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid Work Order id" });
      return null;
    }
    const order = getOrderById(id);
    if (!order) {
      res.status(404).json({ error: `No Work Order #${id}` });
      return null;
    }
    return order;
  }

  router.get("/:id", (req, res) => {
    const order = orderOr404(req, res);
    if (!order) return;
    res.json({ order: orderView(order) });
  });

  /** Why the queue is shut for this order, before anyone tries the move. */
  router.get("/:id/release", (req, res) => {
    const order = orderOr404(req, res);
    if (!order) return;
    res.json({ release: releaseGate(order) });
  });

  // The moves that need nothing but the actor.
  const PLAIN_MOVES = {
    submit: submitOrder,
    approve: approveOrder,
    claim: claimOrder,
    start: startOrder,
    release: releaseOrder,
    review: beginReview,
    retry: retryOrder,
  } as const;

  for (const [path, move] of Object.entries(PLAIN_MOVES)) {
    router.post(`/:id/${path}`, (req, res) => {
      const order = orderOr404(req, res);
      if (!order) return;
      try {
        res.json({ order: orderView(move(order.id, "operator")) });
      } catch (err) {
        handle(res, err);
      }
    });
  }

  router.post("/:id/proof", (req, res) => {
    const order = orderOr404(req, res);
    if (!order) return;
    try {
      const { order: moved } = submitProof(
        { orderId: order.id, proof: req.body?.proof },
        "operator"
      );
      res.json({ order: orderView(moved) });
    } catch (err) {
      handle(res, err);
    }
  });

  router.post("/:id/complete", (req, res) => {
    const order = orderOr404(req, res);
    if (!order) return;
    const note = typeof req.body?.note === "string" ? req.body.note : "";
    try {
      // Completing a measure order files its numbers in the same act, in
      // one transaction. A measure order that completed without them would
      // be a person having done the work and the system having lost it.
      if (order.kind === "measure") {
        const measured = completeMeasureOrder(order.id, req.body?.readings, note, "operator");
        res.json({
          order: orderView(measured.order),
          snapshots: measured.snapshots.map(snapshotView),
        });
        return;
      }
      const outcome = completeOrder(order.id, note, "operator");
      res.json({ order: orderView(outcome.order), readiness: outcome.readiness });
    } catch (err) {
      handle(res, err);
    }
  });

  // The moves that must say why.
  const REASONED_MOVES = {
    "request-changes": requestChanges,
    fail: failOrder,
    cancel: cancelOrder,
  } as const;

  for (const [path, move] of Object.entries(REASONED_MOVES)) {
    router.post(`/:id/${path}`, (req, res) => {
      const order = orderOr404(req, res);
      if (!order) return;
      const reason =
        typeof req.body?.note === "string"
          ? req.body.note
          : typeof req.body?.reason === "string"
            ? req.body.reason
            : "";
      try {
        res.json({ order: orderView(move(order.id, reason, "operator")) });
      } catch (err) {
        handle(res, err);
      }
    });
  }

  return router;
}
