import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let activeFixture;

function requiredFixture() {
  if (!activeFixture) throw new Error("Reasoning-ledger fixture is not active");
  return activeFixture;
}

const dbMock = {
  async getReasoningReceipt() {
    return requiredFixture().receipt;
  },
  async getReasoningRun(_db, id) {
    const run = requiredFixture().run;
    return run?.id === id ? run : null;
  },
  async insertReasoningReceipt() {
    throw new Error("Unexpected receipt insert");
  },
  async insertReasoningRun(_db, input) {
    const fixture = requiredFixture();
    fixture.calls.runInserts.push(input);
    fixture.calls.order.push("run-insert");
    const now = "2026-08-09T20:00:01.000Z";
    fixture.run = {
      id: input.id,
      receipt_id: input.receiptId,
      provider_label: input.providerLabel,
      model_label: input.modelLabel ?? null,
      client_label: input.clientLabel ?? null,
      status: "started",
      response_hash: null,
      response_r2_key: null,
      response_summary: "",
      structured_result_json: "{}",
      audit_json: "{}",
      outcome_json: "{}",
      confidence: null,
      rating: null,
      memory_proposal_id: null,
      started_at: now,
      completed_at: null,
      reviewed_at: null,
      created_at: now,
      updated_at: now,
    };
  },
  async listReasoningRunEvents() {
    return [];
  },
  async listReasoningRuns() {
    return [];
  },
  async recordReasoningRunEvent(_db, input) {
    const fixture = requiredFixture();
    fixture.calls.events.push(input);
    fixture.calls.order.push(`event:${input.eventType}`);
    return `event-${fixture.calls.events.length}`;
  },
  async updateReasoningReceipt(_db, _id, input) {
    const fixture = requiredFixture();
    fixture.calls.receiptUpdates.push(input);
    fixture.calls.order.push("receipt-update");
    fixture.receipt = {
      ...fixture.receipt,
      provider_label: input.providerLabel ?? fixture.receipt.provider_label,
      model_label: input.modelLabel ?? fixture.receipt.model_label,
      result_json: input.result ? JSON.stringify(input.result) : fixture.receipt.result_json,
      result_r2_key: input.resultR2Key ?? fixture.receipt.result_r2_key,
      confidence: input.confidence ?? fixture.receipt.confidence,
      citations_json: input.citations ? JSON.stringify(input.citations) : fixture.receipt.citations_json,
      decision_note: input.decisionNote ?? fixture.receipt.decision_note,
      status: input.status ?? fixture.receipt.status,
      completed_at: input.completedAt ?? fixture.receipt.completed_at,
    };
  },
  async updateReasoningRun(_db, _id, input) {
    const fixture = requiredFixture();
    fixture.calls.runUpdates.push(input);
    fixture.calls.order.push("run-update");
    fixture.run = {
      ...fixture.run,
      status: input.status ?? fixture.run.status,
      response_hash: input.responseHash ?? fixture.run.response_hash,
      response_r2_key: input.responseR2Key ?? fixture.run.response_r2_key,
      response_summary: input.responseSummary ?? fixture.run.response_summary,
      structured_result_json: input.structuredResult ? JSON.stringify(input.structuredResult) : fixture.run.structured_result_json,
      audit_json: input.audit ? JSON.stringify(input.audit) : fixture.run.audit_json,
      outcome_json: input.outcome ? JSON.stringify(input.outcome) : fixture.run.outcome_json,
      confidence: input.confidence ?? fixture.run.confidence,
      memory_proposal_id: input.memoryProposalId ?? fixture.run.memory_proposal_id,
      completed_at: input.completedAt ?? fixture.run.completed_at,
    };
  },
};

const memoryMock = {
  async stageMemoryProposal(_env, input) {
    const fixture = requiredFixture();
    fixture.calls.memory.push(input);
    fixture.calls.order.push("memory-stage");
    return { proposal: { id: "memory-proposal-one" } };
  },
};

