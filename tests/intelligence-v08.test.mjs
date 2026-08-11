import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HTMLParser } from "./support/html-parser.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate];
}

test("Intelligence Packs remain cloud-first, budgeted, and model-interface portable through v3", async () => {
  const [catalogRaw, schemaRaw, packSource, reasoning, budget, packageRaw] = await Promise.all([
    read("public/intelligence-packs/catalog.json"),
    read("public/intelligence-packs/schema.json"),
    read("src/intelligence-packs.ts"),
    read("src/reasoning.ts"),
    read("src/budget.ts"),
    read("package.json"),
  ]);
  const catalog = JSON.parse(catalogRaw);
  const schema = JSON.parse(schemaRaw);
  const pkg = JSON.parse(packageRaw);
  assert.ok(["0.9.0"].includes(pkg.version));
  assert.equal(schema.properties.driftglassPack.const, "3");
  assert.ok(catalog.packs.length >= 3);
  for (const entry of catalog.packs) {
    assert.ok(entry.cloudSourceCount >= 1, `${entry.id} needs a cloud source`);
    assert.ok(entry.cloudCoverage > 0, `${entry.id} cannot be Companion-only`);
    assert.ok(["free", "cheap", "custom"].includes(entry.budgetProfile));
    assert.ok(entry.pack.reasoning?.outputContract?.length, `${entry.id} needs a reasoning output contract`);
  }
  assert.match(packSource, /previewIntelligencePack/);
  assert.match(packSource, /includeCompanionSources/);
  assert.match(packSource, /checkIntelligencePackUpdates/);
  assert.match(packSource, /Agent Skill/);
  assert.match(reasoning, /reasoningInterfaceKitZip/);
  assert.match(reasoning, /ChatGPT/);
  assert.match(reasoning, /Claude/);
  assert.match(reasoning, /Grok/);
  assert.match(budget, /browser_ms_day: 480_000/);
  assert.match(budget, /browser_ms_day: 900_000/);
  assert.match(budget, /workflow_steps_day: 2_400/);
});

test("v0.8 memory stays sparse, provenance-aware, auditable, and approval-gated", async () => {
  const [migration, graph, epistemic, api, mcp] = await Promise.all([
    read("migrations/0010_reasoning_memory.sql"),
    read("src/memory-graph.ts"),
    read("src/epistemic-memory.ts"),
    read("src/intelligence-api.ts"),
    read("src/mcp.ts"),
  ]);
  assert.match(migration, /maxNodes.*500/);
  assert.match(migration, /maxEdges.*2000/);
  assert.match(graph, /stageMemoryProposal/);
  assert.match(graph, /approveMemoryProposal/);
  assert.match(graph, /memoryGraphAudit/);
  assert.match(graph, /unresolvedContradictions/);
  assert.match(graph, /staleExpectations/);
  assert.match(epistemic, /BudgetDeferredError/);
  assert.match(api, /\/api\/memory\/audit/);
  assert.match(mcp, /audit_memory_integrity/);
  assert.match(mcp, /decide_memory_proposal/);
});

test("v0.8 UI has one coherent Memory, Packs, Reasoning, and Budget surface", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);
  const parser = new HTMLParser();
  parser.feed(html);
  assert.deepEqual(duplicates(parser.ids), []);
  for (const id of ["memory", "sources", "integrations", "system", "memory-audit-run", "memory-run-status", "check-pack-updates", "download-interface-kit"]) {
    assert.ok(parser.ids.includes(id), `missing UI id ${id}`);
  }
  assert.ok(!parser.ids.includes("download-reasoning-kit"));
  assert.match(app, /renderMemoryAudit/);
  assert.match(app, /Memory refresh started/);
  assert.match(app, /Refreshing memory/);
  assert.doesNotMatch(app, /memory\/refresh[\s\S]{0,180}force: true/);
  assert.match(app, /installed-pack-update/);
  assert.match(app, /installed-pack-skill/);
  assert.match(app, /installed-pack-export/);
});


test("Memory Graph refresh is a Free-tier-safe native Workflow, not a hidden single-request fallback", async () => {
  const [wranglerRaw, memory, index, migration] = await Promise.all([
    read("wrangler.jsonc"),
    read("src/epistemic-memory.ts"),
    read("src/index.ts"),
    read("migrations/0012_memory_graph_workflow.sql"),
  ]);
  const wrangler = JSON.parse(wranglerRaw);
  const binding = wrangler.workflows.find((workflow) => workflow.binding === "MEMORY_WORKFLOW");
  assert.equal(binding?.class_name, "MemoryGraphWorkflow");
  assert.match(index, /export \{ MemoryGraphWorkflow \}/);
  assert.match(memory, /class MemoryGraphWorkflow extends WorkflowEntrypoint/);
  assert.match(memory, /missions: 12, stories: 40, sources: 24, packs: 8, entities: 48/);
  assert.match(memory, /maxNodes: 350, maxEdges: 1_200/);
  assert.match(memory, /chunk\(plan\.stories, 3\)/);
  assert.match(memory, /link evidence \$\{story\.id\}/);
  assert.doesNotMatch(memory, /refreshEpistemicMemoryInline/);
  assert.match(migration, /workflow_id/);
});

