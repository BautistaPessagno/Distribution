# MarketingOS

A personal, multi-project marketing workspace: one TypeScript monolith
(Next.js dashboard + MCP gateway + in-process job runner) over SQLite with
Litestream replication. See `CONTEXT.md` for the domain glossary and
`docs/issues/marketing-os/spec.md` for the MVP specification.

## Development

```sh
npm install
npm run dev        # dashboard on http://localhost:3000, MCP on /mcp, health on /health
```

Verify:

```sh
npm run typecheck
npm run lint
npm run build
npm run test:mcp      # real MCP client against a running server (MCP_URL to override)
npm run test:restore  # Litestream backup/restore cycle (requires litestream + sqlite3)
```

## Endpoints

- `POST /mcp` — MCP gateway (Streamable HTTP, stateless). Tool: `marketingos.onboard`.
- `GET /health` — JSON report of app, database (WAL mode), and replication status.
- `/` — dashboard shell.

## Deploy

One command from a clean checkout (requires an authenticated `flyctl` and the
Litestream secrets set once — see `scripts/deploy.sh`):

```sh
./scripts/deploy.sh
```

The Fly app serves everything under one TLS domain, mounts a volume at
`/data`, and runs the app under `litestream replicate` (see `scripts/start.sh`
and `litestream.yml`). Database restore is documented in
`docs/runbooks/restore.md`.
