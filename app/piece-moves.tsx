"use client";

import { useCallback, useState } from "react";

// The Operator's lifecycle moves, in one place. Which moves a piece can take
// is decided server-side and arrives on the piece as `operatorMoves`; this
// component only knows how to label them, collect what they need, and post
// them. Studio and the calendar both render it, so adding a move means
// touching the server's move map and this file — not every screen.

export interface MovablePiece {
  id: number;
  title: string;
  status: string;
  operatorMoves: string[];
}

const MOVE_LABELS: Record<string, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  reapprove: "Re-approve against the current kit",
  plan: "Plan a date",
  unplan: "Unplan",
  export: "Export the bundle",
  reopen: "Reopen to drafting",
};

/** The only move that needs anything typed in before it can be sent. */
const NEEDS_DATE = "plan";

/**
 * Posting one act on one piece: the busy flag, the note it answers with, and
 * the refusal message it answers with instead. Every screen that acts on a
 * piece goes through this, so a refusal reads the same everywhere.
 */
export function usePieceAction(pieceId: number, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      setBusy(true);
      setProblem(null);
      setNote(null);
      try {
        const res = await fetch(`/api/pieces/${pieceId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          message?: string;
          error?: string;
          note?: string;
        };
        if (!res.ok) throw new Error(data.message ?? data.error ?? "The action was refused");
        setNote(data.note ?? null);
        onDone();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onDone, pieceId]
  );

  return { run, busy, note, problem };
}

export function PieceMoves({
  piece,
  only,
  onMoved,
}: {
  piece: MovablePiece;
  /** Restrict to a subset of moves; omit to offer every move that applies. */
  only?: readonly string[];
  onMoved: () => void;
}) {
  const [date, setDate] = useState("");
  const { run, busy, note, problem } = usePieceAction(piece.id, onMoved);
  const move = (action: string) => run(action, action === NEEDS_DATE ? { date } : {});

  const moves = only
    ? piece.operatorMoves.filter((m) => only.includes(m))
    : piece.operatorMoves;

  return (
    <div>
      {moves.includes(NEEDS_DATE) && (
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
          disabled={busy || (action === NEEDS_DATE && date === "")}
          onClick={() => void move(action)}
          style={{ marginRight: "var(--space-1)" }}
        >
          {MOVE_LABELS[action] ?? action}
        </button>
      ))}
      {moves.length === 0 && <p className="body-text">No move applies while {piece.status}.</p>}
      {note && <p className="body-text">{note}</p>}
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}
