import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  collectorResultFingerprint,
  collectorResultSummary,
  isRelayResult,
  normalizeCompanionItems,
  parseCollectorResultSummary,
  relayResultValidationError,
} = require("../.test-dist/collector-results.js");

test("successful Companion payloads require a structural RelayResult while valid empty results remain allowed", () => {
  assert.equal(isRelayResult({ provider: "companion", items: [] }), true);
  assert.equal(isRelayResult(undefined), false);
  assert.equal(isRelayResult({ items: [] }), false);
  assert.equal(isRelayResult({ provider: "companion" }), false);
  assert.equal(isRelayResult({ provider: "companion", items: {} }), false);
  assert.equal(isRelayResult({ provider: "companion", items: ["bad"] }), false);
  assert.equal(isRelayResult({ provider: "companion", items: [], diagnostics: [] }), false);
});

test("Companion results above the Relay's 250-item contract are rejected without truncation", () => {
  const result = {
    provider: "companion",
    items: Array.from({ length: 251 }, (_, index) => ({ title: `Item ${index}` })),
  };
  assert.equal(isRelayResult(result), true, "the payload is structurally valid before its explicit size check");
  assert.match(relayResultValidationError(result), /limited to 250 items; no items were accepted/);
  assert.equal(normalizeCompanionItems(result.items).length, 251, "normalization itself must not silently discard the tail");
});

test("Companion evidence stays on the Queue while job summaries remain content-free", () => {
  const result = {
    provider: "companion",
    items: [{ title: "Private title", text: "Private signed-in body", raw: "raw secret", metadata: { account: "secret" } }],
    diagnostics: {
      durationMs: 42,
      returned: 1,
      fallbackFailures: [{ stderr: "private path" }],
      command: "secret command",
      truncated: false,
    },
  };
  assert.equal(normalizeCompanionItems(result.items)[0].accessClass, "authenticated-local");
  const summary = collectorResultSummary(result, 1, 1);
  const serialized = JSON.stringify(summary);
  assert.deepEqual(summary, {
    provider: "companion",
    collectedCount: 1,
    acceptedCount: 1,
    diagnostics: { durationMs: 42, returned: 1, truncated: false },
  });
  assert.doesNotMatch(serialized, /Private title|signed-in body|raw secret|account|fallbackFailures|secret command/);
});

test("dispatch summaries persist a stable content-free fingerprint and bounded state", async () => {
  const result = {
    provider: "companion",
    items: [{ title: "Private title", text: "Private signed-in body", metadata: { account: "secret" } }],
    diagnostics: { durationMs: 42, returned: 1, command: "private command" },
  };
  const items = normalizeCompanionItems(result.items);
  const first = await collectorResultFingerprint(result, items);
  const second = await collectorResultFingerprint({ ...result, diagnostics: { durationMs: 99 } }, items);
  assert.equal(first, second, "non-evidence diagnostics do not change dispatch identity");

  const summary = collectorResultSummary(result, 1, 0, {
    fingerprint: first,
    attemptId: "dispatch-attempt-0001",
    attemptStartedAt: "2026-08-07T12:00:00.000Z",
    phase: "dispatching",
    plannedCount: 1,
  });
  const serialized = JSON.stringify(summary);
  assert.deepEqual(parseCollectorResultSummary(serialized), summary);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(serialized, /Private title|signed-in body|account|private command/);
});
