# Choose the MVP technical architecture

Type: grilling
Status: resolved
Blocked by: 09, 10, 11, 12, 13, 14

## Question

Which application architecture, persistence model, job system, MCP client and server boundaries, renderer, authentication model, secrets boundary, observability, and test strategy best implement the decided MVP without coupling MarketingOS to any Connected Project or reference product?

## Answer

### Deployment

One small hosted service (Fly.io, Railway, or a small VPS) serving the dashboard and the MCP gateway under one domain with TLS. This gives ticket 18's OAuth flow a stable HTTPS endpoint reachable by hosted AI Hosts, and keeps operations to one deployable. Backups leave the box (see persistence). Vercel was considered and documented as the alternative shape: it is serverless, which rules out SQLite on local disk, long-lived job processes, and in-process Chromium rendering; choosing it would force managed Postgres, a separate render service, and cron-shaped jobs. The single-process host wins for a sole Operator.

### Application shape

One TypeScript monolith, one repo: Next.js dashboard, MCP gateway, and job runner in a single Node service. The PieceDoc editor and the server-side renderer share the same React components, so preview-equals-export (ticket 10's deterministic rendering) holds by construction. PNG export renders the shared components in headless Chromium (Playwright) inside the same service. A shared TypeScript SDK plus the ticket 08 conformance suite is published for the three Connected Project domains, so each project implements `project.*` against the same tested contract without coupling MarketingOS to any project's internals.

### Persistence

Single-file SQLite in WAL mode with continuous replication (Litestream to object storage). Append-only history tables for versions, receipts, proofs, attempts, and Metric Snapshots; PieceDocs and artifacts as versioned JSON. Job queue, caps, cursors, and idempotency keys live in the same database, transactional with the state they guard. Recovery is copy-one-file. Postgres is the documented migration path if collaborators arrive.

### Jobs and scheduling

An in-process job runner on the same SQLite queue: measure Work Order generation at experiment observation points, cap-window recomputation, snapshot freshness checks, approval expiry, and backup verification. No external queue service, per the dependency boundary.

### Secrets

Ticket 18's store gets its backend: secrets encrypted at rest with libsodium sealed boxes in a dedicated table, the master key held only in the host platform's secret manager, decryption confined to a single module that enforces the reference-only rule and response lint-checks. No secrets vendor.

### Observability and tests

Structured JSON logs with the ticket 08 error codes, request IDs on every gateway call, and an append-only audit trail for approvals, writes, and Work Order transitions. Tests: the conformance suite for project domains, contract tests for the 19-tool gateway catalog against the prototypes' reference state machines (`CreativePieceMachine`, `GatewaySim`), property tests for the versioning and approval invariants, and renderer snapshot tests pinning preview-equals-export.
