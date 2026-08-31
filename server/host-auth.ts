import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import { audit } from "./audit";
import { getDb } from "./db";
import { revokeSecret, rotateSecret, storeSecret } from "./secrets";

export const WORKSPACE_SCOPE = "marketingos";

const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
// Static fallback tokens do not expire; they are revoked from the dashboard.
const STATIC_TOKEN_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ConnectionRow {
  id: number;
  kind: "oauth" | "static";
  label: string;
  client_id: string | null;
  scope: string;
  status: "active" | "revoked";
  token_hash: string;
  refresh_token_hash: string | null;
  access_secret_reference: string;
  refresh_secret_reference: string | null;
  access_expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface HostConnection {
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

function toConnection(row: ConnectionRow): HostConnection {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    clientId: row.client_id,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export function listHostConnections(): HostConnection[] {
  const rows = getDb()
    .prepare("SELECT * FROM host_connections ORDER BY created_at DESC, id DESC")
    .all() as ConnectionRow[];
  return rows.map(toConnection);
}

export async function mintStaticHostToken(
  label: string,
  actor: string
): Promise<{ token: string; connection: HostConnection }> {
  const token = newToken("moshost_static_");
  const reference = await storeSecret("host-static-token", token, actor);
  const info = getDb()
    .prepare(
      `INSERT INTO host_connections
         (kind, label, scope, token_hash, access_secret_reference)
       VALUES ('static', ?, ?, ?, ?)`
    )
    .run(label, WORKSPACE_SCOPE, hashToken(token), reference);
  const id = Number(info.lastInsertRowid);
  audit(actor, "host.static_token_minted", { connectionId: id, label });
  const row = getDb()
    .prepare("SELECT * FROM host_connections WHERE id = ?")
    .get(id) as ConnectionRow;
  return { token, connection: toConnection(row) };
}

export async function revokeHostConnection(id: number, actor: string): Promise<HostConnection> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM host_connections WHERE id = ?").get(id) as
    | ConnectionRow
    | undefined;
  if (!row) throw new HostAuthError("Unknown host connection", 404);
  if (row.status !== "active") throw new HostAuthError("Connection is already revoked", 409);
  db.prepare(
    "UPDATE host_connections SET status = 'revoked', revoked_at = ? WHERE id = ?"
  ).run(nowIso(), id);
  await revokeSecret(row.access_secret_reference, actor);
  if (row.refresh_secret_reference) await revokeSecret(row.refresh_secret_reference, actor);
  audit(actor, "host.connection_revoked", { connectionId: id, kind: row.kind, label: row.label });
  const updated = db.prepare("SELECT * FROM host_connections WHERE id = ?").get(id) as ConnectionRow;
  return toConnection(updated);
}

export class HostAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// --- Token verification (bearer auth on /mcp) ---

export async function verifyHostToken(token: string): Promise<AuthInfo> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM host_connections WHERE token_hash = ?")
    .get(hashToken(token)) as ConnectionRow | undefined;
  if (!row) throw new InvalidTokenError("Unknown access token");
  if (row.status !== "active") {
    throw new InvalidTokenError("This host connection has been revoked by the Operator");
  }
  const expiresAtMs = row.access_expires_at
    ? new Date(row.access_expires_at).getTime()
    : Date.now() + STATIC_TOKEN_EXPIRY_MS;
  if (expiresAtMs <= Date.now()) throw new InvalidTokenError("Access token has expired");
  db.prepare("UPDATE host_connections SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return {
    token,
    clientId: row.client_id ?? `static:${row.id}`,
    scopes: row.scope.split(" "),
    expiresAt: Math.floor(expiresAtMs / 1000),
    extra: { connectionId: row.id, kind: row.kind, label: row.label },
  };
}

// --- OAuth 2.1 server provider (MCP authorization spec) ---

interface CodeRow {
  code: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  scope: string;
  resource: string | null;
  expires_at: string;
}

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = getDb()
      .prepare("SELECT data FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: `moshc_${randomBytes(16).toString("hex")}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    getDb()
      .prepare("INSERT INTO oauth_clients (client_id, data) VALUES (?, ?)")
      .run(full.client_id, JSON.stringify(full));
    audit("host", "host.oauth_client_registered", {
      clientId: full.client_id,
      clientName: client.client_name ?? null,
    });
    return full;
  }
}

