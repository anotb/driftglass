import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const observedAt = new Date().toISOString();

function evidence(overrides) {
  return {
    story_id: "story-reasoning",
    item_id: "item-base",
    source_id: "source-base",
    source_name: "Public source",
    source_kind: "web",
    source_config_json: "{}",
    source_health_score: 1,
    source_weight: 1,
    title: "Substantive public evidence",
    url: "https://example.com/evidence",
    author: "Fixture",
    published_at: observedAt,
    observed_at: observedAt,
    access_class: "public",
    metadata_json: "{}",
    text: "A substantive source describes a concrete change and its consequence.",
    family_key: "domain:example.com",
    origin_item_id: null,
    origin_family_key: null,
    lineage_relation: "origin",
    title_similarity: null,
    body_similarity: null,
    lineage_independent: 1,
    lineage_rationale: null,
    ...overrides,
  };
}

const substantive = [
  evidence({
    item_id: "mcp-spec",
    source_id: "mcp-specification",
    source_name: "Model Context Protocol",
    title: "MCP favors a stateless core",
    url: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports",
    text: "The specification defines a stateless core while allowing bounded transport behavior around it.",
    family_key: "domain:modelcontextprotocol.io",
  }),
  evidence({
    item_id: "codex-release",
    source_id: "codex-releases",
    source_name: "OpenAI Codex releases",
    source_kind: "github_releases",
    title: "Codex approval review update",
    url: "https://github.com/openai/codex/releases/tag/rust-v0.147.0",
    text: "Codex added auto-reviewed approvals so bounded tool decisions can remain visible in task flow.",
    family_key: "github:openai/codex",
  }),
  evidence({
    item_id: "claude-release",
    source_id: "claude-releases",
    source_name: "Claude Code releases",
    source_kind: "github_releases",
    title: "Claude Code structured elicitation update",
    url: "https://github.com/anthropics/claude-code/releases/tag/v2.1.217",
    text: "Claude Code added structured MCP elicitation for collecting required human input during a task.",
    family_key: "github:anthropics/claude-code",
  }),
  evidence({
    item_id: "arxiv-study",
    source_id: "arxiv-agent-study",
    source_name: "arXiv",
    source_kind: "arxiv",
    title: "A controlled study of coding-agent workflows",
    url: "https://arxiv.org/abs/2608.01234",
    text: "The study reports that explicit approval boundaries improve provenance completeness in its evaluated workflow.",
    family_key: "arxiv:2608.01234",
  }),
];

const emptyCloudflare = Array.from({ length: 4 }, (_, index) => evidence({
  item_id: `cloudflare-empty-${index + 1}`,
  source_id: "cloudflare-releases",
  source_name: "Cloudflare releases",
  source_kind: "github_releases",
  title: `cloudflare/workers-sdk workers-sdk@4.${120 + index}.0`,
  url: `https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.${120 + index}.0`,
  text: index % 2 ? "   \n\t" : "",
  family_key: "github:cloudflare/workers-sdk",
  origin_item_id: "cloudflare-origin",
  origin_family_key: "github:cloudflare/workers-sdk",
  lineage_relation: "echo",
  lineage_independent: 0,
  lineage_rationale: "Same release lane without authored notes.",
}));

const packageIdentities = [
  evidence({
    item_id: "npm-agents-identity",
    source_id: "npm-agents",
    source_name: "npm package releases",
    source_kind: "npm_releases",
    title: "agents 0.20.1",
    url: "https://www.npmjs.com/package/agents/v/0.20.1",
    text: "Build AI-powered agents on Cloudflare.\n\nPackage: agents\n\nVersion: 0.20.1",
    family_key: "npm:agents",
  }),
  evidence({
    item_id: "pypi-mcp-identity",
    source_id: "pypi-mcp",
    source_name: "PyPI package releases",
    source_kind: "pypi_releases",
    title: "mcp 1.18.0",
    url: "https://pypi.org/project/mcp/1.18.0/",
    text: "Python implementation of Model Context Protocol.\n\nPackage: mcp\n\nVersion: 1.18.0",
    family_key: "pypi:mcp",
  }),
];

