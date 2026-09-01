"use client";

import { useCallback, useEffect, useState } from "react";

// Metric Snapshots in the dashboard. The numbers matter less than where
// they came from, so every row leads with its source: read by hand through
// a measure Work Order, or read from the project's own product funnel with
// the snapshot id and version it came out of.
//
// Nothing here is a current value. Every reading is a row that was
// appended, because two readings of the same metric are two facts.

export interface MetricSnapshot {
  id: number;
  metric: string;
  value: number;
  unit: string | null;
  source: string;
  sourceLabel: string;
  collectionMethod: string;
  observedAt: string;
  provenance: {
    projectSnapshotId?: string | null;
    projectSnapshotVersion?: number | null;
    orderId?: number | null;
  };
  targetId: number | null;
  experimentId: number | null;
  recordedBy: string;
}

export function useSnapshots() {
  const [snapshots, setSnapshots] = useState<MetricSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshots");
      const data = (await res.json()) as { snapshots?: MetricSnapshot[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      setSnapshots(data.snapshots ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { snapshots, error, reload: load };
}

export function SnapshotTable({ snapshots }: { snapshots: MetricSnapshot[] }) {
  return (
    <ul className="connection-list">
      {snapshots.map((snapshot) => (
        <li className="connection-card" key={snapshot.id}>
          <div>
            <span
              className={`tag ${snapshot.source === "project_funnel" ? "tag-info" : "tag-neutral"}`}
            >
              {snapshot.sourceLabel}
            </span>{" "}
            <strong>
              {snapshot.metric} {snapshot.value}
              {snapshot.unit ? ` ${snapshot.unit}` : ""}
            </strong>{" "}
            <span className="body-text">
              observed {new Date(snapshot.observedAt).toLocaleString()}
            </span>
          </div>
          <p className="body-text">{snapshot.collectionMethod}</p>
          <p className="body-text">
            {snapshot.source === "project_funnel" ? (
              <>
                <span className="tag">provenance</span> project snapshot{" "}
                {snapshot.provenance.projectSnapshotId} v
                {snapshot.provenance.projectSnapshotVersion}
              </>
            ) : (
              <>
                <span className="tag">provenance</span> Work Order #
                {snapshot.provenance.orderId}
                {snapshot.experimentId !== null && ` · experiment #${snapshot.experimentId}`}
                {snapshot.targetId !== null && ` · delivery #${snapshot.targetId}`}
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Read the project's product funnel now, and file what it says. */
export function FunnelRead({ onRead }: { onRead: () => void }) {
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="body-text">
      <label>
        <span className="tag">project</span>{" "}
        <input
          aria-label="Project id"
          inputMode="numeric"
          placeholder="1"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
      </label>{" "}
      <button
        disabled={busy || !Number.isInteger(Number(projectId)) || projectId.trim() === ""}
        onClick={async () => {
          setBusy(true);
          const res = await fetch("/api/snapshots/funnel-read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: Number(projectId) }),
          });
          setBusy(false);
          if (res.ok) {
            setProblem(null);
            onRead();
            return;
          }
          const data = (await res.json()) as { error?: string };
          setProblem(data.error ?? "That did not work.");
        }}
      >
        Read the product funnel
      </button>
      <p>
        A project that publishes no funnel is refused rather than filled in. Nothing here is
        invented, and nothing is filed under a provenance that does not exist.
      </p>
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}
