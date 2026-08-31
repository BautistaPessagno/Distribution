# Define the reasoning-module frontier

Type: grilling
Status: resolved

## Question

Which Marketing AGI-inspired capabilities belong in the first MVP, how does the Marketing Router choose and chain them, and what concrete artifact must each capability produce for KeepAnalog, partnr, and VinylOS?

## Answer

Settled by grilling against [the Marketing AGI source review](../research/marketing-agi-deep-dive.md).

### Capability cut: the core six

The MVP ships six native capabilities, chosen because all three dogfood projects are early-stage and the only distribution channel the MVP owns is organic social through warmed accounts:

1. **Positioning** produces a `PositioningHypothesis`: selected frame, rejected frames, offer, and the downstream change set.
2. **Website/funnel audit** produces an `AuditRun`: weighted `Scorecard` plus prioritized `Findings` with replacement copy. Evidence coverage is separate from score; `unknown` is distinct from `fail`.
3. **Copy** turns a Creative Brief into ranked `ArtifactVariants` with a test contrast, matched to awareness stage, passed through the anti-slop check.
4. **Hooks** produce a `HookMatrix`: visual action, spoken line, and on-screen text doing different jobs, grounded in real corpus references.
5. **Social content** produces channel-native posts with a pre-fold hook, job label, alternate hooks, repurposing lineage, and cadence. This is the capability that feeds Creative Pieces.
6. **Analytics/experiments** produce an `Experiment` (one variable, one primary metric, decision rule, sample target, stop condition, predeclared) and an `EvidenceAssessment`.

Deferred to post-MVP: email sequences (no lists yet), launch campaigns, competitor teardowns, app-store optimization, GEO/answer-engine citability, and native SEO/editorial planning.

For each dogfood project the first concrete artifacts are the same set: one PositioningHypothesis, one AuditRun of its public site, one HookMatrix plus a first social cadence of Creative Pieces, and one predeclared Experiment attached to its first distribution.

### Router: plans only for chains

Single-method jobs run directly through `marketingos.get_method(goal)` from the AI Host onboarding contract, with no extra ceremony. When a goal requires two or more chained modules (audit to copy, positioning to copy to social, hooks to copy), the router returns a persisted `MarketingRunPlan` before any generation: the modules, evidence inputs, expected artifacts, and approval gates. The Operator sees the plan as one reviewable step, matching the one-instruction-per-step preference. Marketing AGI's chain conventions port as the router's known chains.

### Typed artifacts with lineage

Every artifact carries type, version, source Project Snapshot, authoring run, upstream finding IDs, cited Proof Claims, status, target channel, and experiment ID. Handoffs pass identifiers, never copied prose. When a brand fact changes or a claim expires, dependent artifacts are flagged stale, the same pinning discipline the Creative Piece workflow uses for the Brand Kit.

### Honesty rules as enforced invariants

Deterministic checks, not method prose: generated text may cite only approved claims from the pinned Project Snapshot; unsupported claims render a visible `[NEED: ...]` token that blocks Creative Piece approval, alongside brand errors; heuristic scores label themselves heuristics; no experiment may declare a winner without its predeclared sample target and stop condition; unknowns are recorded on every report; time-sensitive platform facts require a dated observation.
