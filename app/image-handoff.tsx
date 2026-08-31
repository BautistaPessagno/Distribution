"use client";

import { useCallback, useRef, useState } from "react";

// The Operator's side of the image handoff. MarketingOS does not generate
// images; an AI Host does and hands the result back. When it cannot — no
// binary payload, or a file over the inline cap — the piece says
// "prompt prepared" and this is where the Operator finishes the job by
// hand. The upload records the same lineage the inline path would have.

export interface HandoffPiece {
  id: number;
  projectId: number;
  title: string;
  imageState: string | null;
}

const ATTACHED = "asset_attached:";

export function imageStateLabel(state: string | null): { text: string; tag: string } | null {
  if (state === null) return null;
  if (state === "prompt_prepared") {
    return { text: "prompt prepared — waiting on a manual upload", tag: "tag-warn" };
  }
  if (state.startsWith(ATTACHED)) {
    return { text: `image attached · ${state.slice(ATTACHED.length)}`, tag: "tag-good" };
  }
  return { text: state, tag: "" };
}

async function readAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function ImageHandoff({
  piece,
  onUploaded,
}: {
  piece: HandoffPiece;
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const label = imageStateLabel(piece.imageState);
  const waiting = piece.imageState === "prompt_prepared";

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setNote(null);
      setProblem(null);
      try {
        const res = await fetch("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: piece.projectId,
            pieceId: piece.id,
            bytesBase64: await readAsBase64(file),
          }),
        });
        const data = (await res.json()) as { note?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "The upload was refused");
        setNote(data.note ?? null);
        if (inputRef.current) inputRef.current.value = "";
        onUploaded();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onUploaded, piece.id, piece.projectId]
  );

  return (
    <div className="body-text" style={{ marginTop: "var(--space-1)" }}>
      <strong>Image</strong>{" "}
      {label ? (
        <span className={`tag ${label.tag}`}>{label.text}</span>
      ) : (
        <span className="tag">no image handoff yet</span>
      )}
      {waiting && (
        <p>
          The AI Host prepared a prompt but could not send the file. Upload it here;
          MarketingOS records the same lineage it would have, and never claims it
          generated the image.
        </p>
      )}
      <label>
        <span className="tag">file</span>{" "}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          aria-label={`Upload an image for ${piece.title}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>
      {busy && <p>Uploading…</p>}
      {note && <p>{note}</p>}
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}
