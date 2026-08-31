import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoSecretShapedStrings,
  findSecretShapedStrings,
  ResponseLintError,
} from "../server/response-lint";

test("a response containing a secret-shaped string fails the lint check", () => {
  const payload = {
    content: [
      {
        type: "text",
        text: "Here is your key: sk-abcdefghijklmnopqrstuvwxyz123456",
      },
    ],
  };
  assert.throws(() => assertNoSecretShapedStrings(payload), ResponseLintError);
});

test("known secret formats are detected", () => {
  // Sample tokens are concatenated so repository secret scanners do not
  // mistake these synthetic fixtures for real credentials.
  const samples = [
    "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "xoxb-" + "123456789012-abcdefghijklmnop",
    "AKIA" + "IOSFODNN7EXAMPLE",
    "AIza" + "SyA-1234567890abcdefghijklmnopqrstuv",
    "sk_live_" + "abcdefghijklmnopqrstuvwx",
    "-----BEGIN RSA PRIVATE KEY-----",
    "Bearer " + "dGhpcy1pcy1hLXNlY3JldC10b2tlbg==",
    'api_key: "supersecretvalue123"',
  ];
  for (const sample of samples) {
    assert.ok(
      findSecretShapedStrings(sample).length > 0,
      `expected lint finding for: ${sample}`
    );
  }
});

test("high-entropy opaque strings are detected", () => {
  const highEntropy = "g7Xq2LmR9zKwB4vN8pYt3JhD6fSaU1cE5oIrM0nQxWyZ";
  assert.ok(findSecretShapedStrings(highEntropy).length > 0);
});

test("ordinary prose and opaque secret references pass the lint", () => {
  assert.doesNotThrow(() =>
    assertNoSecretShapedStrings({
      content: [
        {
          type: "text",
          text: "Draft a positioning hypothesis for KeepAnalog. Reference: secretref_0123456789abcdef0123456789abcdef",
        },
      ],
    })
  );
});
