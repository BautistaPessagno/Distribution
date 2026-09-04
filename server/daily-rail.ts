// The daily guided rail (ticket 27; decisions:
// docs/issues/marketing-os/issues/07-choose-dashboard-first-use-loop.md and
// docs/issues/marketing-os/issues/12-define-account-operations-workflow.md).
//
// One step at a time, composed from what is actually due. The rail is not a
// plan for the day; it is the day's real queue, ordered, with everything
// but the current item held back.
//
// Two rules give it its shape.
//
//   An empty day says so. The rail never invents work to look busy — a
//   made-up step is worse than a blank screen, because a person will do it.
//
//   Every step hands over exactly one copyable prompt or one plain
//   instruction. Not both, and never a list. A step that needs two things
//   done is two steps.
//
// A pending digest is not a step. A host proposing a write is an
// interruption someone else caused, and numbering it among the day's work
// would file it as something the Operator planned. It sits outside the
// rail, explicitly, and the rail is exactly where it was afterwards.

import { getDb } from "./db";
import { listTargets, type DeliveryTarget } from "./deliveries";
import { getExperimentById, observationsFor, type Experiment } from "./experiments";
import { METHOD_LIBRARY_VERSION, METHODS } from "./methods";
import { listPreparedChangeSets } from "./project-changes";
import { listProjects } from "./projects";
import { releaseGate } from "./release-gate";
import { listOrders, orderCard, type WorkOrder } from "./work-orders";

