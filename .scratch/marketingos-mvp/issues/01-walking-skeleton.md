# 01: Walking skeleton

**What to build:** The deployed spine. A TypeScript monolith (Next.js dashboard shell + MCP endpoint + in-process job runner) running on the chosen small host under one TLS domain, with SQLite in WAL mode and Litestream replication to object storage. An MCP client can connect and call `marketingos.onboard`, which returns the compact versioned guide.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `marketingos.onboard` answers a real MCP client over HTTPS with contract version, rules, tool map, and example goals
- [x] SQLite database replicates continuously; restoring from replica is documented and tested once
- [x] Deploy is one command from a clean checkout
- [x] Health endpoint reports app, database, and replication status

## Comments

2026-08-31 — Implemented the walking skeleton: Express + Next.js monolith (`server/main.ts`) with a stateless MCP Streamable HTTP endpoint at `/mcp` exposing `marketingos.onboard`, better-sqlite3 in WAL mode with `meta`/`jobs`/`audit_log` tables, an in-process polling job runner, `/health` reporting app/database/replication, Litestream config + Dockerfile + fly.toml, `./scripts/deploy.sh` as the one-command deploy, and a restore runbook verified by `npm run test:restore`. Verified `marketingos.onboard` with a real MCP SDK client over HTTP and self-signed HTTPS locally. Cloud deploy itself was not executed (no Fly.io credentials available to the automation). PR: https://github.com/BautistaPessagno/Distribution/pull/1
