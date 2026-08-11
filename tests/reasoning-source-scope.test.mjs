import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const privateMarker = "SIGNED_IN_MEMORY_MARKER";
const hostileCapabilityMarker = "HOSTILE_CAPABILITY_TOKEN";
const hostileCapabilityOrigin = "https://owner.example";
const privateAccessCalls = {
  operator: 0,
  research: 0,
  memory: 0,
  sourceHealth: 0,
  playbooks: 0,
  packs: 0,
};

const publicEvidence = {
  story_id: "story-public",
  item_id: "item-public",
  source_id: "source-public",
  source_name: "Open source",
  source_kind: "web",
  source_config_json: JSON.stringify({ evidenceRole: "discovery", primarySource: true, marker: privateMarker }),
  source_health_score: 0.17,
  source_weight: 9,
  title: "Public finding",
  url: "https://example.com/public",
  author: null,
  published_at: "2026-08-08T12:00:00.000Z",
  observed_at: "2026-08-08T12:00:00.000Z",
  access_class: "public",
  metadata_json: JSON.stringify({ provider: privateMarker }),
  text: "Public evidence text",
  family_key: "domain:example.com",
  origin_item_id: null,
  origin_family_key: null,
  lineage_relation: "origin",
  title_similarity: null,
  body_similarity: null,
  lineage_independent: 1,
  lineage_rationale: null,
};

const personalEvidence = {
  ...publicEvidence,
  item_id: "item-personal",
  source_id: "source-personal",
  source_name: "Reddit Home",
  source_kind: "collector",
  title: "Signed-in finding",
  url: "https://www.reddit.com/r/example/comments/personal",
  access_class: "authenticated-local",
  metadata_json: JSON.stringify({ provider: " OpenCLI ", operation: " Reddit.Home " }),
  text: privateMarker,
  family_key: "reddit:home",
};

const xPersonalEvidence = {
  ...publicEvidence,
  item_id: "item-x-personal",
  source_id: "source-x-personal",
  source_name: "X Following",
  source_kind: "collector",
  title: "Signed-in X finding",
  url: "https://x.com/example/status/personal",
  access_class: "authenticated-local",
  metadata_json: JSON.stringify({ provider: "OPENCLI", operation: "X.TIMELINE" }),
  text: `${privateMarker}_X`,
  family_key: "x:following",
};

const hostilePersonalEvidence = {
  ...publicEvidence,
  item_id: "item-hostile-personal",
  source_id: "source-hostile-personal",
  source_name: "Connected source",
  source_kind: "collector",
  title: "Hostile metadata finding",
  url: "https://example.com/hostile-metadata",
  access_class: "authenticated-local",
  metadata_json: JSON.stringify({
    provider: `${hostileCapabilityOrigin}/mcp/${hostileCapabilityMarker}\n`,
    operation: `/packet/${hostileCapabilityMarker}/latest.md\u0000`,
  }),
  text: "Evidence text with safe rendered metadata labels.",
  family_key: "collector:hostile-metadata",
};

