"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Shell } from "../shell";
import {
  FORMAT_DIMENSIONS,
  SlideView,
  type BrandTokens,
  type RenderLayer,
  type RenderDoc,
} from "../../render/piece-slide";

type PieceLayer = RenderLayer;
type PieceDoc = RenderDoc;

// Live preview: Studio renders the same SlideView component the server-side
// PNG export screenshots, scaled down to fit the page. The Brand Kit tokens
// are passed in at render time, so changing a token repaints the piece
// without its stored document changing at all.
const PREVIEW_WIDTH = 320;

function SlidePreview({
  doc,
  index,
  tokens,
}: {
  doc: PieceDoc;
  index: number;
  tokens: BrandTokens;
}) {
  const { width, height } = FORMAT_DIMENSIONS[doc.format] ?? FORMAT_DIMENSIONS["1:1"];
  const scale = PREVIEW_WIDTH / width;
  return (
    <div
      style={{
        width: PREVIEW_WIDTH,
        height: Math.round(height * scale),
        overflow: "hidden",
        border: "1px solid var(--line, #ccc)",
      }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <SlideView slide={doc.slides[index]} format={doc.format} tokens={tokens} />
      </div>
    </div>
  );
}

interface BrandKit {
  projectId: number;
  version: number;
  tokens: BrandTokens;
  actor: string;
  summary: string;
  createdAt: string;
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
  kit: BrandKit;
}

interface PieceVersion {
  version: number;
  actor: string;
  summary: string;
  createdAt: string;
}

interface CheckFinding {
  code: string;
  severity: "error" | "warning" | "advisory";
  slide: number;
  layer: number | null;
  where: string;
  message: string;
}

interface CheckReports {
  brand: { kitVersion: number; docVersion: number; errors: CheckFinding[]; warnings: CheckFinding[] };
  quality: { docVersion: number; advisory: true; findings: CheckFinding[] };
}

function layerLabel(layer: PieceLayer): string {
  switch (layer.type) {
    case "text":
      return `text${layer.role ? ` (${layer.role})` : ""}: ${layer.text ?? ""}${
        layer.color ? ` · colour ${layer.color}` : ""
      }${layer.font ? ` · font ${layer.font}` : ""}`;
    case "image":
      return `image: ${layer.ref ?? ""}${layer.alt ? ` — ${layer.alt}` : ""}`;
    case "shape":
      return `shape: ${layer.shape ?? ""}${layer.fill ? `, fill ${layer.fill}` : ""}`;
    case "logo":
      return `logo${layer.variant ? `: ${layer.variant}` : ""}`;
  }
}

// The Brand Kit panel: token references are what pieces hold, so this is the
// one place a colour or family is actually written down.
function BrandKitPanel({
  kit,
  onChanged,
}: {
  kit: BrandKit;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<BrandTokens>(kit.tokens);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setDraft(kit.tokens);
  }, [kit]);

  const dirty = Object.keys(draft).some((name) => draft[name] !== kit.tokens[name]);

  const save = useCallback(async () => {
    setSaving(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/brand-kits/${kit.projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: draft }),
      });
      const data = (await res.json()) as { error?: string; detail?: string[] };
      if (!res.ok) throw new Error([data.error, ...(data.detail ?? [])].filter(Boolean).join(" "));
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, kit.projectId, onChanged]);

  return (
    <div className="body-text">
      <strong>Brand Kit</strong> <span className="tag">v{kit.version}</span>
      <p>
        Pieces reference these token names; only the kit holds the values. Changing a
        token repaints backlog and drafting pieces without touching a stored document.
      </p>
      <ul>
        {Object.keys(kit.tokens)
          .sort()
          .map((name) => (
            <li key={name}>
              <label>
                <span className="mono">{name}</span>{" "}
                <input
                  value={draft[name] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
                  aria-label={name}
                />
              </label>{" "}
              {name.startsWith("brand.") && (
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "1em",
                    height: "1em",
                    verticalAlign: "middle",
                    border: "1px solid var(--line, #ccc)",
                    background: draft[name],
                  }}
                />
              )}
            </li>
          ))}
      </ul>
      <button className="action-quiet" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save Brand Kit"}
      </button>
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