const r2Mock = {
  async getEvidenceObject() {
    const fixture = requiredFixture();
    fixture.calls.r2Gets += 1;
    fixture.calls.order.push("receipt-read");
    if (fixture.missingBundle) return null;
    return {
      async json() {
        if (fixture.invalidBundleJson) throw new SyntaxError("invalid receipt JSON");
        return structuredClone(fixture.bundle);
      },
    };
  },
  async putEvidenceObject(_env, key, value, options) {
    const fixture = requiredFixture();
    fixture.calls.r2Puts.push({ key, value, options });
    fixture.calls.order.push("result-write");
    return { key };
  },
};

let ledger;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "./db") return dbMock;
    if (request === "./memory-graph") {
      return { ...originalLoad.call(this, request, parent, isMain), ...memoryMock };
    }
    if (request === "./reasoning") {
      return {
        buildReasoningBundle: async () => { throw new Error("Unexpected bundle build"); },
        reasoningBundleMarkdown: () => "",
      };
    }
    if (request === "./r2-budget") return r2Mock;
    if (request === "cloudflare:workers") return { WorkflowEntrypoint: class WorkflowEntrypoint {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  ledger = require("../.test-dist/reasoning-ledger.js");
} finally {
  Module._load = originalLoad;
}

const { reasoningResultContract } = require("../.test-dist/reasoning.js");
const { sha256 } = require("../.test-dist/security.js");
const { HttpError, stableStringify } = require("../.test-dist/utils.js");

const URLS = [
  "https://example.com/primary",
  "https://example.net/independent",
  "https://example.org/contrary",
];

function validStructuredResult(urls = URLS) {
  const citations = urls.slice(0, Math.min(2, urls.length));
  return {
    recommendation: "Run one bounded canary before expanding the workflow.",
    confidence: 0.72,
    summary: "A small canary tests the decisive uncertainty while preserving a cheap rollback.",
    options: [
      { name: "Bounded canary", tradeoff: "Adds one validation cycle but limits exposure." },
      { name: "Broad rollout", tradeoff: "Produces faster volume but raises the cost of a hidden failure." },
    ],
    strongestEvidence: citations.map((citationUrl, index) => ({
      claim: index === 0 ? "The primary source supports a bounded trial." : "Independent evidence identifies the same approval boundary.",
      citationUrl,
    })),
    strongestContraryCase: "A small sample may miss failures that appear only under broad concurrency.",
    evidenceGaps: ["The receipt does not establish the long-run failure rate."],
    reversalTrigger: "Reverse the recommendation if the canary omits any required approval event.",
    reversibleNextSteps: ["Run the canary with a fixed cohort and stop condition."],
    irreversibleCommitments: [],
    citations,
  };
}

function validSynthesisResult(urls = URLS) {
  const citations = urls.slice(0, Math.min(2, urls.length));
  return {
    schemaVersion: "1",
    answerMode: "synthesis",
    summary: "The bounded canary is the best-supported next move because it tests the decisive uncertainty while preserving rollback.",
    confidence: 0.72,
    strongestEvidence: citations.map((citationUrl, index) => ({
      title: index === 0 ? "Bounded trial" : "Independent approval boundary",
      claim: index === 0 ? "The primary source supports a bounded trial." : "Independent evidence identifies the same approval boundary.",
      citationUrl,
    })),
    citations,
    strongestContraryCase: {
      text: "Failures visible only under broad concurrency could make the canary falsely reassuring.",
      citationUrls: urls.length > 2 ? [urls[2]] : [],
    },
    watchFor: [{
      text: "A missing approval event in the canary would weaken the synthesis.",
      citationUrls: citations.slice(0, 1),
    }],
  };
}

function validMemoryPatch() {
  return {
    schemaVersion: "1",
    title: "Review the canary conclusion",
    nodes: [{
      key: "finding:bounded-canary",
      type: "finding",
      label: "A bounded canary is the next validation move",
      summary: "The canary preserves rollback while testing the decisive uncertainty.",
    }],
    edges: [],
  };
}

function expect422(action, code) {
  let caught;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HttpError);
  assert.equal(caught.status, 422);
  assert.equal(caught.details?.code, code);
  return caught;
}

async function expect422Async(action, code) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HttpError);
  assert.equal(caught.status, 422);
  assert.equal(caught.details?.code, code);
  return caught;
}

