// The versioned Method Library and goal routing (reference: GatewaySim in
// ai-host-onboarding.html; capability cut settled in marketing-os issue 11).
//
// Discovery is progressive: `marketingos.get_method(goal)` returns exactly
// the one method the current goal needs — steps, rubric, output schema — and
// nothing else. Unknown goals route with `unknown_goal` and closest-goal
// suggestions instead of failing. Goals that require two or more chained
// modules return a persisted MarketingRunPlan the Operator can inspect
// before any generation happens.

import { audit } from "./audit";
import { getDb } from "./db";
import { noProjectSelected, sessionContext, type GatewayResult } from "./gateway";
import { METHOD_LIBRARY_VERSION } from "./onboard";

export { METHOD_LIBRARY_VERSION };

export interface Method {
  goal: string;
  capability: string;
  version: string;
  rubric: string;
  steps: string[];
  evidenceInputs: string[];
  expectedArtifact: string;
  approvalGates: string[];
  outputSchema: Record<string, string>;
}

// The core six capabilities, one versioned method each.
export const METHODS: Record<string, Method> = {
  positioning: {
    goal: "positioning",
    capability: "positioning",
    version: "1",
    rubric: "frame-selection.v1",
    steps: [
      "Read profile and approved claims from the pinned Project Snapshot",
      "Generate candidate frames and reject the weak ones with reasons",
      "Select one frame and state the offer it implies",
      "List the downstream change set (site copy, social bio, Creative Briefs)",
    ],
    evidenceInputs: ["snapshot.profile", "snapshot.claims"],
    expectedArtifact: "PositioningHypothesis",
    approvalGates: ["Operator reviews the hypothesis before any downstream artifact is drafted"],
    outputSchema: {
      selected_frame: "string",
      rejected_frames: "string[]",
      offer: "string",
      change_set: "string[]",
    },
  },
  audit_website: {
    goal: "audit_website",
    capability: "audit",
    version: "1",
    rubric: "weighted-scorecard.v1",
    steps: [
      "Fetch the public pages named by the Operator",
      "Score each dimension of the weighted Scorecard; record 'unknown' where evidence is missing — unknown is distinct from fail",
      "Write prioritized Findings, each with replacement copy grounded in approved claims",
      "Report evidence coverage separately from the score",
    ],
    evidenceInputs: ["snapshot.profile", "snapshot.claims", "public site pages"],
    expectedArtifact: "AuditRun",
    approvalGates: ["Operator reviews Findings before replacement copy ships anywhere"],
    outputSchema: {
      scorecard: "{dimension: string, weight: number, score: number|'unknown'}[]",
      findings: "{priority: number, finding: string, replacement_copy: string}[]",
      evidence_coverage: "number",
    },
  },
  draft_copy: {
    goal: "draft_copy",
    capability: "copy",
    version: "1",
    rubric: "anti-slop-variants.v1",
    steps: [
      "Read the Creative Brief and the pinned Project Snapshot",
      "Match the copy to the audience's awareness stage",
      "Draft ranked variants citing approved claims only; unsupported claims render [NEED: ...] tokens",
      "Declare the test contrast between the top variants and run the anti-slop check",
    ],
    evidenceInputs: ["Creative Brief", "snapshot.claims", "snapshot.brand"],
    expectedArtifact: "ArtifactVariants",
    approvalGates: ["[NEED] tokens block approval", "Operator approves the ranked variants"],
    outputSchema: {
      variants: "{rank: number, text: string, awareness_stage: string}[]",
      test_contrast: "string",
      need_tokens: "string[]",
    },
  },
  hook_matrix: {
    goal: "hook_matrix",
    capability: "hooks",
    version: "1",
    rubric: "three-channel-hooks.v1",
    steps: [
      "Collect real corpus references for the format and channel",
      "For each hook give the visual action, spoken line, and on-screen text different jobs",
      "Ground every hook in an approved claim or a cited corpus reference",
      "Rank hooks by expected stopping power with a self-labeled heuristic score",
    ],
    evidenceInputs: ["snapshot.claims", "corpus references"],
    expectedArtifact: "HookMatrix",
    approvalGates: ["Operator picks the hooks that go on to Creative Pieces"],
    outputSchema: {
      hooks:
        "{visual_action: string, spoken_line: string, on_screen_text: string, grounding: string, heuristic_score: number}[]",
    },
  },
  social_content: {
    goal: "social_content",
    capability: "social",
    version: "1",
    rubric: "channel-native-posts.v1",
    steps: [
      "Read the pinned Project Snapshot and any upstream HookMatrix or ArtifactVariants",
      "Draft channel-native posts with a pre-fold hook, a job label, and alternate hooks",
      "Record the repurposing lineage from any upstream artifact identifiers",
      "Propose a cadence; the posts feed Creative Pieces for Operator review",
    ],
    evidenceInputs: ["snapshot.claims", "snapshot.brand", "upstream artifact ids"],
    expectedArtifact: "ChannelNativePosts",
    approvalGates: ["Every post becomes a Creative Piece gated on Operator approval"],
    outputSchema: {
      posts:
        "{channel: string, pre_fold_hook: string, job_label: string, alternate_hooks: string[], lineage: string[]}[]",
      cadence: "string",
    },
  },
  design_experiment: {
    goal: "design_experiment",
    capability: "experiments",
    version: "1",
    rubric: "predeclared-experiment.v1",
    steps: [
      "Pick exactly one variable and one primary metric",
      "Predeclare the decision rule, sample target, and stop condition before any distribution",
      "Attach the experiment to the distribution it measures",
      "Assess the evidence: no winner may be declared before the sample target and stop condition are met",
    ],
    evidenceInputs: ["snapshot.profile", "distribution plan"],
    expectedArtifact: "Experiment + EvidenceAssessment",
    approvalGates: ["Operator approves the predeclaration before the experiment starts"],
    outputSchema: {
      variable: "string",
      primary_metric: "string",
      decision_rule: "string",
      sample_target: "number",
      stop_condition: "string",
      evidence_assessment: "string",
    },
  },
};

