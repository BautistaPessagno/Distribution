"use client";

import { useCallback, useEffect, useState } from "react";

// The week-four habit check. It appears when it comes due and asks one
// question, because the MVP's real question is not whether the loop ran
// once but whether it is still running a month later.
//
// The answer is recorded either way. A check that only took good news would
// tell us nothing we did not already assume.

export interface HabitCheck {
  id: number;
  projectId: number;
  question: string;
  dueAt: string;
  answer: string | null;
  note: string;
}

export function useHabitCheck(projectId: number | null) {
  const [check, setCheck] = useState<HabitCheck | null>(null);
  const [due, setDue] = useState(false);

  const load = useCallback(async () => {
    if (projectId === null) return;
    const res = await fetch(`/api/habit-check/${projectId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { check: HabitCheck | null; due: boolean };
    setCheck(data.check);
    setDue(data.due);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { check, due, reload: load };
}

export function HabitCheckPanel({
  check,
  onAnswered,
}: {
  check: HabitCheck;
  onAnswered: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="connection-card">
      <div>
        <span className="tag tag-info">week four</span> <strong>{check.question}</strong>
      </div>
      <p className="body-text">{check.note}</p>
      <label>
        <textarea
          aria-label="Habit check answer"
          placeholder="What you actually did last week."
          rows={3}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !answer.trim()}
        onClick={async () => {
          setBusy(true);
          const res = await fetch(`/api/habit-check/${check.projectId}/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: check.id, answer: answer.trim() }),
          });
          setBusy(false);
          if (res.ok) {
            setProblem(null);
            setAnswer("");
            onAnswered();
            return;
          }
          const data = (await res.json()) as { error?: string };
          setProblem(data.error ?? "That did not work.");
        }}
      >
        Record it
      </button>
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}
