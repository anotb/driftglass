import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function loadReasoningResultPayload() {
  const start = appSource.indexOf("function reasoningResultPayload(");
  const end = appSource.indexOf("\nfunction durationLabel(", start);
  assert.ok(start >= 0 && end > start, "reasoning result payload helper is present");
  const context = {};
  vm.runInNewContext(`${appSource.slice(start, end)}\nthis.buildPayload = reasoningResultPayload;`, context);
  return context.buildPayload;
}

function loadReasoningRunRendering() {
  const start = appSource.indexOf("function reasoningValue(");
  const end = appSource.indexOf("\nfunction renderReasoningComparison(", start);
  assert.ok(start >= 0 && end > start, "reasoning run rendering helpers are present");
  const context = {
    escapeHtml: (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]),
    formatDate: (value) => value,
    parseRowJson: (value, fallback = {}) => {
      if (value && typeof value === "object") return value;
      try { return JSON.parse(String(value || "")); } catch { return fallback; }
    },
    safeHref: (value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
      } catch { return ""; }
    },
    supportLabel: () => "supported",
  };
  vm.runInNewContext(`${appSource.slice(start, end)}\nthis.analyze = reasoningRunAnalysis; this.markup = reasoningRunMarkup; this.enrich = enrichReasoningComparison;`, context);
  return context;
}

test("pasted structured results submit their exact canonical ledger fields", () => {
  const buildPayload = loadReasoningResultPayload();
  const structuredResult = {
    summary: "A bounded canary gives the fastest safe answer.",
    citations: ["https://example.com/primary", "https://example.net/independent"],
    confidence: 0.72,
  };
  const payload = buildPayload(
    { provider: "chatgpt", model: "subscription", summary: "Conflicting form summary", confidence: "0.7" },
    JSON.stringify(structuredResult),
    structuredResult,
    undefined,
  );

  assert.equal(payload.summary, structuredResult.summary);
  assert.deepEqual(payload.citations, structuredResult.citations);
  assert.equal(payload.confidence, 0.72, "the form's 0.7 default must not conflict with structured confidence");
  assert.deepEqual(payload.structuredResult, structuredResult);
});

test("unstructured and partially structured submissions preserve legacy form values", () => {
  const buildPayload = loadReasoningResultPayload();
  const legacy = buildPayload(
    { provider: "claude", model: "", summary: "Owner-entered summary", confidence: "0.9" },
    "Legacy prose answer",
    { answer: "Legacy shape" },
    { title: "Review separately" },
  );

  assert.equal(legacy.summary, "Owner-entered summary");
  assert.equal(legacy.confidence, 0.9);
  assert.equal(Object.hasOwn(legacy, "citations"), false);
  assert.deepEqual(legacy.structuredResult, { answer: "Legacy shape" });
  assert.deepEqual(legacy.memoryPatch, { title: "Review separately" });
});

