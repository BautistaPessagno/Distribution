# Find the MarketingOS MVP

Type: wayfinder:map
Status: active

## Destination

Produce an implementation-ready MVP product specification for a personal, multi-project MarketingOS that its owner can dogfood across KeepAnalog, partnr, and VinylOS. The specification must settle the MCP boundaries, evidence-backed reasoning, structured creative workspace, human account operations, dashboard, learning loop, scope, architecture, and acceptance criteria.

## Notes

- This map plans the MVP. It does not implement it.
- Read `CONTEXT.md` and `docs/agents/domain.md` before working a ticket.
- Use `grilling` and `domain-modeling` for product decisions, `prototype` for interface or contract questions, and `research` for external facts.
- The first Operator is the owner. The model may support invited collaborators later.
- KeepAnalog, partnr, and VinylOS are the first Connected Projects and implement the project domain behind the MarketingOS MCP gateway.
- The AI Host sees one MarketingOS MCP connection with `marketingos.*` and `project.*` domains. It is the only provider of AI reasoning and generation.
- Marketing AGI-inspired methods, references, rubrics, and schemas live in the versioned `marketingos.*` Method Library.
- HumanPost is the main reference for human account warm-up and distribution operations.
- Marketing AGI is the main reference for marketing reasoning, evidence, artifacts, and experiments.
- The Agentcy is the main reference for the brand workspace, Creative Pieces, versioned editing, validation, preview, backlog, and calendar.
- These products are references only. MarketingOS must not depend on them at runtime.
- The core MVP requires only the MarketingOS MCP gateway, an AI Host, and a project-domain implementation for each Connected Project. Ordinary social or advertising accounts may be manual destinations, but no additional creative vendor, model subscription, or automation service may be required.
- Static image prompts and edits may use capabilities already included in the AI Host. The MVP records the handoff and imported result; it does not claim that MarketingOS generated the image.
- External, destructive, identity-bearing, or money-spending actions require explicit Operator approval.

## Decisions so far

- [Understand the reference-product landscape](issues/01-understand-reference-products.md): the references divide cleanly into reasoning, creative workspace, production inspiration, and human distribution operations.
- [Model HumanPost account operations](issues/02-model-humanpost-account-operations.md): warm-up and distribution are proof-backed human Work Orders coordinated by software.
- [Adopt Marketing AGI as the reasoning grammar](issues/03-adopt-marketing-agi-reasoning.md): native modules will preserve its evidence, artifact, routing, and experiment discipline without a runtime dependency.
- [Adopt The Agentcy creative-workspace patterns](issues/04-adopt-agentcy-creative-workspace.md): the MVP will use structured Creative Pieces, versioned edits, deterministic checks, preview, backlog, and calendar.
- [Choose the first Operator model](issues/05-choose-first-operator-model.md): the owner is the sole initial Operator; assignments leave room for invited collaborators later.
- [Set the MVP dependency boundary](issues/06-set-mvp-dependency-boundary.md): the core requires the MarketingOS MCP gateway, an AI Host, and project-domain implementations only.
- [Choose the dashboard's first-use loop](issues/07-choose-dashboard-first-use-loop.md): the home screen is a Today view with due work, upcoming Creative Pieces, an undated backlog, a calendar, visible states, and a clear creation action.
- [Define the Connected Project MCP contract](issues/08-define-connected-project-mcp-contract.md): one MCP gateway exposes MarketingOS methods and a selected project's versioned, provenance-aware, approval-gated read/write domain while the AI Host supplies all AI compute.

## Not yet specified

- Current platform-policy research for the exact warm-up and manual engagement actions selected by the account-operations decision.
- The exact binary-media return path from each supported AI Host after image generation or editing.
- Authentication, authorization, and secrets design after both MCP contracts and the Operator model are specified.
- Hosting, deployment, and recovery requirements after the technical architecture is selected.
- Exact SEO, search-console, answer-engine, social, and product-metric ingestion after the measurement model identifies required observations.
- Licensing and attribution mechanics if Marketing AGI text or rubrics are copied rather than cleanly reimplemented.

## Out of scope

- Runtime integrations with HumanPost, Marketing AGI, The Agentcy, or Maxfusion.
- Additional model APIs, creative-vendor subscriptions, stock-media services, and specialized video-generation services.
- Video generation or editing.
- Autonomous follows, unfollows, comments, identity creation, public posting, paid-ad spending, or other external actions.
- Direct social publishing, advertising execution, and automated platform analytics in the first MVP.
- A labor marketplace, multi-organization product, or full agency collaboration suite.
- Guarantees that account warm-up improves reach, prevents enforcement, or creates permanent accounts.
