# Define the Connected Project MCP contract

Type: grilling
Status: resolved

## Question

What versioned resources, provenance, change feed, and safe actions must every Connected Project expose so MarketingOS can obtain Project Context, Brand Kit, audience, proof, funnel, metrics, assets, and current changes without reading the project's repository directly?

## Answer

### One connection and one AI-compute provider

The AI Host uses one MarketingOS MCP connection. That gateway exposes two domains:

- `marketingos.*` provides the Method Library, rules, schemas, strategies, Creative Pieces, workflow state, approvals, Work Orders, outcomes, and learning.
- `project.*` provides the selected Connected Project's context, assets, instructions, validation, and read/write operations.

The AI Host performs all AI reasoning and generation for both domains. MarketingOS and the Connected Project may perform deterministic work such as validation, rendering, builds, tests, hashing, storage, and file transformations, but neither invokes another AI model.

The gateway routes `project.*` operations to the selected Connected Project. Every Project Snapshot, Project Change Set, approval, asset, and Write Receipt is bound to one immutable Connected Project identity. The gateway rejects cross-project evidence or assets unless an explicit import creates new provenance.

### Method Library placement

Marketing AGI-inspired skills and references live in the `marketingos.*` Method Library, not inside each Connected Project. The library exposes versioned onboarding guidance, routing rules, marketing methods, references, rubrics, and output schemas. The AI Host loads only the method needed for the current goal, combines it with Project Context from `project.*`, performs the work, and returns a typed result.

Connected Projects may expose implementation-specific instructions through `project.*`, but they do not duplicate MarketingOS marketing methods. Substantial copied Marketing AGI text or rubrics must retain the source project's MIT attribution.

### Authority and synchronization

The Connected Project is authoritative for its product profile, Brand Kit, audiences, approved claims, funnels, assets, releases, and product metrics. MarketingOS is authoritative for opportunities, strategies, Creative Pieces, experiments, approvals, Work Orders, and marketing outcomes.

MarketingOS may stage a proposed change to project-owned information. It becomes canonical only after an approved project write succeeds and the new project version is synchronized. Cached Project Context cannot silently override the Connected Project. Conflicting versions stop the operation instead of merging automatically.

### Required project resources

Every Connected Project must expose:

- `manifest`: identity, lifecycle, locales, public URLs, contract versions, capability bundles, schemas, and limits
- `profile`: product, mechanism, exclusions, category, offers, markets, and lifecycle stage
- `audiences`: segments, problems, beliefs, alternatives, desired outcomes, and supporting evidence
- `brand`: voice, vocabulary, colors, typography, logos, visual rules, and prohibited usage
- `claims`: approved claim text, evidence, source date, permitted channels, approval status, and expiry
- `assets`: versioned asset metadata, rights, provenance, format, dimensions, hashes, and resource links
- `write-policy`: permitted Project Change Set operations, editable targets, protected resources, accepted formats, limits, validators, and approval classes
- `changes`: a monotonic cursor covering created, changed, removed, and invalidated resources

Required core resources must be implemented, though they may be validly empty. The optional surface is capability-negotiated, and `unsupported` is distinct from `empty`, so a project never fabricates data merely to satisfy the contract.

Optional capability bundles cover website and SEO surfaces, funnels and event definitions, metric definitions and queries, release history, structured-content editing, repository patching, and asset upload or replacement. The three initial dogfood projects must support asset upload plus at least one safe content-editing or repository-patching operation.

### Project Snapshots and provenance

A sync begins with an immutable Project Snapshot descriptor. It records the Connected Project identity, project revision, contract and schema versions, resource versions and hashes, timestamps, validity windows, capabilities, and a change cursor. The AI Host reads resources pinned to that snapshot, preventing a session from combining mismatched revisions.

Facts and claims that may influence marketing output carry field-level provenance. MarketingOS stores the exact Project Snapshot used by every strategy, Creative Piece, experiment, and Project Change Set.

Incremental synchronization uses the change cursor. An expired cursor, schema change, or integrity mismatch requires a fresh Project Snapshot.

### Project Change Sets

All mutations use a two-phase, typed protocol:

1. The AI Host computes a Project Change Set against a Project Snapshot.
2. `project.prepare_change` validates it without changing canonical project state and returns the exact diff, asset manifest, validation results, warnings, and digest.
3. The Operator reviews that prepared digest in MarketingOS.
4. MarketingOS issues a short-lived, scoped, single-use approval grant.
5. `project.apply_change` atomically applies the prepared change and returns a Write Receipt.

A Project Change Set may add or replace an asset, patch an allowed file, update structured content, update project-owned marketing context, add or revise an approved claim, or register an event or metric definition. The Connected Project defines editable locations, validators, file limits, accepted formats, and protected resources. If validation or any atomic operation fails, canonical project state does not change.

The common contract does not expose arbitrary shell execution, secret reads, deployments, production database mutations, customer messaging, money-spending actions, or destructive deletion.

### Approval and receipts

Every Connected Project mutation requires explicit Operator approval in the MVP. Reads, AI reasoning, MarketingOS drafts, and `prepare_change` do not. Staged files and assets remain private and expire automatically.

The approval grant binds the Connected Project, operation, targets, prepared digest, expected versions, Operator identity, and expiration. The project domain rejects missing, expired, reused, or mismatched grants.

A Write Receipt records the prepared change, applied operations, changed resources, resulting versions and hashes, actor, timestamps, validations, and next change cursor. The AI Host reports the receipt and result to MarketingOS after the write.

### Context Gaps and freshness

Project Context gaps use explicit states:

- `unsupported`
- `empty`
- `stale`
- `invalid`
- `conflicted`
- `unavailable`

A Context Gap does not block unrelated work. A Project Change Set is blocked when it depends on stale or invalid context, an unapproved or expired claim, an incompatible schema, a changed base version, or unavailable validation. The AI Host receives the exact gap and the cheapest required resolution instead of permission to guess.

### Data minimization

The core project domain never exposes secrets, tokens, cookies, environment variables, raw customer records, private messages, production database access, unapproved testimonials, unnecessary personal data, or assets without ownership and usage-rights metadata.

It may expose aggregated funnel metrics, approved audience insights, public product facts, and approved proof. Every sensitive resource and asset carries a classification and allowed-use policy that derived artifacts and Project Change Sets must preserve.

### Versions, errors, and conformance

The gateway handshake declares the core contract version, capability-bundle versions, operation kinds, limits, and schemas. Major-version mismatch blocks the connection. Minor versions may add optional fields or capabilities without breaking existing consumers.

Each Connected Project implementation must pass a shared conformance suite before MarketingOS marks the project domain healthy. The suite covers snapshots, provenance, change cursors, stale writes, atomic rollback, approval rejection, protected targets, asset validation, and Write Receipts.

Errors are structured and identify whether retry is safe plus the concrete recovery action. Required codes include `unsupported_capability`, `invalid_schema`, `stale_snapshot`, `version_conflict`, `approval_required`, `approval_mismatch`, `validation_failed`, `protected_target`, `rights_missing`, and `temporarily_unavailable`.

### Deferred boundary

The project domain requires content-addressed asset metadata, rights, hashes, and upload operations. The exact binary return path from each AI Host remains for [Define the AI Host onboarding contract](09-define-ai-host-onboarding-contract.md), where the sending side and attachment capabilities can be decided without changing this contract.
