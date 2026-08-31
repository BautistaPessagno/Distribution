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
  type ProjectManifest,
  type RequiredResource,
  type ResourceEnvelope,
} from "./project-domain-sdk";

// The stub's own revision, so a write here moves the change cursor the way
// a real project domain's would.
let stubCursor = 2;

const STUB_DATA: Record<RequiredResource, { state: "ok" | "empty"; data: unknown }> = {
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

const STUB_VERSIONS: Record<RequiredResource, number> = {
  profile: 1,
  audiences: 1,
  brand: 1,
  claims: 1,
  assets: 1,
  "write-policy": 1,
};

export function createStubProjectRouter(verifyToken: (token: string) => boolean): Router {
  return createProjectDomainRouter({
    manifest(): ProjectManifest {
      return {
        name: "dev-stub-project",
        contractVersion: PROJECT_CONTRACT_VERSION,
        resources: [...REQUIRED_RESOURCES],
        capabilities: [],
      };
    },
    resource(name: RequiredResource): ResourceEnvelope {
      const entry = STUB_DATA[name];
      return { resource: name, state: entry.state, version: STUB_VERSIONS[name], data: entry.data };
    },
    changes(after: number): ChangesPage {
      const entries = [
        { cursor: 1, resource: "profile", kind: "created" as const },
        { cursor: 2, resource: "brand", kind: "created" as const },
        ...Array.from({ length: stubCursor - 2 }, (_, i) => ({
          cursor: 3 + i,
          resource: "brand",
          kind: "changed" as const,
        })),
      ].filter((e) => e.cursor > after);
      return { cursor: stubCursor, entries };
    },
    apply({ operations }: ApplyRequest): ApplyResult {
      // Narrow on purpose, matching the stub's write policy: brand fields
      // and nothing else. A real project domain does the same thing against
      // whatever it actually stores.
      const brand = STUB_DATA.brand.data as Record<string, unknown>;
      for (const raw of operations) {
        const op = raw as { op?: string; resource?: string; path?: string; value?: unknown };
        if (op.op !== "set_field" || op.resource !== "brand" || !op.path) {
          throw new Error(`the dev stub accepts set_field on brand, not ${String(op.op)}`);
        }
        brand[op.path] = op.value;
      }
      stubCursor += 1;
      STUB_VERSIONS.brand += 1;
      return {
        applied: operations.length,
        resources: [{ name: "brand", version: STUB_VERSIONS.brand }],
        cursor: stubCursor,
      };
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
