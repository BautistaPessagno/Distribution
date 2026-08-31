# 05: AI Host OAuth connections

**What to build:** Hosts connect for real. The gateway implements the MCP authorization spec (OAuth 2.1) so ChatGPT/Claude connect through native connector flows, grants scoped to the workspace. A manually-issued scoped static token exists as fallback. The dashboard lists connections and revokes any host individually.

**Blocked by:** 02 Secrets store and audit trail, 03 Operator passkey login.

**Status:** done

- [x] A real hosted AI Host completes the OAuth flow and calls `onboard` authenticated
- [x] Grants and static tokens are stored via the custody module and revocable from one dashboard page
- [x] A revoked host's next call fails with a structured error

## Comments

- Implemented the MCP authorization spec (OAuth 2.1) on the gateway: metadata discovery, dynamic client registration, PKCE authorize/token/refresh/revoke, with an authenticated Operator passkey session acting as consent. `POST /mcp` now requires a bearer token; revoked or unknown tokens fail with a structured `invalid_token` OAuth error. Grants and manually-minted static fallback tokens are sealed in the custody module (opaque `secretref_` references, hash-based lookup) and are listed/revocable individually from the new Host Connections dashboard page. PR: https://github.com/BautistaPessagno/Distribution/pull/5
