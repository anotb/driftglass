#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import {
  WALKTHROUGH_AUDIO_CHANNELS,
  WALKTHROUGH_AUDIO_CODEC,
  WALKTHROUGH_AUDIO_LICENSE,
  WALKTHROUGH_AUDIO_ORIGIN,
  WALKTHROUGH_AUDIO_PROFILE,
  WALKTHROUGH_AUDIO_SAMPLE_RATE,
  WALKTHROUGH_AUDIO_TITLE,
  WALKTHROUGH_DURATION_SECONDS,
  WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS,
  WALKTHROUGH_OUTPUT_FPS,
} from "./walkthrough-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = path.resolve(path.dirname(scriptPath), "..");
export const LAUNCH_DIRECTORY = path.join(REPOSITORY_ROOT, "docs", "assets", "launch");
export const LAUNCH_WORK_DIRECTORY = path.join(REPOSITORY_ROOT, "output", "launch-assets");
export const FIXED_RECEIPT_AT = "2026-07-07T12:00:00.000Z";
export const FIXED_GENERATED_AT = "2026-07-07T14:00:00.000Z";
export const FIXED_REVIEWED_AT = "2026-07-07T13:00:00.000Z";
export const FIXED_MISSION_ID = "launch-hormuz-gas-normalization";
export const FIXED_RECEIPT_ID = "launch-hormuz-share-receipt";
export const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
export const ILLUSTRATIVE_DISCLOSURE = "Illustrative example · public sources";
export const AGENT_WEEK_PACK_PATH = "intelligence-packs/examples/cloudflare-agent-week.json";
export const AI_INFRASTRUCTURE_PACK_PATH = "intelligence-packs/examples/ai-infrastructure-power.json";
export const CODING_AGENTS_PACK_PATH = "intelligence-packs/examples/coding-agents.json";
export const HORMUZ_SOURCE_URLS = Object.freeze([
  "https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary",
  "https://www.eia.gov/todayinenergy/detail.php?id=67484",
  "https://www.eia.gov/international/content/analysis/special_topics/World_Oil_Transit_Chokepoints/",
]);
export const HORMUZ_SOURCE_TITLES = Object.freeze([
  "Gas Market Report, Q3-2026",
  "U.S. natural gas exports to grow nearly 30% by 2027 as LNG facilities ramp up",
  "World Oil Transit Chokepoints",
]);
export const AI_SCIENCE_SOURCE_URLS = Object.freeze([
  "https://www.nature.com/articles/s41586-026-10644-y",
  "https://www.nature.com/articles/s41586-026-10652-y",
]);
export const AI_SCIENCE_SOURCE_TITLES = Object.freeze([
  "Accelerating scientific discovery with Co-Scientist",
  "A multi-agent system for automating scientific discovery",
]);

const PRODUCTION_BUNDLE_DEFINITIONS = Object.freeze([
  { key: "dropCapsule", entryPoint: "src/drop-capsule.ts", filename: "drop-capsule.mjs" },
  { key: "publicSharePage", entryPoint: "src/public-share-page.ts", filename: "public-share-page.mjs" },
  { key: "sharePrivacy", entryPoint: "src/share-privacy.ts", filename: "share-privacy.mjs" },
  { key: "briefWidget", entryPoint: "src/chatgpt-brief-widget.ts", filename: "chatgpt-brief-widget.mjs" },
  { key: "reasoning", entryPoint: "src/reasoning.ts", filename: "reasoning.mjs" },
  { key: "reasoningLedger", entryPoint: "src/reasoning-ledger.ts", filename: "reasoning-ledger.mjs" },
  { key: "shares", entryPoint: "src/shares.ts", filename: "shares.mjs" },
]);

