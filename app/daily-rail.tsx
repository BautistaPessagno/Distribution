"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// The daily rail. One step on screen, from what is actually due — and when
// nothing is due, the screen says so rather than filling itself.
//
// Pending digests sit above the rail, unnumbered. A host proposing a write
// is something that happened to the Operator, not something they planned,
// and numbering it among the day's work would file it as the latter.

export interface RailStep {
  position: number;
  kind: string;
  title: string;
  prompt: string | null;
  instruction: string | null;
  href: string;
  subject: { kind: string; id: number | null };
  proofRequirement: string | null;
}

export interface Interruption {
  digest: string;
  projectName: string;
  summary: string;
  operations: number;
  href: string;
  why: string;
}

export interface DailyRail {
  steps: RailStep[];
  current: RailStep | null;
  interruptions: Interruption[];
  emptyMessage: string | null;
  note: string;
}

export function useDailyRail(goal = "positioning") {
  const [rail, setRail] = useState<DailyRail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/rail?goal=${encodeURIComponent(goal)}`);
      const data = (await res.json()) as { rail?: DailyRail; error?: string };
      if (!res.ok) throw new Error(data.error);
      setRail(data.rail ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [goal]);

  useEffect(() => {
    void load();
  }, [load]);

  return { rail, error, reload: load };
}

function CopyablePrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="body-text">
      <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            // The prompt is on screen either way.
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy the prompt"}
      </button>
    </div>
  );
}

export function DailyRailPanel({ rail }: { rail: DailyRail }) {
  // Everything past the current step is held back on purpose; the count is
  // there so the day has a shape without becoming a list to work through.
  const [showRest, setShowRest] = useState(false);
  const rest = rail.steps.slice(1);

  return (
    <section>
      {/* Outside the rail, above it, and unnumbered. */}
      {rail.interruptions.map((interruption) => (
        <div className="connection-card" key={interruption.digest}>
          <div>
            <span className="tag tag-warn">waiting on you</span>{" "}
            <strong>{interruption.summary}</strong>{" "}
            <span className="tag">{interruption.projectName}</span>{" "}
            <span className="tag">
              {interruption.operations} {interruption.operations === 1 ? "change" : "changes"}
            </span>
          </div>
          <p className="body-text">{interruption.why}</p>
          <Link className="shell-nav-link" href={interruption.href}>
            Read the diff
          </Link>
        </div>
      ))}

      <h2 className="headline" style={{ fontSize: "1.1rem" }}>
        Today&rsquo;s rail
      </h2>

      {rail.emptyMessage ? (
        <p className="body-text">{rail.emptyMessage}</p>
      ) : (
        <>
          <p className="body-text">
            <span className="tag">
              {rail.steps.length} {rail.steps.length === 1 ? "step" : "steps"}
            </span>{" "}
            {rail.note}
          </p>

          {rail.current && (
            <div className="connection-card">
              <div>
                <span className="tag">step {rail.current.position}</span>{" "}
                <strong>{rail.current.title}</strong>
              </div>
              {rail.current.prompt && <CopyablePrompt text={rail.current.prompt} />}
              {rail.current.instruction && (
                <p className="body-text">{rail.current.instruction}</p>
              )}
              {rail.current.proofRequirement && (
                <p className="body-text">
                  <span className="tag">proof</span> {rail.current.proofRequirement}
                </p>
              )}
              <Link className="shell-nav-link" href={rail.current.href}>
                Go there
              </Link>
            </div>
          )}

          {rest.length > 0 && (
            <p className="body-text">
              <button className="action-quiet" onClick={() => setShowRest(!showRest)}>
                {showRest ? "Hide" : `${rest.length} more after this`}
              </button>
              {showRest && (
                <ul>
                  {rest.map((step) => (
                    <li key={step.position}>
                      {step.position}. {step.title}
                    </li>
                  ))}
                </ul>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