function mutationSnapshot(calls) {
  return {
    r2Puts: calls.r2Puts.length,
    memory: calls.memory.length,
    runUpdates: calls.runUpdates.length,
    receiptUpdates: calls.receiptUpdates.length,
    events: calls.events.length,
    taskUpdates: calls.taskUpdates,
  };
}

async function fixtureFor(options = {}) {
  const resultContract = options.resultContract === "missing"
    ? undefined
    : options.resultContract ?? reasoningResultContract("decision", options.urls ?? URLS);
  const bundle = {
    schemaVersion: "3",
    generatedAt: "2026-08-09T20:00:00.000Z",
    receiptId: "receipt-validation",
    task: "decision",
    target: "generic",
    sourceScope: "open",
    title: "Bounded validation decision",
    objective: "Choose the next validation move.",
    ...(resultContract === undefined ? {} : { resultContract }),
  };
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = bundle;
  const bundleHash = await sha256(stableStringify(hashableBundle));
  const calls = {
    order: [],
    r2Gets: 0,
    r2Puts: [],
    memory: [],
    runInserts: [],
    runUpdates: [],
    receiptUpdates: [],
    events: [],
    taskClaims: 0,
    taskUpdates: 0,
  };
  return {
    calls,
    bundle,
    missingBundle: Boolean(options.missingBundle),
    invalidBundleJson: Boolean(options.invalidBundleJson),
    receipt: {
      id: "receipt-validation",
      scope_kind: "mission",
      scope_id: "mission-validation",
      task: "decision",
      target: "generic",
      title: "Bounded validation decision",
      objective: "Choose the next validation move.",
      bundle_version: 3,
      bundle_hash: options.bundleHash ?? bundleHash,
      bundle_r2_key: "reasoning/receipt-validation/bundle.json",
      quality_json: "{}",
      estimated_tokens: 1200,
      evidence_count: options.urls?.length ?? URLS.length,
      independent_family_count: 2,
      provider_label: null,
      model_label: null,
      result_json: "{}",
      result_r2_key: null,
      confidence: null,
      citations_json: "[]",
      decision_note: null,
      status: "prepared",
      completed_at: null,
      created_at: "2026-08-09T20:00:00.000Z",
      updated_at: "2026-08-09T20:00:00.000Z",
    },
    run: {
      id: "run-validation",
      receipt_id: "receipt-validation",
      provider_label: "subscription-client",
      model_label: "model-one",
      client_label: "test-client",
      status: "started",
      response_hash: null,
      response_r2_key: null,
      response_summary: "",
      structured_result_json: "{}",
      audit_json: "{}",
      outcome_json: "{}",
      confidence: null,
      rating: null,
      memory_proposal_id: null,
      started_at: "2026-08-09T20:00:00.000Z",
      completed_at: null,
      reviewed_at: null,
      created_at: "2026-08-09T20:00:00.000Z",
      updated_at: "2026-08-09T20:00:00.000Z",
    },
    env: {
      DB: {
        prepare(query) {
          const claim = /UPDATE reasoning_tasks SET status = 'claimed'/.test(query);
          assert.ok(claim || /UPDATE reasoning_tasks SET status = 'completed'/.test(query));
          return {
            bind() { return this; },
            async run() {
              if (claim) {
                calls.taskClaims += 1;
                calls.order.push("task-claim");
              } else {
                calls.taskUpdates += 1;
                calls.order.push("task-update");
              }
              return { success: true };
            },
          };
        },
      },
      EVIDENCE: {},
    },
  };
}

test("pure canonicalizer accepts contracted decisions with zero, one, or several available citations", () => {
  for (const urls of [[], URLS.slice(0, 1), URLS]) {
    const structuredResult = validStructuredResult(urls);
    const canonical = ledger.canonicalizeReasoningResult(
      { resultContract: reasoningResultContract("decision", urls) },
      { structuredResult },
      "raw response is not canonical",
    );
    assert.equal(canonical.contractEnforced, true);
    assert.equal(canonical.summary, structuredResult.summary);
    assert.deepEqual(canonical.citations, structuredResult.citations);
    assert.equal(canonical.confidence, structuredResult.confidence);
    assert.equal(canonical.structuredResult, structuredResult);
  }
});

