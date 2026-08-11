#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Validator } from "@cfworker/json-schema";
import { build } from "esbuild";

import {
  AGENT_WEEK_PACK_PATH,
  AI_INFRASTRUCTURE_PACK_PATH,
  AI_SCIENCE_SOURCE_TITLES,
  AI_SCIENCE_SOURCE_URLS,
  CODING_AGENTS_PACK_PATH,
  FINAL_ARTIFACTS,
  FIXED_GENERATED_AT,
  FIXED_MISSION_ID,
  FIXED_RECEIPT_AT,
  FIXED_RECEIPT_ID,
  FIXED_REVIEWED_AT,
  HORMUZ_SOURCE_URLS,
  HORMUZ_SOURCE_TITLES,
  ILLUSTRATIVE_DISCLOSURE,
  LAUNCH_WORK_DIRECTORY,
  LAUNCH_DIRECTORY,
  REPOSITORY_ROOT,
  ILLUSTRATIVE_SYNTHESIS_RESULT,
  VIEWPORT,
  computeLaunchCaptureInputFingerprint,
  createLaunchFixture,
  finalAnswerPresentation,
  evidenceBundleHash,
  sha256,
  validateModelInsertManifestBinding,
} from "./build-launch-assets.mjs";
import {
  WALKTHROUGH_ACTIONS,
  WALKTHROUGH_CAPTIONS,
  WALKTHROUGH_SCROLL_SEGMENTS,
  loadApprovedModelInsertBinding,
} from "./capture-launch-assets.mjs";
import {
  WALKTHROUGH_AUDIO_CHANNELS,
  WALKTHROUGH_AUDIO_CODEC,
  WALKTHROUGH_AUDIO_LICENSE,
  WALKTHROUGH_AUDIO_ORIGIN,
  WALKTHROUGH_AUDIO_PROFILE,
  WALKTHROUGH_AUDIO_SAMPLE_RATE,
  WALKTHROUGH_AUDIO_TITLE,
  WALKTHROUGH_DURATION_SECONDS,
  WALKTHROUGH_OUTPUT_FPS,
} from "./walkthrough-contract.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);

