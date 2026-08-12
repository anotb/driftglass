import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { limitsForProfile } = require("../.test-dist/budget.js");
const {
  parseIntelligencePack,
  packSources,
  comparePackVersions,
} = require("../.test-dist/intelligence-packs.js");
const { normalizeMemoryPatch, memoryPatchContract } = require("../.test-dist/memory-graph.js");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Free and Cheap budget profiles preserve explicit headroom", () => {
  const free = limitsForProfile("free");
  const cheap = limitsForProfile("cheap");
  assert.equal(free.browser_ms_day, 480_000);
  assert.equal(cheap.browser_ms_day, 900_000);
  assert.equal(free.workflow_steps_day, 2_400);
  assert.equal(free.source_runs_day, 240);
  assert.ok(free.computer_sync_bytes_day <= 20 * 1024 * 1024);
  for (const key of Object.keys(free)) assert.ok(cheap[key] > free[key], `${key} should grow on Cheap`);
  const custom = limitsForProfile("custom", { source_runs_day: 17, browser_ms_day: 0 });
  assert.equal(custom.source_runs_day, 17);
  assert.equal(custom.browser_ms_day, 0);
  assert.equal(custom.workflow_steps_day, free.workflow_steps_day);
});

test("Lens v1 upgrades to a cloud-first Intelligence Pack with optional Companion lanes", () => {
  const pack = parseIntelligencePack({
    driftglassLens: "1",
    id: "portable-watch",
    name: "Portable Watch",
    description: "Cloud evidence with optional signed-in enrichment.",
    requiresCompanion: true,
    sources: [
      { id: "hn", name: "Hacker News", kind: "hackernews", config: { feed: "best" }, scheduleMinutes: 90, weight: 1 },
      { id: "x-bookmarks", name: "X bookmarks", kind: "collector", config: { operation: "x.bookmarks" }, scheduleMinutes: 180, weight: 1.2 },
    ],
    interestTerms: ["agents"],
  });
  assert.equal(pack.driftglassPack, "3");
  assert.equal(pack.cloudSources?.length, 1);
  assert.equal(pack.companionSources?.length, 1);
  assert.equal(pack.budget?.profile, "free");
  assert.equal(pack.evidencePolicy?.minPrimarySources, 1);
  assert.deepEqual(packSources(pack).map((source) => source.id).sort(), ["hn", "x-bookmarks"]);
});

test("Legacy Pack v2 upgrades to v3 while evidence policy and versions remain stable", () => {
  const pack = parseIntelligencePack({
    driftglassPack: "2",
    id: "research-radar",
    version: "1.10.0",
    name: "Research Radar",
    description: "A bounded research Pack.",
    cloudSources: [
      { id: "papers", name: "Papers", kind: "openalex", config: { query: "agent memory" }, scheduleMinutes: 360, weight: 1 },
    ],
    evidencePolicy: {
      minPrimarySources: 2,
      minIndependentSources: 3,
      maxDiscoveryShare: 0.2,
      maxEvidenceAgeHours: 96,
      preferredDomains: ["openai.com", "openai.com", "anthropic.com"],
    },
    budget: { profile: "free" },
  });
  assert.equal(pack.driftglassPack, "3");
  assert.equal(pack.evidencePolicy?.minPrimarySources, 2);
  assert.equal(pack.evidencePolicy?.minIndependentSources, 3);
  assert.equal(pack.evidencePolicy?.maxDiscoveryShare, 0.2);
  assert.deepEqual(pack.evidencePolicy?.preferredDomains, ["openai.com", "anthropic.com"]);
  assert.equal(comparePackVersions("1.2.0", "1.10.0"), -1);
  assert.equal(comparePackVersions("2.0.0", "1.99.99"), 1);
  assert.equal(comparePackVersions("1.0.0", "1.0.0"), 0);
});

