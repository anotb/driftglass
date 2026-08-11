#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertInternalWorkspaceUntracked } from "./check-release-candidate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await assertInternalWorkspaceUntracked(root);
const migrationNames = [
  "initial", "agent_week", "intelligence_missions", "public_intelligence", "personalization", "mission_sprints",
  "mission_operators", "feature_complete", "memory_graph_and_packs", "reasoning_memory", "context_compiler_and_playbooks",
  "memory_graph_workflow", "runtime_fabric", "judgment_loop", "reasoning_ledger", "evidence_lineage",
  "pack_overlays_and_adaptive_cadence", "email_receipt_idempotency", "queue_ingest_durability",
  "ingest_completion_state", "ingest_deadletter_retry_claims", "source_ingest_producer_outbox",
];
const required = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "ACKNOWLEDGEMENTS.md", "CHANGELOG.md", "package-lock.json",
  ".github/workflows/ci.yml", ".github/workflows/upstream-watch.yml", ".github/dependabot.yml",
  "docs/VALIDATION.md", "docs/ROADMAP.md",
  "docs/COMPUTER.md", "docs/PRODUCT-BOUNDARY.md", "docs/CLOUDFLARE-DROP.md", "docs/MEMORY-GRAPH.md",
  "docs/INTELLIGENCE-PACKS.md", "docs/REASONING-INTERFACES.md", "docs/BUDGET-GOVERNOR.md", "docs/AI-SEARCH.md",
  "docs/AGENT-MEMORY-BRIDGE.md", "docs/JUDGMENT-LOOP.md", "docs/EVIDENCE-LINEAGE.md",
  "docs/INTELLIGENCE-ROUTINES.md", "docs/PACK-OVERLAYS.md", "docs/LIVING-DOSSIERS.md", "docs/FORKABLE-INTELLIGENCE.md",
  "docs/RUNTIME-FABRIC.md", "docs/MEMORY-CHECKPOINTS.md", "docs/REASONING-LEDGER.md", "docs/JUDGMENT-SURFACE.md",
  "docs/RELEASE-0.9.0.md",
  "wrangler.jsonc",
  ...migrationNames.map((name, index) => `migrations/${String(index + 1).padStart(4, "0")}_${name}.sql`),
  "src/schema.ts", "src/generated-migrations.ts", "src/worker-configuration.d.ts", "src/mission-computer.ts", "src/mission-workflow.ts", "src/story-graph.ts",
  "src/epistemic-memory.ts", "src/memory-graph.ts", "src/intelligence-packs.ts", "src/intelligence-api.ts", "src/intelligence.ts",
  "src/reasoning.ts", "src/reasoning-mcp.ts", "src/reasoning-ledger.ts", "src/reasoning-tasks.ts", "src/judgment.ts",
  "src/decision-ledger.ts", "src/evidence-lineage.ts", "src/source-scorecards.ts", "src/adaptive-cadence.ts",
  "src/intelligence-routines.ts", "src/routine-workflow.ts", "src/pack-overlays.ts", "src/v09-api.ts",
  "src/budget.ts", "src/ai-search.ts", "src/mcp.ts", "src/readiness.ts", "src/profile.ts",
  "intelligence-packs/schema.json", "intelligence-packs/examples/cloudflare-agent-week.json",
  "intelligence-packs/examples/coding-agents.json", "intelligence-packs/examples/ai-infrastructure-power.json",
  "public/intelligence-packs/schema.json", "public/intelligence-packs/catalog.json",
  "driftglass-relay/driftglass-relay.mjs", "driftglass-relay/install.sh", "driftglass-relay/install.ps1", "public/relay/manifest.json",
  "public/webmcp.js", "public/openapi.json", "public/install.md", "public/llms.txt", "public/llms-full.txt",
  "public/.well-known/agent.json", "public/.well-known/driftglass.json", "public/.well-known/mcp.json",
  "labs/deep-dive-lab/src/index.ts", "labs/deep-dive-lab/wrangler.jsonc", "labs/deep-dive-lab/README.md",
  "labs/agent-memory-bridge/src/index.ts", "labs/agent-memory-bridge/wrangler.jsonc", "labs/agent-memory-bridge/README.md",
  "tests/intelligence-v08.test.mjs", "tests/v08-behavior.test.mjs", "tests/v09-behavior.test.mjs", "tests/v09-judgment.test.mjs",
  "tests/schema.test.mjs", "tests/schema-readiness.test.mjs", "tests/collectors.test.mjs", "tests/repo.test.mjs",
];
for (const file of required) await readFile(path.join(root, file));

