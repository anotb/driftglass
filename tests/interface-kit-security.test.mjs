import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { reasoningInterfaceKitZip } = require("../.test-dist/reasoning.js");
const execFileAsync = promisify(execFile);

async function readZipMember(archive, name) {
  const directory = await mkdtemp(join(tmpdir(), "driftglass-interface-kit-"));
  const zipPath = join(directory, "kit.zip");
  await writeFile(zipPath, archive);
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, name]);
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bundle(overrides = {}) {
  return {
    schemaVersion: "3",
    generatedAt: "2026-08-07T00:00:00.000Z",
    target: "claude",
    task: "investigate",
    title: "Interface-kit capability test",
    objective: "Test the least-privilege export contract",
    tokenBudget: 2_000,
    executiveContext: [],
    memory: { nodes: [], edges: [], timeline: [], rationale: [] },
    evidence: [],
    coverage: {
      evidenceCount: 0,
      storyCount: 0,
      sourceCount: 0,
      sourceFamilyCount: 0,
      independentFamilyCount: 0,
      echoCount: 0,
      echoShare: 0,
      sourceFamilies: [],
      sourceKinds: [],
      sourceRoles: {},
      primarySourceCount: 0,
      independentSourceCount: 0,
      discoveryShare: 0,
      cloudEvidenceCount: 0,
      localEvidenceCount: 0,
    },
    relevantPacks: [],
    contextBudget: { estimatedTokens: 0, sectionChars: {}, truncatedSections: [] },
    quality: {
      grade: "usable",
      score: 70,
      dimensions: {
        evidenceDepth: 0,
        sourceDiversity: 0,
        provenance: 0,
        memoryContinuity: 0,
        recency: 0,
        challengeCoverage: 0,
        cloudIndependence: 0,
        echoResistance: 0,
      },
      deepResearchRecommended: false,
      blockers: [],
      recommendations: [],
    },
    contradictions: [],
    gaps: [],
    openQuestions: [],
    playbooks: [],
    instructions: [],
    outputContract: [],
    resultContract: {},
    memoryPatchContract: {},
    mcpUrl: "https://driftglass.invalid/mcp/read-capability",
    ...overrides,
  };
}

test("interface kit omits operations configuration unless the owner explicitly includes it", () => {
  const compact = Buffer.from(reasoningInterfaceKitZip(bundle())).toString("utf8");
  assert.match(compact, /read-capability/);
  assert.match(compact, /deliberately omits the mutation-capable operations profile/);
  assert.doesNotMatch(compact, /driftglass_ops|operations-capability|YOUR-PRIVATE-OPERATIONS-KEY/);

  const full = Buffer.from(reasoningInterfaceKitZip(bundle({
    operationsMcpUrl: "https://driftglass.invalid/mcp/operations-capability/ops",
  }))).toString("utf8");
  assert.match(full, /driftglass_ops/);
  assert.match(full, /operations-capability/);
  assert.match(full, /private full kit/);
});

test("interface kit carries a task result schema separately from the memory-patch contract", () => {
  const resultContract = {
    type: "object",
    additionalProperties: false,
    properties: { recommendation: { type: "string" } },
    required: ["recommendation"],
  };
  const kit = Buffer.from(reasoningInterfaceKitZip(bundle({ resultContract }))).toString("utf8");
  assert.match(kit, /result\.schema\.json/);
  assert.match(kit, /finite structured-output contract for this task/);
  assert.match(kit, /recommendation/);
  assert.match(kit, /memory-patch\.schema\.json/);
});

test("contracted interface prompts keep saved answers on the exact source set", async () => {
  const resultContract = {
    type: "object",
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
  };
  const archive = reasoningInterfaceKitZip(bundle({ resultContract }));
  const [taskPrompt, deepResearchPrompt] = await Promise.all([
    readZipMember(archive, "chatgpt/task-prompt.md"),
    readZipMember(archive, "chatgpt/deep-research-prompt.md"),
  ]);
  assert.match(taskPrompt, /exact source set/);
  assert.match(taskPrompt, /Use no sources outside the bundle/);
  assert.match(taskPrompt, /Do not append a memory proposal/);
  assert.match(deepResearchPrompt, /do not claim that it satisfies the attached receipt or structured-result schema/);
  assert.match(deepResearchPrompt, /Return the new sources for import; Driftglass must compile a new source set/);
  assert.doesNotMatch(`${taskPrompt}\n${deepResearchPrompt}`, /propose (?:a )?(?:durable-)?memory patch/i);
});

test("dashboard, owner endpoint, and public contract require an explicit operations-kit opt-in", async () => {
  const [html, app, api, openapiRaw, docs] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/intelligence-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/openapi.json", import.meta.url), "utf8"),
    readFile(new URL("../docs/REASONING-INTERFACES.md", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="include-operations-kit"[^>]*type="checkbox"/);
  assert.match(html, /Include the update connection so the model can save suggestions for review/);
  assert.match(app, /includeOperations: Boolean\(\$\("#include-operations-kit"\)\?\.checked\)/);
  assert.match(api, /includeOperationsCapability: body\.includeOperations === true/);
  assert.doesNotMatch(api, /includeOperationsCapability: true/);
  const includeOperations = JSON.parse(openapiRaw).paths["/api/reasoning/interface-kit.zip"].post
    .requestBody.content["application/json"].schema.properties.includeOperations;
  assert.equal(includeOperations.type, "boolean");
  assert.equal(includeOperations.default, false);
  assert.match(includeOperations.description, /mutation bearer/);
  assert.match(docs, /normal kit contains only the Research connection/);
});
