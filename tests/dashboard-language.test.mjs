import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("Today uses reader-facing update language without changing its controls", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);
  const todayShell = between(html, '<section id="today"', '<section id="missions"');
  const todayRenderer = between(app, "function renderStats()", "function renderReadiness()");
  const storyRenderer = between(app, "function renderStories", "function renderMissionRibbon");

  for (const label of [
    "Questions you follow",
    "Refresh Today",
    "Share Today",
    "Next steps",
    "Briefing",
  ]) assert.match(html, new RegExp(label));
  assert.match(todayRenderer, /<p class="eyebrow">Your Missions<\/p><h3>Questions you’re following<\/h3>/);
  assert.match(todayRenderer, />See all Missions<\/button>/);
  assert.doesNotMatch(storyRenderer, /story-kicker|compactNumber\(sourceCount\)/);
  assert.match(storyRenderer, />Open<\/button>/);
  assert.match(storyRenderer, /<span>\$\{formatDate\(story\.last_changed_at\)\}<\/span>/);
  assert.match(todayRenderer, /item\.action === "review-decision" \? "Review decision"/);
  assert.match(todayRenderer, /No current updates\./);
  assert.match(todayRenderer, /current update/);
  assert.doesNotMatch(todayRenderer, /Everything collected has either been saved or safely accounted for/);
  assert.match(todayRenderer, /class="story-open" data-story=/, "existing Story-open behavior hook stays intact");
  assert.match(html, /id="generate" class="primary">Refresh Today<\/button>/, "existing refresh behavior hook stays intact");

  assert.doesNotMatch(todayShell, /Story memory|Search story memory|No stories yet/);
  assert.doesNotMatch(todayRenderer, /Open evidence|More than one source|One source so far|Questions you're watching/);
});

test("public setup copy starts with the question and uses varied subject examples", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);
  const login = between(html, '<div id="login"', '<div id="app"');
  const onboarding = between(html, '<section id="today"', '<section id="missions"');
  const memory = between(html, '<section id="memory"', '<section id="sources"');
  const sources = between(html, '<section id="sources"', '<section id="capture"');
  const capture = between(html, '<section id="capture"', '<section id="companion"');
  const reasoning = between(html, '<section id="integrations"', '<section id="system"');
  const reasoningQuality = between(app, "function renderReasoningQuality", "function resolveScopeReference");

  assert.match(login, /Personal intelligence for standing questions/);
  assert.match(login, /Follow chosen sources, keep a current cited answer, and revisit it when the facts change\./);
  assert.match(login, /<label for="secret">Owner key<\/label>/);
  assert.doesNotMatch(login, /launch-pills|Private by default|under your control|kept in this browser tab/);

  assert.match(onboarding, /Install one Intelligence Pack to start following a question\./);
  assert.match(onboarding, /Choose a Pack, collect once, then open Today\./);
  assert.match(memory, /<h3>Connected memory<\/h3>/);
  assert.match(memory, /links Missions, findings, decisions, forecasts, and their sources as the answer changes/);
  assert.match(sources, /Ready-made topics/);
  assert.match(capture, /<p class="eyebrow">Save a source<\/p><h3>Add a page to Driftglass<\/h3>/);

  for (const example of [
    "AI advances in materials science",
    "Hormuz LNG",
    "semiconductor supply",
    "IEA gas market updates",
    "Increase semiconductor inventory before a shipping disruption",
  ]) assert.match(html, new RegExp(example));
  assert.doesNotMatch(html, /Personal agent tools worth adopting|local-first agents|Cloudflare changelog|Adopt Kitesurf for public page extraction|Cloudflare Agents&#10;Codex/);
  for (const example of [
    "huggingface/transformers",
    "google-deepmind/alphafold3",
    "battery storage",
    "protein design",
    "materials discovery",
    "LNG market",
  ]) assert.match(app, new RegExp(example));
  assert.doesNotMatch(app, /cloudflare\/agents|cloudflare\/sandbox-sdk|blog\.cloudflare\.com\/tag\/agents-week|computer use agents|"coding agent" OR MCP/);

  assert.match(reasoning, /Prepare a question for your model/);
  assert.match(reasoning, /Choose the question, sources, and length\. Driftglass creates a cited brief you can copy or send through MCP\./);
  assert.match(reasoning, /Use sources from/);
  assert.match(reasoning, /<option value="24000" selected>Thorough<\/option>/);
  assert.match(reasoning, /<option value="50000">Extended<\/option>/);
  assert.match(reasoning, />Prepare brief<\/button>/);
  assert.match(reasoningQuality, /Brief details/);
  assert.match(reasoningQuality, /source item/);
  assert.match(reasoningQuality, /<strong>Limits<\/strong>/);
  assert.doesNotMatch(`${reasoning}\n${reasoningQuality}`, /Evidence quality|Evidence check|Do not overstate this answer|The evidence is ready to use/);
  assert.match(app, /Brief prepared for/);
  assert.match(app, /tokenBudget: 24000/);
  assert.match(app, /data\.tokenBudget \|\| 24000/);
  assert.match(app, /toast\("Brief copied"\)/);
  assert.match(app, /Mission refresh started/);
  assert.doesNotMatch(app, /Evidence prepared for|Evidence brief copied|Evidence refresh started/);
});

