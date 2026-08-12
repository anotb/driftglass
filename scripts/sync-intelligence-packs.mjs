import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { contentDigest, verifyGeneratedFiles } from "./generated-assets.mjs";

const examples = new URL("../intelligence-packs/examples/", import.meta.url);
const output = new URL("../public/intelligence-packs/", import.meta.url);
const schemaUrl = new URL("../intelligence-packs/schema.json", import.meta.url);
const checkOnly = process.argv.includes("--check");
const allowedKinds = new Set([
  "hackernews", "lobsters", "bluesky", "arxiv", "openalex", "github_releases", "github_activity",
  "npm_releases", "pypi_releases", "web", "web_feed", "collector", "manual", "email",
]);

function fail(file, message) { throw new Error(`${file}: ${message}`); }
function sources(pack) { return [...(pack.sources || []), ...(pack.cloudSources || []), ...(pack.companionSources || [])]; }
function validate(file, pack) {
  if (!pack || typeof pack !== "object") fail(file, "must contain an object");
  if (pack.driftglassPack !== "3") fail(file, "driftglassPack must be \"3\"");
  for (const key of ["id", "version", "name", "description"]) if (!String(pack[key] || "").trim()) fail(file, `${key} is required`);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(pack.id)) fail(file, "id must be a lowercase slug");
  const all = sources(pack);
  if (!all.length && !(pack.missions || []).length && !Object.values(pack.memory || {}).some((value) => Array.isArray(value) && value.length)) fail(file, "must contain sources, Missions, or memory seeds");
  const ids = new Set();
  for (const [index, source] of all.entries()) {
    for (const key of ["id", "name", "kind", "config", "scheduleMinutes", "weight"]) if (source[key] === undefined || source[key] === "") fail(file, `source ${index + 1}.${key} is required`);
    if (ids.has(source.id)) fail(file, `duplicate source id ${source.id}`);
    ids.add(source.id);
    if (!allowedKinds.has(source.kind)) fail(file, `unsupported source kind ${source.kind}`);
    if (Number(source.scheduleMinutes) < 15 || Number(source.scheduleMinutes) > 10080) fail(file, `source ${source.id} cadence is out of range`);
    if (Number(source.weight) < 0.1 || Number(source.weight) > 3) fail(file, `source ${source.id} weight is out of range`);
  }
  const companionIds = new Set((pack.companionSources || []).map((source) => source.id));
  for (const source of pack.companionSources || []) if (source.kind !== "collector") fail(file, `companion source ${source.id} must use collector kind`);
  for (const source of pack.cloudSources || []) if (source.kind === "collector") fail(file, `cloud source ${source.id} cannot require a Companion`);
  const cloudCount = (pack.cloudSources || []).length + (pack.sources || []).filter((source) => source.kind !== "collector").length;
  if (!cloudCount) fail(file, "must include at least one cloud-only source");
  if (pack.requiresCompanion !== true && companionIds.size && !cloudCount) fail(file, "Companion-only packs must declare requiresCompanion");
  for (const [index, mission] of (pack.missions || []).entries()) {
    if (mission.mode && !["watch", "decision", "hypothesis", "event"].includes(mission.mode)) fail(file, `mission ${index + 1} has unsupported mode`);
    if (mission.researchPolicy && !["manual", "suggest", "always"].includes(mission.researchPolicy)) fail(file, `mission ${index + 1} has unsupported researchPolicy`);
    if (mission.sprintPolicy && !["manual", "scheduled"].includes(mission.sprintPolicy)) fail(file, `mission ${index + 1} has unsupported sprintPolicy`);
  }
  const missionIds = new Set((pack.missions || []).map((mission) => mission.id));
  const routineIds = new Set();
  const actions = new Set(["refresh-sources", "wait-for-ingest", "rebuild-mission", "sync-computer", "audit-memory", "compile-context", "prepare-research", "checkpoint-memory"]);
  for (const [index, routine] of (pack.routines || []).entries()) {
    if (!routine.id || !routine.name || !Array.isArray(routine.steps) || !routine.steps.length) fail(file, `routine ${index + 1} needs id, name, and steps`);
    if (routineIds.has(routine.id)) fail(file, `duplicate routine id ${routine.id}`);
    routineIds.add(routine.id);
    if (routine.missionId && !missionIds.has(routine.missionId)) fail(file, `routine ${routine.id} references missing Mission ${routine.missionId}`);
    if (routine.trigger === "scheduled" && !(Number(routine.scheduleMinutes) >= 30)) fail(file, `scheduled routine ${routine.id} needs scheduleMinutes >= 30`);
    for (const step of routine.steps) if (!actions.has(step.action)) fail(file, `routine ${routine.id} has unsupported action ${step.action}`);
  }
  const policy = pack.evidencePolicy || {};
  if (policy.maxDiscoveryShare !== undefined && (Number(policy.maxDiscoveryShare) < 0 || Number(policy.maxDiscoveryShare) > 1)) fail(file, "evidencePolicy.maxDiscoveryShare must be between 0 and 1");
  const profile = pack.budget?.profile || "free";
  if (!["free", "cheap", "custom"].includes(profile)) fail(file, `unsupported budget profile ${profile}`);
}

const outputFiles = new Map();
const schema = await readFile(schemaUrl, "utf8");
outputFiles.set("schema.json", schema.endsWith("\n") ? schema : `${schema}\n`);
const entries = [];
const packIds = new Set();
for (const file of (await readdir(examples)).filter((name) => name.endsWith(".json")).sort()) {
  const raw = await readFile(new URL(file, examples), "utf8");
  const pack = JSON.parse(raw);
  validate(file, pack);
  if (packIds.has(pack.id)) fail(file, `duplicate pack id ${pack.id}`);
  packIds.add(pack.id);
  const publicFile = `${pack.id}.json`;
  outputFiles.set(publicFile, `${JSON.stringify(pack, null, 2)}\n`);
  const all = sources(pack);
  const cloud = all.filter((source) => source.kind !== "collector");
  entries.push({
    id: pack.id,
    version: pack.version,
    name: pack.name,
    description: pack.description,
    author: pack.author || "Community",
    category: pack.category || "Community",
    icon: pack.icon || "✦",
    featured: Boolean(pack.featured),
    requiresCompanion: Boolean(pack.companionSources?.length || pack.requiresCompanion),
    sourceCount: all.length,
    cloudSourceCount: cloud.length,
    companionSourceCount: all.length - cloud.length,
    cloudCoverage: all.length ? cloud.length / all.length : 1,
    missionCount: (pack.missions || []).length,
    memorySeedCount: (pack.memory?.entities || []).length + (pack.memory?.claims || []).length + (pack.memory?.findings || []).length + (pack.memory?.questions || []).length + (pack.memory?.expectations || []).length,
    routineCount: (pack.routines || []).length,
    budgetProfile: pack.budget?.profile || "free",
    installUrl: `/intelligence-packs/${publicFile}`,
    pack,
  });
}
const catalogContent = { schemaVersion: 3, packs: entries };
const catalog = {
  schemaVersion: catalogContent.schemaVersion,
  contentDigest: contentDigest(catalogContent),
  packs: catalogContent.packs,
};
outputFiles.set("catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);

if (checkOnly) {
  await verifyGeneratedFiles(output, outputFiles, "Published Intelligence Pack");
  console.log(`Verified ${entries.length} published Intelligence Packs.`);
} else {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [file, content] of outputFiles) await writeFile(new URL(file, output), content);
  console.log(`Synced ${entries.length} Intelligence Packs.`);
}
