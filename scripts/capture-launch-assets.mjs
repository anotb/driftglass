#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  FIXED_GENERATED_AT,
  FIXED_REVIEWED_AT,
  AI_SCIENCE_SOURCE_TITLES,
  AI_SCIENCE_SOURCE_URLS,
  HORMUZ_SOURCE_TITLES,
  HORMUZ_SOURCE_URLS,
  ILLUSTRATIVE_DISCLOSURE,
  LAUNCH_DIRECTORY,
  LAUNCH_WORK_DIRECTORY,
  REPOSITORY_ROOT,
  VIEWPORT,
  buildLaunchAssets,
  computeLaunchCaptureInputFingerprint,
  modelInsertManifestBinding,
  sha256,
  writeLaunchManifest,
} from "./build-launch-assets.mjs";
import { writeWalkthroughMusic } from "./build-walkthrough-music.mjs";
import {
  WALKTHROUGH_AUDIO_BIT_RATE,
  WALKTHROUGH_AUDIO_CHANNELS,
  WALKTHROUGH_AUDIO_CODEC,
  WALKTHROUGH_AUDIO_PROFILE,
  WALKTHROUGH_AUDIO_SAMPLE_RATE,
  WALKTHROUGH_AUDIO_TITLE,
  WALKTHROUGH_CAPTURE_FPS,
  WALKTHROUGH_DURATION_SECONDS,
  WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS,
  WALKTHROUGH_MODEL_INSERT_END_SECONDS,
  WALKTHROUGH_MODEL_INSERT_START_SECONDS,
  WALKTHROUGH_OUTPUT_FPS,
} from "./walkthrough-contract.mjs";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const PROFILE_DIRECTORY = path.join(LAUNCH_WORK_DIRECTORY, "chrome-profile");
const INTERMEDIATE_DIRECTORY = path.join(LAUNCH_WORK_DIRECTORY, "frames");
const WALKTHROUGH_FRAME_DIRECTORY = path.join(LAUNCH_WORK_DIRECTORY, "walkthrough-frames");
const WALKTHROUGH_PREVIEW_PATH = path.join(LAUNCH_WORK_DIRECTORY, "walkthrough-preview.mp4");
const MODEL_INSERT_DIRECTORY = path.join(LAUNCH_WORK_DIRECTORY, "approved");
export const MODEL_INSERT_PATH = path.join(MODEL_INSERT_DIRECTORY, "model-chat-crop.mp4");
export const MODEL_INSERT_APPROVAL_PATH = path.join(MODEL_INSERT_DIRECTORY, "model-chat-crop.approval.json");
const MODEL_PRIVACY_DIRECTORY = path.join(LAUNCH_WORK_DIRECTORY, "privacy-review");
const FIXTURE_NOW = "2026-08-10T14:00:00.000Z";

export const WALKTHROUGH_CAPTIONS = Object.freeze([
  { start: 0.15, end: 1.75, text: "Follow questions that stay open." },
  { start: 1.8, end: 3.35, text: "Open an update and its sources." },
  { start: 3.4, end: 7.4, text: "Keep answers, history, and notes together." },
  { start: 8.05, end: 12.6, text: "Ask ChatGPT through Driftglass." },
  { start: 12.8, end: 19.8, text: "Trace causes, alternatives, and reversal signals." },
  { start: 20.05, end: 22.2, text: "Saved answers stay with each Mission." },
  { start: 22.4, end: 26.8, text: "Check the causes, alternative, and signals." },
  { start: 27, end: 30.05, text: "Every claim links to a source." },
]);

export const WALKTHROUGH_ACTIONS = Object.freeze([
  { at: 0.55, action: "preview-ai-science" },
  { at: 1.4, action: "close-ai-science" },
  { at: 1.85, action: "open-story" },
  { at: 3.05, action: "close-story" },
  { at: 3.4, action: "open-missions" },
  { at: 4.05, action: "open-mission-workspace" },
  { at: 4.85, action: "open-current-answer" },
  { at: 5.7, action: "open-history" },
  { at: 6.55, action: "open-normalization-signals" },
  { at: WALKTHROUGH_MODEL_INSERT_START_SECONDS, action: "show-model-answer" },
  { at: WALKTHROUGH_MODEL_INSERT_END_SECONDS, action: "open-saved-answer" },
  { at: 22, action: "scroll-causes" },
  { at: 24.2, action: "scroll-alternative-signals" },
  { at: 26.95, action: "open-sources" },
  { at: 30, action: "close-sources" },
  { at: 30.3, action: "return-to-bottom-line" },
]);

export const WALKTHROUGH_SCROLL_SEGMENTS = Object.freeze([
  { start: 22, end: 22.65, action: "causes" },
  { start: 24.2, end: 24.85, action: "alternative-signals" },
  { start: 26.4, end: 26.9, action: "sources" },
  { start: 27.2, end: 27.9, action: "source-list" },
  { start: 30.3, end: 30.95, action: "bottom-line" },
]);

const hormuzStory = {
  id: "hormuz-lng-normalization",
  title: "Hormuz is reopening. LNG supply is not back to normal.",
  summary: "From March through June, Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier. Production elsewhere was about 27 bcm higher, offsetting roughly three quarters of the decline, but global LNG output was still about 4% lower year on year.",
  source_count: 3,
  last_changed_at: "2026-07-07T12:00:00.000Z",
};

const hormuzEvidence = [
  {
    id: "hormuz-iea-q3-2026",
    source_name: "International Energy Agency",
    title: HORMUZ_SOURCE_TITLES[0],
    url: HORMUZ_SOURCE_URLS[0],
    published_at: "2026-07-07T00:00:00.000Z",
    text: "From March through June, Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier. Production elsewhere was about 27 bcm higher, offsetting roughly three quarters of the decline. Global LNG production was still about 4% lower year on year.",
  },
  {
    id: "hormuz-eia-capacity",
    source_name: "U.S. Energy Information Administration",
    title: HORMUZ_SOURCE_TITLES[1],
    url: HORMUZ_SOURCE_URLS[1],
    published_at: "2026-04-16T00:00:00.000Z",
    text: "Damage to two Ras Laffan liquefaction trains removed 17% of Qatar's export capacity. QatarEnergy estimated that repairs could take up to five years.",
  },
  {
    id: "hormuz-eia-chokepoint",
    source_name: "U.S. Energy Information Administration",
    title: HORMUZ_SOURCE_TITLES[2],
    url: HORMUZ_SOURCE_URLS[2],
    published_at: "2026-03-03T00:00:00.000Z",
    text: "The Strait carried almost one fifth of global LNG trade before the conflict. Reopening carrier traffic does not by itself restore damaged export production.",
  },
];

const hormuzMission = {
  id: "hormuz-gas-normalization",
  name: "Has Hormuz reopened enough for the gas market to normalize?",
  question: "Have carrier traffic, Gulf loadings, and damaged liquefaction capacity recovered together for several weeks?",
  terms: ["Hormuz LNG", "Qatar loadings", "UAE loadings", "liquefaction trains"],
  status: "active",
  cadence_minutes: 1440,
  priority: 2.5,
  matches: [{ story_id: hormuzStory.id, title: hormuzStory.title, last_changed_at: hormuzStory.last_changed_at }],
  pendingResearchResults: [],
  events: [
    { occurred_at: "2026-07-07T12:00:00.000Z", title: "The bottleneck moved to production", detail: "Carrier traffic began to recover while damaged export capacity kept LNG supply below its prewar path.", event_type: "signal" },
  ],
  operator: {
    mode: "watch",
    sprint_policy: "scheduled",
    next_sprint_at: "2026-07-08T12:00:00.000Z",
    expected_next_event: "Carrier traffic, Qatar and UAE loadings, and damaged trains recover together for several weeks",
    expected_event_status: "pending",
    expected_by: "2026-10-01T12:00:00.000Z",
    alert_threshold: 0.65,
  },
  researchState: {
    current_thesis: "Carrier traffic is recovering, but damaged Qatari export capacity now sets the LNG recovery clock.",
    confidence: 0.82,
    last_research_at: FIXED_REVIEWED_AT,
  },
};

const hormuzComputer = {
  syncedAt: FIXTURE_NOW,
  fileCount: 8,
  storyCount: 1,
  evidenceCount: 3,
  files: [
    { path: "mission.md", name: "mission.md", depth: 0, directory: false },
    { path: "memory/context.md", name: "context.md", depth: 1, directory: false },
    { path: "memory/timeline.md", name: "timeline.md", depth: 1, directory: false },
    { path: "handoffs/deep-research.md", name: "deep-research.md", depth: 1, directory: false },
    { path: "results/", name: "results", depth: 0, directory: true },
    { path: "results/Current-answer.md", name: "Current answer", depth: 1, directory: false },
    { path: "notes/", name: "notes", depth: 0, directory: true },
    { path: "notes/Normalization-signals.md", name: "Normalization signals", depth: 1, directory: false },
  ],
};

const hormuzWorkspaceFiles = new Map([
  ["/mission.md", `# Hormuz and the gas shock\n\n## Current answer\n\nCarrier traffic is recovering, but damaged Qatari export capacity now sets the LNG recovery clock.\n\n## Why this is happening\n\nProduction elsewhere prevented a deeper loss. Two damaged Ras Laffan trains still remove 17% of Qatar's export capacity.\n\n## Next test\n\nCarrier traffic, Qatar and UAE loadings, and damaged trains recover together for several weeks.\n`],
  ["/memory/context.md", "# Background\n\nThe Strait carried almost one fifth of global LNG supply before the conflict. Passage, export capacity, and market balance now recover on different clocks.\n"],
  ["/memory/timeline.md", "# How this changed\n\n- March through June: Qatar and UAE loadings fell about 35 bcm year on year.\n- Other producers added about 27 bcm, replacing roughly three quarters of the decline.\n- Early July: carrier traffic began recovering while damaged liquefaction trains kept production below its prewar path.\n"],
  ["/handoffs/deep-research.md", "# Research plan\n\nTrack weekly carrier traffic, Qatar and UAE cargo loadings, train repairs, and changes to the IEA supply-loss estimate.\n"],
  ["/results/Current-answer.md", "# Current answer\n\nHormuz traffic is recovering, but LNG supply has not normalized. Replacement supply contained most of the loss; damaged Ras Laffan capacity now sets the recovery clock.\n\n## What would change this answer\n\nCarrier traffic and Gulf loadings recover together for several weeks, damaged trains return, and the IEA cuts its cumulative loss estimate.\n"],
  ["/notes/Normalization-signals.md", "# Normalization signals\n\nCarrier traffic, Qatar loadings, UAE loadings, damaged train output, and the IEA cumulative loss estimate.\n"],
]);

const aiScienceStory = {
  id: "ai-science-lab-loop",
  title: "Robin used lab results to propose what to test next",
  summary: "Robin analyzed human-run assay results and proposed a second round of experiments. Co-Scientist broadened hypothesis search and produced candidates that human teams tested in leukemia cells and liver organoids.",
  source_count: 2,
  last_changed_at: "2026-05-19T12:00:00.000Z",
};

