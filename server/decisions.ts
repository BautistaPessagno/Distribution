// Decision records and the learning log (ticket 25; decisions:
// docs/issues/marketing-os/issues/13-define-measurement-learning-loop.md).
//
// An experiment concludes at its stop condition and nowhere earlier. No
// winner is declared before the sample it predeclared has actually been
// delivered, because an experiment stopped when the numbers looked good is
// not an experiment.
//
// A conclusion is a typed decision — repeat, change, or stop — and an
// assessment of the evidence behind it. The assessment has to say what the
// evidence cannot support as plainly as what it can, name its rung on the
// evidence ladder, and name the cheapest next observation that would move
// it up. A conclusion with no ceiling stated is one that will be quoted
// later as if it had none.
//
// The ladder is enforced rather than declared. A caller may claim any rung;
// this module refuses one the evidence does not reach, and says which rung
// it does reach and why.
//
// Funnel movements are carried as correlations, always, and labelled as
// such. They may justify the next test. They are never the reason.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import { getTargetById } from "./deliveries";
import {
  getExperimentById,
  enrolledTargets,
  observationsFor,
  type Experiment,
} from "./experiments";
import { listSnapshots, type MetricSnapshot } from "./snapshots";

export const DECISIONS = ["repeat", "change", "stop"] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * The evidence ladder, strongest first. The rung is not a compliment paid
 * to a result; it is a statement of what kind of claim the result can carry.
 */
export const LADDER_RUNGS = [
  "controlled_experiment",
  "within_account_comparison",
  "pre_post_observation",
  "correlated_observation",
  "anecdote",
] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

export const RUNG_MEANING: Record<LadderRung, string> = {
  controlled_experiment:
    "One variable was isolated, the sample was predeclared and delivered, and the readings were taken at the declared observation points.",
  within_account_comparison:
    "Two arms on the same account, without the full predeclared sample behind them.",
  pre_post_observation: "The same account before and after a change, with nothing held constant.",
  correlated_observation:
    "Two things moved together. That is a reason to test, never a reason to believe one caused the other.",
  anecdote: "One instance, remembered.",
};

export interface CorrelatedObservation {
  metric: string;
  readings: number;
  source: "project_funnel";
  label: string;
}

export interface DecisionRecord {
  id: number;
  experimentId: number;
  projectId: number;
  decision: Decision;
  supports: string;
  doesNotSupport: string;
  ladderRung: LadderRung;
  cheapestNextObservation: string;
  stopConditionMet: string;
  sampleAtConclusion: number;
  sampleTarget: number;
  correlatedObservations: CorrelatedObservation[];
  decidedBy: string;
  decidedAt: string;
}

export class DecisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "DecisionError";
  }
}

interface RecordRow {
  id: number;
  experiment_id: number;
  project_id: number;
  decision: Decision;
  supports: string;
  does_not_support: string;
  ladder_rung: LadderRung;
  cheapest_next_observation: string;
  stop_condition_met: string;
  sample_at_conclusion: number;
  sample_target: number;
  correlated_observations: string;
  decided_by: string;
  decided_at: string;
}

function rowToRecord(row: RecordRow): DecisionRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    projectId: row.project_id,
    decision: row.decision,
    supports: row.supports,
    doesNotSupport: row.does_not_support,
    ladderRung: row.ladder_rung,
    cheapestNextObservation: row.cheapest_next_observation,
    stopConditionMet: row.stop_condition_met,
    sampleAtConclusion: row.sample_at_conclusion,
    sampleTarget: row.sample_target,
    correlatedObservations: JSON.parse(row.correlated_observations) as CorrelatedObservation[],
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

export function getDecisionFor(experimentId: number): DecisionRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM decision_records WHERE experiment_id = ?")
    .get(experimentId) as RecordRow | undefined;
  return row ? rowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// What the sample actually is

export interface SampleState {
  target: number;
  /** Enrolled deliveries that actually went up and were verified. */
  delivered: number;
  short: number;
  met: boolean;
}

/**
 * The sample, counted the only way that means anything: deliveries that
 * were enrolled and reached verified_posted. An enrolled delivery still
 * sitting in a queue has told us nothing.
 */
export function sampleState(experiment: Experiment): SampleState {
  const delivered = enrolledTargets(experiment.id).filter(
    (id) => getTargetById(id)?.status === "verified_posted"
  ).length;
  return {
    target: experiment.sampleTarget,
    delivered,
    short: Math.max(0, experiment.sampleTarget - delivered),
    met: delivered >= experiment.sampleTarget,
  };
}

/**
 * The highest rung this experiment's evidence actually reaches, and why.
 *
 * A controlled experiment needs three things at once: one isolated variable
 * declared in advance (which every experiment here has), the predeclared
 * sample delivered, and readings of the primary metric taken by hand at the
 * declared observation points. Missing the last of those leaves a
 * comparison; missing the sample leaves a before-and-after; readings that
 * exist only in the product funnel leave a correlation, because nothing in
 * a funnel number says which post moved it.
 */
