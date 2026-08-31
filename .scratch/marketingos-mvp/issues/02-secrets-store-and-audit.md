# 02: Secrets store and audit trail

**What to build:** The custody boundary everything else leans on. Secrets (future service tokens, OAuth grants, social credentials) live libsodium-sealed in a dedicated table, master key held only in the host platform's secret manager. All other code receives opaque references. Gateway responses pass a lint for secret-shaped strings before leaving the process. An append-only audit table records security-relevant events.

**Blocked by:** 01 Walking skeleton.

**Status:** ready-for-agent

- [ ] Storing, resolving, rotating, and revoking a secret works only through the one custody module
- [ ] A response containing a secret-shaped string fails the lint check with a test proving it
- [ ] Audit rows are append-only; updates and deletes are impossible at the schema level