// Known chains (marketing-os issue 11): goals needing two or more modules
// return a persisted MarketingRunPlan instead of a single method.
export const CHAINS: Record<string, { modules: string[]; summary: string }> = {
  audit_to_copy: {
    modules: ["audit_website", "draft_copy"],
    summary: "Audit the public funnel, then turn the prioritized Findings into ranked replacement copy.",
  },
  positioning_to_social: {
    modules: ["positioning", "draft_copy", "social_content"],
    summary:
      "Settle the positioning frame, draft copy from it, then produce channel-native posts feeding Creative Pieces.",
  },
  hooks_to_copy: {
    modules: ["hook_matrix", "draft_copy"],
    summary: "Build the HookMatrix, then draft ranked copy variants around the selected hooks.",
  },
};

export interface RunPlanRecord {
  id: number;
  goal: string;
  project: string;
  snapshot: string;
  status: string;
  plan: {
    summary: string;
    modules: {
      goal: string;
      capability: string;
      version: string;
      evidenceInputs: string[];
      expectedArtifact: string;
      approvalGates: string[];
    }[];
  };
  createdAt: string;
}

interface RunPlanRow {
  id: number;
  goal: string;
  project: string;
  snapshot: string;
  status: string;
  plan: string;
  created_at: string;
}

function rowToRecord(row: RunPlanRow): RunPlanRecord {
  return {
    id: row.id,
    goal: row.goal,
    project: row.project,
    snapshot: row.snapshot,
    status: row.status,
    plan: JSON.parse(row.plan) as RunPlanRecord["plan"],
    createdAt: row.created_at,
  };
}

export function listRunPlans(): RunPlanRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM run_plans ORDER BY id DESC")
    .all() as RunPlanRow[];
  return rows.map(rowToRecord);
}

export function getRunPlan(id: number): RunPlanRecord | null {
  const row = getDb().prepare("SELECT * FROM run_plans WHERE id = ?").get(id) as
    | RunPlanRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

function persistRunPlan(
  goal: string,
  project: string,
  snapshot: string,
  plan: RunPlanRecord["plan"]
): RunPlanRecord {
  const info = getDb()
    .prepare(
      "INSERT INTO run_plans (goal, project, snapshot, plan) VALUES (?, ?, ?, ?)"
    )
    .run(goal, project, snapshot, JSON.stringify(plan));
  const record = getRunPlan(Number(info.lastInsertRowid));
  if (!record) throw new Error("run plan insert did not persist");
  return record;
}

// Levenshtein distance for closest-goal routing suggestions.
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return d[rows - 1][cols - 1];
}

export function knownGoals(): string[] {
  return [...Object.keys(METHODS), ...Object.keys(CHAINS)];
}

export function closestGoals(goal: string, count = 3): string[] {
  const needle = goal.toLowerCase();
  return knownGoals()
    .map((g) => {
      const containment = g.includes(needle) || needle.includes(g) ? -g.length : 0;
      return { goal: g, score: containment || distance(needle, g) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((e) => e.goal);
}

export function getMethod(sessionKey: string, goal: string): GatewayResult {
  const context = sessionContext(sessionKey);
  if (!context.project || !context.snapshot) return noProjectSelected();

  const normalized = goal.trim().toLowerCase();

  const method = METHODS[normalized];
  if (method) {
    return {
      ok: true,
      response: {
        context,
        methodLibraryVersion: METHOD_LIBRARY_VERSION,
        ...method,
      },
    };
  }

  const chain = CHAINS[normalized];
  if (chain) {
    const modules = chain.modules.map((g) => {
      const m = METHODS[g];
      return {
        goal: m.goal,
        capability: m.capability,
        version: m.version,
        evidenceInputs: m.evidenceInputs,
        expectedArtifact: m.expectedArtifact,
        approvalGates: m.approvalGates,
      };
    });
    const record = persistRunPlan(normalized, context.project, context.snapshot, {
      summary: chain.summary,
      modules,
    });
    audit("ai-host", "methods.run_plan_created", {
      runPlanId: record.id,
      goal: normalized,
      project: context.project,
      snapshot: context.snapshot,
    });
    return {
      ok: true,
      response: {
        context,
        methodLibraryVersion: METHOD_LIBRARY_VERSION,
        runPlan: record,
        note: "This goal chains multiple modules. The MarketingRunPlan is persisted for Operator inspection before any generation; retrieve each module's method with marketingos.get_method as you reach it.",
      },
    };
  }

  return {
    ok: false,
    response: {
      error: "unknown_goal",
      message: `No method for goal "${goal}".`,
      suggestions: closestGoals(normalized),
      next: `Closest goals: ${closestGoals(normalized).join(", ")}. Ask with one of these.`,
    },
  };
}
