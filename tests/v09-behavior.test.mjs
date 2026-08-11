import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { planRuntimeTask } = require("../.test-dist/runtime-router.js");
const { diffMemorySnapshots } = require("../.test-dist/memory-checkpoint-diff.js");
const {
  estimateIntelligenceRoutineWorkflowSteps,
  normalizeIntelligenceRoutine,
  planIntelligenceRoutineRuntime,
} = require("../.test-dist/intelligence-routines.js");
const { applyPackOverlay } = require("../.test-dist/pack-overlays.js");
const { buildDropCapsule, buildForkableIntelligencePack } = require("../.test-dist/drop-capsule.js");
const { parseIntelligencePack } = require("../.test-dist/intelligence-packs.js");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const runtimeContext = {
  browserAvailable: true,
  companionOnline: true,
  computerAvailable: true,
  computerPowerAvailable: false,
  budgetProfile: "free",
  browserRemainingMs: 300_000,
  workflowRemainingSteps: 2_000,
  policy: { mode: "auto", preferCloud: true, allowCompanion: true, allowComputer: true, allowChromiumFallback: true },
};

test("runtime fabric keeps public work cloud-first and chooses authenticated or persistent substrates only when needed", () => {
  const publicPlan = planRuntimeTask({ kind: "collect", access: "public" }, runtimeContext);
  assert.equal(publicPlan.primary.runtime, "worker");
  assert.equal(publicPlan.cloudOnly, true);
  assert.equal(publicPlan.companionOptional, true);

  const rendered = planRuntimeTask({ kind: "render", access: "public", requiresBrowser: true }, runtimeContext);
  assert.equal(rendered.primary.runtime, "kitesurf");
  assert.ok(rendered.fallbacks.some((candidate) => candidate.runtime === "chromium"));

  const privateMission = planRuntimeTask({ kind: "compare", access: "private", persistence: "mission", missionId: "mission-cloudflare", requiresFiles: true, multiStep: true }, runtimeContext);
  assert.equal(privateMission.primary.runtime, "computer");

  const authenticated = planRuntimeTask({ kind: "collect", access: "authenticated", sourceId: "x-bookmarks" }, runtimeContext);
  assert.equal(authenticated.primary.runtime, "companion");
});

test("runtime fabric blocks authenticated work when no Companion exists without weakening cloud-only public work", () => {
  const noCompanion = { ...runtimeContext, companionOnline: false };
  const privatePlan = planRuntimeTask({ kind: "collect", access: "authenticated" }, noCompanion);
  assert.equal(privatePlan.blocked, true);
  const publicPlan = planRuntimeTask({ kind: "browse", access: "public", requiresBrowser: true }, noCompanion);
  assert.equal(publicPlan.primary.runtime, "kitesurf");
});