const exactDuplicatesAndUpdate = [
  evidence({
    item_id: "same-url-echo",
    source_id: "syndicated-release-feed",
    source_name: "Syndicated release feed",
    source_kind: "web_feed",
    title: "A republished release title",
    url: "https://vendor.example/releases/1.0",
    text: "The release adds deterministic approval receipts for every tool decision.",
    family_key: "domain:syndicate.example",
    lineage_relation: "echo",
    lineage_independent: 0,
  }),
  evidence({
    item_id: "release-origin",
    source_id: "vendor-releases",
    source_name: "Vendor releases",
    source_kind: "github_releases",
    title: "Release 1.0 adds approval receipts",
    url: "https://vendor.example/releases/1.0",
    text: "The release adds deterministic approval receipts for every tool decision.",
    family_key: "vendor:releases",
  }),
  evidence({
    item_id: "same-content-echo",
    source_id: "release-mirror",
    source_name: "Release mirror",
    source_kind: "web_feed",
    title: "Release 1.0 adds approval receipts",
    url: "https://mirror.example/releases/1.0",
    text: "The release adds deterministic approval receipts for every tool decision.",
    family_key: "domain:mirror.example",
    lineage_relation: "echo",
    lineage_independent: 0,
  }),
  evidence({
    item_id: "release-update",
    source_id: "vendor-release-updates",
    source_name: "Vendor release updates",
    source_kind: "github_releases",
    title: "Release 1.0 follow-up",
    url: "https://vendor.example/releases/1.0",
    text: "The follow-up documents a new rollback condition and changes the operational guidance.",
    family_key: "vendor:releases",
    lineage_relation: "update",
    lineage_independent: 0,
  }),
  evidence({
    story_id: "story-independent-analysis",
    item_id: "independent-analysis",
    source_id: "independent-analysis",
    source_name: "Independent analysis",
    title: "Approval receipts reduce missing provenance",
    url: "https://analysis.example/approval-receipts",
    text: "An independent evaluation found fewer missing provenance events when receipts were required.",
    family_key: "domain:analysis.example",
  }),
  evidence({
    story_id: "story-controlled-study",
    item_id: "controlled-study",
    source_id: "controlled-study",
    source_name: "Controlled study",
    source_kind: "arxiv",
    title: "A controlled approval-boundary study",
    url: "https://arxiv.org/abs/2608.09999",
    text: "The controlled study reports the conditions under which explicit approval boundaries help.",
    family_key: "arxiv:2608.09999",
  }),
];

const largeMissionEvidence = [
  ...Array.from({ length: 40 }, (_, index) => evidence({
    item_id: `primary-${String(index + 1).padStart(2, "0")}`,
    source_id: `primary-source-${String(index + 1).padStart(2, "0")}`,
    source_name: `Primary source ${index + 1}`,
    source_kind: "github_releases",
    title: `Primary finding ${index + 1}`,
    url: `https://primary-${index + 1}.example/findings/${index + 1}`,
    text: `Primary finding ${index + 1}. ${"Concrete release detail with a measurable operational consequence. ".repeat(22)}`,
    family_key: `primary-family-${String(index + 1).padStart(2, "0")}`,
  })),
  ...Array.from({ length: 8 }, (_, index) => evidence({
    item_id: `independent-${String(index + 1).padStart(2, "0")}`,
    source_id: `independent-source-${String(index + 1).padStart(2, "0")}`,
    source_name: `Independent source ${index + 1}`,
    source_kind: "web",
    title: `Independent finding ${index + 1}`,
    url: `https://independent-${index + 1}.example/analysis/${index + 1}`,
    text: `Independent finding ${index + 1}. ${"Separate reporting tests the release claim against observed behavior. ".repeat(22)}`,
    family_key: `independent-family-${String(index + 1).padStart(2, "0")}`,
  })),
];