const aiScienceEvidence = [
  {
    id: "ai-science-robin",
    source_name: "Nature",
    title: AI_SCIENCE_SOURCE_TITLES[1],
    url: AI_SCIENCE_SOURCE_URLS[1],
    published_at: "2026-05-19T00:00:00.000Z",
    text: "Robin analyzed human-run assay results and proposed a second round of experiments. People selected candidates and ran every assay.",
  },
  {
    id: "ai-science-co-scientist",
    source_name: "Nature",
    title: AI_SCIENCE_SOURCE_TITLES[0],
    url: AI_SCIENCE_SOURCE_URLS[0],
    published_at: "2026-05-19T00:00:00.000Z",
    text: "Co-Scientist broadened hypothesis search and produced candidates that human teams tested in leukemia cells and liver organoids.",
  },
];

const aiScienceMissionStory = {
  id: "ai-science-discovery-loop",
  title: "Robin turns assay results into a second hypothesis cycle",
  summary: "Robin proposed 30 candidates for dry macular degeneration, analyzed human-run assay results, and proposed a second round. Co-Scientist's leukemia and liver-fibrosis candidates were selected and tested by human teams; its antimicrobial-resistance mechanism matched a parallel, then-unpublished discovery.",
  source_count: 2,
  last_changed_at: "2026-05-19T12:00:00.000Z",
};

const aiScienceMission = {
  id: "ai-science-experimental-loop",
  name: "Where is AI shortening the scientific discovery cycle?",
  question: "Which AI systems now help design experiments, and which parts of the lab still require people?",
  terms: ["AI scientist", "wet-lab validation", "hypothesis generation", "experimental loop"],
  status: "active",
  cadence_minutes: 1440,
  matches: [{ story_id: aiScienceMissionStory.id, title: aiScienceMissionStory.title, last_changed_at: aiScienceMissionStory.last_changed_at }],
  pendingResearchResults: [],
  events: [{ occurred_at: FIXED_GENERATED_AT }],
  operator: {
    mode: "watch",
    sprint_policy: "manual",
    next_sprint_at: null,
    expected_next_event: "An AI-originated result is reproduced outside the originating lab",
    expected_event_status: "pending",
    expected_by: "2027-06-01T12:00:00.000Z",
  },
  researchState: {
    current_thesis: "Robin used lab results to propose what to test next; Co-Scientist expands and ranks hypotheses for human-led validation. Independent replication is the next test.",
    confidence: 0.78,
    last_research_at: FIXED_REVIEWED_AT,
  },
};

const aiScienceComputer = {
  syncedAt: FIXTURE_NOW,
  fileCount: 9,
  storyCount: 1,
  evidenceCount: 2,
  files: [
    { path: "mission.md", name: "mission.md", depth: 0, directory: false },
    { path: "memory/context.md", name: "context.md", depth: 1, directory: false },
    { path: "memory/timeline.md", name: "timeline.md", depth: 1, directory: false },
    { path: "handoffs/deep-research.md", name: "deep-research.md", depth: 1, directory: false },
    { path: "notes/", name: "notes", depth: 0, directory: true },
    { path: "notes/Replication-signals.md", name: "Replication watchlist", depth: 1, directory: false },
    { path: "results/", name: "results", depth: 0, directory: true },
    { path: "results/Current-answer.md", name: "Current answer", depth: 1, directory: false },
    { path: "state/latest-sync.json", name: "latest-sync.json", depth: 1, directory: false },
  ],
};

const workspaceFiles = new Map([
  ["/mission.md", `# AI and the experimental loop\n\n## Current answer\n\nRobin analyzed human-run assay results and proposed what to test next in one biomedical program. Co-Scientist expands and ranks hypotheses that human teams select and test.\n\n## What got faster\n\nRobin synthesized 551 papers in 30 minutes, versus an estimated 294 hours of human reading. Candidate selection and lab work remained human.\n\n## What still requires people\n\nPeople chose the candidates and ran every experiment. Neither paper reports outside-lab replication or clinical outcomes.\n\n## Next test\n\nAn outside lab reproduces an AI-originated result.\n`],
  ["/memory/context.md", "# Background\n\nRobin uses new assay data to propose another hypothesis. Co-Scientist expands and ranks hypotheses for human-led testing. People still select the candidates and run the experiments.\n"],
  ["/memory/timeline.md", "# How this changed\n\n- May 19, 2026: Nature published Robin and Co-Scientist online.\n- Robin used wet-lab assay results to generate a second hypothesis cycle.\n- Co-Scientist's leukemia and liver-fibrosis candidates entered human-led validation; its antimicrobial-resistance mechanism matched a parallel, then-unpublished finding.\n"],
  ["/handoffs/deep-research.md", "# Research plan\n\nFind prospective, blinded comparisons against expert teams and replications outside the originating labs. Track time and cost per replicated hypothesis, not candidate volume alone.\n"],
  ["/notes/Replication-signals.md", "# Replication watchlist\n\nExternal lab, preregistration, blinded comparison, disclosed negative results, and in-vivo follow-through.\n"],
  ["/results/Current-answer.md", "# Current answer\n\nRobin analyzed human-run assay results and proposed what to test next. Co-Scientist expands hypothesis search for human-led validation.\n\n## What still requires people\n\nPeople chose the candidates and ran every experiment. Neither paper reports outside-lab replication or clinical outcomes.\n"],
]);

function budgetFixture() {
  const effectiveLimits = {
    browser_ms_day: 90_000,
    workflow_steps_day: 364,
    ai_search_queries_month: 0,
    memory_writes_day: 50,
    source_runs_day: 144,
    queue_messages_day: 1_000,
    computer_sync_bytes_day: 8_388_608,
    r2_class_a_ops_day: 80,
    r2_class_b_ops_day: 400,
    r2_write_bytes_day: 10_485_760,
  };
  const dimensions = ["browser_ms", "workflow_steps", "ai_search_queries", "memory_writes", "source_runs", "queue_messages", "computer_sync_bytes", "r2_class_a_ops", "r2_class_b_ops", "r2_write_bytes"];
  return {
    profile: "free",
    executionCapacity: "free-ceiling",
    effectiveLimits,
    plannedLimits: effectiveLimits,
    daily: Object.fromEntries(dimensions.map((key, index) => [key, index === 0 ? 14_000 : index + 2])),
    monthly: { ai_search_queries: 0 },
    remaining: Object.fromEntries(dimensions.map((key) => [key, key === "ai_search_queries" ? 0 : 50])),
    utilization: Object.fromEntries(dimensions.map((key, index) => [key, key === "ai_search_queries" ? 0 : (index + 1) / 40])),
  };
}

let activeDashboardMode = "today";

