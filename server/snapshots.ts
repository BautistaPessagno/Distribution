// Metric Snapshots (ticket 24; decisions:
// .scratch/marketing-os/issues/13-define-measurement-learning-loop.md).
//
// Two observation sources, and every snapshot says which one it was.
//
//   A person reading numbers off a platform, through a measure Work Order.
//   The order already names which numbers from where; completing it is what
//   files them.
//
//   A product-funnel read from the Connected Project's own metrics
//   capability. These carry the project's snapshot id and version, so a
//   number here can always be traced back to the exact project state it
//   came out of. A project with no funnel is a project with no funnel; the
//   read is refused as unsupported rather than filled in with a guess.
//
// Nothing is ever overwritten. A second observation of the same metric is
// another row — two readings an hour apart are two facts, and collapsing
// them into one would destroy the only thing that makes a series a series.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import { getTargetById } from "./deliveries";
import { getExperimentById, observationsFor } from "./experiments";
import { log } from "./log";
import { requireHealthyProject, projectServiceToken } from "./projects";
import type { MetricsBundle } from "./project-domain-sdk";
import {
  completeOrder,
  currentAttempt,
  getOrderById,
  requireCompletable,
  type WorkOrder,
} from "./work-orders";

export const SNAPSHOT_SOURCES = ["operator_reading", "project_funnel"] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

export interface MetricSnapshot {
  id: number;
  projectId: number;
  source: SnapshotSource;
  collectionMethod: string;
  metric: string;
  value: number;
  unit: string | null;
  targetId: number | null;
  experimentId: number | null;
  observationId: number | null;
  orderId: number | null;
  /** The project's own name for the state a funnel read came out of. */
  projectSnapshotId: string | null;
  projectSnapshotVersion: number | null;
  /** When the numbers were true, which is not when we wrote them down. */
  observedAt: string;
  recordedBy: string;
  recordedAt: string;
}

export class SnapshotError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

interface SnapshotRow {
  id: number;
  project_id: number;
  source: SnapshotSource;
  collection_method: string;
  metric: string;
  value: number;
  unit: string | null;
  target_id: number | null;
  experiment_id: number | null;
  observation_id: number | null;
  order_id: number | null;
  project_snapshot_id: string | null;
  project_snapshot_version: number | null;
  observed_at: string;
  recorded_by: string;
  recorded_at: string;
}

function rowToSnapshot(row: SnapshotRow): MetricSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    collectionMethod: row.collection_method,
    metric: row.metric,
    value: row.value,
    unit: row.unit,
    targetId: row.target_id,
    experimentId: row.experiment_id,
    observationId: row.observation_id,
    orderId: row.order_id,
    projectSnapshotId: row.project_snapshot_id,
    projectSnapshotVersion: row.project_snapshot_version,
    observedAt: row.observed_at,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

export function listSnapshots(
  filter: { projectId?: number; targetId?: number; experimentId?: number; metric?: string } = {}
): MetricSnapshot[] {
  const where: string[] = [];
  const args: (number | string)[] = [];
  for (const [column, value] of [
    ["project_id", filter.projectId],
    ["target_id", filter.targetId],
    ["experiment_id", filter.experimentId],
    ["metric", filter.metric],
  ] as const) {
    if (value !== undefined) {
      where.push(`${column} = ?`);
      args.push(value);
    }
  }
  const sql = `SELECT * FROM metric_snapshots ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at ASC, id ASC`;
  return (getDb().prepare(sql).all(...args) as SnapshotRow[]).map(rowToSnapshot);
}

/**
 * Every reading of one metric for one delivery, oldest first. This is the
 * shape the append-only rule exists to make possible: a series, not a
 * current value.
 */
export function seriesFor(targetId: number, metric: string): MetricSnapshot[] {
  return listSnapshots({ targetId, metric });
}

// ---------------------------------------------------------------------------
// Writing