export const STEP_KINDS = ["send_brief", "review_draft", "do_work_order", "record_reading"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface RailStep {
  position: number;
  kind: StepKind;
  title: string;
  /**
   * Exactly one of these is set. A step is one copyable prompt or one plain
   * instruction, never both and never a list.
   */
  prompt: string | null;
  instruction: string | null;
  /** Where the one action happens. */
  href: string;
  /** What this step is about, so the rail is auditable against real state. */
  subject: { kind: string; id: number | null };
  /** For work that carries proof: what will count as having done it. */
  proofRequirement: string | null;
}

export interface Interruption {
  digest: string;
  projectName: string;
  summary: string;
  operations: number;
  href: string;
  why: string;
}

export interface DailyRail {
  steps: RailStep[];
  current: RailStep | null;
  /**
   * Outside the rail and deliberately unnumbered: a host proposed a write
   * and is waiting on a person.
   */
  interruptions: Interruption[];
  emptyMessage: string | null;
  note: string;
}

// ---------------------------------------------------------------------------
// The brief
//
// Composed from live state every time it is read: the method for the goal,
// the project's pinned snapshot, and whatever experiments are actually
// open. Canned text would be the one thing on this screen a person could
// safely ignore.

export interface BriefContext {
  projectId: number;
  projectName: string;
  snapshotId: string | null;
  goal: string;
  openExperiments: Experiment[];
}

export function composeBrief(context: BriefContext): string {
  const method = METHODS[context.goal];
  const lines: string[] = [
    `Working on ${context.projectName}.`,
    "",
    `Goal: ${context.goal}. Method ${method ? `${method.capability} v${method.version}, rubric ${method.rubric}` : "not in the library"} (library ${METHOD_LIBRARY_VERSION}).`,
  ];

  if (method) {
    lines.push("", "Steps this method asks for:");
    method.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    lines.push(
      "",
      `Read from: ${method.evidenceInputs.join(", ")}. Produce: ${method.expectedArtifact}.`,
      `Approval gate: ${method.approvalGates.join(" ")}`
    );
  }

  lines.push(
    "",
    context.snapshotId
      ? `Work against the pinned Project Snapshot ${context.snapshotId}. Call marketingos.onboard first if you have not this session.`
      : "No Project Snapshot is pinned yet. Call marketingos.select_project, then marketingos.onboard."
  );

  if (context.openExperiments.length > 0) {
    lines.push("", "Experiments already running, whose declarations are fixed:");
    for (const experiment of context.openExperiments) {
      lines.push(
        `  - "${experiment.name}": varying ${experiment.variable}; primary metric ${experiment.primaryMetric}; ${experiment.sampleTarget} posts; stops when ${experiment.stopCondition}`
      );
    }
    lines.push(
      "",
      "Do not restate or reinterpret those declarations. If this work belongs to one of them, say which."
    );
  } else {
    lines.push("", "No experiment is running. If this work is worth measuring, declare one first.");
  }

  lines.push(
    "",
    "Propose writes as Project Change Sets. You never apply one; the diff comes to me and I approve it."
  );
  return lines.join("\n");
}

function openExperimentsFor(projectId: number): Experiment[] {
  const ids = (
    getDb()
      .prepare(
        "SELECT id FROM experiments WHERE project_id = ? AND status IN ('predeclared', 'running') ORDER BY id ASC"
      )
      .all(projectId) as { id: number }[]
  ).map((row) => row.id);
  return ids.flatMap((id) => {
    const experiment = getExperimentById(id);
    return experiment ? [experiment] : [];
  });
}

/** The snapshot the project is currently pinned to, if any host pinned one. */
function pinnedSnapshotFor(projectId: number): string | null {
  const row = getDb()
    .prepare(
      "SELECT snapshot FROM pieces WHERE project_id = ? AND snapshot IS NOT NULL ORDER BY id DESC LIMIT 1"
    )
    .get(projectId) as { snapshot: string } | undefined;
  return row?.snapshot ?? null;
}

// ---------------------------------------------------------------------------
// What is actually due

interface DraftInReview {
  id: number;
  title: string;
  projectId: number;
}

function draftsInReview(): DraftInReview[] {
  return (
    getDb()
      .prepare(
        "SELECT id, title, project_id AS projectId FROM pieces WHERE status = 'review' ORDER BY id ASC"
      )
      .all() as DraftInReview[]
  );
}

/**
 * Platform work a person could pick up right now. An order behind a shut
 * queue is not due: putting it on the rail would be handing out work the
 * caps and windows just refused.
 */
function dueWorkOrders(now: Date): WorkOrder[] {
  return listOrders()
    .filter((order) => order.kind !== "measure")
    .filter((order) => ["queued", "claimed", "in_progress"].includes(order.status))
    .filter((order) => releaseGate(order, now).open);
}

export interface DueReading {
  order: WorkOrder;
  dueAt: string | null;
  experimentName: string | null;
  observationLabel: string | null;
}

/**
 * Readings that have come due. A scheduled one is due at the moment its
 * observation point declared and not before — reading early is reading a
 * different thing.
 */
function dueReadings(now: Date): DueReading[] {
  const scheduled = new Map(
    (
      getDb()
        .prepare(
          "SELECT order_id, due_at, experiment_id, observation_id FROM observation_orders"
        )
        .all() as {
        order_id: number;
        due_at: string;
        experiment_id: number;
        observation_id: number;
      }[]
    ).map((row) => [row.order_id, row])
  );

  return listOrders()
    .filter((order) => order.kind === "measure")
    .filter((order) => ["queued", "claimed", "in_progress"].includes(order.status))
    .flatMap((order): DueReading[] => {
      const booking = scheduled.get(order.id);
      if (!booking) {
        // An ad-hoc reading has no declared moment, so it is due whenever
        // the Operator made it.
        return [{ order, dueAt: null, experimentName: null, observationLabel: null }];
      }
      if (new Date(booking.due_at).getTime() > now.getTime()) return [];
      const experiment = getExperimentById(booking.experiment_id);
      const point = experiment
        ? observationsFor(experiment.id).find((p) => p.id === booking.observation_id)
        : undefined;
      return [
        {
          order,
          dueAt: booking.due_at,
          experimentName: experiment?.name ?? null,
          observationLabel: point?.label ?? null,
        },
      ];
    })
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

/** Deliveries waiting on a person, so a post order is never orphaned on the rail. */
function releasedDeliveries(): Map<number, DeliveryTarget> {
  return new Map(
    listTargets()
      .filter((t) => t.workOrderId !== null)
      .map((t) => [t.workOrderId as number, t])
  );
}

// ---------------------------------------------------------------------------
// The rail

export function dailyRail(goal = "positioning", now = new Date()): DailyRail {
  const steps: RailStep[] = [];
  const push = (step: Omit<RailStep, "position">): void => {
    steps.push({ ...step, position: steps.length + 1 });
  };

  // 1. Today's brief, once, and only where there is a project to brief about.
  const project = listProjects().find((p) => p.status === "healthy");
  if (project) {
    push({
      kind: "send_brief",
      title: `Send today's brief for ${project.name}`,
      prompt: composeBrief({
        projectId: project.id,
        projectName: project.name,
        snapshotId: pinnedSnapshotFor(project.id),
        goal,
        openExperiments: openExperimentsFor(project.id),
      }),
      instruction: null,
      href: "/studio",
      subject: { kind: "project", id: project.id },
      proofRequirement: null,
    });
  }

  // 2. Drafts that came back and are waiting on a person to read them.
  for (const draft of draftsInReview()) {
    push({
      kind: "review_draft",
      title: `Review "${draft.title}"`,
      prompt: null,
      instruction: `Read "${draft.title}" as it renders through the Brand Kit, then approve it or send it back with what needs to change.`,
      href: "/studio",
      subject: { kind: "piece", id: draft.id },
      proofRequirement: null,
    });
  }

  // 3. Platform work: warm-up, posting, provisioning. One instruction each,
  //    taken straight from the order's own card.
  const deliveries = releasedDeliveries();
  for (const order of dueWorkOrders(now)) {
    const card = orderCard(order);
    const delivery = deliveries.get(order.id);
    push({
      kind: "do_work_order",
      title: card.title,
      prompt: null,
      instruction: delivery
        ? `${card.instruction} Post between ${delivery.window.start} and ${delivery.window.end}.`
        : card.instruction,
      href: "/operations",
      subject: { kind: "work_order", id: order.id },
      proofRequirement: card.proofField.placeholder,
    });
  }

  // 4. Readings that have come due, at the moment they were declared for.
  for (const due of dueReadings(now)) {
    const card = orderCard(due.order);
    push({
      kind: "record_reading",
      title: due.experimentName
        ? `${due.observationLabel ?? "Reading"} — "${due.experimentName}"`
        : card.title,
      prompt: null,
      instruction: card.instruction,
      href: "/operations",
      subject: { kind: "work_order", id: due.order.id },
      proofRequirement: card.proofField.placeholder,
    });
  }

  return {
    steps,
    current: steps[0] ?? null,
    interruptions: pendingInterruptions(),
    emptyMessage:
      steps.length === 0
        ? "Nothing is due. No brief to send, no draft waiting, no work released, and no reading come due. This is what an empty day looks like; there is nothing here to invent."
        : null,
    note: "One step at a time, from what is actually due. Every step is one copyable prompt or one plain instruction.",
  };
}

/**
 * Pending digests, outside the numbered steps. A host proposing a write is
 * something that happened to the Operator, not something they planned, and
 * numbering it among the day's work would file it as the latter.
 */
export function pendingInterruptions(): Interruption[] {
  const names = new Map(listProjects().map((p) => [p.id, p.name]));
  return listPreparedChangeSets("pending").map((change) => ({
    digest: change.digest,
    projectName: names.get(change.projectId) ?? `project #${change.projectId}`,
    summary: change.summary,
    operations: change.changeSet.operations.length,
    href: "/operations",
    why: "A host proposed this write and is waiting. Read the diff and decide; the rail is exactly where you left it afterwards.",
  }));
}
