// Predeclared Experiments and the measure orders they schedule (ticket 23;
// decisions: .scratch/marketing-os/issues/13-define-measurement-learning-loop.md).
//
// An experiment is declared in full before any work ships: one variable,
// one primary metric, the rule that will decide it, the sample it needs,
// and the condition that stops it. All of it, or none of it — a partial
// declaration is refused rather than saved as a draft to finish later,
// because the thing predeclaration protects against is exactly the
// finishing-later.
//
// The declaration is then fixed. The database refuses to edit it, so a
// result cannot be explained by a rule that changed after the numbers came
// in.
//
// Observation points say when to look, at what, and where to read it. When
// a Delivery Target this experiment watches reaches verified_posted, each
// observation point becomes a measure Work Order due at its own offset from
// that moment. Nobody schedules them by hand and nobody can forget to.
//
// Ad-hoc measurement stays possible. It is simply a measure order nobody
// scheduled, and every surface says so, because a number someone went
// looking for is not the same kind of evidence as a number the experiment
// asked for in advance.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import { getTargetById, verifyPosted, type DeliveryTarget } from "./deliveries";
import { getReleaseById } from "./deliveries";
import { createOrder, approveOrder, submitOrder, type WorkOrder } from "./work-orders";

export const EXPERIMENT_STATUSES = ["predeclared", "running", "stopped", "concluded"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export interface ObservationPoint {
  id: number;
  experimentId: number;
  position: number;
  label: string;
  /** Hours after the delivery was verified posted. */
  afterHours: number;
  metrics: string[];
  source: string;
}

export interface Experiment {
  id: number;
  projectId: number;
  name: string;
  /** The one thing being varied. One, because two is not an experiment. */
  variable: string;
  primaryMetric: string;
  decisionRule: string;
  sampleTarget: number;
  stopCondition: string;
  status: ExperimentStatus;
  declaredBy: string;
  createdAt: string;
  updatedAt: string;
}

export class ExperimentError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "ExperimentError";
  }
}

interface ExperimentRow {
  id: number;
  project_id: number;
  name: string;
  variable: string;
  primary_metric: string;
  decision_rule: string;
  sample_target: number;
  stop_condition: string;
  status: ExperimentStatus;
  declared_by: string;
  created_at: string;
  updated_at: string;
}

function rowToExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    variable: row.variable,
    primaryMetric: row.primary_metric,
    decisionRule: row.decision_rule,
    sampleTarget: row.sample_target,
    stopCondition: row.stop_condition,
    status: row.status,
    declaredBy: row.declared_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ObservationRow {
  id: number;
  experiment_id: number;
  position: number;
  label: string;
  after_hours: number;
  metrics: string;
  source: string;
}

function rowToObservation(row: ObservationRow): ObservationPoint {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    position: row.position,
    label: row.label,
    afterHours: row.after_hours,
    metrics: JSON.parse(row.metrics) as string[],
    source: row.source,
  };
}

// ---------------------------------------------------------------------------
// Reading

export function getExperimentById(id: number): Experiment | null {
  const row = getDb().prepare("SELECT * FROM experiments WHERE id = ?").get(id) as
    | ExperimentRow
    | undefined;
  return row ? rowToExperiment(row) : null;
}

export function listExperiments(projectId?: number): Experiment[] {
  const db = getDb();
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT * FROM experiments ORDER BY id DESC").all()
      : db.prepare("SELECT * FROM experiments WHERE project_id = ? ORDER BY id DESC").all(projectId)
  ) as ExperimentRow[];
  return rows.map(rowToExperiment);
}

export function observationsFor(experimentId: number): ObservationPoint[] {
  return (
    getDb()
      .prepare("SELECT * FROM experiment_observations WHERE experiment_id = ? ORDER BY position ASC")
      .all(experimentId) as ObservationRow[]
  ).map(rowToObservation);
}

export function enrolledTargets(experimentId: number): number[] {
  return (
    getDb()
      .prepare("SELECT target_id FROM experiment_deliveries WHERE experiment_id = ? ORDER BY target_id ASC")
      .all(experimentId) as { target_id: number }[]
  ).map((row) => row.target_id);
}

export interface ScheduledObservation {
  observationId: number;
  targetId: number;
  orderId: number;
  dueAt: string;
}

