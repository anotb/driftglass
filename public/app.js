const state = {
  secret: "",
  overview: null,
  packs: [],
  missions: [],
  missionRuns: [],
  integrations: null,
  capabilities: { fixed: [], catalog: [] },
  interests: [],
  receipts: [],
  shares: [],
  taste: { positiveTerms: [], negativeTerms: [], preferredSources: [], downweightedSources: [] },
  suggestions: [],
  packCategory: "All",
  pair: null,
  pairOs: /Win/i.test(navigator.platform) ? "windows" : /Linux/i.test(navigator.platform) ? "linux" : "macos",
  searchTimer: null,
  selectedAdapter: null,
  selectedMission: null,
  deepResearch: null,
  latestShare: null,
  pendingShare: null,
  actionCenter: { actions: [] },
  readiness: { score: 0, checks: [] },
  ingestDeadLetters: [],
  autopilot: [],
  pendingResearchResults: [],
  currentComputer: null,
  intelligence: { graph: {}, nodes: [], edges: [], timeline: [], proposals: [], packs: [], catalog: [], budget: null, playbooks: [], runs: [], recall: null },
  reasoningProviders: { providers: {}, mcpUrl: "", operationsMcpUrl: "" },
  reasoningConnections: { available: false, connections: [] },
  reasoningBundle: null,
  currentReasoningReceipt: null,
  currentReasoningComparison: null,
  currentDossier: null,
  memoryCheckpoints: [],
  memoryCheckpointDiff: null,
  runtime: { context: {}, capabilities: [] },
  judgment: { summary: {}, reasoningInbox: [], receipts: [], reasoningRuns: [], decisions: [], dueDecisionReviews: [], routines: [], routineRuns: [], sourceScorecards: [], cadence: [], overlays: [], lineage: [] },
  pendingPackPreview: null,
  memoryAudit: null,
  packUpdates: [],
  pendingLensUrl: new URL(location.href).searchParams.get("lens") || "",
  pendingPackUrl: new URL(location.href).searchParams.get("pack") || "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function apiPath(value) {
  const url = new URL(String(value || ""), location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("Refused an invalid API destination");
  }
  return `${url.pathname}${url.search}`;
}