test("pure canonicalizer accepts the saved synthesis contract without ledger-specific aliases", () => {
  for (const task of ["investigate", "challenge", "deep-research"]) {
    const structuredResult = validSynthesisResult();
    const canonical = ledger.canonicalizeReasoningResult(
      { resultContract: reasoningResultContract(task, URLS) },
      { structuredResult },
      "raw response is not canonical",
    );
    assert.equal(canonical.contractEnforced, true);
    assert.equal(canonical.summary, structuredResult.summary);
    assert.deepEqual(canonical.citations, structuredResult.citations);
    assert.equal(canonical.confidence, structuredResult.confidence);
    assert.equal(canonical.structuredResult, structuredResult);
  }
});

test("legacy unstructured answers keep a substantial saved summary", () => {
  const response = `${"A concrete causal finding. ".repeat(260)}Final conclusion.`;
  const canonical = ledger.canonicalizeReasoningResult(
    { resultContract: {} },
    {},
    response,
  );

  assert.equal(canonical.contractEnforced, false);
  assert.ok(canonical.summary.length > 4_000, "legacy answers must not collapse into a 1,200-character teaser");
  assert.ok(canonical.summary.length <= 8_000);
  assert.match(canonical.summary, /^A concrete causal finding\./);
});

test("pure canonicalizer rejects invented, duplicate, mismatched, extra, overbound, and incomplete results", () => {
  const contract = reasoningResultContract("decision", URLS);
  const cases = [
    {
      name: "invented URL",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        result.citations = ["https://invented.example/source", URLS[1]];
        result.strongestEvidence[0].citationUrl = "https://invented.example/source";
      },
    },
    {
      name: "duplicate citation",
      code: "REASONING_RESULT_CITATIONS_DUPLICATE",
      change(result) {
        result.citations = [URLS[0], URLS[0]];
        result.strongestEvidence[1].citationUrl = URLS[0];
      },
    },
    {
      name: "citation/evidence mismatch",
      code: "REASONING_RESULT_CITATIONS_MISMATCH",
      change(result) {
        result.strongestEvidence[1].citationUrl = URLS[2];
      },
    },
    {
      name: "extra property",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        result.auditAppendix = ["unbounded"];
      },
    },
    {
      name: "overbound gaps",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        result.evidenceGaps = ["one", "two", "three", "four", "five"];
      },
    },
    {
      name: "missing required field",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        delete result.summary;
      },
    },
    {
      name: "empty recommendation",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        result.recommendation = "";
      },
    },
    {
      name: "oversized summary",
      code: "REASONING_RESULT_CONTRACT_MISMATCH",
      change(result) {
        result.summary = "x".repeat(8_001);
      },
    },
  ];
  for (const entry of cases) {
    const structuredResult = structuredClone(validStructuredResult());
    entry.change(structuredResult);
    const caught = expect422(
      () => ledger.canonicalizeReasoningResult({ resultContract: contract }, { structuredResult }, ""),
      entry.code,
    );
    assert.ok(caught.message, entry.name);
  }
});

test("pure canonicalizer rejects conflicting top-level duplicates", () => {
  const structuredResult = validStructuredResult();
  const bundle = { resultContract: reasoningResultContract("decision", URLS) };
  for (const [field, value] of [
    ["summary", "A conflicting summary"],
    ["citations", [...structuredResult.citations].reverse()],
    ["confidence", 0.21],
  ]) {
    const caught = expect422(
      () => ledger.canonicalizeReasoningResult(bundle, { structuredResult, [field]: value }, ""),
      "REASONING_RESULT_TOP_LEVEL_CONFLICT",
    );
    assert.equal(caught.details.field, field);
  }
});

