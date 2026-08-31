// Shared project-domain SDK skeleton (contract v0).
//
// A Connected Project exposes the `project.*` read surface over HTTP. This
// module defines the wire contract — resource names, error codes, response
// envelopes — and builds an Express router from a ProjectDomainImpl, so every
// project domain (including the dev stub) serves the exact shape the
// conformance suite verifies.

import express, { type Request, type Response, type Router } from "express";

export const PROJECT_CONTRACT_VERSION = "0";

export const REQUIRED_RESOURCES = [
  "profile",
  "audiences",
  "brand",
  "claims",
  "assets",
  "write-policy",
] as const;

export type RequiredResource = (typeof REQUIRED_RESOURCES)[number];

// Structured error codes from the Connected Project MCP contract, plus
// `invalid_token` for the bearer-auth boundary.
export type ProjectErrorCode =
  | "unsupported_capability"
  | "invalid_schema"
  | "stale_snapshot"
  | "version_conflict"
  | "approval_required"
  | "approval_mismatch"
  | "validation_failed"
  | "protected_target"
  | "rights_missing"
  | "temporarily_unavailable"
  | "invalid_token";

export interface ProjectError {
  code: ProjectErrorCode;
  message: string;
  retryable: boolean;
  recovery: string;
}

// A required resource is always implemented but may be validly empty.
// `empty` is distinct from `unsupported`.
export type ResourceState = "ok" | "empty";

export interface ResourceEnvelope {
  resource: string;
  state: ResourceState;
  version: number;
  data: unknown;
}

export interface ProjectManifest {
  name: string;
  contractVersion: string;
  resources: string[];
  capabilities: string[];
}

export interface ChangesPage {
  cursor: number;
  entries: { cursor: number; resource: string; kind: "created" | "changed" | "removed" }[];
}

/**
 * The write side of the contract. MarketingOS has already validated the
 * change against the project's own write policy and a person has approved
 * the exact diff; this applies it atomically or does not apply it at all.
 *
 * The result is what a Write Receipt is made of: how many operations went
 * in, the resulting version of every resource that moved, and the change
 * cursor afterwards.
 */
export interface ApplyRequest {
  digest: string;
  operations: unknown[];
}

export interface ApplyResult {
  applied: number;
  resources: { name: string; version: number }[];
  cursor: number;
}

export interface ProjectDomainImpl {
  manifest(): ProjectManifest;
  resource(name: RequiredResource): ResourceEnvelope;
  changes(after: number): ChangesPage;
  verifyToken(token: string): boolean;
  /**
   * Optional. A project domain that does not implement this accepts no
   * writes at all, which is the same thing its write policy should say.
   */
  apply?(request: ApplyRequest): ApplyResult;
}

function sendError(res: Response, status: number, error: ProjectError): void {
  res.status(status).json({ error });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export function createProjectDomainRouter(impl: ProjectDomainImpl): Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next) => {
    const token = bearerToken(req);
    if (!token || !impl.verifyToken(token)) {
      sendError(res, 401, {
        code: "invalid_token",
        message: "A valid project service token is required",
        retryable: false,
        recovery: "Rotate or re-issue the project service token in MarketingOS",
      });
      return;
    }
    next();
  });

  router.get("/manifest", (_req, res) => {
    res.json(impl.manifest());
  });

  router.get("/changes", (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) {
      sendError(res, 400, {
        code: "invalid_schema",
        message: "The `after` cursor must be a non-negative integer",
        retryable: false,
        recovery: "Request a fresh snapshot and use its change cursor",
      });
      return;
    }
    res.json(impl.changes(after));
  });

  router.get("/resources/:name", (req, res) => {
    const name = req.params.name;
    if (!(REQUIRED_RESOURCES as readonly string[]).includes(name)) {
      sendError(res, 404, {
        code: "unsupported_capability",
        message: `Resource '${name}' is not supported by this project domain`,
        retryable: false,
        recovery: "Consult the manifest for the supported resource list",
      });
      return;
    }
    res.json(impl.resource(name as RequiredResource));
  });

  router.post("/apply", express.json({ limit: "4mb" }), (req, res) => {
    if (!impl.apply) {
      sendError(res, 404, {
        code: "unsupported_capability",
        message: "This project domain does not accept writes",
        retryable: false,
        recovery: "Consult the project's write-policy resource for what it permits",
      });
      return;
    }
    const digest = typeof req.body?.digest === "string" ? req.body.digest : "";
    const operations = Array.isArray(req.body?.operations) ? req.body.operations : null;
    if (!digest || !operations) {
      sendError(res, 400, {
        code: "invalid_schema",
        message: "An apply names the approved digest and the operations to apply",
        retryable: false,
        recovery: "Send {digest, operations} as prepared and approved",
      });
      return;
    }
    try {
      res.json(impl.apply({ digest, operations }));
    } catch (err) {
      sendError(res, 422, {
        code: "validation_failed",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
        recovery: "Recompute the change against a fresh snapshot and prepare it again",
      });
    }
  });

  router.use((_req, res) => {
    sendError(res, 404, {
      code: "unsupported_capability",
      message: "Unknown project-domain path",
      retryable: false,
      recovery: "Use /manifest, /changes, /resources/:name, or /apply",
    });
  });

  return router;
}