const text = async (file) => readFile(path.join(root, file), "utf8");
const jsonFile = async (file) => JSON.parse(await text(file));
const pkg = await jsonFile("package.json");
if (pkg.version !== "0.9.0") throw new Error("Release surfaces must be 0.9.0");

const wrangler = await jsonFile("wrangler.jsonc");
if (wrangler.d1_databases?.some((entry) => entry.database_id)) throw new Error("D1 must remain unpinned for clean deployment");
if (wrangler.d1_databases?.[0]?.database_name !== "driftglass-db") throw new Error("D1 needs a deterministic recoverable resource name");
if (wrangler.r2_buckets?.[0]?.bucket_name !== "driftglass-evidence") throw new Error("R2 needs a deterministic recoverable resource name");
if (wrangler.browser?.binding !== "BROWSER") throw new Error("Adaptive browsing requires BROWSER");
for (const [binding, className] of [["MISSION_WORKFLOW","MissionSprintWorkflow"],["MEMORY_WORKFLOW","MemoryGraphWorkflow"],["ROUTINE_WORKFLOW","IntelligenceRoutineWorkflow"]]) {
  if (!wrangler.workflows?.some((entry) => entry.binding === binding && entry.class_name === className)) throw new Error(`${binding} is invalid`);
}
if (!wrangler.durable_objects?.bindings?.some((entry) => entry.name === "MISSION_COMPUTER" && entry.class_name === "MissionComputer")) throw new Error("MISSION_COMPUTER is invalid");
if (
  wrangler.observability?.enabled !== false
  || wrangler.observability?.logs?.enabled !== false
  || wrangler.observability?.logs?.invocation_logs !== false
  || wrangler.observability?.traces?.enabled !== false
) throw new Error("Retained URL-bearing Workers logs and traces must stay disabled for capability URLs");
for (const route of ["/share/*", "/robots.txt", "/sitemap.xml"]) {
  if (!wrangler.assets?.run_worker_first?.includes(route)) throw new Error(`Worker-first route missing ${route}`);
}
const staging = wrangler.env?.staging;
if (!staging || staging.vars?.PUBLIC_INDEXING !== "disabled" || staging.triggers?.crons?.length !== 0) throw new Error("Staging privacy policy is invalid");
if (
  staging.observability?.enabled !== false
  || staging.observability?.logs?.enabled !== false
  || staging.observability?.logs?.invocation_logs !== false
  || staging.observability?.traces?.enabled !== false
) throw new Error("Staging must not retain URL-bearing Workers logs or traces");
if (staging.queues?.producers?.[0]?.queue !== "driftglass-staging-ingest") throw new Error("Staging Queue is not isolated");
if (staging.ai_search_namespaces?.[0]?.namespace !== "driftglass-staging") throw new Error("Staging AI Search namespace is not isolated");
if (!staging.workflows?.every((entry) => entry.name.startsWith("driftglass-staging-"))) throw new Error("Staging Workflows are not isolated");
if (staging.d1_databases?.some((entry) => entry.database_id)) throw new Error("Staging resource IDs must not ship in the public config");
if (staging.d1_databases?.[0]?.database_name !== "driftglass-staging-db" || staging.r2_buckets?.[0]?.bucket_name !== "driftglass-staging-evidence") throw new Error("Staging resources need deterministic isolated names");