test("pure Memory validation returns a canonical patch and rejects invalid proposals", () => {
  const canonical = ledger.canonicalizeReasoningMemoryPatch(validMemoryPatch());
  assert.equal(canonical.schemaVersion, "1");
  assert.equal(canonical.nodes.length, 1);
  assert.equal(canonical.nodes[0].key, "finding:bounded-canary");

  expect422(
    () => ledger.canonicalizeReasoningMemoryPatch({ schemaVersion: "1", title: "Empty", nodes: [], edges: [] }),
    "REASONING_MEMORY_PATCH_INVALID",
  );
  expect422(
    () => ledger.canonicalizeReasoningMemoryPatch({ schemaVersion: "1", title: "Unknown field", nodes: validMemoryPatch().nodes, edges: [], extra: true }),
    "REASONING_MEMORY_PATCH_INVALID",
  );
});

test("contracted ledger completion accepts zero, one, and several receipt citation choices", async () => {
  for (const urls of [[], URLS.slice(0, 1), URLS]) {
    activeFixture = await fixtureFor({ urls });
    const structuredResult = validStructuredResult(urls);
    await ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, { structuredResult });
    const stored = JSON.parse(activeFixture.calls.r2Puts[0].value);
    assert.equal(stored.summary, structuredResult.summary);
    assert.deepEqual(stored.citations, structuredResult.citations);
    assert.equal(stored.confidence, structuredResult.confidence);
    assert.deepEqual(JSON.parse(activeFixture.run.structured_result_json), structuredResult);
    assert.equal(activeFixture.run.response_summary, structuredResult.summary);
    assert.equal(activeFixture.run.confidence, structuredResult.confidence);
    assert.deepEqual(JSON.parse(activeFixture.receipt.result_json), structuredResult);
    assert.deepEqual(JSON.parse(activeFixture.receipt.citations_json), structuredResult.citations);
    assert.equal(activeFixture.receipt.confidence, structuredResult.confidence);
    assert.equal(JSON.parse(activeFixture.run.audit_json).resultContractEnforced, true);
  }
  activeFixture = undefined;
});

test("valid completion verifies the bundle before canonical writes and Memory staging", async () => {
  activeFixture = await fixtureFor();
  const structuredResult = validStructuredResult();
  await ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, {
    structuredResult,
    summary: structuredResult.summary,
    citations: structuredResult.citations,
    confidence: structuredResult.confidence,
    memoryPatch: validMemoryPatch(),
  });

  assert.deepEqual(activeFixture.calls.order, [
    "receipt-read",
    "result-write",
    "memory-stage",
    "event:memory-proposed",
    "run-update",
    "receipt-update",
    "event:completed",
    "task-update",
  ]);
  assert.equal(activeFixture.calls.memory.length, 1);
  assert.equal(activeFixture.run.memory_proposal_id, "memory-proposal-one");
  assert.deepEqual(mutationSnapshot(activeFixture.calls), {
    r2Puts: 1,
    memory: 1,
    runUpdates: 1,
    receiptUpdates: 1,
    events: 2,
    taskUpdates: 1,
  });
  activeFixture = undefined;
});

test("a valid result with an invalid Memory patch fails before result or ledger mutation", async () => {
  for (const resultContract of [reasoningResultContract("decision", URLS), {}]) {
    activeFixture = await fixtureFor({ resultContract });
    await expect422Async(
      () => ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, {
        structuredResult: validStructuredResult(),
        memoryPatch: { schemaVersion: "1", title: "Empty proposal", nodes: [], edges: [] },
      }),
      "REASONING_MEMORY_PATCH_INVALID",
    );
    assert.equal(activeFixture.calls.r2Gets, 1);
    assert.deepEqual(mutationSnapshot(activeFixture.calls), {
      r2Puts: 0,
      memory: 0,
      runUpdates: 0,
      receiptUpdates: 0,
      events: 0,
      taskUpdates: 0,
    });
    assert.equal(activeFixture.calls.runInserts.length, 0);
    assert.equal(activeFixture.calls.taskClaims, 0);
    assert.deepEqual(activeFixture.calls.order, ["receipt-read"]);
  }
  activeFixture = undefined;
});

