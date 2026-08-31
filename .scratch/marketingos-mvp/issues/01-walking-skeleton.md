# 01: Walking skeleton

**What to build:** The deployed spine. A TypeScript monolith (Next.js dashboard shell + MCP endpoint + in-process job runner) running on the chosen small host under one TLS domain, with SQLite in WAL mode and Litestream replication to object storage. An MCP client can connect and call `marketingos.onboard`, which returns the compact versioned guide.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `marketingos.onboard` answers a real MCP client over HTTPS with contract version, rules, tool map, and example goals
- [ ] SQLite database replicates continuously; restoring from replica is documented and tested once
- [ ] Deploy is one command from a clean checkout
- [ ] Health endpoint reports app, database, and replication status
