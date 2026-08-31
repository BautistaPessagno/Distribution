"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Shell } from "../shell";

interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface ConformanceReport {
  passed: boolean;
  contractVersion: string;
  ranAt: string;
  checks: ConformanceCheck[];
}

interface ConnectedProject {
  id: number;
  name: string;
  baseUrl: string;
  status: "healthy" | "unhealthy";
  tokenVersion: number;
  lastConformanceAt: string | null;
  lastConformanceReport: ConformanceReport | null;
  createdAt: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ConnectedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { projects: ConnectedProject[] };
      setProjects(data.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseUrl }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { token: string };
      setMintedToken(data.token);
      setName("");
      setBaseUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rerunConformance(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${id}/conformance`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rotateToken(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${id}/rotate-token`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { token: string };
      setMintedToken(data.token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Shell>
      <section>
        <span className="tag">Setup</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          Connected Projects
        </h1>
        <p className="body-text">
          Registering a Connected Project mints a dedicated scoped service token and runs
          the conformance suite against the project domain. A project becomes usable only
          after every conformance check passes. In development, a stub project domain is
          served at <code>/stub-project</code>.
        </p>

        <form onSubmit={register} style={{ marginTop: "var(--space-4)" }}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name, e.g. Dev Stub"
            aria-label="Project name"
          />
          <input
            className="field"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Project domain URL, e.g. http://localhost:3000/stub-project"
            aria-label="Project domain URL"
            style={{ marginTop: "var(--space-1)" }}
          />
          <button
            className="action-primary"
            style={{ marginTop: "var(--space-1)" }}
            type="submit"
            disabled={busy}
          >
            {busy ? "Registering…" : "Register project"}
          </button>
        </form>

        {mintedToken && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <p className="body-text">
              The service token below is shown exactly once. Configure it in the project
              domain now — it cannot be retrieved again, only rotated.
            </p>
            <p className="recovery-code">{mintedToken}</p>
            <button className="action-quiet" onClick={() => setMintedToken(null)}>
              I saved it — hide token
            </button>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <hr className="hairline" />

        {projects === null && <p className="body-text">Loading…</p>}

        {projects !== null && projects.length === 0 && (
          <EmptyState tag="Setup" title="No Connected Projects yet">
            <p>
              No Connected Projects exist yet. Registering a project gives MarketingOS its
              facts, brand, audience, goals, and constraints, and unlocks the project
              switcher. This is the first setup step.
            </p>
          </EmptyState>
        )}

        {projects !== null && projects.length > 0 && (
          <ul className="connection-list">
            {projects.map((p) => (
              <li key={p.id} className="connection-row">
                <div>
                  <strong>{p.name}</strong>{" "}
                  <span className="tag">{p.status}</span>{" "}
                  <span className="tag">token v{p.tokenVersion}</span>
                  <div className="body-text">
                    {p.baseUrl}
                    {p.lastConformanceAt &&
                      ` · conformance ${new Date(p.lastConformanceAt).toLocaleString()}`}
                  </div>
                  {p.status === "unhealthy" && (
                    <p className="error-text">
                      This project failed conformance and is unusable until every check
                      passes.
                    </p>
                  )}
                  {p.lastConformanceReport && (
                    <ul className="body-text" style={{ marginTop: "var(--space-1)" }}>
                      {p.lastConformanceReport.checks.map((c) => (
                        <li key={c.name}>
                          {c.passed ? "pass" : "FAIL"} — {c.name} ({c.detail})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <button className="action-quiet" onClick={() => rerunConformance(p.id)}>
                    Re-run conformance
                  </button>{" "}
                  <button className="action-quiet" onClick={() => rotateToken(p.id)}>
                    Rotate token
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