let reasoning;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "./memory-graph") {
      return {
        memoryNeighborhood: async () => ({ nodes: [], edges: [], stats: {} }),
        memoryPatchContract: () => ({}),
      };
    }
    if (request === "./db") {
      return {
        getSetting: async () => "12000",
        getMission: async () => ({
          id: "mission-reasoning",
          name: "Coding-agent workflow improvements",
          question: "Which coding-agent workflow change should we test next?",
        }),
        getMissionOperator: async () => null,
        getMissionResearchState: async () => null,
        getStory: async () => null,
        listMissionMatches: async (db, _missionId, limit) => {
          db.requestedMissionMatchLimits?.push(limit);
          return (db.missionMatches ?? [{ story_id: "story-reasoning" }]).slice(0, limit);
        },
        listReasoningEvidenceSummary: async (db, storyIds, limit) => {
          db.requestedEvidenceLimits?.push(limit);
          const rows = db.evidenceRows ?? [...substantive, ...emptyCloudflare, ...packageIdentities];
          const scoped = db.respectStoryIds ? rows.filter((row) => storyIds.includes(row.story_id)) : rows;
          return scoped.slice(0, limit);
        },
        listReasoningDegradedSourceHealth: async () => [],
        listReasoningPlaybooks: async () => [],
        listIntelligencePacks: async () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  reasoning = require("../.test-dist/reasoning.js");
} finally {
  Module._load = originalLoad;
}

test("open and share bundles score only substantive public evidence while personal context stays lossless", async () => {
  const env = { DB: {}, PUBLIC_BASE_URL: "", DRIFTGLASS_SECRET: "fixture-secret" };
  const input = {
    task: "decision",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    objective: "Choose one workflow change to test now and one migration to defer.",
  };
  const [open, share, personal] = await Promise.all([
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "open" }),
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "share" }),
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "personal" }),
  ]);

  const expectedIds = substantive.map((row) => row.item_id).sort();
  for (const bundle of [open, share]) {
    assert.deepEqual(bundle.evidence.map((item) => item.itemId).sort(), expectedIds);
    assert.equal(bundle.coverage.evidenceCount, 4);
    assert.equal(bundle.coverage.sourceCount, 4);
    assert.equal(bundle.coverage.sourceFamilyCount, 4);
    assert.equal(bundle.coverage.independentFamilyCount, 4);
    assert.equal(bundle.coverage.primarySourceCount, 3);
    assert.equal(bundle.coverage.independentSourceCount, 1);
    assert.equal(bundle.coverage.echoCount, 0);
    assert.equal(bundle.coverage.echoShare, 0);
    assert.deepEqual(bundle.coverage.sourceFamilies, [
      "arxiv:2608.01234",
      "domain:modelcontextprotocol.io",
      "github:anthropics/claude-code",
      "github:openai/codex",
    ]);
    assert.equal(bundle.quality.score, 65, "quality is recomputed from four useful rows instead of the former inflated 75");
    assert.equal(bundle.quality.dimensions.evidenceDepth, 4 / 12);
    assert.equal(bundle.quality.dimensions.sourceDiversity, 4 / 5);
    assert.match(bundle.gaps.join("\n"), /6 public evidence rows were omitted before decision-quality scoring/i);
    assert.match(bundle.gaps.join("\n"), /4 had no substantive excerpt; 2 contained only package\/version identity/i);
    assert.match(bundle.gaps.join("\n"), /quality use only the 4 retained substantive rows/i);
    assert.doesNotMatch(JSON.stringify(bundle.evidence), /cloudflare-empty|npm-agents-identity|pypi-mcp-identity/);
  }

  assert.ok(personal.evidence.some((item) => item.itemId === "npm-agents-identity"));
  assert.ok(personal.evidence.some((item) => item.itemId === "pypi-mcp-identity"));
  assert.ok(personal.evidence.some((item) => String(item.itemId).startsWith("cloudflare-empty-")));
  assert.doesNotMatch(personal.gaps.join("\n"), /omitted before decision-quality scoring/i);
});

