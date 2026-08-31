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
    "marketingos.apply_edit_batch":
      "Apply an atomic batch of typed edit operations to a Creative Piece, bound to the baseVersion it was computed against.",
    "marketingos.list_versions": "Read a Creative Piece's append-only version history.",
    "marketingos.restore_version": "Restore an old version of a Creative Piece as a new version.",
    "marketingos.get_brand_kit":
      "Read the selected project's Brand Kit: the versioned token table pieces reference. Pieces hold token names, never copied values.",
    "marketingos.check_brand":
      "Deterministic brand check over a piece: off-kit colours and fonts, empty text layers, and missing assets are errors that block approval; overflow risk is a warning.",
    "marketingos.check_quality":
      "Heuristic quality check over a piece. Every finding is advisory and never blocks anything.",
    "marketingos.render_preview":
      "Render a Creative Piece as slide HTML from the same components the PNG export screenshots.",
    "marketingos.export_piece":
      "Export a Creative Piece as a PNG-per-slide bundle plus captions, recorded with its doc and kit versions.",
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
