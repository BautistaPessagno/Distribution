export const CONTRACT_VERSION = "0.1.0";

export const ONBOARD_GUIDE = {
  contract: CONTRACT_VERSION,
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
    "marketingos.get_method": "Route a marketing goal to a Method Library entry. (planned)",
    "project.get_snapshot": "Refresh the pinned Project Snapshot; the recovery path for stale_snapshot.",
    "project.get_resource": "Read brand, claims, or profile from the pinned snapshot with provenance and explicit Context Gap states.",
  },
  exampleGoals: [
    "Draft a positioning hypothesis for KeepAnalog from its Project Context.",
    "Audit the partnr landing funnel and return a Scorecard with Findings.",
    "Turn this Creative Brief into channel-native social posts for review.",
  ],
} as const;