test("open and share bundles collapse exact public repeats without erasing personal evidence or real updates", async () => {
  const env = {
    DB: { evidenceRows: exactDuplicatesAndUpdate },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  };
  const input = {
    task: "decision",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    objective: "Choose the next reversible workflow test.",
  };
  const [open, share, personal] = await Promise.all([
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "open" }),
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "share" }),
    reasoning.buildReasoningBundle(env, { ...input, sourceScope: "personal" }),
  ]);

  for (const bundle of [open, share]) {
    assert.deepEqual(bundle.evidence.map((item) => item.itemId).sort(), [
      "controlled-study",
      "independent-analysis",
      "release-origin",
      "release-update",
    ]);
    assert.equal(bundle.coverage.evidenceCount, 4);
    assert.equal(bundle.coverage.sourceCount, 4);
    assert.equal(bundle.coverage.sourceFamilyCount, 3);
    assert.equal(bundle.coverage.independentFamilyCount, 3);
    assert.equal(bundle.coverage.echoCount, 0);
    assert.match(bundle.gaps.join("\n"), /2 public evidence rows were omitted before decision-quality scoring/i);
    assert.match(bundle.gaps.join("\n"), /2 exactly repeated a retained public URL or title and excerpt/i);
    assert.match(bundle.gaps.join("\n"), /quality use only the 4 retained substantive rows/i);
  }

  assert.deepEqual(personal.evidence.map((item) => item.itemId).sort(), exactDuplicatesAndUpdate.map((item) => item.item_id).sort());
  assert.equal(personal.evidence.find((item) => item.itemId === "same-url-echo")?.lineageRelation, "echo");
  assert.equal(personal.evidence.find((item) => item.itemId === "release-update")?.lineageRelation, "update");
  assert.doesNotMatch(personal.gaps.join("\n"), /exactly repeated a retained public URL/i);
});