if (pkg.dependencies?.["@cloudflare/computer"] !== "0.1.1") throw new Error("Core Computer pin is unexpected");
if (pkg.dependencies?.agents !== "0.20.1") throw new Error("Agents SDK pin is unexpected");
if (pkg.dependencies?.["@modelcontextprotocol/server"] !== "2.0.0") throw new Error("MCP server pin is unexpected");
if (pkg.devDependencies?.wrangler !== "4.120.0") throw new Error("Wrangler pin is unexpected");
if (!pkg.scripts?.deploy?.includes("db:migrate:remote") || !pkg.scripts?.["deploy:staging"]?.includes("db:migrate:staging")) throw new Error("Deploy scripts must apply D1 migrations");
if (pkg.allowScripts?.["esbuild@0.28.1"] !== true || pkg.allowScripts?.["workerd@1.20260801.1"] !== true) throw new Error("Required install scripts are not narrowly approved");
if (/openai|anthropic|xai/i.test(JSON.stringify(pkg.dependencies))) throw new Error("Core must not require a model-provider SDK");

const computer = await text("src/mission-computer.ts");
if (!computer.includes("withWorkspace") || !computer.includes("freeTierCapable: true") || !computer.includes("importMissionComputerFiles")) throw new Error("Mission Computer contract is incomplete");
const labPackage = await jsonFile("labs/deep-dive-lab/package.json");
const labWorker = await text("labs/deep-dive-lab/src/index.ts");
if (labPackage.dependencies?.["@cloudflare/computer"] !== "0.1.1") throw new Error("Power Mode Computer pin is unexpected");
if (!labWorker.includes("WorkerShellBackend") || !labWorker.includes("WorkerJavaScriptBackend")) throw new Error("Power Mode must keep dual isolate backends");

const memory = await text("src/memory-graph.ts");
for (const expected of ["maxNodes: 500", "maxEdges: 2_000", "maxPendingProposals: 50", "maxNeighborhoodNodes: 80", "memoryGraphAudit", "stageMemoryProposal", "approveMemoryProposal"]) {
  if (!memory.includes(expected)) throw new Error(`Memory contract missing ${expected}`);
}
const epistemic = await text("src/epistemic-memory.ts");
for (const expected of ["class MemoryGraphWorkflow", "maxNodes: 350", "maxEdges: 1_200", "missions: 12", "stories: 40", "The MEMORY_WORKFLOW binding is required", "status: \"deferred\""]) {
  if (!epistemic.includes(expected)) throw new Error(`Free-tier Memory Workflow contract missing ${expected}`);
}
if (/refreshEpistemicMemoryInline/.test(epistemic)) throw new Error("Unsafe inline Memory Graph fallback returned");

const budget = await text("src/budget.ts");
for (const expected of ["browser_ms_day: 480_000", "browser_ms_day: 900_000", "workflow_steps_day: 2_400", "ai_search_queries_month: 15_000", "source_runs_day: 240", "queue_messages_day: 2_500"]) {
  if (!budget.includes(expected)) throw new Error(`Free budget contract missing ${expected}`);
}
const cadence = await text("src/adaptive-cadence.ts");
for (const expected of ["failure-backoff", "low-yield-backoff", "high-signal-acceleration", "adaptive_cadence_enabled"]) if (!cadence.includes(expected)) throw new Error(`Adaptive cadence missing ${expected}`);
const lineage = await text("src/evidence-lineage.ts");
for (const expected of ["sourceFamily", "origin", "echo", "update", "independent"]) if (!lineage.includes(expected)) throw new Error(`Evidence lineage missing ${expected}`);

