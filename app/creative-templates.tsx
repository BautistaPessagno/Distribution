"use client";

import { useState } from "react";
import { usePieceAction } from "./piece-moves";

// Creative Templates in the dashboard: saving a piece's layout as one, and
// seeing what has been saved. A template is the structure without the
// campaign, so nothing here shows copy or captions — there is none to show.

export interface CreativeTemplateRow {
  id: number;
  name: string;
  format: string;
  slides: number;
  layers: number;
  fromPieceId: number | null;
  projectName: string;
  createdAt: string;
}

/**
 * Saving is a read of the piece: it writes a stripped copy alongside and
 * leaves the piece exactly where it was, whatever its status.
 */
export function SaveAsTemplate({
  piece,
  onSaved,
}: {
  piece: { id: number; title: string };
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const { run, busy, note, problem } = usePieceAction(piece.id, () => {
    setName("");
    onSaved();
  });

  return (
    <div style={{ marginTop: "var(--space-1)" }}>
      <label>
        <span className="tag">template name</span>{" "}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${piece.title} layout`}
          aria-label={`Template name for ${piece.title}`}
        />
      </label>{" "}
      <button
        className="action-quiet"
        disabled={busy}
        onClick={() => void run("save-as-template", name.trim() ? { name: name.trim() } : {})}
      >
        Save layout as a Creative Template
      </button>
      {note && <p className="body-text">{note}</p>}
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

export function TemplateList({ templates }: { templates: CreativeTemplateRow[] | null }) {
  if (templates === null) return null;
  return (
    <>
      <hr className="hairline" />
      <h2 className="headline" style={{ fontSize: "1.1rem" }}>
        Creative Templates
      </h2>
      <p className="body-text">
        Layout and Brand Kit token references, without the campaign that produced them.
        A host starts a new backlog piece from one with{" "}
        <span className="mono">marketingos.instantiate_template</span>.
      </p>
      {templates.length === 0 ? (
        <p className="body-text">No templates saved yet.</p>
      ) : (
        <ul className="connection-list">
          {templates.map((t) => (
            <li key={t.id} className="connection-row">
              <div>
                <strong>{t.name}</strong> <span className="tag">{t.format}</span>{" "}
                <span className="tag">{t.projectName}</span>
                <div className="body-text">
                  {t.slides} slide{t.slides === 1 ? "" : "s"} · {t.layers} layer
                  {t.layers === 1 ? "" : "s"}
                  {t.fromPieceId !== null ? ` · from piece #${t.fromPieceId}` : ""} ·{" "}
                  {new Date(t.createdAt).toLocaleString()}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
