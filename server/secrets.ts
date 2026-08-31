import sodium from "libsodium-wrappers";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { audit } from "./audit";

export type SecretReference = string;

const REFERENCE_PREFIX = "secretref_";

export function isSecretReference(value: string): boolean {
  return /^secretref_[0-9a-f]{32}$/.test(value);
}

class CustodyError extends Error {}

async function masterKey(): Promise<Uint8Array> {
  await sodium.ready;
  const encoded = process.env.SECRETS_MASTER_KEY;
  if (!encoded) {
    throw new CustodyError(
      "SECRETS_MASTER_KEY is not set. Provide a base64-encoded 32-byte key from the platform secret manager."
    );
  }
  let key: Uint8Array;
  try {
    key = sodium.from_base64(encoded, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new CustodyError("SECRETS_MASTER_KEY is not valid base64");
  }
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new CustodyError(
      `SECRETS_MASTER_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes`
    );
  }
  return key;
}

interface SecretRow {
  reference: string;
  kind: string;
  ciphertext: Buffer;
  nonce: Buffer;
  version: number;
  status: string;
}

function seal(plaintext: string, key: Uint8Array): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  return { ciphertext: Buffer.from(ciphertext), nonce: Buffer.from(nonce) };
}

export async function storeSecret(
  kind: string,
  value: string,
  actor: string
): Promise<SecretReference> {
  const key = await masterKey();
  const reference = REFERENCE_PREFIX + randomUUID().replace(/-/g, "");
  const { ciphertext, nonce } = seal(value, key);
  getDb()
    .prepare(
      "INSERT INTO secrets (reference, kind, ciphertext, nonce) VALUES (?, ?, ?, ?)"
    )
    .run(reference, kind, ciphertext, nonce);
  audit(actor, "secret.stored", { reference, kind });
  return reference;
}

export async function resolveSecret(reference: SecretReference, actor: string): Promise<string> {
  const key = await masterKey();
  const row = getDb()
    .prepare("SELECT * FROM secrets WHERE reference = ?")
    .get(reference) as SecretRow | undefined;
  if (!row) throw new CustodyError(`Unknown secret reference: ${reference}`);
  if (row.status !== "active") {
    throw new CustodyError(`Secret ${reference} is ${row.status}`);
  }
  const plaintext = sodium.crypto_secretbox_open_easy(
    new Uint8Array(row.ciphertext),
    new Uint8Array(row.nonce),
    key
  );
  audit(actor, "secret.resolved", { reference, kind: row.kind });
  return sodium.to_string(plaintext);
}

export async function rotateSecret(
  reference: SecretReference,
  newValue: string,
  actor: string
): Promise<void> {
  const key = await masterKey();
  const row = getDb()
    .prepare("SELECT * FROM secrets WHERE reference = ?")
    .get(reference) as SecretRow | undefined;
  if (!row) throw new CustodyError(`Unknown secret reference: ${reference}`);
  if (row.status !== "active") {
    throw new CustodyError(`Secret ${reference} is ${row.status}`);
  }
  const { ciphertext, nonce } = seal(newValue, key);
  getDb()
    .prepare(
      `UPDATE secrets
       SET ciphertext = ?, nonce = ?, version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE reference = ?`
    )
    .run(ciphertext, nonce, reference);
  audit(actor, "secret.rotated", { reference, kind: row.kind, version: row.version + 1 });
}

export async function revokeSecret(reference: SecretReference, actor: string): Promise<void> {
  const row = getDb()
    .prepare("SELECT * FROM secrets WHERE reference = ?")
    .get(reference) as SecretRow | undefined;
  if (!row) throw new CustodyError(`Unknown secret reference: ${reference}`);
  if (row.status !== "active") {
    throw new CustodyError(`Secret ${reference} is ${row.status}`);
  }
  getDb()
    .prepare(
      `UPDATE secrets
       SET status = 'revoked', ciphertext = zeroblob(0), nonce = zeroblob(0),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE reference = ?`
    )
    .run(reference);
  audit(actor, "secret.revoked", { reference, kind: row.kind });
}