function toast(message, tone = "normal") {
  const node = $("#toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${state.secret}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(apiPath(path), { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function apiText(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${state.secret}`);
  const response = await fetch(apiPath(path), { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return response.text();
}

async function apiBlob(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${state.secret}`);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(apiPath(path), { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.DriftglassApi = {
  request: api,
  requestText: apiText,
  isUnlocked: () => Boolean(state.secret),
  openStory: (id) => openStory(id),
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function supportLabel(value) {
  const confidence = Number(value || 0);
  if (confidence >= .85) return "strongly supported";
  if (confidence >= .65) return "supported";
  return "tentative";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function readableExcerpt(value, maxLength = 420) {
  const source = String(value || "").trim();
  if (!source) return "";
  const decoded = source
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(value, 16) || 32)))
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(value, 10) || 32)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity.toLowerCase()] || " ");
  const plain = decoded
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*~]+/g, "")
    .replace(/(^|\s)[#>*_`~-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeHref(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch { return ""; }
}

function lines(value) {
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function parseJsonSafe(value, fallback = null) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function reasoningResultPayload(data, rawResponse, structured, memoryPatch) {
  const structuredRecord = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : null;
  const summary = typeof structuredRecord?.summary === "string" ? structuredRecord.summary : data.summary || undefined;
  const citations = Array.isArray(structuredRecord?.citations) ? structuredRecord.citations : undefined;
  const confidence = typeof structuredRecord?.confidence === "number" ? structuredRecord.confidence : Number(data.confidence || 0.5);
  return {
    provider: data.provider,
    model: data.model || undefined,
    client: "driftglass-dashboard",
    response: rawResponse,
    summary,
    confidence,
    structuredResult: structuredRecord || undefined,
    memoryPatch,
    ...(citations === undefined ? {} : { citations }),
  };
}

function durationLabel(minutes) {
  const value = Number(minutes || 0);
  if (value >= 10080 && value % 10080 === 0) return `${value / 10080}w`;
  if (value >= 1440 && value % 1440 === 0) return `${value / 1440}d`;
  if (value >= 60 && value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
}

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadText(filename, value, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function setView(name) {
  const valid = ["today", "missions", "memory", "sources", "capture", "companion", "browser", "integrations", "system"];
  if (!valid.includes(name)) name = "today";
  $$(".view").forEach((view) => view.classList.toggle("active-view", view.id === name));
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const titles = {
    today: ["Questions you follow", "Today"],
    missions: ["Persistent questions", "Your Missions"],
    memory: ["What Driftglass remembers", "Memory"],
    sources: ["Choose what earns your attention", "Sources & Packs"],
    capture: ["Save a source", "Capture"],
    companion: ["Your signed-in web", "Companion"],
    browser: ["Read difficult public pages", "Browse Lab"],
    integrations: ["Use the model you already trust", "Reasoning"],
    system: ["Private, portable, understandable", "Setup"],
  };
  $("#view-eyebrow").textContent = titles[name][0];
  $("#view-title").textContent = titles[name][1];
  location.hash = name;
}

function renderStats() {
  const overview = state.overview || {};
  const missions = state.missions || [];
  const storyCount = (overview.stories || []).length;
  const activeMissionCount = missions.filter((mission) => mission.status === "active").length;
  const summary = storyCount
    ? `${storyCount} current update${storyCount === 1 ? "" : "s"}.${activeMissionCount ? ` ${activeMissionCount} active Mission${activeMissionCount === 1 ? "" : "s"}.` : ""}`
    : "No current updates.";
  $("#stats").className = "today-summary";
  $("#stats").innerHTML = `<p>${escapeHtml(summary)}</p>`;
  $("#onboarding").hidden = Boolean(
    (overview.stories || []).length
    || (overview.packInstalls || []).length
    || missions.length,
  );
}

function renderRenderStrip() {
  const target = $("#render-strip");
  if (!target) return;
  const rendering = state.overview?.renderStats || { totals: [], profiles: [] };
  const metric = (engine, status) => Number((rendering.totals || []).find((row) => row.engine === engine && row.status === status)?.attempts || 0);
  const kiteSuccess = metric("kitesurf", "success");
  const kiteFailure = metric("kitesurf", "failed");
  const chromium = metric("chromium", "success");
  const kiteRate = kiteSuccess + kiteFailure ? Math.round(kiteSuccess / (kiteSuccess + kiteFailure) * 100) : 0;
  target.innerHTML = `<div><span class="pulse-dot"></span><strong>Page reader</strong></div><span>Direct read first</span><span>Kitesurf ${kiteSuccess ? `${kiteRate}% success` : "ready"}</span><span>Chromium fallbacks ${chromium}</span><span>${(rendering.profiles || []).length} learned site${(rendering.profiles || []).length === 1 ? "" : "s"}</span>`;
}

function renderStories(stories = state.overview?.stories || []) {
  const element = $("#stories");
  if (!stories.length) {
    element.className = "story-list empty-state";
    element.innerHTML = `<strong>No updates in Today.</strong><span>Check sources, or start a Mission about AI research, energy markets, or a supply chain you follow.</span>`;
    return;
  }
  element.className = "story-list";
  element.innerHTML = stories.map((story) => {
    const title = readableExcerpt(story.title, 180);
    const summary = readableExcerpt(story.summary, 420);
    const usefulSummary = summary && summary.toLowerCase() !== title.toLowerCase() ? summary : "";
    return `<article class="story">
      <div class="story-body"><h4>${escapeHtml(title)}</h4>${usefulSummary ? `<p class="story-summary">${escapeHtml(usefulSummary)}</p>` : ""}<div class="story-meta"><span>${formatDate(story.last_changed_at)}</span></div></div>
      <button class="story-open" data-story="${escapeHtml(story.id)}">Open</button>
    </article>`;
  }).join("");
}

function renderMissionRibbon() {
  const active = state.missions.filter((mission) => mission.status === "active").slice(0, 4);
  const node = $("#mission-ribbon");
  if (!active.length) { node.innerHTML = ""; return; }
  const todayIds = new Set((state.overview?.stories || []).map((story) => story.id));
  node.innerHTML = `<div class="section-heading"><div><p class="eyebrow">Your Missions</p><h3>Questions you’re following</h3></div><button class="secondary jump-missions">See all Missions</button></div>${active.map((mission) => {
    const match = (mission.matches || []).find((candidate) => todayIds.has(candidate.story_id));
    return `<article class="list-card"><div><div><h4>${escapeHtml(mission.name)}</h4><p>${escapeHtml(match ? match.title : mission.question || "Waiting for the first matching story")}</p></div></div><button class="secondary mission-open" data-mission="${escapeHtml(mission.id)}">Open Mission</button></article>`;
  }).join("")}`;
}

function renderActionCenter() {
  const actions = state.actionCenter?.actions || [];
  const node = $("#action-center");
  if (!node) return;
  $("#action-count").textContent = String(actions.length);
  $("#action-count").hidden = actions.length === 0;
  if (!actions.length) {
    node.innerHTML = `<div class="empty-state compact"><strong>No next steps.</strong></div>`;
    return;
  }
  const kindLabel = (kind) => ({
    "research-result": "Research ready",
    "mission-sprint": "Mission due",
    "source-health": "Source needs attention",
    "decision-review": "Outcome due",
    "reasoning-task": "Ready to reason",
    "pack-update": "Pack update",
  })[kind] || String(kind || "Update").replaceAll("-", " ");
  node.innerHTML = actions.slice(0, 12).map((item) => {
    const label = item.action === "review-research-result" ? "Review" : item.action === "run-mission-sprint" ? "Run now" : item.action === "open-sources" ? "Open sources" : item.action === "review-decision" ? "Review decision" : item.action === "open-reasoning" ? "Open reasoning" : "Open";
    return `<article class="action-item ${escapeHtml(item.severity)}"><div><div class="story-kicker"><span>${escapeHtml(kindLabel(item.kind))}</span>${item.missionName ? `<span>${escapeHtml(item.missionName)}</span>` : ""}${item.dueAt ? `<span>${formatDate(item.dueAt)}</span>` : ""}</div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.detail || "")}</p></div><button class="secondary action-center-button" data-action-kind="${escapeHtml(item.action)}" data-mission="${escapeHtml(item.missionId || "")}" data-import="${escapeHtml(item.metadata?.importId || "")}" data-task="${escapeHtml(item.metadata?.taskId || "")}" data-receipt="${escapeHtml(item.metadata?.receiptId || "")}" data-decision-id="${escapeHtml(item.metadata?.decisionId || "")}" data-routine="${escapeHtml(item.metadata?.routineId || "")}">${label}</button></article>`;
  }).join("");
}

function renderReadiness() {
  const result = state.readiness || { score: 0, checks: [] };
  const score = Number(result.score || 0);
  const scoreNode = $("#readiness-score");
  if (scoreNode) { scoreNode.textContent = score === 100 ? "Ready" : score >= 75 ? "Needs attention" : "Not ready"; scoreNode.className = `badge ${score === 100 ? "good" : score >= 75 ? "warn" : ""}`; }
  const node = $("#readiness-checks");
  if (!node) return;
  node.innerHTML = (result.checks || []).map((check) => `<article class="readiness-check ${escapeHtml(check.status)}"><span>${check.status === "ready" ? "ready" : check.status === "optional" ? "optional" : "attention"}</span><div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail || "")}</small></div></article>`).join("");
}

function renderIngestRecovery() {
  const records = state.ingestDeadLetters || [];
  const unresolved = records.filter((record) => record.status === "unresolved");
  const resolved = records.filter((record) => record.status === "resolved").length;
  const ignored = records.filter((record) => record.status === "ignored").length;
  const blocked = Boolean(state.readiness?.releaseBlocked);
  const badge = $("#ingest-recovery-status");
  const summary = $("#ingest-recovery-summary");
  const list = $("#ingest-dead-letters");
  if (!badge || !summary || !list) return;

  badge.textContent = unresolved.length ? `${unresolved.length} need attention` : blocked ? "collection paused" : "clear";
  badge.className = `badge ${blocked || unresolved.length ? "warn" : "good"}`;
  summary.innerHTML = [
    [unresolved.length, "need attention"],
    [resolved, "recently retried"],
    [ignored, "recently dismissed"],
    [blocked ? "paused" : "clear", "collection"],
  ].map(([value, label]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");

  if (!unresolved.length) {
    const durability = (state.readiness?.checks || []).find((check) => check.id === "ingest-durability");
    list.className = `ingest-recovery-empty ${blocked ? "attention" : "ready"}`;
    list.innerHTML = blocked
      ? `<div><strong>Collection is paused.</strong><p>${escapeHtml(durability?.detail || "Run the setup check again. If collection is still paused, review the latest source run before continuing.")}</p></div>`
      : `<div><strong>No failed items.</strong></div>`;
    return;
  }

  list.className = "ingest-dead-letter-list";
  list.innerHTML = unresolved.map((record) => `<article class="ingest-dead-letter">
    <div class="ingest-dead-letter-head"><div><span>${escapeHtml(record.provider || "unknown source")}</span><strong>${escapeHtml(formatDate(record.created_at))}</strong></div><span class="badge warn">needs your choice</span></div>
    <p>${escapeHtml(record.reason || "Driftglass could not save this collected item safely.")}</p>
    <dl><div><dt>Collected by</dt><dd>${escapeHtml(record.provider || "unknown source")}</dd></div><div><dt>Received</dt><dd>${escapeHtml(formatDate(record.created_at))}</dd></div><div><dt>Retries</dt><dd>${compactNumber(record.attempts)}</dd></div></dl>
    <div class="ingest-dead-letter-actions"><button class="primary ingest-dead-letter-action" data-dead-letter="${escapeHtml(record.id)}" data-dead-letter-action="retry">Retry once</button><button class="secondary ingest-dead-letter-action" data-dead-letter="${escapeHtml(record.id)}" data-dead-letter-action="dismiss">Dismiss</button></div>
  </article>`).join("");
}

async function refreshIngestRecovery() {
  const [readiness, deadLetters] = await Promise.all([
    api("/api/readiness"),
    api("/api/ingest/dead-letters?limit=100"),
  ]);
  state.readiness = readiness;
  state.ingestDeadLetters = deadLetters.deadLetters || [];
  renderReadiness();
  renderIngestRecovery();
}

async function actOnIngestDeadLetter(button) {
  const id = String(button.dataset.deadLetter || "");
  const action = button.dataset.deadLetterAction === "dismiss" ? "dismiss" : "retry";
  const record = state.ingestDeadLetters.find((candidate) => candidate.id === id && candidate.status === "unresolved");
  if (!record) throw new Error("This failed collection item has already been handled");
  const confirmed = action === "retry"
    ? window.confirm("Try saving this collected item once more?")
    : window.confirm("Dismiss this item? Its private recovery copy will be erased and cannot be tried again.");
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/ingest/dead-letters/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    await refreshIngestRecovery();
    toast(action === "retry" ? "Retry started" : "Recovery record dismissed");
  } finally {
    button.disabled = false;
  }
}

function renderMissions() {
  const node = $("#mission-list");
  if (!state.missions.length) {
    node.innerHTML = `<div class="empty-state"><strong>No Research Missions yet.</strong><span>Create one for a question you want to revisit as sources change.</span></div>`;
    return;
  }
  node.innerHTML = state.missions.map((mission) => {
    const terms = mission.terms || [];
    const matches = mission.matches || [];
    const operator = mission.operator || {};
    const research = mission.researchState || {};
    const pending = mission.pendingResearchResults || [];
    const events = mission.events || [];
    const run = state.missionRuns.find((candidate) => candidate.mission_id === mission.id);
    const runResult = run?.result || {};
    const runState = run?.status === "success" ? "Current" : run?.status === "failed" ? "Needs attention" : run?.status === "partial" ? "Partly updated" : "Updating";
    const sprint = run ? `<div class="mission-run ${escapeHtml(run.status)}"><div><span>Latest source check</span><strong>${runState}</strong></div><small>${formatDate(run.started_at || run.created_at)}${Number(runResult.collectedItems || 0) ? " · new sources found" : ""}${Number(runResult.matchedStories || 0) ? " · Mission updated" : ""}</small></div>` : "";
    const automation = `<div class="mission-autopilot"><div><span>Source checks</span><strong>${operator.sprint_policy === "scheduled" ? `Automatic · ${durationLabel(mission.cadence_minutes)}` : "When you ask"}</strong></div><small>${operator.sprint_policy === "scheduled" ? `Next ${formatDate(operator.next_sprint_at)}` : "Check when you want Driftglass to look for updates"}</small></div>`;
    const eventState = { pending: "still expected", occurred: "occurred", missed: "did not happen", rescheduled: "rescheduled", none: "not set" }[operator.expected_event_status] || "still expected";
    const expected = operator.expected_next_event ? `<div class="mission-next"><span>Next signal · ${eventState}</span><strong>${escapeHtml(operator.expected_next_event)}</strong>${operator.expected_by ? `<small>Expected by ${formatDate(operator.expected_by)}</small>` : ""}</div>` : "";
    const baseline = research.current_thesis || research.report_summary ? `<div class="research-baseline"><span>Current answer</span><p>${escapeHtml(research.current_thesis || research.report_summary)}</p>${research.last_research_at ? `<small>Updated ${formatDate(research.last_research_at)}</small>` : ""}</div>` : "";
    const review = pending.length ? `<button class="research-pending review-research-result" data-import="${escapeHtml(pending[0].id)}"><strong>${pending.length === 1 ? "An AI answer is" : "AI answers are"} ready for review</strong><span>Approve what should become part of Mission memory</span></button>` : "";
    const outcome = operator.outcome_status && operator.outcome_status !== "open" ? `<div class="mission-outcome"><span>${escapeHtml(operator.outcome_status)}</span><p>${escapeHtml(operator.outcome_summary || "Mission closed without an outcome summary.")}</p></div>` : "";
    const missionState = mission.status === "paused" ? `<span>Paused</span>` : mission.status === "complete" ? `<span>Complete</span>` : "";
    const missionPurpose = { watch: "Stay current", decision: "Decision", hypothesis: "Test a belief", event: "Expected event" }[operator.mode] || "Stay current";
    return `<article class="panel mission-card"><div class="story-kicker">${missionState}<span>${missionPurpose}</span>${operator.outcome_status && operator.outcome_status !== "open" ? `<span>${escapeHtml(operator.outcome_status)}</span>` : ""}</div><h3>${escapeHtml(mission.name)}</h3><p>${escapeHtml(mission.question || "A standing question")}</p><div class="feature-list">${terms.slice(0, 8).map((term) => `<span>${escapeHtml(term)}</span>`).join("")}</div>${automation}${expected}${baseline}${review}${outcome}${sprint}${matches.length ? `<div class="stack-list mission-match-list">${matches.slice(0, 4).map((match) => `<button class="list-card mission-story" data-story="${escapeHtml(match.story_id)}"><div><div><h4>${escapeHtml(match.title)}</h4><small>${formatDate(match.last_changed_at)}</small></div></div></button>`).join("")}</div>` : ""}<div class="mission-ledger-summary">${events.length ? `Latest change ${formatDate(events[0]?.occurred_at)}` : "No Mission history yet"}</div><div class="top-actions mission-actions"><button class="primary mission-sprint" data-mission="${escapeHtml(mission.id)}">Check for updates</button><button class="secondary mission-dossier" data-mission="${escapeHtml(mission.id)}">Open brief</button><button class="secondary mission-computer" data-mission="${escapeHtml(mission.id)}">Open workspace</button><details class="action-menu"><summary>More</summary><div><button class="secondary mission-research" data-mission="${escapeHtml(mission.id)}">Prepare for AI review</button><button class="secondary mission-configure" data-mission="${escapeHtml(mission.id)}">Settings</button>${state.integrations?.deepDiveLab?.configured ? `<button class="secondary mission-deep-dive" data-mission="${escapeHtml(mission.id)}">Local analysis tools</button>` : ""}<button class="secondary mission-share" data-mission="${escapeHtml(mission.id)}">Share</button><button class="secondary mission-bundle" data-mission="${escapeHtml(mission.id)}">Download context</button><button class="secondary mission-delete" data-mission="${escapeHtml(mission.id)}">Delete</button></div></details></div></article>`;
  }).join("");
}

function renderPackFilters() {
  const categories = ["All", ...new Set(state.packs.map((pack) => pack.category || "Other"))];
  $("#pack-filter").innerHTML = categories.map((category) => `<button class="chip ${state.packCategory === category ? "active" : ""}" data-pack-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
}

function renderPacks() {
  renderPackFilters();
  const installed = new Set((state.overview?.packInstalls || []).map((row) => row.pack_id));
  const packs = state.packs.filter((pack) => state.packCategory === "All" || (pack.category || "Other") === state.packCategory);
  $("#packs").innerHTML = packs.map((pack) => {
    const installKey = pack.lensType === "community" ? `lens:${pack.id}` : pack.id;
    const isInstalled = installed.has(installKey);
    const sourceCount = Array.isArray(pack.sources) ? pack.sources.length : Number(pack.sourceCount || 0);
    const author = pack.lensType === "community" && pack.author ? `<span class="pack-category">by ${escapeHtml(pack.author)}</span>` : "";
    return `<article class="pack ${pack.featured ? "featured" : ""}"><div class="pack-top"><div><span class="pack-category">${escapeHtml(pack.category || "Lens")}</span>${author}${pack.requiresCompanion ? '<span class="pack-category companion">Companion</span>' : ""}</div></div><div><h4>${escapeHtml(pack.name)}</h4><p>${escapeHtml(pack.description)}</p></div><div class="pack-foot"><span>${sourceCount} sources${Array.isArray(pack.missions) && pack.missions.length ? ` · ${pack.missions.length} Mission${pack.missions.length === 1 ? "" : "s"}` : ""}</span><div class="pack-actions"><button class="secondary export-pack" data-pack="${escapeHtml(pack.id)}">Share JSON</button><button class="${isInstalled ? "installed" : "secondary"} apply-pack" data-pack="${escapeHtml(pack.id)}">${isInstalled ? "Installed" : "Install Lens"}</button></div></div></article>`;
  }).join("");
}


function evidenceStrength(value) {
  const score = Number(value || 0);
  if (score >= .8) return "well supported";
  if (score >= .55) return "developing";
  return "tentative";
}

function sourceValueLabel(value) {
  const score = Number(value || 0);
  if (score >= 70) return "high value";
  if (score >= 45) return "useful";
  return "low signal";
}

function sourceCoverageLabel(value) {
  const score = Number(value || 0);
  if (score >= .7) return "mostly original coverage";
  if (score >= .35) return "a mix of original and repeated coverage";
  return "often repeats existing coverage";
}

function sourceReliabilityLabel(value) {
  const score = Number(value || 0);
  if (score >= .85) return "usually reliable";
  if (score >= .6) return "mixed reliability";
  return "needs attention";
}

function sourceRecommendationLabel(value) {
  return ({ accelerate: "check more often", maintain: "keep this pace", slow: "check less often", repair: "needs attention", pause: "pause for now" })[value] || "keep this pace";
}

function cadenceModeLabel(value) {
  return value === "fixed" ? "Fixed schedule" : "Adapts to usefulness";
}

function cadenceReasonLabel(value) {
  return ({
    "stable-yield": "steady useful results",
    "high-signal-acceleration": "recent finds were useful",
    "failure-backoff": "slower after a failed check",
    "low-yield-backoff": "fewer recent finds",
    "health-backoff": "slower while the source recovers",
  })[value] || "based on recent usefulness";
}

function sourceReasonLabel(value) {
  return String(value || "")
    .replace("Collection reliability is materially degraded", "Recent collection has been unreliable")
    .replace("Repeated runs produced no evidence in the selected window", "Recent checks found nothing useful")
    .replace("Most items duplicate another source family", "Most items repeat another source")
    .replace("High mission relevance, independent evidence, and reliable collection", "Useful to current Missions, original, and reliable")
    .replace("Contributes to active Research Missions", "Supports an active Mission")
    .replace("Echo coverage exceeds independent coverage", "Repeated coverage outweighs original reporting")
    .replace("Browser cost is high relative to observed value", "Page-reading work is high for the value found")
    .replace("Source is currently disabled", "Source is paused");
}

const MEMORY_CONTEXT_TYPES = new Set(["mission", "decision", "question", "finding", "expectation", "outcome", "preference", "event"]);
const MEMORY_TYPE_PRIORITY = {
  mission: 0, decision: 1, question: 2, finding: 3, expectation: 4, outcome: 5,
  preference: 6, event: 7, story: 8, claim: 9, entity: 10, source: 11, pack: 12,
};
const MEMORY_DEFAULT_TYPE_LIMITS = {
  mission: 4, decision: 3, question: 4, finding: 3, expectation: 2, outcome: 2,
  preference: 2, event: 2, story: 4, claim: 2, entity: 2, source: 2, pack: 1,
};

function memoryMetadata(value) {
  if (value?.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)) return value.metadata;
  return parseJsonSafe(value?.metadata_json, {}) || {};
}

function memoryEvidence(edge) {
  if (Array.isArray(edge?.evidence)) return edge.evidence;
  const parsed = parseJsonSafe(edge?.evidence_json, []);
  return Array.isArray(parsed) ? parsed : [];
}

function memoryTextKey(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function memoryStoryId(node) {
  const metadata = memoryMetadata(node);
  if (metadata.storyId) return String(metadata.storyId);
  const ref = String(node?.source_ref || "");
  return ref.startsWith("story:") ? ref.slice(6) : "";
}

function memoryStoryClaimAliases(nodes) {
  const storyById = new Map();
  const storyByLabel = new Map();
  for (const node of nodes) {
    if (node.node_type !== "story") continue;
    const storyId = memoryStoryId(node);
    if (storyId) storyById.set(storyId, node);
    const label = memoryTextKey(node.label);
    if (label && !storyByLabel.has(label)) storyByLabel.set(label, node);
  }
  const aliases = new Map();
  for (const node of nodes) {
    if (node.node_type !== "claim") continue;
    const story = storyById.get(memoryStoryId(node)) || storyByLabel.get(memoryTextKey(node.label));
    if (story && memoryTextKey(story.label) === memoryTextKey(node.label)) aliases.set(node.id, story.id);
  }
  return aliases;
}

function memoryRecallIsActive(recall) {
  return Boolean(String(recall?.query || "").trim() || String(recall?.ref || "").trim());
}

function memoryNodeMatchesRecall(node, recall) {
  if (!memoryRecallIsActive(recall)) return false;
  const ref = String(recall?.ref || "").trim();
  if (ref && (node.source_ref === ref || node.id === ref || node.canonical_key === ref)) return true;
  const query = memoryTextKey(recall?.query);
  if (!query) return false;
  const metadata = memoryMetadata(node);
  const haystack = memoryTextKey([
    node.label, node.summary, ...(Array.isArray(node.aliases) ? node.aliases : []),
    node.aliases_json, metadata.missionId, metadata.storyId,
  ].filter(Boolean).join(" "));
  return haystack.includes(query);
}

function compareMemoryNodes(left, right, recall) {
  const recallRank = Number(memoryNodeMatchesRecall(right, recall)) - Number(memoryNodeMatchesRecall(left, recall));
  if (recallRank) return recallRank;
  const leftMetadata = memoryMetadata(left);
  const rightMetadata = memoryMetadata(right);
  const activeRank = Number(rightMetadata.status === "active") - Number(leftMetadata.status === "active");
  if (activeRank) return activeRank;
  const typeRank = (MEMORY_TYPE_PRIORITY[left.node_type] ?? 99) - (MEMORY_TYPE_PRIORITY[right.node_type] ?? 99);
  if (typeRank) return typeRank;
  const importanceRank = Number(right.importance || 0) - Number(left.importance || 0);
  if (importanceRank) return importanceRank;
  return Date.parse(right.updated_at || 0) - Date.parse(left.updated_at || 0);
}

function memoryDisplayModel(nodes, recall) {
  const aliases = memoryStoryClaimAliases(nodes);
  const unique = nodes.filter((node) => !aliases.has(node.id)).sort((left, right) => compareMemoryNodes(left, right, recall));
  if (memoryRecallIsActive(recall)) return { nodes: unique.slice(0, 24), aliases };
  const counts = new Map();
  const selected = [];
  for (const node of unique) {
    const limit = MEMORY_DEFAULT_TYPE_LIMITS[node.node_type] ?? 1;
    const count = counts.get(node.node_type) || 0;
    if (count >= limit) continue;
    selected.push(node);
    counts.set(node.node_type, count + 1);
    if (selected.length >= 14) break;
  }
  return { nodes: selected, aliases };
}

function memorySummaryMarkup(value, limit = 360) {
  const summary = String(value?.summary || "").trim();
  if (!summary) return "";
  const summaryKey = memoryTextKey(summary);
  const labelKey = memoryTextKey(value?.label);
  if (!summaryKey || summaryKey === labelKey || summaryKey === "tracked entity or topic") return "";
  if (labelKey && summaryKey === `current claim represented by story ${labelKey}`) return "";
  return `<p>${escapeHtml(readableExcerpt(summary, limit))}</p>`;
}

function memoryIndependentFamilyCount(value, relatedEdges = []) {
  const metadata = memoryMetadata(value);
  const explicit = [
    metadata.independentFamilyCount,
    metadata.independentFamilies,
    metadata.independentSourceCount,
  ].map(Number).filter((count) => Number.isSafeInteger(count) && count >= 0);
  const families = new Set();
  for (const edge of relatedEdges) {
    const edgeMetadata = memoryMetadata(edge);
    const independent = edgeMetadata.lineageIndependent === true
      || edgeMetadata.lineage_independent === 1
      || edgeMetadata.independent === true
      || edgeMetadata.independent === 1;
    const family = edgeMetadata.familyKey || edgeMetadata.family_key || edgeMetadata.originFamilyKey || edgeMetadata.origin_family_key;
    if (independent && family) families.add(String(family));
  }
  return Math.max(families.size, ...explicit, 0);
}

function memorySourceCount(node, relatedEdges, nodeById, aliases) {
  const configured = Number(memoryMetadata(node).sourceCount);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  const sourceIds = new Set();
  for (const edge of relatedEdges) {
    if (!["observed_in", "evidence_for", "evidence_against", "supports", "contradicts"].includes(edge.relation)) continue;
    const fromId = aliases.get(edge.from_node_id) || edge.from_node_id;
    const toId = aliases.get(edge.to_node_id) || edge.to_node_id;
    const otherId = fromId === node.id ? toId : toId === node.id ? fromId : "";
    if (otherId && nodeById.get(otherId)?.node_type === "source") sourceIds.add(otherId);
  }
  return sourceIds.size;
}

function memorySupportLabel(node, relatedEdges, nodeById, aliases) {
  if (!["story", "claim", "finding"].includes(node.node_type)) return "";
  const independentFamilies = memoryIndependentFamilyCount(node, relatedEdges);
  if (independentFamilies >= 2) return `${independentFamilies} independent source groups`;
  if (independentFamilies === 1) return "one independent source group";
  const sources = memorySourceCount(node, relatedEdges, nodeById, aliases);
  if (sources === 1) return "one source so far";
  return "support not yet independent";
}

function memoryCardStatus(node) {
  const metadata = memoryMetadata(node);
  if (node.node_type === "mission" && metadata.status === "active") return "Active";
  if (node.node_type === "question" && node.status === "active") return "Open";
  return memoryStatusLabel(node.status);
}

function memoryNodeFootnote(node, relatedEdges, nodeById, aliases) {
  const support = memorySupportLabel(node, relatedEdges, nodeById, aliases);
  const metadata = memoryMetadata(node);
  const context = node.node_type === "mission" ? metadata.status === "active" ? "Active Mission" : "Saved Mission"
    : node.node_type === "decision" ? "Saved decision"
      : node.node_type === "question" ? "Open question"
        : node.node_type === "expectation" ? "Expected signal"
          : node.node_type === "outcome" ? "Saved outcome"
            : node.node_type === "event" ? "Mission history"
              : node.node_type === "preference" ? "Saved preference" : "";
  return `${support || context || "Saved context"} · updated ${formatDate(node.updated_at)}`;
}

function memoryTypeLabel(value) {
  return ({ entity: "Topic", source: "Source", story: "Story", claim: "Claim", mission: "Mission", finding: "Finding", decision: "Decision", outcome: "Outcome", event: "Mission update", expectation: "Expected event", question: "Open question", preference: "Preference", pack: "Intelligence Pack" })[value]
    || String(value || "Memory").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function memoryStatusLabel(value) {
  return ({ active: "Current", open: "Open", resolved: "Resolved", confirmed: "Confirmed", superseded: "Replaced", retracted: "Removed", archived: "Archived", rejected: "Rejected", provisional: "Provisional" })[value]
    || "Current";
}

function memoryRelationLabel(value) {
  return ({ supports: "supports", contradicts: "challenges", derived_from: "comes from", supersedes: "replaces", about: "is about", relevant_to: "matters to", affects: "affects", evidence_for: "is evidence for", evidence_against: "weighs against", observed_in: "appeared in", asks: "asks", answers: "answers", tracks: "follows", updates: "updates", resolves: "settles", expects: "expects", mentions: "mentions", defined_by: "is defined by", contains: "contains" })[value]
    || String(value || "relates to").replaceAll("_", " ");
}

function memoryRelationTrail(edge) {
  const metadata = memoryMetadata(edge);
  const independent = metadata.lineageIndependent === true
    || metadata.lineage_independent === 1
    || metadata.independent === true
    || metadata.independent === 1;
  const family = metadata.familyKey || metadata.family_key || metadata.originFamilyKey || metadata.origin_family_key;
  if (independent && family) return "independent source trail";
  const evidence = memoryEvidence(edge);
  if (["observed_in", "evidence_for", "evidence_against", "supports", "contradicts"].includes(edge.relation)) {
    return evidence.length === 1 ? "one source item so far" : "support not yet independent";
  }
  if (evidence.some((ref) => String(ref).startsWith("mission"))) return "saved Mission context";
  if (evidence.some((ref) => String(ref).startsWith("pack:"))) return "Intelligence Pack definition";
  if (evidence.some((ref) => String(ref).startsWith("story:"))) return "same Story record";
  return evidence.length ? "source trail saved; independence not established" : "saved connection";
}

function memoryDisplayEdges(edges, allNodes, display, recall) {
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const selectedIds = new Set(display.nodes.map((node) => node.id));
  const relationPriority = { resolves: 0, asks: 1, answers: 2, updates: 3, expects: 4, relevant_to: 5, evidence_for: 6, evidence_against: 7, contradicts: 8, supports: 9, observed_in: 10 };
  const seen = new Set();
  const rows = [];
  for (const edge of edges) {
    const fromId = display.aliases.get(edge.from_node_id) || edge.from_node_id;
    const toId = display.aliases.get(edge.to_node_id) || edge.to_node_id;
    if (fromId === toId || !nodeById.has(fromId) || !nodeById.has(toId)) continue;
    if (!selectedIds.has(fromId) && !selectedIds.has(toId)) continue;
    const key = `${fromId}:${edge.relation}:${toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ edge, fromId, toId });
  }
  rows.sort((left, right) => {
    const leftSelected = Number(selectedIds.has(left.fromId)) + Number(selectedIds.has(left.toId));
    const rightSelected = Number(selectedIds.has(right.fromId)) + Number(selectedIds.has(right.toId));
    if (leftSelected !== rightSelected) return rightSelected - leftSelected;
    const leftContext = Number(MEMORY_CONTEXT_TYPES.has(nodeById.get(left.fromId)?.node_type)) + Number(MEMORY_CONTEXT_TYPES.has(nodeById.get(left.toId)?.node_type));
    const rightContext = Number(MEMORY_CONTEXT_TYPES.has(nodeById.get(right.fromId)?.node_type)) + Number(MEMORY_CONTEXT_TYPES.has(nodeById.get(right.toId)?.node_type));
    if (leftContext !== rightContext) return rightContext - leftContext;
    return (relationPriority[left.edge.relation] ?? 99) - (relationPriority[right.edge.relation] ?? 99);
  });
  return { rows: rows.slice(0, memoryRecallIsActive(recall) ? 32 : 16), nodeById };
}

function memoryTimelineRows(timeline, recall) {
  const storyLabels = new Set(timeline.filter((item) => item.type === "story").map((item) => memoryTextKey(item.label)));
  const unique = timeline.filter((item, index, rows) => {
    if (item.type === "claim" && storyLabels.has(memoryTextKey(item.label))) return false;
    const key = `${item.type}:${memoryTextKey(item.label)}:${item.at || ""}`;
    return rows.findIndex((candidate) => `${candidate.type}:${memoryTextKey(candidate.label)}:${candidate.at || ""}` === key) === index;
  });
  if (memoryRecallIsActive(recall)) return unique.slice(0, 14);
  const context = unique.filter((item) => MEMORY_CONTEXT_TYPES.has(item.type));
  const stories = unique.filter((item) => item.type === "story");
  return [...context, ...stories].slice(0, 8);
}

function renderMemory(data = state.intelligence || {}) {
  const health = data.graph || {};
  const stats = health.stats || {};
  const proposals = data.proposals || [];
  const statCards = [
    [stats["type:mission"] || 0, "Missions connected", "Focus"],
    [stats["type:decision"] || 0, "saved decisions", "Decisions"],
    [stats["type:question"] || 0, "questions retained", "Questions"],
    [proposals.length, "changes to review", "Review"],
  ];
  const statsNode = $("#memory-stats");
  if (statsNode) statsNode.innerHTML = statCards.map(([value, label, kicker]) => `<article class="stat"><span>${escapeHtml(kicker)}</span><strong>${compactNumber(value)}</strong><small>${escapeHtml(label)}</small></article>`).join("");

  const runNode = $("#memory-run-status");
  const recentRuns = health.recentRuns || data.runs || [];
  const latestRun = recentRuns[0];
  if (runNode) {
    runNode.hidden = false;
    if (!latestRun) {
      runNode.innerHTML = `<div class="section-heading compact"><div><p class="eyebrow">Memory refresh</p><h3>Connect saved context</h3></div></div><p>Refresh after the first collection to connect Missions, Stories, decisions, and their source trail.</p>`;
    } else {
      const status = latestRun.status || "unknown";
      if (["complete", "partial"].includes(status)) {
        runNode.hidden = true;
        runNode.innerHTML = "";
      } else {
        const title = status === "failed" ? "Memory needs attention" : "Refreshing memory";
        const stateLabel = status === "queued" ? "Waiting" : status === "running" ? "In progress" : "Needs attention";
        runNode.innerHTML = `<div class="section-heading compact"><div><p class="eyebrow">Memory refresh</p><h3>${title}</h3></div><span class="badge ${status === "failed" ? "bad" : "warn"}">${stateLabel}</span></div><div class="story-meta"><span>${formatDate(latestRun.completed_at || latestRun.updated_at || latestRun.started_at)}</span></div>${latestRun.error ? `<p class="error-text">${escapeHtml(latestRun.error)}</p>` : `<p>Driftglass is refreshing current sources and connected memory.</p>`}`;
      }
    }
  }

  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const recall = data.recall || null;
  const display = memoryDisplayModel(nodes, recall);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relatedEdges = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    const fromId = display.aliases.get(edge.from_node_id) || edge.from_node_id;
    const toId = display.aliases.get(edge.to_node_id) || edge.to_node_id;
    relatedEdges.get(fromId)?.push(edge);
    if (toId !== fromId) relatedEdges.get(toId)?.push(edge);
  }
  const nodesNode = $("#memory-nodes");
  if (nodesNode) {
    const recallLabel = readableExcerpt(recall?.query || recall?.ref || "", 120);
    const intro = memoryRecallIsActive(recall)
      ? `<div class="memory-focus-note"><strong>Recall for “${escapeHtml(recallLabel)}”</strong><span>Closest saved context comes first. Refine the search or use an exact Mission reference to follow a narrower thread.</span></div>`
      : `<div class="memory-focus-note"><strong>Your standing context</strong><span>Active Missions, decisions, and open questions come first. Search a Mission, topic, or question to open its nearby memory.</span></div>`;
    nodesNode.innerHTML = display.nodes.length ? `${intro}${display.nodes.map((node) => `<article class="memory-node ${MEMORY_CONTEXT_TYPES.has(node.node_type) ? "memory-context" : ""}"><div class="story-kicker"><span>${escapeHtml(memoryTypeLabel(node.node_type))}</span><span>${escapeHtml(memoryCardStatus(node))}</span></div><h4>${escapeHtml(readableExcerpt(node.label, 180))}</h4>${memorySummaryMarkup(node)}<small>${escapeHtml(memoryNodeFootnote(node, relatedEdges.get(node.id) || [], nodeById, display.aliases))}</small></article>`).join("")}` : `<div class="empty-state compact"><strong>No connected memory yet.</strong><span>Collect a Story or start a Mission, then refresh memory to connect it to a source trail.</span></div>`;
  }

  const edgesNode = $("#memory-edges");
  if (edgesNode) {
    const edgeDisplay = memoryDisplayEdges(edges, nodes, display, recall);
    edgesNode.innerHTML = edgeDisplay.rows.length ? edgeDisplay.rows.map(({ edge, fromId, toId }) => {
      const fromLabel = readableExcerpt(edgeDisplay.nodeById.get(fromId)?.label || "Saved context", 180);
      const toLabel = readableExcerpt(edgeDisplay.nodeById.get(toId)?.label || "Saved context", 180);
      return `<article class="memory-edge"><div><strong title="${escapeHtml(fromLabel)}">${escapeHtml(fromLabel)}</strong><span>${escapeHtml(memoryRelationLabel(edge.relation))}</span><strong title="${escapeHtml(toLabel)}">${escapeHtml(toLabel)}</strong></div>${edge.rationale ? `<p>${escapeHtml(readableExcerpt(edge.rationale, 300))}</p>` : ""}<small>${escapeHtml(memoryRelationTrail(edge))}</small></article>`;
    }).join("") : `<div class="empty-state compact"><strong>No useful connection in this view.</strong><span>Recall a Mission, Story, decision, or question to follow its nearby source trail.</span></div>`;
  }

  const timeline = data.timeline || [];
  const timelineNode = $("#memory-timeline");
  if (timelineNode) {
    const timelineRows = memoryTimelineRows(timeline, recall);
    timelineNode.innerHTML = timelineRows.length ? timelineRows.map((item) => `<article class="timeline-item"><time>${formatDate(item.at)}</time><div><div class="story-kicker"><span>${escapeHtml(memoryTypeLabel(item.type))}</span><span>${escapeHtml(memoryStatusLabel(item.status))}</span></div><strong>${escapeHtml(readableExcerpt(item.label, 180))}</strong>${memorySummaryMarkup(item)}</div></article>`).join("") : `<div class="empty-state compact"><strong>No meaningful change in this view yet.</strong><span>Mission updates, decisions, findings, and expected events appear here as they change.</span></div>`;
  }

  const count = $("#memory-proposal-count");
  if (count) count.textContent = String(proposals.length);
  const proposalNode = $("#memory-proposals");
  if (proposalNode) proposalNode.innerHTML = proposals.length ? proposals.map((proposal) => {
    const provider = ({ chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", owner: "You" })[proposal.provider] || "AI review";
    const scope = ({ global: "Across Driftglass", mission: "Mission", story: "Story" })[proposal.scope_kind] || "Memory";
    return `<article class="memory-proposal"><div class="story-kicker"><span>${escapeHtml(provider)}</span><span>${escapeHtml(scope)}</span></div><h4>${escapeHtml(proposal.title)}</h4><p>Suggested ${formatDate(proposal.created_at)}. Review what should become part of memory.</p><div class="top-actions"><button class="primary memory-proposal-approve" data-proposal="${escapeHtml(proposal.id)}">Approve</button><button class="secondary memory-proposal-reject" data-proposal="${escapeHtml(proposal.id)}">Reject</button></div></article>`;
  }).join("") : `<div class="empty-state compact"><strong>No memory change needs review.</strong><span>Reasoning models can propose durable findings, decisions, expectations, and questions through MCP.</span></div>`;
}

function renderMemoryAudit() {
  const target = $("#memory-audit");
  if (!target) return;
  const audit = state.memoryAudit;
  if (!audit) { target.hidden = true; target.innerHTML = ""; return; }
  target.hidden = false;
  const issues = audit.issues || {};
  const counts = [
    [issues.unresolvedContradictions?.length || 0, "unresolved contradictions"],
    [issues.staleExpectations?.length || 0, "overdue expectations"],
    [issues.unsupportedDurableNodes?.length || 0, "memories without enough support"],
    [issues.orphanNodes?.length || 0, "items no longer connected"],
    [issues.incompleteSupersession?.length || 0, "unfinished replacements"],
  ];
  target.innerHTML = `<div class="section-heading compact"><div><p class="eyebrow">Memory health</p><h3>${Number(audit.score || 0) >= .85 ? "Memory looks healthy" : "Memory needs attention"}</h3></div><span class="badge ${Number(audit.score || 0) >= .85 ? "good" : "warn"}">${Number(audit.totals?.activeNodes || 0)} remembered items · ${Number(audit.totals?.activeEdges || 0)} connections</span></div><div class="memory-audit-grid">${counts.map(([count, label]) => `<article><strong>${count}</strong><span>${escapeHtml(label)}</span></article>`).join("")}</div><div class="memory-audit-recommendations">${(audit.recommendations || []).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>`;
}

function renderMemoryCheckpoints() {
  const target = $("#memory-checkpoints");
  if (!target) return;
  const checkpoints = state.memoryCheckpoints || [];
  const diff = state.memoryCheckpointDiff?.diff || null;
  const diffMarkup = diff ? `<section class="checkpoint-diff"><div class="section-heading compact"><div><p class="eyebrow">Since the last saved state</p><h4>${diff.unchanged ? "Memory is unchanged" : "The standing answer changed"}</h4></div><span class="badge ${diff.unchanged ? "good" : "warn"}">Earlier and latest</span></div><div class="checkpoint-diff-grid"><article><strong>${Number(diff.addedNodes?.length || 0)}</strong><span>items added</span></article><article><strong>${Number(diff.changedNodes?.length || 0)}</strong><span>items changed</span></article><article><strong>${Number(diff.removedNodes?.length || 0)}</strong><span>items removed</span></article><article><strong>${Number(diff.addedEdges?.length || 0)}</strong><span>connections added</span></article></div></section>` : "";
  target.innerHTML = `${diffMarkup}${checkpoints.length ? `<div class="checkpoint-list">${checkpoints.slice(0, 6).map((checkpoint, index) => `<article><div><strong>${escapeHtml(checkpoint.title)}</strong><small>${escapeHtml(checkpoint.scope_kind)} · ${formatDate(checkpoint.created_at)}</small></div><span>${index === 0 ? "latest" : escapeHtml(checkpoint.reason || "saved state")}</span></article>`).join("")}</div>` : `<div class="empty-state compact"><strong>No saved memory state yet.</strong><span>Save one after a meaningful change. A later state makes shifts in beliefs and decisions easy to see.</span></div>`}`;
}

async function refreshMemoryCheckpoints(compare = true) {
  const result = await api("/api/memory/checkpoints?scopeKind=global&limit=8");
  state.memoryCheckpoints = result.checkpoints || [];
  state.memoryCheckpointDiff = null;
  if (compare && state.memoryCheckpoints.length) {
    state.memoryCheckpointDiff = await api("/api/memory/checkpoints/compare?scopeKind=global").catch(() => null);
  }
  renderMemoryCheckpoints();
}

function renderIntelligencePacks() {
  const target = $("#intelligence-pack-grid");
  if (!target) return;
  const catalog = state.intelligence?.catalog || [];
  const installedRows = state.intelligence?.packs || [];
  const installed = new Map(installedRows.map((row) => [row.id, row]));
  const updates = new Map((state.packUpdates || []).map((row) => [row.id, row]));
  const overlays = state.judgment?.overlays || [];
  const overlaysByPack = new Map();
  for (const overlay of overlays) {
    const rows = overlaysByPack.get(overlay.base_pack_id) || [];
    rows.push(overlay); overlaysByPack.set(overlay.base_pack_id, rows);
  }
  const merged = [...catalog];
  for (const row of installedRows) {
    if (merged.some((entry) => (entry.id || entry.pack?.id) === row.id)) continue;
    merged.push({
      id: row.id,
      version: row.version,
      name: row.name,
      description: row.description,
      author: row.author,
      category: row.category,
      icon: row.icon,
      budgetProfile: row.budget_profile,
      pack: row.manifest || {},
      installedOnly: true,
    });
  }
  if (!merged.length) {
    target.innerHTML = `<div class="empty-state"><strong>No Intelligence Packs yet.</strong><span>Install a curated Pack or preview one from a URL or local JSON file.</span></div>`;
    return;
  }
  target.innerHTML = merged.map((entry) => {
    const pack = entry.pack || entry;
    const packId = entry.id || pack.id;
    const installedRow = installed.get(packId);
    const isInstalled = Boolean(installedRow);
    const allSources = [...(pack.sources || []), ...(pack.cloudSources || []), ...(pack.companionSources || [])];
    const cloudCount = Number(entry.cloudSourceCount ?? allSources.filter((source) => source.kind !== "collector").length);
    const companionCount = Number(entry.companionSourceCount ?? allSources.filter((source) => source.kind === "collector").length);
    const sourceCount = Number(entry.sourceCount ?? cloudCount + companionCount);
    const cloudCoverage = Number(entry.cloudCoverage ?? (sourceCount ? cloudCount / sourceCount : 1));
    const update = updates.get(packId);
    const packOverlays = overlaysByPack.get(packId) || [];
    const activeOverlay = packOverlays.find((overlay) => overlay.status !== "disabled");
    const conflicted = packOverlays.some((overlay) => overlay.status === "conflicted");
    const overlayStatus = activeOverlay ? `<span class="badge ${conflicted ? "warn" : "good"}">${conflicted ? "fork needs review" : "local changes saved"}</span>` : "";
    const updateControl = update?.updateAvailable ? `<button class="primary installed-pack-update" data-pack="${escapeHtml(packId)}">Update to ${escapeHtml(update.availableVersion || "new version")}</button>` : update?.status === "error" ? `<span class="badge warn" title="${escapeHtml(update.error || "Update check failed")}">Update check failed</span>` : update?.status === "current" ? `<span class="badge good">Current</span>` : "";
    const installedControls = `<div class="pack-installed-actions">${updateControl}${overlayStatus}<button class="secondary installed-pack-preserve" data-pack="${escapeHtml(packId)}">Save local changes</button>${activeOverlay ? `<button class="secondary installed-pack-fork" data-pack="${escapeHtml(packId)}">Export forked Pack</button>` : ""}<button class="secondary installed-pack-skill" data-pack="${escapeHtml(packId)}">Agent Skill</button><button class="secondary installed-pack-export" data-pack="${escapeHtml(packId)}">Export Pack</button></div>`;
    return `<article class="pack intelligence-pack ${entry.featured ? "featured" : ""}"><div class="pack-top"><div><span class="pack-category">${escapeHtml(entry.category || pack.category || "Intelligence Pack")}</span><span class="pack-category ${cloudCoverage >= .8 ? "cloud" : "companion"}">${cloudCoverage >= .8 ? "Cloud sources" : "Companion adds coverage"}</span></div></div><div><h4>${escapeHtml(entry.name || pack.name || packId)}</h4><p>${escapeHtml(entry.description || pack.description || "A focused set of sources, Missions, memory, and research methods")}</p></div><div class="pack-metrics"><span>${cloudCount} ready sources</span>${companionCount ? `<span>${companionCount} optional signed-in</span>` : ""}<span>${Number(entry.missionCount ?? pack.missions?.length ?? 0)} Missions</span></div><div class="pack-foot"><span>${escapeHtml(entry.budgetProfile || pack.budget?.profile || installedRow?.budget_profile || "free")} plan</span>${isInstalled ? `<span class="badge good">Installed</span>` : `<button class="secondary preview-intelligence-pack" data-pack="${escapeHtml(packId)}">Preview Pack</button>`}</div>${isInstalled ? installedControls : ""}</article>`;
  }).join("");
}

function budgetValue(dimension, units) {
  const value = Number(units || 0);
  if (dimension === "browser_ms") return `${(value / 60_000).toFixed(value >= 600_000 ? 0 : 1)} min`;
  if (dimension === "computer_sync_bytes" || dimension === "r2_write_bytes") return `${(value / 1024 / 1024).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
  return compactNumber(value);
}

function budgetCapacityLabel(profile, expanded, plannedExpansion) {
  if (profile === "custom") {
    if (expanded) return "Custom limits · higher Worker limits confirmed";
    return plannedExpansion ? "Custom plan selected · Free ceiling active" : "Custom limits active";
  }
  if (expanded) return "Higher Worker limits confirmed";
  if (plannedExpansion) return `${profile === "cheap" ? "Low-cost" : "Free"} plan selected · Free limits active`;
  return "Free limits active";
}

function renderBudget() {
  const budget = state.intelligence?.budget;
  const target = $("#budget-bars");
  const selector = $("#budget-profile");
  const capacityControl = $("#workers-paid-confirmed");
  const capacityState = $("#execution-capacity-state");
  if (!budget || !target) return;
  if (selector) {
    const customOption = selector.querySelector('option[value="custom"]');
    if (budget.profile === "custom") {
      const option = customOption || document.createElement("option");
      option.value = "custom";
      option.textContent = "Custom";
      option.disabled = true;
      if (!customOption) selector.append(option);
      selector.value = "custom";
    } else {
      customOption?.remove();
      selector.value = budget.profile === "cheap" ? "cheap" : "free";
    }
  }
  const expanded = budget.executionCapacity === "expanded-confirmed";
  if (capacityControl) capacityControl.checked = expanded;
  const effectiveLimits = budget.effectiveLimits || budget.limits || {};
  const plannedLimits = budget.plannedLimits || effectiveLimits;
  const workerLimitKeys = [
    "browser_ms_day",
    "workflow_steps_day",
    "ai_search_queries_month",
    "memory_writes_day",
    "source_runs_day",
    "queue_messages_day",
    "computer_sync_bytes_day",
  ];
  const plannedExpansion = workerLimitKeys.some((key) => Number(plannedLimits[key] ?? 0) > Number(effectiveLimits[key] ?? 0));
  if (capacityState) {
    capacityState.textContent = budgetCapacityLabel(budget.profile, expanded, plannedExpansion);
  }
  const labels = {
    browser_ms: "Page reading",
    workflow_steps: "Scheduled work",
    ai_search_queries: "AI Search operations",
    memory_writes: "Memory updates",
    source_runs: "Source checks",
    queue_messages: "Collected items",
    computer_sync_bytes: "Mission workspace updates",
    r2_class_a_ops: "R2 write operations",
    r2_class_b_ops: "R2 read operations",
    r2_write_bytes: "R2 storage",
  };
  const limitKeys = {
    browser_ms: "browser_ms_day",
    workflow_steps: "workflow_steps_day",
    ai_search_queries: "ai_search_queries_month",
    memory_writes: "memory_writes_day",
    source_runs: "source_runs_day",
    queue_messages: "queue_messages_day",
    computer_sync_bytes: "computer_sync_bytes_day",
    r2_class_a_ops: "r2_class_a_ops_day",
    r2_class_b_ops: "r2_class_b_ops_day",
    r2_write_bytes: "r2_write_bytes_day",
  };
  target.innerHTML = Object.entries(labels).map(([dimension, label]) => {
    const used = dimension === "ai_search_queries" ? Number(budget.monthly?.[dimension] || 0) : Number(budget.daily?.[dimension] || 0);
    const remaining = Number(budget.remaining?.[dimension] || 0);
    const limit = Number(effectiveLimits[limitKeys[dimension]] ?? 0);
    const utilization = Math.round(Number(budget.utilization?.[dimension] || 0) * 100);
    return `<article class="budget-lane ${utilization >= 90 ? "degraded" : ""}"><div><strong>${escapeHtml(label)}</strong><span>${budgetValue(dimension, used)} / ${budgetValue(dimension, limit)}</span></div><progress class="visual-meter budget-track" max="100" value="${Math.min(100, utilization)}" aria-label="${escapeHtml(label)} usage"></progress><small>${utilization}% used · ${budgetValue(dimension, remaining)} left</small></article>`;
  }).join("");
}

function chatgptPluginDownloadMarkup() {
  return `<details class="provider-setup chatgpt-plugin-download"><summary>Add @Driftglass</summary><p>Once the ChatGPT connection is created, open it and copy the technical app ID from the browser address. Installing the download through ChatGPT desktop enables @Driftglass.</p><label for="chatgpt-plugin-app-id">Technical app ID</label><div class="chatgpt-plugin-download-row"><input id="chatgpt-plugin-app-id" class="chatgpt-plugin-app-id" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="48" pattern="plugin_asdk_app_[0-9a-f]{32}" placeholder="plugin_asdk_app_…" required /><button class="secondary download-chatgpt-plugin" type="button">Download Driftglass plugin</button></div></details>`;
}

function renderReasoningProviders() {
  const target = $("#reasoning-providers");
  if (!target) return;
  const providers = state.reasoningProviders?.providers || {};
  if (state.runtime?.context?.profile === "selfhost") {
    const local = state.reasoningProviders?.localConnections || {};
    const tunnel = state.reasoningProviders?.chatgptWeb || {};
    const research = tunnel.profiles?.compact || {};
    const updates = tunnel.profiles?.updates || {};
    const tunnelSettings = safeHref(tunnel.links?.tunnelSettings);
    const tunnelDownload = safeHref(tunnel.links?.download);
    const chatgptPlugins = safeHref(tunnel.links?.chatgptPlugins);
    const guide = safeHref(tunnel.links?.guide);
    const setupLinks = [
      tunnelSettings ? `<a class="primary" href="${escapeHtml(tunnelSettings)}" target="_blank" rel="noopener noreferrer">Open tunnel settings</a>` : "",
      tunnelDownload ? `<a class="secondary" href="${escapeHtml(tunnelDownload)}" target="_blank" rel="noopener noreferrer">Download tunnel client</a>` : "",
    ].join("");
    const setupSteps = (tunnel.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    target.innerHTML = `<article class="provider-card provider-card-featured"><div class="provider-card-head"><div><p class="eyebrow">ChatGPT</p><h4>${escapeHtml(tunnel.title || "Connect ChatGPT")}</h4></div><span class="connection-state">Manual setup</span></div><p>Use ChatGPT with Today, Missions, and source-linked briefs while Driftglass stays on this machine.</p><small>${escapeHtml(tunnel.detail || "The connection runs outward from this machine.")}</small><div class="provider-actions provider-actions-row">${setupLinks}</div><details class="provider-setup"><summary>Finish the connection</summary><ol>${setupSteps}</ol><div class="provider-actions">${research.init?.copyCommand ? `<button class="primary copy-provider" type="button" data-copy-value="${escapeHtml(research.init.copyCommand)}">Copy Research setup</button>` : ""}${research.check?.copyCommand ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(research.check.copyCommand)}">Copy check command</button>` : ""}${research.run?.copyCommand ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(research.run.copyCommand)}">Copy start command</button>` : ""}${chatgptPlugins ? `<a class="secondary" href="${escapeHtml(chatgptPlugins)}" target="_blank" rel="noopener noreferrer">Open ChatGPT</a>` : ""}</div>${guide ? `<a class="provider-help" href="${escapeHtml(guide)}" target="_blank" rel="noopener noreferrer">OpenAI setup guide</a>` : ""}</details>${updates.init?.copyCommand ? `<details class="provider-setup provider-setup-secondary"><summary>Allow ChatGPT to save suggestions</summary><p>Set up the second tunnel only when you want answers saved for review.</p><div class="provider-actions">${`<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(updates.init.copyCommand)}">Copy update setup</button>`}${updates.check?.copyCommand ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(updates.check.copyCommand)}">Copy check command</button>` : ""}${updates.run?.copyCommand ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(updates.run.copyCommand)}">Copy start command</button>` : ""}</div></details>` : ""}</article><article class="provider-card provider-card-wide"><div><p class="eyebrow">On this machine</p><h4>Claude, Codex, and local models</h4><p>Copy the connection into an app on this machine.</p></div><div class="provider-actions">${local.read ? `<button class="primary copy-provider" type="button" data-copy-value="${escapeHtml(local.read)}">Copy Research setup</button>` : ""}${local.approval ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(local.approval)}">Copy update setup</button>` : ""}</div></article>`;
    target.querySelector(".provider-card-featured")?.insertAdjacentHTML("beforeend", chatgptPluginDownloadMarkup());
    return;
  }
  const chatgpt = providers.chatgpt || {};
  const claude = providers.claude || {};
  const generic = providers.generic || providers.grok || {};
  const chatgptSetup = state.reasoningConnections?.available ? chatgpt.mcpUrl || "" : "";
  const connections = Array.isArray(state.reasoningConnections?.connections) ? state.reasoningConnections.connections : [];
  const connectionList = connections.length
    ? `<div class="connection-list">${connections.map((connection) => { const name = connection.name || "ChatGPT"; const connectedAt = typeof connection.connectedAt === "string" && Number.isFinite(new Date(connection.connectedAt).getTime()) ? connection.connectedAt : ""; const detail = connectedAt ? `<time datetime="${escapeHtml(connectedAt)}">Connected ${escapeHtml(formatDate(connectedAt))}</time>` : "<small>Connected</small>"; return `<div class="connection-row"><span><strong>${escapeHtml(name)}</strong>${detail}</span><button class="secondary disconnect-reasoning-connection" type="button" aria-label="Disconnect ${escapeHtml(name)}" data-connection="${escapeHtml(connection.id)}">Disconnect</button></div>`; }).join("")}</div><p class="micro">Start a new ChatGPT Work chat, open Tools, and select Driftglass.</p>`
    : "";
  const chatgptLabel = connections.length ? "Connect another" : "Connect ChatGPT";
  const claudeConnection = claude.mcpUrl || state.reasoningProviders?.mcpUrl || "";
  const genericSetup = generic.command || generic.mcpUrl || state.reasoningProviders?.mcpUrl || "";
  const chatgptAction = chatgptSetup
    ? `<button class="${connections.length ? "secondary" : "primary"} connect-chatgpt" type="button" data-copy-value="${escapeHtml(chatgptSetup)}">${chatgptLabel}</button>`
    : `<span class="connection-unavailable">ChatGPT connection needs setup in this install.</span>`;
  const openChatgptClass = connections.length ? "primary" : "secondary";
  target.innerHTML = `<article class="provider-card provider-card-featured"><div class="provider-card-head"><div><p class="eyebrow">ChatGPT</p><h4>Use Driftglass in ChatGPT</h4></div>${connections.length ? '<span class="connection-state connected">Connected</span>' : ""}</div><p>Ask about Today or any Mission and get a source-linked answer.</p>${connectionList}<div class="provider-actions provider-actions-row">${chatgptAction}<a class="${openChatgptClass}" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT</a></div></article><article class="provider-card"><div><p class="eyebrow">Claude</p><h4>Use Driftglass in Claude</h4><p>Bring current sources and Mission memory into Claude or Claude Code.</p></div><div class="provider-actions">${claudeConnection ? `<button class="primary copy-provider" type="button" data-copy-value="${escapeHtml(claudeConnection)}">Copy Claude connection</button>` : ""}${claude.command ? `<button class="secondary copy-provider" type="button" data-copy-value="${escapeHtml(claude.command)}">Copy Claude Code command</button>` : ""}</div></article><article class="provider-card"><div><p class="eyebrow">Other models</p><h4>Use any MCP client</h4><p>Connect Grok or another capable model, or use the prepared brief below.</p></div><div class="provider-actions">${genericSetup ? `<button class="primary copy-provider" type="button" data-copy-value="${escapeHtml(genericSetup)}">Copy connection</button>` : ""}</div></article>`;
  if (connections.length) target.querySelector(".provider-card-featured")?.insertAdjacentHTML("beforeend", chatgptPluginDownloadMarkup());
}

async function refreshReasoningConnections() {
  state.reasoningConnections = await api("/api/reasoning/connections");
  renderReasoningProviders();
}


function parseRowJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  return parseJsonSafe(value, fallback) ?? fallback;
}

function judgmentEmpty(title, detail) {
  return `<div class="empty-state compact"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function reasoningValue(input, names) {
  for (const name of names) {
    const value = input?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function reasoningItemText(item, objectKeys) {
  if (typeof item === "string" && item.trim()) return item.trim();
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const title = reasoningValue(item, ["title", "name"]);
  let body = reasoningValue(item, objectKeys);
  if (!body) {
    for (const key of objectKeys) {
      const nested = item[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
      body = reasoningValue(nested, ["text", "summary", "claim", "judgment", "driver", "description"]);
      if (body) break;
    }
  }
  return title && body && title !== body ? `${title}: ${body}` : body || title;
}

function reasoningList(input, names, objectKeys = ["claim", "judgment", "driver", "text", "summary", "action", "step", "description"]) {
  for (const name of names) {
    const value = input?.[name];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    const output = values.map((item) => reasoningItemText(item, objectKeys)).filter(Boolean);
    if (output.length) return [...new Set(output)];
  }
  return [];
}

function reasoningNarrative(input, names) {
  for (const name of names) {
    const value = input?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    const text = reasoningItemText(value, ["text", "summary", "claim", "judgment", "description"]);
    if (text) return text;
  }
  return "";
}

function reasoningCitationUrls(input) {
  const urls = [];
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (["citationUrl", "url", "sourceUrl"].includes(key)) {
        const safe = safeHref(value);
        if (safe) urls.push(safe);
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (["citations", "citationUrls"].includes(childKey) && Array.isArray(child)) {
        for (const item of child) visit(item, "citationUrl");
      } else visit(child, childKey);
    }
  };
  visit(input);
  return [...new Set(urls)].slice(0, 16);
}

function reasoningOptions(input) {
  if (!Array.isArray(input?.options)) return [];
  return input.options.flatMap((option) => {
    if (typeof option === "string" && option.trim()) return [{ name: option.trim(), tradeoff: "" }];
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const name = reasoningValue(option, ["name", "option", "title"]);
    if (!name) return [];
    return [{ name, tradeoff: reasoningValue(option, ["tradeoff", "reason", "consequence", "description"]) }];
  }).slice(0, 6);
}

function reasoningEvidence(input) {
  if (!Array.isArray(input?.strongestEvidence)) return [];
  return input.strongestEvidence.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ claim: item.trim(), citationUrl: "" }];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const claim = reasoningItemText(item, ["claim", "judgment", "summary", "text"]);
    if (!claim) return [];
    return [{ claim, citationUrl: safeHref(reasoningValue(item, ["citationUrl", "url", "sourceUrl"])) }];
  }).slice(0, 8);
}

function reasoningRunAnalysis(run) {
  const structured = parseRowJson(run?.structuredResult ?? run?.structured_result_json, {});
  const recommendation = reasoningValue(structured, ["recommendation", "answer", "conclusion", "thesis", "bottomLine", "bottom_line"]);
  const structuredSummary = reasoningValue(structured, ["summary", "whyItMatters", "why_it_matters", "significance"]);
  const fallbackSummary = typeof run?.summary === "string" ? run.summary.trim() : typeof run?.response_summary === "string" ? run.response_summary.trim() : "";
  const answer = recommendation || structuredSummary || fallbackSummary;
  const summary = (structuredSummary || fallbackSummary) === answer ? "" : structuredSummary || fallbackSummary;
  const strongestEvidence = reasoningEvidence(structured);
  const keyJudgments = reasoningList(structured, ["keyJudgments", "key_judgments", "drivers", "causalDrivers", "causal_drivers"]);
  return {
    answer,
    summary,
    options: reasoningOptions(structured),
    keyJudgments: keyJudgments.length ? keyJudgments : strongestEvidence.map((item) => item.claim),
    strongestEvidence,
    outlook: reasoningNarrative(structured, ["outlook", "baseCase", "base_case", "mostLikelyCase", "most_likely_case"]),
    alternativeCase: reasoningNarrative(structured, ["alternativeCase", "alternative_case", "strongestContraryCase", "strongest_contrary_case", "contraryCase", "contrary_case", "competingExplanation", "competing_explanation"]),
    gaps: reasoningList(structured, ["evidenceGaps", "evidence_gaps", "uncertainty", "uncertainties", "caveats"]),
    whatWouldChange: reasoningList(structured, ["whatWouldChange", "what_would_change", "reversalTrigger", "reversal_trigger"]),
    signposts: reasoningList(structured, ["signposts", "indicators", "watchSignals", "watch_signals", "watchFor", "watch_for", "whatToWatch", "what_to_watch", "watchConditions", "nextChecks"]),
    nextSteps: reasoningList(structured, ["nextSteps", "next_steps", "reversibleNextSteps", "reversible_next_steps"]),
    citations: reasoningCitationUrls(structured),
  };
}

function reasoningSection(title, value) {
  if (!value || (Array.isArray(value) && !value.length)) return "";
  if (!Array.isArray(value)) return `<section><h4>${escapeHtml(title)}</h4><div>${escapeHtml(value)}</div></section>`;
  return `<section><h4>${escapeHtml(title)}</h4><ul>${value.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
}

function reasoningRunMarkup(run, runStatus) {
  const analysis = reasoningRunAnalysis(run);
  const options = analysis.options.length
    ? `<section><h4>Other options</h4><ul>${analysis.options.map((option) => `<li><strong>${escapeHtml(option.name)}</strong>${option.tradeoff ? `: ${escapeHtml(option.tradeoff)}` : ""}</li>`).join("")}</ul></section>`
    : "";
  const sources = [...new Set([...analysis.strongestEvidence.map((item) => item.citationUrl), ...analysis.citations].filter(Boolean))];
  const provenance = `<details><summary>Sources</summary>${sources.length ? `<ul>${sources.map((url, index) => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Source ${index + 1}</a></li>`).join("")}</ul>` : ""}</details>`;
  const content = analysis.answer
    ? `<div class="reasoning-analysis" style="display:grid;gap:12px;margin-top:12px;font-size:13px;line-height:1.5"><section><h4>Answer</h4><div><strong>${escapeHtml(analysis.answer)}</strong></div>${analysis.summary ? `<div>${escapeHtml(analysis.summary)}</div>` : ""}</section>${reasoningSection("Why this is happening", analysis.keyJudgments)}${reasoningSection("Outlook", analysis.outlook)}${options}${reasoningSection("Alternative case", analysis.alternativeCase)}${reasoningSection("Open questions", analysis.gaps)}${reasoningSection("What could change", analysis.whatWouldChange)}${reasoningSection("What to watch", analysis.signposts)}${reasoningSection("Next steps", analysis.nextSteps)}${provenance}</div>`
    : `<p>No answer saved.</p>${provenance}`;
  const actions = ["completed", "reviewed", "rejected"].includes(run.status)
    ? `<div class="top-actions"><button class="secondary reasoning-review" data-run="${escapeHtml(run.id)}" data-decision="approve">Approve</button><button class="secondary reasoning-review" data-run="${escapeHtml(run.id)}" data-decision="reject">Reject</button></div>`
    : "";
  const support = run.confidence == null ? "" : `${supportLabel(run.confidence)} · `;
  return `<article><div><strong>${escapeHtml(run.provider)}${run.model ? ` · ${escapeHtml(run.model)}` : ""}</strong><span>${support}${runStatus(run.status)}</span></div>${content}${actions}</article>`;
}

function enrichReasoningComparison(comparison, detailedRuns = []) {
  if (!comparison) return comparison;
  const details = new Map(detailedRuns.map((run) => [run.id, run]));
  return {
    ...comparison,
    runs: (comparison.runs || []).map((run) => {
      const detail = details.get(run.id);
      return detail ? { ...run, structuredResult: detail.structuredResult ?? parseRowJson(detail.structured_result_json, {}) } : run;
    }),
  };
}

function renderReasoningComparison(comparison = state.currentReasoningComparison) {
  const node = $("#reasoning-comparison");
  if (!node) return;
  if (!comparison || !Number(comparison.runCount || 0)) {
    node.innerHTML = `<p class="micro">No comparison yet. Save another answer from this source set to compare them.</p>`;
    return;
  }
  const divergent = comparison.divergentPairs || [];
  const agreement = Number(comparison.averageAgreement || 0);
  const agreementLabel = agreement >= .8 ? "Answers mostly agree" : agreement >= .55 ? "Answers partly agree" : "Answers disagree";
  const runStatus = (status) => ({ reviewed: "Approved", rejected: "Rejected", completed: "Awaiting review", pending: "Still running", failed: "Failed" }[status] || "Saved");
  node.innerHTML = `<div class="comparison-stats"><span>${agreementLabel}</span>${Number(comparison.providerCount || 0) > 1 ? "<span>Compared across models</span>" : ""}${comparison.needsAdjudication ? '<span class="badge warn">review the differences</span>' : ""}</div>${(comparison.runs || []).length ? `<div class="comparison-runs" style="grid-template-columns:1fr">${comparison.runs.map((run) => reasoningRunMarkup(run, runStatus)).join("")}</div>` : ""}${divergent.length ? `<div class="quality-blockers"><strong>The models disagree on the same source set</strong><ul>${divergent.slice(0, 4).map((pair) => `<li>${escapeHtml(pair.leftProvider)} and ${escapeHtml(pair.rightProvider)} emphasize different conclusions</li>`).join("")}</ul></div>` : ""}`;
}

async function openReasoningReceipt(receiptId, options = {}) {
  const [detail, comparisonResult] = await Promise.all([
    api(`/api/reasoning/receipts/${encodeURIComponent(receiptId)}`),
    api(`/api/reasoning/receipts/${encodeURIComponent(receiptId)}/compare`).catch(() => ({ comparison: null })),
  ]);
  state.currentReasoningReceipt = detail;
  state.currentReasoningComparison = enrichReasoningComparison(comparisonResult.comparison, detail.runs || []);
  state.reasoningBundle = detail.bundle;
  $("#reasoning-output").value = detail.markdown || "";
  renderReasoningQuality(detail.bundle);
  const panel = $("#reasoning-result-panel");
  panel.hidden = false;
  const receipt = detail.receipt || {};
  const form = $("#reasoning-result-form");
  form.elements.receiptId.value = receipt.id || receiptId;
  const structuredRequired = Boolean(detail.bundle?.resultContract && Object.keys(detail.bundle.resultContract).length);
  form.dataset.structuredRequired = structuredRequired ? "true" : "false";
  const responseLabel = form.elements.response?.closest("label");
  if (responseLabel?.firstChild) responseLabel.firstChild.nodeValue = structuredRequired ? "Structured result" : "Answer or structured result";
  form.elements.response.placeholder = structuredRequired
    ? "Paste the complete structured JSON result required by this brief."
    : "Paste the answer or a structured Driftglass result block.";
  const summaryLabel = form.elements.summary?.closest("label");
  if (summaryLabel) summaryLabel.hidden = structuredRequired;
  if (receipt.target) form.elements.provider.value = ["chatgpt", "claude", "grok", "generic"].includes(receipt.target) ? receipt.target : "generic";
  $("#reasoning-receipt-meta").innerHTML = `<span>${escapeHtml(receipt.task || "reasoning")}</span><span>${escapeHtml(receipt.scope_kind || "global")}</span><span>${compactNumber(receipt.evidence_count || 0)} source items</span><span>${compactNumber(receipt.independent_family_count || 0)} independent source groups</span>`;
  renderReasoningComparison();
  if (options.scroll !== false) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  return detail;
}

async function materializeJudgmentTask(taskId) {
  const result = await api(`/api/reasoning/tasks/${encodeURIComponent(taskId)}/materialize`, { method: "POST", body: "{}" });
  await loadAll();
  if (result.task?.receipt_id) await openReasoningReceipt(result.task.receipt_id);
  toast("Brief prepared");
}

function renderJudgment() {
  const judgment = state.judgment || {};
  const summary = judgment.summary || {};
  const summaryNode = $("#judgment-summary");
  if (!summaryNode) return;
  const lineage = judgment.lineage || [];
  const echoCount = lineage.filter((row) => row.relation === "echo").reduce((total, row) => total + Number(row.count || 0), 0);
  const independentCount = lineage.filter((row) => Number(row.independent || 0) === 1).reduce((total, row) => total + Number(row.count || 0), 0);
  summaryNode.innerHTML = [
    [Number(summary.readyReasoningTasks || 0) ? "Ready" : "Clear", Number(summary.readyReasoningTasks || 0) ? "a question merits deeper thought" : "no answer is waiting"],
    [Number(summary.dueDecisionReviews || 0) ? "Due" : "Current", Number(summary.dueDecisionReviews || 0) ? "a decision needs review" : "decision reviews"],
    [independentCount ? "Separated" : "Learning", independentCount ? "independent source groups" : "source relationships"],
    [echoCount ? "Grouped" : "Quiet", echoCount ? "repeated coverage identified" : "no repeated coverage found"],
  ].map(([value, label]) => `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join("");

  const tasks = judgment.reasoningInbox || [];
  const inbox = $("#judgment-inbox");
  inbox.innerHTML = tasks.length ? tasks.slice(0, 6).map((task, index) => `<article class="judgment-item ${index === 0 ? "featured" : ""}"><div class="story-kicker"><span>${escapeHtml(task.task)}</span><span>${escapeHtml(task.target)}</span></div><h5>${escapeHtml(task.objective || task.reason || "Reasoning task")}</h5><p>${escapeHtml(task.reason || "Prepared from current Mission and Story state.")}</p><div class="top-actions">${task.receipt_id ? `<button class="primary judgment-open-receipt" data-receipt="${escapeHtml(task.receipt_id)}">Open brief</button>` : `<button class="primary judgment-materialize" data-task="${escapeHtml(task.id)}">Prepare brief</button>`}<button class="secondary judgment-dismiss-task" data-task="${escapeHtml(task.id)}">Dismiss</button></div></article>`).join("") : judgmentEmpty("No questions are waiting.", "Prepare a brief from a Mission when you want a model answer.");

  const receipts = judgment.receipts || [];
  const runs = judgment.reasoningRuns || [];
  $("#judgment-receipts").innerHTML = receipts.length ? receipts.slice(0, 6).map((receipt) => {
    const receiptRuns = runs.filter((run) => run.receipt_id === receipt.id);
    const quality = parseRowJson(receipt.quality_json, {});
    const target = ({ chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", generic: "Another model" })[receipt.target] || "Your model";
    const task = ({ investigate: "Investigation", decision: "Decision", challenge: "Challenge", "daily-brief": "Today brief", "deep-research": "Broader review", "memory-update": "Memory review" })[receipt.task] || "Research";
    const support = quality.grade === "strong" ? "Well sourced" : quality.grade === "insufficient" ? "Needs another source" : "Sources attached";
    return `<button class="list-card judgment-open-receipt" data-receipt="${escapeHtml(receipt.id)}"><div><div><h4>${escapeHtml(receipt.title)}</h4><small>${target} · ${task} · ${receiptRuns.length ? "answer saved" : "awaiting an answer"}</small></div></div><span class="badge ${quality.grade === "strong" ? "good" : quality.grade === "insufficient" ? "warn" : ""}">${support}</span></button>`;
  }).join("") : judgmentEmpty("No prepared briefs yet.", "Prepare a brief, then compare answers from the same source set.");

  const decisions = judgment.decisions || [];
  const calibration = judgment.calibration || {};
  $("#judgment-decisions").innerHTML = `${Number(calibration.reviewedCount || 0) ? `<div class="calibration-strip"><span>${compactNumber(calibration.reviewedCount)} outcomes reviewed</span><span>${calibration.overallBrierScore == null ? "track record building" : "forecast track record available"}</span></div>` : ""}${decisions.length ? decisions.slice(0, 8).map((decision) => `<article class="judgment-item"><div class="story-kicker"><span>${escapeHtml(decision.decision_type)}</span><span>${escapeHtml(decision.status)}</span><span>${supportLabel(decision.confidence)}</span></div><h5>${escapeHtml(decision.title)}</h5><p>${escapeHtml(decision.statement)}</p><div class="top-actions">${decision.status === "open" ? `<button class="secondary decision-review" data-decision-id="${escapeHtml(decision.id)}">Review outcome</button>` : ""}${decision.mission_id ? `<button class="secondary mission-configure" data-mission="${escapeHtml(decision.mission_id)}">Open Mission</button>` : ""}</div></article>`).join("") : judgmentEmpty("No decisions or forecasts yet.", "Save decisions and forecasts so Driftglass can revisit what happened, not just remember what was said.")}`;

  const routines = judgment.routines || [];
  $("#judgment-routines").innerHTML = routines.length ? routines.slice(0, 8).map((routine) => {
    const definition = routine.definition || parseRowJson(routine.definition_json, {});
    const last = routine.lastRun || null;
    const trigger = definition.trigger === "scheduled" ? "Automatic" : "When you ask";
    const lastState = last?.status === "complete" ? "last check finished" : last?.status === "failed" ? "last check needs attention" : last ? "last check in progress" : "not run yet";
    return `<article class="judgment-item"><div class="story-kicker"><span>${trigger}</span></div><h5>${escapeHtml(routine.name)}</h5><p>${escapeHtml(routine.description || "A recurring research update.")}</p><small>${routine.next_run_at ? `Next ${formatDate(routine.next_run_at)}` : "Run when useful"} · ${lastState}</small><div class="top-actions"><button class="secondary routine-run" data-routine="${escapeHtml(routine.id)}">Run now</button></div></article>`;
  }).join("") : judgmentEmpty("No scheduled research is installed.", "Packs can add repeatable checks that collect sources, update memory, and prepare a brief.");
}

async function openDecisionReview(decisionId) {
  const result = await api(`/api/decisions/${encodeURIComponent(decisionId)}`);
  const decision = result.decision;
  $("#research-detail").innerHTML = `<p class="eyebrow">Outcome review</p><h2>${escapeHtml(decision.title)}</h2><p class="dialog-summary">${escapeHtml(decision.statement)}</p><div class="story-meta"><span>${escapeHtml(decision.decision_type)}</span><span>Initial view: ${supportLabel(decision.confidence)}</span><span>${escapeHtml(decision.status)}</span></div><form id="decision-review-form" class="stack-form"><input name="decisionId" type="hidden" value="${escapeHtml(decision.id)}" /><label>Observed outcome<textarea name="observedOutcome" rows="4" required></textarea></label><div class="form-row"><label>Actual value<input name="actualValue" type="number" min="0" max="1" step="0.01" placeholder="0 or 1 for forecasts" /></label><label>How well did the decision hold up?<select name="qualityScore"><option value="0.35">Poorly</option><option value="0.7" selected>Partly</option><option value="0.95">Well</option></select></label><label>Status<select name="status"><option value="resolved">Resolved</option><option value="reversed">Reversed</option><option value="expired">Expired</option></select></label></div><label>Lesson<textarea name="lesson" rows="3" placeholder="What should future decisions learn from this outcome?"></textarea></label><button class="primary" type="submit">Save review</button></form>`;
  $("#research-dialog").showModal();
  $("#decision-review-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const body = { observedOutcome: data.observedOutcome, actualValue: data.actualValue === "" ? null : Number(data.actualValue), qualityScore: data.qualityScore === "" ? null : Number(data.qualityScore), status: data.status, lesson: data.lesson, provider: "owner" };
    await api(`/api/decisions/${encodeURIComponent(decision.id)}/review`, { method: "POST", body: JSON.stringify(body) });
    $("#research-dialog").close();
    await loadAll();
    toast("Decision outcome reviewed");
  }, { once: true });
}

function renderReasoningQuality(bundle) {
  const target = $("#reasoning-quality");
  if (!target) return;
  const quality = bundle?.quality;
  if (!quality) {
    target.className = "context-quality empty";
    target.innerHTML = `<strong>Brief details appear after preparation.</strong><span>Source items and limits appear here.</span>`;
    return;
  }
  const coverage = bundle.coverage || {};
  const blockers = quality.blockers || [];
  const recommendations = quality.recommendations || [];
  const packs = bundle.relevantPacks || [];
  const sourceItems = Number(coverage.evidenceCount || 0);
  const sourceGroups = Number(coverage.independentFamilyCount || 0);
  const omittedRepeats = Number(coverage.echoCount || 0);
  target.className = `context-quality ${blockers.length ? "insufficient" : "usable"}`;
  target.innerHTML = `<div class="context-quality-head"><div><span class="eyebrow">Brief details</span><strong>${compactNumber(sourceItems)} source item${sourceItems === 1 ? "" : "s"}</strong></div><div class="quality-coverage"><span>${compactNumber(sourceGroups)} source group${sourceGroups === 1 ? "" : "s"}</span>${omittedRepeats ? `<span>${compactNumber(omittedRepeats)} repeated item${omittedRepeats === 1 ? "" : "s"} omitted</span>` : ""}</div></div>${blockers.length ? `<div class="quality-blockers"><strong>Limits</strong><ul>${blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}${recommendations.length ? `<div class="quality-recommendations"><strong>Sources to add</strong><ul>${recommendations.slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}${packs.length ? `<div class="quality-packs"><span>Related Intelligence Packs</span>${packs.map((pack) => `<b>${escapeHtml(pack.name)}</b>`).join("")}</div>` : ""}${quality.deepResearchRecommended ? `<button class="secondary reasoning-use-deep-research" type="button">Prepare for Deep Research</button>` : ""}`;
}

function resolveScopeReference(scopeKind, value) {
  const reference = String(value || "").trim();
  if (!reference) return "";
  const candidates = scopeKind === "mission"
    ? state.missions || []
    : scopeKind === "story" ? state.overview?.stories || [] : [];
  if (!candidates.length) return reference;
  const exactId = candidates.find((item) => String(item.id || "") === reference);
  if (exactId) return String(exactId.id);
  const normalized = reference.toLocaleLowerCase();
  const named = candidates.filter((item) => String(item.name || item.title || "").trim().toLocaleLowerCase() === normalized);
  if (named.length === 1) return String(named[0].id);
  if (named.length > 1) throw new Error(`More than one ${scopeKind} has that name. Open the one you mean and copy its reference.`);
  return reference;
}

function reasoningFormPayload() {
  const form = $("#reasoning-form");
  if (!form) return { target: "chatgpt", task: "investigate", scopeKind: "global", tokenBudget: 24000 };
  const data = Object.fromEntries(new FormData(form));
  return {
    target: data.target || "chatgpt",
    task: data.task || "investigate",
    scopeKind: data.scopeKind || "global",
    scopeId: resolveScopeReference(String(data.scopeKind || "global"), String(data.scopeId || "")) || undefined,
    objective: String(data.objective || "").trim() || undefined,
    tokenBudget: Number(data.tokenBudget || 24000),
    sourceScope: ["open", "personal", "share"].includes(String(data.sourceScope)) ? String(data.sourceScope) : "personal",
  };
}

function showIntelligencePackPreview(pack, preview, sourceUrl = "") {
  state.pendingPackPreview = { pack, preview, sourceUrl };
  const cloudWarnings = preview.warnings || [];
  const companionWarnings = preview.companionWarnings || [];
  const companionCount = Number(preview.companionSourceCount || 0);
  const runnableCloudCount = Number(preview.immediatelyRunnableCloudSourceCount ?? preview.cloudSourceCount ?? 0);
  const credentialDeferredCount = Number(preview.credentialDeferredSourceCount || 0);
  const cloudFit = Boolean(preview.fitsProfile);
  const fullFit = Boolean(preview.fitsWithCompanion);
  const expandedCapacity = state.intelligence?.budget?.executionCapacity === "expanded-confirmed";
  const evidencePolicy = preview.evidencePolicy || pack.evidencePolicy || {};
  const lane = (title, fit, values, warnings, tone) => `<article class="pack-budget-lane ${fit ? "fits" : "over"}"><div class="pack-budget-head"><div><span>${escapeHtml(title)}</span><strong>${fit ? "Ready on this plan" : "Needs a larger plan"}</strong></div><span class="badge ${fit ? "good" : "warn"}">${escapeHtml(tone)}</span></div>${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : `<p>Fits your current plan.</p>`}<details class="advanced-details"><summary>Usage estimate</summary><dl><div><dt>Setup work</dt><dd>${compactNumber(values.queries)}</dd></div><div><dt>Source checks / day</dt><dd>${compactNumber(values.sourceRuns)}</dd></div><div><dt>Collected items / day</dt><dd>${compactNumber(values.queue)}</dd></div><div><dt>Page reading / day</dt><dd>${Number(values.browser || 0).toFixed(1)} min</dd></div><div><dt>Scheduled work / day</dt><dd>${compactNumber(values.workflow)}</dd></div></dl></details></article>`;
  const policyItems = [
    ...(evidencePolicy.preferredDomains || []).slice(0, 6).map((domain) => `Prefer ${domain}`),
    evidencePolicy.minPrimarySources ? `At least ${evidencePolicy.minPrimarySources} primary source${evidencePolicy.minPrimarySources === 1 ? "" : "s"}` : "",
    evidencePolicy.minIndependentSources ? `At least ${evidencePolicy.minIndependentSources} independent source${evidencePolicy.minIndependentSources === 1 ? "" : "s"}` : "",
    evidencePolicy.maxDiscoveryShare !== undefined ? `Discovery sources capped at ${Math.round(Number(evidencePolicy.maxDiscoveryShare) * 100)}%` : "",
  ].filter(Boolean);
  const fitAction = cloudFit
    ? `<button class="primary install-intelligence-pack" data-companion="false">Install</button>`
    : preview.profile !== "cheap"
      ? `<button class="primary pack-switch-cheap">Switch to low-cost plan</button>`
      : !expandedCapacity
        ? `<button class="primary pack-review-capacity">Open Usage plan</button>`
        : "";
  $("#story-detail").innerHTML = `<p class="eyebrow">Intelligence Pack</p><h2>${escapeHtml(pack.name)}</h2><p class="dialog-summary">${escapeHtml(pack.description || "")}</p><div class="story-meta"><span>${runnableCloudCount} sources ready</span>${credentialDeferredCount ? `<span>${credentialDeferredCount} waiting for setup</span>` : ""}<span>${companionCount} optional signed-in sources</span><span>${escapeHtml(preview.profile)} plan</span></div><div class="pack-budget-comparison">${lane("Without Companion", cloudFit, { queries: preview.estimatedInstallQueries, sourceRuns: preview.projectedSourceRunsPerDay, queue: preview.projectedQueueMessagesPerDay, browser: preview.projectedBrowserMinutesPerDay, workflow: preview.projectedWorkflowStepsPerDay }, cloudWarnings, "default")}${companionCount ? lane("With Companion", fullFit, { queries: preview.withCompanionEstimatedInstallQueries, sourceRuns: preview.withCompanionSourceRunsPerDay, queue: preview.withCompanionQueueMessagesPerDay, browser: preview.withCompanionBrowserMinutesPerDay, workflow: preview.withCompanionWorkflowStepsPerDay }, companionWarnings, "optional") : ""}</div><section class="pack-preview-section"><p class="eyebrow">What it adds</p><div class="feature-list"><span>${pack.missions?.length || 0} Missions</span><span>${pack.views?.length || 0} focused views</span><span>${pack.memory?.entities?.length || 0} memory seeds</span><span>${pack.reasoning?.researchPlaybooks?.length || 0} research methods</span><span>${preview.routineCount ?? pack.routines?.length ?? 0} scheduled routines</span></div></section>${policyItems.length ? `<section class="pack-preview-section"><p class="eyebrow">Source standards</p><div class="feature-list">${policyItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div></section>` : ""}<div class="top-actions">${fitAction}${companionCount && fullFit ? `<button class="secondary install-intelligence-pack" data-companion="true">Install with Companion</button>` : ""}<button class="secondary download-pack-skill" data-pack="${escapeHtml(pack.id)}">Download Pack Skill</button></div>`;
  if (!$("#story-dialog").open) $("#story-dialog").showModal();
}

async function previewIntelligencePackInput(input, sourceUrl = "") {
  const result = await api("/api/intelligence-packs/preview", { method: "POST", body: JSON.stringify(sourceUrl ? { url: sourceUrl } : { pack: input }) });
  showIntelligencePackPreview(result.pack, result.preview, sourceUrl || result.sourceUrl || "");
}

async function installPendingIntelligencePack(includeCompanionSources) {
  const pending = state.pendingPackPreview;
  if (!pending) throw new Error("Preview an Intelligence Pack first");
  if (!pending.preview?.fitsProfile) throw new Error("This Pack does not fit the selected plan");
  if (includeCompanionSources && !pending.preview?.fitsWithCompanion) throw new Error("This Pack with Companion does not fit the selected plan");
  const endpoint = pending.sourceUrl ? "/api/intelligence-packs/install-url" : "/api/intelligence-packs/install";
  const body = pending.sourceUrl
    ? { url: pending.sourceUrl, includeCompanionSources }
    : { pack: pending.pack, includeCompanionSources };
  await api(endpoint, { method: "POST", body: JSON.stringify(body) });
  await api("/api/sources/run-due", { method: "POST", body: "{}" });
  state.pendingPackPreview = null;
  $("#story-dialog").close();
  await loadAll();
  const deferred = Number(pending.preview?.credentialDeferredSourceCount || 0);
  toast(deferred
    ? `Installed ${pending.pack.name} · ${deferred} OpenAlex source${deferred === 1 ? " is" : "s are"} waiting for the optional Worker secret`
    : `Installed ${pending.pack.name} · cloud intelligence is active`);
}

function healthBadge(score, enabled = true) {
  if (!enabled) return `<span class="badge">paused</span>`;
  return score >= .7 ? `<span class="badge good">healthy</span>` : `<span class="badge warn">degraded</span>`;
}

function sourceKindLabel(kind) {
  return ({ web: "Adaptive web", web_feed: "Page Feed", github_releases: "GitHub releases", github_activity: "GitHub activity", npm_releases: "npm", pypi_releases: "PyPI", hackernews: "HN", lobsters: "Lobsters", bluesky: "Bluesky", arxiv: "arXiv", openalex: "OpenAlex", collector: "Companion", manual: "Capture", email: "Email" })[kind] || kind;
}

function sourceTable() {
  const sources = state.overview?.sources || [];
  const cadence = new Map((state.judgment?.cadence || []).map((row) => [row.source_id, row]));
  const scorecards = new Map((state.judgment?.sourceScorecards || []).map((row) => [row.sourceId, row]));
  if (!sources.length) return `<div class="empty-state"><strong>No sources configured.</strong><span>Use Smart Add or install an Intelligence Pack.</span></div>`;
  return `<table><thead><tr><th>Source</th><th>Type</th><th>Checks</th><th>Health</th><th>Last useful check</th><th>Value</th><th></th></tr></thead><tbody>${sources.map((source) => {
    const lane = cadence.get(source.id);
    const scorecard = scorecards.get(source.id);
    const cadenceMarkup = lane ? `<strong>${cadenceModeLabel(lane.mode)} · ${durationLabel(lane.effective_minutes)}</strong><br><span class="micro">${escapeHtml(cadenceReasonLabel(lane.last_reason))}${lane.next_run_at ? ` · next ${formatDate(lane.next_run_at)}` : ""}</span>` : `<strong>Every ${durationLabel(source.schedule_minutes)}</strong><br><span class="micro">adapts after the first useful check</span>`;
    const runtimeAccess = source.runtimeAccess || { runnable: true };
    const blocked = runtimeAccess.runnable === false;
    const valueMarkup = blocked
      ? `<strong>Setup required</strong><br><span class="micro">${escapeHtml(runtimeAccess.detail || "This source is waiting for an optional runtime credential.")}</span>`
      : source.last_error
        ? `<strong>Last run needs attention</strong><br><span class="micro">${escapeHtml(source.last_error)}</span>`
        : scorecard
          ? `<strong>${escapeHtml(sourceValueLabel(scorecard.valueScore))}</strong><br><span class="micro">${escapeHtml(sourceCoverageLabel(scorecard.independenceRate))}${Number(scorecard.missionMatches || 0) ? " · supports current Mission work" : ""}</span>`
          : escapeHtml(source.last_run_at ? "Ready" : "Awaiting first run");
    const healthMarkup = blocked ? `<span class="badge warn">waiting for setup</span>` : healthBadge(source.health_score, source.enabled);
    return `<tr><td><strong>${escapeHtml(source.name)}</strong></td><td><span class="source-kind">${escapeHtml(sourceKindLabel(source.kind))}</span></td><td>${cadenceMarkup}</td><td>${healthMarkup}</td><td>${formatDate(source.last_success_at)}</td><td>${valueMarkup}</td><td><div class="table-actions"><button data-run="${escapeHtml(source.id)}" ${blocked ? `disabled title="Finish this source's setup, then reload Driftglass"` : ""}>Run</button><button data-delete="${escapeHtml(source.id)}">Delete</button></div></td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderSources() {
  const html = sourceTable();
  $("#source-list").innerHTML = html;
  $("#source-list-standalone").innerHTML = html;
}

function renderRuntimeFabric() {
  const target = $("#runtime-fabric");
  if (!target) return;
  const context = state.runtime?.context || {};
  const capabilities = state.runtime?.capabilities || [];
  const available = {
    worker: true,
    kitesurf: Boolean(context.browserAvailable),
    chromium: Boolean(context.browserAvailable),
    computer: Boolean(context.computerAvailable),
    companion: Boolean(context.companionOnline),
  };
  const labels = {
    worker: "Core collection",
    queue: "Collection handoff",
    mcp: "AI connections",
    "mcp-stdio": "Local AI connection",
    backup: "Backup and restore",
    "public-sharing": "Public sharing",
    email: "Email intake",
    companion: "Signed-in sources",
    "semantic-search": "Concept search",
    kitesurf: "Quick page reader",
    chromium: "Full browser reader",
    computer: "Mission workspace",
    workflow: "Scheduled research",
    scheduler: "Collection schedule",
  };
  target.innerHTML = capabilities.map((entry) => {
    const runtime = String(entry.runtime || "");
    const status = typeof entry.available === "boolean" ? entry.available : available[runtime];
    const detail = runtime === "computer" && context.computerAvailable
      ? context.computerPowerAvailable ? "Mission workspace + Power Mode" : "persistent Mission workspace"
      : runtime === "companion" ? context.companionOnline ? "signed-in sources ready" : "optional · currently offline"
      : runtime === "kitesurf" ? context.browserAvailable ? "quick page reader ready" : "page reader unavailable"
      : runtime === "chromium" ? context.browserAvailable ? "full-browser fallback ready" : "full-browser fallback unavailable"
      : "collection ready";
    return `<article class="runtime-card ${status ? "available" : "offline"}"><div><span>${escapeHtml(labels[runtime] || "Additional capability")}</span><strong>${status ? "ready" : runtime === "companion" ? "optional" : "unavailable"}</strong></div><p>${escapeHtml((entry.bestFor || []).slice(0, 3).join(" · "))}</p><small>${escapeHtml(detail)}</small></article>`;
  }).join("");
  const policy = context.policy || {};
  const note = $("#runtime-policy-note");
  if (note) note.textContent = `${policy.mode === "auto" || !policy.mode ? "automatic" : policy.mode} · ${context.budgetProfile || "free"} plan · signed-in sources ${context.companionOnline ? "ready" : "optional"}`;
}

async function openMissionDossier(id) {
  const params = new URLSearchParams({ scopeKind: "mission", scopeId: id });
  const [result, markdownText] = await Promise.all([
    api(`/api/dossiers?${params.toString()}`),
    apiText(`/api/dossiers?${params.toString()}&format=markdown`),
  ]);
  state.currentDossier = { dossier: result.dossier, markdown: markdownText };
  const quality = result.dossier?.quality || {};
  $("#story-detail").innerHTML = `<p class="eyebrow">Question brief</p><h2>${escapeHtml(result.dossier?.focus?.label || id)}</h2><div class="story-meta"><span>${escapeHtml(quality.grade || "compiled")}</span><span>${Number(result.dossier?.evidence?.length || 0)} source items</span></div><pre class="dossier-preview">${escapeHtml(markdownText)}</pre><div class="top-actions"><button class="secondary mission-dossier-copy">Copy brief</button><button class="secondary mission-dossier-download" data-mission="${escapeHtml(id)}">Download Markdown</button></div>`;
  if (!$("#story-dialog").open) $("#story-dialog").showModal();
}

function renderSourceScorecards() {
  const target = $("#source-scorecards");
  if (!target) return;
  const cards = state.judgment?.sourceScorecards || [];
  if (!cards.length) {
    target.innerHTML = `<div class="empty-state compact"><strong>Source value appears after collection.</strong><span>Driftglass measures unique Story yield, Mission contribution, independence from copied coverage, reliability, latency, and browser cost.</span></div>`;
    return;
  }
  target.innerHTML = cards.slice(0, 18).map((source) => {
    const cadence = source.cadence || {};
    const effective = Number(cadence.effective_minutes || cadence.effective_schedule_minutes || cadence.base_minutes || cadence.base_schedule_minutes || 0);
    const tone = source.recommendation === "accelerate" ? "good" : ["repair", "pause"].includes(source.recommendation) ? "bad" : source.recommendation === "slow" ? "warn" : "";
    const stories = Number(source.uniqueStories || 0);
    const missions = Number(source.missionMatches || 0);
    const storyLabel = stories ? `${compactNumber(stories)} useful ${stories === 1 ? "Story" : "Stories"}` : "No useful Story yet";
    const missionLabel = missions ? `Supports ${missions === 1 ? "a Mission" : `${compactNumber(missions)} Missions`}` : "Not linked to a Mission yet";
    const reasons = (source.reasons || ["This pace fits its recent contribution."]).map(sourceReasonLabel);
    return `<article class="source-scorecard"><div class="source-score-head"><div><span>${escapeHtml(sourceKindLabel(source.kind))}</span><h4>${escapeHtml(source.name)}</h4></div><strong>${escapeHtml(sourceValueLabel(source.valueScore))}</strong></div><div class="source-score-metrics"><span>${escapeHtml(sourceCoverageLabel(source.independenceRate))}</span><span>${storyLabel}</span><span>${missionLabel}</span><span>${escapeHtml(sourceReliabilityLabel(source.successRate))}</span>${effective ? `<span>checks about every ${durationLabel(effective)}</span>` : ""}</div><div class="source-score-foot"><span class="badge ${tone}">${escapeHtml(sourceRecommendationLabel(source.recommendation))}</span><small>${escapeHtml(reasons.join(" · "))}</small></div></article>`;
  }).join("");
}

function renderCollectors() {
  const collectors = state.overview?.collectors || [];
  $("#collector-list").innerHTML = collectors.length ? `<table><thead><tr><th>Companion</th><th>Status</th><th>Version</th><th>Platform</th><th>Last seen</th><th>Capabilities</th></tr></thead><tbody>${collectors.map((collector) => {
    let details = {}; let capabilities = [];
    try { details = JSON.parse(collector.details_json || "{}"); } catch {}
    try { capabilities = JSON.parse(collector.capabilities_json || "[]"); } catch {}
    return `<tr><td><strong>${escapeHtml(collector.name)}</strong></td><td>${collector.status === "online" ? '<span class="badge good">online</span>' : '<span class="badge warn">offline</span>'}</td><td>${escapeHtml(collector.version || "")}</td><td>${escapeHtml(details.platform || details.architecture || "")}</td><td>${formatDate(collector.last_seen_at)}</td><td>${capabilities.length}</td></tr>`;
  }).join("")}</tbody></table>` : `<div class="empty-state"><strong>Cloud mode is active.</strong><span>Pair a Companion when you want personalized signed-in sources.</span></div>`;
}

function renderCatalog(query = "") {
  const needle = query.trim().toLowerCase();
  const entries = (state.capabilities.catalog || []).filter((entry) => !needle || `${entry.site} ${entry.command} ${entry.description || ""}`.toLowerCase().includes(needle)).slice(0, 120);
  $("#catalog-list").innerHTML = entries.length ? entries.map((entry) => {
    const online = (entry.collectors || []).filter((collector) => collector.status === "online").length;
    return `<article class="pack catalog-card"><div class="pack-top"><span class="pack-category">${escapeHtml(entry.strategy || "read")}</span></div><div><h4>${escapeHtml(entry.site)} · ${escapeHtml(entry.command)}</h4><p>${escapeHtml(entry.description || "OpenCLI source discovered from the paired Companion.")}</p></div><div class="catalog-args">${(entry.args || []).slice(0, 5).map((arg) => `<span>${escapeHtml(arg.name)}${arg.required ? "*" : ""}</span>`).join("")}${(entry.args || []).length > 5 ? `<span>+${entry.args.length - 5}</span>` : ""}</div><div class="pack-foot"><span>${entry.browser === false ? "public" : "uses your browser"} · ${online}/${(entry.collectors || []).length} ready</span><button class="primary catalog-add" data-site="${escapeHtml(entry.site)}" data-command="${escapeHtml(entry.command)}">Add source</button></div></article>`;
  }).join("") : `<div class="empty-state"><strong>No catalog entries yet.</strong><span>Pair a Companion; its current OpenCLI read manifest appears here automatically.</span></div>`;
}

function adapterField(arg) {
  const name = escapeHtml(arg.name);
  const help = escapeHtml(arg.help || (arg.positional ? "Positional argument" : `OpenCLI --${arg.name}`));
  const required = arg.required ? " required" : "";
  const marker = arg.required ? " · required" : "";
  const type = String(arg.type || "str").toLowerCase();
  const defaultValue = arg.default === undefined || arg.default === null ? "" : arg.default;
  if (Array.isArray(arg.choices) && arg.choices.length) {
    return `<label>${name}<select class="adapter-arg" data-arg="${name}"${required}><option value="">Use adapter default</option>${arg.choices.map((choice) => `<option value="${escapeHtml(choice)}"${String(choice) === String(defaultValue) ? " selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select><small>${help}${marker}</small></label>`;
  }
  if (["bool", "boolean", "flag"].includes(type)) {
    return `<label class="check-row adapter-check"><input class="adapter-arg" data-arg="${name}" type="checkbox"${defaultValue === true ? " checked" : ""} /><span><strong>${name}</strong><small>${help}${marker}</small></span></label>`;
  }
  if (["array", "list", "strings", "string[]"].includes(type) || Array.isArray(defaultValue)) {
    const value = Array.isArray(defaultValue) ? defaultValue.join("\n") : "";
    return `<label>${name}<textarea class="adapter-arg" data-arg="${name}" rows="3" placeholder="One value per line"${required}>${escapeHtml(value)}</textarea><small>${help}${marker}</small></label>`;
  }
  if (["json", "object", "record"].includes(type)) {
    const value = defaultValue && typeof defaultValue === "object" ? JSON.stringify(defaultValue, null, 2) : defaultValue;
    return `<label>${name}<textarea class="adapter-arg" data-arg="${name}" rows="4" placeholder='{"key":"value"}'${required}>${escapeHtml(value)}</textarea><small>${help}${marker}</small></label>`;
  }
  const inputType = ["int", "integer", "count", "float", "double", "number"].includes(type) ? "number" : "text";
  const step = ["float", "double", "number"].includes(type) ? " step=\"any\"" : "";
  return `<label>${name}<input class="adapter-arg" data-arg="${name}" type="${inputType}" value="${escapeHtml(defaultValue)}"${step}${required} /><small>${help}${marker}</small></label>`;
}

function openAdapterBuilder(site, command) {
  const entry = (state.capabilities.catalog || []).find((candidate) => candidate.site === site && candidate.command === command);
  if (!entry) throw new Error("Adapter is no longer in the live Companion catalog");
  state.selectedAdapter = entry;
  $("#adapter-title").textContent = `${entry.site} · ${entry.command}`;
  $("#adapter-description").textContent = entry.description || "Create a recurring source from this live OpenCLI read adapter.";
  $("#adapter-command").textContent = `opencli ${entry.site} ${entry.command}`;
  $("#adapter-collector").innerHTML = (entry.collectors || []).map((collector) => `<option value="${escapeHtml(collector.id)}"${collector.id === entry.collectorId ? " selected" : ""}>${escapeHtml(collector.name)} · ${escapeHtml(collector.status)}${collector.platform ? ` · ${escapeHtml(collector.platform)}` : ""}</option>`).join("");
  $("#adapter-name").value = `${entry.site} · ${entry.command}`;
  $("#adapter-fields").innerHTML = (entry.args || []).length ? entry.args.map(adapterField).join("") : `<div class="empty-state compact"><strong>No parameters required.</strong><span>This adapter can run as configured.</span></div>`;
  $("#adapter-dialog").showModal();
}

function adapterSourcePayload(form) {
  const entry = state.selectedAdapter;
  if (!entry) throw new Error("Choose an adapter first");
  const data = Object.fromEntries(new FormData(form));
  const params = {};
  form.querySelectorAll(".adapter-arg").forEach((field) => {
    const name = field.dataset.arg;
    if (!name) return;
    if (field.type === "checkbox") {
      if (field.checked) params[name] = true;
      return;
    }
    const value = field.value.trim();
    if (!value) return;
    const definition = (entry.args || []).find((arg) => arg.name === name);
    const type = String(definition?.type || "str").toLowerCase();
    params[name] = ["array", "list", "strings", "string[]"].includes(type) || Array.isArray(definition?.default) ? lines(value) : value;
  });
  return {
    collectorId: data.collectorId,
    site: entry.site,
    command: entry.command,
    name: data.name,
    params,
    scheduleMinutes: Number(data.scheduleMinutes || 120),
    weight: Number(data.weight || 1.2),
    runNow: form.querySelector("[name=runNow]").checked,
  };
}

function renderIntegrations() {
  if (!state.integrations) return;
  const isSelfhost = state.runtime?.context?.profile === "selfhost";
  const remoteConnections = $("#remote-reasoning-connections");
  if (remoteConnections) remoteConnections.hidden = isSelfhost;
  const scheduledTaskPanel = $("#task-prompt")?.closest(".panel");
  if (scheduledTaskPanel) scheduledTaskPanel.hidden = isSelfhost;
  const scheduledCheckPanel = $(".pulse-panel");
  if (scheduledCheckPanel) scheduledCheckPanel.hidden = isSelfhost;
  const missionConnections = $("#mission-integrations");
  if (missionConnections) {
    missionConnections.hidden = isSelfhost;
    if (missionConnections.previousElementSibling) missionConnections.previousElementSibling.hidden = isSelfhost;
  }
  $("#task-prompt").value = state.integrations.scheduledTaskPrompt || "";
  $("#mcp-url").value = state.integrations.mcpUrl || state.reasoningProviders?.mcpUrl || "";
  $("#operations-mcp-url").value = state.integrations.operationsMcpUrl || state.reasoningProviders?.operationsMcpUrl || "";
  $("#packet-url").value = state.integrations.packetUrl || "";
  $("#pulse-packet-url").value = state.integrations.pulsePacketUrl || "";
  $("#pulse-task-prompt").value = state.integrations.pulseTaskPrompt || "";
  $("#ai-search-corpus-url").value = state.integrations.aiSearchCorpusUrl || "";
  const missions = state.integrations.missions || [];
  $("#mission-integrations").innerHTML = missions.length ? missions.map((mission) => `<article class="list-card integration-card"><div><div><h4>${escapeHtml(mission.name)}</h4><p>${escapeHtml(mission.question || "Focused Mission brief")}</p></div></div><div class="top-actions"><button class="secondary copy-value" data-copy-value="${escapeHtml(mission.scheduledTaskPrompt)}">Copy scheduled check</button><button class="secondary copy-value" data-copy-value="${escapeHtml(mission.deepResearchPacketUrl)}">Copy AI review brief</button></div></article>`).join("") : `<div class="empty-state"><strong>Create a Research Mission for focused checks.</strong><span>Each active Mission gets scheduled-check instructions and a prepared brief for your chosen AI.</span></div>`;
  const semantic = state.integrations.semanticMemory || {};
  const semanticNode = $("#semantic-memory-status");
  const semanticReady = Boolean(semantic.enabled && semantic.configured);
  if (semanticNode) semanticNode.innerHTML = semanticReady
    ? `<span class="badge good">enabled</span><small>${semantic.lastSyncAt ? `last sync ${escapeHtml(formatDate(semantic.lastSyncAt))}` : "ready for first sync"}</small>`
    : semantic.enabled
      ? `<span class="badge">repair</span><small>${escapeHtml(semantic.error || "AI Search is enabled but its instance is unavailable")}</small>`
      : semantic.available
        ? `<span class="badge">optional</span><small>${semantic.configured ? "configured" : "not configured"}</small>`
        : `<span class="badge">optional</span><small>${escapeHtml(semantic.error || "AI Search binding is unavailable")}</small>`;
  const semanticSetup = $("#semantic-memory-setup");
  if (semanticSetup) {
    semanticSetup.disabled = !semantic.available || semanticReady;
    semanticSetup.textContent = semanticReady ? "AI Search enabled" : semantic.enabled ? "Repair AI Search" : "Enable AI Search";
  }
  const semanticSync = $("#semantic-memory-sync");
  if (semanticSync) semanticSync.disabled = !semanticReady;
  $("#semantic-memory-search")?.querySelectorAll("input, select, button").forEach((control) => { control.disabled = !semanticReady; });
  const lab = state.integrations.deepDiveLab || {};
  const labNode = $("#deep-dive-status");
  if (labNode) labNode.innerHTML = lab.configured
    ? `<span class="badge good">connected</span><p>Local analysis tools are ready for selected Story and Mission workspaces${lab.url ? ` at ${escapeHtml(lab.url)}` : ""}.</p>`
    : `<span class="badge">optional</span><p>Connect local analysis tools for code, shell, or file transformations.</p>`;
}

function semanticChunkText(chunk) {
  const value = chunk.content ?? chunk.text ?? chunk.page_content ?? chunk.context ?? chunk.snippet ?? "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  return value && typeof value === "object" ? JSON.stringify(value) : "";
}

function renderSemanticResults(chunks = []) {
  const target = $("#semantic-memory-results");
  if (!target) return;
  target.innerHTML = chunks.length ? chunks.map((chunk, index) => {
    const metadata = chunk.metadata || chunk.custom_metadata || {};
    const score = Number(chunk.score ?? chunk.similarity ?? chunk.rerank_score ?? 0);
    const key = chunk.key || chunk.filename || chunk.file_name || metadata.record_id || `result-${index + 1}`;
    return `<article class="semantic-result"><div class="story-kicker"><span>${escapeHtml(metadata.kind || "memory")}</span>${score ? `<span>score ${score.toFixed(3)}</span>` : ""}</div><h4>${escapeHtml(String(key))}</h4><p>${escapeHtml(semanticChunkText(chunk).slice(0, 1500))}</p></article>`;
  }).join("") : `<div class="empty-state compact"><strong>No semantic match.</strong><span>Sync memory after adding Stories or Missions, then try a broader concept.</span></div>`;
}

function renderRenderHealth() {
  const rendering = state.overview?.renderStats || { totals: [], profiles: [] };
  const total = (engine, status) => rendering.totals.find((row) => row.engine === engine && row.status === status) || {};
  const kite = total("kitesurf", "success");
  const chrome = total("chromium", "success");
  $("#render-health").innerHTML = `<div class="render-cards"><div><span>Kitesurf</span><strong>${compactNumber(kite.attempts || 0)}</strong><small>${kite.average_ms ? `${Math.round(kite.average_ms)} ms average` : "agent-first route"}</small></div><div><span>Chromium fallback</span><strong>${compactNumber(chrome.attempts || 0)}</strong><small>${chrome.average_ms ? `${Math.round(chrome.average_ms)} ms average` : "full browser route"}</small></div></div>${(rendering.profiles || []).length ? `<div class="profile-list">${rendering.profiles.slice(0, 12).map((profile) => `<div><strong>${escapeHtml(profile.hostname)}</strong><span>${escapeHtml(profile.preferred_engine)} · last ${escapeHtml(profile.last_engine || "—")}</span></div>`).join("")}</div>` : '<p class="micro">Hostname profiles appear after rendered page checks.</p>'}`;
}

function renderShares() {
  const target = $("#share-list");
  if (!target) return;
  target.innerHTML = state.shares.length ? state.shares.slice(0, 12).map((share) => `<article class="list-card"><div><div><h4>${escapeHtml(share.title)}</h4><small>${escapeHtml(share.kind)} · expires ${formatDate(share.expires_at)} · ${compactNumber(share.view_count)} views</small></div></div></article>`).join("") : `<div class="empty-state"><strong>No shared views yet.</strong><span>Use Share on a Story or Mission, or Share Today above.</span></div>`;
}


function renderTaste() {
  const target = $("#taste-profile");
  if (!target) return;
  const profile = state.taste || {};
  const positive = profile.positiveTerms || [];
  const negative = profile.negativeTerms || [];
  const sources = [...(profile.preferredSources || []), ...(profile.downweightedSources || [])];
  if (!positive.length && !negative.length && !sources.length) {
    target.innerHTML = `<div class="empty-state"><strong>Your preferences start empty.</strong><span>Use More, Less, Track, Mute, and Bad source on Stories. Driftglass learns recurring terms and source preferences for future collection.</span></div>`;
    return;
  }
  const chips = (items, tone) => items.slice(0, 16).map((item) => `<span class="taste-chip ${tone}" title="${escapeHtml(`${item.positive_count || 0} positive · ${item.negative_count || 0} negative signals`)}">${escapeHtml(item.term)} <b>${Number(item.weight || 0).toFixed(2)}</b></span>`).join("");
  target.innerHTML = `<div class="taste-columns"><div><h4>Show me more</h4><div class="taste-cloud">${chips(positive, "positive") || '<span class="micro">Nothing learned yet.</span>'}</div></div><div><h4>Show me less</h4><div class="taste-cloud">${chips(negative, "negative") || '<span class="micro">Nothing muted yet.</span>'}</div></div></div>${sources.length ? `<div class="taste-source-list"><h4>Source preferences</h4>${sources.slice(0, 12).map((source) => `<div><span>${escapeHtml(source.source_name)}</span><strong class="${Number(source.weight) >= 0 ? "positive-text" : "negative-text"}">${Number(source.weight) > 0 ? "+" : ""}${Number(source.weight).toFixed(2)}</strong></div>`).join("")}</div>` : ""}`;
}

function rankingMarkup(explanation) {
  if (!explanation) return "";
  const components = (explanation.components || []).map((item) => {
    return `<div class="ranking-row"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.explanation)}</small></div>`;
  }).join("");
  const reasons = (explanation.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const positive = explanation.taste?.matchedPositive || [];
  const negative = explanation.taste?.matchedNegative || [];
  return `<details class="ranking-explanation"><summary>Why this appeared</summary>${explanation.muted ? '<p class="ranking-muted">Muted Stories stay out of briefings.</p>' : ""}<div class="ranking-grid">${components}</div>${reasons ? `<ul class="ranking-reasons">${reasons}</ul>` : ""}${positive.length || negative.length ? `<div class="taste-cloud compact">${positive.slice(0, 8).map((item) => `<span class="taste-chip positive">${escapeHtml(item.term)}</span>`).join("")}${negative.slice(0, 6).map((item) => `<span class="taste-chip negative">${escapeHtml(item.term)}</span>`).join("")}</div>` : ""}</details>`;
}

function renderReceipts() {
  $("#email-receipts").innerHTML = state.receipts.length ? state.receipts.slice(0, 6).map((receipt) => {
    const metadata = parseRowJson(receipt.metadata_json, {});
    const deliveries = Math.max(1, Number(receipt.delivery_count || 1));
    const attachments = Math.max(0, Number(metadata.attachmentCount || 0));
    const outcome = receipt.queue_state === "pending"
      ? "being saved"
      : receipt.queue_state === "failed"
        ? "needs attention"
        : deliveries > 1
          ? "already saved"
          : "saved";
    return `<article class="list-card"><div><div><h4>${escapeHtml(receipt.subject || "Forwarded signal")}</h4><small>${escapeHtml(receipt.sender || "")}${receipt.last_received_at || receipt.received_at ? ` · ${formatDate(receipt.last_received_at || receipt.received_at)}` : ""} · ${escapeHtml(outcome)}${attachments ? ` · ${attachments} attachment${attachments === 1 ? "" : "s"}` : ""}</small></div></div></article>`;
  }).join("") : `<p class="micro">Recent forwarded messages appear here.</p>`;
}

function renderSourceConfigFields(kind) {
  const target = $("#source-config-fields");
  if (kind === "web") target.innerHTML = `<label>URL<input name="url" type="url" required placeholder="https://www.iea.org/reports/gas-market-report-q3-2026" /></label><div class="form-row"><label>Page reader<select name="renderStrategy"><option value="adaptive">Choose automatically</option><option value="direct">Simple pages only</option><option value="kitesurf">Quick reader only</option><option value="chromium">Full browser only</option></select></label><label>Mode<select name="mode"><option value="monitor">Monitor changes</option><option value="article">Capture article</option></select></label></div><label>Optional CSS selector<input name="selector" placeholder="main, article, #report" /></label>`;
  else if (kind === "web_feed") target.innerHTML = `<label>Listing page URL<input name="url" type="url" required placeholder="https://www.nature.com/subjects/machine-learning" /></label><div class="form-row"><label>Listing reader<select name="renderStrategy"><option value="adaptive">Choose automatically</option><option value="direct">Simple pages only</option><option value="kitesurf">Quick reader only</option><option value="chromium">Full browser only</option></select></label><label>Article reader<select name="articleRenderStrategy"><option value="direct">Simple pages first</option><option value="adaptive">Choose automatically</option><option value="kitesurf">Quick reader</option><option value="chromium">Full browser</option></select></label></div><div class="form-row"><label>New links per check<input name="maxArticles" type="number" min="1" max="20" value="8" /></label><label class="check-row"><input name="sameOrigin" type="checkbox" checked />Same-site links only</label></div><label>Include URL/text pattern<input name="includePattern" placeholder="research|analysis|2026" /></label><label>Exclude URL/text pattern<input name="excludePattern" placeholder="tag|author|privacy" /></label>`;
  else if (kind === "github_releases") target.innerHTML = `<label>Repositories — one per line<textarea name="repos" rows="5" required placeholder="huggingface/transformers\npytorch/pytorch"></textarea></label><div class="form-row"><label>Releases per repository<input name="perRepo" type="number" min="1" max="10" value="3" /></label><label class="check-row"><input name="includePrereleases" type="checkbox" />Include prereleases</label></div>`;
  else if (kind === "github_activity") target.innerHTML = `<label>Repositories — one per line<textarea name="repos" rows="5" required placeholder="google-deepmind/alphafold3\nmaterialsproject/pymatgen"></textarea></label><div class="form-row"><label>Events per repository<input name="perRepo" type="number" min="1" max="100" value="30" /></label><label>Event types<input name="includeTypes" placeholder="PullRequestEvent, IssuesEvent, PushEvent" /></label></div><label>Watch terms<textarea name="watchTerms" rows="3" placeholder="protein design\nmaterials discovery\nbenchmark"></textarea></label>`;
  else if (kind === "npm_releases") target.innerHTML = `<label>npm packages — one per line<textarea name="packages" rows="5" required placeholder="typescript\nplaywright\nzod"></textarea></label><div class="form-row"><label>Versions per package<input name="perPackage" type="number" min="1" max="20" value="5" /></label><label class="check-row"><input name="includePrereleases" type="checkbox" />Include prereleases</label></div>`;
  else if (kind === "pypi_releases") target.innerHTML = `<label>PyPI packages — one per line<textarea name="packages" rows="5" required placeholder="numpy\npandas\nscikit-learn"></textarea></label><label>Versions per package<input name="perPackage" type="number" min="1" max="20" value="5" /></label>`;
  else if (kind === "hackernews") target.innerHTML = `<div class="form-row"><label>Feed<select name="feed"><option value="best">Best</option><option value="top">Top</option><option value="new">New</option></select></label><label>Minimum score<input name="minScore" type="number" min="0" value="10" /></label></div><label>Watch terms<textarea name="watchTerms" rows="3" placeholder="battery storage\nprotein design\nshipping"></textarea></label>`;
  else if (kind === "lobsters") target.innerHTML = `<div class="form-row"><label>Feed<select name="feed"><option value="hottest">Hottest</option><option value="newest">Newest</option></select></label><label>Minimum score<input name="minScore" type="number" min="0" value="3" /></label></div><label>Tags<input name="tags" placeholder="ai, security, distributed" /></label><label>Watch terms<textarea name="watchTerms" rows="3"></textarea></label>`;
  else if (kind === "bluesky") target.innerHTML = `<label>Mode<select name="bskyMode" id="bsky-mode"><option value="search">Search</option><option value="author">Author feed</option><option value="feed">Custom feed URI</option></select></label><div id="bsky-mode-fields"><label>Search query<input name="query" required placeholder='"materials science" OR "LNG market"' /></label></div>`;
  else if (kind === "arxiv") target.innerHTML = `<label>Search query<input name="query" placeholder='"protein design" OR "materials discovery"' /></label><label>Categories<input name="categories" placeholder="q-bio.BM, cs.LG, cond-mat.mtrl-sci" /></label><div class="form-row"><label>Limit<input name="limit" type="number" min="1" max="100" value="40" /></label><label>Sort<select name="sortBy"><option value="submittedDate">Newest submissions</option><option value="lastUpdatedDate">Recently updated</option><option value="relevance">Relevance</option></select></label></div>`;
  else if (kind === "openalex") target.innerHTML = `<p class="micro">OpenAlex requires a free account key for every API request. Configure it only as the <code>OPENALEX_API_KEY</code> Worker secret—never enter it here. <a href="https://developers.openalex.org/guides/authentication" target="_blank" rel="noreferrer">OpenAlex setup guide</a></p><label>Research query — scheduled search<input name="query" placeholder="AI for materials discovery" /></label><label>Concept terms<input name="concepts" placeholder="materials science, machine learning, autonomous laboratories" /></label><label>Direct Work IDs — alternative to search<textarea name="workIds" rows="3" placeholder="W2741809807\nW2100837269"></textarea><span class="micro">Up to 20 zero-cost singleton lookups per run; authentication is still required.</span></label><div class="form-row"><label>Limit<input name="limit" type="number" min="1" max="100" value="30" /></label><label>Sort<select name="openAlexSort"><option value="publication_date:desc">Newest</option><option value="cited_by_count:desc">Most cited</option><option value="relevance_score:desc">Relevance</option></select></label></div><div class="form-row"><label>Published since<input name="fromPublicationDate" type="date" /></label><label class="check-row"><input name="openAccessOnly" type="checkbox" />Open access only</label></div>`;
  else if (kind === "collector") target.innerHTML = `<label>Capability<select name="operation">${(state.capabilities.fixed || []).map((capability) => `<option value="${escapeHtml(capability.id)}">${escapeHtml(capability.group)} · ${escapeHtml(capability.title)}</option>`).join("")}</select></label><label>Arguments — JSON<input name="args" placeholder='{"limit":50,"type":"for-you"}' /></label>`;
  else target.innerHTML = "";
}

function updateBlueskyFields() {
  const mode = $("#bsky-mode")?.value;
  const target = $("#bsky-mode-fields");
  if (!target) return;
  if (mode === "author") target.innerHTML = `<label>Actor<input name="actor" required placeholder="handle.bsky.social" /></label>`;
  else if (mode === "feed") target.innerHTML = `<label>Feed URI<input name="feedUri" required placeholder="at://did:plc:…/app.bsky.feed.generator/…" /></label>`;
  else target.innerHTML = `<label>Search query<input name="query" required placeholder='"materials science" OR "LNG market"' /></label>`;
}

function sourcePayload(form) {
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  const kind = data.kind;
  let config = {};
  if (kind === "web") config = { url: data.url, mode: data.mode, renderStrategy: data.renderStrategy, selector: data.selector || undefined };
  else if (kind === "web_feed") config = { url: data.url, renderStrategy: data.renderStrategy, articleRenderStrategy: data.articleRenderStrategy, maxArticles: Number(data.maxArticles || 8), maxLinks: Math.max(20, Number(data.maxArticles || 8) * 3), sameOrigin: formData.has("sameOrigin"), fetchArticles: true, includePattern: data.includePattern || undefined, excludePattern: data.excludePattern || undefined };
  else if (kind === "github_releases") config = { repos: lines(data.repos), perRepo: Number(data.perRepo || 3), includePrereleases: formData.has("includePrereleases") };
  else if (kind === "github_activity") config = { repos: lines(data.repos), perRepo: Number(data.perRepo || 30), includeTypes: lines(data.includeTypes), watchTerms: lines(data.watchTerms) };
  else if (kind === "npm_releases") config = { packages: lines(data.packages), perPackage: Number(data.perPackage || 5), includePrereleases: formData.has("includePrereleases") };
  else if (kind === "pypi_releases") config = { packages: lines(data.packages), perPackage: Number(data.perPackage || 5) };
  else if (kind === "hackernews") config = { feed: data.feed, minScore: Number(data.minScore || 0), limit: 60, watchTerms: lines(data.watchTerms) };
  else if (kind === "lobsters") config = { feed: data.feed, minScore: Number(data.minScore || 0), limit: 60, tags: lines(data.tags), watchTerms: lines(data.watchTerms) };
  else if (kind === "bluesky") config = { mode: data.bskyMode, query: data.query || undefined, actor: data.actor || undefined, feedUri: data.feedUri || undefined, limit: 60, sort: "latest" };
  else if (kind === "arxiv") config = { query: data.query || undefined, categories: lines(data.categories), limit: Number(data.limit || 40), sortBy: data.sortBy };
  else if (kind === "openalex") config = { query: data.query || undefined, concepts: lines(data.concepts), workIds: lines(data.workIds), limit: Number(data.limit || 30), sort: data.openAlexSort, fromPublicationDate: data.fromPublicationDate || undefined, openAccessOnly: formData.has("openAccessOnly") };
  else if (kind === "collector") config = { operation: data.operation, args: data.args ? JSON.parse(data.args) : { limit: 50 } };
  return { name: data.name, kind, config, scheduleMinutes: Number(data.scheduleMinutes), weight: Number(data.weight) };
}

function pairCommands() {
  if (!state.pair) return {};
  const base = location.origin;
  const code = state.pair.code;
  const pair = `driftglass-companion pair --url ${base} --code ${code} --start`;
  return {
    macos: `curl -fsSL ${base}/relay/install.sh | sh -s -- ${base}\n${pair}`,
    linux: `curl -fsSL ${base}/relay/install.sh | sh -s -- ${base}\n${pair}`,
    windows: `& ([scriptblock]::Create((irm ${base}/relay/install.ps1))) ${base}\n${pair}`,
  };
}

function renderPairOutput() {
  if (!state.pair) return;
  const commands = pairCommands();
  $("#pair-output").hidden = false;
  $("#pair-output").innerHTML = `<div class="os-tabs">${["macos", "windows", "linux"].map((os) => `<button class="${state.pairOs === os ? "active" : ""}" data-pair-os="${os}">${os === "macos" ? "macOS" : os[0].toUpperCase() + os.slice(1)}</button>`).join("")}</div><p>Pairing code <strong>${escapeHtml(state.pair.code)}</strong> · expires ${formatDate(state.pair.expiresAt)}</p><p class="micro">This pairs the Companion and starts Mission workspace mirroring. Add browser sources below whenever you want.</p><pre>${escapeHtml(commands[state.pairOs])}</pre><button class="secondary copy-pair">Copy pairing command</button><div class="pair-next"><p class="eyebrow">Add Reddit and X</p><p class="micro">Optional. Connect Browser Bridge to a dedicated profile, name it <code>driftglass</code>, then check each source you want.</p><pre>opencli doctor
opencli profile list
opencli profile rename &lt;contextId&gt; driftglass
opencli profile use driftglass
driftglass-companion probe --operation reddit.frontpage --profile driftglass --limit 3
driftglass-companion probe --operation reddit.home --profile driftglass --limit 3
driftglass-companion probe --operation x.timeline --profile driftglass --type following --limit 3
driftglass-companion probe --operation x.timeline --profile driftglass --type for-you --limit 3</pre></div>`;
}

async function compileLivingDossier(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const params = new URLSearchParams({ scopeKind: String(data.scopeKind || "global") });
  const scopeId = resolveScopeReference(String(data.scopeKind || "global"), String(data.scopeId || ""));
  if (scopeId) params.set("scopeId", scopeId);
  if (String(data.query || "").trim()) params.set("q", String(data.query).trim());
  const [jsonResult, markdownResult] = await Promise.all([
    api(`/api/dossiers?${params.toString()}`),
    apiText(`/api/dossiers?${params.toString()}&format=markdown`),
  ]);
  state.currentDossier = { dossier: jsonResult.dossier, markdown: markdownResult };
  $("#dossier-output").value = markdownResult;
  const quality = jsonResult.dossier?.quality || {};
  const badge = $("#dossier-quality");
  badge.textContent = quality.grade || "ready";
  badge.className = `badge ${quality.grade === "strong" ? "good" : quality.grade === "insufficient" ? "warn" : ""}`.trim();
  toast("Question brief ready");
}

async function loadAll() {
  const [overview, packs, missions, missionRuns, integrations, interests, capabilities, receipts, shares, taste, actionCenter, readiness, ingestDeadLetters, autopilot, researchResults, intelligence, reasoningProviders, reasoningConnections, judgment, runtime, memoryCheckpoints] = await Promise.all([
    api("/api/overview"),
    api("/api/packs"),
    api("/api/missions"),
    api("/api/mission-runs?limit=40"),
    api("/api/integrations"),
    api("/api/settings/interests"),
    api("/api/capabilities"),
    api("/api/email/receipts"),
    api("/api/shares"),
    api("/api/taste"),
    api("/api/action-center"),
    api("/api/readiness"),
    api("/api/ingest/dead-letters?limit=100"),
    api("/api/autopilot"),
    api("/api/research-results"),
    api("/api/intelligence/overview"),
    api("/api/reasoning/providers"),
    api("/api/reasoning/connections").catch(() => ({ available: false, connections: [] })),
    api("/api/judgment"),
    api("/api/runtime"),
    api("/api/memory/checkpoints?scopeKind=global&limit=8"),
  ]);
  state.overview = overview;
  state.packs = packs.packs || [];
  state.missions = missions.missions || [];
  state.missionRuns = missionRuns.runs || [];
  state.integrations = integrations;
  state.interests = interests.terms || [];
  state.capabilities = capabilities;
  state.receipts = receipts.receipts || [];
  state.shares = shares.shares || [];
  state.taste = taste.profile || state.taste;
  state.actionCenter = actionCenter;
  state.readiness = readiness;
  state.ingestDeadLetters = ingestDeadLetters.deadLetters || [];
  state.autopilot = autopilot.missions || [];
  state.pendingResearchResults = researchResults.imports || [];
  state.intelligence = { ...state.intelligence, ...intelligence, recall: null };
  state.reasoningProviders = reasoningProviders;
  state.reasoningConnections = reasoningConnections;
  state.judgment = judgment;
  state.runtime = runtime;
  state.memoryCheckpoints = memoryCheckpoints.checkpoints || [];
  state.memoryCheckpointDiff = null;
  renderStats();
  renderRenderStrip();
  renderStories();
  renderMissionRibbon();
  renderActionCenter();
  renderMissions();
  renderMemory();
  renderIntelligencePacks();
  renderPacks();
  renderSources();
  renderSourceScorecards();
  renderRuntimeFabric();
  renderCollectors();
  renderCatalog($("#catalog-search").value || "");
  renderIntegrations();
  renderReasoningProviders();
  renderJudgment();
  renderBudget();
  renderRenderHealth();
  renderReceipts();
  renderShares();
  renderTaste();
  renderReadiness();
  renderIngestRecovery();
  renderSourceConfigFields($("#source-kind").value);
  $("#interest-terms").value = state.interests.join("\n");
  $("#health-dot").classList.add("good");
  const isSelfhost = state.runtime?.context?.profile === "selfhost";
  const runtimeLabel = isSelfhost ? "Your machine" : "Cloudflare";
  $("#health-label").textContent = isSelfhost
    ? `${runtimeLabel} · collection ready`
    : state.intelligence?.graph?.dirty ? `${runtimeLabel} · memory refresh due` : `${runtimeLabel} · ready`;
}

function storyGraphMarkup(graph) {
  if (!graph?.edges?.length) return "";
  const nodes = new Map((graph.nodes || []).map((node) => [node.id, node]));
  return `<section class="story-graph"><div class="section-heading"><div><p class="eyebrow">Signal graph</p><h3>Connected developments</h3></div><span>${graph.edges.length} relation${graph.edges.length === 1 ? "" : "s"}</span></div><div class="graph-list">${graph.edges.map((edge) => {
    const related = nodes.get(edge.to);
    if (!related) return "";
    return `<button class="graph-edge mission-story" data-story="${escapeHtml(related.id)}"><div><strong>${escapeHtml(related.title)}</strong><small>${escapeHtml((edge.reasons || []).join(" · ") || edge.relation)} · changed ${formatDate(related.changedAt)}</small></div></button>`;
  }).join("")}</div></section>`;
}

async function openStory(id) {
  const [data, ranking, graph] = await Promise.all([
    api(`/api/stories/${encodeURIComponent(id)}`),
    api(`/api/stories/${encodeURIComponent(id)}/explain`).catch(() => ({ explanation: null })),
    api(`/api/stories/${encodeURIComponent(id)}/graph?limit=8`).catch(() => ({ graph: null })),
  ]);
  const { story, evidence } = data;
  const sourceCount = Math.max(0, Number(story.source_count || evidence.length || 0));
  $("#story-detail").innerHTML = `<p class="eyebrow">Latest update</p><h2>${escapeHtml(story.title)}</h2><p class="dialog-summary">${escapeHtml(story.summary)}</p><div class="story-meta"><span>${compactNumber(sourceCount)} ${sourceCount === 1 ? "source" : "sources"}</span><span>changed ${formatDate(story.last_changed_at)}</span></div><div class="feedback-row">${[["more", "More like this"], ["less", "Less"], ["track", "Track"], ["mute", "Mute"], ["already-knew", "Already knew"], ["bad-source", "Bad source"], ["wrong", "Wrong interpretation"]].map(([action, label]) => `<button class="feedback-button" data-feedback="${action}" data-story="${escapeHtml(story.id)}">${label}</button>`).join("")}${state.integrations?.deepDiveLab?.configured ? `<button class="feedback-button story-deep-dive" data-story="${escapeHtml(story.id)}">Open Power Mode</button>` : ""}<button class="feedback-button story-share" data-story="${escapeHtml(story.id)}">Share</button><button class="feedback-button story-bundle" data-story="${escapeHtml(story.id)}">Download copy</button></div>${rankingMarkup(ranking.explanation)}${storyGraphMarkup(graph.graph)}<h3>Sources</h3>${evidence.map((item) => { const href = safeHref(item.url); return `<article class="evidence"><div class="evidence-head"><span>${escapeHtml(item.source_name)}</span><time>${formatDate(item.published_at || item.observed_at)}</time></div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml((item.text || "").slice(0, 1800))}</p>${href ? `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">Open original</a>` : ""}</article>`; }).join("")}`;
  if (!$("#story-dialog").open) $("#story-dialog").showModal();
}

async function exportStoryBundle(id) {
  const bundle = await api(`/api/stories/${encodeURIComponent(id)}/bundle`);
  downloadJson(`driftglass-story-${slug(bundle.story?.title || id)}.json`, bundle);
}

async function exportMissionBundle(id) {
  const bundle = await api(`/api/missions/${encodeURIComponent(id)}/bundle`);
  downloadJson(`driftglass-mission-${slug(bundle.mission?.name || id)}.json`, bundle);
}

async function showDeepDive(result) {
  const dossier = await apiText(result.dossierApiUrl);
  $("#story-detail").innerHTML = `<p class="eyebrow">Deep Research workspace</p><h2>${escapeHtml(result.manifest?.title || result.caseId || "Deep Research workspace")}</h2><div class="story-meta"><span>${escapeHtml(result.caseId || "case")}</span><span>${Number(result.manifest?.evidenceCount || 0)} source items</span><span>${Number(result.manifest?.sourceCount || 0)} sources</span></div><div class="top-actions"><button class="secondary deep-dive-download" data-export-url="${escapeHtml(result.exportApiUrl)}" data-case="${escapeHtml(result.caseId)}">Download brief</button></div><pre class="dossier-preview">${escapeHtml(dossier)}</pre>`;
  if (!$("#story-dialog").open) $("#story-dialog").showModal();
}

async function openStoryDeepDive(id) {
  const result = await api(`/api/stories/${encodeURIComponent(id)}/deep-dive`, { method: "POST", body: "{}" });
  await showDeepDive(result);
  toast("Deep Research workspace opened");
}

async function openMissionDeepDive(id) {
  const result = await api(`/api/missions/${encodeURIComponent(id)}/deep-dive`, { method: "POST", body: "{}" });
  await showDeepDive(result);
  toast("Mission workspace opened");
}

async function downloadDeepDive(url, caseId) {
  const text = await apiText(url);
  const objectUrl = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${slug(caseId || "driftglass")}-dossier.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function renderMissionEvents(events = []) {
  const node = $("#mission-event-list");
  node.innerHTML = events.length ? events.map((event) => `<article class="list-card mission-event"><div><div><h4>${escapeHtml(event.title)}</h4><p>${escapeHtml(event.detail || event.event_type)}</p><small>${escapeHtml(event.event_type)} · ${formatDate(event.occurred_at)}</small></div></div></article>`).join("") : `<div class="empty-state compact">No Mission history yet.</div>`;
}

function openMissionEditor(id) {
  const mission = state.missions.find((candidate) => candidate.id === id);
  if (!mission) throw new Error("Mission not found");
  state.selectedMission = id;
  const operator = mission.operator || {};
  const form = $("#mission-edit-form");
  form.elements.id.value = mission.id;
  form.elements.name.value = mission.name || "";
  form.elements.status.value = mission.status || "active";
  form.elements.question.value = mission.question || "";
  form.elements.terms.value = (mission.terms || []).join("\n");
  form.elements.mode.value = operator.mode || "watch";
  form.elements.researchPolicy.value = operator.research_policy || "suggest";
  form.elements.expectedNextEvent.value = operator.expected_next_event || "";
  form.elements.expectedBy.value = dateInputValue(operator.expected_by);
  form.elements.expectedEventStatus.value = operator.expected_event_status || (operator.expected_next_event ? "pending" : "none");
  form.elements.sprintPolicy.value = operator.sprint_policy || "manual";
  const chooseExact = (element, value, label) => {
    const exact = String(value);
    if (![...element.options].some((option) => option.value === exact)) element.add(new Option(label, exact));
    element.value = exact;
  };
  const cadence = Number(mission.cadence_minutes || 360);
  const reminder = Number(operator.reminder_lead_days ?? 3);
  const threshold = Number(operator.alert_threshold ?? .65);
  const priority = Number(mission.priority || 1.5);
  chooseExact(form.elements.cadenceMinutes, cadence, `Every ${durationLabel(cadence)}`);
  chooseExact(form.elements.reminderLeadDays, reminder, reminder ? `${reminder} days before` : "On the expected date");
  chooseExact(form.elements.alertThreshold, threshold, "Current sensitivity");
  form.elements.outcomeStatus.value = operator.outcome_status || "open";
  form.elements.outcomeSummary.value = operator.outcome_summary || "";
  chooseExact(form.elements.priority, priority, "Current importance");
  $("#mission-event-form").elements.missionId.value = mission.id;
  $("#mission-dialog-title").textContent = mission.name;
  renderMissionEvents(mission.events || []);
  if (!$("#mission-dialog").open) $("#mission-dialog").showModal();
}

function workspaceDocumentInfo(file) {
  if (file?.directory) return null;
  const path = `/${String(file?.path || "").replace(/^\/+/, "")}`;
  const exact = {
    "/mission.md": ["Brief", "Answer, mechanism, and next test"],
    "/memory/context.md": ["Background", "Findings and context tied to this Mission"],
    "/memory/timeline.md": ["How this changed", "How the sources and standing answer changed"],
    "/handoffs/deep-research.md": ["Research plan", "Questions and sources for the next review"],
    "/README.md": ["About this workspace", "How these files stay organized"],
  }[path];
  if (exact) return { path, title: exact[0], detail: exact[1], rank: Object.keys({
    "/mission.md": 0,
    "/memory/context.md": 1,
    "/memory/timeline.md": 2,
    "/handoffs/deep-research.md": 3,
    "/README.md": 9,
  }).indexOf(path) };
  const personal = path.match(/^\/(notes|results|exports)\/(.+\.md)$/i);
  if (!personal || /\/README\.md$/i.test(path)) return null;
  const section = personal[1].toLowerCase();
  return {
    path,
    title: personal[2].replace(/\.md$/i, "").replace(/[-_]+/g, " "),
    detail: section === "notes" ? "Working note" : section === "results" ? "Reviewed result" : "Saved export",
    rank: section === "notes" ? 4 : section === "results" ? 5 : 6,
  };
}

function computerTree(files) {
  const documents = (files || []).map(workspaceDocumentInfo).filter(Boolean).sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
  const documentPaths = new Set(documents.map((document) => document.path));
  const underlying = (files || []).filter((file) => !documentPaths.has(`/${String(file?.path || "").replace(/^\/+/, "")}`));
  const documentMarkup = documents.map((document) => `<button class="computer-document" data-computer-file="${escapeHtml(document.path)}"><strong>${escapeHtml(document.title)}</strong><span>${escapeHtml(document.detail)}</span></button>`).join("");
  const underlyingMarkup = underlying.map((file) => {
    const depth = Math.max(0, Math.min(8, Math.floor(Number(file.depth || 0))));
    return `<button class="computer-file depth-${depth} ${file.directory ? "directory" : ""}" ${file.directory ? "disabled" : ""} data-computer-file="${escapeHtml(file.path)}"><span>${file.directory ? "Folder" : "File"}</span><strong>${escapeHtml(file.name)}</strong></button>`;
  }).join("");
  return `<div class="computer-documents"><p class="eyebrow">Saved work</p>${documentMarkup || `<div class="empty-state compact">Refresh this workspace to prepare its brief.</div>`}</div><details class="computer-data-files"><summary>Technical files</summary><div>${underlyingMarkup}</div></details>`;
}

function workspaceDocumentMarkup(content) {
  const lines = String(content || "").split(/\r?\n/);
  const markup = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    markup.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const clean = (value) => String(value || "").replace(/\*\*|__/g, "").replace(/`([^`]*)`/g, "$1").trim();
  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { list.push(clean(bullet[1])); continue; }
    flushList();
    if (heading) markup.push(`<h${Math.min(5, heading[1].length + 2)}>${escapeHtml(clean(heading[2]))}</h${Math.min(5, heading[1].length + 2)}>`);
    else if (/^>\s*/.test(line)) markup.push(`<blockquote>${escapeHtml(clean(line.replace(/^>\s*/, "")))}</blockquote>`);
    else if (line.trim()) markup.push(`<p>${escapeHtml(clean(line))}</p>`);
  }
  flushList();
  return markup.join("") || `<div class="empty-state compact">This document is empty.</div>`;
}

function readableWorkspaceMatch(value) {
  const source = String(value || "").trim();
  const explained = /\bmem-[a-z0-9-]+\b/i.test(source) && source.includes(" — ")
    ? source.split(" — ").at(-1)
    : source;
  return readableExcerpt(String(explained || "")
    .replace(/\bmem-[a-z0-9-]+\b/gi, "")
    .replace(/\s*·\s*(?:entity|story|claim|source|mission)\s*·\s*confidence\s+[0-9.]+/gi, "")
    .replace(/\bconfidence\s+[0-9.]+/gi, "")
    .replace(/^\s*(?:tracks|asks|supports|contains)\s*[-–—:]?\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim(), 360);
}

async function openMissionComputer(id, forceSync = false) {
  const before = state.currentComputer?.missionId === id ? state.currentComputer.syncedAt : null;
  let result = forceSync
    ? await api(`/api/missions/${encodeURIComponent(id)}/computer/sync`, { method: "POST", body: "{}" })
    : await api(`/api/missions/${encodeURIComponent(id)}/computer`);
  if (!forceSync && (!result.computer?.syncedAt || Number(result.computer?.fileCount || 0) === 0)) {
    result = await api(`/api/missions/${encodeURIComponent(id)}/computer/sync`, { method: "POST", body: "{}" });
  }
  if (result.sync?.status === "queued") {
    const queuedFrom = result.computer?.syncedAt ?? before;
    toast("Refreshing this Mission workspace…");
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshed = await api(`/api/missions/${encodeURIComponent(id)}/computer`);
      const syncedAt = refreshed.computer?.syncedAt;
      if (syncedAt && (syncedAt !== queuedFrom || Number(refreshed.computer?.fileCount || 0) > Number(result.computer?.fileCount || 0))) {
        result = refreshed;
        break;
      }
    }
  }
  const computer = result.computer;
  state.currentComputer = { missionId: id, ...computer };
  const mission = state.missions.find((candidate) => candidate.id === id);
  $("#story-detail").innerHTML = `<p class="eyebrow">Mission workspace</p><h2>${escapeHtml(mission?.name || id)}</h2><p class="dialog-summary">${escapeHtml(mission?.question || "")}</p><div class="computer-stats"><span>Updated ${formatDate(computer.syncedAt)}</span></div><div class="computer-layout"><aside><div class="computer-toolbar"><button class="secondary computer-sync" data-mission="${escapeHtml(id)}">Refresh workspace</button><button class="secondary computer-export" data-mission="${escapeHtml(id)}">Download copy</button></div><div class="computer-tree">${computerTree(computer.files)}</div></aside><section class="computer-workbench"><div class="computer-preview-head"><strong id="computer-preview-path">Brief</strong></div><div id="computer-preview" class="computer-preview">Opening brief…</div><form id="computer-search-form" class="inline-search"><input name="query" placeholder="Search this workspace" aria-label="Search this workspace" required maxlength="300" /><button class="secondary" type="submit">Search</button></form><div id="computer-search-result" class="computer-search-result" hidden></div><form id="computer-note-form" class="stack-form"><p class="eyebrow">Working note</p><label>File<input name="file" value="${new Date().toISOString().slice(0,10)}.md" /></label><label>Note<textarea name="content" rows="5" placeholder="Save a decision, hypothesis, question, or instruction for this Mission." required></textarea></label><button class="primary" type="submit">Save note</button></form></section></div>`;
  if (!$("#story-dialog").open) $("#story-dialog").showModal();
  const openFile = async (path) => {
    const file = await api(`/api/missions/${encodeURIComponent(id)}/computer/file?path=${encodeURIComponent(path)}`);
    const info = workspaceDocumentInfo({ path: file.path, directory: false });
    $("#computer-preview-path").textContent = info?.title || String(file.path || "Saved file").replace(/^\//, "");
    $("#computer-preview").innerHTML = /\.md$/i.test(String(file.path || ""))
      ? workspaceDocumentMarkup(file.content)
      : `<pre class="computer-machine-preview">${escapeHtml(file.content)}</pre>`;
  };
  $("#story-detail").querySelectorAll("[data-computer-file]").forEach((button) => button.addEventListener("click", () => openFile(button.dataset.computerFile).catch((error) => toast(error.message, "error"))));
  $("#computer-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("query");
    const search = await api(`/api/missions/${encodeURIComponent(id)}/computer/search?q=${encodeURIComponent(query)}`);
    const node = $("#computer-search-result");
    const matches = Array.isArray(search.matches) ? search.matches : [];
    const readableMatches = matches.filter((match) => /(?:^|\/)(?:notes|results|exports)\/|\.md$/i.test(String(match.path || "")));
    const displayedMatches = (readableMatches.length ? readableMatches : matches).slice(0, 12);
    node.hidden = false;
    node.innerHTML = displayedMatches.length
      ? displayedMatches.map((match) => {
        const path = String(match.path || "Saved file").replace(/^\//, "");
        const info = workspaceDocumentInfo({ path, directory: false });
        return `<button class="computer-search-hit" data-computer-file="${escapeHtml(match.path)}"><span><strong>${escapeHtml(info?.title || path)}</strong><small>${escapeHtml(info?.detail || "Saved match")}</small></span><p>${escapeHtml(readableWorkspaceMatch(match.text))}</p></button>`;
      }).join("")
      : `<div class="empty-state compact"><strong>No matching saved work.</strong><span>Try a shorter phrase, source name, or exact term from the Mission.</span></div>`;
    node.querySelectorAll("[data-computer-file]").forEach((button) => button.addEventListener("click", () => openFile(button.dataset.computerFile).catch((error) => toast(error.message, "error"))));
  });
  $("#computer-note-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    const saved = await api(`/api/missions/${encodeURIComponent(id)}/computer/notes`, { method: "POST", body: JSON.stringify(data) });
    toast(`Saved ${saved.note.path}`); await openMissionComputer(id, false);
  });
  openFile("/mission.md").catch((error) => { $("#computer-preview").textContent = error.message; });
}

async function openDeepResearch(id) {
  const result = await api(`/api/missions/${encodeURIComponent(id)}/deep-research`, { method: "POST", body: "{}" });
  state.deepResearch = { ...result, missionId: id };
  const handoff = result.handoff;
  const recommendation = handoff.recommendation || {};
  const sourceDomains = handoff.preferredDomains || [];
  const baseline = handoff.researchBaseline;
  $("#research-detail").innerHTML = `<p class="eyebrow">ChatGPT Deep Research handoff</p><h2>${escapeHtml(handoff.mission.name)}</h2><p class="dialog-summary">${escapeHtml(handoff.mission.question)}</p><div class="research-recommendation ${recommendation.shouldEscalate ? "ready" : "monitor"}"><strong>${recommendation.shouldEscalate ? "Ready for deeper investigation" : "Continue monitoring"}</strong><p>${escapeHtml(recommendation.whyNow || "")}</p>${(recommendation.reasons || []).length ? `<ul>${recommendation.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}</div>${baseline?.currentThesis ? `<section class="research-baseline"><span>Current standing answer</span><p>${escapeHtml(baseline.currentThesis)}</p>${baseline.lastResearchAt ? `<small>Last researched ${formatDate(baseline.lastResearchAt)}</small>` : ""}</section>` : ""}<div class="research-grid"><section><p class="eyebrow">Current state</p>${(handoff.currentState || []).slice(0, 8).map((story) => `<article class="research-story"><strong>${escapeHtml(story.title)}</strong><span>${story.sourceCount} distinct sources · changed ${formatDate(story.changedAt)}</span><p>${escapeHtml(story.summary || "")}</p></article>`).join("") || `<div class="empty-state compact">No matched Story yet.</div>`}</section><section><p class="eyebrow">Source coverage</p><div class="feature-list">${sourceDomains.slice(0, 16).map((domain) => `<span>${escapeHtml(domain)}</span>`).join("")}</div>${(handoff.coverageGaps || []).length ? `<ul class="coverage-gaps">${handoff.coverageGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>` : `<p class="success">No obvious source gap found.</p>`}<p class="eyebrow section-space">Research plan</p><ol class="research-plan">${(handoff.researchPlan || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section></div><label>Ready-to-use prompt<textarea id="deep-research-prompt" rows="16" readonly>${escapeHtml(handoff.prompt)}</textarea></label><div class="top-actions"><button class="primary copy-deep-research">Copy prompt</button><button class="secondary download-deep-research">Download handoff</button><a class="secondary" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT</a></div><section class="research-return"><p class="eyebrow">Close the loop</p><h3>Bring the result back into Mission memory</h3><p>Paste the fenced <code>DRIFTGLASS_RESULT</code> JSON from the report. Driftglass shows the changes for approval before updating the Mission.</p><form id="research-result-form" class="stack-form"><textarea name="resultJson" rows="12" placeholder='{"currentThesis":"…","reportSummary":"…","openQuestions":[],"confidence":0.8,"nextExpectedEvent":"…"}' required></textarea><button class="primary" type="submit">Review proposed update</button></form></section>`;
  $("#research-result-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const raw = String(new FormData(event.currentTarget).get("resultJson") || "").trim();
      const fenced = raw.match(/```(?:json|DRIFTGLASS_RESULT)?\s*([\s\S]*?)```/i)?.[1] || raw;
      const parsed = parseJsonSafe(fenced.trim());
      if (!parsed) throw new Error("The research result is not valid JSON");
      const staged = await api(`/api/missions/${encodeURIComponent(id)}/research-results/preview`, { method: "POST", body: JSON.stringify({ result: parsed, source: "dashboard-deep-research" }) });
      await loadAll();
      $("#research-dialog").close();
      await reviewResearchResult(staged.import.id);
      toast("Research result staged for approval");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  $("#research-dialog").showModal();
  loadAll().catch(() => undefined);
}

function diffValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(" · ") : "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

async function reviewResearchResult(importId) {
  let item = state.pendingResearchResults.find((candidate) => candidate.id === importId);
  if (!item) {
    const result = await api("/api/research-results");
    state.pendingResearchResults = result.imports || [];
    item = state.pendingResearchResults.find((candidate) => candidate.id === importId);
  }
  if (!item) throw new Error("Research result is no longer pending");
  const diff = item.diff || parseJsonSafe(item.diff_json, {}) || {};
  $("#research-detail").innerHTML = `<p class="eyebrow">Approval inbox</p><h2>Review Deep Research result</h2><p class="dialog-summary">${escapeHtml(item.missionName || item.mission_id)} · staged ${formatDate(item.created_at)} · expires ${formatDate(item.expires_at)}</p><div class="research-diff">${Object.entries(diff).map(([key, change]) => `<article><h3>${escapeHtml(key.replace(/([A-Z])/g, " $1"))}</h3><div class="diff-grid"><div><span>Before</span><pre>${escapeHtml(diffValue(change?.before))}</pre></div><div><span>After</span><pre>${escapeHtml(diffValue(change?.after))}</pre></div></div></article>`).join("")}</div><div class="top-actions"><button class="primary confirm-research-result" data-import="${escapeHtml(item.id)}">Confirm and update Mission</button><button class="secondary reject-research-result" data-import="${escapeHtml(item.id)}">Reject</button></div><p class="micro">Confirmation updates the durable thesis, report summary, open questions, expected event, outcome state, and Mission history.</p>`;
  if (!$("#research-dialog").open) $("#research-dialog").showModal();
}

function showShareDialog(share) {
  const liveUrl = safeHref(share?.url);
  const capsuleUrl = safeHref(share?.dropUrl);
  if (!liveUrl || !capsuleUrl) throw new Error("Share response contained an invalid URL");
  state.latestShare = { ...share, url: liveUrl, dropUrl: capsuleUrl };
  $("#share-detail").innerHTML = `<p class="eyebrow">Share</p><h2>${escapeHtml(share.payload?.title || "Driftglass intelligence")}</h2><p class="dialog-summary">Copy a link, or download a portable version with its public sources.</p><div class="share-options"><article><h3>Live view</h3><p>Opens the ${share.payload?.reviewedAnswer ? "answer" : "briefing"} and its public sources in a browser.</p><label>URL<input id="share-live-url" value="${escapeHtml(liveUrl)}" readonly /></label><div class="top-actions"><button class="primary copy-share-live">Copy link</button><a class="secondary" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener noreferrer">Open</a></div></article><article><h3>Downloadable copy</h3><p>A ZIP with the page, source notes, and a model-readable copy.</p><label>Download URL<input id="share-drop-url" value="${escapeHtml(capsuleUrl)}" readonly /></label><div class="top-actions"><a class="primary" href="${escapeHtml(capsuleUrl)}">Download a copy</a><a class="secondary" href="https://www.cloudflare.com/drop/" target="_blank" rel="noopener noreferrer">Optional hosting</a></div></article></div><p class="micro">Includes public sources${share.payload?.reviewedAnswer ? " and the answer you selected" : ""}.</p>`;
  $("#share-dialog").showModal();
}

function reviewedRunsForShare(kind, id) {
  const receiptById = new Map((state.judgment.receipts || []).map((receipt) => [receipt.id, receipt]));
  return (state.judgment.reasoningRuns || []).flatMap((run) => {
    const receipt = receiptById.get(run.receipt_id);
    const scopeMatches = kind === "briefing"
      ? receipt?.scope_kind === "global" && !receipt.scope_id
      : receipt?.scope_kind === kind && receipt.scope_id === id;
    const analysis = reasoningRunAnalysis(run);
    const hasPublicFields = Boolean(
      analysis.answer || analysis.summary || analysis.outlook || analysis.alternativeCase ||
      analysis.options.length || analysis.keyJudgments.length || analysis.gaps.length ||
      analysis.whatWouldChange.length || analysis.signposts.length || analysis.nextSteps.length
    );
    const receiptScope = parseJsonSafe(receipt?.quality_json, {})?.sourceScope;
    return run.status === "reviewed" && receiptScope === "share" && scopeMatches && hasPublicFields ? [{ run, receipt }] : [];
  }).sort((left, right) => String(right.run.reviewed_at || "").localeCompare(String(left.run.reviewed_at || "")));
}

async function openShareComposer(kind, id) {
  const reviewed = reviewedRunsForShare(kind, id);
  if (!reviewed.length) return publishShare(kind, id);
  state.pendingShare = { kind, id };
  const options = reviewed.map(({ run, receipt }) => `<option value="${escapeHtml(run.id)}">${escapeHtml(receipt.title || "Reviewed answer")} · ${formatDate(run.reviewed_at)}</option>`).join("");
  $("#share-detail").innerHTML = `<p class="eyebrow">Share</p><h2>Choose what to include</h2><p class="dialog-summary">Includes public sources.</p><form id="share-create-form" class="stack-form"><label>Answer<select name="reviewedRunId"><option value="">Share without an answer</option>${options}</select></label><p class="micro">Reviewed answers for this ${kind === "briefing" ? "briefing" : kind === "mission" ? "Mission" : "Story"} appear here.</p><button class="primary create-public-share" type="submit">Create share</button></form>`;
  if (!$("#share-dialog").open) $("#share-dialog").showModal();
}

async function publishShare(kind, id, reviewedRunId) {
  const result = await api("/api/shares", { method: "POST", body: JSON.stringify({ kind, id, expiresDays: 14, reviewedRunId: reviewedRunId || undefined }) });
  state.pendingShare = null;
  showShareDialog(result.share);
  await loadAll();
}

async function runSource(id) {
  await api(`/api/sources/${encodeURIComponent(id)}/run`, { method: "POST", body: "{}" });
  toast("Source run complete");
  await loadAll();
}

async function deleteSource(id) {
  await api(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadAll(); toast("Source removed");
}

async function applyPack(id) {
  const pack = state.packs.find((candidate) => candidate.id === id);
  if (!pack) throw new Error("Lens not found");
  if (pack.lensType === "community") {
    await api("/api/lenses/import", { method: "POST", body: JSON.stringify(pack) });
    await api("/api/sources/run-due", { method: "POST", body: "{}" });
  } else {
    await api(`/api/packs/${encodeURIComponent(id)}/apply`, { method: "POST", body: JSON.stringify({ runNow: true }) });
  }
  toast("Lens installed · first collection started");
  await loadAll();
  setTimeout(() => loadAll().catch(() => undefined), 6500);
}

async function processPendingInstalls() {
  if (!state.secret) return;
  if (state.pendingPackUrl) {
    const url = state.pendingPackUrl;
    state.pendingPackUrl = "";
    try {
      await previewIntelligencePackInput(null, url);
      const current = new URL(location.href);
      current.searchParams.delete("pack");
      history.replaceState({}, "", `${current.pathname}${current.search}${current.hash || "#sources"}`);
      setView("sources");
    } catch (error) {
      toast(`Pack preview failed: ${error.message}`, "error");
    }
    return;
  }
  if (!state.pendingLensUrl) return;
  const url = state.pendingLensUrl;
  state.pendingLensUrl = "";
  const current = new URL(location.href);
  current.searchParams.delete("lens");
  history.replaceState({}, "", `${current.pathname}${current.search}${current.hash || "#sources"}`);
  setView("sources");
  const input = $("#lens-url-form [name=url]");
  if (input) input.value = url;
  toast("Review this Lens before installing it");
}

function sharedCaptureInput(href) {
  const current = new URL(href);
  const sharedText = current.searchParams.get("text") || "";
  const sharedUrl = current.searchParams.get("url") || sharedText.match(/https?:\/\/\S+/)?.[0] || current.searchParams.get("capture");
  const sharedTitle = current.searchParams.get("title") || sharedText.replace(sharedUrl || "", "").trim();
  return { sharedUrl, sharedTitle };
}

function initializeCaptureTools() {
  const target = `${location.origin}/?capture=`;
  $("#bookmarklet").href = `javascript:(()=>{location.href='${target}'+encodeURIComponent(location.href)+'#capture'})()`;
  const { sharedUrl, sharedTitle } = sharedCaptureInput(location.href);
  if (sharedUrl) {
    $("#capture-form [name=url]").value = sharedUrl;
    if (sharedTitle) $("#capture-form [name=title]").value = sharedTitle.slice(0, 300);
    setView("capture");
    history.replaceState({}, "", `${location.origin}/#capture`);
  }
}

function wireEvents() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); state.secret = String(new FormData(event.currentTarget).get("secret") || "");
    try { await api("/api/session"); $("#login").hidden = true; $("#app").hidden = false; await loadAll(); await processPendingInstalls(); }
    catch (error) { $("#login-error").textContent = error.message; }
  });
  $("#logout").addEventListener("click", async () => {
    try { await api("/api/session/lock", { method: "POST", body: "{}" }); }
    catch { /* Lock the local interface even if the service is unreachable. */ }
    state.secret = "";
    location.reload();
  });
  $$(".nav").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#collect-now").addEventListener("click", async () => { const result = await api("/api/sources/run-due", { method: "POST", body: "{}" }); toast(result.scheduled ? `Scheduled ${result.scheduled} sources` : "Everything is current"); setTimeout(() => loadAll().catch(() => undefined), 4500); });
  $("#generate").addEventListener("click", async () => { await api("/api/briefings/generate", { method: "POST", body: JSON.stringify({ hours: 24 }) }); await loadAll(); toast("Today refreshed"); });
  $("#share-briefing").addEventListener("click", async () => { try { await openShareComposer("briefing"); } catch (error) { toast(error.message, "error"); } });
  $("#story-search").addEventListener("input", (event) => { clearTimeout(state.searchTimer); const query = event.target.value.trim(); state.searchTimer = setTimeout(async () => { if (!query) return renderStories(); const result = await api(`/api/stories?q=${encodeURIComponent(query)}&limit=40`); renderStories(result.stories || []); }, 220); });
  $("#mission-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    data.terms = lines(data.terms);
    data.priority = Number(data.priority);
    data.cadenceMinutes = Number(data.cadenceMinutes || 360);
    data.reminderLeadDays = Number(data.reminderLeadDays || 3);
    data.alertThreshold = Number(data.alertThreshold);
    if (!data.expectedBy) data.expectedBy = null;
    await api("/api/missions", { method: "POST", body: JSON.stringify(data) });
    form.reset();
    form.elements.alertThreshold.value = "0.65";
    form.elements.priority.value = "1.5";
    form.elements.cadenceMinutes.value = "360";
    form.elements.reminderLeadDays.value = "3";
    await loadAll();
    toast("Mission created. Checking sources.");
  });
  $("#discover-form").addEventListener("submit", async (event) => { event.preventDefault(); const input = String(new FormData(event.currentTarget).get("input") || ""); const result = await api("/api/sources/discover", { method: "POST", body: JSON.stringify({ input }) }); state.suggestions = result.suggestions || []; $("#discover-results").innerHTML = state.suggestions.map((suggestion) => { const fit = Number(suggestion.confidence || 0) >= .8 ? "Strong fit" : Number(suggestion.confidence || 0) >= .6 ? "Likely fit" : "Possible fit"; return `<article class="suggestion"><div><span>${fit}</span><h4>${escapeHtml(suggestion.source.name)}</h4><p>${escapeHtml(suggestion.reason)}</p><small>${escapeHtml(sourceKindLabel(suggestion.source.kind))} · check about every ${durationLabel(suggestion.source.scheduleMinutes)}</small></div><button class="primary install-suggestion" data-suggestion="${escapeHtml(suggestion.id)}">Add</button></article>`; }).join("") || `<div class="empty-state">No source suggestion found.</div>`; });
  $("#lens-url-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const url = String(new FormData(form).get("url") || ""); const result = await api("/api/lenses/install-url", { method: "POST", body: JSON.stringify({ url }) }); form.reset(); await loadAll(); toast(`Installed ${result.lens.name}`); });
  $("#lens-file-import").addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; const lens = JSON.parse(await file.text()); const result = await api("/api/lenses/import", { method: "POST", body: JSON.stringify(lens) }); event.target.value = ""; await loadAll(); toast(`Installed ${result.lens.name}`); });
  $("#intelligence-pack-url-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = String(new FormData(event.currentTarget).get("url") || "").trim();
    await previewIntelligencePackInput(null, url);
  });
  $("#intelligence-pack-file-import")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await previewIntelligencePackInput(JSON.parse(await file.text())); }
    finally { event.target.value = ""; }
  });
  $("#memory-search-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const query = String(data.query || "").trim();
    const ref = String(data.ref || "").trim();
    const params = new URLSearchParams({ limit: "60" });
    if (query) params.set("q", query);
    if (ref) params.set("ref", ref);
    const result = await api(`/api/memory/search?${params}`);
    state.intelligence = {
      ...state.intelligence,
      nodes: result.graph?.nodes || [],
      edges: result.graph?.edges || [],
      timeline: result.timeline || [],
      recall: query || ref ? { query, ref } : null,
    };
    renderMemory();
  });
  $("#memory-refresh")?.addEventListener("click", async () => {
    const result = await api("/api/memory/refresh", { method: "POST", body: JSON.stringify({}) });
    await loadAll();
    const status = result.result?.status || "queued";
    const messages = {
      queued: "Memory refresh started",
      running: "Memory is already refreshing",
      deferred: `Memory refresh deferred${result.result?.reason ? ` · ${result.result.reason}` : ""}`,
      complete: "Memory refreshed",
      partial: "Memory refreshed within the current plan",
    };
    toast(messages[status] || `Memory · ${status}`, status === "deferred" ? "error" : undefined);
  });
  $("#memory-checkpoint-create")?.addEventListener("click", async () => {
    const result = await api("/api/memory/checkpoints", { method: "POST", body: JSON.stringify({ scopeKind: "global", title: "Personal intelligence state", reason: "Manual dashboard checkpoint" }) });
    await refreshMemoryCheckpoints(true);
    toast(result.created ? "Current memory state saved" : "Memory is unchanged since the last saved state");
  });
  $("#memory-checkpoint-compare")?.addEventListener("click", async () => {
    await refreshMemoryCheckpoints(true);
    toast(state.memoryCheckpointDiff?.diff ? "Latest memory states compared" : "Save a second state to compare changes");
  });
  $("#refresh-judgment")?.addEventListener("click", async () => {
    const result = await api("/api/reasoning/tasks/refresh", { method: "POST", body: "{}" });
    await loadAll();
    toast(`Reasoning inbox refreshed`);
  });
  $("#dossier-form")?.addEventListener("submit", compileLivingDossier);
  $("#copy-dossier")?.addEventListener("click", async () => { await navigator.clipboard.writeText(state.currentDossier?.markdown || $("#dossier-output").value || ""); toast("Question brief copied"); });
  $("#download-dossier")?.addEventListener("click", () => { if (!state.currentDossier?.markdown) throw new Error("Prepare a question brief first"); downloadText(`driftglass-dossier-${slug(state.currentDossier.dossier?.focus?.label || state.currentDossier.dossier?.query || "global")}.md`, state.currentDossier.markdown); });
  $("#decision-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const result = await api("/api/decisions", { method: "POST", body: JSON.stringify({
      decisionType: data.decisionType,
      title: data.title,
      statement: data.statement,
      confidence: Number(data.confidence || 0.5),
      expectedOutcome: data.expectedOutcome || undefined,
      reviewAt: data.reviewAt || null,
    }) });
    form.reset();
    form.elements.confidence.value = "0.7";
    await loadAll();
    toast(`Recorded ${result.decision?.decision_type || "judgment"}`);
  });
  $("#reasoning-result-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const receiptId = String(data.receiptId || "");
    if (!receiptId) throw new Error("Open a prepared brief first");
    const rawResponse = String(data.response || "");
    const explicitStructured = String(data.structuredResult || "").trim();
    const explicitMemoryPatch = String(data.memoryPatch || "").trim();
    const inferredStructured = parseJsonSafe(rawResponse, null);
    const structured = explicitStructured ? parseJsonSafe(explicitStructured, null) : inferredStructured;
    const memoryPatch = explicitMemoryPatch ? parseJsonSafe(explicitMemoryPatch, null) : undefined;
    if (form.dataset.structuredRequired === "true" && (!structured || typeof structured !== "object" || Array.isArray(structured))) {
      throw new Error("Paste the complete structured JSON result from the prepared brief");
    }
    if (explicitStructured && (!structured || typeof structured !== "object")) throw new Error("Structured result must be valid JSON");
    if (explicitMemoryPatch && (!memoryPatch || typeof memoryPatch !== "object")) throw new Error("Memory patch must be valid JSON");
    const result = await api(`/api/reasoning/receipts/${encodeURIComponent(receiptId)}/results`, {
      method: "POST",
      body: JSON.stringify(reasoningResultPayload(data, rawResponse, structured, memoryPatch)),
    });
    state.currentReasoningComparison = result.comparison || null;
    renderReasoningComparison();
    form.elements.response.value = "";
    form.elements.summary.value = "";
    if (form.elements.structuredResult) form.elements.structuredResult.value = "";
    if (form.elements.memoryPatch) form.elements.memoryPatch.value = "";
    await loadAll();
    toast("Answer saved");
  });
  $("#close-reasoning-result")?.addEventListener("click", () => {
    $("#reasoning-result-panel").hidden = true;
    state.currentReasoningReceipt = null;
    state.currentReasoningComparison = null;
  });
  $("#reasoning-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = reasoningFormPayload();
    const result = await api("/api/reasoning/receipts", { method: "POST", body: JSON.stringify(payload) });
    state.reasoningBundle = result.bundle;
    state.currentReasoningReceipt = { receipt: result.receipt, bundle: result.bundle, markdown: result.markdown, runs: [] };
    state.currentReasoningComparison = null;
    $("#reasoning-output").value = result.markdown || "";
    renderReasoningQuality(result.bundle);
    state.judgment.receipts = [result.receipt, ...(state.judgment.receipts || []).filter((row) => row.id !== result.receipt.id)];
    renderJudgment();
    await openReasoningReceipt(result.receipt.id, { scroll: false });
    toast(`Brief prepared for ${payload.target}`);
  });
  $("#copy-reasoning-output")?.addEventListener("click", async () => { await navigator.clipboard.writeText($("#reasoning-output").value || ""); toast("Brief copied"); });
  $("#download-reasoning-skill")?.addEventListener("click", async () => { const payload = reasoningFormPayload(); downloadBlob(`driftglass-${payload.task}-${payload.target}-skill.zip`, await apiBlob("/api/reasoning/skill.zip", { method: "POST", body: JSON.stringify(payload) })); });
  $("#download-interface-kit")?.addEventListener("click", async () => {
    const payload = { ...reasoningFormPayload(), includeOperations: Boolean($("#include-operations-kit")?.checked) };
    downloadBlob(
      `driftglass-${payload.task}-${payload.target}-interface-kit.zip`,
      await apiBlob("/api/reasoning/interface-kit.zip", { method: "POST", body: JSON.stringify(payload) }),
    );
  });
  $("#memory-audit-run")?.addEventListener("click", async () => { const result = await api("/api/memory/audit"); state.memoryAudit = result.audit; renderMemoryAudit(); toast("Memory check complete"); });
  $("#check-pack-updates")?.addEventListener("click", async () => { const result = await api("/api/intelligence-packs/updates"); state.packUpdates = result.updates || []; renderIntelligencePacks(); const count = state.packUpdates.filter((row) => row.updateAvailable).length; toast(count ? `${count} Pack update${count === 1 ? "" : "s"} available` : "Installed Packs are current"); });
  $("#budget-profile")?.addEventListener("change", async (event) => {
    const profile = event.target.value === "cheap" ? "cheap" : "free";
    await api("/api/budget", { method: "PUT", body: JSON.stringify({ profile }) });
    await loadAll();
    toast(`Usage plan set to ${profile}`);
  });
  $("#workers-paid-confirmed")?.addEventListener("change", async (event) => {
    const control = event.currentTarget;
    const confirmedWorkersPaid = control.checked;
    const previous = !confirmedWorkersPaid;
    let saved = false;
    control.disabled = true;
    try {
      await api("/api/budget/execution-capacity", {
        method: "PUT",
        body: JSON.stringify({ confirmedWorkersPaid }),
      });
      saved = true;
      await loadAll();
      toast(confirmedWorkersPaid ? "Higher Worker limits confirmed" : "Free plan limits active");
    } catch (error) {
      if (!saved) control.checked = previous;
      toast(error.message, "error");
    } finally {
      control.disabled = false;
    }
  });
  $("#toggle-source-form").addEventListener("click", () => { const panel = $("#source-form-panel"); panel.hidden = !panel.hidden; $("#source-list-standalone").hidden = !panel.hidden; $("#toggle-source-form").textContent = panel.hidden ? "Add custom source" : "Close form"; });
  $("#source-kind").addEventListener("change", (event) => renderSourceConfigFields(event.target.value));
  $("#source-config-fields").addEventListener("change", (event) => { if (event.target.id === "bsky-mode") updateBlueskyFields(); });
  $("#source-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { await api("/api/sources", { method: "POST", body: JSON.stringify(sourcePayload(form)) }); form.reset(); renderSourceConfigFields($("#source-kind").value); await loadAll(); toast("Source added"); } catch (error) { toast(error.message, "error"); } });
  $("#capture-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const result = await api("/api/manual", { method: "POST", body: JSON.stringify({ url: data.url, title: data.title || undefined }) }); $("#capture-result").textContent = "Saved to Driftglass."; form.reset(); toast("Saved"); });
  $("#export-config").addEventListener("click", async () => downloadJson("driftglass-profile.json", await api("/api/config/export")));
  $("#import-config").addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const dryRun = await api("/api/config/import?dryRun=true", { method: "POST", body: JSON.stringify(data) });
      const preview = dryRun.preview || {};
      const updates = Number(preview.sources?.update || 0) + Number(preview.missions?.update || 0);
      const summary = `Restore ${preview.sources?.total ?? 0} sources, ${preview.missions?.total ?? 0} Missions, ${preview.intelligencePacks?.total ?? 0} Intelligence Packs, ${preview.customPlaybooks ?? 0} research methods, ${preview.approvedMemoryPatches?.total ?? 0} approved memory changes, ${preview.missionEvents ?? 0} history entries, and the ${preview.budgetProfile || "existing"} plan?${updates ? `\n\n${updates} existing items will be updated in place.` : ""}\n\n${preview.graphPolicy || "Connected memory will be rebuilt after restore."}`;
      if (!window.confirm(summary)) return;
      const result = await api("/api/config/import", { method: "POST", body: JSON.stringify(data) });
      await loadAll();
      toast(`Imported ${result.sources} sources, ${result.missions} Missions, ${result.packs || 0} Packs, and ${result.memoryPatches || 0} approved memory patches`);
    } finally { event.target.value = ""; }
  });
  $("#mission-edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const id = String(data.id || "");
    data.terms = lines(data.terms);
    data.priority = Number(data.priority);
    data.cadenceMinutes = Number(data.cadenceMinutes || 360);
    data.reminderLeadDays = Number(data.reminderLeadDays || 3);
    data.alertThreshold = Number(data.alertThreshold);
    if (!data.expectedBy) data.expectedBy = null;
    await api(`/api/missions/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) });
    await loadAll();
    const refreshed = state.missions.find((mission) => mission.id === id);
    if (refreshed) openMissionEditor(id);
    toast("Mission updated");
  });
  $("#mission-event-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const missionId = String(data.missionId || "");
    await api(`/api/missions/${encodeURIComponent(missionId)}/events`, { method: "POST", body: JSON.stringify(data) });
    form.elements.title.value = "";
    form.elements.detail.value = "";
    await loadAll();
    const refreshed = state.missions.find((mission) => mission.id === missionId);
    if (refreshed) renderMissionEvents(refreshed.events || []);
    toast("Mission history updated");
  });
  $("#mission-dialog .dialog-close").addEventListener("click", () => $("#mission-dialog").close());
  $("#research-dialog .dialog-close").addEventListener("click", () => $("#research-dialog").close());
  $("#share-dialog .dialog-close").addEventListener("click", () => $("#share-dialog").close());
  $("#share-dialog").addEventListener("submit", async (event) => {
    if (event.target.id !== "share-create-form") return;
    event.preventDefault();
    const pending = state.pendingShare;
    if (!pending) return;
    const submit = event.target.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const reviewedRunId = String(new FormData(event.target).get("reviewedRunId") || "");
      await publishShare(pending.kind, pending.id, reviewedRunId);
    } catch (error) {
      toast(error.message, "error");
      if (submit) submit.disabled = false;
    }
  });
  $("#pair").addEventListener("click", async () => { state.pair = await api("/api/collectors/pairing", { method: "POST", body: JSON.stringify({ name: "Driftglass Companion" }) }); renderPairOutput(); });
  $("#catalog-search").addEventListener("input", (event) => renderCatalog(event.target.value));
  $("#adapter-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api("/api/catalog/source", { method: "POST", body: JSON.stringify(adapterSourcePayload(event.currentTarget)) });
    $("#adapter-dialog").close();
    state.selectedAdapter = null;
    await loadAll();
    toast(result.scheduled ? "Source added · collection started" : "Source added");
  });
  $("#adapter-dialog .dialog-close").addEventListener("click", () => $("#adapter-dialog").close());
  $("#semantic-memory-setup")?.addEventListener("click", async () => { await api("/api/ai-search/setup", { method: "POST", body: "{}" }); await loadAll(); toast("AI Search enabled; sync when you are ready"); });
  $("#semantic-memory-sync")?.addEventListener("click", async () => { await api("/api/ai-search/sync", { method: "POST", body: JSON.stringify({ wait: false }) }); toast("Search update started"); setTimeout(() => loadAll().catch(() => undefined), 4000); });
  $("#semantic-memory-search")?.addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); const result = await api("/api/ai-search/search", { method: "POST", body: JSON.stringify({ query: data.query, kind: data.kind || undefined, limit: 12 }) }); renderSemanticResults(result.chunks || []); });
  $("#browser-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); const result = await api("/api/render/inspect", { method: "POST", body: JSON.stringify(data) }); $("#browser-result").textContent = JSON.stringify({ engine: result.engine, title: result.title, finalUrl: result.finalUrl, elapsedMs: result.elapsedMs, browserMs: result.browserMs, attempts: result.attempts, preview: result.preview }, null, 2); await loadAll(); toast(`Page read`); });
  $("#interest-form").addEventListener("submit", async (event) => { event.preventDefault(); const terms = lines($("#interest-terms").value); await api("/api/settings/interests", { method: "PUT", body: JSON.stringify({ terms }) }); toast("Interests saved"); });
  $("#reset-taste").addEventListener("click", async () => { await api("/api/taste", { method: "DELETE" }); state.taste = { positiveTerms: [], negativeTerms: [], preferredSources: [], downweightedSources: [] }; renderTaste(); toast("Taste Profile reset"); });
  $("#story-dialog .dialog-close").addEventListener("click", () => $("#story-dialog").close());

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button, a"); if (!button) return;
    try {
      if (button.matches(".story-open, .mission-story")) await openStory(button.dataset.story);
      else if (button.matches("[data-run]")) await runSource(button.dataset.run);
      else if (button.matches("[data-delete]")) await deleteSource(button.dataset.delete);
      else if (button.matches(".ingest-dead-letter-action")) await actOnIngestDeadLetter(button);
      else if (button.matches(".apply-pack") && !button.classList.contains("installed")) await applyPack(button.dataset.pack);
      else if (button.matches(".export-pack")) { const pack = state.packs.find((candidate) => candidate.id === button.dataset.pack); downloadJson(`driftglass-lens-${button.dataset.pack}.json`, pack?.lensType === "community" ? pack : await api(`/api/packs/${encodeURIComponent(button.dataset.pack)}/export`)); }
      else if (button.matches("[data-pack-category]")) { state.packCategory = button.dataset.packCategory; renderPacks(); }
      else if (button.matches(".install-suggestion")) { const suggestion = state.suggestions.find((item) => item.id === button.dataset.suggestion); if (suggestion) { await api("/api/sources", { method: "POST", body: JSON.stringify(suggestion.source) }); await loadAll(); toast("Source added"); } }
      else if (button.matches(".preview-intelligence-pack") && !button.classList.contains("installed")) { const entry = (state.intelligence.catalog || []).find((candidate) => (candidate.id || candidate.pack?.id) === button.dataset.pack); if (!entry) throw new Error("Intelligence Pack not found"); const sourceUrl = entry.installUrl ? new URL(entry.installUrl, location.origin).toString() : ""; await previewIntelligencePackInput(entry.pack || entry, sourceUrl); }
      else if (button.matches(".install-intelligence-pack")) await installPendingIntelligencePack(button.dataset.companion === "true");
      else if (button.matches(".pack-switch-cheap")) { await api("/api/budget", { method: "PUT", body: JSON.stringify({ profile: "cheap" }) }); await loadAll(); await previewIntelligencePackInput(state.pendingPackPreview?.pack, state.pendingPackPreview?.sourceUrl || ""); toast("Low-cost plan enabled"); }
      else if (button.matches(".pack-review-capacity")) { $("#story-dialog").close(); setView("system"); $("#workers-paid-confirmed")?.scrollIntoView({ behavior: "smooth", block: "center" }); }
      else if (button.matches(".download-pack-skill")) { const pending = state.pendingPackPreview; if (!pending) throw new Error("Preview a Pack first"); downloadBlob(`driftglass-${pending.pack.id}-skill.zip`, await apiBlob("/api/intelligence-packs/skill.zip", { method: "POST", body: JSON.stringify({ pack: pending.pack }) })); }
      else if (button.matches(".installed-pack-skill")) downloadBlob(`driftglass-${button.dataset.pack}-skill.zip`, await apiBlob(`/api/intelligence-packs/${encodeURIComponent(button.dataset.pack)}/skill.zip`));
      else if (button.matches(".installed-pack-export")) downloadBlob(`driftglass-${button.dataset.pack}.intelligence-pack.json`, await apiBlob(`/api/intelligence-packs/${encodeURIComponent(button.dataset.pack)}/export`));
      else if (button.matches(".installed-pack-update")) { const result = await api(`/api/intelligence-packs/${encodeURIComponent(button.dataset.pack)}/update`, { method: "POST", body: JSON.stringify({ includeCompanionSources: false }) }); await loadAll(); state.packUpdates = []; renderIntelligencePacks(); toast(result.updated ? `Updated to ${result.pack.version}` : "Pack is already current"); }
      else if (button.matches(".installed-pack-preserve")) { const result = await api(`/api/intelligence-packs/${encodeURIComponent(button.dataset.pack)}/overlays/capture`, { method: "POST", body: JSON.stringify({ name: `My ${button.dataset.pack} customizations` }) }); await loadAll(); toast(result.created ? "Local changes saved" : "No local Pack differences found"); }
      else if (button.matches(".installed-pack-fork")) { const result = await api(`/api/intelligence-packs/${encodeURIComponent(button.dataset.pack)}/fork`, { method: "POST", body: "{}" }); downloadJson(`driftglass-${slug(result.pack.id)}.intelligence-pack.json`, result.pack); toast(result.conflicts?.length ? `Fork exported with ${result.conflicts.length} conflict note${result.conflicts.length === 1 ? "" : "s"}` : "Forked Intelligence Pack exported"); }
      else if (button.matches(".judgment-materialize")) await materializeJudgmentTask(button.dataset.task);
      else if (button.matches(".judgment-open-receipt")) { setView("integrations"); await openReasoningReceipt(button.dataset.receipt); }
      else if (button.matches(".judgment-dismiss-task")) { await api(`/api/reasoning/tasks/${encodeURIComponent(button.dataset.task)}/status`, { method: "POST", body: JSON.stringify({ status: "dismissed" }) }); await loadAll(); toast("Reasoning task dismissed"); }
      else if (button.matches(".routine-run")) { const result = await api(`/api/routines/${encodeURIComponent(button.dataset.routine)}/run`, { method: "POST", body: "{}" }); await loadAll(); toast("Scheduled research started"); }
      else if (button.matches(".decision-review")) await openDecisionReview(button.dataset.decisionId);
      else if (button.matches(".reasoning-review")) { const note = window.prompt(`Optional note for this ${button.dataset.decision}`, "") || ""; await api(`/api/reasoning/runs/${encodeURIComponent(button.dataset.run)}/review`, { method: "POST", body: JSON.stringify({ decision: button.dataset.decision, rating: button.dataset.decision === "approve" ? 4 : 2, note }) }); const receiptId = state.currentReasoningReceipt?.receipt?.id; await loadAll(); if (receiptId) await openReasoningReceipt(receiptId, { scroll: false }); toast(`Answer ${button.dataset.decision === "approve" ? "approved" : "rejected"}`); }
      else if (button.matches(".memory-proposal-approve")) { await api(`/api/memory/proposals/${encodeURIComponent(button.dataset.proposal)}/approve`, { method: "POST", body: JSON.stringify({ note: "Approved from Driftglass dashboard" }) }); await loadAll(); toast("Memory change approved"); }
      else if (button.matches(".memory-proposal-reject")) { const note = window.prompt("Why should this memory change be rejected?", "Not durable or not sufficiently supported") || "Rejected from Driftglass dashboard"; await api(`/api/memory/proposals/${encodeURIComponent(button.dataset.proposal)}/reject`, { method: "POST", body: JSON.stringify({ note }) }); await loadAll(); toast("Memory change rejected"); }
      else if (button.matches(".connect-chatgpt")) {
        window.open("https://chatgpt.com/plugins", "_blank", "noopener,noreferrer");
        await navigator.clipboard.writeText(button.dataset.copyValue || "");
        toast("Connection copied — paste it into Create app in ChatGPT");
      }
      else if (button.matches(".download-chatgpt-plugin")) {
        const input = button.closest(".chatgpt-plugin-download")?.querySelector(".chatgpt-plugin-app-id");
        if (!input?.reportValidity()) return;
        button.disabled = true;
        try {
          downloadBlob("driftglass-plugin.zip", await apiBlob("/api/reasoning/chatgpt-plugin.zip", {
            method: "POST",
            body: JSON.stringify({ appId: input.value }),
          }));
          toast("Driftglass plugin downloaded");
        } finally {
          button.disabled = false;
        }
      }
      else if (button.matches(".disconnect-reasoning-connection")) {
        const connectionId = button.dataset.connection || "";
        button.disabled = true;
        try {
          await api(`/api/reasoning/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
          await refreshReasoningConnections();
          toast("Connection removed");
        } catch (error) {
          button.disabled = false;
          throw error;
        }
      }
      else if (button.matches(".copy-provider")) { await navigator.clipboard.writeText(button.dataset.copyValue || ""); toast("Copied"); }
      else if (button.matches(".reasoning-use-deep-research")) { const select = $("#reasoning-form [name=task]"); if (select) select.value = "deep-research"; toast("Deep Research output contract selected"); }
      else if (button.matches(".action-center-button")) {
        const action = button.dataset.actionKind;
        if (action === "review-research-result") await reviewResearchResult(button.dataset.import);
        else if (action === "run-mission-sprint") {
          const result = await api(`/api/missions/${encodeURIComponent(button.dataset.mission)}/sprint`, { method: "POST", body: "{}" });
          await loadAll(); toast("Mission refresh started");
        } else if (action === "open-reasoning") {
          setView("integrations");
          if (button.dataset.receipt) await openReasoningReceipt(button.dataset.receipt);
          else if (button.dataset.task) await materializeJudgmentTask(button.dataset.task);
        } else if (action === "review-decision") { setView("integrations"); await openDecisionReview(button.dataset.decisionId); }
        else if (action === "open-sources") setView("sources");
        else if (button.dataset.mission) { setView("missions"); openMissionEditor(button.dataset.mission); }
      }
      else if (button.matches(".review-research-result")) await reviewResearchResult(button.dataset.import);
      else if (button.matches(".confirm-research-result")) {
        await api(`/api/research-results/${encodeURIComponent(button.dataset.import)}/confirm`, { method: "POST", body: "{}" });
        $("#research-dialog").close(); await loadAll(); toast("Mission memory updated");
      }
      else if (button.matches(".reject-research-result")) {
        await api(`/api/research-results/${encodeURIComponent(button.dataset.import)}/reject`, { method: "POST", body: "{}" });
        $("#research-dialog").close(); await loadAll(); toast("Research result rejected");
      }
      else if (button.matches(".mission-open, .jump-missions")) setView("missions");
      else if (button.matches(".jump-sources")) setView("sources");
      else if (button.matches(".mission-sprint")) {
        const result = await api(`/api/missions/${encodeURIComponent(button.dataset.mission)}/sprint`, { method: "POST", body: "{}" });
        await loadAll();
        toast("Mission refresh started");
      }
      else if (button.matches(".mission-research")) await openDeepResearch(button.dataset.mission);
      else if (button.matches(".mission-configure")) openMissionEditor(button.dataset.mission);
      else if (button.matches(".mission-dossier")) await openMissionDossier(button.dataset.mission);
      else if (button.matches(".mission-dossier-copy")) { await navigator.clipboard.writeText(state.currentDossier?.markdown || ""); toast("Question brief copied"); }
      else if (button.matches(".mission-dossier-download")) { if (!state.currentDossier?.markdown) throw new Error("Open a question brief first"); downloadText(`driftglass-mission-${slug(button.dataset.mission)}-dossier.md`, state.currentDossier.markdown); }
      else if (button.matches(".mission-computer")) await openMissionComputer(button.dataset.mission);
      else if (button.matches(".computer-sync")) await openMissionComputer(button.dataset.mission, true);
      else if (button.matches(".computer-export")) { const exported = await api(`/api/missions/${encodeURIComponent(button.dataset.mission)}/computer/export`); downloadJson(`driftglass-mission-computer-${slug(button.dataset.mission)}.json`, exported); }
      else if (button.matches(".mission-deep-dive")) await openMissionDeepDive(button.dataset.mission);
      else if (button.matches(".mission-share")) await openShareComposer("mission", button.dataset.mission);
      else if (button.matches(".story-deep-dive")) await openStoryDeepDive(button.dataset.story);
      else if (button.matches(".story-share")) await openShareComposer("story", button.dataset.story);
      else if (button.matches(".mission-bundle")) await exportMissionBundle(button.dataset.mission);
      else if (button.matches(".story-bundle")) await exportStoryBundle(button.dataset.story);
      else if (button.matches(".deep-dive-download")) await downloadDeepDive(button.dataset.exportUrl, button.dataset.case);
      else if (button.matches(".mission-rebuild")) { await api(`/api/missions/${encodeURIComponent(button.dataset.mission)}/rebuild`, { method: "POST", body: "{}" }); await loadAll(); toast("Mission update started"); }
      else if (button.matches(".mission-delete")) { await api(`/api/missions/${encodeURIComponent(button.dataset.mission)}`, { method: "DELETE" }); await loadAll(); toast("Mission removed"); }
      else if (button.matches(".catalog-add")) openAdapterBuilder(button.dataset.site, button.dataset.command);
      else if (button.matches("[data-pair-os]")) { state.pairOs = button.dataset.pairOs; renderPairOutput(); }
      else if (button.matches(".copy-pair")) { await navigator.clipboard.writeText(pairCommands()[state.pairOs]); toast("Command copied"); }
      else if (button.matches(".copy")) { const target = document.getElementById(button.dataset.target); await navigator.clipboard.writeText(target.value); toast("Copied"); }
      else if (button.matches(".copy-value")) { await navigator.clipboard.writeText(button.dataset.copyValue); toast("Task prompt copied"); }
      else if (button.matches(".copy-deep-research")) { await navigator.clipboard.writeText(state.deepResearch?.handoff?.prompt || ""); toast("Deep Research prompt copied"); }
      else if (button.matches(".download-deep-research")) { const handoff = state.deepResearch?.handoff; downloadText(`driftglass-deep-research-${slug(handoff?.mission?.name || "mission")}.md`, state.deepResearch?.markdown || ""); }
      else if (button.matches(".copy-share-live")) { await navigator.clipboard.writeText(state.latestShare?.url || ""); toast("Live view link copied"); }
      else if (button.matches(".feedback-button[data-feedback]")) { const result = await api("/api/feedback", { method: "POST", body: JSON.stringify({ storyId: button.dataset.story, action: button.dataset.feedback }) }); button.classList.add("selected"); const taste = await api("/api/taste"); state.taste = taste.profile || state.taste; renderTaste(); await openStory(button.dataset.story); toast(result.learned?.termsLearned ? `Preference saved · learned ${result.learned.termsLearned} signals` : "Preference saved"); }
    } catch (error) { toast(error.message, "error"); }
  });
}

wireEvents();
renderSourceConfigFields($("#source-kind").value);
initializeCaptureTools();
setView(location.hash.slice(1) || "today");
window.addEventListener("focus", () => {
  if (!state.secret || !$("#integrations")?.classList.contains("active-view")) return;
  refreshReasoningConnections().catch(() => undefined);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
