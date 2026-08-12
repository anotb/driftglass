import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { contentDigest, verifyGeneratedFiles } from "./generated-assets.mjs";

const examples = new URL("../lenses/examples/", import.meta.url);
const output = new URL("../public/lenses/", import.meta.url);
const checkOnly = process.argv.includes("--check");
const allowedKinds = new Set([
  "hackernews", "lobsters", "bluesky", "arxiv", "openalex", "github_releases", "github_activity",
  "npm_releases", "pypi_releases", "web", "web_feed", "collector", "manual", "email",
]);

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function validate(file, lens) {
  if (!lens || typeof lens !== "object") fail(file, "must contain an object");
  if (lens.driftglassLens !== "1") fail(file, "driftglassLens must be \"1\"");
  for (const key of ["id", "name", "description"]) if (!String(lens[key] || "").trim()) fail(file, `${key} is required`);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(lens.id)) fail(file, "id must be a lowercase slug");
  if (!Array.isArray(lens.sources) || lens.sources.length === 0) fail(file, "sources must be non-empty");
  const ids = new Set();
  for (const [index, source] of lens.sources.entries()) {
    if (!source || typeof source !== "object") fail(file, `sources[${index}] must be an object`);
    for (const key of ["id", "name", "kind"]) if (!String(source[key] || "").trim()) fail(file, `sources[${index}].${key} is required`);
    if (ids.has(source.id)) fail(file, `duplicate source id ${source.id}`);
    ids.add(source.id);
    if (!allowedKinds.has(source.kind)) fail(file, `unsupported source kind ${source.kind}`);
    if (!source.config || typeof source.config !== "object" || Array.isArray(source.config)) fail(file, `sources[${index}].config must be an object`);
    const schedule = Number(source.scheduleMinutes);
    const weight = Number(source.weight);
    if (!Number.isFinite(schedule) || schedule < 15 || schedule > 10080) fail(file, `sources[${index}].scheduleMinutes is out of range`);
    if (!Number.isFinite(weight) || weight < 0.1 || weight > 3) fail(file, `sources[${index}].weight is out of range`);
  }
  const missionIds = new Set();
  for (const [index, mission] of (lens.missions || []).entries()) {
    if (!mission || typeof mission !== "object" || !String(mission.id || "").trim() || !String(mission.name || "").trim()) fail(file, `missions[${index}] needs id and name`);
    if (missionIds.has(mission.id)) fail(file, `duplicate mission id ${mission.id}`);
    missionIds.add(mission.id);
  }
}

const outputFiles = new Map();
const schema = await readFile(new URL("../lenses/schema.json", import.meta.url), "utf8");
outputFiles.set("schema.json", schema.endsWith("\n") ? schema : `${schema}\n`);
const entries = [];
for (const file of (await readdir(examples)).filter((name) => name.endsWith(".json")).sort()) {
  const raw = await readFile(new URL(file, examples), "utf8");
  const lens = JSON.parse(raw);
  validate(file, lens);
  const publicFile = `${lens.id}.json`;
  outputFiles.set(publicFile, `${JSON.stringify(lens, null, 2)}\n`);
  entries.push({
    id: lens.id,
    name: lens.name,
    description: lens.description,
    author: lens.author || "Community",
    category: lens.category || "Community",
    icon: lens.icon || "✦",
    featured: Boolean(lens.featured),
    requiresCompanion: Boolean(lens.requiresCompanion),
    sourceCount: lens.sources.length,
    missionCount: Array.isArray(lens.missions) ? lens.missions.length : 0,
    installUrl: `/lenses/${publicFile}`,
    lens,
  });
}
const catalogContent = { schemaVersion: 1, lenses: entries };
const catalog = {
  schemaVersion: catalogContent.schemaVersion,
  contentDigest: contentDigest(catalogContent),
  lenses: catalogContent.lenses,
};
outputFiles.set("catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);

if (checkOnly) {
  await verifyGeneratedFiles(output, outputFiles, "Published Lens");
  console.log(`Verified ${entries.length} published community Lenses.`);
} else {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [file, content] of outputFiles) await writeFile(new URL(file, output), content);
  console.log(`Synced ${entries.length} community Lenses.`);
}