export function scheduledFor(experimentId: number): ScheduledObservation[] {
  return (
    getDb()
      .prepare(
        "SELECT observation_id, target_id, order_id, due_at FROM observation_orders WHERE experiment_id = ? ORDER BY due_at ASC, id ASC"
      )
      .all(experimentId) as {
      observation_id: number;
      target_id: number;
      order_id: number;
      due_at: string;
    }[]
  ).map((row) => ({
    observationId: row.observation_id,
    targetId: row.target_id,
    orderId: row.order_id,
    dueAt: row.due_at,
  }));
}

// ---------------------------------------------------------------------------
// Predeclaration

const observationSchema = z.object({
  label: z.string().min(1).max(120),
  afterHours: z.number().int().min(0).max(24 * 90),
  metrics: z.array(z.string().min(1)).min(1).max(20),
  source: z.string().min(1).max(300),
});

export const declareExperimentSchema = z.object({
  projectId: z.number().int(),
  name: z.string().min(1).max(160),
  variable: z.string().min(1).max(300),
  primaryMetric: z.string().min(1).max(120),
  decisionRule: z.string().min(1).max(1000),
  sampleTarget: z.number().int().min(1).max(1_000_000),
  stopCondition: z.string().min(1).max(1000),
  observations: z.array(observationSchema).min(1).max(12),
});

/** What a full predeclaration has to name, said the way a person would ask. */
const DECLARATION_PARTS: Record<string, string> = {
  name: "a name",
  variable: "the one variable being changed",
  primaryMetric: "the primary metric",
  decisionRule: "the rule that will decide it",
  sampleTarget: "the sample it needs",
  stopCondition: "the condition that stops it",
  observations: "at least one observation point",
};

/**
 * Declare an experiment, whole. Anything missing refuses the whole thing
 * and names every gap at once, because a half-declared experiment saved for
 * later is precisely the failure predeclaration exists to prevent.
 */
export function declareExperiment(input: unknown, actor = "operator"): Experiment {
  const parsed = declareExperimentSchema.safeParse(input);
  if (!parsed.success) {
    const missing = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const field = String(issue.path[0] ?? "");
          return DECLARATION_PARTS[field] ?? `${issue.path.join(".") || "(root)"}: ${issue.message}`;
        })
      ),
    ];
    throw new ExperimentError(
      400,
      "An experiment is declared in full before any work ships, or not at all. This one is missing: " +
        missing.join("; ") +
        ".",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const spec = parsed.data;

  const db = getDb();
  const experiment = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO experiments
          (project_id, name, variable, primary_metric, decision_rule, sample_target,
           stop_condition, declared_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        spec.projectId,
        spec.name,
        spec.variable,
        spec.primaryMetric,
        spec.decisionRule,
        spec.sampleTarget,
        spec.stopCondition,
        actor
      );
    const id = Number(info.lastInsertRowid);
    // The observation points go in with the declaration, in one
    // transaction: an experiment that exists without its schedule would be
    // an experiment that could still be given one after the fact.
    spec.observations.forEach((point, index) => {
      db.prepare(
        "INSERT INTO experiment_observations (experiment_id, position, label, after_hours, metrics, source) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, index, point.label, point.afterHours, JSON.stringify(point.metrics), point.source);
    });
    return id;
  })();

  const declared = getExperimentById(experiment);
  if (!declared) throw new Error("experiment did not persist");
  audit(actor, "experiments.declared", {
    experimentId: declared.id,
    projectId: declared.projectId,
    variable: declared.variable,
    primaryMetric: declared.primaryMetric,
    observations: spec.observations.length,
  });
  return declared;
}

