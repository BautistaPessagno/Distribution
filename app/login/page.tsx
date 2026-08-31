"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

type Phase = "loading" | "first-run" | "sign-in" | "recovery-shown";

// Same-origin relative paths only, so ?next= can never redirect off-site.
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

export default function LoginPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryInput, setRecoveryInput] = useState("");

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((status: { operatorExists: boolean; authenticated: boolean }) => {
        if (status.authenticated) {
          window.location.href = nextPath();
          return;
        }
        setPhase(status.operatorExists ? "sign-in" : "first-run");
      })
      .catch(() => setError("Could not reach the server"));
  }, []);

  async function register() {
    setError(null);
    try {
      const optionsRes = await fetch("/api/auth/register/options", { method: "POST" });
      if (!optionsRes.ok) throw new Error((await optionsRes.json()).error);
      const attestation = await startRegistration({ optionsJSON: await optionsRes.json() });
      const verifyRes = await fetch("/api/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestation),
      });
      if (!verifyRes.ok) throw new Error((await verifyRes.json()).error);
      const { recoveryCode: code } = (await verifyRes.json()) as { recoveryCode: string };
      setRecoveryCode(code);
      setPhase("recovery-shown");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function signIn() {
    setError(null);
    try {
      const optionsRes = await fetch("/api/auth/login/options", { method: "POST" });
      if (!optionsRes.ok) throw new Error((await optionsRes.json()).error);
      const assertion = await startAuthentication({ optionsJSON: await optionsRes.json() });
      const verifyRes = await fetch("/api/auth/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assertion),
      });
      if (!verifyRes.ok) throw new Error((await verifyRes.json()).error);
      window.location.href = nextPath();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function recover(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch("/api/auth/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: recoveryInput }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      window.location.href = nextPath();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="login-box">
      <h1 className="headline">MarketingOS</h1>
      <hr className="hairline" />

      {phase === "loading" && <p>Loading…</p>}

      {phase === "first-run" && (
        <>
          <p className="body-text">
            No Operator account exists yet. Create the sole Operator account with a
            passkey. You will be shown a recovery code exactly once.
          </p>
          <button className="action-primary" onClick={register}>
            Create Operator account
          </button>
        </>
      )}

      {phase === "recovery-shown" && recoveryCode && (
        <>
          <p className="body-text">
            Your recovery code. Store it somewhere safe — it is shown only this once and
            is the only way back in if you lose your passkey.
          </p>
          <p className="recovery-code">{recoveryCode}</p>
          <button className="action-primary" onClick={() => (window.location.href = nextPath())}>
            I saved it — continue
          </button>
        </>
      )}

      {phase === "sign-in" && (
        <>
          <button className="action-primary" onClick={signIn}>
            Sign in with passkey
          </button>
          <form onSubmit={recover} style={{ marginTop: "var(--space-4)" }}>
            <p className="body-text">Lost your passkey? Enter your recovery code.</p>
            <input
              className="field"
              value={recoveryInput}
              onChange={(e) => setRecoveryInput(e.target.value)}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              aria-label="Recovery code"
            />
            <button className="action-primary" style={{ marginTop: "var(--space-1)" }} type="submit">
              Sign in with recovery code
            </button>
          </form>
        </>
      )}

      {error && (
        <p className="error-text">{error}</p>
      )}
    </main>
  );
}
