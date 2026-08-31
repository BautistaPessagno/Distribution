import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { audit } from "./audit";

export const SESSION_COOKIE = "mos_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RP_NAME = "MarketingOS";

export function expectedOrigin(): string {
  return process.env.APP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

export function rpId(): string {
  return new URL(expectedOrigin()).hostname;
}

interface OperatorRow {
  id: number;
  handle: string;
  recovery_code_hash: string;
  recovery_code_salt: string;
}

interface CredentialRow {
  id: string;
  operator_id: number;
  public_key: Buffer;
  counter: number;
  transports: string;
}

export function operatorExists(): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM operators").get() as { n: number };
  return row.n > 0;
}

function getOperator(): OperatorRow | undefined {
  return getDb().prepare("SELECT * FROM operators ORDER BY id LIMIT 1").get() as
    | OperatorRow
    | undefined;
}

// --- Recovery code ---

export function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    const bytes = randomBytes(5);
    for (let i = 0; i < 5; i++) group += alphabet[bytes[i] % alphabet.length];
    groups.push(group);
  }
  return groups.join("-");
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string, salt: string): string {
  return scryptSync(normalizeRecoveryCode(code), salt, 32).toString("hex");
}

export function verifyRecoveryCode(code: string): OperatorRow | null {
  const operator = getOperator();
  if (!operator) return null;
  const candidate = Buffer.from(hashRecoveryCode(code, operator.recovery_code_salt), "hex");
  const stored = Buffer.from(operator.recovery_code_hash, "hex");
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return null;
  return operator;
}

// --- Sessions ---

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(operatorId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb()
    .prepare("INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), operatorId, expiresAt.toISOString());
  return { token, expiresAt };
}

export function validateSession(token: string | undefined): number | null {
  if (!token) return null;
  const row = getDb()
    .prepare("SELECT operator_id, expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as { operator_id: number; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return row.operator_id;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

// --- Route guard ---

const PUBLIC_EXACT = new Set(["/login", "/health", "/mcp", "/favicon.ico"]);
const PUBLIC_PREFIXES = ["/login/", "/api/auth/", "/_next/", "/__nextjs"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// --- WebAuthn challenges (single-instance, short-lived) ---

const challenges = new Map<string, { challenge: string; expiresAt: number }>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function putChallenge(kind: "register" | "login", challenge: string): void {
  challenges.set(kind, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(kind: "register" | "login"): string | null {
  const entry = challenges.get(kind);
  challenges.delete(kind);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.challenge;
}

// --- Registration (first run only) ---

export async function registrationOptions() {
  if (operatorExists()) throw new AuthError("Operator account already exists", 403);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId(),
    userName: "operator",
    userDisplayName: "Operator",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  putChallenge("register", options.challenge);
  return options;
}

export async function verifyRegistration(
  response: RegistrationResponseJSON
): Promise<{ operatorId: number; recoveryCode: string }> {
  if (operatorExists()) throw new AuthError("Operator account already exists", 403);
  const expectedChallenge = takeChallenge("register");
  if (!expectedChallenge) throw new AuthError("Registration challenge expired; try again", 400);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigin(),
    expectedRPID: rpId(),
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new AuthError("Passkey registration could not be verified", 400);
  }
  const { credential } = verification.registrationInfo;
  const recoveryCode = generateRecoveryCode();
  const salt = randomBytes(16).toString("hex");
  const db = getDb();
  const operatorId = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt) VALUES (?, ?, ?)"
      )
      .run("operator", hashRecoveryCode(recoveryCode, salt), salt);
    const id = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO webauthn_credentials (id, operator_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)"
    ).run(
      credential.id,
      id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? [])
    );
    return id;
  })();
  audit("operator", "auth.operator_created", { operatorId, credentialId: credential.id });
  return { operatorId, recoveryCode };
}

// --- Authentication ---

export async function authenticationOptions() {
  if (!operatorExists()) throw new AuthError("No Operator account exists yet", 404);
  const creds = getDb().prepare("SELECT * FROM webauthn_credentials").all() as CredentialRow[];
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: JSON.parse(c.transports) as AuthenticatorTransportFuture[],
    })),
  });
  putChallenge("login", options.challenge);
  return options;
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON
): Promise<number> {
  const expectedChallenge = takeChallenge("login");
  if (!expectedChallenge) throw new AuthError("Sign-in challenge expired; try again", 400);
  const cred = getDb()
    .prepare("SELECT * FROM webauthn_credentials WHERE id = ?")
    .get(response.id) as CredentialRow | undefined;
  if (!cred) throw new AuthError("Unknown passkey", 400);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: expectedOrigin(),
    expectedRPID: rpId(),
    requireUserVerification: false,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(cred.public_key),
      counter: cred.counter,
      transports: JSON.parse(cred.transports) as AuthenticatorTransportFuture[],
    },
  });
  if (!verification.verified) throw new AuthError("Passkey sign-in could not be verified", 401);
  getDb()
    .prepare("UPDATE webauthn_credentials SET counter = ? WHERE id = ?")
    .run(verification.authenticationInfo.newCounter, cred.id);
  audit("operator", "auth.signed_in", { method: "passkey", credentialId: cred.id });
  return cred.operator_id;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
