import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let projectReviewedAnswerForShare;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") return { tracing: { trace: (_name, operation) => operation } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ projectReviewedAnswerForShare } = require("../.test-dist/shares.js"));
} finally {
  Module._load = originalLoad;
}
const { sha256 } = require("../.test-dist/security.js");
const { stableStringify } = require("../.test-dist/utils.js");

async function hashBundle(bundle) {
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = bundle;
  return sha256(stableStringify(hashableBundle));
}

async function withSignedBundle(input, bundle) {
  return {
    ...input,
    bundle,
    receipt: { ...input.receipt, bundle_hash: await hashBundle(bundle) },
  };
}

async function fixture() {
  const bundle = {
    schemaVersion: "3",
    sourceScope: "share",
    receiptId: "receipt-private-id",
    generatedAt: "2026-08-08T12:00:00.000Z",
    evidence: [{
      accessClass: "public",
      sourceKind: "web",
      title: "Public evidence",
      url: "https://public.example/evidence",
    }],
    coverage: { localEvidenceCount: 0 },
  };
  const bundleHash = await hashBundle(bundle);
  const receipt = {
    id: bundle.receiptId,
    scope_kind: "story",
    scope_id: "story-1",
    bundle_hash: bundleHash,
  };
  const run = {
    id: "run-private-id",
    receipt_id: receipt.id,
    status: "reviewed",
    reviewed_at: "2026-08-08T13:00:00.000Z",
    structured_result_json: JSON.stringify({
      answer: "<strong>Public conclusion</strong>",
      whyItMatters: "It changes the next decision.",
      whatToWatch: ["A primary-source update"],
      uncertainties: ["The timing remains unclear"],
      privateAnalysis: "must not cross",
      provider: "must not cross",
    }),
  };
  return { bundle, receipt, run };
}

test("an explicitly selected reviewed answer is reduced to the public editorial allowlist and exact snapshot hash", async () => {
  const input = await fixture();
  const answer = await projectReviewedAnswerForShare({ kind: "story", id: "story-1", ...input });
  assert.deepEqual(answer, {
    answer: "Public conclusion",
    whyItMatters: "It changes the next decision.",
    whatToWatch: ["A primary-source update"],
    uncertainty: ["The timing remains unclear"],
    evidenceSnapshotHash: input.receipt.bundle_hash,
    reviewedAt: input.run.reviewed_at,
  });
  assert.doesNotMatch(JSON.stringify(answer), /privateAnalysis|provider|receipt-private-id|run-private-id|<strong>/);
});

test("reviewed decision fields become a rich public answer without passing unknown fields through", async () => {
  const input = await fixture();
  input.run.structured_result_json = JSON.stringify({
    recommendation: "Keep the contingency until physical throughput holds.",
    summary: "Crude recovered faster than products and LNG.",
    options: [
      { name: "Keep it", tradeoff: "Costs more now but preserves protection." },
      { name: "Stand down", tradeoff: "Saves now but accepts renewed disruption." },
    ],
    strongestEvidence: [
      {
        claim: "Crude exports recovered to roughly three quarters of prewar levels.",
        citationUrl: "https://public.example/evidence",
        privateSourceNote: "PRIVATE SOURCE NOTE",
      },
      {
        claim: "Products remained below half of prewar levels.",
        citationUrls: [
          "https://public.example/evidence",
          "https://public.example/evidence",
          "https://public.example/evidence?altered=1",
          "http://127.0.0.1/private",
        ],
        internalEvidenceId: "PRIVATE EVIDENCE ID",
      },
    ],
    strongestContraryCase: "Security support could keep traffic moving.",
    evidenceGaps: ["Daily LNG operating data remain incomplete."],
    reversalTrigger: "Exports hold near prewar levels for several weeks without attacks.",
    reversibleNextSteps: ["Keep weekly transit and export checks."],
    irreversibleCommitments: ["PRIVATE BOARD COMMITMENT"],
    privateAnalysis: "PRIVATE ANALYSIS",
  });

  const answer = await projectReviewedAnswerForShare({ kind: "story", id: "story-1", ...input });
  assert.deepEqual(answer, {
    answer: "Keep the contingency until physical throughput holds.",
    whyItMatters: "Crude recovered faster than products and LNG.",
    keyJudgments: [
      {
        text: "Crude exports recovered to roughly three quarters of prewar levels.",
        citationUrls: ["https://public.example/evidence"],
      },
      {
        text: "Products remained below half of prewar levels.",
        citationUrls: ["https://public.example/evidence"],
      },
    ],
    options: [
      { name: "Keep it", tradeoff: "Costs more now but preserves protection." },
      { name: "Stand down", tradeoff: "Saves now but accepts renewed disruption." },
    ],
    alternativeCase: "Security support could keep traffic moving.",
    whatWouldChange: ["Exports hold near prewar levels for several weeks without attacks."],
    nextSteps: ["Keep weekly transit and export checks."],
    whatToWatch: undefined,
    uncertainty: ["Daily LNG operating data remain incomplete."],
    evidenceSnapshotHash: input.receipt.bundle_hash,
    reviewedAt: input.run.reviewed_at,
  });
  const serialized = JSON.stringify(answer);
  assert.doesNotMatch(serialized, /PRIVATE|privateAnalysis|irreversibleCommitments|privateSourceNote|internalEvidenceId/);
  assert.doesNotMatch(serialized, /altered=1|127\.0\.0\.1|"citationUrl":/);
});