test("Memory checkpoints expose temporal additions, removals, and changed beliefs", () => {
  const base = {
    schemaVersion: "1",
    scope: { kind: "mission", id: "m1", ref: "mission:m1", title: "Cloudflare agent stack" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    nodes: [
      { id: "claim", type: "claim", key: "claim:computer", label: "Computer is useful", summary: "Initial", aliases: [], metadata: {}, importance: 0.8, confidence: 0.6, occurredAt: null, status: "active", supersededBy: null, sourceRef: "story:s1", validFrom: null, validTo: null },
      { id: "question", type: "question", key: "question:pricing", label: "Pricing?", summary: "Unresolved", aliases: [], metadata: {}, importance: 0.5, confidence: 1, occurredAt: null, status: "active", supersededBy: null, sourceRef: "mission:m1", validFrom: null, validTo: null },
    ],
    edges: [{ id: "edge-1", from: "claim", to: "question", relation: "relevant_to", weight: 0.7, confidence: 0.7, evidence: ["s1"], rationale: "pricing matters", status: "active" }],
    summary: { nodes: 2, edges: 1, activeNodes: 2, activeEdges: 1, byType: { claim: 1, question: 1 }, byRelation: { relevant_to: 1 } },
  };
  const current = structuredClone(base);
  current.capturedAt = "2026-08-07T00:00:00.000Z";
  current.nodes = [
    { ...base.nodes[0], summary: "Strengthened after launch", confidence: 0.82 },
    { id: "decision", type: "decision", key: "decision:adopt", label: "Pilot Computer", summary: "Use for Mission workspaces", aliases: [], metadata: {}, importance: 0.9, confidence: 0.8, occurredAt: null, status: "active", supersededBy: null, sourceRef: "mission:m1", validFrom: null, validTo: null },
  ];
  current.edges = [{ id: "edge-2", from: "decision", to: "claim", relation: "derived_from", weight: 0.9, confidence: 0.8, evidence: ["s2"], rationale: "decision follows evidence", status: "active" }];
  const diff = diffMemorySnapshots(base, current, "cp-previous");
  assert.deepEqual(diff.addedNodes, ["decision"]);
  assert.deepEqual(diff.removedNodes, ["question"]);
  assert.deepEqual(diff.changedNodes, ["claim"]);
  assert.deepEqual(diff.addedEdges, ["edge-2"]);
  assert.deepEqual(diff.removedEdges, ["edge-1"]);
  assert.equal(diff.unchanged, false);
});

test("Intelligence Routines remain deterministic, bounded, and runtime-routable", () => {
  const routine = normalizeIntelligenceRoutine({
    id: "cloudflare-change-loop",
    name: "Cloudflare change loop",
    trigger: "scheduled",
    scheduleMinutes: 360,
    budgetClass: "light",
    steps: [
      { id: "refresh", action: "refresh-sources", runtime: "auto", sourceIds: ["docs", "github"] },
      { id: "settle", action: "wait-for-ingest", waitSeconds: 45 },
      { id: "rebuild", action: "rebuild-mission", runtime: "worker" },
      { id: "context", action: "compile-context", reasoningTask: "challenge", target: "chatgpt" },
      { id: "checkpoint", action: "checkpoint-memory", runtime: "computer", optional: true },
    ],
  });
  assert.equal(routine.steps.length, 5);
  assert.equal(routine.steps[3].reasoningTask, "challenge");
  assert.equal(routine.steps[3].target, "chatgpt");
  assert.equal(planIntelligenceRoutineRuntime(routine, runtimeContext)[0].task.estimatedWorkflowSteps, 8);
  assert.equal(
    planIntelligenceRoutineRuntime(routine, runtimeContext)[2].task.estimatedWorkflowSteps,
    1,
    "the child-Workflow handoff is planned as a single non-retrying attempt",
  );
  assert.equal(estimateIntelligenceRoutineWorkflowSteps(routine), 38, "every configured callback attempt is reserved");
  const dynamicRoutine = {
    ...routine,
    missionId: "mission-dynamic",
    steps: [{ id: "refresh", action: "refresh-sources", sourceIds: [] }],
  };
  assert.equal(planIntelligenceRoutineRuntime(dynamicRoutine, runtimeContext)[0].task.estimatedWorkflowSteps, 30);
  assert.equal(estimateIntelligenceRoutineWorkflowSteps(dynamicRoutine), 48, "mission-derived refreshes share one bounded source-call envelope");
  const sharedEnvelopeRoutine = normalizeIntelligenceRoutine({
    id: "shared-source-envelope",
    name: "Shared source envelope",
    steps: [
      {
        id: "optional-prefix",
        action: "refresh-sources",
        optional: true,
        sourceIds: Array.from({ length: 20 }, (_, index) => `optional-${index}`),
      },
      {
        id: "required-sources",
        action: "refresh-sources",
        sourceIds: Array.from({ length: 20 }, (_, index) => `required-${index}`),
      },
    ],
  });
  assert.deepEqual(
    planIntelligenceRoutineRuntime(sharedEnvelopeRoutine, runtimeContext)
      .map((plan) => plan.task.estimatedWorkflowSteps),
    [10, 20],
    "required sources receive first attempts before an earlier optional prefix",
  );
  assert.equal(estimateIntelligenceRoutineWorkflowSteps(sharedEnvelopeRoutine), 48);
  assert.throws(() => normalizeIntelligenceRoutine({ name: "bad", steps: [{ action: "run-model" }] }), /Unsupported routine action/);
  assert.throws(() => normalizeIntelligenceRoutine({ name: "too empty", steps: [] }), /at least one step/);
  assert.throws(() => normalizeIntelligenceRoutine({
    name: "stale rebuild",
    steps: [
      { action: "refresh-sources", sourceIds: ["docs"] },
      { action: "rebuild-mission" },
    ],
  }), /requires wait-for-ingest after refresh-sources/);
  assert.throws(() => normalizeIntelligenceRoutine({
    name: "stale context after multiple refreshes",
    steps: [
      { action: "refresh-sources", sourceIds: ["docs"] },
      { action: "refresh-sources", sourceIds: ["github"] },
      { action: "compile-context" },
    ],
  }), /requires wait-for-ingest after refresh-sources/);
  assert.doesNotThrow(() => normalizeIntelligenceRoutine({
    name: "refresh only",
    steps: [{ action: "refresh-sources", sourceIds: ["docs"] }],
  }));
  assert.doesNotThrow(() => normalizeIntelligenceRoutine({
    name: "settled consumer",
    steps: [
      { action: "refresh-sources", sourceIds: ["docs"] },
      { action: "refresh-sources", sourceIds: ["github"] },
      { action: "wait-for-ingest" },
      { action: "rebuild-mission" },
      { action: "sync-computer" },
    ],
  }));
});

test("Pack v3 overlays preserve user customizations across upstream evolution", () => {
  const base = parseIntelligencePack({
    driftglassPack: "3",
    id: "agent-radar",
    version: "1.0.0",
    name: "Agent Radar",
    description: "Cloud-first agent intelligence",
    cloudSources: [
      { id: "docs", name: "Official docs", kind: "web", config: { url: "https://example.com/docs" }, scheduleMinutes: 180, weight: 1.2 },
      { id: "hn", name: "HN", kind: "hackernews", config: { feed: "best" }, scheduleMinutes: 90, weight: 1 },
    ],
    missions: [{ id: "winning", name: "Which stack is winning?", question: "Which agent stack is winning?", terms: ["agents"] }],
    budget: { profile: "free" },
  });
  const result = applyPackOverlay(base, {
    disableSources: ["hn"],
    sourceOverrides: { docs: { scheduleMinutes: 60, weight: 1.7 } },
    addSources: [{ id: "local-bookmarks", name: "My bookmarks", kind: "collector", config: { operation: "x.bookmarks" }, scheduleMinutes: 240, weight: 1.4 }],
    missionOverrides: { winning: { alertThreshold: 0.8 } },
    addInterestTerms: ["computer use"],
  });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.pack.cloudSources.some((source) => source.id === "hn"), false);
  assert.equal(result.pack.cloudSources.find((source) => source.id === "docs").scheduleMinutes, 60);
  assert.equal(result.pack.companionSources.find((source) => source.id === "local-bookmarks").kind, "collector");
  assert.equal(result.pack.missions[0].alertThreshold, 0.8);
  assert.ok(result.pack.interestTerms.includes("computer use"));
});