let reasoning;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "./briefing") {
      return {
        curatedStoriesForToday: async (env, limit) => {
          env.DB.requestedCuratedLimits?.push(limit);
          return env.DB.curatedStories ?? [{ id: "story-public" }];
        },
      };
    }
    if (request === "./memory-graph") {
      return {
        memoryNeighborhood: async () => {
          privateAccessCalls.memory += 1;
          return {
            nodes: [{
              id: "memory-private",
              node_type: "finding",
              label: privateMarker,
              summary: privateMarker,
              aliases_json: "[]",
              metadata_json: "{}",
              importance: 1,
              confidence: 1,
              occurred_at: null,
              first_seen_at: "2026-08-08T12:00:00.000Z",
              last_seen_at: "2026-08-08T12:00:00.000Z",
              updated_at: "2026-08-08T12:00:00.000Z",
              status: "active",
              superseded_by: null,
              source_ref: "story:private",
              valid_from: null,
              valid_to: null,
            }],
            edges: [],
            stats: {},
          };
        },
        memoryPatchContract: () => ({ marker: privateMarker }),
      };
    }
    if (request === "./db") {
      return {
        getSetting: async () => "12000",
        getMission: async () => ({
          id: "mission-one",
          name: "Visible Mission",
          question: "What changed in public?",
        }),
        getMissionOperator: async () => {
          privateAccessCalls.operator += 1;
          return { expected_next_event: privateMarker };
        },
        getMissionResearchState: async () => {
          privateAccessCalls.research += 1;
          return { current_thesis: privateMarker, open_questions_json: JSON.stringify([privateMarker]) };
        },
        listMissionMatches: async () => [{ story_id: "story-public" }],
        listReasoningEvidenceSummary: async (database, storyIds, limit) => {
          database.requestedEvidenceStoryIds?.push([...storyIds]);
          const evidenceRows = database.evidenceRows
            ?? [publicEvidence, personalEvidence, xPersonalEvidence, hostilePersonalEvidence];
          return evidenceRows.filter((row) => storyIds.includes(row.story_id)).slice(0, limit);
        },
        listReasoningDegradedSourceHealth: async () => {
          privateAccessCalls.sourceHealth += 1;
          return [
            { id: "source-public", name: "Open source", health_score: 1, last_error: null },
            { id: "source-personal", name: privateMarker, health_score: 0, last_error: privateMarker },
          ];
        },
        listReasoningPlaybooks: async () => {
          privateAccessCalls.playbooks += 1;
          return [{ id: "private-playbook", name: privateMarker, instructions: privateMarker, pack_id: null }];
        },
        listIntelligencePacks: async () => {
          privateAccessCalls.packs += 1;
          return [{
            id: "private-pack",
            name: privateMarker,
            version: "1",
            enabled: 1,
            manifest_json: JSON.stringify({ featured: true, sources: [{ id: "source-public" }] }),
          }];
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  reasoning = require("../.test-dist/reasoning.js");
} finally {
  Module._load = originalLoad;
}

test("reasoning source scopes keep personal evidence explicit and public Shares fail closed", () => {
  const openWeb = { access_class: "public", source_kind: "web" };
  const signedIn = { access_class: "authenticated-local", source_kind: "collector" };
  const malformedCollector = { access_class: "public", source_kind: "collector" };
  const malformedEmail = { access_class: "public", source_kind: "email" };

  assert.equal(reasoning.reasoningEvidenceAllowed(openWeb, "open"), true);
  assert.equal(reasoning.reasoningEvidenceAllowed(signedIn, "open"), false);
  assert.equal(reasoning.reasoningEvidenceAllowed(openWeb, "personal"), true);
  assert.equal(reasoning.reasoningEvidenceAllowed(signedIn, "personal"), true);
  assert.equal(reasoning.reasoningEvidenceAllowed(openWeb, "share"), true);
  assert.equal(reasoning.reasoningEvidenceAllowed(signedIn, "share"), false);
  assert.equal(reasoning.reasoningEvidenceAllowed(malformedCollector, "share"), false);
  assert.equal(reasoning.reasoningEvidenceAllowed(malformedEmail, "share"), false);
});

test("global reasoning reports Stories beyond its twenty-Story evidence window", async () => {
  const requestedCuratedLimits = [];
  const requestedEvidenceStoryIds = [];
  const curatedStories = Array.from({ length: 24 }, (_, index) => ({ id: `global-story-${index + 1}` }));
  const evidenceRows = curatedStories.map((story, index) => ({
    ...publicEvidence,
    story_id: story.id,
    item_id: `global-item-${index + 1}`,
    source_id: `global-source-${index + 1}`,
    source_name: `Global source ${index + 1}`,
    url: `https://global-${index + 1}.example/evidence`,
    family_key: `global-family-${index + 1}`,
  }));
  const database = { curatedStories, evidenceRows, requestedCuratedLimits, requestedEvidenceStoryIds };

  const bundle = await reasoning.buildReasoningBundle({
    DB: database,
    PUBLIC_BASE_URL: "",
    DRIFTGLASS_SECRET: "test-secret",
  }, {
    sourceScope: "open",
    scopeKind: "global",
    tokenBudget: 50_000,
  });

  assert.deepEqual(requestedCuratedLimits, [24]);
  assert.equal(requestedEvidenceStoryIds.length, 1);
  assert.deepEqual(requestedEvidenceStoryIds[0], curatedStories.slice(0, 20).map((story) => story.id));
  assert.equal(bundle.contextBudget.evidenceSelection.storyWindowLimit, 20);
  assert.equal(bundle.contextBudget.evidenceSelection.contextWindowStoryCount, 20);
  assert.equal(bundle.contextBudget.evidenceSelection.hasMoreStories, true);
});

test("Reddit Home and X Following remain explicit personal context while open and share stay public", async () => {
  const env = { DB: {}, PUBLIC_BASE_URL: "https://owner.example", DRIFTGLASS_SECRET: "test-secret" };
  const [open, savedPersonal, personal, share, memoryUpdate] = await Promise.all([
    reasoning.buildReasoningBundle(env, { sourceScope: "open", scopeKind: "mission", scopeId: "mission-one" }),
    reasoning.buildReasoningBundle(env, { sourceScope: "personal", scopeKind: "mission", scopeId: "mission-one" }, { includeReadCapability: false }),
    reasoning.buildTransientPersonalReasoningBundle(env, { scopeKind: "mission", scopeId: "mission-one" }),
    reasoning.buildReasoningBundle(env, { sourceScope: "share", scopeKind: "mission", scopeId: "mission-one" }),
    reasoning.buildTransientPersonalReasoningBundle(env, { task: "memory-update", scopeKind: "mission", scopeId: "mission-one" }),
  ]);

  for (const bundle of [open, share]) {
    assert.equal(bundle.evidence.length, 1);
    assert.deepEqual(bundle.memory.nodes, []);
    assert.deepEqual(bundle.memory.edges, []);
    assert.deepEqual(bundle.playbooks, []);
    assert.deepEqual(bundle.relevantPacks, []);
    assert.deepEqual(bundle.memoryPatchContract, {});
    assert.equal(bundle.mcpUrl, undefined);
    assert.equal(bundle.mission.name, "Visible Mission");
    assert.equal(bundle.mission.question, "What changed in public?");
    assert.equal(bundle.mission.currentThesis, undefined);
    assert.equal(bundle.mission.expectedNextEvent, undefined);
    assert.equal(bundle.evidence[0]?.sourceRole, "independent");
    for (const field of ["sourceHealth", "sourceWeight", "qualityScore", "provider", "operation"]) {
      assert.equal(Object.hasOwn(bundle.evidence[0] ?? {}, field), false);
    }
    assert.doesNotMatch(JSON.stringify(bundle), new RegExp(privateMarker));
  }

  assert.equal(personal.evidence.length, 4);
  assert.equal(personal.mission.id, "mission-one");
  for (const field of ["mcpUrl", "operationsMcpUrl", "packetUrl"]) {
    assert.equal(Object.hasOwn(personal, field), false);
    assert.equal(Object.hasOwn(memoryUpdate, field), false);
  }
  assert.equal(personal.memory.nodes[0]?.label, privateMarker);
  assert.equal(personal.mission.currentThesis, privateMarker);
  assert.equal(personal.mission.expectedNextEvent, privateMarker);
  const personalPublicEvidence = personal.evidence.find((item) => item.itemId === "item-public");
  assert.equal(personalPublicEvidence?.sourceRole, "discovery");
  assert.equal(personalPublicEvidence?.sourceHealth, 0.17);
  assert.equal(personalPublicEvidence?.sourceWeight, 9);
  assert.equal(personalPublicEvidence?.provider, "redacted");
  assert.equal(Object.hasOwn(personalPublicEvidence ?? {}, "operation"), false);
  assert.equal(typeof personalPublicEvidence?.qualityScore, "number");
  const redditEvidence = personal.evidence.find((item) => item.itemId === "item-personal");
  const xEvidence = personal.evidence.find((item) => item.itemId === "item-x-personal");
  assert.equal(redditEvidence?.provider, "opencli");
  assert.equal(redditEvidence?.operation, "reddit.home");
  assert.equal(xEvidence?.provider, "opencli");
  assert.equal(xEvidence?.operation, "x.timeline");
  const hostileEvidence = personal.evidence.find((item) => item.itemId === "item-hostile-personal");
  assert.equal(hostileEvidence?.provider, "redacted");
  assert.equal(hostileEvidence?.operation, "redacted");

  const personalMarkdown = reasoning.reasoningBundleMarkdown(personal);
  assert.match(personalMarkdown, /accessClass: authenticated-local · sourceKind: collector · provider: opencli · operation: reddit\.home/);
  assert.match(personalMarkdown, /accessClass: authenticated-local · sourceKind: collector · provider: opencli · operation: x\.timeline/);
  assert.match(personalMarkdown, /accessClass: authenticated-local · sourceKind: collector · provider: redacted · operation: redacted/);
  assert.match(personalMarkdown, /lineage: relation=origin · family=reddit:home · independent=yes/);
  assert.match(personalMarkdown, /lineage: relation=origin · family=x:following · independent=yes/);
  assert.doesNotMatch(personalMarkdown, /Optional durable memory update/);
  assert.doesNotMatch(personalMarkdown, /https:\/\/owner\.example\/(?:mcp|packet)\//);
  assert.doesNotMatch(personalMarkdown, new RegExp(hostileCapabilityMarker));
  assert.deepEqual(personal.memoryPatchContract, {});

  assert.notDeepEqual(memoryUpdate.memoryPatchContract, {});
  assert.match(reasoning.reasoningBundleMarkdown(memoryUpdate), /Optional durable memory update/);

  for (const bundle of [open, savedPersonal, share]) {
    assert.equal(bundle.resultContract.properties.schemaVersion.const, "1");
    assert.equal(bundle.resultContract.properties.answerMode.const, "synthesis");
  }
  const savedPersonalInstructions = [...savedPersonal.instructions, ...savedPersonal.outputContract].join("\n");
  assert.match(savedPersonalInstructions, /Use only this returned bundle/);
  assert.match(savedPersonalInstructions, /do not browse the web/i);
  assert.match(savedPersonalInstructions, /access class visible/);
  assert.match(savedPersonalInstructions, /lineage limits/);
  assert.doesNotMatch(savedPersonalInstructions, /90–160 words/);
  assert.doesNotMatch(savedPersonalInstructions, /no headings, checklists, report-style recap/);

  const personalContract = [...personal.instructions, ...personal.outputContract].join("\n");
  assert.deepEqual(personal.resultContract, {});
  assert.equal(personal.contextBudget.sectionChars.resultContract, JSON.stringify({}).length);
  assert.equal(
    personal.contextBudget.estimatedTokens,
    Math.ceil((Object.values(personal.contextBudget.sectionChars).reduce((total, value) => total + value, 0) + personal.objective.length + 1_200) / 4),
  );
  assert.match(personalContract, /Use only this returned bundle/);
  assert.match(personalContract, /do not browse the web/i);
  assert.match(personalContract, /90–160 words/);
  assert.match(personalContract, /no headings, checklists, report-style recap/);
  assert.match(personalContract, /Identify claims that come from connected sources/);
  assert.match(personalContract, /access class visible/);
  assert.match(personalContract, /lineage limits/);
  assert.match(personalContract, /Do not propose or append a durable-memory patch unless the user explicitly requested a memory update/);
  assert.doesNotMatch(personalContract, /broader research|broader current research|general knowledge unless|browse[^.]*unless|Deep Research/i);
  assert.doesNotMatch(personalMarkdown, /broader research/i);

  const inheritedBudgetGap = `${savedPersonal.contextBudget.estimatedTokens} tokens, above the requested token envelope.`;
  const projectedEstimate = personal.contextBudget.estimatedTokens;
  const reprojected = reasoning.projectTransientPersonalReasoningBundle({
    ...savedPersonal,
    tokenBudget: projectedEstimate,
    contextBudget: {
      ...savedPersonal.contextBudget,
      truncatedSections: [...savedPersonal.contextBudget.truncatedSections.filter((section) => section !== "overall"), "overall"],
    },
    gaps: [...savedPersonal.gaps, inheritedBudgetGap],
    quality: {
      ...savedPersonal.quality,
      blockers: [...savedPersonal.quality.blockers, "The portable context exceeded its requested token envelope after fixed instructions and output contracts were included."],
    },
  });
  assert.equal(reprojected.contextBudget.estimatedTokens, projectedEstimate);
  assert.equal(reprojected.contextBudget.truncatedSections.includes("overall"), false);
  assert.equal(reprojected.gaps.some((gap) => /token envelope/i.test(gap)), false);
  assert.equal(reprojected.quality.blockers.some((blocker) => /token envelope/i.test(blocker)), false);

  const savedMarkdown = reasoning.reasoningBundleMarkdown(savedPersonal);
  assert.match(savedMarkdown, /Return one JSON object matching this schema when saving this answer:/);
  assert.doesNotMatch(savedMarkdown, /when the client supports structured output/i);

  const transientSerialized = JSON.stringify({ personal, memoryUpdate });
  assert.doesNotMatch(transientSerialized, /https:\/\/owner\.example\/(?:mcp|packet)\//);
  assert.doesNotMatch(transientSerialized, /\/mcp\/|\/packet\//);
  assert.doesNotMatch(transientSerialized, new RegExp(hostileCapabilityMarker));

  for (const bundle of [open, share]) {
    const serialized = JSON.stringify(bundle);
    const markdown = reasoning.reasoningBundleMarkdown(bundle);
    assert.doesNotMatch(serialized, /Reddit Home|X Following|reddit:home|x:following|item-personal|item-x-personal|item-hostile-personal/);
    assert.doesNotMatch(markdown, /accessClass: authenticated-local|provider: opencli|operation: reddit\.home|operation: x\.timeline/);
  }
  assert.match(JSON.stringify(personal), new RegExp(privateMarker));
  assert.deepEqual(privateAccessCalls, {
    operator: 3,
    research: 3,
    memory: 3,
    sourceHealth: 3,
    playbooks: 3,
    packs: 3,
  });
});
