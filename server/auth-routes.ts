import express, { type Request, type Response, type Router } from "express";
import {
  AuthError,
  SESSION_COOKIE,
  authenticationOptions,
  createSession,
  destroySession,
  operatorExists,
  registrationOptions,
  validateSession,
  verifyAuthentication,
  verifyRecoveryCode,
  verifyRegistration,
} from "./auth";
import { audit } from "./audit";
import { log } from "./log";

export function sessionTokenFrom(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  log("error", "auth route error", {
    error: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  res.status(500).json({ error: "Internal error" });
}

export function authRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.get("/status", (req, res) => {
    res.json({
      operatorExists: operatorExists(),
      authenticated: validateSession(sessionTokenFrom(req)) !== null,
    });
  });

  router.post("/register/options", async (_req, res) => {
    try {
      res.json(await registrationOptions());
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/register/verify", async (req, res) => {
    try {
      const { operatorId, recoveryCode } = await verifyRegistration(req.body);
      const { token, expiresAt } = createSession(operatorId);
      setSessionCookie(res, token, expiresAt);
      res.json({ recoveryCode });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/login/options", async (_req, res) => {
    try {
      res.json(await authenticationOptions());
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/login/verify", async (req, res) => {
    try {
      const operatorId = await verifyAuthentication(req.body);
      const { token, expiresAt } = createSession(operatorId);
      setSessionCookie(res, token, expiresAt);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/recovery", (req, res) => {
    try {
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const operator = verifyRecoveryCode(code);
      if (!operator) {
        audit("operator", "auth.recovery_failed", {});
        res.status(401).json({ error: "Invalid recovery code" });
        return;
      }
      const { token, expiresAt } = createSession(operator.id);
      setSessionCookie(res, token, expiresAt);
      audit("operator", "auth.signed_in", { method: "recovery-code" });
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post("/logout", (req, res) => {
    try {
      destroySession(sessionTokenFrom(req));
      clearSessionCookie(res);
      audit("operator", "auth.signed_out", {});
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
