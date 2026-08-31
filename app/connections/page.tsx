"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Shell } from "../shell";

interface HostConnection {
  id: number;
  kind: "oauth" | "static";
  label: string;
  clientId: string | null;
  scope: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<HostConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/hosts/connections");
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { connections: HostConnection[] };
      setConnections(data.connections);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mintToken(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch("/api/hosts/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { token: string };
      setMintedToken(data.token);
      setLabel("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/hosts/connections/${id}/revoke`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Shell>
      <section>
        <span className="tag">Hosts</span>
        <h1 className="headline" style={{ marginTop: "var(--space-2)" }}>
          AI Host connections
        </h1>
        <p className="body-text">
          Hosts connect through the MCP authorization flow (OAuth 2.1). Each grant is
          scoped to this workspace and revocable individually. For hosts without OAuth
          support, mint a scoped static token as a fallback.
        </p>

        <form onSubmit={mintToken} style={{ marginTop: "var(--space-4)" }}>
          <input
            className="field"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. local scripting host"
            aria-label="Static token label"
          />
          <button className="action-primary" style={{ marginTop: "var(--space-1)" }} type="submit">
            Mint static fallback token
          </button>
        </form>

        {mintedToken && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <p className="body-text">
              The token below is shown exactly once. Store it in the host&apos;s
              configuration now — it cannot be retrieved again, only revoked.
            </p>
            <p className="recovery-code">{mintedToken}</p>
            <button className="action-quiet" onClick={() => setMintedToken(null)}>
              I saved it — hide token
            </button>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <hr className="hairline" />

        {connections === null && <p className="body-text">Loading…</p>}

        {connections !== null && connections.length === 0 && (
          <EmptyState tag="Setup" title="No host connections yet">
            <p>
              Connect ChatGPT or Claude through their native connector flows by pointing
              them at this workspace&apos;s MCP endpoint, or mint a static fallback token
              above. Connections appear here and can be revoked individually.
            </p>
          </EmptyState>
        )}

        {connections !== null && connections.length > 0 && (
          <ul className="connection-list">
            {connections.map((c) => (
              <li key={c.id} className="connection-row">
                <div>
                  <strong>{c.label}</strong>{" "}
                  <span className="tag">{c.kind === "oauth" ? "OAuth grant" : "Static token"}</span>{" "}
                  <span className="tag">{c.status}</span>
                  <div className="body-text">
                    Connected {new Date(c.createdAt).toLocaleString()}
                    {c.lastUsedAt && ` · last used ${new Date(c.lastUsedAt).toLocaleString()}`}
                    {c.revokedAt && ` · revoked ${new Date(c.revokedAt).toLocaleString()}`}
                  </div>
                </div>
                {c.status === "active" && (
                  <button className="action-quiet" onClick={() => revoke(c.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