const fixtures = new Map([
  ["/api/session", {}],
  ["/api/overview", () => ({
    stories: activeDashboardMode === "workspace" ? [aiScienceMissionStory] : [hormuzStory, aiScienceStory],
    packInstalls: [],
    sources: activeDashboardMode === "workspace" ? [
      { id: "nature-robin", name: "Nature · Robin", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.97, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
      { id: "nature-co-scientist", name: "Nature · Co-Scientist", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.96, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
    ] : [
      { id: "iea-gas-market", name: "IEA Gas Market Report", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.98, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
      { id: "eia-hormuz", name: "EIA Hormuz and LNG", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.97, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
      { id: "nature-robin", name: "Nature · Robin", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.97, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
      { id: "nature-co-scientist", name: "Nature · Co-Scientist", kind: "web", enabled: 1, schedule_minutes: 1440, health_score: 0.96, last_success_at: FIXED_GENERATED_AT, last_run_at: FIXED_GENERATED_AT },
    ],
    collectors: [],
    renderStats: { totals: [], profiles: [] },
  })],
  ["/api/packs", { packs: [] }],
  ["/api/missions", () => ({ missions: activeDashboardMode === "workspace" ? [aiScienceMission] : activeDashboardMode === "walkthrough" ? [hormuzMission] : [] })],
  ["/api/mission-runs?limit=40", () => ({ runs: activeDashboardMode === "workspace"
    ? [{ mission_id: aiScienceMission.id, status: "success", started_at: FIXED_GENERATED_AT, result: { collectedItems: 2, matchedStories: 1 } }]
    : activeDashboardMode === "walkthrough"
      ? [{ mission_id: hormuzMission.id, status: "success", started_at: FIXED_GENERATED_AT, result: { collectedItems: 3, matchedStories: 1 } }]
      : [] })],
  ["/api/integrations", {
    scheduledTaskPrompt: "",
    mcpUrl: "",
    operationsMcpUrl: "",
    packetUrl: "",
    pulsePacketUrl: "",
    pulseTaskPrompt: "",
    aiSearchCorpusUrl: "",
    missions: [],
    semanticMemory: { available: true, enabled: false, configured: false },
    deepDiveLab: { configured: false },
  }],
  ["/api/settings/interests", () => ({ terms: activeDashboardMode === "workspace" ? ["AI scientist", "wet-lab validation", "experimental loop"] : ["Hormuz LNG", "gas markets", "AI scientific discovery"] })],
  ["/api/capabilities", { fixed: [], catalog: [] }],
  ["/api/email/receipts", { receipts: [] }],
  ["/api/shares", { shares: [] }],
  ["/api/taste", { profile: { positiveTerms: [], negativeTerms: [], preferredSources: [], downweightedSources: [] } }],
  ["/api/action-center", { actions: [] }],
  ["/api/readiness", { score: 100, releaseBlocked: false, checks: [{ id: "local-fixture", label: "Local portfolio fixture", detail: "Deterministic public-source content", status: "ready" }] }],
  ["/api/ingest/dead-letters?limit=100", { deadLetters: [] }],
  ["/api/autopilot", { missions: [] }],
  ["/api/research-results", { imports: [] }],
  ["/api/intelligence/overview", () => ({
    graph: { dirty: false, stats: { "type:mission": 1, "type:decision": 1, "type:question": 1 }, recentRuns: [] },
    nodes: [], edges: [], timeline: [], proposals: [], runs: [], playbooks: [],
    packs: [], catalog: [],
    budget: budgetFixture(),
  })],
  ["/api/reasoning/providers", { providers: { chatgpt: {}, claude: {}, generic: {} }, mcpUrl: "", operationsMcpUrl: "" }],
  ["/api/reasoning/connections", { available: false, connections: [] }],
  ["/api/judgment", { summary: { readyReasoningTasks: 0, dueDecisionReviews: 0 }, lineage: [], reasoningInbox: [], receipts: [], reasoningRuns: [], decisions: [], calibration: { reviewedCount: 0 }, routines: [], sourceScorecards: [], cadence: [], overlays: [] }],
  ["/api/runtime", {
    context: { profile: "cloudflare", browserAvailable: true, computerAvailable: true, computerPowerAvailable: false, companionOnline: false, budgetProfile: "free", policy: { mode: "auto" } },
    capabilities: [
      { runtime: "worker", available: true, bestFor: ["public collection"] },
      { runtime: "kitesurf", available: true, bestFor: ["rendered public pages"] },
      { runtime: "chromium", available: true, bestFor: ["compatibility fallback"] },
      { runtime: "computer", available: true, bestFor: ["durable Mission files"] },
      { runtime: "workflow", available: true, bestFor: ["bounded research steps"] },
      { runtime: "companion", available: false, bestFor: ["optional signed-in sources"] },
    ],
  }],
  ["/api/memory/checkpoints?scopeKind=global&limit=8", { checkpoints: [] }],
  [`/api/missions/${aiScienceMission.id}/computer`, { computer: aiScienceComputer }],
  [`/api/missions/${hormuzMission.id}/computer`, { computer: hormuzComputer }],
  [`/api/stories/${hormuzStory.id}`, { story: hormuzStory, evidence: hormuzEvidence }],
  [`/api/stories/${hormuzStory.id}/explain`, { explanation: null }],
  [`/api/stories/${hormuzStory.id}/graph`, { graph: null }],
  [`/api/stories/${aiScienceStory.id}`, { story: aiScienceStory, evidence: aiScienceEvidence }],
  [`/api/stories/${aiScienceStory.id}/explain`, { explanation: null }],
  [`/api/stories/${aiScienceStory.id}/graph`, { graph: null }],
]);

function injectedIndex(source, disclosure) {
  const fixtureStyle = `<style>html{scroll-behavior:auto!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.launch-disclosure{position:fixed;z-index:50;top:86px;right:22px;padding:6px 9px;border:1px solid rgba(88,83,117,.24);border-radius:999px;background:rgba(250,249,246,.96);color:#666277;box-shadow:0 6px 18px rgba(27,22,65,.08);font:680 10px/1.2 Inter,ui-sans-serif,system-ui;letter-spacing:.045em}.launch-disclosure.dialog-disclosure{position:absolute;top:24px;right:110px;left:auto}</style>`;
  return source
    .replace("</head>", `${fixtureStyle}</head>`)
    .replace("<main>", `<main><p class="launch-disclosure">${disclosure}</p>`);
}

function fixedClockSource() {
  return `(() => {
    const fixed = ${JSON.stringify(FIXTURE_NOW)};
    const NativeDate = globalThis.Date;
    class FixedDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return new NativeDate(fixed).getTime(); }
    }
    Object.defineProperty(globalThis, "Date", { value: FixedDate, configurable: true, writable: true });
  })();`;
}

function captureStabilitySource() {
  return `(() => {
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      if (options && typeof options === "object") return nativeScrollIntoView.call(this, { ...options, behavior: "instant" });
      return nativeScrollIntoView.call(this, options);
    };
    Object.defineProperty(globalThis, "__DRIFTGLASS_CAPTURE_STABILITY__", { value: true });
  })();`;
}

function contentType(filename) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".zip": "application/zip", ".webmanifest": "application/manifest+json" })[path.extname(filename)] || "application/octet-stream";
}

async function createFixtureServer() {
  const publicRoot = path.join(REPOSITORY_ROOT, "public");
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      requests.push(url.pathname);
      const apiKey = `${url.pathname}${url.search}`;
      if (fixtures.has(apiKey) || fixtures.has(url.pathname)) {
        const fixture = fixtures.get(apiKey) ?? fixtures.get(url.pathname);
        const payload = typeof fixture === "function" ? fixture() : fixture;
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(`${JSON.stringify(payload)}\n`);
        return;
      }
      if (url.pathname.startsWith(`/api/missions/${aiScienceMission.id}/computer/file`) || url.pathname.startsWith(`/api/missions/${hormuzMission.id}/computer/file`)) {
        const requestedPath = url.searchParams.get("path") || "/mission.md";
        const files = url.pathname.includes(hormuzMission.id) ? hormuzWorkspaceFiles : workspaceFiles;
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(`${JSON.stringify({ path: requestedPath, content: files.get(requestedPath) || "# About this workspace\n\nThis file is intentionally empty in the illustrative workspace.\n" })}\n`);
        return;
      }
      if (["/", "/index.html", "/today", "/workspace", "/walkthrough"].includes(url.pathname)) {
        activeDashboardMode = url.pathname === "/workspace" ? "workspace" : url.pathname === "/walkthrough" ? "walkthrough" : "today";
        const disclosure = ILLUSTRATIVE_DISCLOSURE;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(injectedIndex(await readFile(path.join(publicRoot, "index.html"), "utf8"), disclosure));
        return;
      }
      let filename;
      if (url.pathname.startsWith("/launch/")) filename = path.join(LAUNCH_DIRECTORY, url.pathname.slice("/launch/".length));
      else if (url.pathname === "/work/final-answer.html") filename = path.join(LAUNCH_WORK_DIRECTORY, "final-answer.html");
      else if (url.pathname.startsWith("/work/")) filename = path.join(INTERMEDIATE_DIRECTORY, url.pathname.slice("/work/".length));
      else filename = path.join(publicRoot, url.pathname.replace(/^\/+/, ""));
      const permittedRoots = [publicRoot, LAUNCH_DIRECTORY, LAUNCH_WORK_DIRECTORY].map((root) => `${path.resolve(root)}${path.sep}`);
      const resolved = path.resolve(filename);
      if (!permittedRoots.some((root) => `${resolved}${path.sep}`.startsWith(root) || resolved.startsWith(root))) {
        throw Object.assign(new Error("Refused path"), { statusCode: 403 });
      }
      const data = await readFile(resolved);
      response.writeHead(200, { "content-type": contentType(resolved), "cache-control": "no-store" });
      response.end(data);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : error?.statusCode || 500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error?.code === "ENOENT" ? "Not found" : "Fixture server error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind the loopback fixture server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        Promise.resolve(listener(message.params || {})).catch((error) => {
          process.stderr.write(`CDP ${message.method} handler failed: ${error.message}\n`);
        });
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`Chrome CDP closed during ${pending.method}`));
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome CDP")), { once: true });
    });
    return new CdpSession(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function findChromeExecutable() {
  const configured = process.env.CHROME_BIN;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit portable candidate list.
    }
  }
  throw new Error("Chrome is required for launch:capture. Set CHROME_BIN to an installed Chrome or Chromium executable.");
}

async function waitForDevTools(profileDirectory, chromeProcess) {
  const activePortPath = path.join(profileDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (chromeProcess.exitCode !== null) throw new Error(`Chrome exited before CDP was ready (${chromeProcess.exitCode})`);
    try {
      const [portText] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for Chrome CDP");
}

async function pageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    }
    await delay(50);
  }
  throw new Error("Chrome did not expose a page target");
}

async function launchChrome() {
  if (typeof WebSocket !== "function" || typeof fetch !== "function") throw new Error("launch:capture requires Node.js 22+ with built-in WebSocket and fetch");
  const executable = await findChromeExecutable();
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE_DIRECTORY}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-features=MediaRouter,OptimizationHints,Translate",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--password-store=basic",
    "--use-mock-keychain",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1",
    "about:blank",
  ];
  const chromeProcess = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chromeProcess.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  chromeProcess.once("error", (error) => { stderr += `${error.message}\n`; });
  try {
    const port = await waitForDevTools(PROFILE_DIRECTORY, chromeProcess);
    const target = await pageTarget(port);
    const debuggerUrl = new URL(target.webSocketDebuggerUrl);
    if (debuggerUrl.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(debuggerUrl.hostname) || Number(debuggerUrl.port) !== port) {
      throw new Error(`Chrome exposed an unexpected CDP endpoint: ${debuggerUrl.origin}`);
    }
    debuggerUrl.hostname = "127.0.0.1";
    const cdp = await CdpSession.connect(debuggerUrl.toString());
    return { cdp, chromeProcess, stderr: () => stderr };
  } catch (error) {
    chromeProcess.kill("SIGTERM");
    throw new Error(`${error.message}${stderr ? `\n${stderr.trim()}` : ""}`);
  }
}

async function stopChrome(browser) {
  browser.cdp.close();
  if (browser.chromeProcess.exitCode !== null) return;
  browser.chromeProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => browser.chromeProcess.once("exit", resolve)),
    delay(3_000),
  ]);
  if (browser.chromeProcess.exitCode === null) browser.chromeProcess.kill("SIGKILL");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Page evaluation failed");
  return result.result?.value;
}

async function waitForExpression(cdp, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, `Boolean(${expression})`)) return;
    } catch {
      // Navigation can briefly destroy the execution context.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function goto(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitForExpression(cdp, 'document.readyState === "complete"', `page load: ${url}`);
}

async function click(cdp, selector) {
  await waitForExpression(cdp, `document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluate(cdp, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.click(); return true; })()`);
}

async function screenshot(cdp, filename) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(filename, Buffer.from(data, "base64"));
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function ease(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function interpolatePoint(from, to, progress) {
  const t = ease(progress);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function walkthroughCaptionAt(time) {
  return WALKTHROUGH_CAPTIONS.find((caption) => time >= caption.start && time < caption.end)?.text || "";
}

async function elementCenter(cdp, selector, fallback = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 }) {
  const result = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || style.display === "none" || style.visibility === "hidden") return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  return result || fallback;
}

async function installWalkthroughOverlay(cdp, { finalAnswer = false } = {}) {
  await evaluate(cdp, `(() => {
    document.querySelector("#walkthrough-overlay")?.remove();
    document.querySelector("#walkthrough-video-style")?.remove();
    const style = document.createElement("style");
    style.id = "walkthrough-video-style";
    style.textContent = [
      "*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}",
      "#walkthrough-overlay{position:fixed;inset:0;z-index:2147483646;pointer-events:none}",
      "#walkthrough-cursor{position:absolute;width:24px;height:30px;background:#fff;clip-path:polygon(0 0,0 26px,7px 20px,12px 30px,17px 27px,12px 18px,22px 18px);filter:drop-shadow(0 2px 1px rgba(0,0,0,.55));transform:translate(-100px,-100px);will-change:transform}",
      "#walkthrough-ripple{position:absolute;width:44px;height:44px;border:3px solid rgba(117,104,220,.72);border-radius:50%;opacity:0;transform:translate(-100px,-100px) scale(.45)}",
      "#walkthrough-caption,.walkthrough-top-caption{left:50%;bottom:28px;max-width:1050px;transform:translateX(-50%);padding:13px 22px;border:1px solid rgba(255,255,255,.14);border-radius:15px;background:rgba(15,17,23,.92);box-shadow:0 12px 34px rgba(0,0,0,.24);color:#fff;font:720 25px/1.25 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:-.015em;text-align:center;opacity:0;pointer-events:none}",
      "#walkthrough-caption{position:absolute}.walkthrough-top-caption{position:fixed;bottom:72px;z-index:2147483647;background:rgba(15,17,23,.92)!important;color:#fff!important;border:1px solid rgba(255,255,255,.14)!important;box-sizing:border-box!important}",
      ${finalAnswer ? JSON.stringify(".illustrative-disclosure{display:none!important}.shell{max-width:1080px;padding:36px 34px 150px}.brief{border-radius:24px}.masthead{padding:30px 38px 25px}.masthead h1{font-size:44px;line-height:1.08}.masthead .context{font-size:20px}.synthesis{display:block;padding:0 38px 34px}.synthesis-lead{padding:30px 0 27px}.synthesis-thesis{font-size:29px;line-height:1.38}.judgments{padding:28px 0 12px}.judgment-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 18px}.competing,.watch-list{margin:24px 0 0}.evidence summary{min-height:58px;padding:16px 38px}.evidence-body{padding:8px 38px 28px}body{overflow-y:auto}") : JSON.stringify("#stats,#mission-ribbon,.action-center-section{display:none!important}#missions>.split-grid{grid-template-columns:1fr!important}#missions>.split-grid>div.panel{display:none!important}.mission-card .mission-autopilot,.mission-card .mission-next,.mission-card .mission-run,.mission-card .mission-match-list{display:none!important}.mission-card{max-width:980px}.launch-disclosure{transition:none!important}")}
    ].join("");
    document.head.append(style);
    const overlay = document.createElement("div");
    overlay.id = "walkthrough-overlay";
    overlay.innerHTML = '<div id="walkthrough-ripple"></div><div id="walkthrough-cursor"></div><div id="walkthrough-caption"></div>';
    document.body.append(overlay);
    return true;
  })()`);
}