test("every invalid contracted result fails before R2, D1, task, event, or Memory mutation", async () => {
  const invalidResults = [];
  for (const change of [
    (result) => { result.citations = [URLS[0], URLS[0]]; result.strongestEvidence[1].citationUrl = URLS[0]; },
    (result) => { result.strongestEvidence[1].citationUrl = URLS[2]; },
    (result) => { result.citations = ["https://invented.example/source", URLS[1]]; result.strongestEvidence[0].citationUrl = "https://invented.example/source"; },
    (result) => { result.extra = true; },
    (result) => { result.reversibleNextSteps = ["one", "two", "three", "four", "five"]; },
    (result) => { delete result.summary; },
    (result) => { result.recommendation = ""; },
    (result) => { result.summary = "x".repeat(8_001); },
  ]) {
    const result = structuredClone(validStructuredResult());
    change(result);
    invalidResults.push(result);
  }
  invalidResults.push(validStructuredResult());

  for (const [index, structuredResult] of invalidResults.entries()) {
    activeFixture = await fixtureFor();
    const input = {
      structuredResult,
      memoryPatch: { schemaVersion: "1", title: "Must not stage", nodes: [], edges: [] },
      ...(index === invalidResults.length - 1 ? { confidence: 0.1 } : {}),
    };
    await expect422Async(
      () => ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, input),
      index === 0
        ? "REASONING_RESULT_CITATIONS_DUPLICATE"
        : index === 1
          ? "REASONING_RESULT_CITATIONS_MISMATCH"
          : index === invalidResults.length - 1
            ? "REASONING_RESULT_TOP_LEVEL_CONFLICT"
            : "REASONING_RESULT_CONTRACT_MISMATCH",
    );
    assert.equal(activeFixture.calls.r2Gets, 1);
    assert.deepEqual(mutationSnapshot(activeFixture.calls), {
      r2Puts: 0,
      memory: 0,
      runUpdates: 0,
      receiptUpdates: 0,
      events: 0,
      taskUpdates: 0,
    });
    assert.deepEqual(activeFixture.calls.order, ["receipt-read"]);
  }
  activeFixture = undefined;
});

test("missing, malformed, mismatched, and tampered receipt bundles fail with 422 before result side effects", async () => {
  const cases = [
    { options: { missingBundle: true }, code: "REASONING_RECEIPT_BUNDLE_MISSING" },
    { options: { invalidBundleJson: true }, code: "REASONING_RECEIPT_BUNDLE_INVALID" },
    { options: {}, code: "REASONING_RECEIPT_BUNDLE_INVALID", mutate: (fixture) => { fixture.bundle.receiptId = "receipt-other"; } },
    { options: {}, code: "REASONING_RECEIPT_BUNDLE_HASH_MISMATCH", mutate: (fixture) => { fixture.bundle.objective = "Tampered after hashing"; } },
  ];
  for (const entry of cases) {
    activeFixture = await fixtureFor(entry.options);
    entry.mutate?.(activeFixture);
    await expect422Async(
      () => ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, {
        structuredResult: validStructuredResult(),
        memoryPatch: { title: "Must not stage" },
      }),
      entry.code,
    );
    assert.deepEqual(mutationSnapshot(activeFixture.calls), {
      r2Puts: 0,
      memory: 0,
      runUpdates: 0,
      receiptUpdates: 0,
      events: 0,
      taskUpdates: 0,
    });
  }
  activeFixture = undefined;
});

test("invalid and tampered API/MCP-style one-step results create no run, event, claim, result, or Memory side effect", async () => {
  const callers = [
    { provider: "chatgpt", model: "subscription-gpt", client: "driftglass-dashboard" },
    { provider: "claude", model: "subscription-claude", client: "driftglass-operations-mcp" },
  ];
  for (const caller of callers) {
    for (const failure of ["invalid-result", "tampered-bundle", "invalid-memory"]) {
      activeFixture = await fixtureFor();
      const structuredResult = validStructuredResult();
      let memoryPatch;
      if (failure === "invalid-result") delete structuredResult.summary;
      if (failure === "tampered-bundle") activeFixture.bundle.objective = "Tampered after receipt hashing";
      if (failure === "invalid-memory") memoryPatch = { schemaVersion: "1", title: "Empty", nodes: [], edges: [] };

      await expect422Async(
        () => ledger.recordReasoningResult(activeFixture.env, {
          receiptId: activeFixture.receipt.id,
          ...caller,
          response: "One-step subscription result",
          structuredResult,
          memoryPatch,
        }),
        failure === "tampered-bundle"
          ? "REASONING_RECEIPT_BUNDLE_HASH_MISMATCH"
          : failure === "invalid-memory"
            ? "REASONING_MEMORY_PATCH_INVALID"
            : "REASONING_RESULT_CONTRACT_MISMATCH",
      );
      assert.equal(activeFixture.calls.r2Gets, 1);
      assert.equal(activeFixture.calls.runInserts.length, 0);
      assert.equal(activeFixture.calls.taskClaims, 0);
      assert.deepEqual(mutationSnapshot(activeFixture.calls), {
        r2Puts: 0,
        memory: 0,
        runUpdates: 0,
        receiptUpdates: 0,
        events: 0,
        taskUpdates: 0,
      });
      assert.deepEqual(activeFixture.calls.order, ["receipt-read"]);
    }
  }
  activeFixture = undefined;
});

