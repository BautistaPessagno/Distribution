"use client";

import { useCallback, useEffect, useState } from "react";

// A prepared Project Change Set waiting on the Operator.
//
// This is an interruption, not a step. The guided rail is the work you
// planned to do today; this is a host asking to change a Connected Project,
// which arrives whenever it arrives. It renders outside and above the rail,
// numbered nowhere, and the rail is unchanged underneath it.
//
// Nothing reaches the project until a person reads the exact diff and says
// yes. The approval is recorded here against the digest; the AI Host is
// told a status and never holds a token.

export interface DiffEntry {
  resource: string;
  path: string;
  before: unknown;
  after: unknown;
}

export interface PreparedChange {
  digest: string;
  projectId: number;
  projectName: string;
  snapshotId: string;
  summary: string;
  diff: DiffEntry[];
  diffText: string;
  validations: string[];
  warnings: string[];
  status: "pending" | "approved" | "rejected" | "used";
  createdAt: string;
}

const STATUS_TAG: Record<PreparedChange["status"], string> = {
  pending: "tag-warn",
  approved: "tag-good",
  rejected: "tag-bad",
  used: "tag-info",
};

export function useApprovals() {
  const [changes, setChanges] = useState<PreparedChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (!res.ok) throw new Error((await res.json()).error);
      setChanges(((await res.json()) as { changes: PreparedChange[] }).changes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { changes, error, reload: load };
}

export function ChangeCard({
  change,
  onDecided,
}: {
  change: PreparedChange;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      setBusy(true);
      setNote(null);
      setProblem(null);
      try {
        const res = await fetch(`/api/approvals/${change.digest}/${decision}`, {
          method: "POST",
        });
        const data = (await res.json()) as { note?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "The decision was refused");
        setNote(data.note ?? null);
        onDecided();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [change.digest, onDecided]
  );

  return (
    <li className="connection-row">
      <div>
        <strong>{change.summary}</strong>{" "}
        <span className={`tag ${STATUS_TAG[change.status]}`}>{change.status}</span>{" "}
        <span className="tag">{change.projectName}</span>
        <div className="body-text">
          digest <span className="mono">{change.digest}</span> · against snapshot{" "}
          <span className="mono">{change.snapshotId}</span> ·{" "}
          {new Date(change.createdAt).toLocaleString()}
        </div>

        <div className="body-text">
          <strong>Exact diff</strong>
          <pre className="mono" style={{ overflowX: "auto" }}>
            {change.diffText || "(no changes)"}
          </pre>
        </div>

        {change.warnings.length > 0 && (
          <div className="body-text">
            <strong>Warnings</strong>
            <ul>
              {change.warnings.map((w, i) => (
                <li key={i}>
                  <span className="tag tag-warn">warning</span> {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        <details className="body-text">
          <summary>Validations that ran ({change.validations.length})</summary>
          <ul>
            {change.validations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </details>

        {note && <p className="body-text">{note}</p>}
        {problem && <p className="error-text">{problem}</p>}
      </div>
      {change.status === "pending" && (
        <div>
          <button
            className="action-primary"
            disabled={busy}
            onClick={() => void decide("approve")}
            style={{ marginRight: "var(--space-1)" }}
          >
            Approve this diff
          </button>
          <button className="action-quiet" disabled={busy} onClick={() => void decide("reject")}>
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

/** The interruption itself: shown above the rail, never inside it. */
export function ApprovalInterruption({
  changes,
  onDecided,
}: {
  changes: PreparedChange[] | null;
  onDecided: () => void;
}) {
  const pending = (changes ?? []).filter((c) => c.status === "pending");
  if (pending.length === 0) return null;

  return (
    <section
      aria-label="Waiting on your approval"
      style={{
        border: "1px solid var(--tag-warn-ink, #956400)",
        padding: "var(--space-2)",
        marginBottom: "var(--space-3)",
      }}
    >
      <span className="tag tag-warn">Waiting on you</span>
      <h2 className="headline" style={{ fontSize: "1.1rem", marginTop: "var(--space-1)" }}>
        {pending.length} change{pending.length === 1 ? "" : "s"} to a Connected Project
      </h2>
      <p className="body-text">
        An AI Host prepared {pending.length === 1 ? "this change" : "these changes"} and nothing has
        been written. Read the exact diff and decide. This is not part of today&apos;s rail; the rail
        picks up where it was.
      </p>
      <ul className="connection-list">
        {pending.map((change) => (
          <ChangeCard key={change.digest} change={change} onDecided={onDecided} />
        ))}
      </ul>
    </section>
  );
}
