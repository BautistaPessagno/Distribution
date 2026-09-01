"use client";

import { useCallback, useEffect, useState } from "react";

// Work Orders in the dashboard. Every platform action in MarketingOS is a
// person's hand, so this is where that work is handed out and where what
// came back is recorded.
//
// The card is the point. A warm-up order shows one instruction and one box
// for the proof — not a plan for the session, not a checklist. The rest of
// the card is history: every attempt, with the proof it produced and what
// review said of it. A rejected attempt stays visible, because what went
// wrong the first time is the part worth keeping.

export interface Attempt {
  id: number;
  attemptNo: number;
  claimedBy: string;
  claimedAt: string;
  proof: { body: string; submittedBy: string; submittedAt: string } | null;
  review: {
    decision: "accepted" | "changes_requested" | "failed";
    note: string;
    reviewedBy: string;
    reviewedAt: string;
  } | null;
}

export interface Transition {
  from: string;
  to: string;
  actor: string;
  note: string;
  at: string;
}

export interface WorkOrderCard {
  orderId: number;
  kind: string;
  title: string;
  instruction: string;
  proofField: { label: string; placeholder: string };
  reminder: string | null;
}

export interface ReleaseGate {
  open: boolean;
  reason: string | null;
  message: string;
  nextOpensAt: string | null;
  cap: { action: string; perDay: number; releasedToday: number } | null;
}

export interface WorkOrder {
  id: number;
  projectName: string;
  kind: string;
  title: string;
  status: string;
  card: WorkOrderCard;
  readinessLabel: string | null;
  cappedAction: string | null;
  /** Why the queue is shut for this order, and when it opens again. */
  release: ReleaseGate | null;
  attempts: Attempt[];
  attemptCount: number;
  history: Transition[];
}

const STATUS_TAG: Record<string, string> = {
  draft: "tag-neutral",
  awaiting_brand_approval: "tag-info",
  queued: "tag-info",
  claimed: "tag-warn",
  in_progress: "tag-warn",
  proof_submitted: "tag-info",
  under_review: "tag-info",
  changes_requested: "tag-warn",
  completed: "tag-good",
  cancelled: "tag-neutral",
  failed: "tag-bad",
};

/** The move a person takes next, given where the order is. */
const NEXT_MOVE: Record<string, { path: string; label: string } | undefined> = {
  draft: { path: "submit", label: "Send for approval" },
  awaiting_brand_approval: { path: "approve", label: "Approve onto the queue" },
  queued: { path: "claim", label: "Claim" },
  claimed: { path: "start", label: "Start" },
  proof_submitted: { path: "review", label: "Review the proof" },
  changes_requested: { path: "retry", label: "Try again" },
};