test("large Mission compilation reports exact omissions and reserves independent reporting", async () => {
  const input = {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
    tokenBudget: 2_000,
    objective: "What do the release claims and independent observations establish?",
  };
  const env = { DB: { evidenceRows: largeMissionEvidence }, PUBLIC_BASE_URL: "", DRIFTGLASS_SECRET: "fixture-secret" };
  const reversedEnv = { DB: { evidenceRows: [...largeMissionEvidence].reverse() }, PUBLIC_BASE_URL: "", DRIFTGLASS_SECRET: "fixture-secret" };
  const [bundle, reversed] = await Promise.all([
    reasoning.buildReasoningBundle(env, input),
    reasoning.buildReasoningBundle(reversedEnv, input),
  ]);

  assert.ok(bundle.contextBudget.truncatedSections.includes("evidence"));
  assert.equal(bundle.evidence.length, 2);
  assert.ok(bundle.evidence.some((item) => item.sourceRole === "independent" && item.independentEvidence === true));
  assert.deepEqual(bundle.evidence.map((item) => item.itemId), reversed.evidence.map((item) => item.itemId));

  const counts = bundle.contextBudget.evidenceSelection;
  assert.deepEqual(counts, {
    storyWindowLimit: 20,
    evidenceWindowLimit: 80,
    contextWindowStoryCount: 1,
    contextWindowEvidenceCount: 48,
    contextWindowSourceCount: 48,
    preprocessingOmittedEvidenceCount: 0,
    preprocessingOmittedSourceCount: 0,
    eligibleCandidateEvidenceCount: 48,
    eligibleCandidateSourceCount: 48,
    selectedCandidateEvidenceCount: bundle.evidence.length,
    selectedCandidateSourceCount: bundle.coverage.sourceCount,
    fittingOmittedEvidenceCount: 48 - bundle.evidence.length,
    fittingOmittedSourceCount: 48 - bundle.coverage.sourceCount,
    clippedExcerptCount: 1,
    hasMoreStories: false,
    hasMoreEvidence: false,
  });
  const summary = bundle.executiveContext.find((line) => line.startsWith("This brief carries"));
  assert.match(summary, /This brief carries 2 of 48 source items from 2 of 48 sources; 46 items remain outside this brief\./);
  assert.match(summary, /1 selected excerpt was shortened\./);
  assert.doesNotMatch(summary, /\b0\b[^.]*left out/i);
  assert.match(reasoning.reasoningBundleMarkdown(bundle), new RegExp(summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a second fit pass uses a larger budget after one-Story fairness had its first chance", async () => {
  const bundle = await reasoning.buildReasoningBundle({
    DB: { evidenceRows: largeMissionEvidence },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
    tokenBudget: 50_000,
    objective: "What do the release claims and independent observations establish?",
  });

  assert.equal(new Set(largeMissionEvidence.map((row) => row.story_id)).size, 1);
  assert.equal(bundle.evidence.length, 45);
  assert.equal(bundle.coverage.sourceCount, 45);
  assert.equal(bundle.contextBudget.evidenceSelection.selectedCandidateEvidenceCount, 45);
  assert.equal(bundle.contextBudget.evidenceSelection.fittingOmittedEvidenceCount, 3);
  assert.equal(bundle.contextBudget.evidenceSelection.fittingOmittedSourceCount, 3);
});

test("the default 12k-token bundle reports exact one-Story multi-source coverage", async () => {
  const bundle = await reasoning.buildReasoningBundle({
    DB: { evidenceRows: largeMissionEvidence },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
    objective: "What do the release claims and independent observations establish?",
  });
  const counts = bundle.contextBudget.evidenceSelection;
  assert.equal(bundle.evidence.length, 11);
  assert.equal(bundle.coverage.sourceCount, 11);
  assert.equal(counts.eligibleCandidateEvidenceCount, 48);
  assert.equal(counts.eligibleCandidateSourceCount, 48);
  assert.equal(counts.selectedCandidateEvidenceCount, 11);
  assert.equal(counts.selectedCandidateSourceCount, 11);
  assert.equal(counts.fittingOmittedEvidenceCount, 37);
  assert.equal(counts.fittingOmittedSourceCount, 37);
  const summary = bundle.executiveContext.find((line) => line.startsWith("This brief carries"));
  assert.match(summary, /This brief carries 11 of 48 source items from 11 of 48 sources; 37 items remain outside this brief\./);
});

test("Mission compilation uses 21/81 sentinels while retaining a bounded 20/80 context window", async () => {
  const requestedMissionMatchLimits = [];
  const requestedEvidenceLimits = [];
  const missionMatches = Array.from({ length: 21 }, (_, index) => ({
    story_id: `story-window-${String(index + 1).padStart(2, "0")}`,
  }));
  const evidenceRows = Array.from({ length: 81 }, (_, index) => evidence({
    story_id: `story-window-${String((index % 20) + 1).padStart(2, "0")}`,
    item_id: `window-item-${String(index + 1).padStart(3, "0")}`,
    source_id: `window-source-${String(index + 1).padStart(3, "0")}`,
    source_name: `Window source ${index + 1}`,
    source_kind: "github_releases",
    title: `Window finding ${index + 1}`,
    url: `https://window-${index + 1}.example/finding`,
    text: `Window finding ${index + 1} records a concrete change.`,
    family_key: `window-family-${String(index + 1).padStart(3, "0")}`,
  }));
  const bundle = await reasoning.buildReasoningBundle({
    DB: {
      missionMatches,
      evidenceRows,
      respectStoryIds: true,
      requestedMissionMatchLimits,
      requestedEvidenceLimits,
    },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
    tokenBudget: 50_000,
  });

  assert.deepEqual(requestedMissionMatchLimits, [21]);
  assert.deepEqual(requestedEvidenceLimits, [81]);
  assert.equal(bundle.contextBudget.evidenceSelection.storyWindowLimit, 20);
  assert.equal(bundle.contextBudget.evidenceSelection.evidenceWindowLimit, 80);
  assert.equal(bundle.contextBudget.evidenceSelection.contextWindowStoryCount, 20);
  assert.equal(bundle.contextBudget.evidenceSelection.contextWindowEvidenceCount, 80);
  assert.equal(bundle.contextBudget.evidenceSelection.hasMoreStories, true);
  assert.equal(bundle.contextBudget.evidenceSelection.hasMoreEvidence, true);
  assert.equal(bundle.contextBudget.evidenceSelection.eligibleCandidateEvidenceCount, 80);
  assert.equal(bundle.contextBudget.evidenceSelection.selectedCandidateEvidenceCount, bundle.evidence.length);
  assert.equal(
    bundle.contextBudget.evidenceSelection.fittingOmittedEvidenceCount,
    80 - bundle.evidence.length,
  );
  assert.match(bundle.executiveContext.join("\n"), /More matching material remains in the Mission\./);
});

test("a per-Story evidence sentinel reports material beyond the indexed candidate window", async () => {
  const bundle = await reasoning.buildReasoningBundle({
    DB: {
      evidenceRows: [evidence({ story_window_has_more: 1 })],
    },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
  });

  assert.equal(bundle.contextBudget.evidenceSelection.contextWindowEvidenceCount, 1);
  assert.equal(bundle.contextBudget.evidenceSelection.hasMoreEvidence, true);
  assert.match(bundle.executiveContext.join("\n"), /More matching material remains in the Mission\./);
});

test("duplicate Story links choose the same evidence representative regardless of row order", async () => {
  const duplicateLinks = [
    evidence({ story_id: "story-z", item_id: "duplicate-link", title: "Linked finding" }),
    evidence({ story_id: "story-a", item_id: "duplicate-link", title: "Linked finding" }),
  ];
  const input = {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
  };
  const build = (rows) => reasoning.buildReasoningBundle({
    DB: { evidenceRows: rows },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, input);
  const [forward, reversed] = await Promise.all([build(duplicateLinks), build([...duplicateLinks].reverse())]);

  assert.deepEqual(forward.evidence, reversed.evidence);
  assert.equal(forward.evidence.length, 1);
  assert.equal(forward.evidence[0].storyId, "story-a");
  assert.equal(forward.contextBudget.evidenceSelection.preprocessingOmittedEvidenceCount, 1);
  assert.equal(forward.contextBudget.evidenceSelection.eligibleCandidateEvidenceCount, 1);
});

test("a shortened excerpt that fits is selected without inventing a zero-omission claim", async () => {
  const longRow = evidence({
    item_id: "clip-only",
    source_id: "clip-source",
    title: "T".repeat(900),
    text: "A concrete source detail with consequences. ".repeat(180),
  });
  const bundle = await reasoning.buildReasoningBundle({
    DB: { evidenceRows: [longRow] },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "open",
    tokenBudget: 2_000,
  });

  const counts = bundle.contextBudget.evidenceSelection;
  assert.equal(bundle.evidence.length, 1);
  assert.equal(counts.eligibleCandidateEvidenceCount, 1);
  assert.equal(counts.selectedCandidateEvidenceCount, 1);
  assert.equal(counts.fittingOmittedEvidenceCount, 0);
  assert.equal(counts.clippedExcerptCount, 1);
  assert.ok(JSON.stringify(bundle.evidence).length <= Math.floor(2_000 * 4 * 0.46));
  const summary = bundle.executiveContext.find((line) => line.startsWith("This brief carries"));
  assert.match(summary, /1 selected excerpt was shortened\./);
  assert.doesNotMatch(summary, /left out/i);
});

test("source and family caps remain after the second Story-fairness pass", async () => {
  const scenarios = [
    {
      rows: Array.from({ length: 5 }, (_, index) => evidence({
        story_id: `source-cap-story-${index}`,
        item_id: `source-cap-${index}`,
        source_id: "one-source",
        title: `Source cap ${index}`,
        url: `https://source-cap.example/${index}`,
        text: `Distinct source-cap evidence ${index}.`,
        family_key: `source-cap-family-${index}`,
      })),
      selected: 4,
      omittedSources: 0,
    },
    {
      rows: Array.from({ length: 4 }, (_, index) => evidence({
        story_id: `family-cap-story-${index}`,
        item_id: `family-cap-${index}`,
        source_id: `family-cap-source-${index}`,
        title: `Family cap ${index}`,
        url: `https://family-cap-${index}.example/finding`,
        text: `Distinct family-cap evidence ${index}.`,
        family_key: "one-family",
      })),
      selected: 3,
      omittedSources: 1,
    },
    {
      rows: Array.from({ length: 9 }, (_, index) => evidence({
        story_id: "one-story",
        item_id: `story-cap-${index}`,
        source_id: `story-cap-source-${index}`,
        title: `Story cap ${index}`,
        url: `https://story-cap-${index}.example/finding`,
        text: `Distinct Story-cap evidence ${index}.`,
        family_key: `story-cap-family-${index}`,
      })),
      selected: 9,
      omittedSources: 0,
      omittedEvidence: 0,
    },
  ];

  for (const scenario of scenarios) {
    const bundle = await reasoning.buildReasoningBundle({
      DB: { evidenceRows: scenario.rows },
      PUBLIC_BASE_URL: "",
      DRIFTGLASS_SECRET: "fixture-secret",
    }, {
      task: "investigate",
      scopeKind: "mission",
      scopeId: "mission-reasoning",
      sourceScope: "open",
      tokenBudget: 50_000,
    });
    const counts = bundle.contextBudget.evidenceSelection;
    assert.equal(bundle.evidence.length, scenario.selected);
    assert.equal(counts.selectedCandidateEvidenceCount, scenario.selected);
    assert.equal(counts.fittingOmittedEvidenceCount, scenario.omittedEvidence ?? 1);
    assert.equal(counts.fittingOmittedSourceCount, scenario.omittedSources);
  }
});

test("transient projection derives selection stats for saved v2/v3 bundles without them", async () => {
  const saved = await reasoning.buildReasoningBundle({
    DB: { evidenceRows: substantive },
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "fixture-secret",
  }, {
    task: "investigate",
    scopeKind: "mission",
    scopeId: "mission-reasoning",
    sourceScope: "personal",
  });
  for (const schemaVersion of ["2", "3"]) {
    const legacy = structuredClone(saved);
    legacy.schemaVersion = schemaVersion;
    delete legacy.contextBudget.evidenceSelection;
    const projected = reasoning.projectTransientPersonalReasoningBundle(legacy);
    assert.deepEqual(projected.contextBudget.evidenceSelection, {
      storyWindowLimit: projected.coverage.storyCount,
      evidenceWindowLimit: projected.evidence.length,
      contextWindowStoryCount: projected.coverage.storyCount,
      contextWindowEvidenceCount: projected.evidence.length,
      contextWindowSourceCount: projected.coverage.sourceCount,
      preprocessingOmittedEvidenceCount: 0,
      preprocessingOmittedSourceCount: 0,
      eligibleCandidateEvidenceCount: projected.evidence.length,
      eligibleCandidateSourceCount: projected.coverage.sourceCount,
      selectedCandidateEvidenceCount: projected.evidence.length,
      selectedCandidateSourceCount: projected.coverage.sourceCount,
      fittingOmittedEvidenceCount: 0,
      fittingOmittedSourceCount: 0,
      clippedExcerptCount: 0,
      hasMoreStories: false,
      hasMoreEvidence: false,
    });
  }
});
