# 02: Secrets store and audit trail

**What to build:** The custody boundary everything else leans on. Secrets (future service tokens, OAuth grants, social credentials) live libsodium-sealed in a dedicated table, master key held only in the host platform's secret manager. All other code receives opaque references. Gateway responses pass a lint for secret-shaped strings before leaving the process. An append-only audit table records security-relevant events.

**Blocked by:** 01 Walking skeleton.

**Status:** ready-for-agent

- [x] Storing, resolving, rotating, and revoking a secret works only through the one custody module
- [x] A response containing a secret-shaped string fails the lint check with a test proving it
- [x] Audit rows are append-only; updates and deletes are impossible at the schema level

## Comments

- 2026-08-31: Implemented by Devin. Added the libsodium custody module (`server/secrets.ts`, store/resolve/rotate/revoke behind opaque `secretref_` references, master key from `SECRETS_MASTER_KEY`), gateway response lint for secret-shaped strings (`server/response-lint.ts`, wired into `server/mcp.ts`), append-only `audit_log` via SQLite triggers, and 12 tests under `tests/` (`npm test`). PR: https://github.com/BautistaPessagno/Distribution/pull/2
