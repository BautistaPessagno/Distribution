// Host-facing project session ritual (GatewaySim walkthroughs 1 and 5).
//
// `select_project` pins an immutable Project Snapshot: the change cursor and
// the snapshot resources are captured once, at selection time. Every response
// echoes `{project, snapshot, contract}`. Project-touching calls before
// selection return `no_project_selected` naming the exact next call. Reads
// against a snapshot the world has moved past refuse with `stale_snapshot`
// and the recovery path. Context Gaps are explicit data states, never silent
// omissions and never transport errors.

import { audit } from "./audit";
import { CONTRACT_VERSION } from "./onboard";
import {
  listProjects,
  projectServiceToken,
  requireHealthyProject,
  ProjectError,
  type ConnectedProject,
} from "./projects";

export const SNAPSHOT_RESOURCES = ["brand", "claims", "profile"] as const;
export type SnapshotResource = (typeof SNAPSHOT_RESOURCES)[number];

export type ContextGapState =
  | "unsupported"
  | "empty"
  | "stale"
  | "invalid"
  | "conflicted"
  | "unavailable";

export interface ContextGap {
  resource: string;
  state: ContextGapState;
  detail: string;
}

export interface SessionContext {
  project: string | null;
  snapshot: string | null;
  contract: string;
}

export interface GatewayResult {
  ok: boolean;
  response: Record<string, unknown>;
}

interface CapturedResource {
  state: "ok" | "empty";
  version: number;
  data: unknown;
  capturedAt: string;
  source: string;
  gap: ContextGap | null;
}

interface PinnedSnapshot {
  projectId: number;
  projectName: string;
  baseUrl: string;
  id: string;
  cursor: number;
  capturedAt: string;
  resources: Partial<Record<SnapshotResource, CapturedResource>>;
  gaps: ContextGap[];
}

interface SessionState {
  snapshot: PinnedSnapshot | null;
  // In-flight work bound to the pinned snapshot (pieces, prepared changes).
  // Later tickets register entries here; switching projects reports them.
  inFlight: string[];
}

const sessions = new Map<string, SessionState>();

function getSession(key: string): SessionState {
  let session = sessions.get(key);
  if (!session) {
    session = { snapshot: null, inFlight: [] };
    sessions.set(key, session);
  }
  return session;
}

function ctx(session: SessionState): SessionContext {
  return {
    project: session.snapshot?.projectName ?? null,
    snapshot: session.snapshot?.id ?? null,
    contract: CONTRACT_VERSION,
  };
}

export function sessionContext(sessionKey: string): SessionContext {
  return ctx(getSession(sessionKey));
}

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function selectProjectHint(): string {
  const names = listProjects().map((p) => p.name);
  const options = names.length
    ? names.map((n) => JSON.stringify(n)).join("|")
    : '"<name>"';
  return `Call marketingos.select_project({"project":${options}}) first.`;
}

// The guiding error: fired by every project-touching call before selection,
// naming the exact next call instead of failing opaquely.
export function noProjectSelected(): GatewayResult {
  return errResult(
    "no_project_selected",
    "No Connected Project is selected on this connection.",
    selectProjectHint()
  );
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, token: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function currentCursor(base: string, token: string): Promise<number> {
  const res = await fetchJson(`${base}/changes?after=0`, token);
  const cursor = ((res.body ?? {}) as { cursor?: unknown }).cursor;
  if (res.status !== 200 || typeof cursor !== "number") {
    throw new Error(`change feed unavailable (status ${res.status})`);
  }
  return cursor;
}

async function entriesAfter(
  base: string,
  token: string,
  after: number
): Promise<{ cursor: number; resource: string }[]> {
  const res = await fetchJson(`${base}/changes?after=${after}`, token);
  const entries = ((res.body ?? {}) as { entries?: unknown }).entries;
  if (res.status !== 200 || !Array.isArray(entries)) {
    throw new Error(`change feed unavailable (status ${res.status})`);
  }
  return entries as { cursor: number; resource: string }[];
}

function isValidEnvelope(
  body: unknown,
  name: string
): body is { resource: string; state: "ok" | "empty"; version: number; data: unknown } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.resource === name &&
    (b.state === "ok" || b.state === "empty") &&
    typeof b.version === "number"
  );
}