export const LAUNCH_CAPTURE_DIRECT_INPUT_PATHS = Object.freeze([
  "public/index.html",
  "public/app.js",
  "public/sw.js",
  "public/webmcp.js",
  "public/styles.css",
  "public/icons/driftglass.svg",
  "public/manifest.webmanifest",
  AGENT_WEEK_PACK_PATH,
  AI_INFRASTRUCTURE_PACK_PATH,
  CODING_AGENTS_PACK_PATH,
  "scripts/build-launch-assets.mjs",
  "scripts/build-walkthrough-music.mjs",
  "scripts/capture-launch-assets.mjs",
  "scripts/check-launch-assets.mjs",
  "scripts/walkthrough-contract.mjs",
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function repositoryRelativePath(inputPath) {
  const absolutePath = path.resolve(REPOSITORY_ROOT, inputPath);
  const relativePath = path.relative(REPOSITORY_ROOT, absolutePath).replaceAll(path.sep, "/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Launch capture input is outside the repository: ${inputPath}`);
  }
  return relativePath;
}

async function serviceWorkerShellInputPaths() {
  const source = await readFile(path.join(REPOSITORY_ROOT, "public", "sw.js"), "utf8");
  const shell = source.match(/\bconst\s+SHELL\s*=\s*\[([\s\S]*?)\]\s*;/)?.[1];
  if (!shell) throw new Error("Launch capture could not resolve the service-worker shell inputs");
  const paths = new Set();
  for (const match of shell.matchAll(/"(\/[^"\\]*)"/g)) {
    const url = new URL(match[1], "https://launch.invalid");
    const publicPath = url.pathname === "/" || url.pathname === "/index.html"
      ? "public/index.html"
      : `public${url.pathname}`;
    paths.add(repositoryRelativePath(publicPath));
  }
  if (!paths.size) throw new Error("Launch capture found an empty service-worker shell");
  return [...paths];
}

const ILLUSTRATIVE_EVIDENCE = Object.freeze([
  {
    accessClass: "public",
    sourceKind: "web",
    source: "International Energy Agency",
    title: HORMUZ_SOURCE_TITLES[0],
    url: HORMUZ_SOURCE_URLS[0],
    publishedAt: "2026-07-07T00:00:00.000Z",
    excerpt: "From March through June, Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier. Production elsewhere was about 27 bcm higher, offsetting roughly three quarters of the decline, but global LNG production was still about 4% lower year on year. Near-term disruption and infrastructure damage could remove 140 bcm of cumulative supply through 2030.",
  },
  {
    accessClass: "public",
    sourceKind: "web",
    source: "U.S. Energy Information Administration",
    title: HORMUZ_SOURCE_TITLES[1],
    url: HORMUZ_SOURCE_URLS[1],
    publishedAt: "2026-04-16T00:00:00.000Z",
    excerpt: "Damage to two Ras Laffan liquefaction trains removed 17% of Qatar's export capacity; QatarEnergy estimated repairs could take up to five years.",
  },
  {
    accessClass: "public",
    sourceKind: "web",
    source: "U.S. Energy Information Administration",
    title: HORMUZ_SOURCE_TITLES[2],
    url: HORMUZ_SOURCE_URLS[2],
    publishedAt: "2026-03-03T00:00:00.000Z",
    excerpt: "Hormuz carried 20.9 million barrels per day of oil and 11.4 billion cubic feet per day of LNG in the first half of 2025; bypass capacity was much smaller.",
  },
]);

export const ILLUSTRATIVE_SYNTHESIS_RESULT = Object.freeze({
  schemaVersion: "1",
  answerMode: "synthesis",
  summary: "No. Hormuz traffic is recovering, but LNG supply has not normalized. The bottleneck has moved from the Strait to damaged Qatari export capacity: replacement supply has contained most of the loss, while the Ras Laffan repair schedule sets a multi-year recovery clock.",
  confidence: 0.8,
  strongestEvidence: [
    {
      title: "Replacement supply narrowed the gap",
      claim: "From March through June, Qatar and UAE loadings were about 35 bcm lower than a year earlier while production elsewhere rose about 27 bcm; global LNG output still fell 4%. Substitution prevented a deeper loss without restoring pre-shock supply.",
      citationUrl: HORMUZ_SOURCE_URLS[0],
    },
    {
      title: "Damage outlasts reopening",
      claim: "Reopening cannot restore output from two damaged Ras Laffan trains that removed 17% of Qatar's export capacity. With repairs expected to take up to five years, plant capacity now sets part of the recovery clock.",
      citationUrl: HORMUZ_SOURCE_URLS[1],
    },
    {
      title: "Asia's premium redirected flexible cargoes",
      claim: "Weaker demand and cargo diversion helped lower prices while supply stayed impaired. Asia's $2.1 per MBtu premium pulled flexible cargoes east, showing how prices can normalize before physical supply; the IEA still estimates 140 bcm of cumulative LNG losses through 2030.",
      citationUrl: HORMUZ_SOURCE_URLS[0],
    },
  ],
  strongestContraryCase: {
    text: "New non-Gulf capacity could normalize the wider market before Qatar repairs its damaged trains. The IEA expects close to 50 bcm from new projects and more than 10 bcm from existing producers; if the Strait fully reopens in Q3 and undamaged facilities return in Q4, global supply could hold flat in 2026 despite Qatar’s outage.",
    citationUrls: [HORMUZ_SOURCE_URLS[0]],
  },
  watchFor: [
    {
      text: "Normalization test: carrier traffic and Qatar and UAE cargo loadings recover together for several weeks.",
      citationUrls: [HORMUZ_SOURCE_URLS[0], HORMUZ_SOURCE_URLS[2]],
    },
    {
      text: "Damaged liquefaction trains return to production and the IEA cuts its cumulative loss estimate.",
      citationUrls: [HORMUZ_SOURCE_URLS[0], HORMUZ_SOURCE_URLS[1]],
    },
  ],
  citations: [HORMUZ_SOURCE_URLS[0], HORMUZ_SOURCE_URLS[1]],
});

export function illustrativeEvidenceBundle(resultContract) {
  return {
    schemaVersion: "3",
    generatedAt: FIXED_RECEIPT_AT,
    target: "chatgpt",
    task: "investigate",
    sourceScope: "share",
    title: "Has the Strait of Hormuz reopened enough for the gas market to normalize?",
    objective: "Assess whether physical gas supply has normalized as shipping resumes.",
    tokenBudget: 10_000,
    mission: {
      id: FIXED_MISSION_ID,
      name: "Hormuz gas normalization",
      question: "Has the Strait of Hormuz reopened enough for the gas market to normalize?",
    },
    executiveContext: [],
    memory: { nodes: [], edges: [], timeline: [], rationale: [] },
    evidence: ILLUSTRATIVE_EVIDENCE.map((item) => ({ ...item })),
    coverage: {
      evidenceCount: 3,
      storyCount: 1,
      sourceCount: 3,
      sourceFamilyCount: 2,
      independentFamilyCount: 2,
      echoCount: 0,
      echoShare: 0,
      sourceFamilies: ["eia.gov", "iea.org"],
      sourceKinds: ["web"],
      sourceRoles: { authoritative: 2 },
      primarySourceCount: 2,
      independentSourceCount: 0,
      discoveryShare: 0,
      cloudEvidenceCount: 3,
      localEvidenceCount: 0,
    },
    relevantPacks: [],
    contextBudget: { estimatedTokens: 1_100, sectionChars: {}, truncatedSections: [] },
    quality: {
      score: 0.8,
      grade: "strong",
      dimensions: {
        evidenceDepth: 0.8,
        sourceDiversity: 0.7,
        provenance: 1,
        memoryContinuity: 0,
        recency: 0.8,
        challengeCoverage: 0.7,
        cloudIndependence: 1,
        echoResistance: 1,
      },
      blockers: [],
      recommendations: [],
      deepResearchRecommended: false,
    },
    contradictions: [],
    gaps: [],
    openQuestions: [],
    playbooks: [],
    instructions: [],
    outputContract: [],
    resultContract,
    memoryPatchContract: {},
    receiptId: FIXED_RECEIPT_ID,
  };
}

export function evidenceBundleHash(bundle) {
  const { receiptId: _receiptId, generatedAt: _generatedAt, ...hashableBundle } = bundle;
  return createHash("sha256").update(stableStringify(hashableBundle)).digest("hex");
}

function illustrativePublicStory() {
  return {
    id: "hormuz-lng-normalization",
    title: "Shipping is recovering faster than LNG supply",
    summary: "From March through June, Qatar and UAE loadings were about 35 bcm lower than a year earlier. Production elsewhere was about 27 bcm higher, offsetting roughly three quarters of the decline, but global LNG output was still about 4% lower year on year.",
    evidenceCount: 3,
    sourceCount: 3,
    sourceFamilyCount: 2,
    independentFamilyCount: 2,
    echoCount: 0,
    confidence: 0.8,
    changedAt: "2026-07-07T10:00:00.000Z",
    evidence: [
      {
        accessClass: "public",
        independent: true,
        lineageRelation: "origin",
        evidenceFamily: "iea.org",
        source: "International Energy Agency",
        title: HORMUZ_SOURCE_TITLES[0],
        url: HORMUZ_SOURCE_URLS[0],
        excerpt: "From March through June, Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier, production elsewhere was about 27 bcm higher, and global LNG production was still about 4% lower year on year.",
      },
      {
        accessClass: "public",
        independent: true,
        lineageRelation: "independent",
        evidenceFamily: "eia.gov",
        source: "U.S. Energy Information Administration",
        title: HORMUZ_SOURCE_TITLES[1],
        url: HORMUZ_SOURCE_URLS[1],
        publishedAt: "2026-04-16T00:00:00.000Z",
        excerpt: "Damage to two Ras Laffan liquefaction trains removed 17% of Qatar's export capacity; QatarEnergy estimated repairs could take up to five years.",
      },
      {
        accessClass: "public",
        independent: false,
        lineageRelation: "same-family",
        evidenceFamily: "eia.gov",
        source: "U.S. Energy Information Administration",
        title: HORMUZ_SOURCE_TITLES[2],
        url: HORMUZ_SOURCE_URLS[2],
        publishedAt: "2026-03-03T00:00:00.000Z",
        excerpt: "Hormuz carried 20.9 million barrels per day of oil and 11.4 billion cubic feet per day of LNG in the first half of 2025; bypass capacity was much smaller.",
      },
    ],
  };
}

export const FINAL_ARTIFACTS = Object.freeze([
  ["hormuz-share.json", "application/json"],
  ["hormuz-analysis.html", "text/html"],
  ["hormuz-analysis.zip", "application/zip"],
  ["01-today.png", "image/png"],
  ["02-mission-computer.png", "image/png"],
  ["03-final-answer.png", "image/png"],
  ["04-public-card.png", "image/png"],
  ["architecture.svg", "image/svg+xml"],
  ["walkthrough.mp4", "video/mp4"],
]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function cloudflareWorkersStubPlugin() {
  return {
    name: "launch-cloudflare-workers-stub",
    setup(bundle) {
      bundle.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        path: "cloudflare:workers",
        namespace: "launch-cloudflare-workers",
      }));
      bundle.onLoad({ filter: /.*/, namespace: "launch-cloudflare-workers" }, () => ({
        loader: "js",
        contents: `
          class NoopEntrypoint {}
          const span = { setAttribute() {}, setStatus() {}, addEvent() {} };
          export class DurableObject extends NoopEntrypoint {}
          export class WorkerEntrypoint extends NoopEntrypoint {}
          export class WorkflowEntrypoint extends NoopEntrypoint {}
          export const tracing = { enterSpan(_name, operation) { return operation(span); } };
        `,
      }));
    },
  };
}

