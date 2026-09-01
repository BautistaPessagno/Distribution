import express, { type Request, type Response, type Router } from "express";
import {
  AccountError,
  activateSlot,
  addInstance,
  createSlot,
  getInstanceById,
  getSlotById,
  instanceView,
  listInstances,
  listSlots,
  markInstanceLost,
  markReady,
  pauseSlot,
  recordReadiness,
  resumeSlot,
  slotView,
  READINESS_ITEMS,
  READINESS_LABELS,
} from "./accounts";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { log } from "./log";
import { PLATFORM_POLICIES } from "./platform-policy";
import { listProjects } from "./projects";

// Operator surface for Account Slots and Instances. Creating a platform
// identity is a person's act — MarketingOS never creates one and never
// performs a platform action — so every one of these is here and none is on
// the host surface.
export function accountRouter(): Router {
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
    if (err instanceof AccountError) {
      res.status(err.status).json({ error: err.message, detail: err.detail });
      return;
    }
    log("error", "account route error", {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    res.status(500).json({ error: "Internal error" });
  }

  function decorated(): (slot: ReturnType<typeof listSlots>[number]) => Record<string, unknown> {
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    return (slot) => ({
      ...slotView(slot),
      projectName: names.get(slot.projectId) ?? `project #${slot.projectId}`,
    });
  }

  /** What the platforms say and what MarketingOS chose, kept apart. */
  router.get("/policies", (_req, res) => {
    res.json({
      note: "Every shipped cap is a MarketingOS judgment call. Where a platform publishes a number it is recorded as an anchor with its source and the date it was read; a cap with no anchor has no published number behind it at all.",
      policies: PLATFORM_POLICIES,
      readinessChecklist: READINESS_ITEMS.map((item) => ({
        item,
        label: READINESS_LABELS[item],
      })),
    });
  });

  router.get("/", (_req, res) => {
    res.json({ slots: listSlots().map(decorated()) });
  });

  router.post("/", (req, res) => {
    try {
      res.json({ slot: slotView(createSlot(req.body, "operator")) });
    } catch (err) {
      handle(res, err);
    }
  });

  function slotOr404(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid slot id" });
      return null;
    }
    const slot = getSlotById(id);
    if (!slot) {
      res.status(404).json({ error: `No Account Slot #${id}` });
      return null;
    }
    return slot;
  }

  router.get("/:id", (req, res) => {
    const slot = slotOr404(req, res);
    if (!slot) return;
    res.json({
      slot: slotView(slot),
      // Archived instances stay attached: losing an account does not lose
      // what it did.
      instances: listInstances(slot.id).map(instanceView),
    });
  });

  router.post("/:id/instances", (req, res) => {
    const slot = slotOr404(req, res);
    if (!slot) return;
    try {
      const instance = addInstance({ ...req.body, slotId: slot.id }, "operator");
      res.json({ instance: instanceView(instance), slot: slotView(getSlotById(slot.id)!) });
    } catch (err) {
      handle(res, err);
    }
  });

  /**
   * The instance named in the body must be the one this slot holds. Without
   * the check the path would be a lie: evidence would land on another
   * slot's instance while the response reported this slot.
   */
  function instanceInSlotOr409(slotId: number, instanceId: unknown, res: Response): boolean {
    const instance = Number.isInteger(instanceId) ? getInstanceById(Number(instanceId)) : null;
    if (!instance || instance.slotId !== slotId) {
      res.status(409).json({
        error: `Account Instance #${String(instanceId)} does not belong to Account Slot #${slotId}`,
      });
      return false;
    }
    return true;
  }

  router.post("/:id/readiness", (req, res) => {
    const slot = slotOr404(req, res);
    if (!slot) return;
    if (!instanceInSlotOr409(slot.id, req.body?.instanceId, res)) return;
    try {
      const checklist = recordReadiness(req.body, "operator");
      res.json({ checklist, slot: slotView(getSlotById(slot.id)!) });
    } catch (err) {
      handle(res, err);
    }
  });

  const SLOT_MOVES = {
    ready: markReady,
    activate: activateSlot,
    pause: pauseSlot,
    resume: resumeSlot,
  } as const;

  for (const [path, move] of Object.entries(SLOT_MOVES)) {
    router.post(`/:id/${path}`, (req, res) => {
      const slot = slotOr404(req, res);
      if (!slot) return;
      try {
        const result = move(slot.id, "operator");
        const updated = "slot" in result ? result.slot : result;
        res.json({ slot: slotView(updated), ...("checklist" in result ? result : {}) });
      } catch (err) {
        handle(res, err);
      }
    });
  }

  router.post("/:id/lost", (req, res) => {
    const slot = slotOr404(req, res);
    if (!slot) return;
    if (!instanceInSlotOr409(slot.id, req.body?.instanceId, res)) return;
    try {
      const instanceId = Number(req.body?.instanceId);
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      const { instance, slot: updated } = markInstanceLost(instanceId, reason, "operator");
      res.json({
        instance: instanceView(instance),
        slot: slotView(updated),
        note: "The instance is archived read-only with its history. The slot survives and needs a replacement, which earns readiness from nothing.",
      });
    } catch (err) {
      handle(res, err);
    }
  });

  return router;
}
