"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

type Phase = "loading" | "first-run" | "sign-in" | "recovery-shown";

const box: React.CSSProperties = {
  maxWidth: "26rem",
  margin: "0 auto",
  padding: "6rem 1.5rem",
};

const buttonStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "1rem",
  padding: "0.6rem 1.2rem",
  background: "#1a1a18",
  color: "#faf9f7",
  border: "none",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  fontSize: "0.9rem",
  padding: "0.5rem",
  border: "1px solid #d8d5cf",
  width: "100%",
  boxSizing: "border-box",
};

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
          window.location.href = "/";
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
      window.location.href = "/";
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
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main style={box}>
      <h1 style={{ fontWeight: 400, fontSize: "1.75rem", marginBottom: "0.5rem" }}>
        MarketingOS
      </h1>
      <hr style={{ border: "none", borderTop: "1px solid #d8d5cf", margin: "1.5rem 0" }} />

      {phase === "loading" && <p>Loading…</p>}

      {phase === "first-run" && (
        <>
          <p style={{ fontFamily: "system-ui, sans-serif", fontSize: "0.9rem", color: "#5a574f" }}>
            No Operator account exists yet. Create the sole Operator account with a
            passkey. You will be shown a recovery code exactly once.
          </p>
          <button style={buttonStyle} onClick={register}>
            Create Operator account
          </button>
        </>
      )}

      {phase === "recovery-shown" && recoveryCode && (
        <>
          <p style={{ fontFamily: "system-ui, sans-serif", fontSize: "0.9rem", color: "#5a574f" }}>
            Your recovery code. Store it somewhere safe — it is shown only this once and
            is the only way back in if you lose your passkey.
          </p>
          <p
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "1.1rem",
              padding: "1rem",
              background: "#f0eeea",
              border: "1px solid #d8d5cf",
              userSelect: "all",
            }}
          >
            {recoveryCode}
          </p>
          <button style={buttonStyle} onClick={() => (window.location.href = "/")}>
            I saved it — continue
          </button>
        </>
      )}

      {phase === "sign-in" && (
        <>
          <button style={buttonStyle} onClick={signIn}>
            Sign in with passkey
          </button>
          <form onSubmit={recover} style={{ marginTop: "2.5rem" }}>
            <p
              style={{ fontFamily: "system-ui, sans-serif", fontSize: "0.85rem", color: "#5a574f" }}
            >
              Lost your passkey? Enter your recovery code.
            </p>
            <input
              style={inputStyle}
              value={recoveryInput}
              onChange={(e) => setRecoveryInput(e.target.value)}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              aria-label="Recovery code"
            />
            <button style={{ ...buttonStyle, marginTop: "0.75rem" }} type="submit">
              Sign in with recovery code
            </button>
          </form>
        </>
      )}

      {error && (
        <p style={{ fontFamily: "system-ui, sans-serif", fontSize: "0.85rem", color: "#a03d2e" }}>
          {error}
        </p>
      )}
    </main>
  );
}
