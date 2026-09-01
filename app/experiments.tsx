"use client";

import { useCallback, useEffect, useState } from "react";

// Experiments in the dashboard. The whole point of the surface is that the
// declaration is shown as it was fixed — one variable, one primary metric,
// the rule, the sample, the stop condition — beside the readings it asked
// for in advance. Nothing here can be edited, because an experiment whose
// terms move with its results is not an experiment.

export interface ObservationPoint {
  id: number;
  position: number;
  label: string;
  afterHours: number;
  metrics: string[];
  source: string;
}

export interface Experiment {
  id: number;
  projectId: number;
  name: string;
  declaration: {
    variable: string;
    primaryMetric: string;
    decisionRule: string;
    sampleTarget: number;
    stopCondition: string;
    declaredBy: string;
    declaredAt: string;
  };
  observations: ObservationPoint[];
  status: string;
  enrolledTargets: number[];
  scheduledObservations: { observationId: number; targetId: number; orderId: number; dueAt: string }[];
  sampleProgress: { target: number; enrolled: number };
  note: string;
}

const STATUS_TAG: Record<string, string> = {
  predeclared: "tag-info",
  running: "tag-good",
  stopped: "tag-warn",
  concluded: "tag-neutral",
};

export function useExperiments() {
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/experiments");
      const data = (await res.json()) as { experiments?: Experiment[]; error?: string };
      if (!res.ok) throw new Error(data.error);
      setExperiments(data.experiments ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { experiments, error, reload: load };
}

export function ExperimentCard({
  experiment,
  onChanged,
}: {
  experiment: Experiment;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { declaration } = experiment;

  const move = useCallback(
    async (path: string) => {
      setBusy(true);
      const res = await fetch(`/api/experiments/${experiment.id}/${path}`, { method: "POST" });
      setBusy(false);
      if (res.ok) {
        setProblem(null);
        onChanged();
        return;
      }
      const data = (await res.json()) as { error?: string };
      setProblem(data.error ?? "That did not work.");
    },
    [experiment.id, onChanged]
  );

  return (
    <li className="connection-card">
      <div>
        <span className={`tag ${STATUS_TAG[experiment.status] ?? "tag-neutral"}`}>
          {experiment.status}
        </span>{" "}
        <strong>{experiment.name}</strong>{" "}
        <span className="tag">
          {experiment.sampleProgress.enrolled} of {experiment.sampleProgress.target} delivered
        </span>
      </div>

      {/* The declaration, as it was fixed. Read-only by construction. */}
      <dl className="body-text">
        <dt>
          <strong>Variable</strong>
        </dt>
        <dd>{declaration.variable}</dd>
        <dt>
          <strong>Primary metric</strong>
        </dt>
        <dd>{declaration.primaryMetric}</dd>
        <dt>
          <strong>Decision rule</strong>
        </dt>
        <dd>{declaration.decisionRule}</dd>
        <dt>
          <strong>Stop condition</strong>
        </dt>
        <dd>{declaration.stopCondition}</dd>
      </dl>
      <p className="body-text">
        <span className="tag">predeclared</span> by {declaration.declaredBy} on{" "}
        {new Date(declaration.declaredAt).toLocaleString()}. {experiment.note}
      </p>

      <div className="body-text">
        <strong>Observation points</strong>
        <ul>
          {experiment.observations.map((point) => {
            const due = experiment.scheduledObservations.filter(
              (s) => s.observationId === point.id
            );
            return (
              <li key={point.id}>
                {point.label} — {point.metrics.join(", ")} from {point.source}, {point.afterHours}h
                after posting{" "}
                <span className={`tag ${due.length > 0 ? "tag-good" : "tag-neutral"}`}>
                  {due.length} scheduled
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {experiment.status !== "concluded" && (
        <>
          {experiment.status !== "stopped" && (
            <button disabled={busy} onClick={() => void move("stop")}>
              Stop
            </button>
          )}{" "}
          <button disabled={busy} onClick={() => void move("conclude")}>
            Conclude
          </button>
        </>
      )}
      {problem && <p className="error-text">{problem}</p>}
    </li>
  );
}
