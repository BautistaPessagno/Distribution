# 06: Connected Project registration

**What to build:** Registering a Connected Project from the dashboard: mints a dedicated scoped service token via the custody module, runs the conformance suite v0 against the project domain, and marks the project healthy only on pass. Ships the shared project-domain SDK skeleton and a dev stub project that passes conformance, so MarketingOS is testable before any real project domain exists.

**Blocked by:** 02 Secrets store and audit trail, 05 AI Host OAuth connections.

**Status:** done

- [x] Registering the stub project mints its token, runs conformance, and shows the result
- [x] A failing conformance run leaves the project visibly unhealthy and unusable
- [x] Token rotation works without re-registration

## Comments

- 2026-08-31: Implemented Connected Project registration: `/api/projects` mints a scoped `mosproj_` service token via the custody module, runs conformance suite v0 (`server/conformance.ts`) against the project domain, and marks the project healthy only on pass; unhealthy projects are unusable (`requireHealthyProject`). Shipped the shared project-domain SDK skeleton (`server/project-domain-sdk.ts`) and a dev stub project mounted at `/stub-project` that passes conformance. Token rotation re-mints in place without re-registration. PR: https://github.com/BautistaPessagno/Distribution/pull/6