test("future analysis fields retain their public synthesis shape", async () => {
  const input = await fixture();
  input.run.structured_result_json = JSON.stringify({
    answer: "The route is open, but normalization is incomplete.",
    keyJudgments: [
      "Insurance still suppresses traffic.",
      {
        title: "Repair lag",
        text: { text: "LNG repairs trail crude recovery." },
        citationUrls: ["https://public.example/evidence", "https://unknown.example/claim"],
        privateAnalysis: "PRIVATE JUDGMENT NOTE",
      },
      {
        text: "An unsupported judgment remains readable without a source link.",
        citationUrls: ["https://unknown.example/unsupported"],
      },
    ],
    outlook: { text: { text: "Crude should recover before gas and products." } },
    alternativeCase: "A durable ceasefire could accelerate the recovery.",
    whatWouldChange: "Several weeks of near-prewar throughput without attacks.",
    signposts: ["A lower JMIC threat level", "LNG train restarts"],
    nextSteps: [{ action: "Track daily transits and weekly exports." }],
  });

  const answer = await projectReviewedAnswerForShare({ kind: "story", id: "story-1", ...input });
  assert.deepEqual(answer, {
    answer: "The route is open, but normalization is incomplete.",
    whyItMatters: undefined,
    keyJudgments: [
      "Insurance still suppresses traffic.",
      {
        text: "Repair lag: LNG repairs trail crude recovery.",
        citationUrls: ["https://public.example/evidence"],
      },
      "An unsupported judgment remains readable without a source link.",
    ],
    outlook: "Crude should recover before gas and products.",
    alternativeCase: "A durable ceasefire could accelerate the recovery.",
    whatWouldChange: ["Several weeks of near-prewar throughput without attacks."],
    signposts: ["A lower JMIC threat level", "LNG train restarts"],
    nextSteps: ["Track daily transits and weekly exports."],
    whatToWatch: undefined,
    uncertainty: undefined,
    evidenceSnapshotHash: input.receipt.bundle_hash,
    reviewedAt: input.run.reviewed_at,
  });
  assert.doesNotMatch(JSON.stringify(answer), /unknown\.example|PRIVATE JUDGMENT NOTE|privateAnalysis/);
});

test("contracted saved synthesis maps to the public answer without a second hand-authored shape", async () => {
  const input = await fixture();
  input.run.structured_result_json = JSON.stringify({
    schemaVersion: "1",
    answerMode: "synthesis",
    summary: "The route has reopened, but damaged export capacity still constrains supply.",
    confidence: 0.8,
    strongestEvidence: [{
      title: "Capacity is now the constraint",
      claim: "Damaged liquefaction trains still hold Gulf loadings below normal.",
      citationUrl: "https://public.example/evidence",
    }],
    strongestContraryCase: {
      text: "Earlier train restarts could close the remaining deficit faster.",
      citationUrls: ["https://public.example/evidence"],
    },
    watchFor: [{
      text: "Realized cargo loadings rise with announced train restarts.",
      citationUrls: ["https://public.example/evidence"],
    }],
    citations: ["https://public.example/evidence"],
  });

  const answer = await projectReviewedAnswerForShare({ kind: "story", id: "story-1", ...input });
  assert.deepEqual(answer, {
    answer: "The route has reopened, but damaged export capacity still constrains supply.",
    whyItMatters: undefined,
    keyJudgments: [{
      text: "Capacity is now the constraint: Damaged liquefaction trains still hold Gulf loadings below normal.",
      citationUrls: ["https://public.example/evidence"],
    }],
    alternativeCase: {
      text: "Earlier train restarts could close the remaining deficit faster.",
      citationUrls: ["https://public.example/evidence"],
    },
    signposts: [{
      text: "Realized cargo loadings rise with announced train restarts.",
      citationUrls: ["https://public.example/evidence"],
    }],
    whatToWatch: undefined,
    uncertainty: undefined,
    evidenceSnapshotHash: input.receipt.bundle_hash,
    reviewedAt: input.run.reviewed_at,
  });
});

test("unreviewed, rejected, wrong-scope, private-evidence, and tampered selections all fail closed", async () => {
  const input = await fixture();
  const evidence = input.bundle.evidence[0];
  const { url: _url, ...missingUrlEvidence } = evidence;
  const { sourceKind: _sourceKind, ...missingSourceKindEvidence } = evidence;
  const variants = [
    { ...input, run: { ...input.run, status: "completed" } },
    { ...input, run: { ...input.run, status: "rejected" } },
    { ...input, receipt: { ...input.receipt, scope_id: "story-2" } },
    await withSignedBundle(input, { ...input.bundle, sourceScope: "personal" }),
    await withSignedBundle(input, { ...input.bundle, sourceScope: "open" }),
    await withSignedBundle(input, { ...input.bundle, coverage: { localEvidenceCount: 1 } }),
    await withSignedBundle(input, { ...input.bundle, evidence: [{ ...evidence, accessClass: "authenticated-local" }] }),
    await withSignedBundle(input, { ...input.bundle, evidence: [{ ...evidence, sourceKind: "collector" }] }),
    await withSignedBundle(input, { ...input.bundle, evidence: [{ ...evidence, sourceKind: "email" }] }),
    await withSignedBundle(input, { ...input.bundle, evidence: [missingSourceKindEvidence] }),
    await withSignedBundle(input, { ...input.bundle, evidence: [missingUrlEvidence] }),
    await withSignedBundle(input, { ...input.bundle, evidence: [{ ...evidence, url: "https://public.example/evidence?token=private" }] }),
    { ...input, receipt: { ...input.receipt, bundle_hash: "0".repeat(64) } },
  ];
  for (const variant of variants) {
    assert.equal(await projectReviewedAnswerForShare({ kind: "story", id: "story-1", ...variant }), null);
  }
});