const compactMcp = await text("src/reasoning-mcp.ts");
for (const expected of ["next_reasoning_task", "prepare_context", "compare_memory", "get_system_health"]) if (!compactMcp.includes(expected)) throw new Error(`Compact MCP missing ${expected}`);
if (/record_reasoning_result/.test(compactMcp)) throw new Error("Compact MCP must remain read-only");
const opsMcp = await text("src/mcp.ts");
for (const expected of ["prepare_reasoning_receipt", "record_reasoning_result", "create_decision_record", "run_intelligence_routine", "capture_pack_customizations"]) if (!opsMcp.includes(expected)) throw new Error(`Operations MCP missing ${expected}`);
const receiptSource = await text("src/reasoning-ledger.ts");
for (const expected of ["bundle_hash", "responseHash", "compareReasoningRuns", "memoryProposalId"]) if (!receiptSource.includes(expected)) throw new Error(`Reasoning receipt contract missing ${expected}`);
const sourceScorecards = await text("src/source-scorecards.ts");
for (const expected of ["recentRunsPerSource = 32", "ROW_NUMBER() OVER (PARTITION BY source_id", "COUNT(DISTINCT matches.mission_id"]) if (!sourceScorecards.includes(expected)) throw new Error(`Bounded source scorecard contract missing ${expected}`);
for (const expected of ["receiptId: _receiptId, generatedAt: _generatedAt", "Promise.allSettled([env.EVIDENCE.delete(jsonKey)", "[\"completed\", \"reviewed\", \"rejected\"].includes(run.status)"]) if (!receiptSource.includes(expected)) throw new Error(`Reasoning reliability contract missing ${expected}`);
const decisions = await text("src/decision-ledger.ts");
for (const expected of ["forecast", "reviewDecision", "calibration", "brier"]) if (!decisions.toLowerCase().includes(expected.toLowerCase())) throw new Error(`Decision ledger missing ${expected}`);
const routines = await text("src/intelligence-routines.ts");
for (const expected of ["refresh-sources", "compile-context", "checkpoint-memory", "ROUTINE_WORKFLOW"]) if (!routines.includes(expected)) throw new Error(`Intelligence Routine missing ${expected}`);
const overlays = await text("src/pack-overlays.ts");
for (const expected of ["applyPackOverlay", "deriveInstalledPackOverlay", "conflicts", "sourceOverrides"]) if (!overlays.includes(expected)) throw new Error(`Pack overlay contract missing ${expected}`);

const packCatalog = await jsonFile("public/intelligence-packs/catalog.json");
if (!Array.isArray(packCatalog.packs) || packCatalog.packs.length < 3) throw new Error("Intelligence Pack catalog needs at least three Packs");
for (const entry of packCatalog.packs) {
  if (entry.pack?.driftglassPack !== "3") throw new Error(`${entry.id} is not Pack v3`);
  if (!(Number(entry.cloudSourceCount) >= 1) || !(Number(entry.cloudCoverage) > 0)) throw new Error(`${entry.id} is not cloud-first`);
  if (!entry.pack?.reasoning?.outputContract?.length) throw new Error(`${entry.id} lacks a reasoning output contract`);
  if (!entry.pack?.memory?.claims?.length || !entry.pack?.memory?.expectations?.length) throw new Error(`${entry.id} lacks epistemic seeds`);
  if (!entry.pack?.evidencePolicy?.minPrimarySources || !entry.pack?.evidencePolicy?.minIndependentSources) throw new Error(`${entry.id} lacks an evidence policy`);
  if (!entry.pack?.routines?.length) throw new Error(`${entry.id} lacks deterministic routines`);
}

const openapi = await jsonFile("public/openapi.json");
if (openapi.info?.version !== "0.9.0") throw new Error("OpenAPI version is stale");
for (const apiPath of [
  "/api/judgment", "/api/dossiers", "/api/runtime", "/api/runtime/plan", "/api/source-scorecards",
  "/api/memory/checkpoints", "/api/memory/checkpoints/compare", "/api/reasoning/receipts",
  "/api/reasoning/receipts/{receiptId}/results", "/api/reasoning/receipts/{receiptId}/compare",
  "/api/reasoning/tasks", "/api/reasoning/tasks/next", "/api/decisions", "/api/decisions/{decisionId}",
  "/api/decisions/{decisionId}/review", "/api/routines", "/api/routines/{routineId}/run",
  "/api/evidence/lineage", "/api/sources/cadence", "/api/intelligence-packs/{packId}/overlays",
  "/api/intelligence-packs/{packId}/overlays/capture", "/api/intelligence-packs/{packId}/fork",
]) if (!openapi.paths?.[apiPath]) throw new Error(`OpenAPI is missing ${apiPath}`);