export function highestRungAvailable(experiment: Experiment): {
  rung: LadderRung;
  why: string;
} {
  const sample = sampleState(experiment);
  const readings = listSnapshots({ experimentId: experiment.id });
  const primaryReadings = readings.filter(
    (s) => s.metric === experiment.primaryMetric && s.source === "operator_reading"
  );
  const atObservationPoints = primaryReadings.filter((s) => s.observationId !== null);
  const deliveriesRead = new Set(atObservationPoints.map((s) => s.targetId)).size;

  if (primaryReadings.length === 0) {
    return {
      rung: "correlated_observation",
      why: `Nothing was read for "${experiment.primaryMetric}" on the posts themselves, so whatever moved elsewhere only moved alongside.`,
    };
  }
  if (!sample.met) {
    return {
      rung: "pre_post_observation",
      why: `The predeclared sample of ${sample.target} was not delivered; ${sample.delivered} were. Readings without the sample behind them describe what happened, not what works.`,
    };
  }
  if (deliveriesRead < sample.target) {
    return {
      rung: "within_account_comparison",
      why: `${deliveriesRead} of ${sample.target} delivered posts were read at a declared observation point, so the arms are comparable but the schedule was not held to.`,
    };
  }
  return {
    rung: "controlled_experiment",
    why: `One variable was declared in advance, ${sample.delivered} of ${sample.target} posts were delivered, and "${experiment.primaryMetric}" was read on every one at a declared observation point.`,
  };
}

/**
 * Funnel movements observed for this project, carried alongside the
 * decision and labelled for what they are. They are never the reason: a
 * funnel number cannot tell you which post moved it.
 */
export function correlationsFor(experiment: Experiment): CorrelatedObservation[] {
  const funnel = listSnapshots({ projectId: experiment.projectId }).filter(
    (s: MetricSnapshot) => s.source === "project_funnel"
  );
  const byMetric = new Map<string, number>();
  for (const snapshot of funnel) {
    byMetric.set(snapshot.metric, (byMetric.get(snapshot.metric) ?? 0) + 1);
  }
  return [...byMetric.entries()].map(([metric, readings]) => ({
    metric,
    readings,
    source: "project_funnel" as const,
    label:
      "Correlated observation. This moved alongside the experiment; nothing here says the experiment moved it. It may justify the next test and never stands as proof.",
  }));
}

// ---------------------------------------------------------------------------
// Concluding

export const concludeSchema = z.object({
  decision: z.enum(DECISIONS),
  supports: z.string().min(1).max(2000),
  doesNotSupport: z.string().min(1).max(2000),
  ladderRung: z.enum(LADDER_RUNGS),
  cheapestNextObservation: z.string().min(1).max(1000),
  /** How the predeclared stop condition was met, in the Operator's words. */
  stopConditionMet: z.string().min(1).max(1000),
});

const ASSESSMENT_PARTS: Record<string, string> = {
  decision: "the decision: repeat, change, or stop",
  supports: "what the evidence supports",
  doesNotSupport: "what the evidence does not support",
  ladderRung: "its rung on the evidence ladder",
  cheapestNextObservation: "the cheapest next observation",
  stopConditionMet: "how the predeclared stop condition was met",
};

export interface Conclusion {
  experiment: Experiment;
  record: DecisionRecord;
  sample: SampleState;
  available: { rung: LadderRung; why: string };
}

/**
 * Conclude an experiment. Four things have to hold, and none of them is a
 * warning:
 *
 *   The sample the experiment predeclared has been delivered.
 *   The stop condition is stated as met, in words, by a person.
 *   The assessment is whole — including what the evidence cannot support.
 *   The claimed ladder rung is one the evidence actually reaches.
 */
