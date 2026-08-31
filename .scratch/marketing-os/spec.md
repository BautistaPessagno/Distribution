# MarketingOS MVP specification

Status: implementation-ready
Compiled: 2026-08-31, from the 18 resolved decision tickets of the [wayfinder map](map.md). Each section gists its decisions and links the ticket that holds the full detail. Nothing here requires a prerequisite decision.

## 1. Product summary

MarketingOS is a personal, multi-project marketing workspace its owner dogfoods across KeepAnalog, partnr, and VinylOS. One MCP gateway gives the owner's existing AI Host evidence-backed marketing reasoning over versioned Connected Project context; a deterministic creative workspace turns briefs into approved, exported Creative Pieces; human account operations distribute them; a measurement loop turns results into recorded learning. The AI Host is the only provider of AI compute. The product surface is a guided, minimalist, one-step-at-a-time dashboard. See the glossary in [CONTEXT.md](../../CONTEXT.md) for canonical vocabulary.

## 2. Architecture

One TypeScript monolith (Next.js dashboard + MCP gateway + in-process job runner) deployed as one small hosted service (Fly.io, Railway, or a small VPS) under one TLS domain. SQLite in WAL mode with Litestream replication; append-only history tables; PieceDocs and artifacts as versioned JSON. PieceDoc editor and server renderer share React components; PNG export renders them in headless Chromium, so preview equals export by construction. A shared TypeScript SDK plus conformance suite is published for Connected Project domains. Secrets are libsodium-sealed rows in a dedicated table, master key in the host platform's secret manager. Structured JSON logs, request IDs, append-only audit trail. Vercel + Neon + render worker is the documented alternative shape, rejected for the MVP. [Ticket 15](issues/15-choose-mvp-technical-architecture.md)

## 3. Actors and authentication

The owner is the sole initial Operator; Operator Assignments keep room for invited collaborators without redesign. [Ticket 05](issues/05-choose-first-operator-model.md)

- AI Hosts connect through the MCP authorization spec (OAuth 2.1), workspace-scoped, revocable per host; static scoped token as fallback.
- The Operator signs in with a passkey (single account, recovery code).
- Each Connected Project registration mints a scoped, rotatable per-project service token; the ticket 08 conformance suite runs at registration.
- One encrypted secrets store; everything else holds opaque references. No secret ever appears in MCP responses, method text, Work Orders, proofs, logs, or AI Host context; gateway responses are lint-checked for secret-shaped strings. [Ticket 18](issues/18-define-auth-and-secrets.md)

## 4. MCP gateway contract