test("Share copy describes the answer and sources in plain language", async () => {
  const [html, webmcp] = await Promise.all([read("public/index.html"), read("public/webmcp.js")]);

  assert.match(html, /Turn Today, a Mission, or a Story into a page with the answer and its sources\. Download a copy to keep or pass along\./);
  assert.doesNotMatch(html, /focused evidence-linked page|self-contained copy/);
  assert.match(webmcp, /Publish an expiring public page with the answer and sources for a Story, Research Mission, or the latest briefing\./);
  assert.doesNotMatch(webmcp, /expiring evidence-linked public card/);
  assert.match(webmcp, /tokenBudget: \{ type: "integer", minimum: 2000, maximum: 50000, default: 24000 \}/);
});

test("dashboard status copy stays in ordinary source and plan language", async () => {
  const [html, app, readiness] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("src/readiness.ts"),
  ]);
  const visibleCopy = `${html}\n${app}\n${readiness}`;

  for (const phrase of [
    /evidence items/i,
    /independent evidence families/i,
    /Evidence ready/,
    /More evidence needed/,
    /Free-safe execution/,
    /saved safely/i,
    /never displays/i,
    /current evidence and memory/i,
    /same evidence/i,
    /new evidence collected/i,
  ]) assert.doesNotMatch(visibleCopy, phrase);

  assert.match(app, /source items/);
  assert.match(app, /Needs another source/);
  assert.match(visibleCopy, /Free plan limits active/);
  assert.match(readiness, /Workers Free limits/);
  for (const label of ["First briefing", "Connected memory", "Source collection", "Web reading", "Model connections"]) {
    assert.match(readiness, new RegExp(label));
  }
  assert.doesNotMatch(readiness, /evidence packet|Durable evidence ingestion|quality-graded context kits/);
});

test("Mission workspaces present durable files as readable sections", async () => {
  const app = await read("public/app.js");
  const workspace = between(app, "function workspaceDocumentInfo", "async function openDeepResearch");

  for (const label of [
    "Brief",
    "Answer, mechanism, and next test",
    "Background",
    "How this changed",
    "Research plan",
    "About this workspace",
    "Saved work",
    "Technical files",
    "Search this workspace",
    "Updated",
    "mission\\?\\.question",
  ]) assert.match(workspace, new RegExp(label));
  assert.match(workspace, /openFile\("\/mission\.md"\)/, "the default workspace document is unchanged");
  assert.match(workspace, /data-computer-file=/, "existing file-open behavior hook stays intact");
  assert.match(workspace, /id="computer-search-form"/, "existing workspace-search behavior hook stays intact");
  assert.doesNotMatch(workspace, /Current brief|source items|The question, current answer, sources, research plan, notes, and results in one place\.|Mission brief|Connected memory|Memory timeline|AI research brief|Workspace guide|Show underlying data|Search notes and evidence|matched Stories|evidence items|saved locally|>refreshed /);
});