async function loadProductionPackParser() {
  const directory = path.join(LAUNCH_WORK_DIRECTORY, "check");
  const outfile = path.join(directory, "intelligence-packs.mjs");
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [path.join(REPOSITORY_ROOT, "src", "intelligence-packs.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  const bundle = await readFile(outfile);
  return import(`${pathToFileURL(outfile).href}?sha256=${sha256(bundle)}`);
}

async function command(commandName, args) {
  return execFile(commandName, args, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, TZ: "UTC" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function pngDimensions(buffer) {
  assert.ok(buffer.length > 24, "PNG is truncated");
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR", "PNG starts with IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function pngChunkTypes(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    chunks.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function forbiddenTextChecks(label, text) {
  const patterns = [
    ["a workers.dev hostname", /workers\.dev/i],
    ["staging text", /\bstaging\b/i],
    ["a bearer capability route", /\/(?:mcp|operations-mcp|packet|pulse|capabilit(?:y|ies))(?:\/|%2f)[a-z0-9_-]{16,}/i],
    ["an authorization value", /\b(?:authorization|bearer)\s*[:=]?\s*[a-z0-9._~-]{16,}/i],
    ["an email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["a private filesystem path", /(?:\/Users\/|\/home\/[^/\s]+\/|[A-Z]:\\Users\\)/i],
    ["a validation identifier", /(?:\b(?:M|F|N)\.\d{2,3}\b|\bb\d{2,3}\b|validation[-_:][a-z0-9-]{4,})/i],
    ["a fictional example domain", /(?:https?:\/\/)?[a-z0-9.-]+\.example(?:[/:]|\b)/i],
  ];
  for (const [description, pattern] of patterns) {
    assert.doesNotMatch(text, pattern, `${label} contains ${description}`);
  }
}

function forbiddenLaunchLanguage(label, text) {
  for (const phrase of ["Sample public data", "fixed fixture", "Open evidence", "evidence items", "Story memory", "Reviewed answer", "self-contained copy"]) {
    assert.ok(!text.includes(phrase), `${label} does not expose banned launch copy: ${phrase}`);
  }
}

async function unzipText(zipPath, filename) {
  const { stdout } = await command("unzip", ["-p", zipPath, filename]);
  return stdout;
}

function npmPackFiles(stdout) {
  const report = JSON.parse(stdout);
  const candidate = Array.isArray(report)
    ? report[0]
    : Array.isArray(report?.files)
      ? report
      : Object.values(report || {}).find((entry) => Array.isArray(entry?.files));
  assert.ok(candidate && Array.isArray(candidate.files), "npm pack returned a file report");
  return candidate.files.map((entry) => entry.path);
}

function descriptionSection(markdown) {
  const match = markdown.match(/^## 90–120 word description\s*\n+([\s\S]*?)(?=\n## |$)/m)
    || markdown.match(/^## 90-120 word description\s*\n+([\s\S]*?)(?=\n## |$)/m);
  assert.ok(match, "showcase includes the 90-120 word description section");
  return match[1].replace(/\[[^\]]+\]\([^)]*\)/g, "$1").trim();
}

export function parseFfmpegMaxVolume(output) {
  const match = output.match(/max_volume:\s*(-inf|-?(?:\d+(?:\.\d*)?|\.\d+))\s*dB\b/);
  assert.ok(match, "ffmpeg volumedetect reported a finite max_volume or explicit -inf");
  if (match[1] === "-inf") return -Infinity;
  const peak = Number(match[1]);
  assert.ok(Number.isFinite(peak), `ffmpeg volumedetect reported an invalid max_volume: ${match[1]}`);
  return peak;
}

export async function resolveLaunchModelInsertBinding({ sourceProfile, persistedBinding, loadSourceBinding = loadApprovedModelInsertBinding }) {
  const normalized = validateModelInsertManifestBinding(persistedBinding);
  assert.deepEqual(persistedBinding, normalized, "public manifest keeps only the sanitized model insert binding");
  if (sourceProfile) {
    const sourceBinding = await loadSourceBinding();
    assert.deepEqual(sourceBinding.manifestBinding, normalized, "source checkout model insert and approval match the complete manifest");
  }
  return normalized;
}

export async function checkLaunchAssets() {
  process.env.TZ = "UTC";
  const expectedNames = new Set(FINAL_ARTIFACTS.map(([filename]) => filename));
  expectedNames.add("manifest.json");
  const buffers = new Map();
  for (const filename of expectedNames) {
    const absolutePath = path.join(LAUNCH_DIRECTORY, filename);
    const [buffer, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    assert.ok(metadata.isFile() && metadata.size > 0, `${filename} is a non-empty file`);
    buffers.set(filename, buffer);
  }
  const gitAttributes = await readFile(path.join(REPOSITORY_ROOT, ".gitattributes"), "utf8");
  const sourceBoundaryHasShowcase = gitAttributes
    .split(/\r?\n/)
    .includes("docs/CLOUDFLARE-SHOWCASE.md export-ignore");

  const launch = await createLaunchFixture();
  const { production, resultContract, canonical, bundle, receipt, run, share: expectedShare } = launch;
  const fixture = JSON.parse(buffers.get("hormuz-share.json").toString("utf8"));
  const assertProductionShare = (value) => assert.deepEqual(value, expectedShare, "illustrative Share is the production projection of the reviewed saved synthesis");
  assertProductionShare(fixture);
  assert.equal(fixture.schemaVersion, "2");
  assert.equal(fixture.publicEvidenceOnly, true);
  assert.equal(fixture.generatedAt, FIXED_GENERATED_AT);
  assert.equal(fixture.reviewedAnswer.reviewedAt, FIXED_REVIEWED_AT);
  assert.equal(fixture.title, "Has Hormuz reopened enough for the gas market to normalize?");
  assert.equal(fixture.subtitle, undefined, "public analysis does not restate its answer in a subtitle");
  assert.equal(fixture.reviewedAnswer.answer, ILLUSTRATIVE_SYNTHESIS_RESULT.summary);
  assert.equal(bundle.receiptId, FIXED_RECEIPT_ID, "the evidence bundle names the receipt that stores it");
  assert.equal(receipt.id, FIXED_RECEIPT_ID);
  assert.equal(receipt.scope_id, FIXED_MISSION_ID);
  assert.equal(bundle.generatedAt, FIXED_RECEIPT_AT);
  assert.ok(Date.parse(FIXED_RECEIPT_AT) < Date.parse(FIXED_REVIEWED_AT) && Date.parse(FIXED_REVIEWED_AT) < Date.parse(FIXED_GENERATED_AT), "receipt, review, and public Share timestamps are chronological");
  assert.deepEqual(bundle.resultContract, resultContract, "the signed evidence bundle carries the live investigate result contract");
  assert.deepEqual(resultContract, production.reasoning.reasoningResultContract("investigate", HORMUZ_SOURCE_URLS), "the fixture uses the current production result contract");
  const synthesisSchemaResult = new Validator(resultContract, "2020-12", false).validate(ILLUSTRATIVE_SYNTHESIS_RESULT);
  assert.equal(synthesisSchemaResult.valid, true, `illustrative synthesis satisfies the live result contract: ${JSON.stringify(synthesisSchemaResult.errors || [])}`);
  assert.equal(canonical.contractEnforced, true);
  assert.deepEqual(canonical.structuredResult, ILLUSTRATIVE_SYNTHESIS_RESULT, "the production ledger canonicalizes the one saved synthesis without changing it");
  assert.equal(canonical.summary, ILLUSTRATIVE_SYNTHESIS_RESULT.summary);
  assert.deepEqual(canonical.citations, ILLUSTRATIVE_SYNTHESIS_RESULT.citations);
  assert.equal(canonical.confidence, ILLUSTRATIVE_SYNTHESIS_RESULT.confidence);
  assert.equal(run.structured_result_json, JSON.stringify(canonical.structuredResult));
  assert.equal(fixture.reviewedAnswer.evidenceSnapshotHash, receipt.bundle_hash);
  assert.equal(receipt.bundle_hash, evidenceBundleHash(bundle));
  assert.notEqual(
    evidenceBundleHash({ ...bundle, evidence: bundle.evidence.map((item, index) => index ? item : { ...item, excerpt: `${item.excerpt} Changed.` }) }),
    fixture.reviewedAnswer.evidenceSnapshotHash,
    "the snapshot hash changes when the public evidence content changes",
  );
  assert.deepEqual(fixture.stories.flatMap((item) => item.evidence.map((evidence) => evidence.url)), HORMUZ_SOURCE_URLS);
  assert.deepEqual(fixture.stories.flatMap((item) => item.evidence.map((evidence) => evidence.title)), HORMUZ_SOURCE_TITLES, "Hormuz source metadata uses exact publisher titles");
  assert.deepEqual(HORMUZ_SOURCE_URLS.map((sourceUrl) => new URL(sourceUrl).hostname), ["www.iea.org", "www.eia.gov", "www.eia.gov"]);
  assert.deepEqual(AI_SCIENCE_SOURCE_TITLES, [
    "Accelerating scientific discovery with Co-Scientist",
    "A multi-agent system for automating scientific discovery",
  ], "AI-science fixtures use exact Nature titles");
  assert.equal(fixture.reviewedAnswer.keyJudgments.length, 3, "public synthesis carries the saved causal evidence claims");
  assert.deepEqual(fixture.reviewedAnswer.keyJudgments.map((judgment) => judgment.citationUrls), [
    [HORMUZ_SOURCE_URLS[0]],
    [HORMUZ_SOURCE_URLS[1]],
    [HORMUZ_SOURCE_URLS[0]],
  ], "public synthesis claim citations stay within the Hormuz source allowlist");
  assert.equal(fixture.reviewedAnswer.signposts.length, 2, "public synthesis carries the saved observable recovery signals");
  assert.deepEqual(fixture.reviewedAnswer.alternativeCase, ILLUSTRATIVE_SYNTHESIS_RESULT.strongestContraryCase, "public projection retains the contrary-case citation");
  assert.deepEqual(fixture.reviewedAnswer.signposts, ILLUSTRATIVE_SYNTHESIS_RESULT.watchFor, "public projection retains the watch-signal citations");
  assert.equal(fixture.reviewedAnswer.whatWouldChange, undefined, "public synthesis does not restate its recovery signals in a second reversal field");
  assert.equal(fixture.reviewedAnswer.whatToWatch, undefined, "public synthesis does not repeat its signposts in a second watch field");
  assert.equal(fixture.reviewedAnswer.whyItMatters, undefined, "public synthesis does not add a hand-authored significance block");
  assert.equal(fixture.reviewedAnswer.outlook, undefined, "public synthesis does not add a hand-authored outlook block");
  assert.equal(fixture.reviewedAnswer.uncertainty, undefined, "public synthesis does not add a hand-authored caveat block");

  const invalidCitation = structuredClone(ILLUSTRATIVE_SYNTHESIS_RESULT);
  invalidCitation.strongestEvidence[0].citationUrl = "https://invalid.example/source";
  invalidCitation.citations[0] = "https://invalid.example/source";
  assert.throws(
    () => production.reasoningLedger.canonicalizeReasoningResult({ resultContract }, { structuredResult: invalidCitation }, invalidCitation.summary),
    /does not match its receipt contract/,
    "the production canonicalizer rejects citation substitution",
  );
  const missingSummary = structuredClone(ILLUSTRATIVE_SYNTHESIS_RESULT);
  delete missingSummary.summary;
  assert.throws(
    () => production.reasoningLedger.canonicalizeReasoningResult({ resultContract }, { structuredResult: missingSummary }, "substituted response"),
    /does not match its receipt contract/,
    "the production canonicalizer rejects incomplete direct substitution",
  );
  const changedEvidence = structuredClone(bundle);
  changedEvidence.evidence[0].excerpt += " Changed.";
  assert.equal(await production.shares.projectReviewedAnswerForShare({ kind: "mission", id: FIXED_MISSION_ID, run, receipt, bundle: changedEvidence }), null, "Share projection rejects evidence changed after the receipt hash was fixed");
  const privateEvidence = structuredClone(bundle);
  privateEvidence.evidence[0].accessClass = "authenticated-local";
  privateEvidence.coverage.localEvidenceCount = 1;
  const privateReceipt = { ...receipt, bundle_hash: evidenceBundleHash(privateEvidence) };
  assert.equal(await production.shares.projectReviewedAnswerForShare({ kind: "mission", id: FIXED_MISSION_ID, run, receipt: privateReceipt, bundle: privateEvidence }), null, "Share projection rejects private evidence even under a matching hash");
  assert.equal(await production.shares.projectReviewedAnswerForShare({ kind: "mission", id: FIXED_MISSION_ID, run, receipt: { ...receipt, bundle_hash: "0".repeat(64) }, bundle }), null, "Share projection rejects a substituted receipt hash");
  const directlySubstitutedShare = structuredClone(expectedShare);
  directlySubstitutedShare.reviewedAnswer.answer = "Directly substituted launch copy";
  assert.throws(() => assertProductionShare(directlySubstitutedShare), /illustrative Share is the production projection/, "the exact-projection check catches hand-authored answer substitution");

  const { dropCapsule, publicSharePage, sharePrivacy } = production;
  const synthesis = finalAnswerPresentation(launch);
  assert.equal(synthesis.answerMode, "synthesis");
  assert.ok(synthesis.thesis.text.length >= 180, "finished analysis opens with a substantial answer");
  assert.equal(synthesis.keyJudgments.length, 3, "finished analysis carries three causal judgments");
  assert.ok(synthesis.keyJudgments.every((judgment) => judgment.title && judgment.text.length >= 100 && /\d/.test(judgment.text) && judgment.citationUrls.length), "each causal judgment adds sourced substance without padding");
  assert.match(synthesis.keyJudgments[0].text, /35 bcm[\s\S]*27 bcm[\s\S]*4%/, "replacement judgment owns the supply-balance figures");
  assert.match(synthesis.keyJudgments[1].text, /17%/, "damage judgment owns the lost-capacity figure");
  assert.doesNotMatch(synthesis.keyJudgments[1].text, /140 bcm/, "EIA-backed damage judgment does not pool the IEA cumulative estimate");
  assert.match(synthesis.keyJudgments[2].text, /140 bcm/, "market-adjustment judgment distinguishes prices from the cumulative physical loss");
  assert.ok(synthesis.competingExplanation?.text.length >= 180, "finished analysis includes a developed competing case");
  assert.equal(synthesis.watchFor.length, 2, "finished analysis includes two concrete reversal signals");
  assert.ok((JSON.stringify(synthesis).match(/\b(?:35|27|4|140|17|2\.1|50|10)\b/g) || []).length >= 8, "finished analysis carries the decisive quantitative facts");
  assert.equal(synthesis.evidence.boundary, "Sources current through July 7, 2026; flow comparisons cover March through June.");
  assert.deepEqual(JSON.parse(JSON.stringify(sharePrivacy.requirePublicSharePayload(fixture))), fixture, "fixture passes the production Share validator before rendering");
  const expectedCard = publicSharePage.renderPublicSharePage({
    payload: fixture,
    publicIndexing: true,
    dropUrl: "hormuz-analysis.zip",
    ogImageUrl: "04-public-card.png",
    presentation: {
      watchLabel: "Signals to watch",
      downloadLabel: "Download the brief",
      disclosure: ILLUSTRATIVE_DISCLOSURE,
    },
  });
  assert.equal(buffers.get("hormuz-analysis.html").toString("utf8"), expectedCard, "public analysis is an exact production-renderer export");
  assert.match(expectedCard, /<meta property="og:image" content="04-public-card\.png">/);
  assert.match(expectedCard, /<meta name="twitter:image" content="04-public-card\.png">/);
  assert.match(expectedCard, /href="hormuz-analysis\.zip"/);
  assert.match(expectedCard, />\[1\]<\/a>/, "public card renders the IEA claim citation");
  assert.match(expectedCard, />\[2\]<\/a>/, "public card renders the EIA claim citation");
  for (const phrase of [ILLUSTRATIVE_DISCLOSURE, "Bottom line", "Why this is happening", "Alternative case", "Signals to watch", "Download the brief", "Sources"]) {
    assert.match(expectedCard, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `public card includes ${phrase}`);
  }
  assert.equal((expectedCard.match(/Illustrative example · public sources/g) || []).length, 1, "public card has one illustrative disclosure");
  assert.equal((expectedCard.match(/Hormuz traffic is recovering, but LNG supply has not normalized/g) || []).length, 1, "public card states its answer once");
  assert.match(expectedCard, /<span class="date">As of July 7, 2026 at 2:00 PM<\/span>/, "illustrative card renders the evidence-date timestamp");
  forbiddenLaunchLanguage("public card", expectedCard);

  const expectedDrop = Buffer.from(dropCapsule.buildDropCapsule(fixture, {
    publicIndexing: true,
    presentation: { watchLabel: "Signals to watch", disclosure: ILLUSTRATIVE_DISCLOSURE },
  }));
  assert.deepEqual(buffers.get("hormuz-analysis.zip"), expectedDrop, "portable analysis is byte-deterministic from the Share fixture");
  const zipPath = path.join(LAUNCH_DIRECTORY, "hormuz-analysis.zip");
  await command("unzip", ["-t", zipPath]);
  const { stdout: zipList } = await command("unzip", ["-Z1", zipPath]);
  const zipEntries = zipList.trim().split(/\r?\n/);
  const expectedZipEntries = ["index.html", "data.json", "evidence.md", "driftglass-pack.json", "manifest.webmanifest", "driftglass.svg", "favicon.ico", "llms.txt", "robots.txt", "README.md"];
  assert.deepEqual(zipEntries, expectedZipEntries, "Drop contains exactly the ten expected members in deterministic order");
  const recipient = JSON.parse(await unzipText(zipPath, "data.json"));
  assert.equal(recipient.format, "driftglass.shared-intelligence.v1");
  assert.equal(recipient.publicEvidenceOnly, true);
  const fork = JSON.parse(await unzipText(zipPath, "driftglass-pack.json"));
  assert.equal(fork.driftglassPack, "3");
  assert.equal(fork.requiresCompanion, false);
  assert.deepEqual(fork.companionSources, []);
  assert.deepEqual(fork.cloudSources.map((source) => source.config.url), HORMUZ_SOURCE_URLS, "forked Pack sources stay within the fixture URL allowlist");
  for (const source of fork.cloudSources) assert.ok(HORMUZ_SOURCE_URLS.includes(source.config.url), `fork source ${source.id} is allow-listed`);
  const packSchema = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "intelligence-packs", "schema.json"), "utf8"));
  const iconMaxLength = packSchema.properties.icon.maxLength;
  assert.ok(typeof fork.icon === "string" && fork.icon.length <= iconMaxLength && [...fork.icon].length <= iconMaxLength, "fork icon fits the current Pack schema without code-unit or code-point truncation");
  const schemaResult = new Validator(packSchema, "2020-12", false).validate(fork);
  assert.equal(schemaResult.valid, true, `generated fork satisfies the complete Pack v3 schema: ${JSON.stringify(schemaResult.errors || [])}`);
  const { parseIntelligencePack } = await loadProductionPackParser();
  const parsedFork = parseIntelligencePack(fork);
  for (const key of ["driftglassPack", "id", "version", "name", "description", "author", "category", "icon", "featured", "requiresCompanion"]) {
    assert.deepEqual(parsedFork[key], fork[key], `generated fork parser preserves identity field ${key}`);
  }
  for (const [index, source] of fork.cloudSources.entries()) {
    const parsedSource = parsedFork.cloudSources[index];
    assert.ok(parsedSource, `generated fork parser preserves source ${source.id}`);
    for (const key of Object.keys(source)) assert.deepEqual(parsedSource[key], source[key], `generated fork parser preserves source ${source.id}.${key}`);
  }
  assert.equal(new Set(fork.cloudSources.map((source) => source.id)).size, fork.cloudSources.length, "generated fork source IDs are unique");
  for (const source of fork.cloudSources) assert.ok(source.id.length <= 80, `generated fork source ID ${source.id} stays within 80 characters`);
  for (const [index, mission] of fork.missions.entries()) {
    const parsedMission = parsedFork.missions[index];
    assert.ok(parsedMission, `generated fork parser preserves Mission ${mission.id}`);
    for (const key of Object.keys(mission)) assert.deepEqual(parsedMission[key], mission[key], `generated fork parser preserves Mission ${mission.id}.${key}`);
  }
  for (const [index, routine] of fork.routines.entries()) {
    const parsedRoutine = parsedFork.routines[index];
    assert.ok(parsedRoutine, `generated fork parser preserves routine ${routine.id}`);
    for (const key of Object.keys(routine).filter((key) => key !== "steps")) assert.deepEqual(parsedRoutine[key], routine[key], `generated fork parser preserves routine ${routine.id}.${key}`);
    for (const [stepIndex, step] of routine.steps.entries()) {
      const parsedStep = parsedRoutine.steps[stepIndex];
      assert.ok(parsedStep, `generated fork parser preserves routine step ${step.id}`);
      for (const key of Object.keys(step)) assert.deepEqual(parsedStep[key], step[key], `generated fork parser preserves routine step ${step.id}.${key}`);
    }
  }
  assert.deepEqual(parsedFork.cloudSources.map((source) => source.config.url), HORMUZ_SOURCE_URLS, "parsed fork preserves its exact public source lanes");
  assert.equal(fork.missions[0]?.question, fixture.title, "forked Mission keeps a question headline intact");
  const forkObjective = fork.routines[0]?.steps.find((step) => step.id === "prepare")?.args?.objective;
  const forkMemoryQuestion = fork.memory?.questions?.[0]?.title;
  for (const value of [fork.missions[0]?.question, forkObjective, forkMemoryQuestion]) {
    assert.equal(typeof value, "string");
    assert.doesNotMatch(value, /\?\?|\?\.|[?!.]”[?!.]/u, "forked Pack prompts contain no duplicated terminal punctuation");
  }
  for (const term of ["hormuz", "lng", "qatar", "uae", "loadings", "production", "strait", "capacity", "liquefaction"]) {
    assert.ok(fork.interestTerms.includes(term), `forked Pack retains topic term ${term}`);
  }
  for (const term of ["the", "and", "but", "for", "between", "enough", "elsewhere", "fell", "added", "changed", "faster", "bcm", "bcm."]) {
    assert.ok(!fork.interestTerms.includes(term), `forked Pack excludes low-information term ${term}`);
  }
  const dropIndex = await unzipText(zipPath, "index.html");
  assert.match(dropIndex, /Continue in Driftglass/);
  assert.equal((dropIndex.match(/Illustrative example · public sources/g) || []).length, 1, "portable analysis has one illustrative disclosure");
  for (const phrase of ["Bottom line", "Why this is happening", "Alternative case", "Signals to watch", "Sources"]) assert.ok(dropIndex.includes(phrase), `Drop page includes ${phrase}`);
  assert.equal(await unzipText(zipPath, "robots.txt"), "User-agent: *\nAllow: /\n");

  for (const filename of ["01-today.png", "02-mission-computer.png", "03-final-answer.png", "04-public-card.png"]) {
    const buffer = buffers.get(filename);
    assert.deepEqual(pngDimensions(buffer), VIEWPORT, `${filename} uses the required viewport`);
    const chunks = pngChunkTypes(buffer);
    assert.deepEqual(chunks[0], "IHDR");
    assert.deepEqual(chunks.at(-1), "IEND");
    assert.ok(!chunks.some((type) => ["tEXt", "zTXt", "iTXt", "eXIf"].includes(type)), `${filename} carries no text or EXIF metadata`);
  }

  const architecture = buffers.get("architecture.svg").toString("utf8");
  assert.match(architecture, /width="1600" height="1000" viewBox="0 0 1600 1000"/);
  assert.match(architecture, /M520 400V438H250V480/, "Worker routes through Queue before the D1 index");
  assert.doesNotMatch(architecture, /M630 400V468/, "architecture has no direct Worker-to-D1 bypass");
  for (const phrase of ["Worker + Budget Governor", "D1", "MISSION ID → MISSIONCOMPUTER DURABLE OBJECT", "YOUR MODEL", "ChatGPT, Claude, Grok, or another model", "OPTIONAL COMPANION", "OPTIONAL POWER MODE", "AI Search and Agent Memory"]) {
    assert.match(architecture, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `architecture names ${phrase}`);
  }
  assert.equal(WALKTHROUGH_CAPTIONS.length, 8, "walkthrough carries a concise caption sequence");
  assert.ok(WALKTHROUGH_CAPTIONS.every((caption) => caption.start >= 0 && caption.end <= WALKTHROUGH_DURATION_SECONDS && caption.end > caption.start), "walkthrough captions have bounded timing");
  assert.ok(WALKTHROUGH_CAPTIONS.every((caption) => caption.text.trim().split(/\s+/).length <= 8), "walkthrough captions use eight words or fewer");
  assert.equal(new Set(WALKTHROUGH_CAPTIONS.map((caption) => caption.text)).size, WALKTHROUGH_CAPTIONS.length, "walkthrough captions do not repeat themselves");
  assert.doesNotMatch(WALKTHROUGH_CAPTIONS.map((caption) => caption.text).join(" "), /\b(?:demo|sample|receipt|audit|evidence quality|memory patch)\b/i, "walkthrough captions stay in human terms");
  for (let index = 0; index < WALKTHROUGH_CAPTIONS.length; index += 1) {
    const caption = WALKTHROUGH_CAPTIONS[index];
    assert.ok(caption.end - caption.start >= 1.5, `walkthrough caption ${index + 1} stays readable`);
    if (index) assert.ok(caption.start >= WALKTHROUGH_CAPTIONS[index - 1].end, "walkthrough captions are ordered and non-overlapping");
  }
  assert.ok(WALKTHROUGH_ACTIONS.length >= 12, "walkthrough has continuous visible interaction");
  assert.ok(WALKTHROUGH_ACTIONS.every((entry, index) => entry.at >= 0 && entry.at < WALKTHROUGH_DURATION_SECONDS && (!index || entry.at > WALKTHROUGH_ACTIONS[index - 1].at)), "walkthrough actions are unique and chronological");
  for (const action of ["preview-ai-science", "close-ai-science", "open-story", "open-missions", "open-mission-workspace", "open-current-answer", "open-history", "open-normalization-signals", "show-model-answer", "open-saved-answer", "scroll-causes", "scroll-alternative-signals", "open-sources", "return-to-bottom-line"]) {
    assert.ok(WALKTHROUGH_ACTIONS.some((entry) => entry.action === action), `walkthrough includes ${action}`);
  }
  assert.ok(!WALKTHROUGH_ACTIONS.some((entry) => entry.action === "scroll-story-sources"), "the shallow opening Story does not waste time scrolling");
  assert.ok(WALKTHROUGH_SCROLL_SEGMENTS.every((segment, index) => segment.start >= 0 && segment.end <= WALKTHROUGH_DURATION_SECONDS && segment.end > segment.start && segment.end - segment.start <= 1 && (!index || segment.start >= WALKTHROUGH_SCROLL_SEGMENTS[index - 1].end)), "every walkthrough scroll is a distinct burst of one second or less");
  assert.equal(ILLUSTRATIVE_DISCLOSURE, "Illustrative example · public sources");

  const videoPath = path.join(LAUNCH_DIRECTORY, "walkthrough.mp4");
  const { stdout: probeRaw } = await command("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:format_tags:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,duration",
    "-of", "json", videoPath,
  ]);
  const probe = JSON.parse(probeRaw);
  const video = probe.streams.find((stream) => stream.codec_name === "h264");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.ok(video, "walkthrough contains an H.264 video stream");
  assert.equal(probe.streams.length, 2, "walkthrough contains one video stream and one music stream");
  assert.ok(audio, "walkthrough contains its original background score");
  assert.equal(video.width, VIEWPORT.width);
  assert.equal(video.height, VIEWPORT.height);
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.r_frame_rate, `${WALKTHROUGH_OUTPUT_FPS}/1`);
  assert.equal(audio.codec_name, WALKTHROUGH_AUDIO_CODEC);
  assert.equal(audio.profile, WALKTHROUGH_AUDIO_PROFILE);
  assert.equal(Number(audio.sample_rate), WALKTHROUGH_AUDIO_SAMPLE_RATE);
  assert.equal(audio.channels, WALKTHROUGH_AUDIO_CHANNELS);
  const duration = Number(probe.format.duration);
  assert.ok(Math.abs(duration - WALKTHROUGH_DURATION_SECONDS) <= 0.05, `walkthrough duration ${duration} is ${WALKTHROUGH_DURATION_SECONDS} seconds`);
  assert.ok(!Number.isFinite(Number(audio.duration)) || Math.abs(Number(audio.duration) - duration) <= 1 / WALKTHROUGH_OUTPUT_FPS + 0.01, "walkthrough music ends with the video");
  assert.equal(probe.format.tags?.title, "Driftglass 0.9.0 walkthrough");
  forbiddenTextChecks("MP4 metadata", JSON.stringify(probe.format.tags || {}));
  const { stderr: blackDetect } = await command("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", videoPath, "-vf", "blackdetect=d=0.08:pix_th=0.10", "-an", "-f", "null", "-"]);
  assert.doesNotMatch(blackDetect, /black_start:/, "walkthrough has no fade-to-black or dead black interval");
  const { stderr: freezeDetect } = await command("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", videoPath, "-vf", "freezedetect=n=-50dB:d=2.85", "-an", "-f", "null", "-"]);
  const freezeDurations = [...freezeDetect.matchAll(/freeze_duration:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  assert.ok(freezeDurations.every((value) => value <= 2.85), `walkthrough has no low-motion reading beat longer than 2.85 seconds (${Math.max(0, ...freezeDurations)}s found)`);
  const { stdout: frameHashesRaw } = await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-an", "-vf", "fps=2,scale=160:100:flags=area,format=gray", "-f", "framemd5", "-"]);
  const frameHashes = frameHashesRaw.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1).trim());
  assert.ok(frameHashes.length >= WALKTHROUGH_DURATION_SECONDS * 2 - 1, "motion audit samples the complete walkthrough");
  assert.ok(new Set(frameHashes).size / frameHashes.length >= 0.8, "walkthrough changes visually through most of its shorter duration");
  let longestStableRun = 1;
  let currentStableRun = 1;
  for (let index = 1; index < frameHashes.length; index += 1) {
    currentStableRun = frameHashes[index] === frameHashes[index - 1] ? currentStableRun + 1 : 1;
    longestStableRun = Math.max(longestStableRun, currentStableRun);
  }
  assert.ok(longestStableRun <= 6, `walkthrough has no exact reading hold longer than 3 seconds (${longestStableRun / 2}s found)`);

  const { stderr: loudnessRaw } = await command("ffmpeg", ["-hide_banner", "-nostats", "-i", videoPath, "-map", "0:a:0", "-af", "loudnorm=I=-22:TP=-3.5:LRA=6:print_format=json", "-f", "null", "-"]);
  const integrated = Number(loudnessRaw.match(/"input_i"\s*:\s*"(-?[0-9.]+)"/)?.[1]);
  const truePeak = Number(loudnessRaw.match(/"input_tp"\s*:\s*"(-?[0-9.]+)"/)?.[1]);
  assert.ok(Number.isFinite(integrated) && integrated >= -23.5 && integrated <= -20.5, `walkthrough music stays in the background (${integrated} LUFS)`);
  assert.ok(Number.isFinite(truePeak) && truePeak <= -3, `walkthrough music has safe peak headroom (${truePeak} dBTP)`);

  for (const [label, start] of [["opening", 0], ["ending", WALKTHROUGH_DURATION_SECONDS - 0.05]]) {
    const { stderr: edgeVolumeRaw } = await command("ffmpeg", ["-hide_banner", "-nostats", "-ss", String(start), "-t", "0.05", "-i", videoPath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
    const peak = parseFfmpegMaxVolume(edgeVolumeRaw);
    assert.ok(peak <= -26, `walkthrough music has a quiet ${label} boundary (${peak} dBFS)`);
  }

  const manifest = JSON.parse(buffers.get("manifest.json").toString("utf8"));
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "buildVersion", "status", "captureFingerprint", "modelInsert", "illustrative", "artifacts"], "public manifest stays compact");
  assert.equal(manifest.schemaVersion, "2");
  assert.equal(manifest.buildVersion, "0.9.0-launch.4");
  assert.equal(manifest.status, "complete");
  assert.match(manifest.captureFingerprint, /^[a-f0-9]{64}$/, "complete manifest records one opaque capture-input fingerprint");
  const modelInsert = await resolveLaunchModelInsertBinding({ sourceProfile: sourceBoundaryHasShowcase, persistedBinding: manifest.modelInsert });
  const expectedCaptureFingerprint = await computeLaunchCaptureInputFingerprint({
    modelInsertBinding: modelInsert,
  });
  assert.equal(manifest.captureFingerprint, expectedCaptureFingerprint, "launch capture matches the current transitive render inputs and approved model insert");
  assert.deepEqual(manifest.illustrative, {
    classification: ILLUSTRATIVE_DISCLOSURE,
    publicSourcesAsOf: "2026-07-07",
    sourceUrls: [...HORMUZ_SOURCE_URLS, ...AI_SCIENCE_SOURCE_URLS],
  });
  const privateManifestKeys = ["source" + "BaseRevision", "source" + "BaseRole", "generation" + "Provenance", "publication" + "Links"];
  for (const key of privateManifestKeys) assert.ok(!(key in manifest), `public manifest excludes private field ${key}`);
  assert.doesNotMatch(JSON.stringify(manifest), /\b(?:demo|sample)\b/i, "public manifest exposes no launch-planning narration");
  assert.equal(manifest.artifacts.length, FINAL_ARTIFACTS.length);
  for (const [filename, mediaType] of FINAL_ARTIFACTS) {
    const entry = manifest.artifacts.find((candidate) => candidate.path === filename);
    assert.ok(entry, `manifest records ${filename}`);
    assert.equal(entry.mediaType, mediaType);
    assert.equal(entry.sha256, sha256(buffers.get(filename)), `${filename} hash matches manifest`);
    assert.equal(entry.bytes, buffers.get(filename).length, `${filename} size matches manifest`);
    if (mediaType === "image/png") assert.deepEqual({ width: entry.width, height: entry.height }, pngDimensions(buffers.get(filename)), `${filename} dimensions match manifest`);
    if (mediaType === "video/mp4") {
      assert.equal(entry.width, video.width, "video width matches manifest");
      assert.equal(entry.height, video.height, "video height matches manifest");
      assert.equal(entry.codec, video.codec_name, "video codec matches manifest");
      assert.equal(entry.pixelFormat, video.pix_fmt, "video pixel format matches manifest");
      assert.equal(entry.durationSeconds, duration, "video duration matches manifest");
      assert.equal(entry.frameRate, WALKTHROUGH_OUTPUT_FPS, "video frame rate matches manifest");
      assert.equal(entry.audioCodec, audio.codec_name, "music codec matches manifest");
      assert.equal(entry.audioProfile, audio.profile, "music profile matches manifest");
      assert.equal(entry.audioSampleRate, Number(audio.sample_rate), "music sample rate matches manifest");
      assert.equal(entry.audioChannels, audio.channels, "music channels match manifest");
      assert.equal(entry.audioTitle, WALKTHROUGH_AUDIO_TITLE, "manifest names the original score");
      assert.equal(entry.audioSource, WALKTHROUGH_AUDIO_ORIGIN, "manifest records an original score");
      assert.equal(entry.audioLicense, WALKTHROUGH_AUDIO_LICENSE, "manifest records the score license");
    }
  }
  const referencePaths = [AI_INFRASTRUCTURE_PACK_PATH, CODING_AGENTS_PACK_PATH, AGENT_WEEK_PACK_PATH];
  for (const referencePath of referencePaths) {
    const packBuffer = await readFile(path.join(REPOSITORY_ROOT, referencePath));
    assert.match(sha256(packBuffer), /^[a-f0-9]{64}$/, `${referencePath} hashes directly`);
    const canonicalPack = JSON.parse(packBuffer.toString("utf8"));
    assert.equal(canonicalPack.driftglassPack, "3", `${referencePath} is a current Pack`);
  }
  assert.equal(JSON.parse((await readFile(path.join(REPOSITORY_ROOT, AGENT_WEEK_PACK_PATH))).toString("utf8")).id, "cloudflare-agent-week");

  const textArtifacts = [
    ["hormuz-share.json", buffers.get("hormuz-share.json").toString("utf8")],
    ["hormuz-analysis.html", expectedCard],
    ["architecture.svg", architecture],
    ["manifest.json", buffers.get("manifest.json").toString("utf8")],
    ...await Promise.all(zipEntries.filter((filename) => /\.(?:html|json|md|txt|webmanifest|svg)$/i.test(filename)).map(async (filename) => [`hormuz-analysis.zip:${filename}`, await unzipText(zipPath, filename)])),
  ];
  for (const [label, text] of textArtifacts) forbiddenTextChecks(label, text);
  for (const [label, text] of textArtifacts.filter(([name]) => !name.endsWith("manifest.json"))) {
    assert.doesNotMatch(text, /California public fleet|parallel agents|announced data-center capacity|grid access is now/i, `${label} does not retain a rejected launch theme`);
  }

  const npmIgnore = await readFile(path.join(REPOSITORY_ROOT, ".npmignore"), "utf8");
  assert.ok(npmIgnore.split(/\r?\n/).includes("/docs/assets/launch/"), "npm package explicitly excludes launch media");
  const { stdout: npmPackRaw } = await command("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  assert.ok(!npmPackFiles(npmPackRaw).some((filename) => filename === "docs/assets/launch" || filename.startsWith("docs/assets/launch/")), "npm package excludes the repository launch kit");

  await command(process.execPath, ["scripts/sync-intelligence-packs.mjs", "--check"]);
  if (sourceBoundaryHasShowcase) {
    const showcase = await readFile(path.join(REPOSITORY_ROOT, "docs", "CLOUDFLARE-SHOWCASE.md"), "utf8");
    const descriptionWords = descriptionSection(showcase).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
    assert.ok(descriptionWords.length >= 90 && descriptionWords.length <= 120, `showcase description has ${descriptionWords.length} words`);
    assert.doesNotMatch(showcase, /## Publication links|Verification boundary|Publication-gated/i, "showcase stays on the product instead of release auditing");
  }

  process.stdout.write(`Launch assets verified: ${FINAL_ARTIFACTS.length} artifacts, ${duration.toFixed(1)}s H.264 walkthrough, two source-backed themes, rich synthesis and Share paths, current Drop/Pack schemas, and npm exclusion.\n`);
  return { artifactCount: FINAL_ARTIFACTS.length, durationSeconds: duration };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await checkLaunchAssets();
}
