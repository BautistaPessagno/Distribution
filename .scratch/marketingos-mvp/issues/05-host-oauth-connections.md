# 05: AI Host OAuth connections

**What to build:** Hosts connect for real. The gateway implements the MCP authorization spec (OAuth 2.1) so ChatGPT/Claude connect through native connector flows, grants scoped to the workspace. A manually-issued scoped static token exists as fallback. The dashboard lists connections and revokes any host individually.

**Blocked by:** 02 Secrets store and audit trail, 03 Operator passkey login.

**Status:** in-progress

- [ ] A real hosted AI Host completes the OAuth flow and calls `onboard` authenticated
- [ ] Grants and static tokens are stored via the custody module and revocable from one dashboard page
- [ ] A revoked host's next call fails with a structured error