export function useWorkOrders() {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/work-orders");
      const data = (await res.json()) as { orders?: WorkOrder[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      setOrders(data.orders ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { orders, error, reload: load };
}

async function post(
  path: string,
  body?: Record<string, unknown>
): Promise<string | null> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as { error?: string; detail?: string[] };
  if (res.ok) return null;
  return [data.error, ...(data.detail ?? [])].filter(Boolean).join(" ") || "That did not work.";
}

function AttemptHistory({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <div className="body-text">
      <strong>Attempts</strong>{" "}
      <span className="tag">
        {attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}
      </span>
      <ul>
        {attempts.map((attempt) => (
          <li key={attempt.id}>
            <span className="tag">attempt {attempt.attemptNo}</span> claimed by {attempt.claimedBy}
            {attempt.proof && (
              <div className="body-text">
                <em>Proof:</em> {attempt.proof.body}
              </div>
            )}
            {attempt.review && (
              <div className="body-text">
                <span
                  className={`tag ${
                    attempt.review.decision === "accepted" ? "tag-good" : "tag-warn"
                  }`}
                >
                  {attempt.review.decision.replace(/_/g, " ")}
                </span>{" "}
                {attempt.review.note}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The proof box, and the two things review can say about what lands in it. */
function ProofPanel({ order, onChanged }: { order: WorkOrder; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = useCallback(
    async (path: string, key: "proof" | "note") => {
      if (!text.trim()) return;
      setBusy(true);
      const failure = await post(`/api/work-orders/${order.id}/${path}`, { [key]: text.trim() });
      setBusy(false);
      setProblem(failure);
      if (!failure) {
        setText("");
        onChanged();
      }
    },
    [onChanged, order.id, text]
  );

  if (order.status === "in_progress") {
    return (
      <div className="body-text">
        <label>
          <span className="tag">{order.card.proofField.label}</span>
          <textarea
            aria-label="Proof"
            placeholder={order.card.proofField.placeholder}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button disabled={busy || !text.trim()} onClick={() => void send("proof", "proof")}>
          Submit proof
        </button>
        <p>Nothing completes without this.</p>
        {problem && <p className="error-text">{problem}</p>}
      </div>
    );
  }

  if (order.status === "under_review") {
    return (
      <div className="body-text">
        <label>
          <span className="tag">review note</span>
          <textarea
            aria-label="Review note"
            placeholder="What you make of the proof."
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const failure = await post(`/api/work-orders/${order.id}/complete`, {
              note: text.trim(),
            });
            setBusy(false);
            setProblem(failure);
            if (!failure) {
              setText("");
              onChanged();
            }
          }}
        >
          Accept and complete
        </button>{" "}
        <button
          disabled={busy || !text.trim()}
          onClick={() => void send("request-changes", "note")}
        >
          Request changes
        </button>
        <p>
          Reading your own proof back is the step, not a formality. A retry becomes a new
          attempt; this one stays exactly as it is.
        </p>
        {problem && <p className="error-text">{problem}</p>}
      </div>
    );
  }

  return problem ? <p className="error-text">{problem}</p> : null;
}

export function WorkOrderCardView({
  order,
  onChanged,
}: {
  order: WorkOrder;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const move = NEXT_MOVE[order.status];

  return (
    <li className="connection-card">
      <div>
        <span className={`tag ${STATUS_TAG[order.status] ?? "tag-neutral"}`}>
          {order.status.replace(/_/g, " ")}
        </span>{" "}
        <span className="tag">{order.kind}</span>{" "}
        <strong>{order.title}</strong>{" "}
        <span className="body-text">{order.projectName}</span>
      </div>

      {/* One instruction. Everything else on this card is history. */}
      <p className="body-text">{order.card.instruction}</p>
      {order.card.reminder && (
        <p className="body-text">
          <span className="tag tag-info">platform rule</span> {order.card.reminder}
        </p>
      )}
      {order.readinessLabel && (
        <p className="body-text">
          <span className="tag">earns</span> {order.readinessLabel}
        </p>
      )}

      {order.release && !order.release.open && (
        <p className="body-text">
          <span className={`tag ${order.release.reason === "paused" ? "tag-bad" : "tag-warn"}`}>
            {order.release.reason === "paused" ? "halted" : "queue shut"}
          </span>{" "}
          {order.release.message}
        </p>
      )}
      {order.release?.cap && order.release.open && (
        <p className="body-text">
          <span className="tag tag-warn">judgment call</span> {order.release.cap.releasedToday} of{" "}
          {order.release.cap.perDay} {order.release.cap.action} orders released today. This cap is
          ours, not a volume the platform sanctioned.
        </p>
      )}

      {move && (
        <button
          disabled={busy || (move.path === "claim" && order.release?.open === false)}
          onClick={async () => {
            setBusy(true);
            const failure = await post(`/api/work-orders/${order.id}/${move.path}`);
            setBusy(false);
            setProblem(failure);
            if (!failure) onChanged();
          }}
        >
          {move.label}
        </button>
      )}
      {problem && <p className="error-text">{problem}</p>}

      <ProofPanel order={order} onChanged={onChanged} />
      <AttemptHistory attempts={order.attempts} />
    </li>
  );
}
