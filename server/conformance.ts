// Conformance suite v0 for Connected Project domains.
//
// MarketingOS marks a project healthy only when every check passes. v0 covers
// the read surface of the contract: manifest handshake, required resources,
// the change cursor, bearer-token enforcement, and structured errors.

import { PROJECT_CONTRACT_VERSION, REQUIRED_RESOURCES } from "./project-domain-sdk";

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceReport {
  passed: boolean;
  contractVersion: string;
  ranAt: string;
  checks: ConformanceCheck[];
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, token?: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function isStructuredError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    typeof e.message === "string" &&
    typeof e.retryable === "boolean" &&
    typeof e.recovery === "string"
  );
}

export async function runConformance(baseUrl: string, token: string): Promise<ConformanceReport> {
  const base = baseUrl.replace(/\/+$/, "");
  const checks: ConformanceCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail });

  try {
    // 1. Manifest handshake and contract version.
    const manifest = await fetchJson(`${base}/manifest`, token);
    const m = (manifest.body ?? {}) as Record<string, unknown>;
    const versionOk =
      manifest.status === 200 && m.contractVersion === PROJECT_CONTRACT_VERSION;
    add(
      "manifest declares contract v0",
      versionOk,
      versionOk
        ? `contractVersion ${String(m.contractVersion)}`
        : `status ${manifest.status}, contractVersion ${String(m.contractVersion)}`
    );

    // 2. Requests without a token are rejected with a structured error.
    const unauthed = await fetchJson(`${base}/manifest`);
    const unauthOk = unauthed.status === 401 && isStructuredError(unauthed.body);
    add(
      "rejects requests without a service token",
      unauthOk,
      `status ${unauthed.status}${isStructuredError(unauthed.body) ? ", structured error" : ", missing structured error"}`
    );

    // 3. Requests with a wrong token are rejected.
    const badToken = await fetchJson(`${base}/manifest`, `${token}-tampered`);
    add(
      "rejects requests with an invalid service token",
      badToken.status === 401 && isStructuredError(badToken.body),
      `status ${badToken.status}`
    );

    // 4. Every required resource is implemented (ok or explicitly empty).
    for (const resource of REQUIRED_RESOURCES) {
      const res = await fetchJson(`${base}/resources/${resource}`, token);
      const body = (res.body ?? {}) as Record<string, unknown>;
      const ok =
        res.status === 200 &&
        body.resource === resource &&
        (body.state === "ok" || body.state === "empty");
      add(
        `required resource '${resource}' is implemented`,
        ok,
        ok ? `state ${String(body.state)}` : `status ${res.status}`
      );
    }

    // 5. Unknown resources fail with `unsupported_capability`, not fabricated data.
    const unknown = await fetchJson(`${base}/resources/not-a-real-resource`, token);
    const unknownError = ((unknown.body ?? {}) as { error?: { code?: string } }).error;
    add(
      "unknown resource returns unsupported_capability",
      unknown.status === 404 &&
        isStructuredError(unknown.body) &&
        unknownError?.code === "unsupported_capability",
      `status ${unknown.status}, code ${String(unknownError?.code)}`
    );

    // 5b. The metrics capability, if declared, is implemented — and if it
    // is not declared, it answers as unsupported rather than half-existing.
    // A capability that is declared but missing is worse than one that was
    // never claimed, because a reading would be expected from it.
    const declaresMetrics =
      Array.isArray(m.capabilities) && (m.capabilities as unknown[]).includes("metrics");
    const funnel = await fetchJson(`${base}/capabilities/metrics`, token);
    if (declaresMetrics) {
      const bundle = (funnel.body ?? {}) as Record<string, unknown>;
      const ok =
        funnel.status === 200 &&
        typeof bundle.snapshotId === "string" &&
        typeof bundle.version === "number" &&
        typeof bundle.collectionMethod === "string" &&
        Array.isArray(bundle.metrics);
      add(
        "declared 'metrics' capability serves a bundle with provenance",
        ok,
        ok
          ? `snapshot ${String(bundle.snapshotId)} v${String(bundle.version)}`
          : `status ${funnel.status}`
      );
    } else {
      const error = ((funnel.body ?? {}) as { error?: { code?: string } }).error;
      add(
        "undeclared 'metrics' capability answers as unsupported",
        funnel.status === 404 &&
          isStructuredError(funnel.body) &&
          error?.code === "unsupported_capability",
        `status ${funnel.status}, code ${String(error?.code)}`
      );
    }

    // 6. Change feed exposes a monotonic cursor.
    const changes = await fetchJson(`${base}/changes?after=0`, token);
    const c = (changes.body ?? {}) as { cursor?: unknown; entries?: unknown };
    const entries = Array.isArray(c.entries) ? (c.entries as { cursor?: unknown }[]) : null;
    const monotonic =
      entries !== null &&
      typeof c.cursor === "number" &&
      entries.every(
        (e, i) =>
          typeof e.cursor === "number" &&
          (i === 0 || (e.cursor as number) > (entries[i - 1].cursor as number))
      );
    add(
      "change feed exposes a monotonic cursor",
      changes.status === 200 && monotonic,
      `status ${changes.status}`
    );
  } catch (err) {
    add(
      "project domain is reachable",
      false,
      err instanceof Error ? err.message : String(err)
    );
  }

  return {
    passed: checks.every((c) => c.passed),
    contractVersion: PROJECT_CONTRACT_VERSION,
    ranAt: new Date().toISOString(),
    checks,
  };
}
