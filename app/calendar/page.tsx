"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Shell } from "../shell";

// Planning, seen two ways: the Content Backlog holds every piece with no
// date yet, and the calendar holds the ones that have one. Both read the
// same pieces, so a lifecycle move anywhere shows up here on the next load.
// A date here is a plan the Operator made. Nothing publishes from it.

interface PlannedPiece {
  id: number;
  title: string;
  status: string;
  projectName: string;
  docVersion: number;
  pinnedKitVersion: number | null;
  brandOutdated: boolean;
  plannedDate: string | null;
  operatorMoves: string[];
}

interface CalendarDay {
  date: string;
  pieces: PlannedPiece[];
}

const MOVE_LABELS: Record<string, string> = {
  plan: "Plan a date",
  unplan: "Unplan",
  export: "Export the bundle",
  reapprove: "Re-approve against the current kit",
  reopen: "Reopen to drafting",
};

// Only the moves that make sense from a planning screen; approving and
// requesting changes belong with the document, in Studio.
const PLANNING_MOVES = new Set(["plan", "unplan", "export", "reapprove"]);

function PieceRow({
  piece,
  onMoved,
}: {
  piece: PlannedPiece;
  onMoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [date, setDate] = useState("");

  const move = useCallback(
    async (action: string) => {
      setBusy(true);
      setProblem(null);
      try {
        const res = await fetch(`/api/pieces/${piece.id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "plan" ? { date } : {}),
        });
        const data = (await res.json()) as { message?: string; error?: string };
        if (!res.ok) throw new Error(data.message ?? data.error ?? "The move was refused");
        onMoved();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [date, onMoved, piece.id]
  );

  const moves = piece.operatorMoves.filter((m) => PLANNING_MOVES.has(m));

  return (
    <li className="connection-row">
      <div>
        <strong>{piece.title}</strong> <span className="tag">{piece.status}</span>{" "}
        <span className="tag">{piece.projectName}</span>{" "}
        {piece.brandOutdated && (
          <span className="tag tag-warn">brand-outdated — re-approve before export</span>
        )}
        <div className="body-text">
          doc v{piece.docVersion}
          {piece.pinnedKitVersion !== null ? ` · approved against kit v${piece.pinnedKitVersion}` : ""}
          {piece.plannedDate ? ` · planned for ${piece.plannedDate}` : " · undated"}
        </div>
        {problem && <p className="error-text">{problem}</p>}
      </div>
      <div>
        {moves.includes("plan") && (
          <label>
            <span className="tag">date</span>{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label={`Planned date for ${piece.title}`}
            />{" "}
          </label>
        )}
        {moves.map((action) => (
          <button
            key={action}
            className="action-quiet"
            disabled={busy || (action === "plan" && date === "")}
            onClick={() => void move(action)}
            style={{ marginLeft: "var(--space-1)" }}
          >
            {MOVE_LABELS[action] ?? action}
          </button>
        ))}
      </div>
    </li>
  );
}

export default function CalendarPage() {
  const [days, setDays] = useState<CalendarDay[] | null>(null);
  const [backlog, setBacklog] = useState<PlannedPiece[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [calendarRes, backlogRes] = await Promise.all([
        fetch("/api/pieces/calendar"),
        fetch("/api/pieces/backlog"),
      ]);
      if (!calendarRes.ok) throw new Error((await calendarRes.json()).error);
      if (!backlogRes.ok) throw new Error((await backlogRes.json()).error);
      setDays(((await calendarRes.json()) as { days: CalendarDay[] }).days);
      setBacklog(((await backlogRes.json()) as { pieces: PlannedPiece[] }).pieces);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = days !== null && days.length === 0 && backlog !== null && backlog.length === 0;

  return (
    <Shell>
      <section>
        <span className="tag">Planning</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Calendar
        </h1>
        <p className="body-text">
          A planned date is a plan you intend to act on. Nothing here publishes
          automatically, and nothing here is a queue. Only an approved piece takes a
          date, and only a planned piece can be exported.
        </p>

        {error && <p className="error-text">{error}</p>}
        {days === null && !error && <p className="body-text">Loading…</p>}

        {empty && (
          <EmptyState tag="Planning" title="Nothing planned, nothing waiting">
            <p>
              The calendar fills when an approved Creative Piece is given a date. The
              Content Backlog below holds every piece that has no date yet.
            </p>
          </EmptyState>
        )}

        {days !== null && days.length > 0 && (
          <>
            {days.map((day) => (
              <div key={day.date}>
                <h2 className="headline" style={{ fontSize: "1.1rem" }}>
                  {day.date}
                </h2>
                <ul className="connection-list">
                  {day.pieces.map((piece) => (
                    <PieceRow key={piece.id} piece={piece} onMoved={load} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}

        <hr className="hairline" />

        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Content Backlog
        </h2>
        <p className="body-text">Creative Pieces with no planned date yet.</p>
        {backlog !== null && backlog.length === 0 && (
          <p className="body-text">Nothing undated.</p>
        )}
        {backlog !== null && backlog.length > 0 && (
          <ul className="connection-list">
            {backlog.map((piece) => (
              <PieceRow key={piece.id} piece={piece} onMoved={load} />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
