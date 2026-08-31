# 06: Connected Project registration

**What to build:** Registering a Connected Project from the dashboard: mints a dedicated scoped service token via the custody module, runs the conformance suite v0 against the project domain, and marks the project healthy only on pass. Ships the shared project-domain SDK skeleton and a dev stub project that passes conformance, so MarketingOS is testable before any real project domain exists.

**Blocked by:** 02 Secrets store and audit trail, 05 AI Host OAuth connections.

**Status:** ready-for-agent

- [ ] Registering the stub project mints its token, runs conformance, and shows the result
- [ ] A failing conformance run leaves the project visibly unhealthy and unusable
- [ ] Token rotation works without re-registration
