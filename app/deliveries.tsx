"use client";

import { useCallback, useEffect, useState } from "react";

// Deliveries in the dashboard. Exported work reaches an account by hand, so
// this is the record of that handoff: which release, to which account, in
// what order, under which disclosure rules, and — at the end — the link
// someone can open.
//
// MarketingOS posts nothing. Everything here happened because a person did
// it, and none of it is verified until they came back with a permalink.

export interface DisclosureItem {
  rule: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface DeliveryTarget {
  id: number;
  releaseId: number;
  slotId: number;
  idempotencyKey: string;
  queuePosition: number;
  window: { start: string; end: string };
  status: string;
  disclosures: DisclosureItem[];
  outstandingDisclosures: string[];
  workOrderId: number | null;
  workOrderStatus: string | null;
  permalink: string | null;
  failureReason: string | null;
  attemptCount: number;
  cancellationRequested: boolean;
  cancellationNote: string | null;
}

const STATUS_TAG: Record<string, string> = {
  queued: "tag-info",
  released_to_operator: "tag-warn",
  posting: "tag-warn",
  proof_submitted: "tag-info",
  verified_posted: "tag-good",
  failed: "tag-bad",
  cancelled: "tag-neutral",
};

export function useDeliveries() {
  const [targets, setTargets] = useState<DeliveryTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/deliveries");
      const data = (await res.json()) as { targets?: DeliveryTarget[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      setTargets(data.targets ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { targets, error, reload: load };
}

async function post(path: string, body?: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as { error?: string; detail?: string[] };
  if (res.ok) return null;
  return [data.error, ...(data.detail ?? [])].filter(Boolean).join(" ") || "That did not work.";
}

/** The checklist, and the only way past it. */
function Disclosures({ target, onChanged }: { target: DeliveryTarget; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="body-text">
      <strong>Disclosures</strong>{" "}
      <span className={`tag ${target.outstandingDisclosures.length === 0 ? "tag-good" : "tag-warn"}`}>
        {target.disclosures.length - target.outstandingDisclosures.length} of{" "}
        {target.disclosures.length} acknowledged
      </span>
      <p>
        The platform&rsquo;s own rules. Every one is acknowledged before the work is handed
        out, not after it is published.
      </p>
      <ul>
        {target.disclosures.map((item) => (
          <li key={item.rule}>
            <span className={`tag ${item.acknowledgedBy ? "tag-good" : "tag-warn"}`}>
              {item.acknowledgedBy ? "acknowledged" : "outstanding"}
            </span>{" "}
            {item.rule}
            {!item.acknowledgedBy && target.status === "queued" && (
              <>
                {" "}
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const failure = await post(`/api/deliveries/${target.id}/disclosures`, {
                      rule: item.rule,
                    });
                    setBusy(false);
                    setProblem(failure);
                    if (!failure) onChanged();
                  }}
                >
                  Acknowledge
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

/** The permalink box: the one thing that turns a claim into a fact. */
function ProofBox({ target, onChanged }: { target: DeliveryTarget; onChanged: () => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (target.status !== "posting" && target.status !== "released_to_operator") return null;

  return (
    <div className="body-text">
      <label>
        <span className="tag">permalink</span>
        <input
          aria-label="Destination permalink"
          placeholder="https://…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
      </label>{" "}
      <button
        disabled={busy || !link.trim()}
        onClick={async () => {
          setBusy(true);
          const failure = await post(`/api/deliveries/${target.id}/proof`, {
            permalink: link.trim(),
          });
          setBusy(false);
          setProblem(failure);
          if (!failure) {
            setLink("");
            onChanged();
          }
        }}
      >
        Submit the link
      </button>
      <p>Nothing is verified as posted without a link someone can open.</p>
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

const NEXT_MOVE: Record<string, { path: string; label: string } | undefined> = {
  queued: { path: "release", label: "Release to the Operator" },
  released_to_operator: { path: "posting", label: "Start posting" },
  proof_submitted: { path: "verify", label: "Verify posted" },
  failed: { path: "release", label: "Try again" },
};

export function DeliveryCard({
  target,
  onChanged,
}: {
  target: DeliveryTarget;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const move = NEXT_MOVE[target.status];
  const blocked = target.status === "queued" && target.outstandingDisclosures.length > 0;

  return (
    <li className="connection-card">
      <div>
        <span className={`tag ${STATUS_TAG[target.status] ?? "tag-neutral"}`}>
          {target.status.replace(/_/g, " ")}
        </span>{" "}
        <span className="tag">position {target.queuePosition}</span>{" "}
        <strong>Release #{target.releaseId}</strong>{" "}
        <span className="body-text">
          window {target.window.start}–{target.window.end}
          {target.attemptCount > 1 && ` · attempt ${target.attemptCount}`}
        </span>
      </div>

      {target.cancellationRequested && target.status !== "cancelled" && (
        <p className="body-text">
          <span className="tag tag-warn">cancellation requested</span> {target.cancellationNote}{" "}
          — the work is already with a person, so this is a request rather than a stop.{" "}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const failure = await post(
                `/api/deliveries/${target.id}/acknowledge-cancellation`
              );
              setBusy(false);
              setProblem(failure);
              if (!failure) onChanged();
            }}
          >
            Acknowledge and stop
          </button>
        </p>
      )}

      {target.failureReason && (
        <p className="body-text">
          <span className="tag tag-bad">failed</span> {target.failureReason}
        </p>
      )}

      {target.permalink && (
        <p className="body-text">
          <span className="tag tag-good">destination</span>{" "}
          <a href={target.permalink} rel="noreferrer noopener" target="_blank">
            {target.permalink}
          </a>
        </p>
      )}

      <Disclosures target={target} onChanged={onChanged} />
      <ProofBox target={target} onChanged={onChanged} />

      {move && (
        <button
          disabled={busy || blocked || target.cancellationRequested}
          onClick={async () => {
            setBusy(true);
            const failure = await post(`/api/deliveries/${target.id}/${move.path}`);
            setBusy(false);
            setProblem(failure);
            if (!failure) onChanged();
          }}
        >
          {move.label}
        </button>
      )}
      {problem && <p className="error-text">{problem}</p>}
    </li>
  );
}
