"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// The first-run rail. One step on screen, one action in it. Everything the
// rail knows about the other steps stays behind the current one on purpose:
// a first run that shows all of it at once is a survey, not a start.
//
// The done screen says what setup did not do, because that is the promise
// the rest of the system rests on.

export interface SetupStepState {
  step: string;
  position: number;
  title: string;
  action: string;
  why: string;
  href: string;
  copyable: string | null;
  done: boolean;
  doneDetail: string | null;
  skipped: boolean;
  skippedAt: string | null;
  writesToProject: boolean;
}

export interface SetupRail {
  steps: SetupStepState[];
  current: SetupStepState | null;
  complete: boolean;
  skipped: string[];
  doneMessage: string;
  note: string;
}

export function useSetupRail() {
  const [rail, setRail] = useState<SetupRail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/setup");
      const data = (await res.json()) as { rail?: SetupRail; error?: string };
      if (!res.ok) throw new Error(data.error);
      setRail(data.rail ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { rail, error, reload: load };
}

/** The one thing to copy, with the copying done for you. */
function Copyable({ text }: { text: string }) {
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
            // Clipboard access can be refused; the text is on screen either way.
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function SetupRailPanel({ rail, onChanged }: { rail: SetupRail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const move = useCallback(
    async (step: string, path: "skip" | "resume") => {
      setBusy(true);
      await fetch(`/api/setup/${step}/${path}`, { method: "POST" });
      setBusy(false);
      onChanged();
    },
    [onChanged]
  );

  if (rail.complete) {
    return (
      <section>
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Setup is done
        </h2>
        {/* The promise the rest of the system rests on, said before handing off. */}
        <p className="body-text">{rail.doneMessage}</p>
      </section>
    );
  }

  const done = rail.steps.filter((s) => s.done).length;

  return (
    <section>
      <h2 className="headline" style={{ fontSize: "1.1rem" }}>
        Setup
      </h2>
      <p className="body-text">
        <span className="tag">
          {done} of {rail.steps.length} done
        </span>{" "}
        {rail.note}
      </p>

      {rail.current ? (
        <div className="connection-card">
          <div>
            <span className="tag">step {rail.current.position}</span>{" "}
            <strong>{rail.current.title}</strong>
          </div>
          <p className="body-text">{rail.current.action}</p>
          <p className="body-text">{rail.current.why}</p>
          {rail.current.copyable && <Copyable text={rail.current.copyable} />}
          <Link className="shell-nav-link" href={rail.current.href}>
            Go there
          </Link>{" "}
          <button disabled={busy} onClick={() => void move(rail.current!.step, "skip")}>
            Skip for now
          </button>
        </div>
      ) : (
        <p className="body-text">
          Nothing left on the rail. {rail.skipped.length > 0 && "The steps you passed over are below."}
        </p>
      )}

      {/* Passed over, still here, one action from coming back. */}
      {rail.skipped.length > 0 && (
        <div className="body-text">
          <strong>Skipped</strong>
          <ul>
            {rail.steps
              .filter((s) => s.skipped)
              .map((step) => (
                <li key={step.step}>
                  <span className="tag tag-warn">skipped</span> {step.title}
                  {step.skippedAt && ` — ${new Date(step.skippedAt).toLocaleString()}`}{" "}
                  <button disabled={busy} onClick={() => void move(step.step, "resume")}>
                    Pick it back up
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