test("valid API/MCP-style one-step results verify once and preserve run attribution", async () => {
  const callers = [
    { provider: "chatgpt", model: "subscription-gpt", client: "driftglass-dashboard" },
    { provider: "claude", model: "subscription-claude", client: "driftglass-operations-mcp" },
  ];
  for (const caller of callers) {
    activeFixture = await fixtureFor();
    const completed = await ledger.recordReasoningResult(activeFixture.env, {
      receiptId: activeFixture.receipt.id,
      ...caller,
      response: "One-step subscription result",
      structuredResult: validStructuredResult(),
    });

    assert.equal(activeFixture.calls.r2Gets, 1, "one-step completion must reuse its verified receipt");
    assert.equal(activeFixture.calls.runInserts.length, 1);
    assert.equal(activeFixture.calls.taskClaims, 1);
    assert.equal(completed.run.provider_label, caller.provider);
    assert.equal(completed.run.model_label, caller.model);
    assert.equal(completed.run.client_label, caller.client);
    assert.deepEqual(activeFixture.calls.order, [
      "receipt-read",
      "run-insert",
      "event:started",
      "task-claim",
      "result-write",
      "run-update",
      "receipt-update",
      "event:completed",
      "task-update",
    ]);
  }
  activeFixture = undefined;
});

test("completed-run replay stays idempotent without re-reading or mutating its receipt", async () => {
  activeFixture = await fixtureFor();
  activeFixture.run.status = "completed";
  activeFixture.run.memory_proposal_id = "memory-existing";
  const completed = await ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, {
    structuredResult: {},
    memoryPatch: { invalid: true },
  });

  assert.equal(completed.run, activeFixture.run);
  assert.equal(completed.memoryProposalId, "memory-existing");
  assert.equal(activeFixture.calls.r2Gets, 0);
  assert.equal(activeFixture.calls.runInserts.length, 0);
  assert.equal(activeFixture.calls.taskClaims, 0);
  assert.deepEqual(mutationSnapshot(activeFixture.calls), {
    r2Puts: 0,
    memory: 0,
    runUpdates: 0,
    receiptUpdates: 0,
    events: 0,
    taskUpdates: 0,
  });
  assert.deepEqual(activeFixture.calls.order, []);
  activeFixture = undefined;
});

test("historical receipts without a result contract preserve permissive completion behavior", async () => {
  for (const resultContract of ["missing", {}]) {
    activeFixture = await fixtureFor({ resultContract });
    await ledger.completeReasoningRun(activeFixture.env, activeFixture.run.id, {
      response: "Unstructured historical response",
      summary: "Owner-supplied historical summary",
      citations: ["historical-reference"],
      confidence: 0.61,
      structuredResult: { answer: "Legacy answer shape" },
    });
    const stored = JSON.parse(activeFixture.calls.r2Puts[0].value);
    assert.equal(stored.summary, "Owner-supplied historical summary");
    assert.deepEqual(stored.citations, ["historical-reference"]);
    assert.equal(stored.confidence, 0.61);
    assert.deepEqual(stored.structuredResult, { answer: "Legacy answer shape" });
    assert.equal(JSON.parse(activeFixture.run.audit_json).resultContractEnforced, false);
  }
  activeFixture = undefined;
});