const mcpCard = await jsonFile("public/.well-known/mcp.json");
const compactMcpTools = [
  "brief_today", "brief_mission", "present_brief", "open_today", "next_reasoning_task", "prepare_context", "prepare_personal_context",
  "search", "find_missions", "fetch", "get_mission", "recall_memory", "compare_memory", "explain_story",
  "get_action_center", "get_system_health", "list_intelligence_packs",
];
if (
  mcpCard.version !== "0.9.0"
  || JSON.stringify(mcpCard.tools) !== JSON.stringify(compactMcpTools)
  || JSON.stringify(mcpCard.profiles?.reasoning?.tools) !== JSON.stringify(compactMcpTools)
) throw new Error("MCP discovery card is stale");
const productCard = await jsonFile("public/.well-known/driftglass.json");
if (
  productCard.version !== "0.9.0"
  || productCard.intelligence?.reasoningReceipts !== "/api/reasoning/receipts"
  || productCard.intelligence?.runtimeFabric !== "/api/runtime"
  || JSON.stringify(productCard.mcp?.ui) !== JSON.stringify([
    "ui://driftglass/briefing-v2.html",
    "ui://driftglass/editorial-brief-v9.html",
    "ui://driftglass/editorial-brief-v8.html",
  ])
) throw new Error("Product card is stale");
const agentCard = await jsonFile("public/.well-known/agent.json");
if (agentCard.version !== "0.9.0" || agentCard.interfaces?.judgment !== "/api/judgment" || agentCard.interfaces?.memory_checkpoints !== "/api/memory/checkpoints") throw new Error("Agent card is stale");

const profileSource = await text("src/profile.ts");
for (const expected of ["schemaVersion: 3", "intelligencePacks", "customPlaybooks", "approvedMemoryPatches", "budgetProfile", "graphPolicy"]) if (!profileSource.includes(expected)) throw new Error(`Portable Profile v3 missing ${expected}`);
const dashboard = await text("public/app.js");
for (const expected of ["renderJudgment", "currentReasoningReceipt", "materializeJudgmentTask", "overlays/capture", "sourceScorecards"]) if (!dashboard.includes(expected)) throw new Error(`Dashboard v0.9 contract missing ${expected}`);


const currentDocs = ["README.md", "docs/ROADMAP.md", "public/install.md", "public/llms.txt", "public/llms-full.txt"];
for (const file of currentDocs) {
  const content = await text(file);
  if (/\b0\.8\.0\b/.test(content)) throw new Error(`Current release surface is stale in ${file}`);
  if (/Pack v2 previews/.test(content)) throw new Error(`Current Pack surface is stale in ${file}`);
}

const relay = await readFile(path.join(root, "driftglass-relay/driftglass-relay.mjs"));
const publicRelay = await readFile(path.join(root, "public/relay/driftglass-relay.mjs"));
if (!relay.equals(publicRelay)) throw new Error("Hosted Companion copy is stale; run npm run sync:relay");
const relayManifest = await jsonFile("public/relay/manifest.json");
const digest = createHash("sha256").update(relay).digest("hex");
if (relayManifest.sha256 !== digest || relayManifest.version !== "0.9.0") throw new Error("Companion manifest is stale");

const sourceFiles = [];
for (const folder of ["src", "public", "driftglass-relay"]) {
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else sourceFiles.push(target);
    }
  }
  await walk(path.join(root, folder));
}
const forbidden = /\b(?:Asterism|Signal Desk)\b/i;
for (const file of sourceFiles) {
  const content = await readFile(file, "utf8");
  if (forbidden.test(content)) throw new Error(`Stale project branding in ${path.relative(root, file)}`);
}
console.log(`Repository contract verified for Driftglass ${pkg.version}.`);
