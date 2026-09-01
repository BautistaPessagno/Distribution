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

/**
 * Optional capabilities a project domain may declare in its manifest. A
 * project that does not declare `metrics` has no product funnel to read,
 * which is a fact about the project rather than a fault in it.
 */
export const OPTIONAL_CAPABILITIES = ["metrics"] as const;
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];

/**
 * A product-funnel read. The numbers matter less than where they came
 * from: `snapshotId` and `version` are the project's own name for the state
 * these were read out of, so a snapshot recorded here can always be traced
 * back to the exact project state that produced it.
 */
export interface MetricsBundle {
  snapshotId: string;
  version: number;
  /** When the project observed these, in its own reckoning. */
  observedAt: string;
  /** How the project got them, said in its own words. */
  collectionMethod: string;
  metrics: { name: string; value: number; unit?: string }[];
}

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
 *
 * **Apply must be idempotent on the digest.** MarketingOS consumes an
 * approval before calling this, and a network failure afterwards is
 * indistinguishable from one before it — so a project domain that sees the
 * same digest twice must return the first result rather than applying the
 * operations again.
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
  apply?(request: ApplyRequest): ApplyResult | Promise<ApplyResult>;

  /**
   * Optional. The product funnel, if this project has one. A domain that
   * does not implement this must not declare the `metrics` capability, and
   * a domain that declares it must implement it — the conformance suite
   * checks both directions.
   */
  metrics?(): MetricsBundle | Promise<MetricsBundle>;
}

function sendError(res: Response, status: number, error: ProjectError): void {
  res.status(status).json({ error });
}

/** A refusal the project domain means, as opposed to something that broke. */
export function isProjectError(err: unknown): err is ProjectError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<ProjectError>;
  return typeof e.code === "string" && typeof e.message === "string";
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

  router.get("/capabilities/metrics", async (_req, res) => {
    if (!impl.metrics) {
      sendError(res, 404, {
        code: "unsupported_capability",
        message: "This project domain publishes no product funnel",
        retryable: false,
        recovery: "Consult the manifest for the capabilities this project declares",
      });
      return;
    }
    try {
      res.json(await impl.metrics());
    } catch (err) {
      if (isProjectError(err)) {
        sendError(res, err.retryable ? 503 : 400, err);
        return;
      }
      sendError(res, 503, {
        code: "temporarily_unavailable",
        message: "The product funnel could not be read just now",
        retryable: true,
        recovery: "Retry the read, or record the observation by hand instead",
      });
    }
  });

  // A change set is control JSON, not payload: the operations name fields
  // and values, and an asset arrives through its own surface.
  const applyBody = express.json({ limit: "256kb" });

  router.post("/apply", (req, res, next) => {
    applyBody(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      // Even a body that never parsed answers in this contract's shape.
      sendError(res, 413, {
        code: "invalid_schema",
        message: "The change set is larger than this endpoint accepts",
        retryable: false,
        recovery: "Split the change into smaller Project Change Sets",
      });
    });
  });

  router.post("/apply", async (req, res) => {
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
      res.json(await impl.apply({ digest, operations }));
    } catch (err) {
      // A refusal the project means is a ProjectError it threw; anything
      // else is a fault, and a fault is retryable where a refusal is not.
      if (isProjectError(err)) {
        sendError(res, 422, err);
        return;
      }
      sendError(res, 500, {
        code: "temporarily_unavailable",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        recovery: "Retry, then check the project's state before preparing the change again",
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