test("Cloudflare Drop capsules carry a cloud-only forkable Intelligence Pack", async () => {
  const payload = {
    schemaVersion: "2",
    publicEvidenceOnly: true,
    kind: "mission",
    title: "Cloudflare agent infrastructure",
    subtitle: "What materially changed this week?",
    generatedAt: "2026-08-07T12:00:00.000Z",
    context: [{ label: "Current thesis", value: "Computer improves persistent Mission workspaces." }],
    stories: [{
      id: "story-1",
      title: "Cloudflare launches Computer and Kitesurf",
      summary: "A durable filesystem and stateless agent browser change the architecture.",
      evidenceCount: 2,
      sourceCount: 2,
      sourceFamilyCount: 2,
      independentFamilyCount: 2,
      echoCount: 0,
      confidence: 0.82,
      changedAt: "2026-08-07T10:00:00.000Z",
      evidence: [
        { accessClass: "public", independent: true, lineageRelation: "origin", evidenceFamily: "blog.cloudflare.com", source: "Cloudflare", title: "Computer announcement", url: "https://blog.cloudflare.com/cloudflare-computer", publishedAt: "2026-08-06T00:00:00.000Z", excerpt: "Durable filesystem." },
        { accessClass: "public", independent: true, lineageRelation: "origin", evidenceFamily: "developers.cloudflare.com", source: "Cloudflare Docs", title: "Computer docs", url: "https://developers.cloudflare.com/computer/", publishedAt: "2026-08-06T00:00:00.000Z", excerpt: "Workspace backends." },
      ],
    }],
  };
  const pack = buildForkableIntelligencePack(payload);
  assert.equal(pack.driftglassPack, "3");
  assert.equal(pack.requiresCompanion, false);
  assert.equal(pack.companionSources.length, 0);
  assert.ok(pack.cloudSources.length >= 1);
  assert.ok(pack.missions.length === 1);
  assert.ok(pack.routines.length === 1);
  assert.equal(pack.budget.profile, "free");
  assert.equal(pack.icon, "✦");
  const parsedPack = parseIntelligencePack(pack);
  assert.equal(parsedPack.icon, pack.icon);
  assert.deepEqual(parsedPack.cloudSources.map((source) => source.id), pack.cloudSources.map((source) => source.id));
  assert.deepEqual(parsedPack.missions.map((mission) => mission.id), pack.missions.map((mission) => mission.id));
  assert.deepEqual(parsedPack.routines.map((routine) => routine.id), pack.routines.map((routine) => routine.id));

  const longTitlePack = buildForkableIntelligencePack({ ...payload, title: `Sample public data: ${"long-title ".repeat(30)}` });
  const longSourceIds = longTitlePack.cloudSources.map((source) => source.id);
  assert.equal(new Set(longSourceIds).size, 2);
  assert.ok(longSourceIds.every((id) => id.length <= 80));
  assert.match(longSourceIds[0], /-source-1-blog-cloudflare-com$/);
  assert.match(longSourceIds[1], /-source-2-developers-cloudflar$/);
  assert.deepEqual(longTitlePack.missions[0].sourceScope, longSourceIds);
  const parsedLongTitlePack = parseIntelligencePack(longTitlePack);
  assert.deepEqual(parsedLongTitlePack.cloudSources.map((source) => source.id), longSourceIds);
  assert.deepEqual(parsedLongTitlePack.missions[0].sourceScope, longSourceIds);

  const archive = buildDropCapsule(payload);
  const directory = await mkdtemp(join(tmpdir(), "driftglass-v09-drop-"));
  const zipPath = join(directory, "drop.zip");
  await writeFile(zipPath, archive);
  try {
    const { stdout } = await execFileAsync("unzip", ["-l", zipPath]);
    for (const name of ["index.html", "driftglass-pack.json", "evidence.md", "llms.txt", "manifest.webmanifest"]) assert.match(stdout, new RegExp(name.replace(".", "\\.")));
    const { stdout: page } = await execFileAsync("unzip", ["-p", zipPath, "index.html"]);
    assert.match(page, /Continue in Driftglass/);
    const { stdout: packJson } = await execFileAsync("unzip", ["-p", zipPath, "driftglass-pack.json"]);
    const extracted = JSON.parse(packJson);
    assert.equal(extracted.requiresCompanion, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v0.9 keeps model reasoning external while making receipts, decisions, lineage, and routines first-class", async () => {
  const [pkgRaw, migration, compactMcp, opsMcp, index, judgment, drop] = await Promise.all([
    read("package.json"),
    read("migrations/0015_reasoning_ledger.sql"),
    read("src/reasoning-mcp.ts"),
    read("src/mcp.ts"),
    read("src/index.ts"),
    read("src/judgment.ts"),
    read("src/drop-capsule.ts"),
  ]);
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.version, "0.9.0");
  assert.match(migration, /response_hash/);
  assert.match(migration, /provider_label/);
  assert.match(compactMcp, /next_reasoning_task/);
  assert.match(compactMcp, /compare_memory/);
  assert.doesNotMatch(compactMcp, /record_reasoning_result/);
  assert.match(opsMcp, /prepare_reasoning_receipt/);
  assert.match(opsMcp, /record_reasoning_result/);
  assert.match(opsMcp, /create_decision_record/);
  assert.match(index, /startDueIntelligenceRoutines/);
  assert.match(judgment, /sourceScorecards/);
  assert.match(drop, /driftglass-pack\.json/);
  assert.doesNotMatch(JSON.stringify(pkg.dependencies), /openai|anthropic|xai|project-think/i);
});


test("v0.9 reliability paths stay bounded, deterministic, and retry-safe", async () => {
  const [scorecards, ledger, tasks] = await Promise.all([
    read("src/source-scorecards.ts"),
    read("src/reasoning-ledger.ts"),
    read("src/reasoning-tasks.ts"),
  ]);
  assert.match(scorecards, /ROW_NUMBER\(\) OVER \(PARTITION BY source_id/);
  assert.match(scorecards, /recentRunsPerSource = 32/);
  assert.match(scorecards, /COUNT\(DISTINCT matches\.mission_id \|\| ':' \|\| linked\.story_id\)/);
  assert.doesNotMatch(scorecards, /"pending"\]\.includes\(row\.status\)/);
  assert.match(ledger, /receiptId: _receiptId, generatedAt: _generatedAt/);
  assert.match(ledger, /Promise\.allSettled\(\[env\.EVIDENCE\.delete\(jsonKey\)/);
  assert.match(ledger, /\["completed", "reviewed", "rejected"\]\.includes\(run\.status\)/);
  assert.match(tasks, /partial unique index is the final concurrency guard/);
  assert.match(tasks, /if \(raced\) return raced/);
});