test("Memory patches are typed, bounded, unique, and approval-ready", () => {
  const patch = normalizeMemoryPatch({
    schemaVersion: "1",
    title: "Durable conclusion",
    nodes: [{ key: "computer-fit", type: "decision", label: "Use Computer for Mission workspaces", summary: "Mission-scoped files benefit from a durable Computer." }],
    edges: [{ from: "computer-fit", to: "mission:cloudflare", relation: "relevant_to", confidence: 0.9 }],
  });
  assert.equal(patch.nodes.length, 1);
  assert.equal(patch.nodes[0].type, "decision");
  assert.equal(patch.edges[0].relation, "relevant_to");
  assert.throws(() => normalizeMemoryPatch({ nodes: [
    { key: "duplicate", type: "finding", label: "One", summary: "One" },
    { key: "duplicate", type: "finding", label: "Two", summary: "Two" },
  ] }), /unique/);
  const contract = memoryPatchContract();
  assert.equal(contract.type, "object");
  assert.ok(contract.properties.nodes);
  assert.ok(contract.properties.edges);
});

test("Default MCP is compact and read-only while operations stay explicit", async () => {
  const [compact, router, reasoning] = await Promise.all([
    read("src/reasoning-mcp.ts"),
    read("src/mcp.ts"),
    read("src/reasoning.ts"),
  ]);
  const registrations = [...compact.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(registrations, [
    "brief_today", "brief_mission", "present_brief", "open_today", "next_reasoning_task", "prepare_context", "prepare_personal_context", "search", "find_missions", "fetch", "get_mission",
    "recall_memory", "compare_memory", "explain_story", "get_action_center", "get_system_health", "list_intelligence_packs",
  ]);
  assert.doesNotMatch(compact, /record_feedback|stage_memory|install_intelligence_pack|run_mission_sprint/);
  assert.match(router, /authorizeMcpPath/);
  assert.match(reasoning, /Context quality gate/);
  assert.match(reasoning, /operationsMcpUrl/);
  assert.match(reasoning, /Deep Research recommended/);
});

test("machine discovery and dashboard preserve compact reasoning, explicit operations, and cloud-first Pack installs", async () => {
  const [mcpRaw, agentRaw, driftglassRaw, openapiRaw, app, html] = await Promise.all([
    read("public/.well-known/mcp.json"),
    read("public/.well-known/agent.json"),
    read("public/.well-known/driftglass.json"),
    read("public/openapi.json"),
    read("public/app.js"),
    read("public/index.html"),
  ]);
  const mcp = JSON.parse(mcpRaw);
  const agent = JSON.parse(agentRaw);
  const driftglass = JSON.parse(driftglassRaw);
  const openapi = JSON.parse(openapiRaw);
  assert.equal(mcp.default_profile, "reasoning");
  assert.equal(mcp.read_only, true);
  assert.equal(mcp.tools.length, 17);
  assert.equal(mcp.profiles.reasoning.read_only, true);
  assert.equal(mcp.profiles.operations.read_only, false);
  assert.equal(mcp.capability_scoping, "independent-per-profile");
  assert.equal(mcp.profiles.reasoning.capability_scope, "read");
  assert.equal(mcp.profiles.operations.capability_scope, "operations");
  assert.equal(mcp.operations_endpoint_template, "/mcp/{private-operations-key}/ops");
  assert.equal(agent.interfaces.mcp_reasoning, "/mcp");
  assert.equal(agent.interfaces.mcp_reasoning_legacy, "/mcp/{private-read-key}");
  assert.equal(agent.interfaces.mcp_operations, "/mcp/{private-operations-key}/ops");
  assert.equal(driftglass.mcp.defaultProfile, "reasoning");
  assert.ok(openapi.paths["/mcp/{operationsKey}/ops"]);
  assert.equal(openapi.paths["/mcp/{operationsKey}/ops"].post.parameters[0].name, "operationsKey");
  assert.match(html, /operations-mcp-url/);
  assert.match(html, /reasoning-quality/);
  assert.match(app, /fitsWithCompanion/);
  assert.match(app, /brief details/i);
  assert.doesNotMatch(app, /evidence check/i);
  assert.match(app, /includeCompanionSources: false/);
});