async function setWalkthroughOverlay(cdp, { point, caption, disclosureVisible, rippleProgress = null }) {
  return evaluate(cdp, `(() => {
    const cursor = document.querySelector("#walkthrough-cursor");
    const ripple = document.querySelector("#walkthrough-ripple");
    const baseCaption = document.querySelector("#walkthrough-caption");
    if (!cursor || !ripple || !baseCaption) return { captionVisible: false, topLayer: false };
    const x = ${Number(point.x).toFixed(3)};
    const y = ${Number(point.y).toFixed(3)};
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    const openDialog = [...document.querySelectorAll("dialog[open]")].find((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    for (const stale of document.querySelectorAll(".walkthrough-top-caption")) {
      if (stale.parentElement !== openDialog) stale.remove();
    }
    let targetCaption = baseCaption;
    if (openDialog) {
      targetCaption = openDialog.querySelector(":scope > .walkthrough-top-caption");
      if (!targetCaption) {
        targetCaption = document.createElement("div");
        targetCaption.className = "walkthrough-top-caption";
        openDialog.append(targetCaption);
      }
      baseCaption.style.opacity = "0";
    }
    targetCaption.textContent = ${JSON.stringify(caption)};
    targetCaption.style.opacity = ${caption ? "1" : "0"};
    const progress = ${rippleProgress === null ? "null" : Number(rippleProgress).toFixed(4)};
    if (progress === null) ripple.style.opacity = "0";
    else {
      ripple.style.opacity = String(1 - progress);
      ripple.style.transform = 'translate(' + (x - 22) + 'px,' + (y - 22) + 'px) scale(' + (.45 + progress * .9) + ')';
    }
    const disclosure = document.querySelector(".launch-disclosure");
    if (disclosure) {
      disclosure.style.opacity = ${disclosureVisible ? "1" : "0"};
      disclosure.style.visibility = ${disclosureVisible ? '"visible"' : '"hidden"'};
    }
    const rect = targetCaption.getBoundingClientRect();
    return {
      captionVisible: ${caption ? "true" : "false"} ? getComputedStyle(targetCaption).opacity !== "0" && rect.width > 0 && rect.height > 0 : true,
      topLayer: Boolean(openDialog),
    };
  })()`);
}

async function dispatchClick(cdp, selector) {
  const point = await elementCenter(cdp, selector);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return point;
}