export function concludeWithDecision(
  experimentId: number,
  input: unknown,
  actor = "operator"
): Conclusion {
  const experiment = getExperimentById(experimentId);
  if (!experiment) throw new DecisionError(404, `No experiment #${experimentId}`);
  if (getDecisionFor(experimentId)) {
    throw new DecisionError(
      409,
      `Experiment #${experimentId} already concluded. A decision record is what was believed at the time and is not revised.`
    );
  }

  const parsed = concludeSchema.safeParse(input);
  if (!parsed.success) {
    const missing = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const field = String(issue.path[0] ?? "");
          return ASSESSMENT_PARTS[field] ?? `${issue.path.join(".") || "(root)"}: ${issue.message}`;
        })
      ),
    ];
    throw new DecisionError(
      400,
      "A conclusion states all of it or none of it. This one is missing: " + missing.join("; ") + ".",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const spec = parsed.data;

  // The sample first, because everything else is an argument about numbers
  // that are not all in yet.
  const sample = sampleState(experiment);
  if (!sample.met) {
    throw new DecisionError(
      409,
      `"${experiment.name}" predeclared a sample of ${sample.target} and ${sample.delivered} have been delivered. No winner is declared ${sample.short} short of the sample the experiment set for itself.`,
      [`Stop condition as declared: ${experiment.stopCondition}`]
    );
  }

  const available = highestRungAvailable(experiment);
  if (rungIsAbove(spec.ladderRung, available.rung)) {
    throw new DecisionError(
      409,
      `This evidence reaches ${available.rung.replace(/_/g, " ")}, not ${spec.ladderRung.replace(/_/g, " ")}. ${available.why}`,
      [RUNG_MEANING[available.rung]]
    );
  }

  const correlations = correlationsFor(experiment);
  const db = getDb();
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO decision_records
          (experiment_id, project_id, decision, supports, does_not_support, ladder_rung,
           cheapest_next_observation, stop_condition_met, sample_at_conclusion,
           sample_target, correlated_observations, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        experiment.id,
        experiment.projectId,
        spec.decision,
        spec.supports,
        spec.doesNotSupport,
        spec.ladderRung,
        spec.cheapestNextObservation,
        spec.stopConditionMet,
        sample.delivered,
        sample.target,
        JSON.stringify(correlations),
        actor
      );
    db.prepare(
      "UPDATE experiments SET status = 'concluded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(experiment.id);
    return Number(info.lastInsertRowid);
  })();

  const record = getDecisionFor(experiment.id);
  if (!record || record.id !== id) throw new Error("decision record did not persist");
  audit(actor, "decisions.concluded", {
    experimentId: experiment.id,
    projectId: experiment.projectId,
    decision: spec.decision,
    ladderRung: spec.ladderRung,
    sample: `${sample.delivered}/${sample.target}`,
  });

  const concluded = getExperimentById(experiment.id);
  if (!concluded) throw new Error("experiment vanished");
  return { experiment: concluded, record, sample, available };
}

/** True when `claimed` sits higher on the ladder than `available`. */
function rungIsAbove(claimed: LadderRung, available: LadderRung): boolean {
  return LADDER_RUNGS.indexOf(claimed) < LADDER_RUNGS.indexOf(available);
}

// ---------------------------------------------------------------------------
// The learning log
//
// Derived from the decision records rather than copied into a second table,
// so there is exactly one place a conclusion lives and no way for the log
// to drift from it.

export interface LearningEntry {
  experimentId: number;
  name: string;
  variable: string;
  primaryMetric: string;
  decisionRule: string;
  decision: Decision;
  supports: string;
  doesNotSupport: string;
  ladderRung: LadderRung;
  ladderMeaning: string;
  cheapestNextObservation: string;
  stopConditionMet: string;
  sample: { delivered: number; target: number };
  correlatedObservations: CorrelatedObservation[];
  observationPoints: string[];
  decidedBy: string;
  decidedAt: string;
}

export function learningLog(projectId: number): LearningEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM decision_records WHERE project_id = ? ORDER BY decided_at DESC, id DESC")
    .all(projectId) as RecordRow[];
  return rows.flatMap((row) => {
    const record = rowToRecord(row);
    const experiment = getExperimentById(record.experimentId);
    if (!experiment) return [];
    return [
      {
        experimentId: experiment.id,
        name: experiment.name,
        variable: experiment.variable,
        primaryMetric: experiment.primaryMetric,
        decisionRule: experiment.decisionRule,
        decision: record.decision,
        supports: record.supports,
        doesNotSupport: record.doesNotSupport,
        ladderRung: record.ladderRung,
        ladderMeaning: RUNG_MEANING[record.ladderRung],
        cheapestNextObservation: record.cheapestNextObservation,
        stopConditionMet: record.stopConditionMet,
        sample: { delivered: record.sampleAtConclusion, target: record.sampleTarget },
        correlatedObservations: record.correlatedObservations,
        observationPoints: observationsFor(experiment.id).map((p) => p.label),
        decidedBy: record.decidedBy,
        decidedAt: record.decidedAt,
      },
    ];
  });
}

/**
 * The log as a host reads it. The framing is part of the payload: a host
 * that reads a conclusion without its ceiling will quote it as if it had
 * none.
 */
export function learningLogView(projectId: number): Record<string, unknown> {
  const entries = learningLog(projectId);
  return {
    entries,
    ladder: LADDER_RUNGS.map((rung) => ({ rung, meaning: RUNG_MEANING[rung] })),
    note:
      "Every conclusion carries the rung its evidence reaches and what that evidence cannot support. " +
      "Correlated observations are listed beside each decision and never underneath it: a funnel movement may justify the next test and is never proof of what caused it.",
  };
}

export function decisionView(record: DecisionRecord): Record<string, unknown> {
  return {
    experimentId: record.experimentId,
    decision: record.decision,
    evidence: {
      supports: record.supports,
      doesNotSupport: record.doesNotSupport,
      ladderRung: record.ladderRung,
      ladderMeaning: RUNG_MEANING[record.ladderRung],
      cheapestNextObservation: record.cheapestNextObservation,
    },
    sample: { delivered: record.sampleAtConclusion, target: record.sampleTarget },
    stopConditionMet: record.stopConditionMet,
    correlatedObservations: record.correlatedObservations,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
  };
}