One connection exposes two domains: `marketingos.*` (methods, pieces, workflow, approvals, Work Orders, outcomes) and `project.*` (the selected Connected Project's versioned, provenance-aware, approval-gated context). Project Snapshots pin every session; Project Change Sets use the two-phase prepare/approve/apply protocol with Write Receipts; Context Gaps are explicit states; required resources, capability bundles, error codes, and the conformance suite are defined in [ticket 08](issues/08-define-connected-project-mcp-contract.md).

Host onboarding: in-session `select_project` with every response echoing `{project, snapshot, contract}`; guiding errors enforce the session ritual; `onboard` returns a compact versioned guide; `get_method(goal)` routes progressively; the v1 catalog is 19 tools; approvals are digest-keyed and never transit the host; images return through `register_asset` (inline base64 up to 2 MB with origin, prompt, lineage, rights) with manual dashboard upload as fallback and a `prompt_prepared` state until an asset lands. Reference behavior: the [session simulator](prototypes/ai-host-onboarding.html) and its `GatewaySim` module. [Ticket 09](issues/09-define-ai-host-onboarding-contract.md)

## 5. Reasoning capabilities

Six native capabilities with typed, lineage-carrying artifacts: positioning (PositioningHypothesis), website/funnel audit (AuditRun: Scorecard + Findings), copy (ArtifactVariants), hooks (HookMatrix), social content (channel-native posts feeding Creative Pieces), analytics/experiments (Experiment + EvidenceAssessment). Single-method jobs run direct; chains of 2+ modules produce a reviewable MarketingRunPlan. Honesty rules are blocking invariants: approved-claims-only citation, `[NEED]` tokens block approval, heuristic scores self-label, no winner without predeclared sample and stop condition. Deferred: email, launch, competitive, app-store, GEO, native SEO. Methods live in the versioned `marketingos.*` Method Library, reimplemented natively from the Marketing AGI reference. [Ticket 11](issues/11-define-reasoning-module-frontier.md), [ticket 03](issues/03-adopt-marketing-agi-reasoning.md)

## 6. Creative workspace

Creative Pieces follow `backlog -> drafting -> review -> approved -> planned -> exported -> measured` with a changes-requested loop; reopen clears approval and planned date. PieceDoc: 1-20 slides, text/image/shape/logo layers, four formats, per-network captions (Instagram, X, LinkedIn, TikTok). Atomic typed edit batches (max 20 ops, baseVersion, version_conflict on stale writes); history append-only; restore creates a new version; approved pieces reject edits until reopened. Brand tokens repaint backlog/drafting live; approved work pins its kit version, goes brand-outdated on kit change, and blocks export until re-approval. check_brand errors gate approval; check_quality findings advise. Templates strip campaign content; export renders a PNG-per-slide bundle plus captions file, recorded with doc and kit versions. Reference behavior: the [workflow prototype](prototypes/creative-piece-workflow.html) and its `CreativePieceMachine` module. [Ticket 10](issues/10-define-creative-piece-workflow.md), [ticket 04](issues/04-adopt-agentcy-creative-workspace.md)

## 7. Account operations

Durable Account Slots (platform, identity spec, niche, disclosure rules, risk policy, caps, windows) hold replaceable Account Instances (credentials by reference only). Readiness is a six-item explicit checklist, never elapsed time. Work Orders are typed (provision, warmup, post, comment, measure, replace) and keep the full proof-and-review cycle even solo. Content Releases are immutable; Delivery Targets carry idempotency keys and their own state path; cancellation after release-to-operator is a request. Daily caps block with next-window messaging; each slot has a kill switch. Lost instances archive read-only with a reason; the slot spawns a replacement that re-earns readiness. Platform-policy constraints and the labeled-judgment-call rule for non-X caps come from the dated first-party research. [Ticket 12](issues/12-define-account-operations-workflow.md), [ticket 02](issues/02-model-humanpost-account-operations.md), [ticket 19](issues/19-research-platform-policies-for-warmup.md)

## 8. Measurement and learning

Two observation sources: hand-entered Metric Snapshots per Delivery Target and product-funnel reads from each project's metrics capability. Experiments predeclare observation points that auto-generate measure Work Orders; ad-hoc snapshots are marked unscheduled. Experiments conclude only at their stop condition with a typed decision record (repeat, change, stop) appended to a per-project learning log the AI Host reads. Every conclusion carries its evidence-ladder rung; correlations may justify tests, never proof. [Ticket 13](issues/13-define-measurement-learning-loop.md)

## 9. Dashboard

A guided single-step rail: only the current step on screen, one headline, one artifact, one primary action; each step hands over exactly one copyable AI Host prompt or one plain Operator instruction. First-run onboarding is pure setup (connect project, connect host, create first slot) and never writes to a Connected Project. Digest approvals are explicit interruptions outside the rail. Studio, Calendar, Operations, Learning, and Project Connection are destinations off the rail; a planned date never implies publishing. Visual language: the minimalist-ui protocol (warm monochrome, hairlines, serif step headline, pastel status tags, off-black actions, reduced-motion fallback). Reference: [dashboard-guided.html](prototypes/dashboard-guided.html). [Ticket 14](issues/14-prototype-dashboard-information-architecture.md), [ticket 07](issues/07-choose-dashboard-first-use-loop.md)

## 10. Scope boundary

The core requires only the MarketingOS gateway, an AI Host, and a project-domain implementation per Connected Project. No model APIs, creative vendors, stock services, video services, or automation platforms. Static image work uses AI Host capabilities with recorded handoffs. Out of scope for the MVP: runtime integrations with any reference product, direct publishing, platform analytics ingestion, ad execution, autonomous external actions, video, marketplaces, and warm-up guarantees; SEO/search-console/answer-engine ingestion is post-MVP (no MVP capability produces those observations). [Ticket 06](issues/06-set-mvp-dependency-boundary.md), [map out-of-scope](map.md)

## 11. Licensing and attribution

Method Library content is reimplemented natively. Any substantially copied Marketing AGI text or rubric retains that project's MIT attribution; the reimplementation-first rule makes this the exception path. Reference products are never runtime dependencies.

## 12. Acceptance criteria

1. Every Connected Project domain passes the shared conformance suite at registration.
2. Gateway behavior matches the reference state machines (`GatewaySim`, `CreativePieceMachine`) under contract tests; versioning and approval invariants hold under property tests; renderer snapshot tests pin preview-equals-export.
3. KeepAnalog completes one full loop, brief to measured decision record, exercising every gate at least once: digest approval, brand-error block, `[NEED]` block, cap hit, submitted proof, scheduled Metric Snapshot, concluded Experiment.
4. The Operator still opens the daily rail in week four unforced.
5. The second project onboards with zero code changes. [Ticket 16](issues/16-define-dogfood-rollout.md)