async function openDashboard(cdp, baseUrl, route) {
  await goto(cdp, `${baseUrl}${route}`);
  const pageNow = await evaluate(cdp, "new Date().toISOString()");
  if (pageNow !== FIXTURE_NOW) throw new Error(`Fixed capture clock was not installed: ${pageNow}`);
  await waitForExpression(cdp, 'document.querySelector("#secret")', "login form");
  await evaluate(cdp, `(() => { const input = document.querySelector("#secret"); input.value = "launch-local-key"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await click(cdp, '#login-form button[type="submit"]');
  await waitForExpression(cdp, 'document.querySelector("#app") && !document.querySelector("#app").hidden', "dashboard");
  await evaluate(cdp, "document.fonts ? document.fonts.ready.then(() => true) : true");
  await delay(250);
}

async function normalizeDocumentTop(cdp) {
  const result = await evaluate(cdp, `(async () => {
    const settle = () => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for two capture frames")), 1000);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
    });
    history.replaceState(null, "", location.pathname + location.search);
    document.scrollingElement.scrollTop = 0;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await settle();
    const first = scrollY;
    await settle();
    return { first, second: scrollY };
  })()`);
  if (result.first !== 0 || result.second !== 0) throw new Error(`Dashboard top scroll did not settle deterministically: ${JSON.stringify(result)}`);
}

async function todayActionGeometry(cdp) {
  return evaluate(cdp, `(() => {
    const item = document.querySelector(".action-item");
    if (!item) return null;
    const children = [...item.children];
    const copy = children[0];
    const button = children[1];
    if (!copy || !button) return { childCount: children.length };
    const itemRect = item.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const style = getComputedStyle(item);
    const innerWidth = itemRect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      viewportWidth: window.innerWidth,
      childCount: children.length,
      innerWidth,
      copyWidth: copyRect.width,
      copyRight: copyRect.right,
      copyBottom: copyRect.bottom,
      buttonWidth: buttonRect.width,
      buttonLeft: buttonRect.left,
      buttonTop: buttonRect.top,
    };
  })()`);
}

async function assertTodayActionGeometry(cdp, mode) {
  const geometry = await todayActionGeometry(cdp);
  if (!geometry || geometry.childCount !== 2) throw new Error(`Today action card must have exactly two rendered children: ${JSON.stringify(geometry)}`);
  if (mode === "desktop") {
    if (geometry.viewportWidth !== VIEWPORT.width || geometry.copyWidth < geometry.innerWidth * 0.6 || geometry.buttonWidth > geometry.innerWidth * 0.4 || geometry.buttonLeft < geometry.copyRight) {
      throw new Error(`Today desktop action card geometry is not a 60/40 trailing-control layout: ${JSON.stringify(geometry)}`);
    }
    return;
  }
  if (geometry.viewportWidth !== 680 || geometry.copyWidth < geometry.innerWidth * 0.9 || geometry.buttonTop < geometry.copyBottom) {
    throw new Error(`Today mobile action card geometry does not stack full-width copy above the control: ${JSON.stringify(geometry)}`);
  }
}

async function assertDisclosureClear(cdp, controlSelector = "", disclosureSelector = ".launch-disclosure") {
  const result = await evaluate(cdp, `(() => {
    const candidates = [...new Set(document.querySelectorAll(${JSON.stringify(disclosureSelector)}))];
    const rendered = candidates.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    });
    const hitTestVisible = rendered.filter((element) => {
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      return document.elementsFromPoint(x, y).some((hit) => hit === element || hit.closest?.(${JSON.stringify(disclosureSelector)}) === element);
    });
    const banner = hitTestVisible[0];
    if (!banner) return { candidateCount: candidates.length, renderedCount: rendered.length, visibleCount: 0, missing: true };
    const bannerRect = banner.getBoundingClientRect();
    const visibleControls = ${controlSelector ? `[...document.querySelectorAll(${JSON.stringify(controlSelector)})]` : "[]"}
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ element, rect }) => {
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
    const collisions = visibleControls.filter(({ rect }) => !(
      bannerRect.right <= rect.left || bannerRect.left >= rect.right || bannerRect.bottom <= rect.top || bannerRect.top >= rect.bottom
    )).map(({ element }) => element.id || element.className || element.tagName);
    return {
      missing: false,
      candidateCount: candidates.length,
      renderedCount: rendered.length,
      visibleCount: hitTestVisible.length,
      withinViewport: bannerRect.left >= 0 && bannerRect.top >= 0 && bannerRect.right <= innerWidth && bannerRect.bottom <= innerHeight,
      collisions,
    };
  })()`);
  if (result.missing || result.visibleCount !== 1 || !result.withinViewport || result.collisions.length) throw new Error(`Illustrative disclosure is missing, duplicated, or obscures a capture control: ${JSON.stringify(result)}`);
}

async function assertCaptureStable(cdp, expectedScrollY = null) {
  const result = await evaluate(cdp, `(() => {
    document.activeElement?.blur();
    const view = document.querySelector(".view.active-view");
    const style = view ? getComputedStyle(view) : null;
    const runningAnimations = document.getAnimations().filter((animation) => ["pending", "running"].includes(animation.playState));
    return {
      guardInstalled: globalThis.__DRIFTGLASS_CAPTURE_STABILITY__ === true,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      scrollY,
      animationName: style?.animationName,
      animationDuration: style?.animationDuration,
      transitionDuration: style?.transitionDuration,
      transform: style?.transform,
      opacity: style?.opacity,
      runningAnimations: runningAnimations.length,
    };
  })()`);
  if (!result.guardInstalled || result.scrollBehavior !== "auto" || result.animationName !== "none" || result.animationDuration !== "0s" || result.transitionDuration !== "0s" || result.transform !== "none" || result.opacity !== "1" || result.runningAnimations !== 0) {
    throw new Error(`Dashboard capture still has time-dependent presentation state: ${JSON.stringify(result)}`);
  }
  if (expectedScrollY !== null && result.scrollY !== expectedScrollY) throw new Error(`Dashboard capture scroll position is ${result.scrollY}, expected ${expectedScrollY}`);
}

function isLocalCaptureResource(value, allowedOrigin) {
  try {
    const url = new URL(value);
    return url.origin === allowedOrigin || url.protocol === "data:";
  } catch {
    return false;
  }
}

async function assertLoopbackPage(cdp, baseUrl, observedRequests, blockedRequests) {
  const allowedOrigin = new URL(baseUrl).origin;
  const unexpected = await evaluate(cdp, `(() => {
    const allowedOrigin = ${JSON.stringify(allowedOrigin)};
    const urls = [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name), ...performance.getEntriesByType("navigation").map((entry) => entry.name)];
    return [...new Set(urls)].filter((value) => { try { const url = new URL(value); return url.origin !== allowedOrigin && url.protocol !== "data:"; } catch { return true; } });
  })()`);
  const observedUnexpected = observedRequests.filter((value) => !isLocalCaptureResource(value, allowedOrigin));
  const allUnexpected = [...new Set([...unexpected, ...observedUnexpected, ...blockedRequests])];
  if (allUnexpected.length) throw new Error(`Capture attempted a non-loopback resource: ${allUnexpected.join(", ")}`);
}

async function renderWalkthroughFrames(cdp, baseUrl, observedRequests, blockedRequests) {
  await rm(WALKTHROUGH_FRAME_DIRECTORY, { recursive: true, force: true });
  await mkdir(WALKTHROUGH_FRAME_DIRECTORY, { recursive: true });
  await openDashboard(cdp, baseUrl, "/walkthrough");
  await waitForExpression(cdp, `document.querySelector('.story-open[data-story="${hormuzStory.id}"]') && document.body.innerText.includes("Robin used lab results to propose what to test next")`, "walkthrough Today view");
  await normalizeDocumentTop(cdp);
  await installWalkthroughOverlay(cdp);

  const aiOpen = await elementCenter(cdp, `.story-open[data-story="${aiScienceStory.id}"]`, { x: 1338, y: 480 });
  const hormuzOpen = await elementCenter(cdp, `.story-open[data-story="${hormuzStory.id}"]`, { x: 1338, y: 332 });
  const missionsNav = await elementCenter(cdp, '[data-view="missions"]', { x: 92, y: 148 });
  const openingRest = { x: 118, y: 700 };
  let cursor = openingRest;
  let motion = { from: openingRest, to: aiOpen, start: 0.15, end: 0.9 };
  let clickAt = -10;
  let aiStoryOpened = false;
  let aiStoryClosed = false;
  let storyOpened = false;
  let storyClosed = false;
  let closeMotionStarted = false;
  let missionsOpened = false;
  let workspaceOpened = false;
  let currentAnswerOpened = false;
  let historyOpened = false;
  let normalizationSignalsOpened = false;
  let finalAnswerOpened = false;
  let sourcesOpened = false;
  let sourcesClosed = false;
  let finalScrollMaximum = 0;
  let sourceScrollStart = 0;
  let sourceScrollMaximum = 0;
  let expectedScrollY = 0;

  const beginMotion = (to, time, duration = 1) => {
    cursor = motion && time < motion.end
      ? interpolatePoint(motion.from, motion.to, (time - motion.start) / Math.max(0.001, motion.end - motion.start))
      : motion?.to || cursor;
    motion = { from: cursor, to, start: time, end: time + duration };
  };

  const moveCursor = (time) => {
    if (!motion) return cursor;
    if (time <= motion.start) return motion.from;
    if (time >= motion.end) return motion.to;
    return interpolatePoint(motion.from, motion.to, (time - motion.start) / (motion.end - motion.start));
  };

  const frameCount = WALKTHROUGH_DURATION_SECONDS * WALKTHROUGH_CAPTURE_FPS;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / WALKTHROUGH_CAPTURE_FPS;

    if (!aiStoryOpened && time >= 0.55) {
      cursor = await dispatchClick(cdp, `.story-open[data-story="${aiScienceStory.id}"]`);
      clickAt = time;
      await waitForExpression(cdp, `document.querySelector("#story-dialog[open]") && document.body.innerText.includes(${JSON.stringify(AI_SCIENCE_SOURCE_TITLES[0])}) && document.body.innerText.includes(${JSON.stringify(AI_SCIENCE_SOURCE_TITLES[1])})`, "walkthrough AI-science update");
      aiStoryOpened = true;
      const closePoint = await elementCenter(cdp, "#story-dialog .dialog-close", { x: 1370, y: 52 });
      beginMotion(closePoint, time + 0.03, 0.68);
    }

    if (aiStoryOpened && !aiStoryClosed && time >= 1.4) {
      cursor = await dispatchClick(cdp, "#story-dialog .dialog-close");
      clickAt = time;
      await waitForExpression(cdp, '!document.querySelector("#story-dialog[open]")', "closed walkthrough AI-science update");
      aiStoryClosed = true;
      beginMotion(hormuzOpen, time + 0.03, 0.36);
    }

    if (!storyOpened && time >= 1.85) {
      cursor = await dispatchClick(cdp, `.story-open[data-story="${hormuzStory.id}"]`);
      clickAt = time;
      await waitForExpression(cdp, `document.querySelector("#story-dialog[open]") && document.body.innerText.includes(${JSON.stringify(HORMUZ_SOURCE_TITLES[0])})`, "walkthrough Hormuz update");
      storyOpened = true;
      beginMotion({ x: 930, y: 640 }, time + 0.04, 0.42);
    }

    if (storyOpened && !storyClosed && !closeMotionStarted && time >= 2.35) {
      beginMotion({ x: 1370, y: 52 }, time, 0.56);
      closeMotionStarted = true;
    }

    if (!storyClosed && time >= 3.05) {
      cursor = await dispatchClick(cdp, "#story-dialog .dialog-close");
      clickAt = time;
      await waitForExpression(cdp, '!document.querySelector("#story-dialog[open]")', "closed walkthrough Story");
      storyClosed = true;
      beginMotion(missionsNav, time + 0.02, 0.28);
    }

    if (!missionsOpened && time >= 3.4) {
      cursor = await dispatchClick(cdp, '[data-view="missions"]');
      clickAt = time;
      await waitForExpression(cdp, 'document.querySelector("#missions.active-view") && document.querySelector(".mission-computer") && document.querySelector(".mission-sprint")?.textContent.trim() === "Check for updates"', "walkthrough Mission list");
      missionsOpened = true;
      const workspacePoint = await elementCenter(cdp, ".mission-computer", { x: 1160, y: 650 });
      beginMotion(workspacePoint, time + 0.04, 0.5);
    }

    if (!workspaceOpened && time >= 4.05) {
      cursor = await dispatchClick(cdp, ".mission-computer");
      clickAt = time;
      await waitForExpression(cdp, 'document.querySelector("#story-dialog[open] #computer-preview")?.innerText.includes("Carrier traffic is recovering")', "walkthrough Mission workspace");
      workspaceOpened = true;
      const currentAnswerPoint = await elementCenter(cdp, '[data-computer-file="/results/Current-answer.md"]', { x: 250, y: 430 });
      beginMotion(currentAnswerPoint, time + 0.04, 0.54);
    }

    if (!currentAnswerOpened && time >= 4.85) {
      cursor = await dispatchClick(cdp, '[data-computer-file="/results/Current-answer.md"]');
      clickAt = time;
      await waitForExpression(cdp, 'document.querySelector("#computer-preview-path")?.textContent === "Current answer"', "walkthrough current answer file");
      currentAnswerOpened = true;
      const historyPoint = await elementCenter(cdp, '[data-computer-file="/memory/timeline.md"]', { x: 245, y: 330 });
      beginMotion(historyPoint, time + 0.04, 0.55);
    }

    if (!historyOpened && time >= 5.7) {
      cursor = await dispatchClick(cdp, '[data-computer-file="/memory/timeline.md"]');
      clickAt = time;
      await waitForExpression(cdp, 'document.querySelector("#computer-preview-path")?.textContent === "How this changed"', "walkthrough Mission history");
      historyOpened = true;
      const normalizationPoint = await elementCenter(cdp, '[data-computer-file="/notes/Normalization-signals.md"]', { x: 250, y: 520 });
      beginMotion(normalizationPoint, time + 0.04, 0.56);
    }

    if (!normalizationSignalsOpened && time >= 6.55) {
      cursor = await dispatchClick(cdp, '[data-computer-file="/notes/Normalization-signals.md"]');
      clickAt = time;
      await waitForExpression(cdp, 'document.querySelector("#computer-preview-path")?.textContent === "Normalization signals"', "walkthrough normalization signals");
      normalizationSignalsOpened = true;
      beginMotion({ x: 930, y: 520 }, time + 0.04, 0.78);
    }

    if (!finalAnswerOpened && time >= WALKTHROUGH_MODEL_INSERT_END_SECONDS) {
      await goto(cdp, `${baseUrl}/work/final-answer.html`);
      await waitForExpression(cdp, 'document.querySelector("article.brief") && document.body.innerText.includes("Hormuz traffic is recovering, but LNG supply has not normalized")', "walkthrough saved answer");
      await evaluate(cdp, "document.fonts ? document.fonts.ready.then(() => true) : true");
      await installWalkthroughOverlay(cdp, { finalAnswer: true });
      finalScrollMaximum = await evaluate(cdp, 'Math.max(0, document.scrollingElement.scrollHeight - innerHeight)');
      if (finalScrollMaximum < 320) throw new Error(`Saved-answer walkthrough has too little scroll range: ${finalScrollMaximum}`);
      expectedScrollY = 0;
      finalAnswerOpened = true;
      cursor = { x: 250, y: 330 };
      const citationPoint = await elementCenter(cdp, ".synthesis-lead .citation-ref", { x: 250, y: 500 });
      beginMotion(citationPoint, time + 0.04, 0.95);
    }

    if (finalAnswerOpened && time >= 22 && time < 22.65) {
      const progress = ease((time - 22) / 0.65);
      expectedScrollY = Math.round(finalScrollMaximum * 0.48 * progress);
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
      if (time < 22.15) beginMotion({ x: 1060, y: 470 }, time, 0.9);
    }

    if (finalAnswerOpened && time >= 24.2 && time < 24.85) {
      const progress = ease((time - 24.2) / 0.65);
      const start = finalScrollMaximum * 0.48;
      expectedScrollY = Math.round(start + finalScrollMaximum * 0.34 * progress);
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
      if (time < 24.35) beginMotion({ x: 720, y: 650 }, time, 0.9);
    }

    if (finalAnswerOpened && !sourcesOpened && time >= 26.4 && time < 26.9) {
      const progress = ease((time - 26.4) / 0.5);
      const start = finalScrollMaximum * 0.82;
      expectedScrollY = Math.round(start + (finalScrollMaximum - start) * progress);
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
    }

    if (finalAnswerOpened && !sourcesOpened && time >= 26.95) {
      await evaluate(cdp, 'window.scrollTo({ top: document.scrollingElement.scrollHeight, left: 0, behavior: "instant" })');
      cursor = await dispatchClick(cdp, "details.evidence summary");
      clickAt = time;
      sourcesOpened = true;
      const sourceScroll = await evaluate(cdp, '({ start: scrollY, maximum: Math.max(0, document.scrollingElement.scrollHeight - innerHeight) })');
      sourceScrollStart = sourceScroll.start;
      sourceScrollMaximum = sourceScroll.maximum;
      expectedScrollY = sourceScrollStart;
      beginMotion({ x: 610, y: 610 }, time + 0.04, 0.8);
    }

    if (sourcesOpened && !sourcesClosed && time >= 27.2 && time < 27.9) {
      const progress = ease((time - 27.2) / 0.7);
      expectedScrollY = Math.round(sourceScrollStart + (sourceScrollMaximum - sourceScrollStart) * progress);
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
    }

    if (sourcesOpened && !sourcesClosed && time >= 30) {
      expectedScrollY = Math.round(sourceScrollStart);
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
      cursor = await dispatchClick(cdp, "details.evidence summary");
      clickAt = time;
      sourcesClosed = true;
    }

    if (finalAnswerOpened && time >= 30.3 && time < 30.95) {
      const progress = ease((time - 30.3) / 0.65);
      expectedScrollY = Math.round(finalScrollMaximum * (1 - progress));
      await evaluate(cdp, `window.scrollTo({ top: ${expectedScrollY}, left: 0, behavior: "instant" })`);
      if (time < 30.45) beginMotion({ x: 265, y: 505 }, time, 0.82);
    }

    if (finalAnswerOpened && time >= 30.95 && time < 31.1) {
      await evaluate(cdp, 'window.scrollTo({ top: 0, left: 0, behavior: "instant" })');
      expectedScrollY = 0;
      const citationPoint = await elementCenter(cdp, ".synthesis-lead .citation-ref", { x: 310, y: 500 });
      beginMotion(citationPoint, time, 2.7);
    }

    cursor = moveCursor(time);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cursor.x, y: cursor.y });
    const rippleProgress = time >= clickAt && time < clickAt + 0.38 ? (time - clickAt) / 0.38 : null;
    const captionText = walkthroughCaptionAt(time);
    const overlayState = await setWalkthroughOverlay(cdp, {
      point: cursor,
      caption: captionText,
      disclosureVisible: !finalAnswerOpened && time < 2.5,
      rippleProgress,
    });
    if (captionText && !overlayState?.captionVisible) throw new Error(`Walkthrough caption is hidden at ${time.toFixed(2)}s`);
    const settledFrame = await evaluate(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      scrollY,
      scrollMaximum: Math.max(0, document.scrollingElement.scrollHeight - innerHeight),
    }))))`);
    if (finalAnswerOpened) {
      const expectedScrollMaximum = sourcesOpened && !sourcesClosed ? sourceScrollMaximum : finalScrollMaximum;
      if (settledFrame.scrollY !== expectedScrollY || settledFrame.scrollMaximum !== expectedScrollMaximum) {
        throw new Error(`Walkthrough frame ${frame} did not settle at deterministic geometry: ${JSON.stringify({ settledFrame, expectedScrollY, expectedScrollMaximum })}`);
      }
    }
    await screenshot(cdp, path.join(WALKTHROUGH_FRAME_DIRECTORY, `frame-${String(frame).padStart(4, "0")}.png`));
  }

  await assertLoopbackPage(cdp, baseUrl, observedRequests, blockedRequests);
  return { frameCount, durationSeconds: WALKTHROUGH_DURATION_SECONDS };
}