test("the dashboard asks for structured JSON when the receipt has a result contract", () => {
  assert.match(appSource, /const structuredRequired = Boolean\(detail\.bundle\?\.resultContract/);
  assert.match(appSource, /form\.dataset\.structuredRequired = structuredRequired/);
  assert.match(appSource, /Paste the complete structured JSON result from the prepared brief/);
  assert.match(appSource, /summaryLabel\.hidden = structuredRequired/);
});

test("saved decision results render the answer and full reasoning instead of collapsing to the ledger summary", () => {
  const { analyze, markup } = loadReasoningRunRendering();
  const structuredResult = {
    recommendation: "Keep the corridor contingency in place until physical throughput holds.",
    summary: "Crude shipments recovered faster than products and LNG, so the headline reopening overstates normalization.",
    options: [
      { name: "Keep the contingency", tradeoff: "Carries some idle cost but protects against another traffic retreat." },
      { name: "Stand down", tradeoff: "Saves cost now but depends on an unproved all-clear." },
    ],
    strongestEvidence: [
      { claim: "Crude exports recovered to roughly three quarters of prewar levels.", citationUrl: "https://example.com/crude" },
      { claim: "Products and LPG remained below half of prewar levels.", citationUrl: "https://example.net/products" },
    ],
    strongestContraryCase: "Security support could keep traffic moving despite intermittent attacks.",
    evidenceGaps: ["Daily LNG operating data remain incomplete."],
    reversalTrigger: "Stand down after several weeks of near-prewar throughput without attacks.",
    reversibleNextSteps: ["Keep weekly transit and export checks."],
    citations: ["https://example.com/crude", "https://example.net/products"],
    privateAnalysis: "must not render",
  };
  const run = {
    id: "run-1",
    provider: "ChatGPT",
    model: "subscription",
    status: "reviewed",
    confidence: 0.78,
    summary: "A lossy ledger summary.",
    structuredResult,
  };

  assert.deepEqual(JSON.parse(JSON.stringify(analyze(run))), {
    answer: structuredResult.recommendation,
    summary: structuredResult.summary,
    options: structuredResult.options,
    keyJudgments: structuredResult.strongestEvidence.map((item) => item.claim),
    strongestEvidence: structuredResult.strongestEvidence,
    outlook: "",
    alternativeCase: structuredResult.strongestContraryCase,
    gaps: structuredResult.evidenceGaps,
    whatWouldChange: [structuredResult.reversalTrigger],
    signposts: [],
    nextSteps: structuredResult.reversibleNextSteps,
    citations: structuredResult.citations,
  });

  const card = markup(run, () => "Approved");
  for (const expected of [
    "Answer", "Why this is happening", "Other options", "Alternative case",
    "Open questions", "What could change", "Next steps", "Sources",
  ]) assert.match(card, new RegExp(expected));
  assert.ok(card.indexOf(structuredResult.recommendation) < card.indexOf("Why this is happening"));
  assert.doesNotMatch(card, /privateAnalysis|must not render|<details[^>]* open/);
});

test("saved synthesis results render every substantive field and nested source once", () => {
  const { analyze, enrich } = loadReasoningRunRendering();
  const structuredResult = {
    schemaVersion: "1",
    answerMode: "synthesis",
    summary: "The route is open, but gas supply remains constrained.",
    confidence: 0.78,
    strongestEvidence: [
      { title: "Capacity damage", claim: "Damaged export trains still limit loadings.", citationUrl: "https://example.com/capacity" },
      { title: "Replacement supply", claim: "Other producers replaced only part of the loss.", citationUrl: "https://example.net/supply" },
    ],
    strongestContraryCase: {
      text: "A faster repair schedule could accelerate normalization.",
      citationUrls: ["https://example.com/capacity"],
    },
    watchFor: [{
      text: "Export train restarts lift realized loadings.",
      citationUrls: ["https://example.com/capacity"],
    }],
    citations: ["https://example.com/capacity", "https://example.net/supply"],
  };
  const detailedRun = { id: "run-2", structuredResult };
  const comparison = enrich({ runs: [{ id: "run-2", provider: "Claude" }] }, [detailedRun]);
  assert.deepEqual(comparison.runs[0].structuredResult, structuredResult);
  assert.deepEqual(JSON.parse(JSON.stringify(analyze(comparison.runs[0]))), {
    answer: structuredResult.summary,
    summary: "",
    options: [],
    keyJudgments: structuredResult.strongestEvidence.map((item) => `${item.title}: ${item.claim}`),
    strongestEvidence: structuredResult.strongestEvidence.map((item) => ({
      claim: `${item.title}: ${item.claim}`,
      citationUrl: item.citationUrl,
    })),
    outlook: "",
    alternativeCase: structuredResult.strongestContraryCase.text,
    gaps: [],
    whatWouldChange: [],
    signposts: structuredResult.watchFor.map((item) => item.text),
    nextSteps: [],
    citations: structuredResult.citations,
  });
  assert.match(appSource, /function reviewedRunsForShare[\s\S]*const analysis = reasoningRunAnalysis\(run\);/);
});