interface SnapshotInsert {
  projectId: number;
  source: SnapshotSource;
  collectionMethod: string;
  metric: string;
  value: number;
  unit?: string | null;
  targetId?: number | null;
  experimentId?: number | null;
  observationId?: number | null;
  orderId?: number | null;
  projectSnapshotId?: string | null;
  projectSnapshotVersion?: number | null;
  observedAt: string;
}

function insertSnapshot(spec: SnapshotInsert, actor: string): MetricSnapshot {
  const info = getDb()
    .prepare(
      `INSERT INTO metric_snapshots
        (project_id, source, collection_method, metric, value, unit, target_id,
         experiment_id, observation_id, order_id, project_snapshot_id,
         project_snapshot_version, observed_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      spec.projectId,
      spec.source,
      spec.collectionMethod,
      spec.metric,
      spec.value,
      spec.unit ?? null,
      spec.targetId ?? null,
      spec.experimentId ?? null,
      spec.observationId ?? null,
      spec.orderId ?? null,
      spec.projectSnapshotId ?? null,
      spec.projectSnapshotVersion ?? null,
      spec.observedAt,
      actor
    );
  const row = getDb().prepare("SELECT * FROM metric_snapshots WHERE id = ?").get(
    Number(info.lastInsertRowid)
  ) as SnapshotRow | undefined;
  if (!row) throw new Error("metric snapshot did not persist");
  return rowToSnapshot(row);
}

// ---------------------------------------------------------------------------
// Source one: a person, through a measure Work Order

const readingSchema = z.object({
  metric: z.string().min(1).max(80),
  value: z.number().finite(),
  unit: z.string().min(1).max(40).optional(),
});

export const recordReadingsSchema = z.object({
  orderId: z.number().int(),
  readings: z.array(readingSchema).min(1).max(40),
  /** When the numbers were true. Defaults to now, which is usually right. */
  observedAt: z.string().min(1).optional(),
});

/**
 * File the numbers a person read. The Work Order is what ties them to a
 * delivery and, through it, to the experiment that asked — so nothing here
 * has to be told twice where it belongs.
 *
 * The order must have carried its proof already: the numbers and the record
 * of having read them are the same act, and filing values against an
 * attempt with no proof would be recording a reading nobody did.
 */
export function recordReadings(input: unknown, actor = "operator"): MetricSnapshot[] {
  const parsed = recordReadingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new SnapshotError(
      400,
      "A reading names the measure order and at least one metric with its value.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }
  const { orderId, readings } = parsed.data;

  const order = getOrderById(orderId);
  if (!order) throw new SnapshotError(404, `No Work Order #${orderId}`);
  if (order.kind !== "measure") {
    throw new SnapshotError(
      409,
      `Work Order #${orderId} is a ${order.kind} order. Readings are filed against a measure order.`
    );
  }
  const attempt = currentAttempt(orderId);
  if (!attempt?.proof) {
    throw new SnapshotError(
      409,
      `Work Order #${orderId} carries no proof yet. The numbers and the record of having read them are one act.`
    );
  }

  const observedAt = parsed.data.observedAt ?? attempt.proof.submittedAt;
  const placement = placementOf(order);

  const snapshots = readings.map((reading) =>
    insertSnapshot(
      {
        projectId: order.projectId,
        source: "operator_reading",
        collectionMethod: `Read by hand and filed against Work Order #${order.id} (${order.title}).`,
        metric: reading.metric,
        value: reading.value,
        unit: reading.unit ?? null,
        orderId: order.id,
        observedAt,
        ...placement,
      },
      actor
    )
  );

  audit(actor, "snapshots.recorded", {
    orderId,
    source: "operator_reading",
    metrics: readings.map((r) => r.metric),
    targetId: placement.targetId ?? null,
    experimentId: placement.experimentId ?? null,
  });
  return snapshots;
}

/**
 * Where a measure order's readings belong. A scheduled order came from an
 * observation point, which names the experiment and the delivery; an ad-hoc
 * one belongs nowhere in particular, and saying so is more honest than
 * attaching it to whatever was nearby.
 */
function placementOf(order: WorkOrder): {
  targetId: number | null;
  experimentId: number | null;
  observationId: number | null;
} {
  if (order.observationId === null) {
    return { targetId: null, experimentId: null, observationId: null };
  }
  const row = getDb()
    .prepare(
      "SELECT experiment_id, target_id FROM observation_orders WHERE order_id = ? LIMIT 1"
    )
    .get(order.id) as { experiment_id: number; target_id: number } | undefined;
  return {
    targetId: row?.target_id ?? null,
    experimentId: row?.experiment_id ?? null,
    observationId: order.observationId,
  };
}

// ---------------------------------------------------------------------------
// Source two: the project's own product funnel

function isMetricsBundle(body: unknown): body is MetricsBundle {
  if (typeof body !== "object" || body === null) return false;
  const bundle = body as Partial<MetricsBundle>;
  return (
    typeof bundle.snapshotId === "string" &&
    typeof bundle.version === "number" &&
    typeof bundle.observedAt === "string" &&
    typeof bundle.collectionMethod === "string" &&
    Array.isArray(bundle.metrics) &&
    bundle.metrics.every(
      (m) => typeof m?.name === "string" && typeof m?.value === "number"
    )
  );
}

export interface FunnelReadOutcome {
  snapshots: MetricSnapshot[];
  provenance: { snapshotId: string; version: number; collectionMethod: string; observedAt: string };
}

/**
 * Read the project's product funnel and file what it says. The numbers
 * matter less than where they came from: the project's own snapshot id and
 * version go on every row, so a funnel reading can always be traced back to
 * the exact project state that produced it.
 *
 * A project with no funnel is refused as unsupported. Nothing is invented,
 * and nothing is filed under a provenance that does not exist.
 */
export async function readProjectFunnel(
  projectId: number,
  actor = "operator"
): Promise<FunnelReadOutcome> {
  const project = requireHealthyProject(projectId);
  const token = await projectServiceToken(projectId, actor);
  const url = `${project.baseUrl.replace(/\/+$/, "")}/capabilities/metrics`;

  let status: number;
  let body: unknown;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    log("error", "project funnel read failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new SnapshotError(
      503,
      `"${project.name}" could not be reached for a funnel read. Record the observation by hand instead, and it will say it was read by hand.`
    );
  }

  if (status === 404) {
    throw new SnapshotError(
      404,
      `"${project.name}" publishes no product funnel. That is a fact about the project, not a gap to fill in.`
    );
  }
  if (status !== 200 || !isMetricsBundle(body)) {
    throw new SnapshotError(
      502,
      `"${project.name}" answered the funnel read with something this contract does not recognise.`
    );
  }

  const bundle = body;
  const snapshots = bundle.metrics.map((metric) =>
    insertSnapshot(
      {
        projectId,
        source: "project_funnel",
        collectionMethod: bundle.collectionMethod,
        metric: metric.name,
        value: metric.value,
        unit: metric.unit ?? null,
        projectSnapshotId: bundle.snapshotId,
        projectSnapshotVersion: bundle.version,
        observedAt: bundle.observedAt,
      },
      actor
    )
  );

  audit(actor, "snapshots.funnel_read", {
    projectId,
    source: "project_funnel",
    projectSnapshotId: bundle.snapshotId,
    projectSnapshotVersion: bundle.version,
    metrics: bundle.metrics.map((m) => m.name),
  });

  return {
    snapshots,
    provenance: {
      snapshotId: bundle.snapshotId,
      version: bundle.version,
      collectionMethod: bundle.collectionMethod,
      observedAt: bundle.observedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// The shape every surface sees

export function snapshotView(snapshot: MetricSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    metric: snapshot.metric,
    value: snapshot.value,
    unit: snapshot.unit,
    // The three things every observation carries, said in one place.
    source: snapshot.source,
    sourceLabel:
      snapshot.source === "operator_reading"
        ? "read by hand"
        : "read from the project's product funnel",
    collectionMethod: snapshot.collectionMethod,
    observedAt: snapshot.observedAt,
    provenance:
      snapshot.source === "project_funnel"
        ? {
            projectSnapshotId: snapshot.projectSnapshotId,
            projectSnapshotVersion: snapshot.projectSnapshotVersion,
          }
        : { orderId: snapshot.orderId },
    targetId: snapshot.targetId,
    experimentId: snapshot.experimentId,
    observationId: snapshot.observationId,
    recordedBy: snapshot.recordedBy,
    recordedAt: snapshot.recordedAt,
    note: "Observations are never overwritten. A further reading of the same metric is another row, because two readings are two facts.",
  };
}

/**
 * What an experiment has actually collected, per metric, oldest first. The
 * primary metric is named separately because it is the one the decision
 * rule was fixed against, and burying it among the others would make the
 * declaration harder to hold the result to.
 */
export function experimentEvidence(experimentId: number): Record<string, unknown> {
  const experiment = getExperimentById(experimentId);
  if (!experiment) throw new SnapshotError(404, `No experiment #${experimentId}`);
  const snapshots = listSnapshots({ experimentId });
  const byMetric = new Map<string, MetricSnapshot[]>();
  for (const snapshot of snapshots) {
    const series = byMetric.get(snapshot.metric) ?? [];
    series.push(snapshot);
    byMetric.set(snapshot.metric, series);
  }
  return {
    experimentId,
    primaryMetric: experiment.primaryMetric,
    decisionRule: experiment.decisionRule,
    observations: observationsFor(experimentId).map((point) => ({
      id: point.id,
      label: point.label,
      metrics: point.metrics,
      collected: snapshots.filter((s) => s.observationId === point.id).length,
    })),
    series: [...byMetric.entries()].map(([metric, readings]) => ({
      metric,
      isPrimary: metric === experiment.primaryMetric,
      readings: readings.map(snapshotView),
    })),
    note: "Every reading here is a row that was appended, never an updated total.",
  };
}

/** A reading that belongs to a delivery, whichever source it came from. */
export function deliveryEvidence(targetId: number): Record<string, unknown> {
  const target = getTargetById(targetId);
  if (!target) throw new SnapshotError(404, `No Delivery Target #${targetId}`);
  return {
    targetId,
    permalink: target.permalink,
    readings: listSnapshots({ targetId }).map(snapshotView),
  };
}

// ---------------------------------------------------------------------------
// Completion and the snapshot are one act
//
// A measure order that completed without its numbers landing would be a
// person having done the work and the system having lost it. So the two
// happen together, in one database transaction, or neither happens.

export interface MeasureCompletion {
  order: WorkOrder;
  snapshots: MetricSnapshot[];
}

export function completeMeasureOrder(
  orderId: number,
  readings: unknown,
  note = "",
  actor = "operator"
): MeasureCompletion {
  const order = getOrderById(orderId);
  if (!order) throw new SnapshotError(404, `No Work Order #${orderId}`);
  if (order.kind !== "measure") {
    throw new SnapshotError(
      409,
      `Work Order #${orderId} is a ${order.kind} order. Only a measure order files readings on completion.`
    );
  }

  // The order has to be completable before its numbers are anyone's
  // problem: "you gave me no readings" is the wrong complaint about an
  // order that was never at the point of completing.
  requireCompletable(orderId);

  const db = getDb();
  return db.transaction(() => {
    const snapshots = recordReadings({ orderId, readings }, actor);
    const outcome = completeOrder(orderId, note, actor);
    return { order: outcome.order, snapshots };
  })();
}
