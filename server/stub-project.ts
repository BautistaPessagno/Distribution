// Dev stub Connected Project: a minimal, conformant project domain built on
// the shared SDK skeleton, so MarketingOS registration and conformance are
// testable before any real project domain exists.

import { createHash } from "node:crypto";
import type { Router } from "express";
import {
  createProjectDomainRouter,
  PROJECT_CONTRACT_VERSION,
  REQUIRED_RESOURCES,
  type ApplyRequest,
  type ApplyResult,
  type ChangesPage,
  type MetricsBundle,
  type ProjectManifest,
  type RequiredResource,
  type ResourceEnvelope,
} from "./project-domain-sdk";

const INITIAL_DATA: Record<RequiredResource, { state: "ok" | "empty"; data: unknown }> = {
  profile: {
    state: "ok",
    data: {
      product: "Dev Stub Product",
      mechanism: "A fixture project domain for local development",
      category: "developer-tools",
      lifecycleStage: "development",
    },
  },
  audiences: { state: "empty", data: [] },
  brand: {
    state: "ok",
    data: {
      voice: "plain and factual",
      colors: { primary: "#1a1a1a", accent: "#e8e4dc" },
    },
  },
  claims: { state: "empty", data: [] },
  assets: { state: "empty", data: [] },
  // Narrow on purpose, and non-empty on purpose: the stub exists so the
  // two-phase write loop can be walked locally, and a policy of "nothing"
  // would make that impossible to demonstrate. Brand voice is editable;
  // everything else this project holds is protected.
  "write-policy": {
    state: "ok",
    data: {
      operations: ["set_field"],
      editableTargets: ["brand"],
      protectedResources: ["profile", "claims", "assets", "audiences", "write-policy"],
    },
  },
};

export function createStubProjectRouter(verifyToken: (token: string) => boolean): Router {
  // Per-router state, so two stub projects in one process are two projects
  // rather than one shared mutable blob.
  const data = JSON.parse(JSON.stringify(INITIAL_DATA)) as typeof INITIAL_DATA;
  const versions: Record<RequiredResource, number> = {
    profile: 1,
    audiences: 1,
    brand: 1,
    claims: 1,
    assets: 1,
    "write-policy": 1,
  };
  // The stub's own revision, so a write here moves the change cursor the
  // way a real project domain's would.
  let cursor = 2;
  // Apply is idempotent on the digest, as the contract requires: the same
  // digest twice returns the first result rather than writing twice.
  const applied = new Map<string, ApplyResult>();
  // Bumped per funnel read, so two reads carry different provenance the
  // way two reads of a real project would.
  let funnelReads = 0;

  return createProjectDomainRouter({
    manifest(): ProjectManifest {
      return {
        name: "dev-stub-project",
        contractVersion: PROJECT_CONTRACT_VERSION,
        resources: [...REQUIRED_RESOURCES],
        // The stub publishes a product funnel, so the metrics capability
        // has something conformant to read in development.
        capabilities: ["metrics"],
      };
    },
    resource(name: RequiredResource): ResourceEnvelope {
      const entry = data[name];
      return { resource: name, state: entry.state, version: versions[name], data: entry.data };
    },
    metrics(): MetricsBundle {
      // Deterministic numbers with real provenance: what matters in the
      // stub is that a reading can be traced to the exact state it came
      // out of, not that the values mean anything.
      funnelReads += 1;
      return {
        snapshotId: `dev-stub-funnel-${funnelReads}`,
        version: cursor,
        observedAt: new Date().toISOString(),
        collectionMethod: "the dev stub's in-memory counters, read at request time",
        metrics: [
          { name: "signups", value: 40 + funnelReads, unit: "people" },
          { name: "activated", value: 12 + funnelReads, unit: "people" },
          { name: "trial_to_paid", value: 0.21, unit: "ratio" },
        ],
      };
    },
    changes(after: number): ChangesPage {
      const entries = [
        { cursor: 1, resource: "profile", kind: "created" as const },
        { cursor: 2, resource: "brand", kind: "created" as const },
        ...Array.from({ length: cursor - 2 }, (_, i) => ({
          cursor: 3 + i,
          resource: "brand",
          kind: "changed" as const,
        })),
      ].filter((e) => e.cursor > after);
      return { cursor, entries };
    },
    apply({ digest, operations }: ApplyRequest): ApplyResult {
      const already = applied.get(digest);
      if (already) return already;

      // Narrow on purpose, matching the stub's write policy: brand fields
      // and nothing else. A real project domain does the same thing against
      // whatever it actually stores.
      const brand = data.brand.data as Record<string, unknown>;
      for (const raw of operations) {
        const op = raw as { op?: string; resource?: string; path?: string; value?: unknown };
        if (op.op !== "set_field" || op.resource !== "brand" || !op.path) {
          throw {
            code: "protected_target",
            message: `the dev stub accepts set_field on brand, not ${String(op.op)}`,
            retryable: false,
            recovery: "Consult the project's write-policy resource for what it permits",
          };
        }
        brand[op.path] = op.value;
      }
      cursor += 1;
      versions.brand += 1;
      const result: ApplyResult = {
        applied: operations.length,
        resources: [{ name: "brand", version: versions.brand }],
        cursor,
      };
      applied.set(digest, result);
      return result;
    },
    verifyToken,
  });
}

// Token verification for the in-process stub: accept any active project
// service token minted by MarketingOS (matched by hash, never plaintext).
export function stubVerifyAgainstProjects(
  lookupTokenHash: (hash: string) => boolean
): (token: string) => boolean {
  return (token) => lookupTokenHash(createHash("sha256").update(token).digest("hex"));
}
