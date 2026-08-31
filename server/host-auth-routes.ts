import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import {
  HostAuthError,
  listHostConnections,
  mintStaticHostToken,
  revokeHostConnection,
} from "./host-auth";
import { log } from "./log";

function handleError(res: Response, err: unknown): void {
  if (err instanceof HostAuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  log("error", "host connection route error", {
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  res.status(500).json({ error: "Internal error" });
}

export function hostAuthRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/connections", (_req, res) => {
    try {
      res.json({ connections: listHostConnections() });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/tokens", async (req, res) => {
    try {
      const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
      if (!label) {
        res.status(400).json({ error: "A label for the token is required" });
        return;
      }
      const { token, connection } = await mintStaticHostToken(label, "operator");
      res.json({ token, connection });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/connections/:id/revoke", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid connection id" });
        return;
      }
      const connection = await revokeHostConnection(id, "operator");
      res.json({ connection });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
