"use client";

import { useCallback, useEffect, useState } from "react";

// Decisions and the learning log. The shape of this surface is the argument
// it makes: a conclusion is never shown without what its evidence cannot
// support and the rung that evidence reaches, and funnel movements sit
// beside a decision, labelled, rather than underneath it.

export interface CorrelatedObservation {
  metric: string;
  readings: number;
  label: string;
}

export interface LearningEntry {
  experimentId: number;
  name: string;
  variable: string;
  primaryMetric: string;
  decision: string;
  supports: string;
  doesNotSupport: string;
  ladderRung: string;
  ladderMeaning: string;
  cheapestNextObservation: string;
  stopConditionMet: string;
  sample: { delivered: number; target: number };
  correlatedObservations: CorrelatedObservation[];
  decidedBy: string;
  decidedAt: string;
}

export interface LearningLog {
  entries: LearningEntry[];
  ladder: { rung: string; meaning: string }[];
  note: string;
}

const RUNG_TAG: Record<string, string> = {
  controlled_experiment: "tag-good",
  within_account_comparison: "tag-info",
  pre_post_observation: "tag-warn",
  correlated_observation: "tag-warn",
  anecdote: "tag-neutral",
};

export function useLearningLog(projectId: number | null) {
  const [log, setLog] = useState<LearningLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (projectId === null) return;
    try {
      const res = await fetch(`/api/experiments/log/${projectId}`);
      const data = (await res.json()) as { log?: LearningLog; error?: string };
      if (!res.ok) throw new Error(data.error);
      setLog(data.log ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { log, error, reload: load };
}

export function LearningEntryCard({ entry }: { entry: LearningEntry }) {
  return (
    <li className="connection-card">
      <div>
        <span className="tag">{entry.decision}</span>{" "}
        <span className={`tag ${RUNG_TAG[entry.ladderRung] ?? "tag-neutral"}`}>
          {entry.ladderRung.replace(/_/g, " ")}
        </span>{" "}
        <strong>{entry.name}</strong>{" "}
        <span className="tag">
          {entry.sample.delivered} of {entry.sample.target} delivered
        </span>
      </div>
      <p className="body-text">{entry.ladderMeaning}</p>

      <dl className="body-text">
        <dt>
          <strong>Supports</strong>
        </dt>
        <dd>{entry.supports}</dd>
        {/* Shown with the same weight as the claim, never as a footnote. */}
        <dt>
          <strong>Does not support</strong>
        </dt>
        <dd>{entry.doesNotSupport}</dd>
        <dt>
          <strong>Cheapest next observation</strong>
        </dt>
        <dd>{entry.cheapestNextObservation}</dd>
        <dt>
          <strong>Stop condition met</strong>
        </dt>
        <dd>{entry.stopConditionMet}</dd>
      </dl>

      {entry.correlatedObservations.length > 0 && (
        <div className="body-text">
          <strong>Moved alongside</strong>{" "}
          <span className="tag tag-warn">correlated, not caused</span>
          <ul>
            {entry.correlatedObservations.map((correlation) => (
              <li key={correlation.metric}>
                {correlation.metric} ({correlation.readings}{" "}
                {correlation.readings === 1 ? "reading" : "readings"}) — {correlation.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="body-text">
        Decided by {entry.decidedBy} on {new Date(entry.decidedAt).toLocaleString()}. Variable:{" "}
        {entry.variable}. Primary metric: {entry.primaryMetric}.
      </p>
    </li>
  );
}