async function fileExists(filename) {
  try {
    await access(filename, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const visionOcrSource = `
import Foundation
import Vision

for filename in CommandLine.arguments.dropFirst() {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .fast
  request.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: filename), options: [:])
  do {
    try handler.perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
    print(filename + "\\t" + Data(text.utf8).base64EncodedString())
  } catch {
    FileHandle.standardError.write(Data(("OCR failed for " + filename + ": " + error.localizedDescription + "\\n").utf8))
    exit(2)
  }
}
`;

async function ocrModelInsertFrames(framePaths) {
  if (process.platform !== "darwin") throw new Error("A pinned model insert requires the frame-by-frame OCR helper on macOS");
  const helperSource = path.join(MODEL_PRIVACY_DIRECTORY, "vision-ocr.swift");
  const helperBinary = path.join(MODEL_PRIVACY_DIRECTORY, "vision-ocr");
  const moduleCache = path.join(MODEL_PRIVACY_DIRECTORY, "swift-module-cache");
  await mkdir(moduleCache, { recursive: true });
  await writeFile(helperSource, visionOcrSource);
  await execFile("swiftc", [helperSource, "-framework", "Vision", "-o", helperBinary], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULE_CACHE_PATH: moduleCache },
    maxBuffer: 16 * 1024 * 1024,
  });
  const { stdout } = await execFile(helperBinary, framePaths, { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const records = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error("The model-insert OCR helper returned an invalid record");
    return { path: line.slice(0, separator), text: Buffer.from(line.slice(separator + 1), "base64").toString("utf8") };
  });
  if (records.length !== framePaths.length) throw new Error(`Model-insert OCR covered ${records.length}/${framePaths.length} frames`);
  return records;
}

async function makeModelInsertContactSheets(input, frameCount) {
  const contactDirectory = path.join(MODEL_PRIVACY_DIRECTORY, "contact-sheets");
  await mkdir(contactDirectory, { recursive: true });
  const framesPerSheet = 40;
  const sheetCount = Math.ceil(frameCount / framesPerSheet);
  for (let sheet = 0; sheet < sheetCount; sheet += 1) {
    const first = sheet * framesPerSheet;
    const last = Math.min(frameCount - 1, first + framesPerSheet - 1);
    await execFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-vf", `select='between(n,${first},${last})',scale=280:175,tile=5x8:padding=4:margin=4`,
      "-frames:v", "1",
      path.join(contactDirectory, `sheet-${String(sheet + 1).padStart(2, "0")}.png`),
    ], { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  }
  return { contactDirectory, sheetCount };
}

function modelInsertApprovalProposal(insertSha256, reviewedFrameCount) {
  return {
    insertSha256,
    reviewedFrameCount,
    conversationOnly: true,
    noBrowserChrome: true,
    noSidebar: true,
    noAccountUi: true,
    noOtherChats: true,
  };
}

export async function loadApprovedModelInsertBinding({
  insertPath = MODEL_INSERT_PATH,
  approvalPath = MODEL_INSERT_APPROVAL_PATH,
  reviewedFrameCount = Math.round(WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS * WALKTHROUGH_OUTPUT_FPS),
} = {}) {
  let insertBuffer;
  try {
    insertBuffer = await readFile(insertPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(`The approved model insert is required for the ${WALKTHROUGH_DURATION_SECONDS}-second walkthrough contract: ${insertPath}`);
  }
  let approval;
  try {
    approval = JSON.parse(await readFile(approvalPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(`The approved model insert requires its hash-bound approval: ${approvalPath}`);
  }
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw new Error(`Pinned model insert approval must be a JSON object: ${approvalPath}`);
  }
  const insertSha256 = sha256(insertBuffer);
  const proposal = modelInsertApprovalProposal(insertSha256, reviewedFrameCount);
  for (const [key, value] of Object.entries(proposal)) {
    if (approval[key] !== value) throw new Error(`Pinned model insert approval does not bind ${key} to ${JSON.stringify(value)}`);
  }
  return {
    insertSha256,
    approval,
    manifestBinding: modelInsertManifestBinding({ modelInsertSha256: insertSha256, modelInsertApproval: approval }),
  };
}

async function validatePinnedModelInsert({ requireApproval = true } = {}) {
  if (!await fileExists(MODEL_INSERT_PATH)) {
    throw new Error(`The approved model insert is required for the ${WALKTHROUGH_DURATION_SECONDS}-second walkthrough contract: ${MODEL_INSERT_PATH}`);
  }
  const { stdout: probeRaw } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate", "-of", "json", MODEL_INSERT_PATH,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(probeRaw);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(probe.format?.duration);
  if (!video || probe.streams.some((stream) => stream.codec_type === "audio") || Math.abs(duration - WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS) > 0.05 || video.width < 900 || video.height < 500 || video.r_frame_rate !== "30/1") {
    throw new Error(`Pinned model insert must be a silent ${WALKTHROUGH_MODEL_INSERT_DURATION_SECONDS}-second, 30 fps conversation-only crop: ${JSON.stringify(probe)}`);
  }

  await rm(MODEL_PRIVACY_DIRECTORY, { recursive: true, force: true });
  const frameDirectory = path.join(MODEL_PRIVACY_DIRECTORY, "frames");
  await mkdir(frameDirectory, { recursive: true });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", MODEL_INSERT_PATH, "-vf", "fps=30", path.join(frameDirectory, "frame-%04d.png"),
  ], { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  const framePaths = (await readdir(frameDirectory)).filter((filename) => filename.endsWith(".png")).sort().map((filename) => path.join(frameDirectory, filename));
  const expectedFrames = Math.round(duration * 30);
  if (framePaths.length < expectedFrames - 1 || framePaths.length > expectedFrames + 1) throw new Error(`Pinned model insert extracted ${framePaths.length} frames; expected ${expectedFrames}`);

  const ocrRecords = await ocrModelInsertFrames(framePaths);
  const ocrText = ocrRecords.map((record) => record.text).join("\n");
  await writeFile(path.join(MODEL_PRIVACY_DIRECTORY, "ocr-report.json"), `${JSON.stringify(ocrRecords.map((record) => ({ frame: path.basename(record.path), text: record.text })), null, 2)}\n`);
  const bannedPatterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:Search chats|Yesterday|Previous 7 Days|Previous 30 Days|Explore GPTs|Upgrade plan|Settings|Archived chats)\b/i,
    /\b(?:chatgpt\.com|New Tab|Temporary Chat)\b/i,
    /\b(?:Demo|sample)\b/i,
  ];
  for (const pattern of bannedPatterns) {
    if (pattern.test(ocrText)) throw new Error(`Pinned model insert OCR matched private or banned UI text: ${pattern}`);
  }
  const normalizedOcrText = ocrText.replace(/\s+/g, " ").toLowerCase();
  if (!["driftglass", "personal", "sources"].every((term) => normalizedOcrText.includes(term))) throw new Error("Pinned model insert OCR did not find the connected Driftglass source panel");
  if (!["deliverable power", "business consequences"].every((term) => normalizedOcrText.includes(term))) throw new Error("Pinned model insert OCR did not find the analyzed Mission content");
  for (const section of ["causal chain", "structural versus temporary", "strongest alternative explanation", "three signals that would change the conclusion"]) {
    if (!normalizedOcrText.includes(section)) throw new Error(`Pinned model insert OCR did not find the analysis section: ${section}`);
  }
  const contacts = await makeModelInsertContactSheets(MODEL_INSERT_PATH, framePaths.length);
  const insertBuffer = await readFile(MODEL_INSERT_PATH);
  const insertSha256 = sha256(insertBuffer);
  const approvalProposal = modelInsertApprovalProposal(insertSha256, framePaths.length);
  if (!requireApproval) {
    return { duration, insertSha256, frameCount: framePaths.length, approvalProposal, ...contacts };
  }
  const binding = await loadApprovedModelInsertBinding({ reviewedFrameCount: framePaths.length });
  return { duration, insertSha256, approval: binding.approval, manifestBinding: binding.manifestBinding, frameCount: framePaths.length, ...contacts };
}

export async function reviewPinnedModelInsert() {
  return validatePinnedModelInsert({ requireApproval: false });
}

async function buildVideo({ previewOnly = false } = {}) {
  const baseCandidate = path.join(LAUNCH_WORK_DIRECTORY, `walkthrough-base-${process.pid}.mp4`);
  const insertCandidate = path.join(LAUNCH_WORK_DIRECTORY, `walkthrough-insert-${process.pid}.mp4`);
  const audioCandidate = path.join(LAUNCH_WORK_DIRECTORY, `walkthrough-audio-${process.pid}.mp4`);
  const scorePath = path.join(LAUNCH_WORK_DIRECTORY, `walkthrough-score-${process.pid}.wav`);
  const output = previewOnly ? WALKTHROUGH_PREVIEW_PATH : path.join(LAUNCH_DIRECTORY, "walkthrough.mp4");
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(WALKTHROUGH_CAPTURE_FPS), "-i", path.join(WALKTHROUGH_FRAME_DIRECTORY, "frame-%04d.png"),
    "-vf", `fps=${WALKTHROUGH_OUTPUT_FPS},format=yuv420p`,
    "-map_metadata", "-1", "-r", String(WALKTHROUGH_OUTPUT_FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "24",
    "-pix_fmt", "yuv420p", "-threads", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
    "-movflags", "+faststart+use_metadata_tags",
    "-metadata", "creation_time=2026-08-10T14:00:00Z",
    "-metadata", "title=Driftglass 0.9.0 walkthrough",
    baseCandidate,
  ], { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });

  const modelInsert = await validatePinnedModelInsert();
  const insertSlotStart = WALKTHROUGH_MODEL_INSERT_START_SECONDS;
  const filter = [
    `[1:v]trim=start=0:end=${modelInsert.duration.toFixed(6)},setpts=PTS-STARTPTS+${insertSlotStart}/TB,scale=1200:700:force_original_aspect_ratio=decrease,pad=1200:700:(ow-iw)/2:(oh-ih)/2:color=0x111318,format=yuv420p[chat]`,
    `[0:v][chat]overlay=x=120:y=70:eof_action=pass:shortest=0,format=yuv420p[outv]`,
  ].join(";");
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", baseCandidate, "-i", MODEL_INSERT_PATH,
    "-filter_complex", filter, "-map", "[outv]", "-map_metadata", "-1",
    "-r", String(WALKTHROUGH_OUTPUT_FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "24",
    "-pix_fmt", "yuv420p", "-threads", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
    "-movflags", "+faststart+use_metadata_tags",
    "-metadata", "creation_time=2026-08-10T14:00:00Z",
    "-metadata", "title=Driftglass 0.9.0 walkthrough",
    insertCandidate,
  ], { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  let candidate = insertCandidate;

  await writeWalkthroughMusic(scorePath, { durationSeconds: WALKTHROUGH_DURATION_SECONDS });
  await execFile("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", candidate, "-i", scorePath,
    "-filter_complex", `[1:a]volume=0.65,aresample=${WALKTHROUGH_AUDIO_SAMPLE_RATE}:first_pts=0[outa]`,
    "-map", "0:v:0", "-map", "[outa]", "-map_metadata", "-1",
    "-c:v", "copy", "-c:a", WALKTHROUGH_AUDIO_CODEC, "-profile:a", "aac_low", "-b:a", String(WALKTHROUGH_AUDIO_BIT_RATE),
    "-ar", String(WALKTHROUGH_AUDIO_SAMPLE_RATE), "-ac", String(WALKTHROUGH_AUDIO_CHANNELS), "-threads:a", "1",
    "-t", String(WALKTHROUGH_DURATION_SECONDS), "-fflags", "+bitexact", "-flags:a", "+bitexact",
    "-movflags", "+faststart+use_metadata_tags",
    "-metadata", "creation_time=2026-08-10T14:00:00Z",
    "-metadata", "title=Driftglass 0.9.0 walkthrough",
    audioCandidate,
  ], { cwd: REPOSITORY_ROOT, maxBuffer: 16 * 1024 * 1024 });
  const videoOnlyCandidate = candidate;
  candidate = audioCandidate;

  const { stdout: probeRaw } = await execFile("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels", "-of", "json", candidate,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(probeRaw);
  const video = probe.streams?.find((stream) => stream.codec_name === "h264");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  if (!video || video.width !== VIEWPORT.width || video.height !== VIEWPORT.height || video.pix_fmt !== "yuv420p" || video.r_frame_rate !== "30/1"
    || !audio || audio.codec_name !== WALKTHROUGH_AUDIO_CODEC || audio.profile !== WALKTHROUGH_AUDIO_PROFILE || Number(audio.sample_rate) !== WALKTHROUGH_AUDIO_SAMPLE_RATE || audio.channels !== WALKTHROUGH_AUDIO_CHANNELS
    || Math.abs(duration - WALKTHROUGH_DURATION_SECONDS) > 0.05) {
    throw new Error(`Encoded walkthrough candidate failed validation: ${JSON.stringify(probe)}`);
  }
  await rm(output, { force: true });
  await rename(candidate, output);
  await Promise.all([
    rm(baseCandidate, { force: true }),
    rm(insertCandidate, { force: true }),
    rm(videoOnlyCandidate, { force: true }),
    rm(scorePath, { force: true }),
  ]);
  await rm(WALKTHROUGH_FRAME_DIRECTORY, { recursive: true, force: true });
  return { output, modelInsert };
}

async function validateFinalCaptureMedia({ videoPath = path.join(LAUNCH_DIRECTORY, "walkthrough.mp4") } = {}) {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const filename of ["01-today.png", "02-mission-computer.png", "03-final-answer.png", "04-public-card.png"]) {
    const buffer = await readFile(path.join(LAUNCH_DIRECTORY, filename));
    const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 0;
    if (!buffer.subarray(0, 8).equals(pngSignature) || width !== VIEWPORT.width || height !== VIEWPORT.height) {
      throw new Error(`Captured media failed PNG validation: ${filename} (${width}x${height})`);
    }
  }
  const { stdout: probeRaw } = await execFile("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,profile,width,height,pix_fmt,sample_rate,channels",
    "-of", "json",
    videoPath,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(probeRaw);
  const video = probe.streams?.find((stream) => stream.codec_name === "h264");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  if (!video || video.width !== VIEWPORT.width || video.height !== VIEWPORT.height || video.pix_fmt !== "yuv420p"
    || !audio || audio.codec_name !== WALKTHROUGH_AUDIO_CODEC || audio.profile !== WALKTHROUGH_AUDIO_PROFILE || Number(audio.sample_rate) !== WALKTHROUGH_AUDIO_SAMPLE_RATE || audio.channels !== WALKTHROUGH_AUDIO_CHANNELS
    || Math.abs(duration - WALKTHROUGH_DURATION_SECONDS) > 0.05) {
    throw new Error(`Promoted walkthrough failed validation: ${JSON.stringify(probe)}`);
  }
}

export async function captureLaunchAssets({ previewOnly = process.env.WALKTHROUGH_PREVIEW_ONLY === "1" } = {}) {
  process.env.TZ = "UTC";
  await buildLaunchAssets();
  const approvedModelInsert = await loadApprovedModelInsertBinding();
  const captureFingerprint = previewOnly ? undefined : await computeLaunchCaptureInputFingerprint({
    modelInsertBinding: approvedModelInsert.manifestBinding,
  });
  await execFile("ffmpeg", ["-version"], { cwd: REPOSITORY_ROOT, maxBuffer: 4 * 1024 * 1024 });
  await Promise.all([
    mkdir(LAUNCH_WORK_DIRECTORY, { recursive: true }),
    mkdir(INTERMEDIATE_DIRECTORY, { recursive: true }),
  ]);
  await rm(PROFILE_DIRECTORY, { recursive: true, force: true });
  await mkdir(PROFILE_DIRECTORY, { recursive: true });
  const fixtureServer = await createFixtureServer();
  const allowedOrigin = new URL(fixtureServer.baseUrl).origin;
  const observedRequests = [];
  const blockedRequests = [];
  const interceptionErrors = [];
  let browser;
  let videoResult;
  try {
    browser = await launchChrome();
    const { cdp } = browser;
    cdp.on("Network.requestWillBeSent", ({ request }) => {
      if (request?.url) observedRequests.push(request.url);
    });
    cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
      const requestUrl = request?.url || "";
      const permitted = isLocalCaptureResource(requestUrl, allowedOrigin);
      const command = permitted
        ? cdp.send("Fetch.continueRequest", { requestId })
        : cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      if (!permitted) blockedRequests.push(requestUrl);
      command.catch((error) => interceptionErrors.push(error));
    });
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: fixedClockSource() });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: captureStabilitySource() });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });

    await openDashboard(cdp, fixtureServer.baseUrl, "/today");
    await waitForExpression(cdp, 'document.body.innerText.includes("Hormuz is reopening. LNG supply is not back to normal.") && document.body.innerText.includes("Robin used lab results to propose what to test next")', "multi-theme Today copy");
    await evaluate(cdp, `(() => {
      const section = document.querySelector(".action-center-section");
      const stats = document.querySelector("#stats");
      if (!section || !stats) return false;
      section.style.display = "none";
      stats.style.display = "none";
      return true;
    })()`);
    const todayCopy = await evaluate(cdp, "document.body.innerText");
    for (const required of [
      "Hormuz is reopening. LNG supply is not back to normal.",
      "Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier",
      "Production elsewhere was about 27 bcm higher",
      "Robin used lab results to propose what to test next",
      "Co-Scientist broadened hypothesis search",
      ILLUSTRATIVE_DISCLOSURE,
    ]) {
      if (!todayCopy.includes(required)) throw new Error(`Today capture is missing required copy: ${required}`);
    }
    if (todayCopy.includes("Needs your attention") || todayCopy.includes("Nothing needs your attention")) throw new Error("Today capture includes empty operational status instead of current intelligence");
    for (const removed of ["Reload", "Recent evidence", "· supported"]) {
      if (todayCopy.includes(removed)) throw new Error(`Today capture still includes removed status copy: ${removed}`);
    }
    const todayActions = await evaluate(cdp, '[...document.querySelectorAll(".topbar .top-actions button")].map((button) => button.textContent.trim())');
    if (JSON.stringify(todayActions) !== JSON.stringify(["Check sources", "Share Today", "Refresh Today"])) throw new Error(`Today actions are ${JSON.stringify(todayActions)}`);
    await normalizeDocumentTop(cdp);
    await assertDisclosureClear(cdp, ".topbar button, .story-open");
    await assertCaptureStable(cdp, 0);
    await assertLoopbackPage(cdp, fixtureServer.baseUrl, observedRequests, blockedRequests);
    if (interceptionErrors.length) throw interceptionErrors[0];
    await screenshot(cdp, path.join(LAUNCH_DIRECTORY, "01-today.png"));

    await openDashboard(cdp, fixtureServer.baseUrl, "/workspace");
    await click(cdp, '[data-view="missions"]');
    await click(cdp, ".mission-computer");
    await waitForExpression(cdp, 'document.querySelector("#story-dialog[open] #computer-preview")?.innerText.includes("Robin analyzed human-run assay results and proposed what to test next")', "AI science brief");
    await evaluate(cdp, `(() => {
      const dialog = document.querySelector("#story-dialog[open]");
      const style = document.createElement("style");
      style.textContent = [
        "#computer-preview{padding:14px 18px}",
        "#computer-preview h3{margin:8px 0 4px;font-size:17px}",
        "#computer-preview h4{margin:8px 0 3px;font-size:14px}",
        "#computer-preview p{margin:0 0 6px;font-size:14px;line-height:1.42}",
      ].join("");
      document.head.append(style);
      dialog.scrollTop = 0;
      window.scrollTo(0, 0);
      document.activeElement?.blur();
      const disclosure = document.querySelector(".launch-disclosure");
      if (!disclosure) return false;
      dialog.append(disclosure);
      disclosure.classList.add("dialog-disclosure");
      return true;
    })()`);
    const workspaceCopy = await evaluate(cdp, 'document.querySelector("#story-dialog").innerText');
    for (const required of [
      ILLUSTRATIVE_DISCLOSURE,
      "Where is AI shortening the scientific discovery cycle?",
      "Robin analyzed human-run assay results and proposed what to test next in one biomedical program",
      "Robin synthesized 551 papers in 30 minutes",
      "What still requires people",
      "People chose the candidates and ran every experiment",
      "An outside lab reproduces an AI-originated result.",
    ]) {
      if (!workspaceCopy.includes(required)) throw new Error(`Mission workspace capture is missing required copy: ${required}`);
    }
    const workspaceSearchLabel = await evaluate(cdp, 'document.querySelector("#computer-search-form input")?.getAttribute("aria-label")');
    if (workspaceSearchLabel !== "Search this workspace") throw new Error(`Mission workspace search label is ${JSON.stringify(workspaceSearchLabel)}`);
    const workspaceFrame = await evaluate(cdp, `(() => {
      const dialog = document.querySelector("#story-dialog[open]");
      const search = document.querySelector("#computer-search-form");
      const note = document.querySelector("#computer-note-form");
      const preview = document.querySelector("#computer-preview");
      search.style.display = "none";
      note.style.display = "none";
      const dialogRect = dialog.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      return {
        dialogBottom: dialogRect.bottom,
        previewBottom: previewRect.bottom,
        previewClientHeight: preview.clientHeight,
        previewScrollHeight: preview.scrollHeight,
        searchDisplay: getComputedStyle(search).display,
        noteDisplay: getComputedStyle(note).display,
      };
    })()`);
    if (workspaceFrame.noteDisplay !== "none" || workspaceFrame.searchDisplay !== "none" || workspaceFrame.previewBottom > workspaceFrame.dialogBottom - 24 || workspaceFrame.previewScrollHeight > workspaceFrame.previewClientHeight) {
      throw new Error(`Mission workspace does not end cleanly after the brief: ${JSON.stringify(workspaceFrame)}`);
    }
    await assertDisclosureClear(cdp, "#story-dialog button, #story-dialog input, #story-dialog summary");
    await assertCaptureStable(cdp, 0);
    await assertLoopbackPage(cdp, fixtureServer.baseUrl, observedRequests, blockedRequests);
    await screenshot(cdp, path.join(LAUNCH_DIRECTORY, "02-mission-computer.png"));

    await goto(cdp, `${fixtureServer.baseUrl}/work/final-answer.html`);
    await waitForExpression(cdp, 'document.querySelector("article.brief")', "Hormuz analysis brief");
    await evaluate(cdp, "document.fonts ? document.fonts.ready.then(() => true) : true");
    const finalAnswer = await evaluate(cdp, `(() => {
      const article = document.querySelector("article.brief");
      const details = document.querySelector("details.evidence");
      return { text: article.textContent, articleBottom: article.getBoundingClientRect().bottom, detailsOpen: details.open };
    })()`);
    for (const required of [
      "Analysis",
      "Hormuz and the 2026 gas shock",
      "Hormuz traffic is recovering, but LNG supply has not normalized",
      "Why this is happening",
      "Replacement supply narrowed the gap",
      "Damage outlasts reopening",
      "Asia's premium redirected flexible cargoes",
      "Alternative case",
      "What to watch",
      "Sources (3)",
    ]) {
      if (!finalAnswer.text.includes(required)) throw new Error(`Final-answer capture is missing required copy: ${required}`);
    }
    if (finalAnswer.detailsOpen || finalAnswer.articleBottom > VIEWPORT.height) throw new Error(`Final answer does not fit above the fold with sources collapsed: ${JSON.stringify(finalAnswer)}`);
    const finalAnswerDisclosure = await evaluate(cdp, 'document.querySelector(".illustrative-disclosure")?.textContent?.trim()');
    if (finalAnswerDisclosure !== ILLUSTRATIVE_DISCLOSURE) throw new Error(`Final-answer disclosure is ${JSON.stringify(finalAnswerDisclosure)}`);
    await assertDisclosureClear(cdp, "summary, a", ".illustrative-disclosure");
    await assertLoopbackPage(cdp, fixtureServer.baseUrl, observedRequests, blockedRequests);
    await screenshot(cdp, path.join(LAUNCH_DIRECTORY, "03-final-answer.png"));

    await goto(cdp, `${fixtureServer.baseUrl}/launch/hormuz-analysis.html`);
    await waitForExpression(cdp, 'document.querySelector(".reviewed-answer")', "public Hormuz analysis");
    await evaluate(cdp, "document.fonts ? document.fonts.ready.then(() => true) : true");
    await evaluate(cdp, `(() => {
      const style = document.createElement("style");
      style.textContent = [
        "main.portfolio-presentation{width:min(1240px,calc(100% - 32px));padding-top:10px}",
        ".portfolio-presentation .hero{padding:8px 0}",
        ".portfolio-presentation h1{font-size:38px;line-height:1.05}",
        ".portfolio-presentation .subtitle{font-size:15px;margin-top:5px}",
        ".portfolio-presentation .date{margin-top:5px}",
        ".portfolio-presentation .reviewed-answer{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;margin:9px 0;padding:15px 20px}",
        ".portfolio-presentation .reviewed-answer>.assessment,.portfolio-presentation .reviewed-answer>.answer,.portfolio-presentation .reviewed-answer>.review-details,.portfolio-presentation .reviewed-answer>.portfolio-download{grid-column:1/-1}",
        ".portfolio-presentation .reviewed-answer>.assessment{margin:0}",
        ".portfolio-presentation .reviewed-answer>.answer{font-size:18px;line-height:1.3;margin:0}",
        ".portfolio-presentation .reviewed-answer>div{min-width:0}",
        ".portfolio-presentation .reviewed-answer h3{margin:0 0 3px;font-size:13.5px}",
        ".portfolio-presentation .reviewed-answer p,.portfolio-presentation .reviewed-answer li{font-size:15.5px;line-height:1.4}",
        ".portfolio-presentation .reviewed-answer ul{margin:2px 0;padding-left:17px}",
        ".portfolio-presentation .reviewed-answer .review-details{margin-top:1px;padding-top:6px;font-size:12px}",
        ".portfolio-download{margin-top:1px;padding-top:7px}",
      ].join("");
      document.head.append(style);
      for (const section of document.querySelectorAll(".reviewed-answer > div")) {
        const heading = section.querySelector("h3")?.textContent?.trim();
        if (heading === "What this means" || heading === "Open questions") section.style.display = "none";
      }
      return true;
    })()`);
    const publicCard = await evaluate(cdp, `(() => {
      const answer = document.querySelector(".reviewed-answer");
      const download = document.querySelector(".portfolio-download");
      const sectionHeading = document.querySelector("main > .section-heading");
      const stories = document.querySelector("main > .stories");
      sectionHeading.style.display = "none";
      stories.style.display = "none";
      return {
        text: document.body.textContent,
        claimCitations: [...document.querySelectorAll(".claim-citations a")]
          .filter((link) => { const rect = link.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
          .map((link) => link.textContent.trim()),
        answerBottom: answer.getBoundingClientRect().bottom,
        downloadBottom: download?.getBoundingClientRect().bottom || 0,
        sectionHeadingDisplay: getComputedStyle(sectionHeading).display,
        storiesDisplay: getComputedStyle(stories).display,
      };
    })()`);
    for (const required of [
      "Has Hormuz reopened enough for the gas market to normalize?",
      "Bottom line",
      "Hormuz traffic is recovering, but LNG supply has not normalized",
      "Why this is happening",
      "Alternative case",
      "Signals to watch",
      "Download the brief",
    ]) {
      if (!publicCard.text.includes(required)) throw new Error(`Public-card capture is missing required copy: ${required}`);
    }
    if (JSON.stringify([...new Set(publicCard.claimCitations)]) !== JSON.stringify(["[1]", "[2]", "[3]"])) throw new Error(`Public-card claim citations are missing or hidden: ${JSON.stringify(publicCard.claimCitations)}`);
    if (!publicCard.downloadBottom || publicCard.answerBottom > VIEWPORT.height || publicCard.downloadBottom > VIEWPORT.height) throw new Error(`Public analysis or download action falls below the capture fold: ${JSON.stringify(publicCard)}`);
    if (publicCard.sectionHeadingDisplay !== "none" || publicCard.storiesDisplay !== "none") throw new Error(`Public-card source section is visible in the concise capture: ${JSON.stringify(publicCard)}`);
    if (publicCard.text.includes("Public evidence only.")) throw new Error("Public card repeats its illustrative disclosure as a privacy label");
    const publicCardDisclosure = await evaluate(cdp, 'document.querySelector(".illustrative-disclosure")?.textContent?.trim()');
    if (publicCardDisclosure !== ILLUSTRATIVE_DISCLOSURE) throw new Error(`Public-card disclosure is ${JSON.stringify(publicCardDisclosure)}`);
    await assertDisclosureClear(cdp, "summary, a", ".illustrative-disclosure");
    await assertLoopbackPage(cdp, fixtureServer.baseUrl, observedRequests, blockedRequests);
    await screenshot(cdp, path.join(LAUNCH_DIRECTORY, "04-public-card.png"));

    await renderWalkthroughFrames(cdp, fixtureServer.baseUrl, observedRequests, blockedRequests);
    if (interceptionErrors.length) throw interceptionErrors[0];
    videoResult = await buildVideo({ previewOnly });
  } finally {
    if (browser) await stopChrome(browser);
    await fixtureServer.close();
    await rm(PROFILE_DIRECTORY, { recursive: true, force: true });
  }
  if (!fixtureServer.requests.length || fixtureServer.requests.some((requestPath) => !requestPath.startsWith("/"))) throw new Error("Invalid fixture request log");
  await validateFinalCaptureMedia({ videoPath: videoResult.output });
  if (!previewOnly) {
    const currentModelInsert = await loadApprovedModelInsertBinding();
    const currentFingerprint = await computeLaunchCaptureInputFingerprint({ modelInsertBinding: currentModelInsert.manifestBinding });
    if (currentFingerprint !== captureFingerprint || JSON.stringify(videoResult.modelInsert.manifestBinding) !== JSON.stringify(approvedModelInsert.manifestBinding)) {
      throw new Error("Launch capture inputs changed while Chrome or the video encoder was running");
    }
  }
  const manifest = await writeLaunchManifest({
    captureComplete: !previewOnly,
    captureFingerprint,
    modelInsertBinding: previewOnly ? undefined : approvedModelInsert.manifestBinding,
  });
  process.stdout.write(`Captured ${manifest.artifacts.length} deterministic launch artifacts through Chrome CDP with a disposable loopback-only profile.\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--review-model-insert")) {
    const review = await reviewPinnedModelInsert();
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  } else if (process.argv.includes("--encode-preview")) {
    await buildLaunchAssets();
    await loadApprovedModelInsertBinding();
    const result = await buildVideo({ previewOnly: true });
    await validateFinalCaptureMedia({ videoPath: result.output });
    await writeLaunchManifest();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    await captureLaunchAssets();
  }
}