function setStatus(experimentId: number, status: ExperimentStatus, actor: string): Experiment {
  getDb()
    .prepare(
      "UPDATE experiments SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    )
    .run(status, experimentId);
  const experiment = getExperimentById(experimentId);
  if (!experiment) throw new ExperimentError(404, `No experiment #${experimentId}`);
  audit(actor, "experiments.status", { experimentId, status });
  return experiment;
}

export function stopExperiment(experimentId: number, actor = "operator"): Experiment {
  const experiment = getExperimentById(experimentId);
  if (!experiment) throw new ExperimentError(404, `No experiment #${experimentId}`);
  if (experiment.status === "concluded") {
    throw new ExperimentError(409, `Experiment #${experimentId} is already concluded.`);
  }
  return setStatus(experimentId, "stopped", actor);
}

// There is deliberately no plain `conclude` here. An experiment reaches
// `concluded` only through the decision record of ticket 25, which is what
// holds it to the sample and stop condition it predeclared. A status setter
// that skipped that would make every one of those guarantees optional.

// ---------------------------------------------------------------------------
// Enrolment and scheduling

/**
 * Put a delivery under this experiment's watch. A delivery already verified
 * schedules its observations immediately — enrolling late should not lose
 * the readings, and the unique index means it cannot double them either.
 */
export function enrollDelivery(
  experimentId: number,
  targetId: number,
  actor = "operator"
): { experiment: Experiment; scheduled: ScheduledObservation[] } {
  const experiment = getExperimentById(experimentId);
  if (!experiment) throw new ExperimentError(404, `No experiment #${experimentId}`);
  if (experiment.status === "concluded" || experiment.status === "stopped") {
    throw new ExperimentError(
      409,
      `Experiment #${experimentId} is ${experiment.status} and takes on no further deliveries.`
    );
  }
  const target = getTargetById(targetId);
  if (!target) throw new ExperimentError(404, `No Delivery Target #${targetId}`);
  const release = getReleaseById(target.releaseId);
  if (release && release.projectId !== experiment.projectId) {
    throw new ExperimentError(
      409,
      `Delivery #${targetId} belongs to another Connected Project than this experiment.`
    );
  }

  getDb()
    .prepare(
      "INSERT OR IGNORE INTO experiment_deliveries (experiment_id, target_id) VALUES (?, ?)"
    )
    .run(experimentId, targetId);
  audit(actor, "experiments.enrolled", { experimentId, targetId });

  const running =
    experiment.status === "predeclared" ? setStatus(experimentId, "running", actor) : experiment;
  return { experiment: running, scheduled: scheduleObservations(targetId, actor) };
}

/**
 * Turn every observation point into a measure Work Order for one verified
 * delivery. Idempotent by (observation, delivery), so it can be called
 * again — on verification, on late enrolment, or by the sweep below —
 * without ever booking a person twice for the same reading.
 *
 * A delivery that is not verified posted schedules nothing: there is
 * nothing published yet to read numbers off.
 */
export function scheduleObservations(targetId: number, actor = "operator"): ScheduledObservation[] {
  const target = getTargetById(targetId);
  if (!target || target.status !== "verified_posted") return [];

  const experiments = (
    getDb()
      .prepare("SELECT experiment_id FROM experiment_deliveries WHERE target_id = ?")
      .all(targetId) as { experiment_id: number }[]
  ).map((row) => row.experiment_id);

  const made: ScheduledObservation[] = [];
  for (const experimentId of experiments) {
    const experiment = getExperimentById(experimentId);
    if (!experiment || experiment.status === "concluded") continue;
    for (const point of observationsFor(experimentId)) {
      const existing = getDb()
        .prepare(
          "SELECT observation_id, target_id, order_id, due_at FROM observation_orders WHERE observation_id = ? AND target_id = ?"
        )
        .get(point.id, targetId) as
        | { observation_id: number; target_id: number; order_id: number; due_at: string }
        | undefined;
      if (existing) continue;

      const dueAt = new Date(
        new Date(target.updatedAt).getTime() + point.afterHours * 3600 * 1000
      ).toISOString();
      const order = measureOrderFor(experiment, point, target, dueAt, actor);
      getDb()
        .prepare(
          "INSERT INTO observation_orders (experiment_id, observation_id, target_id, order_id, due_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(experimentId, point.id, targetId, order.id, dueAt);
      audit(actor, "experiments.observation_scheduled", {
        experimentId,
        observationId: point.id,
        targetId,
        orderId: order.id,
        dueAt,
      });
      made.push({ observationId: point.id, targetId, orderId: order.id, dueAt });
    }
  }
  return made;
}

/**
 * The order a person actually works from: exactly which numbers, from
 * exactly where, for exactly which post. A measure order that leaves any of
 * those to the reader is how two readings stop being comparable.
 */
function measureOrderFor(
  experiment: Experiment,
  point: ObservationPoint,
  target: DeliveryTarget,
  dueAt: string,
  actor: string
): WorkOrder {
  const draft = createOrder(
    {
      projectId: experiment.projectId,
      slotId: target.slotId,
      instanceId: target.instanceId,
      kind: "measure",
      title: `${point.label} — "${experiment.name}"`,
      instruction:
        `Read ${point.metrics.join(", ")} from ${point.source} for ${target.permalink ?? `delivery #${target.id}`}, ` +
        `${point.afterHours} hours after it went up (due ${dueAt}). ` +
        `This is observation point ${point.position + 1} of the experiment "${experiment.name}", ` +
        `whose primary metric is ${experiment.primaryMetric}. Read the numbers as they stand; the decision rule is already fixed.`,
      proofRequirement: `The value of each of ${point.metrics.join(", ")}, and the time you read them.`,
      observationId: point.id,
    },
    actor
  );
  submitOrder(draft.id, actor);
  return approveOrder(draft.id, actor);
}

/**
 * Verify a delivery and schedule what its verification earned, in one act.
 * Keeping the two together is what makes "without manual scheduling" true:
 * there is no moment at which a verified delivery exists with its readings
 * still waiting for someone to remember them.
 */
export function verifyAndObserve(
  targetId: number,
  actor = "operator"
): { target: DeliveryTarget; scheduled: ScheduledObservation[] } {
  const target = verifyPosted(targetId, actor);
  return { target, scheduled: scheduleObservations(targetId, actor) };
}

/**
 * The safety net. Every verified delivery under a live experiment, checked
 * for readings that were never scheduled — so the guarantee does not rest
 * on one call site having been used.
 */
export function scheduleOutstandingObservations(actor = "operator"): ScheduledObservation[] {
  const targets = (
    getDb()
      .prepare(
        `SELECT DISTINCT d.target_id AS id
           FROM experiment_deliveries d
           JOIN delivery_targets t ON t.id = d.target_id
          WHERE t.status = 'verified_posted'`
      )
      .all() as { id: number }[]
  ).map((row) => row.id);
  return targets.flatMap((targetId) => scheduleObservations(targetId, actor));
}

// ---------------------------------------------------------------------------
// Ad-hoc measurement
//
// Still possible, and never mistaken for planned work. A measure order with
// no observation point behind it is unscheduled, and says so.

export const adHocSchema = z.object({
  projectId: z.number().int(),
  title: z.string().min(1).max(160),
  instruction: z.string().min(1).max(2000),
  slotId: z.number().int().optional(),
});

export function measureAdHoc(input: unknown, actor = "operator"): WorkOrder {
  const parsed = adHocSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExperimentError(
      400,
      "An ad-hoc reading still names the project, what to read, and where.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const draft = createOrder(
    {
      ...parsed.data,
      kind: "measure",
      // No observationId: nobody planned this, and the order will say so.
      proofRequirement: "The numbers you read, where you read them, and when.",
    },
    actor
  );
  submitOrder(draft.id, actor);
  return approveOrder(draft.id, actor);
}

// ---------------------------------------------------------------------------
// The shape every surface sees

export function experimentView(experiment: Experiment): Record<string, unknown> {
  const scheduled = scheduledFor(experiment.id);
  return {
    id: experiment.id,
    projectId: experiment.projectId,
    name: experiment.name,
    // The declaration, whole, exactly as it was fixed.
    declaration: {
      variable: experiment.variable,
      primaryMetric: experiment.primaryMetric,
      decisionRule: experiment.decisionRule,
      sampleTarget: experiment.sampleTarget,
      stopCondition: experiment.stopCondition,
      declaredBy: experiment.declaredBy,
      declaredAt: experiment.createdAt,
    },
    observations: observationsFor(experiment.id),
    status: experiment.status,
    enrolledTargets: enrolledTargets(experiment.id),
    scheduledObservations: scheduled,
    sampleProgress: { target: experiment.sampleTarget, enrolled: enrolledTargets(experiment.id).length },
    updatedAt: experiment.updatedAt,
    note: "The declaration was fixed before any work shipped and cannot be edited. Readings are scheduled from the observation points, not chosen after the numbers came in.",
  };
}
