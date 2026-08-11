import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderPublicSharePage } = require("../.test-dist/public-share-page.js");
process.env.TZ = "UTC";

const payload = {
  schemaVersion: "2",
  publicEvidenceOnly: true,
  kind: "mission",
  title: "Sample public data: renderer parity",
  subtitle: "Can the public Share renderer remain deterministic?",
  generatedAt: "2026-04-21T12:00:00.000Z",
  reviewedAnswer: {
    answer: "The pure renderer preserves the live Share contract.",
    whyItMatters: "Readers get the conclusion before its supporting mechanics.",
    keyJudgments: [{
      text: "The live route and Drop use the same reviewed answer.",
      citationUrls: ["https://blog.cloudflare.com/welcome-to-agents-week/"],
    }],
    outlook: "The renderer can remain deterministic as the analysis grows.",
    alternativeCase: {
      text: "A route-only template could drift from downloaded copies.",
      citationUrls: ["https://blog.cloudflare.com/welcome-to-agents-week/"],
    },
    whatWouldChange: ["A byte-level parity check fails."],
    signposts: [{
      text: "The next deterministic export check",
      citationUrls: ["https://blog.cloudflare.com/welcome-to-agents-week/"],
    }],
    nextSteps: ["Keep the pure renderer covered by a fixed-output test."],
    whatToWatch: ["A primary-source update"],
    uncertainty: ["The timing remains unclear"],
    evidenceSnapshotHash: "a".repeat(64),
    reviewedAt: "2026-04-21T14:00:00.000Z",
  },
  stories: [{
    id: "sample-story",
    title: "Renderer extraction",
    summary: "The route retains its storage, analytics, response-header, and URL responsibilities.",
    evidenceCount: 1,
    sourceCount: 1,
    sourceFamilyCount: 1,
    independentFamilyCount: 0,
    echoCount: 0,
    confidence: 0.8,
    changedAt: "2026-04-21T11:00:00.000Z",
    evidence: [{
      accessClass: "public",
      independent: false,
      lineageRelation: "origin",
      evidenceFamily: "cloudflare-official",
      source: "Cloudflare Blog",
      title: "Public source",
      url: "https://blog.cloudflare.com/welcome-to-agents-week/",
      publishedAt: "2026-04-12T12:00:00.000Z",
    }],
  }],
};

