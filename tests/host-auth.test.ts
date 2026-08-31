import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketingos-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("base64");

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getDb } from "../server/db";
import {
  hostOAuthProvider,
  listHostConnections,
  mintStaticHostToken,
  revokeHostConnection,
  verifyHostToken,
  WORKSPACE_SCOPE,
} from "../server/host-auth";

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function registerClient(): OAuthClientInformationFull {
  return hostOAuthProvider.clientsStore.registerClient({
    client_name: "Test Host",
    redirect_uris: ["https://host.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

test("static token: mint, verify, and revoke with a structured error", async () => {
  const { token, connection } = await mintStaticHostToken("fallback host", "test");
  assert.match(token, /^moshost_static_[0-9a-f]{48}$/);
  assert.equal(connection.kind, "static");
  assert.equal(connection.status, "active");

  const auth = await verifyHostToken(token);
  assert.deepEqual(auth.scopes, [WORKSPACE_SCOPE]);
  assert.ok(auth.expiresAt && auth.expiresAt * 1000 > Date.now());

  await revokeHostConnection(connection.id, "test");
  await assert.rejects(
    () => verifyHostToken(token),
    (err: Error & { errorCode?: string }) => {
      assert.equal(err.errorCode, "invalid_token");
      assert.match(err.message, /revoked/);
      return true;
    }
  );
});

test("static tokens are stored via the custody module, never in plaintext", async () => {
  const { token } = await mintStaticHostToken("custody check", "test");
  const rows = getDb()
    .prepare("SELECT access_secret_reference FROM host_connections")
    .all() as { access_secret_reference: string }[];
  for (const row of rows) {
    assert.match(row.access_secret_reference, /^secretref_[0-9a-f]{32}$/);
  }
  const dump = getDb().serialize().toString("latin1");
  assert.ok(!dump.includes(token.slice("moshost_static_".length)));
});

test("dynamic client registration persists the client", () => {
  const client = registerClient();
  assert.match(client.client_id, /^moshc_[0-9a-f]{32}$/);
  const fetched = hostOAuthProvider.clientsStore.getClient(client.client_id);
  assert.equal(fetched?.client_name, "Test Host");
});

test("authorization code exchange issues a verifiable workspace-scoped grant", async () => {
  const client = registerClient();
  const redirects: string[] = [];
  const res = {
    req: { headers: { cookie: undefined }, originalUrl: "/authorize" },
    redirect: (_status: number, url: string) => redirects.push(url),
  };
  // Unauthenticated operator: sent to login, no code issued.
  await hostOAuthProvider.authorize(
    client,
    { codeChallenge: "challenge-1", redirectUri: "https://host.example/callback" },
    res as never
  );
  assert.match(redirects[0], /^\/login\?next=/);

  // Authenticated operator (session validated upstream): issue the code.
  getDb()
    .prepare(
      `INSERT INTO operators (handle, recovery_code_hash, recovery_code_salt)
       VALUES ('operator', 'x', 'y')
       ON CONFLICT (handle) DO NOTHING`
    )
    .run();
  const { createSession } = await import("../server/auth");
  const { token: sessionToken } = createSession(1);
  const authedRes = {
    req: {
      headers: { cookie: `mos_session=${sessionToken}` },
      originalUrl: "/authorize",
    },
    redirect: (_status: number, url: string) => redirects.push(url),
  };
  await hostOAuthProvider.authorize(
    client,
    {
      codeChallenge: "challenge-1",
      redirectUri: "https://host.example/callback",
      state: "abc",
      scopes: [WORKSPACE_SCOPE],
    },
    authedRes as never
  );
  const redirect = new URL(redirects[1]);
  assert.equal(redirect.origin + redirect.pathname, "https://host.example/callback");
  assert.equal(redirect.searchParams.get("state"), "abc");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  assert.equal(
    await hostOAuthProvider.challengeForAuthorizationCode(client, code),
    "challenge-1"
  );

  const tokens = await hostOAuthProvider.exchangeAuthorizationCode(client, code);
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, WORKSPACE_SCOPE);
  const auth = await verifyHostToken(tokens.access_token);
  assert.equal(auth.clientId, client.client_id);

  // Codes are single-use.
  await assert.rejects(() => hostOAuthProvider.exchangeAuthorizationCode(client, code));

  // Refresh rotates the access token.
  const refreshToken = tokens.refresh_token;
  assert.ok(refreshToken);
  const refreshed = await hostOAuthProvider.exchangeRefreshToken(client, refreshToken);
  assert.notEqual(refreshed.access_token, tokens.access_token);
  await verifyHostToken(refreshed.access_token);
  await assert.rejects(() => verifyHostToken(tokens.access_token));
});

test("a revoked OAuth grant fails verification and refresh with structured errors", async () => {
  const client = registerClient();
  const tokens = await (async () => {
    getDb()
      .prepare(
        `INSERT INTO oauth_codes (code, client_id, code_challenge, redirect_uri, scope, expires_at)
         VALUES ('testcode-revoke', ?, 'c', 'https://host.example/callback', ?, ?)`
      )
      .run(client.client_id, WORKSPACE_SCOPE, new Date(Date.now() + 60000).toISOString());
    return hostOAuthProvider.exchangeAuthorizationCode(client, "testcode-revoke");
  })();

  const connection = listHostConnections().find((c) => c.clientId === client.client_id);
  assert.ok(connection);
  await revokeHostConnection(connection.id, "test");

  await assert.rejects(
    () => verifyHostToken(tokens.access_token),
    (err: Error & { errorCode?: string }) => {
      assert.equal(err.errorCode, "invalid_token");
      assert.match(err.message, /revoked/);
      return true;
    }
  );
  const refreshToken = tokens.refresh_token;
  assert.ok(refreshToken);
  await assert.rejects(
    () => hostOAuthProvider.exchangeRefreshToken(client, refreshToken),
    /revoked/
  );
});

test("revocation and grants are audited without leaking token values", async () => {
  const { token, connection } = await mintStaticHostToken("audit check", "test");
  await revokeHostConnection(connection.id, "test");
  const rows = getDb().prepare("SELECT action, detail FROM audit_log").all() as {
    action: string;
    detail: string;
  }[];
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes("host.static_token_minted"));
  assert.ok(actions.includes("host.connection_revoked"));
  for (const row of rows) {
    assert.ok(!row.detail.includes(token));
  }
});