async function productionRendererMetafiles() {
  return Promise.all(PRODUCTION_BUNDLE_DEFINITIONS.map(({ entryPoint }) => build({
    entryPoints: [path.join(REPOSITORY_ROOT, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    metafile: true,
    plugins: [cloudflareWorkersStubPlugin()],
    logLevel: "silent",
  })));
}

export async function collectLaunchCaptureInputEntries() {
  const inputPaths = new Set(LAUNCH_CAPTURE_DIRECT_INPUT_PATHS);
  for (const inputPath of await serviceWorkerShellInputPaths()) inputPaths.add(inputPath);
  for (const result of await productionRendererMetafiles()) {
    for (const inputPath of Object.keys(result.metafile.inputs)) {
      if (inputPath.startsWith("launch-cloudflare-workers:")) continue;
      inputPaths.add(repositoryRelativePath(inputPath));
    }
  }
  return Promise.all([...inputPaths].sort().map(async (inputPath) => ({
    path: inputPath,
    sha256: sha256(await readFile(path.join(REPOSITORY_ROOT, inputPath))),
  })));
}

export function modelInsertManifestBinding({ modelInsertSha256, modelInsertApproval }) {
  if (!/^[a-f0-9]{64}$/.test(modelInsertSha256 || "")) throw new Error("Launch capture requires the approved model insert SHA-256");
  if (!modelInsertApproval || typeof modelInsertApproval !== "object" || Array.isArray(modelInsertApproval)) {
    throw new Error("Launch capture requires the model insert approval");
  }
  if (modelInsertApproval.insertSha256 !== modelInsertSha256) throw new Error("Model insert approval does not bind the approved video SHA-256");
  const binding = {
    sha256: modelInsertSha256,
    approvalDigest: sha256(Buffer.from(stableStringify(modelInsertApproval))),
    reviewedFrameCount: modelInsertApproval.reviewedFrameCount,
    conversationOnly: modelInsertApproval.conversationOnly,
    noBrowserChrome: modelInsertApproval.noBrowserChrome,
    noSidebar: modelInsertApproval.noSidebar,
    noAccountUi: modelInsertApproval.noAccountUi,
    noOtherChats: modelInsertApproval.noOtherChats,
  };
  return validateModelInsertManifestBinding(binding);
}

export function validateModelInsertManifestBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Complete launch manifest requires a model insert binding");
  if (!/^[a-f0-9]{64}$/.test(binding.sha256 || "")) throw new Error("Model insert binding has an invalid SHA-256");
  if (!/^[a-f0-9]{64}$/.test(binding.approvalDigest || "")) throw new Error("Model insert binding has an invalid approval digest");
  const expectedFrameCount = Math.round(WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS * WALKTHROUGH_OUTPUT_FPS);
  if (binding.reviewedFrameCount !== expectedFrameCount) throw new Error(`Model insert binding must cover ${expectedFrameCount} reviewed frames`);
  for (const key of ["conversationOnly", "noBrowserChrome", "noSidebar", "noAccountUi", "noOtherChats"]) {
    if (binding[key] !== true) throw new Error(`Model insert binding requires ${key}`);
  }
  return {
    sha256: binding.sha256,
    approvalDigest: binding.approvalDigest,
    reviewedFrameCount: binding.reviewedFrameCount,
    conversationOnly: true,
    noBrowserChrome: true,
    noSidebar: true,
    noAccountUi: true,
    noOtherChats: true,
  };
}

export function launchCaptureInputFingerprint({ inputEntries, modelInsertBinding }) {
  if (!Array.isArray(inputEntries) || inputEntries.length === 0) throw new Error("Launch capture fingerprint requires source inputs");
  const normalizedModelInsert = validateModelInsertManifestBinding(modelInsertBinding);
  const normalizedInputs = inputEntries.map((entry) => ({
    path: repositoryRelativePath(entry.path),
    sha256: entry.sha256,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(normalizedInputs.map((entry) => entry.path)).size !== normalizedInputs.length) {
    throw new Error("Launch capture fingerprint contains duplicate source inputs");
  }
  for (const entry of normalizedInputs) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error(`Launch capture input has an invalid SHA-256: ${entry.path}`);
  }
  const payload = {
    schemaVersion: "1",
    inputs: normalizedInputs,
    modelInsert: normalizedModelInsert,
  };
  return sha256(Buffer.from(stableStringify(payload)));
}

export async function computeLaunchCaptureInputFingerprint({ modelInsertBinding }) {
  return launchCaptureInputFingerprint({
    inputEntries: await collectLaunchCaptureInputEntries(),
    modelInsertBinding,
  });
}

export async function loadProductionRenderers() {
  const bundleDirectory = path.join(LAUNCH_WORK_DIRECTORY, "renderer");
  await mkdir(bundleDirectory, { recursive: true });
  await Promise.all(PRODUCTION_BUNDLE_DEFINITIONS.map(({ entryPoint, filename }) => build({
    entryPoints: [path.join(REPOSITORY_ROOT, entryPoint)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: path.join(bundleDirectory, filename),
    plugins: [cloudflareWorkersStubPlugin()],
    logLevel: "silent",
  })));
  const modules = await Promise.all(PRODUCTION_BUNDLE_DEFINITIONS.map(async ({ filename }) => {
    const bundledPath = path.join(bundleDirectory, filename);
    const bundleHash = sha256(await readFile(bundledPath));
    return import(`${pathToFileURL(bundledPath).href}?sha256=${bundleHash}`);
  }));
  return Object.fromEntries(PRODUCTION_BUNDLE_DEFINITIONS.map(({ key }, index) => [key, modules[index]]));
}

export async function createLaunchFixture(production) {
  production ??= await loadProductionRenderers();
  const resultContract = production.reasoning.reasoningResultContract("investigate", HORMUZ_SOURCE_URLS);
  const canonical = production.reasoningLedger.canonicalizeReasoningResult(
    { resultContract },
    { structuredResult: structuredClone(ILLUSTRATIVE_SYNTHESIS_RESULT) },
    ILLUSTRATIVE_SYNTHESIS_RESULT.summary,
  );
  const bundle = illustrativeEvidenceBundle(resultContract);
  const bundleHash = evidenceBundleHash(bundle);
  const receipt = {
    id: FIXED_RECEIPT_ID,
    scope_kind: "mission",
    scope_id: FIXED_MISSION_ID,
    task: "investigate",
    target: "chatgpt",
    title: bundle.title,
    objective: bundle.objective,
    bundle_version: 3,
    bundle_hash: bundleHash,
    bundle_r2_key: "launch/hormuz-share-receipt.json",
    quality_json: JSON.stringify(bundle.quality),
    estimated_tokens: bundle.contextBudget.estimatedTokens,
    evidence_count: bundle.evidence.length,
    independent_family_count: bundle.coverage.independentFamilyCount,
    provider_label: "ChatGPT",
    model_label: null,
    result_json: JSON.stringify(canonical.structuredResult),
    result_r2_key: null,
    confidence: canonical.confidence,
    citations_json: JSON.stringify(canonical.citations),
    decision_note: null,
    status: "reviewed",
    completed_at: FIXED_REVIEWED_AT,
    created_at: FIXED_RECEIPT_AT,
    updated_at: FIXED_REVIEWED_AT,
  };
  const run = {
    id: "launch-hormuz-reviewed-run",
    receipt_id: receipt.id,
    provider_label: "ChatGPT",
    model_label: null,
    client_label: "Driftglass launch fixture",
    status: "reviewed",
    response_hash: null,
    response_r2_key: null,
    response_summary: canonical.summary,
    structured_result_json: JSON.stringify(canonical.structuredResult),
    audit_json: "{}",
    outcome_json: "{}",
    confidence: canonical.confidence,
    rating: null,
    memory_proposal_id: null,
    started_at: FIXED_RECEIPT_AT,
    completed_at: FIXED_REVIEWED_AT,
    reviewed_at: FIXED_REVIEWED_AT,
    created_at: FIXED_RECEIPT_AT,
    updated_at: FIXED_REVIEWED_AT,
  };
  const reviewedAnswer = await production.shares.projectReviewedAnswerForShare({
    kind: "mission",
    id: FIXED_MISSION_ID,
    run,
    receipt,
    bundle,
  });
  if (!reviewedAnswer) throw new Error("The production Share projection rejected the launch synthesis receipt");
  const share = JSON.parse(JSON.stringify(production.sharePrivacy.requirePublicSharePayload({
    schemaVersion: "2",
    publicEvidenceOnly: true,
    kind: "mission",
    title: "Has Hormuz reopened enough for the gas market to normalize?",
    generatedAt: FIXED_GENERATED_AT,
    reviewedAnswer,
    stories: [illustrativePublicStory()],
    footer: "",
  })));
  return { production, resultContract, canonical, bundle, receipt, run, reviewedAnswer, share };
}

export function finalAnswerPresentation({ canonical, bundle }) {
  return {
    schemaVersion: "1",
    briefKind: "mission",
    interpretationLabel: "ChatGPT interpretation",
    title: "Hormuz and the 2026 gas shock",
    context: "Has the Strait reopened enough for the gas market to normalize?",
    answerMode: "synthesis",
    thesis: {
      text: canonical.summary,
      citationUrls: canonical.citations,
    },
    keyJudgments: canonical.structuredResult.strongestEvidence.map((item) => ({
      title: item.title,
      text: item.claim,
      citationUrls: [item.citationUrl],
    })),
    competingExplanation: canonical.structuredResult.strongestContraryCase,
    watchFor: canonical.structuredResult.watchFor,
    evidence: {
      asOf: FIXED_REVIEWED_AT,
      boundary: "Sources current through July 7, 2026; flow comparisons cover March through June.",
      limitations: [],
      sources: bundle.evidence.map((item) => ({
        url: item.url,
        publisher: item.source,
        title: item.title,
        publishedAt: item.publishedAt,
        excerpt: item.excerpt,
      })),
    },
  };
}

function finalAnswerDocument(widgetHtml, presentation) {
  const fixture = JSON.stringify(presentation).replaceAll("<", "\\u003c");
  const portfolioStyles = [
    ".shell{max-width:1180px;padding:12px 18px}",
    ".masthead{padding:13px 18px 11px}",
    ".synthesis{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:16px;padding:0 18px 8px}",
    ".synthesis-lead,.judgments{grid-column:1/-1}",
    ".synthesis-lead{padding:13px 0 12px}",
    ".judgments{padding:12px 0 3px}",
    ".judgment-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:8px}",
    ".competing{grid-column:1;margin:10px 0 4px}",
    ".watch-list{grid-column:2;margin:10px 0 4px}",
    ".citation-ref{min-width:25px;min-height:25px}",
    ".evidence summary{min-height:42px;padding:11px 18px}",
    ".illustrative-disclosure{width:min(1144px,100%);margin:0 auto 7px;color:#6b7280;font-size:11px;font-weight:680;letter-spacing:.06em;text-transform:uppercase}",
  ].join("");
  return widgetHtml
    .replace("</style>", `${portfolioStyles}</style>`)
    .replace('<main class="shell">', `<main class="shell"><p class="illustrative-disclosure">${ILLUSTRATIVE_DISCLOSURE}</p>`)
    .replace("</head>", `<script>window.openai={toolOutput:${fixture},notifyIntrinsicHeight(){}};</script></head>`);
}

function architectureSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-labelledby="title desc">
  <title id="title">Driftglass v0.9.0 architecture</title>
  <desc id="desc">A Cloudflare Worker collects public evidence into Queue, D1, R2, Workflows, and one MissionComputer Durable Object per Mission. Subscription models reason over exact receipts. Companion, Power Mode, AI Search, and Agent Memory are optional.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5f3ed"/><stop offset="1" stop-color="#eceaf7"/></linearGradient>
    <linearGradient id="core" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#191d27"/><stop offset="1" stop-color="#34314f"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#181622" flood-opacity=".12"/></filter>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 10 5 0 10Z" fill="#6c6491"/></marker>
    <style>
      text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#17191f}.eyebrow{font-size:15px;font-weight:760;letter-spacing:2.5px;fill:#6259aa}.title{font-size:44px;font-weight:820;letter-spacing:-1.8px}.subtitle{font-size:20px;fill:#626775}.card-title{font-size:22px;font-weight:780}.card-copy{font-size:16px;fill:#656a77}.micro{font-size:14px;fill:#6d7280}.white{fill:#fff}.white-muted{fill:#c9c7d5}.pill{font-size:13px;font-weight:760;letter-spacing:.5px}.line{fill:none;stroke:#6c6491;stroke-width:3;marker-end:url(#arrow)}.dash{stroke-dasharray:9 9}.node{fill:#fff;stroke:#d8d5df;stroke-width:2}.optional{fill:#fbfaf7;stroke:#aaa5bc;stroke-width:2;stroke-dasharray:8 7}.accent{fill:#efeefe;stroke:#8c82d7;stroke-width:2}.orange{fill:#fff2e8;stroke:#dd8751;stroke-width:2}
    </style>
  </defs>
  <rect width="1600" height="1000" fill="url(#bg)"/>
  <text x="80" y="72" class="eyebrow">DRIFTGLASS 0.9.0 · QUESTIONS THAT STAY CURRENT</text>
  <text x="80" y="126" class="title">One durable workspace for each standing question</text>
  <text x="80" y="164" class="subtitle">Cloudflare gathers and organizes the material. Your model writes the answer.</text>

  <rect x="80" y="226" width="260" height="164" rx="24" class="node" filter="url(#shadow)"/>
  <text x="110" y="266" class="eyebrow">EVIDENCE IN</text>
  <text x="110" y="305" class="card-title">Public sources</text>
  <text x="110" y="338" class="card-copy">APIs · releases · research</text>
  <text x="110" y="365" class="card-copy">pages · explicit captures</text>

  <rect x="430" y="216" width="400" height="184" rx="28" fill="url(#core)" filter="url(#shadow)"/>
  <text x="466" y="258" class="eyebrow white-muted">CLOUDFLARE CORE</text>
  <text x="466" y="305" class="card-title white">Worker + Budget Governor</text>
  <text x="466" y="340" class="card-copy white-muted">direct → Kitesurf → Chromium</text>
  <text x="466" y="370" class="card-copy white-muted">collect · schedule · serve</text>

  <path d="M340 308H430" class="line"/>
  <path d="M520 400V438H250V480" class="line"/>

  <rect x="135" y="480" width="230" height="132" rx="22" class="node"/>
  <text x="165" y="521" class="eyebrow">QUEUE</text>
  <text x="165" y="558" class="card-title">Ingestion</text>
  <text x="165" y="585" class="micro">Collection and retries</text>

  <rect x="430" y="468" width="270" height="144" rx="22" class="accent"/>
  <text x="460" y="509" class="eyebrow">D1</text>
  <text x="460" y="546" class="card-title">Global index</text>
  <text x="460" y="574" class="micro">Stories · Missions · memory</text>
  <text x="460" y="597" class="micro">receipts · reviews · decisions</text>

  <rect x="765" y="468" width="245" height="144" rx="22" class="node"/>
  <text x="795" y="509" class="eyebrow">R2</text>
  <text x="795" y="546" class="card-title">Evidence objects</text>
  <text x="795" y="574" class="micro">Raw captures · share media</text>
  <text x="795" y="597" class="micro">portable artifacts</text>

  <rect x="1075" y="468" width="265" height="144" rx="22" class="node"/>
  <text x="1105" y="509" class="eyebrow">WORKFLOWS</text>
  <text x="1105" y="546" class="card-title">Scheduled research</text>
  <text x="1105" y="574" class="micro">Sprints · refreshes</text>
  <text x="1105" y="597" class="micro">refresh · compare · compile</text>

  <path d="M365 546H430" class="line"/>
  <path d="M700 540H765" class="line"/>
  <path d="M1010 540H1075" class="line"/>

  <rect x="430" y="680" width="580" height="188" rx="28" class="orange" filter="url(#shadow)"/>
  <text x="468" y="724" class="eyebrow">MISSION ID → MISSIONCOMPUTER DURABLE OBJECT</text>
  <text x="468" y="766" class="card-title">Mission files and history</text>
  <text x="468" y="803" class="card-copy">sources + notes + results + exports</text>
  <rect x="468" y="824" width="126" height="28" rx="14" fill="#fff"/><text x="486" y="844" class="pill">one Mission</text>
  <rect x="606" y="824" width="145" height="28" rx="14" fill="#fff"/><text x="624" y="844" class="pill">one workspace</text>
  <rect x="763" y="824" width="199" height="28" rx="14" fill="#fff"/><text x="781" y="844" class="pill">history over time</text>
  <path d="M565 612V680" class="line"/>

  <rect x="1075" y="680" width="430" height="188" rx="28" fill="url(#core)" filter="url(#shadow)"/>
  <text x="1112" y="724" class="eyebrow white-muted">YOUR MODEL</text>
  <text x="1112" y="766" class="card-title white">ChatGPT, Claude, Grok, or another model</text>
  <text x="1112" y="803" class="card-copy white-muted">brief in → answer out</text>
  <text x="1112" y="833" class="card-copy white-muted">save the parts worth keeping</text>
  <path d="M1010 774H1075" class="line"/>

  <rect x="80" y="680" width="270" height="82" rx="20" class="optional"/>
  <text x="108" y="714" class="eyebrow">OPTIONAL COMPANION</text>
  <text x="108" y="744" class="micro">outbound collection + local mirror</text>
  <path d="M350 720H430" class="line dash"/>
  <rect x="80" y="786" width="270" height="82" rx="20" class="optional"/>
  <text x="108" y="820" class="eyebrow">OPTIONAL POWER MODE</text>
  <text x="108" y="850" class="micro">separate execution deployment</text>
  <path d="M350 828H430" class="line dash"/>

  <rect x="80" y="910" width="1425" height="54" rx="18" fill="#ffffff" stroke="#d8d5df"/>
  <text x="108" y="943" class="micro">Optional, rebuildable projections: AI Search and Agent Memory</text>
  <text x="1458" y="943" text-anchor="end" class="micro">Observability: aggregate analytics + service metrics + service health</text>
</svg>
`;
}

async function artifactEntry(filename, mediaType) {
  const absolutePath = path.join(LAUNCH_DIRECTORY, filename);
  const [buffer, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
  const entry = { path: filename, mediaType, bytes: metadata.size, sha256: sha256(buffer) };
  if (mediaType === "image/png" || mediaType === "video/mp4") Object.assign(entry, VIEWPORT);
  if (mediaType === "image/svg+xml") Object.assign(entry, { width: 1600, height: 1000 });
  if (mediaType === "video/mp4") Object.assign(entry, {
    durationSeconds: WALKTHROUGH_DURATION_SECONDS,
    frameRate: WALKTHROUGH_OUTPUT_FPS,
    codec: "h264",
    pixelFormat: "yuv420p",
    audioCodec: WALKTHROUGH_AUDIO_CODEC,
    audioProfile: WALKTHROUGH_AUDIO_PROFILE,
    audioSampleRate: WALKTHROUGH_AUDIO_SAMPLE_RATE,
    audioChannels: WALKTHROUGH_AUDIO_CHANNELS,
    audioTitle: WALKTHROUGH_AUDIO_TITLE,
    audioSource: WALKTHROUGH_AUDIO_ORIGIN,
    audioLicense: WALKTHROUGH_AUDIO_LICENSE,
  });
  return entry;
}

export async function writeLaunchManifest({ captureComplete = false, captureFingerprint, modelInsertBinding } = {}) {
  const artifacts = [];
  for (const [filename, mediaType] of FINAL_ARTIFACTS) {
    try {
      artifacts.push(await artifactEntry(filename, mediaType));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const complete = captureComplete && artifacts.length === FINAL_ARTIFACTS.length;
  if (complete && !/^[a-f0-9]{64}$/.test(captureFingerprint || "")) {
    throw new Error("A complete launch capture requires its canonical input fingerprint");
  }
  const normalizedModelInsert = complete ? validateModelInsertManifestBinding(modelInsertBinding) : undefined;
  const manifest = {
    schemaVersion: "2",
    buildVersion: "0.9.0-launch.4",
    status: complete ? "complete" : "capture-pending",
    ...(complete ? { captureFingerprint } : {}),
    ...(complete ? { modelInsert: normalizedModelInsert } : {}),
    illustrative: {
      classification: ILLUSTRATIVE_DISCLOSURE,
      publicSourcesAsOf: "2026-07-07",
      sourceUrls: [...HORMUZ_SOURCE_URLS, ...AI_SCIENCE_SOURCE_URLS],
    },
    artifacts,
  };
  await writeFile(path.join(LAUNCH_DIRECTORY, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function buildLaunchAssets() {
  process.env.TZ = "UTC";
  await Promise.all([
    mkdir(LAUNCH_DIRECTORY, { recursive: true }),
    mkdir(LAUNCH_WORK_DIRECTORY, { recursive: true }),
  ]);
  const fixture = await createLaunchFixture();
  const { dropCapsule, publicSharePage, briefWidget } = fixture.production;
  const answerPresentation = finalAnswerPresentation(fixture);
  const normalized = fixture.share;
  const [shareJson, cardHtml, dropZip, diagram, answerHtml] = [
    `${JSON.stringify(normalized, null, 2)}\n`,
    publicSharePage.renderPublicSharePage({
      payload: normalized,
      publicIndexing: true,
      dropUrl: "hormuz-analysis.zip",
      ogImageUrl: "04-public-card.png",
      presentation: { watchLabel: "Signals to watch", downloadLabel: "Download the brief", disclosure: ILLUSTRATIVE_DISCLOSURE },
    }),
    dropCapsule.buildDropCapsule(normalized, {
      publicIndexing: true,
      presentation: { watchLabel: "Signals to watch", disclosure: ILLUSTRATIVE_DISCLOSURE },
    }),
    architectureSvg(),
    finalAnswerDocument(briefWidget.EDITORIAL_BRIEF_WIDGET_HTML, answerPresentation),
  ];
  await Promise.all([
    writeFile(path.join(LAUNCH_DIRECTORY, "hormuz-share.json"), shareJson),
    writeFile(path.join(LAUNCH_DIRECTORY, "hormuz-analysis.html"), cardHtml),
    writeFile(path.join(LAUNCH_DIRECTORY, "hormuz-analysis.zip"), dropZip),
    writeFile(path.join(LAUNCH_DIRECTORY, "architecture.svg"), diagram),
    writeFile(path.join(LAUNCH_WORK_DIRECTORY, "final-answer.html"), answerHtml),
  ]);
  const manifest = await writeLaunchManifest();
  process.stdout.write(`Built deterministic launch fixtures in ${path.relative(REPOSITORY_ROOT, LAUNCH_DIRECTORY)} (${manifest.artifacts.length}/${FINAL_ARTIFACTS.length} artifacts).\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await buildLaunchAssets();
}
