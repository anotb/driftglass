import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResearchResult, deepResearchResultContract } from "../.test-dist/research-results.js";

test("structured research results normalize the durable Mission update contract", () => {
  const result = normalizeResearchResult({
    current_thesis: "The current answer",
    report_summary: "Material evidence changed the prior view.",
    open_questions: ["What happens next?", "What would falsify this?"],
    reportTitle: "Deep Research report",
    reportUrl: "https://example.com/report",
    confidence: 0.82,
    nextExpectedEvent: "A production release",
    nextExpectedBy: "2026-09-01",
    outcomeStatus: "open",
  });
  assert.equal(result.currentThesis, "The current answer");
  assert.equal(result.reportUrl, "https://example.com/report");
  assert.equal(result.confidence, 0.82);
  assert.equal(result.nextExpectedBy, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(result.openQuestions, ["What happens next?", "What would falsify this?"]);
});

test("research results reject unusable or unsafe state", () => {
  assert.throws(() => normalizeResearchResult({}), /currentThesis or reportSummary/);
  assert.throws(() => normalizeResearchResult({ currentThesis: "x", confidence: 2 }), /between 0 and 1/);
  assert.throws(() => normalizeResearchResult({ currentThesis: "x", reportUrl: "file:///tmp/report" }), /http and https URLs/);
});

test("Deep Research handoff publishes a stable result shape", () => {
  const contract = deepResearchResultContract();
  for (const key of ["currentThesis", "reportSummary", "openQuestions", "confidence", "nextExpectedEvent", "outcomeStatus"]) {
    assert.ok(key in contract, `missing ${key}`);
  }
});
