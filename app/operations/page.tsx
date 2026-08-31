"use client";

import { ChangeCard, pendingOf, useApprovals } from "../approvals";
import { EmptyState, Shell } from "../shell";

// Operations holds the work that needs a person: Work Orders (ticket 20)
// and, today, the full history of prepared Project Change Sets. The Today
// view surfaces the pending ones as an interruption; this is where every
// decision, including the ones already made, stays on the record.

export default function OperationsPage() {
  const { changes, error, reload } = useApprovals();
  const pending = pendingOf(changes);
  const decided = (changes ?? []).filter((c) => c.status !== "pending");

  return (
    <Shell>
      <section>
        <span className="tag">Manual work</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Operations
        </h1>

        {error && <p className="error-text">{error}</p>}

        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Project writes waiting on you
        </h2>
        <p className="body-text">
          A prepared Project Change Set has changed nothing. It shows you the exact diff
          an AI Host computed against a pinned Project Snapshot, and waits. Approving is
          single-use and bound to that one digest; no token ever goes to the host.
        </p>
        {pending.length === 0 ? (
          <p className="body-text">Nothing waiting.</p>
        ) : (
          <ul className="connection-list">
            {pending.map((change) => (
              <ChangeCard key={change.digest} change={change} onDecided={reload} />
            ))}
          </ul>
        )}

        {decided.length > 0 && (
          <>
            <hr className="hairline" />
            <h2 className="headline" style={{ fontSize: "1.1rem" }}>
              Decided
            </h2>
            <ul className="connection-list">
              {decided.map((change) => (
                <ChangeCard key={change.digest} change={change} onDecided={reload} />
              ))}
            </ul>
          </>
        )}

        <hr className="hairline" />
        <EmptyState tag="Manual work" title="No Work Orders yet">
          <p>
            Work Orders are manual marketing actions with instructions, an approval
            policy, and required proof. They populate when the AI Host or a workflow
            issues one for you to carry out.
          </p>
        </EmptyState>
      </section>
    </Shell>
  );
}
