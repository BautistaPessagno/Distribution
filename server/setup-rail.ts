// The first-run setup rail (ticket 26; reference behavior: the approved
// dashboard prototype in docs/issues/marketing-os/prototypes/).
//
// Three steps, one on screen at a time, each one action. The rail's whole
// job is to stop a first run from being a survey of everything at once, so
// its shape is the feature: what it does not show is as deliberate as what
// it does.
//
// Setup never applies a change to a Connected Project. Not once, not as a
// side effect of connecting one. A first run that silently wrote to
// someone's site would poison the only thing this system has to offer,
// which is that a person approved the exact diff. Every step declares this
// about itself, the done screen says it in words, and the tests prove it by
// walking the whole rail and finding no prepared change, no approval, and
// no Write Receipt anywhere behind it.
//
// Skipping is a real choice. A skipped step stays on screen as skipped
// rather than vanishing, and resuming it is one action.

import { audit } from "./audit";
import { getDb } from "./db";
import { listSlots } from "./accounts";
import { listHostConnections } from "./host-auth";
import { listProjects } from "./projects";

export const SETUP_STEPS = ["connect_project", "connect_host", "create_slot"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupStepState {
  step: SetupStep;
  position: number;
  title: string;
  /** One action. Not a checklist, not a list of things to consider. */
  action: string;
  why: string;
  /** Where in the dashboard that one action happens. */
  href: string;
  /** For the host step: the one thing to copy. */
  copyable: string | null;
  done: boolean;
  doneDetail: string | null;
  skipped: boolean;
  skippedAt: string | null;
  /**
   * False for every step of setup, and asserted rather than assumed: no
   * step of a first run writes to a Connected Project.
   */
  writesToProject: false;
}

export interface SetupRail {
  steps: SetupStepState[];
  /** The one step on screen, or null when there is nothing left to do. */
  current: SetupStepState | null;
  complete: boolean;
  /** Steps passed over, still visible and one action from resuming. */
  skipped: SetupStep[];
  doneMessage: string;
  note: string;
}

export class SetupError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SetupError";
  }
}

/**
 * The connector instruction, built from where this server actually is
 * rather than from a placeholder someone has to remember to change.
 */
export function connectorInstruction(baseUrl?: string): string {
  const base = (baseUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `Add MarketingOS as an MCP server at ${base}/mcp, using the host token you mint on the Connections page. Then call marketingos.onboard once — it returns the rules, the tools, and how writes work.`;
}

function skips(): Map<SetupStep, string> {
  const rows = getDb().prepare("SELECT step, skipped_at FROM setup_skips").all() as {
    step: SetupStep;
    skipped_at: string;
  }[];
  return new Map(rows.map((row) => [row.step, row.skipped_at]));
}

interface StepFacts {
  done: boolean;
  detail: string | null;
}

function projectFacts(): StepFacts {
  const projects = listProjects();
  const healthy = projects.filter((p) => p.status === "healthy");
  if (healthy.length === 0) return { done: false, detail: null };
  return {
    done: true,
    detail: `Connected: ${healthy.map((p) => p.name).join(", ")}.`,
  };
}

function hostFacts(): StepFacts {
  const active = listHostConnections().filter((c) => c.status === "active");
  if (active.length === 0) return { done: false, detail: null };
  return {
    done: true,
    detail: `${active.length} active ${active.length === 1 ? "connection" : "connections"}: ${active
      .map((c) => c.label)
      .join(", ")}.`,
  };
}

function slotFacts(): StepFacts {
  const slots = listSlots();
  if (slots.length === 0) return { done: false, detail: null };
  return {
    done: true,
    detail: `${slots.length} Account ${slots.length === 1 ? "Slot" : "Slots"}: ${slots
      .map((s) => `${s.label} (${s.platform})`)
      .join(", ")}.`,
  };
}

export function setupRail(baseUrl?: string): SetupRail {
  const skipped = skips();
  const facts: Record<SetupStep, StepFacts> = {
    connect_project: projectFacts(),
    connect_host: hostFacts(),
    create_slot: slotFacts(),
  };

  const steps: SetupStepState[] = [
    {
      step: "connect_project",
      position: 1,
      title: "Connect your first project",
      action: "Register the project domain MarketingOS will read from.",
      why: "Everything else is scoped to a Connected Project: pieces, slots, experiments, and what a host is allowed to see.",
      href: "/projects",
      copyable: null,
      ...shared("connect_project", facts, skipped),
    },
    {
      step: "connect_host",
      position: 2,
      title: "Connect your AI Host",
      action: "Mint a host token and add MarketingOS as an MCP server.",
      why: "The host reads through this connection and proposes changes through it. It never applies one.",
      href: "/connections",
      copyable: connectorInstruction(baseUrl),
      ...shared("connect_host", facts, skipped),
    },
    {
      step: "create_slot",
      position: 3,
      title: "Create your first Account Slot",
      action: "Describe the presence this project will have on one platform.",
      why: "A slot is durable capacity. The account filling it is replaceable, and readiness is earned item by item rather than by waiting.",
      href: "/operations",
      copyable: null,
      ...shared("create_slot", facts, skipped),
    },
  ];

  // One step on screen: the first that is neither done nor passed over.
  const current = steps.find((s) => !s.done && !s.skipped) ?? null;
  const complete = steps.every((s) => s.done);

  return {
    steps,
    current,
    complete,
    skipped: steps.filter((s) => s.skipped && !s.done).map((s) => s.step),
    doneMessage:
      "Setup is finished, and it changed nothing in your project. Nothing here wrote to your Connected Project, and nothing will without you seeing the exact diff and approving it. From here the daily loop hands you one thing at a time.",
    note: "No step of setup performs or requests a write to a Connected Project.",
  };
}

function shared(
  step: SetupStep,
  facts: Record<SetupStep, StepFacts>,
  skipped: Map<SetupStep, string>
): Pick<SetupStepState, "done" | "doneDetail" | "skipped" | "skippedAt" | "writesToProject"> {
  const fact = facts[step];
  return {
    done: fact.done,
    doneDetail: fact.detail,
    // A step that got done is not skipped, whatever was recorded earlier.
    skipped: !fact.done && skipped.has(step),
    skippedAt: skipped.get(step) ?? null,
    writesToProject: false,
  };
}

export function skipStep(step: string, actor = "operator"): SetupRail {
  const known = assertStep(step);
  getDb()
    .prepare("INSERT OR REPLACE INTO setup_skips (step, skipped_by) VALUES (?, ?)")
    .run(known, actor);
  audit(actor, "setup.skipped", { step: known });
  return setupRail();
}

/** Un-skip. The step comes back exactly where it was in the order. */
export function resumeStep(step: string, actor = "operator"): SetupRail {
  const known = assertStep(step);
  const removed = getDb().prepare("DELETE FROM setup_skips WHERE step = ?").run(known);
  if (removed.changes === 0) {
    throw new SetupError(409, `The "${known}" step was not skipped.`);
  }
  audit(actor, "setup.resumed", { step: known });
  return setupRail();
}

function assertStep(step: string): SetupStep {
  if (!(SETUP_STEPS as readonly string[]).includes(step)) {
    throw new SetupError(404, `There is no "${step}" step. The rail has: ${SETUP_STEPS.join(", ")}.`);
  }
  return step as SetupStep;
}