test("Intelligence Pack v3 schema carries operators, epistemic seeds, routines, lineage, and install economics", async () => {
  const [schemaRaw, packSource, ui] = await Promise.all([
    read("public/intelligence-packs/schema.json"),
    read("src/intelligence-packs.ts"),
    read("public/app.js"),
  ]);
  const schema = JSON.parse(schemaRaw);
  const mission = schema.properties.missions.items.properties;
  const memory = schema.properties.memory.properties;
  assert.ok(mission.mode && mission.researchPolicy && mission.sprintPolicy && mission.alertThreshold);
  assert.ok(memory.claims && memory.expectations);
  assert.ok(schema.properties.evidencePolicy.properties.minPrimarySources);
  assert.ok(schema.properties.routines);
  assert.ok(schema.properties.lineage);
  assert.match(packSource, /packInstallQueryEstimate/);
  assert.match(packSource, /normalizeRoutines/);
  assert.match(packSource, /const installQueryEnvelope = d1QueryEnvelope\(current\.executionCapacity\)/);
  assert.doesNotMatch(packSource, /profile === "cheap"\s*\?\s*900\s*:\s*46/);
  assert.ok(packSource.indexOf('requireBudget(env.DB, "memory_writes"') < packSource.indexOf("const existing = await getIntelligencePack"));
  assert.match(ui, /fitsWithCompanion/);
  assert.match(ui, /estimatedInstallQueries/);
  assert.match(ui, /minPrimarySources/);
});

test("shipped Intelligence Packs are cloud-first analyst modules rather than source lists", async () => {
  const catalog = JSON.parse(await read("public/intelligence-packs/catalog.json"));
  for (const entry of catalog.packs) {
    const pack = entry.pack;
    assert.ok(pack.cloudSources.length >= 3, `${pack.id} needs a useful cloud core`);
    assert.ok(pack.evidencePolicy?.minPrimarySources >= 1, `${pack.id} needs an evidence policy`);
    assert.ok(pack.missions.every((mission) => mission.mode && mission.researchPolicy && mission.sprintPolicy), `${pack.id} needs Mission operators`);
    assert.ok(pack.memory?.claims?.length, `${pack.id} needs a provisional claim seed`);
    assert.ok(pack.memory?.expectations?.length, `${pack.id} needs a falsifiable expectation seed`);
    for (const source of [...pack.cloudSources, ...(pack.companionSources || [])]) {
      assert.ok(source.config.evidenceRole, `${pack.id}/${source.id} needs an evidence role`);
      assert.ok(Number.isFinite(source.config.estimatedItemsPerRun), `${pack.id}/${source.id} needs an expected yield`);
    }
  }
});

test("Context Compiler is source-aware, Pack-scoped, token-honest, and current across model subscriptions", async () => {
  const reasoning = await read("src/reasoning.ts");
  assert.match(reasoning, /relevantPackManifests/);
  assert.match(reasoning, /sourceRole/);
  assert.match(reasoning, /primarySourceCount/);
  assert.match(reasoning, /independentSourceCount/);
  assert.match(reasoning, /discoveryShare/);
  assert.match(reasoning, /contextBudget: \{ estimatedTokens, sectionChars, truncatedSections, evidenceSelection: evidenceResult\.selection \}/);
  assert.match(reasoning, /Settings → Connectors/);
  assert.match(reasoning, /grok\/connector-url\.txt/);
  assert.doesNotMatch(reasoning, /grok\/\.mcp\.json/);
  assert.match(reasoning, /deepResearchRecommended = true/);
});

test("Agent Memory remains an optional checkpoint accelerator and never becomes a core binding", async () => {
  const [wranglerRaw, labWrangler, docs] = await Promise.all([
    read("wrangler.jsonc"),
    read("labs/agent-memory-bridge/wrangler.jsonc"),
    read("docs/AGENT-MEMORY-BRIDGE.md"),
  ]);
  const wrangler = JSON.parse(wranglerRaw);
  assert.equal(wrangler.agent_memory, undefined);
  assert.match(labWrangler, /AGENT_MEMORY|agent_memory/i);
  assert.match(docs, /approved epistemic-memory checkpoints/i);
  assert.match(docs, /canonical graph state in D1/i);
});

test("budget profiles reserve operational headroom instead of advertising Cloudflare maxima", async () => {
  const budget = await read("src/budget.ts");
  assert.match(budget, /browser_ms_day: 480_000/);
  assert.match(budget, /browser_ms_day: 900_000/);
  assert.match(budget, /workflow_steps_day: 2_400/);
  assert.match(budget, /queue_messages_day: 2_500/);
  assert.match(budget, /queue_messages_day: 9_000/);
  assert.match(budget, /three Queue operations/);
});