function FindingList({ findings, tag }: { findings: CheckFinding[]; tag: string }) {
  return (
    <ul>
      {findings.map((f, i) => (
        <li key={`${f.code}-${i}`}>
          <span className={`tag ${tag}`}>{f.severity}</span> {f.message}
        </li>
      ))}
    </ul>
  );
}

function ChecksPanel({ checks }: { checks: CheckReports | null }) {
  if (!checks) return <p className="body-text">Running checks…</p>;
  const { brand, quality } = checks;
  return (
    <div className="body-text">
      <strong>Checks</strong>{" "}
      <span className="tag">doc v{brand.docVersion}</span>{" "}
      <span className="tag">kit v{brand.kitVersion}</span>
      <p>
        <strong>check_brand</strong>{" "}
        <span className={brand.errors.length ? "tag tag-bad" : "tag tag-good"}>
          {brand.errors.length} error{brand.errors.length === 1 ? "" : "s"}
        </span>{" "}
        <span className="tag tag-warn">
          {brand.warnings.length} warning{brand.warnings.length === 1 ? "" : "s"}
        </span>{" "}
        — errors block approval.
      </p>
      {brand.errors.length > 0 && <FindingList findings={brand.errors} tag="tag-bad" />}
      {brand.warnings.length > 0 && <FindingList findings={brand.warnings} tag="tag-warn" />}
      {brand.errors.length === 0 && brand.warnings.length === 0 && <p>Nothing off-kit.</p>}
      <p>
        <strong>check_quality</strong>{" "}
        <span className="tag tag-info">advisory only — never blocks</span>{" "}
        <span className="tag">
          {quality.findings.length} finding{quality.findings.length === 1 ? "" : "s"}
        </span>
      </p>
      {quality.findings.length > 0 ? (
        <FindingList findings={quality.findings} tag="tag-info" />
      ) : (
        <p>No quality findings.</p>
      )}
    </div>
  );
}

export default function StudioPage() {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PieceVersion[] | null>(null);
  const [checks, setChecks] = useState<CheckReports | null>(null);

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

  const loadChecks = useCallback(async (id: number) => {
    setChecks(null);
    try {
      const res = await fetch(`/api/pieces/${id}/checks`);
      if (!res.ok) throw new Error((await res.json()).error);
      setChecks((await res.json()) as CheckReports);
    } catch {
      setChecks(null);
    }
  }, []);

  const toggleOpen = useCallback(
    async (id: number, current: number | null) => {
      if (current === id) {
        setOpenId(null);
        setVersions(null);
        setChecks(null);
        return;
      }
      setOpenId(id);
      setVersions(null);
      void loadChecks(id);
      try {
        const res = await fetch(`/api/pieces/${id}/versions`);
        if (!res.ok) throw new Error((await res.json()).error);
        const data = (await res.json()) as { versions: PieceVersion[] };
        setVersions(data.versions);
      } catch {
        setVersions([]);
      }
    },
    [loadChecks]
  );

  // A kit change repaints every piece of that project and re-runs its checks;
  // no document changed, so version history is untouched.
  const kitChanged = useCallback(() => {
    void load();
    if (openId !== null) void loadChecks(openId);
  }, [load, loadChecks, openId]);

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
                    {p.docVersion} · kit v{p.kit.version} · snapshot{" "}
                    <span className="mono">{p.snapshot}</span> ·{" "}
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                  {openId === p.id && (
                    <div style={{ marginTop: "var(--space-1)" }}>
                      {p.doc.slides.map((slide, i) => (
                        <div key={i} className="body-text">
                          <strong>Slide {i + 1}</strong>
                          <SlidePreview doc={p.doc} index={i} tokens={p.kit.tokens} />
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
                      <ChecksPanel checks={checks} />
                      <BrandKitPanel kit={p.kit} onChanged={kitChanged} />
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
