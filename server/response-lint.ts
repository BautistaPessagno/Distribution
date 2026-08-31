export class ResponseLintError extends Error {
  readonly findings: string[];

  constructor(findings: string[]) {
    super(`Response failed secret lint: ${findings.join(", ")}`);
    this.findings = findings;
  }
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: "pem private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "openai-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: "github fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "google api key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "stripe key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9_.~+/-]{20,}=*/i },
  {
    name: "assignment of long opaque value",
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)s?\b['"]?\s*[:=]\s*['"]?[^\s'"]{12,}/i,
  },
];

const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const SAFE_LONG_STRING = /^secretref_[0-9a-f]{32}$/;

export function findSecretShapedStrings(text: string): string[] {
  const findings: string[] = [];
  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(text)) findings.push(name);
  }
  for (const match of text.match(HIGH_ENTROPY) ?? []) {
    if (SAFE_LONG_STRING.test(match)) continue;
    if (shannonEntropy(match) >= 4.5) {
      findings.push("high-entropy string");
      break;
    }
  }
  return findings;
}

/**
 * Gateway custody boundary: every response payload must pass this lint
 * before leaving the process. Throws ResponseLintError on any finding.
 */
export function assertNoSecretShapedStrings(payload: unknown): void {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const findings = findSecretShapedStrings(text);
  if (findings.length > 0) throw new ResponseLintError(findings);
}