test("pure public Share renderer preserves the live metadata and visible card contract", () => {
  const page = renderPublicSharePage({
    payload,
    publicIndexing: true,
    dropUrl: "https://public.example/share/example/drop.zip",
    ogImageUrl: "https://public.example/share/example/og.png",
  });
  for (const expected of [
    '<meta name="robots" content="index,follow">',
    '<meta property="og:image" content="https://public.example/share/example/og.png">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<a class="cta" href="https://public.example/share/example/drop.zip">Download a copy</a>',
    '<a class="repo-link" href="https://github.com/anotb/driftglass#quick-start" target="_blank" rel="noopener noreferrer">Quick start</a>',
    "Sample public data: renderer parity",
    "Public sources",
    "Bottom line",
    "What this means",
    "What to watch next",
    "Open questions",
    "Original source",
    "Why this is happening",
    "Outlook",
    "Alternative case",
    "What could change",
    "Next steps",
    "<details><summary>Open links</summary>",
    '<span class="claim-citations"><a href="https://blog.cloudflare.com/welcome-to-agents-week/" target="_blank" rel="noopener noreferrer">[1]</a></span>',
  ]) assert.match(page, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(page.indexOf("Open source [1]") > page.indexOf("<summary>Open links</summary>"));
  assert.equal(page.match(/>Sources</g)?.length, 1);
  assert.equal(page.match(/href="https:\/\/blog\.cloudflare\.com\/welcome-to-agents-week\/"[^>]*>\[1\]<\/a>/g)?.length, 3);
  assert.doesNotMatch(page, /\[object Object\]/);
  assert.doesNotMatch(page, /<small class="illustrative-disclosure">/);
  assert.doesNotMatch(page, />Reviewed answer<|Why it matters|What to watch<|>Uncertainty<|Download self-contained copy|Review the public evidence|Prepared from evidence snapshot|Sources and review details/i);
  // Locks the exact pure-renderer output used by the live route at its default presentation.
  assert.equal(createHash("sha256").update(page).digest("hex"), "58d801a8f202701517dae2f1bf776105fbbac944ae821bacff34132a05f1ea4d");
  assert.doesNotMatch(page, /PRIVATE|authenticated-local|subscriber-local/);
});

test("launch-only presentation labels do not change the generic live defaults", () => {
  const page = renderPublicSharePage({
    payload,
    publicIndexing: true,
    dropUrl: "sample-drop.zip",
    presentation: {
      watchLabel: "Before committing",
      downloadLabel: "Download decision pack",
      disclosure: "Illustrative decision · public sources",
    },
  });
  assert.match(page, /<h3>Before committing<\/h3>/);
  assert.match(page, /<a class="cta" href="sample-drop\.zip">Download decision pack<\/a>/);
  assert.match(page, /<small class="illustrative-disclosure">Illustrative decision · public sources<\/small>/);
  assert.match(page, /<main class="portfolio-presentation">/);
  assert.match(page, /\.portfolio-presentation \.reviewed-answer\{margin:14px 0;padding:18px 22px\}/);
  assert.match(page, /<div class="portfolio-download">/);
  assert.match(page, /<a class="repo-link" href="https:\/\/github\.com\/anotb\/driftglass#quick-start" target="_blank" rel="noopener noreferrer">Quick start<\/a>/);
  assert.doesNotMatch(page, /Public evidence only\./);
  assert.doesNotMatch(page, /What to watch next|Download a copy/);
});

test("analysis presentation labels are accepted without changing stored Share data", () => {
  const page = renderPublicSharePage({
    payload,
    publicIndexing: true,
    dropUrl: "sample-drop.zip",
    presentation: {
      watchLabel: "Signals to watch",
      downloadLabel: "Download the brief",
      disclosure: "Illustrative analysis · public sources",
    },
  });
  assert.match(page, /<h3>Signals to watch<\/h3>/);
  assert.match(page, /<a class="cta" href="sample-drop\.zip">Download the brief<\/a>/);
  assert.match(page, /<small class="illustrative-disclosure">Illustrative analysis · public sources<\/small>/);
  assert.doesNotMatch(page, /Illustrative decision|Before committing|Download decision pack/);
});

test("reviewed Share source relationships use reader-facing labels", () => {
  const evidence = [
    ["origin", "Original source"],
    ["independent", "Independent source"],
    ["same-family", "Related report"],
    ["echo", "Repeated report"],
    ["update", "Relationship unknown"],
  ].map(([lineageRelation, label], index) => ({
    ...payload.stories[0].evidence[0],
    lineageRelation,
    title: label,
    url: `https://public.example/source-${index + 1}`,
  }));
  const page = renderPublicSharePage({
    payload: { ...payload, stories: [{ ...payload.stories[0], evidence }] },
    publicIndexing: true,
    dropUrl: "sample-drop.zip",
  });
  for (const label of evidence.map((item) => item.title)) assert.match(page, new RegExp(`<span>${label}`));
  assert.doesNotMatch(page, /<span>(?:Primary evidence|Independent evidence|Related coverage|Repeated coverage|Lineage not established)/);
});

test("live Share route keeps URL, analytics, and response policy outside the pure renderer", async () => {
  const source = await readFile(new URL("../src/shares.ts", import.meta.url), "utf8");
  assert.match(source, /incrementPublicShareView/);
  assert.match(source, /url\.searchParams\.get\("preview"\) !== "1"/);
  assert.match(source, /renderPublicSharePage\(\{/);
  assert.match(source, /dropUrl: new URL\(`\/share\/\$\{token\}\/drop\.zip`/);
  assert.match(source, /ogImageUrl: ogImage/);
  assert.match(source, /headers: shareHeaders\(env/);
  const rendererCall = source.slice(source.indexOf("const page = renderPublicSharePage"), source.indexOf("return new Response(page"));
  assert.doesNotMatch(rendererCall, /presentation/);
});

test("pure renderer does not normalize an already-normalized public payload again", () => {
  const page = renderPublicSharePage({
    payload: { ...payload, title: "&lt;b&gt;safe&lt;/b&gt;" },
    publicIndexing: true,
    dropUrl: "https://public.example/share/example/drop.zip",
    ogImageUrl: "https://public.example/share/example/og.png",
  });
  assert.match(page, /<h1>&amp;lt;b&amp;gt;safe&amp;lt;\/b&amp;gt;<\/h1>/);
  assert.doesNotMatch(page, /<h1>safe<\/h1>/);
});

test("a headline that already states the answer is not repeated beneath itself", () => {
  const title = "Hormuz is reopening. The gas market is not back to normal.";
  const page = renderPublicSharePage({
    payload: {
      ...payload,
      title,
      reviewedAnswer: { ...payload.reviewedAnswer, answer: "Treat Hormuz as open but not normalized." },
    },
    publicIndexing: true,
    dropUrl: "sample-drop.zip",
  });
  assert.equal(page.split(title).length - 1, 3, "title appears in the page title, Open Graph title, and h1 only");
  assert.match(page, /<p class="assessment">Analysis<\/p>/);
  assert.doesNotMatch(page, /<p class="answer">Treat Hormuz/);
});
