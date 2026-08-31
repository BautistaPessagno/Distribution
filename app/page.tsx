"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApprovalInterruption, pendingOf, useApprovals } from "./approvals";
import { PieceMoves } from "./piece-moves";
import { EmptyState, Shell } from "./shell";

// The Today view (ticket 07's decision): what is planned, what is waiting
// undated, and the lifecycle state of both. The guided rail that orders the
// day's work into one step at a time is ticket 27; this is the standing
// picture the rail will sit above.
//
// A date here is a plan the Operator made. Nothing on this page publishes.

interface TodayPiece {
  id: number;
  title: string;
  status: string;
  projectName: string;
  brandOutdated: boolean;
  plannedDate: string | null;
  operatorMoves: string[];
}

interface CalendarDay {
  date: string;
  pieces: TodayPiece[];
}

const TODAY_MOVES = ["reapprove", "unplan", "export"] as const;
const UPCOMING_DAYS = 5;
const BACKLOG_SHOWN = 5;

function PieceLine({ piece, onMoved }: { piece: TodayPiece; onMoved: () => void }) {
  return (
    <li className="connection-row">
      <div>
        <strong>{piece.title}</strong> <span className="tag">{piece.status}</span>{" "}
        <span className="tag">{piece.projectName}</span>{" "}
        {piece.brandOutdated && (
          <span className="tag tag-warn">brand-outdated — re-approve before export</span>
        )}
      </div>
      <PieceMoves piece={piece} only={TODAY_MOVES} onMoved={onMoved} />
    </li>
  );
}

export default function Home() {
  const [days, setDays] = useState<CalendarDay[] | null>(null);
  const [backlog, setBacklog] = useState<TodayPiece[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approvals = useApprovals();

  const load = useCallback(async () => {
    try {
      const [calendarRes, backlogRes] = await Promise.all([
        fetch("/api/pieces/calendar"),
        fetch("/api/pieces/backlog"),
      ]);
      if (!calendarRes.ok || !backlogRes.ok) throw new Error("Could not read the plan");
      setDays(((await calendarRes.json()) as { days: CalendarDay[] }).days);
      setBacklog(((await backlogRes.json()) as { pieces: TodayPiece[] }).pieces);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nothingYet =
    days !== null &&
    days.length === 0 &&
    backlog !== null &&
    backlog.length === 0 &&
    pendingOf(approvals.changes).length === 0;

  return (
    <Shell>
      <section>
        <span className="tag">Today</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Today
        </h1>

        {/* Above the rail, deliberately: an approval is an interruption a
            host caused, not a step you planned. */}
        <ApprovalInterruption changes={approvals.changes} onDecided={approvals.reload} />

        {error && <p className="error-text">{error}</p>}

        {nothingYet && (
          <>
            <EmptyState tag="Setup" title="Nothing on the rail yet">
              <p>
                The guided rail fills with the day&apos;s marketing work once MarketingOS
                is set up. Setup starts by connecting your first project: register a
                Connected Project, then link an AI Host to the MCP endpoint at{" "}
                <span className="mono">/mcp</span> and call{" "}
                <span className="mono">marketingos.onboard</span>.
              </p>
              <p>Connect a project to put setup on the rail as your next action.</p>
            </EmptyState>
            <hr className="hairline" />
            <Link
              className="action-primary"
              href="/projects"
              style={{ textDecoration: "none", display: "inline-block" }}
            >
              Start setup: connect a project
            </Link>
          </>
        )}

        {days !== null && days.length > 0 && (
          <>
            <h2 className="headline" style={{ fontSize: "1.1rem" }}>
              Planned
            </h2>
            <p className="body-text">
              A planned date is a plan you intend to act on. Nothing here publishes
              automatically.
            </p>
            {days.slice(0, UPCOMING_DAYS).map((day) => (
              <div key={day.date}>
                <p className="body-text">
                  <strong>{day.date}</strong>
                </p>
                <ul className="connection-list">
                  {day.pieces.map((piece) => (
                    <PieceLine key={piece.id} piece={piece} onMoved={load} />
                  ))}
                </ul>
              </div>
            ))}
            {days.length > UPCOMING_DAYS && (
              <p className="body-text">
                <Link href="/calendar">
                  {days.length - UPCOMING_DAYS} more planned day
                  {days.length - UPCOMING_DAYS === 1 ? "" : "s"} on the calendar
                </Link>
              </p>
            )}
            <hr className="hairline" />
          </>
        )}

        {backlog !== null && backlog.length > 0 && (
          <>
            <h2 className="headline" style={{ fontSize: "1.1rem" }}>
              Content Backlog
            </h2>
            <p className="body-text">
              Creative Pieces with no planned date yet. Approve a piece in{" "}
              <Link href="/studio">Studio</Link>, then give it a date on the{" "}
              <Link href="/calendar">calendar</Link>.
            </p>
            <ul className="connection-list">
              {backlog.slice(0, BACKLOG_SHOWN).map((piece) => (
                <PieceLine key={piece.id} piece={piece} onMoved={load} />
              ))}
            </ul>
            {backlog.length > BACKLOG_SHOWN && (
              <p className="body-text">
                <Link href="/calendar">
                  {backlog.length - BACKLOG_SHOWN} more undated piece
                  {backlog.length - BACKLOG_SHOWN === 1 ? "" : "s"}
                </Link>
              </p>
            )}
          </>
        )}
      </section>
    </Shell>
  );
}
