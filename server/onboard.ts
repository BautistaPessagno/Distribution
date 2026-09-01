export const CONTRACT_VERSION = "0.1.0";
export const METHOD_LIBRARY_VERSION = "2026.08";

export const ONBOARD_GUIDE = {
  contract: CONTRACT_VERSION,
  methodLibraryVersion: METHOD_LIBRARY_VERSION,
  product: "MarketingOS",
  summary:
    "MarketingOS gives your AI Host evidence-backed marketing reasoning over versioned Connected Project context. One connection exposes two domains: marketingos.* (methods, pieces, workflow, approvals, Work Orders, outcomes) and project.* (the selected Connected Project's versioned, approval-gated context).",
  rules: [
    "Call marketingos.select_project first; every session is pinned to a Project Snapshot.",
    "Every response echoes {project, snapshot, contract}; treat a changed snapshot as a new session.",
    "Context Gaps are explicit states, never silent omissions. Surface them to the Operator.",
    "Writes use the two-phase Project Change Set protocol: prepare, Operator approval, apply. Approvals are digest-keyed and never transit the host.",
    "Approved-claims-only citation. [NEED] tokens block approval. Heuristic scores self-label.",
    "MarketingOS never generates images. Every asset records its origin, prompt lineage, and rights notes, or it is refused.",
    "MarketingOS never creates a platform account and never performs a platform action. Account readiness is an explicit evidenced checklist, never elapsed time, and daily caps are our judgment calls rather than platform-sanctioned volumes.",
    "Platform work happens through Work Orders a person claims and completes. Nothing completes without proof, and a retry is a new attempt rather than a rewrite of the last one.",
    "No secret material ever appears in MCP responses, method text, Work Orders, proofs, or logs.",
  ],
  tools: {
    "marketingos.onboard": "This guide: contract version, rules, tool map, example goals.",
    "marketingos.select_project": "Pin the session to one Connected Project Snapshot.",
    "marketingos.get_method":
      "Route a marketing goal to a Method Library entry: steps, rubric, output schema. Chained goals return a persisted MarketingRunPlan; unknown goals return closest-goal suggestions.",
    "marketingos.create_piece":
      "Create a Creative Piece from a PieceDoc bound to the pinned Project Snapshot. It starts in the backlog for Operator review in Studio.",
    "marketingos.get_piece": "Read one Creative Piece with its full PieceDoc. Cross-project access is refused.",
    "marketingos.list_pieces": "List the selected project's Creative Pieces with status tags.",
    "marketingos.start_drafting": "Move a backlog Creative Piece to drafting, where edits apply.",
    "marketingos.submit_for_review":
      "Hand a drafting piece to the Operator for review. Only the Operator approves; approval means a person saw that exact document.",
    "marketingos.approval_status":
      "What stands between a piece and approval: brand errors and [NEED: ...] tokens block; quality findings never do.",
    "marketingos.reopen_piece":
      "Reopen a piece in review, approved, or planned back to drafting. Approval and the planned date are cleared.",
    "marketingos.register_asset":
      "Return a generated image as inline base64 with origin, prompt, lineage, and rights notes. Missing metadata fails with rights_missing; no payload or an oversized one drops the piece to 'prompt prepared' for manual upload.",
    "marketingos.list_assets":
      "List the selected project's registered assets. Image layers reference them by stable asset:// id.",
    "marketingos.save_as_template":
      "Save a piece's layout as a Creative Template: structure and token references kept, campaign content stripped.",
    "marketingos.list_templates": "List the selected project's Creative Templates.",
    "marketingos.instantiate_template":
      "Start a new backlog piece from a Creative Template, bound to this session's pinned snapshot.",
    "marketingos.record_outcome": "Record what an exported piece did, moving it to measured.",
    "marketingos.list_work_orders":
      "Read the selected project's Work Orders: state, the one-instruction card, every attempt with its proof and review, and the transition history. Read-only.",
    "marketingos.list_account_slots":
      "Read the selected project's Account Slots, their caps and windows, and the readiness checklist of the instance in each. Read-only: MarketingOS never creates an identity or performs a platform action.",
    "marketingos.get_brand_kit":
      "Read the selected project's Brand Kit: the versioned token table pieces reference. Pieces hold token names, never copied values.",
    "marketingos.check_brand":
      "Deterministic brand check over a piece: off-kit colors and fonts, empty text layers, and missing assets are errors that block approval; overflow risk is a warning.",
    "marketingos.check_quality":
      "Heuristic quality check over a piece. Every finding is advisory and never blocks anything.",
    "project.prepare_change":
      "Phase one of a project write: validate a Project Change Set against the pinned snapshot, change nothing, and return the digest, the exact diff, validations, and warnings.",
    "marketingos.get_approval":
      "The Operator's decision on a prepared digest: pending, approved, rejected, or used, with the one call to make next. A status, never a token.",
    "project.apply_change":
      "Phase two: apply an approved prepared change atomically and get a Write Receipt. Exactly once per approval; refuses before approval, after rejection, on reuse, cross-project, or once the project has moved on.",
    "project.get_snapshot": "Refresh the pinned Project Snapshot; the recovery path for stale_snapshot.",
    "project.get_resource": "Read brand, claims, or profile from the pinned snapshot with provenance and explicit Context Gap states.",
  },
  exampleGoals: [
    "positioning — draft a PositioningHypothesis from the pinned Project Snapshot.",
    "audit_website — return an AuditRun: weighted Scorecard plus prioritized Findings.",
    "social_content — turn a Creative Brief into channel-native posts for review.",
    "audit_to_copy — a chained goal: routes to a persisted MarketingRunPlan.",
  ],
} as const;
