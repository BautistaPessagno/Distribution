"use client";

import { useCallback, useEffect, useState } from "react";

// Account Slots in the dashboard. A slot is durable capacity for one
// Connected Project on one platform; the instance filling it is
// replaceable. Readiness is six explicit items, each earned by a recorded
// fact — never by time passing — and this is where the Operator records
// them and sees what is still outstanding.
//
// Credentials are never shown here because they are never held here: an
// instance carries a custody reference into the secrets store and nothing
// more.

export interface ReadinessRecord {
  item: string;
  label: string;
  evidence: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

export interface DailyCap {
  action: string;
  perDay: number;
  basis: "judgment_call";
  platformAnchor: {
    value: number;
    unit: string;
    source: string;
    observedOn: string;
    note: string;
  } | null;
}

export interface SlotInstance {
  id: number;
  handle: string;
  credentials: string;
  health: string;
  lostReason: string | null;
  archived: boolean;
}

export interface AccountSlot {
  id: number;
  projectName: string;
  platform: string;
  label: string;
  identitySpec: { kind: string; displayName: string };
  identityRule: string;
  nicheKeywords: string[];
  disclosureRules: string[];
  dailyCaps: DailyCap[];
  capsNote: string;
  allowedWindows: { start: string; end: string }[];
  status: string;
  instance: SlotInstance | null;
  readiness: ReadinessRecord[];
  outstandingReadiness: string[];
}

const STATUS_TAG: Record<string, string> = {
  requested: "tag-neutral",
  provisioning: "tag-info",
  warming: "tag-warn",
  ready: "tag-good",
  active: "tag-good",
  impaired: "tag-bad",
  replacing: "tag-warn",
  paused: "tag-bad",
  retired: "tag-neutral",
};

export function useSlots() {
  const [slots, setSlots] = useState<AccountSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/slots");
      if (!res.ok) throw new Error((await res.json()).error);
      setSlots(((await res.json()) as { slots: AccountSlot[] }).slots);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { slots, error, reload: load };
}

function CapList({ caps, note }: { caps: DailyCap[]; note: string }) {
  return (
    <div className="body-text">
      <strong>Daily caps</strong> <span className="tag tag-warn">judgment calls</span>
      <p>{note}</p>
      <ul>
        {caps.map((cap) => (
          <li key={cap.action}>
            {cap.action}: {cap.perDay}/day{" "}
            {cap.platformAnchor ? (
              <>
                <span className="tag tag-info">
                  platform publishes {cap.platformAnchor.value} {cap.platformAnchor.unit}
                </span>{" "}
                <span className="body-text">
                  ({cap.platformAnchor.note} Read {cap.platformAnchor.observedOn}:{" "}
                  <a href={cap.platformAnchor.source} rel="noreferrer noopener" target="_blank">
                    source
                  </a>
                  )
                </span>
              </>
            ) : (
              <span className="tag tag-warn">
                no platform number published — ours, and a guess
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadinessChecklist({
  slot,
  onRecorded,
}: {
  slot: AccountSlot;
  onRecorded: () => void;
}) {
  const [item, setItem] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const outstanding = slot.readiness.filter((r) => r.evidence === null);

  const record = useCallback(async () => {
    if (!slot.instance || !item || !evidence.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/slots/${slot.id}/readiness`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: slot.instance.id, item, evidence: evidence.trim() }),
      });
      const data = (await res.json()) as { error?: string; detail?: string[] };
      if (!res.ok) throw new Error([data.error, ...(data.detail ?? [])].filter(Boolean).join(" "));
      setItem("");
      setEvidence("");
      onRecorded();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [evidence, item, onRecorded, slot.id, slot.instance]);

  return (
    <div className="body-text">
      <strong>Readiness</strong>{" "}
      <span className="tag">
        {slot.readiness.length - outstanding.length} of {slot.readiness.length} evidenced
      </span>
      <p>
        Every item is checked by a recorded fact. Time passing checks nothing, and readiness
        promises nothing about reach or safety.
      </p>
      <ul>
        {slot.readiness.map((record) => (
          <li key={record.item}>
            <span className={`tag ${record.evidence ? "tag-good" : "tag-warn"}`}>
              {record.evidence ? "evidenced" : "outstanding"}
            </span>{" "}
            {record.label}
            {record.evidence && (
              <div className="body-text">
                {record.evidence} — {record.recordedBy},{" "}
                {record.recordedAt ? new Date(record.recordedAt).toLocaleString() : ""}
              </div>
            )}
          </li>
        ))}
      </ul>
      {slot.instance && outstanding.length > 0 && (
        <div>
          <label>
            <span className="tag">item</span>{" "}
            <select value={item} onChange={(e) => setItem(e.target.value)} aria-label="Checklist item">
              <option value="">Choose an item…</option>
              {outstanding.map((r) => (
                <option key={r.item} value={r.item}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            <span className="tag">evidence</span>{" "}
            <input
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="What makes this true"
              aria-label="Evidence"
            />
          </label>{" "}
          <button
            className="action-quiet"
            disabled={busy || !item || !evidence.trim()}
            onClick={() => void record()}
          >
            Record evidence
          </button>
        </div>
      )}
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

const SLOT_MOVES: Record<string, string> = {
  ready: "Mark ready",
  activate: "Activate",
  pause: "Pause this slot",
  resume: "Resume",
};

export function SlotCard({ slot, onChanged }: { slot: AccountSlot; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const move = useCallback(
    async (action: string) => {
      setBusy(true);
      setProblem(null);
      try {
        const res = await fetch(`/api/slots/${slot.id}/${action}`, { method: "POST" });
        const data = (await res.json()) as { error?: string; detail?: string[] };
        if (!res.ok) throw new Error([data.error, ...(data.detail ?? [])].filter(Boolean).join(" "));
        onChanged();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, slot.id]
  );

  const available = Object.keys(SLOT_MOVES).filter((action) => {
    if (action === "ready") return slot.status === "warming" || slot.status === "replacing";
    if (action === "activate") return slot.status === "ready";
    if (action === "pause") return slot.status !== "paused" && slot.status !== "retired";
    return slot.status === "paused";
  });

  return (
    <li className="connection-row">
      <div>
        <strong>{slot.label}</strong>{" "}
        <span className={`tag ${STATUS_TAG[slot.status] ?? ""}`}>{slot.status}</span>{" "}
        <span className="tag">{slot.platform}</span>{" "}
        <span className="tag">{slot.projectName}</span>{" "}
        <span className="tag tag-info">{slot.identitySpec.kind}</span>
        <div className="body-text">
          {slot.identitySpec.displayName} · {slot.identityRule}
        </div>

        <div className="body-text">
          <strong>Instance</strong>{" "}
          {slot.instance ? (
            <>
              <span className="mono">{slot.instance.handle}</span>{" "}
              <span className="tag">{slot.instance.health}</span>{" "}
              <span className="tag tag-info">credentials: {slot.instance.credentials}</span>
            </>
          ) : (
            <span className="tag tag-warn">no instance in this slot yet</span>
          )}
        </div>

        <ReadinessChecklist slot={slot} onRecorded={onChanged} />
        <CapList caps={slot.dailyCaps} note={slot.capsNote} />

        <div className="body-text">
          <strong>Allowed windows</strong>{" "}
          {slot.allowedWindows.map((w) => `${w.start}–${w.end}`).join(", ") || "none"}
          <br />
          <strong>Disclosure</strong>
          <ul>
            {slot.disclosureRules.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
        </div>

        {problem && <p className="error-text">{problem}</p>}
      </div>
      <div>
        {available.map((action) => (
          <button
            key={action}
            className="action-quiet"
            disabled={busy}
            onClick={() => void move(action)}
            style={{ marginRight: "var(--space-1)" }}
          >
            {SLOT_MOVES[action]}
          </button>
        ))}
      </div>
    </li>
  );
}