async function captureSnapshot(
  project: ConnectedProject,
  token: string
): Promise<PinnedSnapshot> {
  const base = project.baseUrl.replace(/\/+$/, "");
  const startCursor = await currentCursor(base, token);
  const capturedAt = new Date().toISOString();
  const resources: Partial<Record<SnapshotResource, CapturedResource>> = {};
  const gaps: ContextGap[] = [];

  for (const name of SNAPSHOT_RESOURCES) {
    const source = `${base}/resources/${name}`;
    let result: FetchResult;
    try {
      result = await fetchJson(source, token);
    } catch (err) {
      gaps.push({
        resource: name,
        state: "unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (result.status === 404) {
      gaps.push({
        resource: name,
        state: "unsupported",
        detail: `The project domain does not expose '${name}'.`,
      });
      continue;
    }
    if (result.status !== 200) {
      gaps.push({
        resource: name,
        state: "unavailable",
        detail: `The project domain answered status ${result.status} for '${name}'.`,
      });
      continue;
    }
    if (!isValidEnvelope(result.body, name)) {
      gaps.push({
        resource: name,
        state: "invalid",
        detail: `The '${name}' envelope does not match the project contract shape.`,
      });
      continue;
    }
    const envelope = result.body;
    const gap: ContextGap | null =
      envelope.state === "empty"
        ? {
            resource: name,
            state: "empty",
            detail: `'${name}' is implemented but has no entries yet.`,
          }
        : null;
    if (gap) gaps.push(gap);
    resources[name] = {
      state: envelope.state,
      version: envelope.version,
      data: envelope.data,
      capturedAt,
      source,
      gap,
    };
  }

  // The cursor is re-read after capture: resources that changed while the
  // snapshot was being taken are conflicted, not silently mixed-revision.
  const endCursor = await currentCursor(base, token);
  if (endCursor > startCursor) {
    const moved = await entriesAfter(base, token, startCursor);
    for (const entry of moved) {
      if ((SNAPSHOT_RESOURCES as readonly string[]).includes(entry.resource)) {
        gaps.push({
          resource: entry.resource,
          state: "conflicted",
          detail: `'${entry.resource}' changed while the snapshot was being captured; its captured value may disagree with cursor ${endCursor}.`,
        });
      }
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    baseUrl: base,
    id: `snap-${project.id}-c${endCursor}`,
    cursor: endCursor,
    capturedAt,
    resources,
    gaps,
  };
}

function snapshotPayload(snap: PinnedSnapshot): Record<string, unknown> {
  return { id: snap.id, cursor: snap.cursor, capturedAt: snap.capturedAt };
}

export async function selectProject(
  sessionKey: string,
  projectName: string
): Promise<GatewayResult> {
  const session = getSession(sessionKey);
  const projects = listProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    const available = projects.map((p) => p.name).join(", ");
    return errResult(
      "unsupported_capability",
      `No Connected Project "${projectName}".`,
      available
        ? `Available: ${available}.`
        : "No Connected Projects are registered yet. Register one in the MarketingOS dashboard first."
    );
  }
  try {
    requireHealthyProject(project.id);
  } catch (err) {
    if (err instanceof ProjectError) {
      return errResult(
        "project_unhealthy",
        err.message,
        "Ask the Operator to re-run conformance from the dashboard, then select the project again."
      );
    }
    throw err;
  }

  const token = await projectServiceToken(project.id, "ai-host");
  let snapshot: PinnedSnapshot;
  try {
    snapshot = await captureSnapshot(project, token);
  } catch (err) {
    return errResult(
      "temporarily_unavailable",
      `The project domain for "${projectName}" could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "Retry marketingos.select_project, or ask the Operator to check the Connected Project from the dashboard."
    );
  }

  const notes: string[] = [];
  const previous = session.snapshot;
  if (previous && previous.projectId !== project.id) {
    const inFlight = session.inFlight.length
      ? session.inFlight.join(", ")
      : "none";
    notes.push(
      `Switched from '${previous.projectName}'; snapshot ${previous.id} is released and a fresh snapshot is pinned. In-flight work attached to the previous project: ${inFlight}.`
    );
    session.inFlight = [];
  }

  session.snapshot = snapshot;
  audit("ai-host", "gateway.project_selected", {
    projectId: project.id,
    snapshot: snapshot.id,
  });

  return {
    ok: true,
    response: {
      context: ctx(session),
      snapshot: snapshotPayload(snapshot),
      contextGaps: snapshot.gaps,
      notes,
    },
  };
}

export async function getSnapshot(sessionKey: string): Promise<GatewayResult> {
  const session = getSession(sessionKey);
  const pinned = session.snapshot;
  if (!pinned) return noProjectSelected();

  let project: ConnectedProject;
  try {
    project = requireHealthyProject(pinned.projectId);
  } catch (err) {
    if (err instanceof ProjectError) {
      return errResult(
        "project_unhealthy",
        err.message,
        "Ask the Operator to re-run conformance from the dashboard, then refresh the snapshot."
      );
    }
    throw err;
  }

  const token = await projectServiceToken(project.id, "ai-host");
  let snapshot: PinnedSnapshot;
  try {
    snapshot = await captureSnapshot(project, token);
  } catch (err) {
    return errResult(
      "temporarily_unavailable",
      `The project domain could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "Retry project.get_snapshot, or ask the Operator to check the Connected Project from the dashboard."
    );
  }

  session.snapshot = snapshot;
  return {
    ok: true,
    response: {
      context: ctx(session),
      snapshot: snapshotPayload(snapshot),
      contextGaps: snapshot.gaps,
    },
  };
}

export async function getResource(
  sessionKey: string,
  resource: string
): Promise<GatewayResult> {
  const session = getSession(sessionKey);
  const pinned = session.snapshot;
  if (!pinned) return noProjectSelected();

  if (!(SNAPSHOT_RESOURCES as readonly string[]).includes(resource)) {
    return errResult(
      "unsupported_capability",
      `Resource "${resource}" is not exposed through the session snapshot.`,
      `Available here: ${SNAPSHOT_RESOURCES.join(", ")}.`
    );
  }

  const token = await projectServiceToken(pinned.projectId, "ai-host");
  let moved: { cursor: number; resource: string }[];
  try {
    moved = await entriesAfter(pinned.baseUrl, token, pinned.cursor);
  } catch (err) {
    return errResult(
      "temporarily_unavailable",
      `Staleness could not be verified against the project domain: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "Retry project.get_resource, or ask the Operator to check the Connected Project from the dashboard."
    );
  }
  if (moved.length > 0) {
    return {
      ok: false,
      response: {
        error: "stale_snapshot",
        message: `Snapshot ${pinned.id} is stale; the project changed upstream.`,
        contextGaps: [
          {
            resource,
            state: "stale",
            detail: `${moved.length} change(s) landed after cursor ${pinned.cursor}.`,
          } satisfies ContextGap,
        ],
        next: "Call project.get_snapshot to pin a fresh snapshot, then re-read.",
      },
    };
  }

  const captured = pinned.resources[resource as SnapshotResource];
  if (!captured) {
    const gap =
      pinned.gaps.find((g) => g.resource === resource) ??
      ({
        resource,
        state: "unavailable",
        detail: `'${resource}' was not captured in snapshot ${pinned.id}.`,
      } satisfies ContextGap);
    // A Context Gap is data, not an error: the read succeeds and names the state.
    return {
      ok: true,
      response: {
        context: ctx(session),
        resource,
        state: gap.state,
        data: null,
        contextGaps: [gap],
      },
    };
  }

  return {
    ok: true,
    response: {
      context: ctx(session),
      resource,
      state: captured.state,
      data: captured.data,
      contextGaps: captured.gap ? [captured.gap] : [],
      provenance: {
        snapshot: pinned.id,
        resource,
        version: captured.version,
        capturedAt: captured.capturedAt,
        source: captured.source,
      },
    },
  };
}
