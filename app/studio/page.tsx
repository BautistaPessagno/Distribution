"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Shell } from "../shell";

interface PieceLayer {
  type: "text" | "image" | "shape" | "logo";
  text?: string;
  role?: string;
  ref?: string;
  alt?: string;
  shape?: string;
  fill?: string;
  variant?: string;
}

interface PieceDoc {
  format: string;
  slides: { layers: PieceLayer[] }[];
  captions: Record<string, string>;
}

interface Piece {
  id: number;
  projectId: number;
  projectName: string;
  title: string;
  status: string;
  snapshot: string;
  doc: PieceDoc;
  docVersion: number;
  createdAt: string;
}

interface PieceVersion {
  version: number;
  actor: string;
  summary: string;
  createdAt: string;
}

function layerLabel(layer: PieceLayer): string {
  switch (layer.type) {
    case "text":
      return `text${layer.role ? ` (${layer.role})` : ""}: ${layer.text ?? ""}`;
    case "image":
      return `image: ${layer.ref ?? ""}${layer.alt ? ` — ${layer.alt}` : ""}`;
    case "shape":
      return `shape: ${layer.shape ?? ""}${layer.fill ? `, fill ${layer.fill}` : ""}`;
    case "logo":
      return `logo${layer.variant ? `: ${layer.variant}` : ""}`;
  }
}

export default function StudioPage() {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PieceVersion[] | null>(null);

  const toggleOpen = useCallback(async (id: number, current: number | null) => {
    if (current === id) {
      setOpenId(null);
      setVersions(null);
      return;
    }
    setOpenId(id);
    setVersions(null);
    try {
      const res = await fetch(`/api/pieces/${id}/versions`);
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { versions: PieceVersion[] };
      setVersions(data.versions);
    } catch {
      setVersions([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pieces");
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { pieces: Piece[] };
      setPieces(data.pieces);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell>
      <section>
        <span className="tag">Creative work</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Studio
        </h1>
        <p className="body-text">
          Studio holds Creative Pieces: versioned, multi-slide compositions bound to the
          Project Snapshot pinned when they were created. Each piece moves through
          backlog, drafting, review, approved, planned, exported, and measured.
        </p>

        {error && <p className="error-text">{error}</p>}

        {pieces === null && !error && <p className="body-text">Loading…</p>}

        {pieces !== null && pieces.length === 0 && (
          <EmptyState tag="Creative work" title="No Creative Pieces yet">
            <p>
              Studio populates when an AI Host drafts a piece through the MCP gateway
              (marketingos.create_piece), or when you start one from a Creative Template.
            </p>
          </EmptyState>
        )}

        {pieces !== null && pieces.length > 0 && (
          <ul className="connection-list">
            {pieces.map((p) => (
              <li key={p.id} className="connection-row">
                <div>
                  <strong>{p.title}</strong> <span className="tag">{p.status}</span>{" "}
                  <span className="tag">{p.doc.format}</span>{" "}
                  <span className="tag">{p.projectName}</span>
                  <div className="body-text">
                    {p.doc.slides.length} slide{p.doc.slides.length === 1 ? "" : "s"} · doc v
                    {p.docVersion} · snapshot <span className="mono">{p.snapshot}</span> ·{" "}
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                  {openId === p.id && (
                    <div style={{ marginTop: "var(--space-1)" }}>
                      {p.doc.slides.map((slide, i) => (
                        <div key={i} className="body-text">
                          <strong>Slide {i + 1}</strong>
                          <ul>
                            {slide.layers.map((layer, j) => (
                              <li key={j}>{layerLabel(layer)}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      <div className="body-text">
                        <strong>Captions</strong>
                        <ul>
                          {Object.entries(p.doc.captions).map(([network, caption]) => (
                            <li key={network}>
                              {network}: {caption || "—"}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="body-text">
                        <strong>Version history</strong>
                        {versions === null && <p>Loading history…</p>}
                        {versions !== null && (
                          <ul>
                            {versions.map((v) => (
                              <li key={v.version}>
                                v{v.version} · {v.actor} · {v.summary} ·{" "}
                                {new Date(v.createdAt).toLocaleString()}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <button
                    className="action-quiet"
                    onClick={() => void toggleOpen(p.id, openId)}
                  >
                    {openId === p.id ? "Hide document" : "View document"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