async function issueTokens(
  client: OAuthClientInformationFull,
  scope: string
): Promise<OAuthTokens> {
  const accessToken = newToken("moshost_");
  const refreshToken = newToken("moshostr_");
  const accessRef = await storeSecret("host-oauth-access-token", accessToken, "host");
  const refreshRef = await storeSecret("host-oauth-refresh-token", refreshToken, "host");
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO host_connections
         (kind, label, client_id, scope, token_hash, refresh_token_hash,
          access_secret_reference, refresh_secret_reference, access_expires_at)
       VALUES ('oauth', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client.client_name ?? client.client_id,
      client.client_id,
      scope,
      hashToken(accessToken),
      hashToken(refreshToken),
      accessRef,
      refreshRef,
      expiresAt
    );
  audit("host", "host.oauth_grant_issued", {
    connectionId: Number(info.lastInsertRowid),
    clientId: client.client_id,
  });
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope,
    refresh_token: refreshToken,
  };
}

export class HostOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new SqliteClientsStore();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // The MCP authorization spec leaves resource-owner authentication to the
    // server. This workspace has a single Operator: an authenticated dashboard
    // session (passkey) is the consent; otherwise, sign in first and retry.
    const req = res.req as Request;
    const operatorId = validateSession(sessionTokenFrom(req));
    if (operatorId === null) {
      const next = encodeURIComponent(req.originalUrl ?? "/authorize");
      res.redirect(302, `/login?next=${next}`);
      return;
    }
    const code = newToken("moshac_");
    getDb()
      .prepare(
        `INSERT INTO oauth_codes
           (code, client_id, code_challenge, redirect_uri, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code,
        client.client_id,
        params.codeChallenge,
        params.redirectUri,
        params.scopes?.join(" ") || WORKSPACE_SCOPE,
        params.resource?.href ?? null,
        new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString()
      );
    audit("operator", "host.oauth_authorized", {
      clientId: client.client_id,
      clientName: client.client_name ?? null,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state !== undefined) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  private takeCode(client: OAuthClientInformationFull, authorizationCode: string): CodeRow {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM oauth_codes WHERE code = ?")
      .get(authorizationCode) as CodeRow | undefined;
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Unknown authorization code");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(authorizationCode);
      throw new InvalidGrantError("Authorization code has expired");
    }
    return row;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    return this.takeCode(client, authorizationCode).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const row = this.takeCode(client, authorizationCode);
    getDb().prepare("DELETE FROM oauth_codes WHERE code = ?").run(authorizationCode);
    return issueTokens(client, row.scope);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM host_connections WHERE refresh_token_hash = ?")
      .get(hashToken(refreshToken)) as ConnectionRow | undefined;
    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError("Unknown refresh token");
    }
    if (row.status !== "active") {
      throw new InvalidGrantError("This host connection has been revoked by the Operator");
    }
    const accessToken = newToken("moshost_");
    await rotateSecret(row.access_secret_reference, accessToken, "host");
    const scope = scopes?.length ? scopes.join(" ") : row.scope;
    db.prepare(
      "UPDATE host_connections SET token_hash = ?, access_expires_at = ?, scope = ? WHERE id = ?"
    ).run(
      hashToken(accessToken),
      new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
      scope,
      row.id
    );
    audit("host", "host.oauth_grant_refreshed", {
      connectionId: row.id,
      clientId: client.client_id,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope,
      refresh_token: refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyHostToken(token);
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const hash = hashToken(request.token);
    const row = getDb()
      .prepare("SELECT * FROM host_connections WHERE token_hash = ? OR refresh_token_hash = ?")
      .get(hash, hash) as ConnectionRow | undefined;
    if (!row || row.client_id !== client.client_id || row.status !== "active") return;
    await revokeHostConnection(row.id, "host");
  }
}

export const hostOAuthProvider = new HostOAuthProvider();
