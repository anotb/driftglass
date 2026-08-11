import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createStoredZip, crc32 } from "../.test-dist/zip.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { buildDropCapsule, buildForkableIntelligencePack } = require("../.test-dist/drop-capsule.js");

const publicPayload = {
  schemaVersion: "2",
  publicEvidenceOnly: true,
  kind: "mission",
  title: "Shared decision briefing",
  subtitle: "What changed, and what should happen next?",
  generatedAt: "2026-04-21T12:00:00.000Z",
  reviewedAnswer: {
    answer: "Run a bounded pilot before expanding.",
    whyItMatters: "The evidence supports a reversible next step.",
    keyJudgments: [{
      text: "The current evidence supports a bounded test.",
      citationUrls: ["https://public.example/update"],
    }],
    options: [
      { name: "Bounded pilot", tradeoff: "Adds a test cycle but limits exposure." },
      { name: "Broad rollout", tradeoff: "Moves faster but makes hidden failure costlier." },
    ],
    outlook: "The pilot should resolve the most consequential uncertainty.",
    alternativeCase: {
      text: "The pilot may miss failures that appear only at scale.",
      citationUrls: ["https://public.example/update"],
    },
    whatWouldChange: ["The pilot omits a required approval event."],
    signposts: [{
      text: "Approval-event coverage",
      citationUrls: ["https://public.example/update"],
    }],
    nextSteps: ["Run the pilot with a fixed cohort and stop condition."],
    whatToWatch: ["A primary-source update"],
    uncertainty: ["The implementation window is unresolved"],
    evidenceSnapshotHash: "a".repeat(64),
    reviewedAt: "2026-04-21T14:00:00.000Z",
  },
  stories: [{
    id: "story-1",
    title: "A material update",
    summary: "The public evidence changed the decision boundary.",
    evidenceCount: 1,
    sourceCount: 1,
    sourceFamilyCount: 1,
    independentFamilyCount: 0,
    echoCount: 0,
    confidence: 0.72,
    changedAt: "2026-04-21T11:00:00.000Z",
    evidence: [{
      accessClass: "public",
      independent: false,
      lineageRelation: "origin",
      evidenceFamily: "official",
      source: "Official source",
      title: "Primary-source update",
      url: "https://public.example/update",
      publishedAt: "2026-04-21T10:00:00.000Z",
    }],
  }],
};

async function readZipMembers(archive, names) {
  const directory = await mkdtemp(join(tmpdir(), "driftglass-drop-copy-"));
  const zipPath = join(directory, "briefing.zip");
  await writeFile(zipPath, archive);
  try {
    return Object.fromEntries(await Promise.all(names.map(async (name) => {
      const { stdout } = await execFileAsync("unzip", ["-p", zipPath, name]);
      return [name, stdout];
    })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("stored ZIP writer creates a Cloudflare Drop-compatible static archive", async () => {
  const archive = createStoredZip([
    { name: "index.html", data: "<!doctype html><title>Driftglass</title>" },
    { name: "data.json", data: '{"kind":"mission"}\n' },
    { name: "evidence.md", data: "# Evidence\n" },
    { name: "llms.txt", data: "# Driftglass Capsule\n" },
  ], new Date("2026-08-07T12:00:00Z"));
  assert.equal(new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(0, true), 0x04034b50);
  assert.ok(archive.byteLength > 200);

  const directory = await mkdtemp(join(tmpdir(), "driftglass-drop-"));
  const zipPath = join(directory, "capsule.zip");
  await writeFile(zipPath, archive);
  try {
    const { stdout } = await execFileAsync("unzip", ["-l", zipPath]);
    for (const name of ["index.html", "data.json", "evidence.md", "llms.txt"]) assert.match(stdout, new RegExp(name.replace(".", "\\.")));
    const { stdout: index } = await execFileAsync("unzip", ["-p", zipPath, "index.html"]);
    assert.match(index, /Driftglass/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CRC32 matches the canonical test vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("Drop briefing leads with the outcome while keeping mechanics and limits subordinate", async () => {
  const defaults = await readZipMembers(buildDropCapsule(publicPayload), ["index.html", "evidence.md", "data.json"]);
  for (const expected of [
    "Bottom line",
    "What this means",
    "What to watch next",
    "Open questions",
    "Original source",
    "Why this is happening",
    "Other choices",
    "Outlook",
    "Alternative case",
    "What could change",
    "Next steps",
    "Sources",
    "Follow this question",
    "Install the Pack to track updates from the same public sources.",
    '<a class="repo-link" href="https://github.com/anotb/driftglass#quick-start" target="_blank" rel="noopener noreferrer">Quick start</a>',
    '<span class="claim-citations"><a href="https://public.example/update" target="_blank" rel="noopener noreferrer">[1]</a></span>',
  ]) assert.match(defaults["index.html"], new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(defaults["index.html"].indexOf("Primary-source update") > defaults["index.html"].indexOf("<summary>Open links</summary>"));
  assert.equal(defaults["index.html"].match(/>Sources</g)?.length, 1);
  assert.equal(defaults["index.html"].match(/href="https:\/\/public\.example\/update"[^>]*>\[1\]<\/a>/g)?.length, 3);
  assert.doesNotMatch(defaults["index.html"], /\[object Object\]/);
  assert.doesNotMatch(defaults["index.html"], /<small class="illustrative-disclosure">/);
  assert.doesNotMatch(defaults["index.html"], /Self-contained copy|included Intelligence Pack|Download the Pack|Self-contained public-evidence snapshot|Reviewed answer|Why it matters|What to watch<|>Uncertainty<|Review the public evidence|evidence snapshot|review details/i);

  assert.match(defaults["evidence.md"], /^## Bottom line$/m);
  assert.match(defaults["evidence.md"], /^### What to watch next$/m);
  assert.match(defaults["evidence.md"], /^### Open questions$/m);
  assert.match(defaults["evidence.md"], /^## Sources$/m);
  assert.doesNotMatch(defaults["evidence.md"], /^### A material update$/m);
  assert.match(defaults["evidence.md"], /\[\[1\]\]\(https:\/\/public\.example\/update\)/);
  assert.equal(defaults["evidence.md"].match(/\[\[1\]\]\(https:\/\/public\.example\/update\)/g)?.length, 3);
  assert.doesNotMatch(defaults["evidence.md"], /\[object Object\]/);
  assert.doesNotMatch(defaults["evidence.md"], /evidence snapshot|review details/i);
  const recipient = JSON.parse(defaults["data.json"]);
  assert.deepEqual(recipient.reviewedAnswer, publicPayload.reviewedAnswer);
  assert.equal("presentation" in recipient, false);

  const launch = await readZipMembers(buildDropCapsule(publicPayload, {
    publicIndexing: true,
    presentation: {
      watchLabel: "Before committing",
      disclosure: "Illustrative decision · public sources",
    },
  }), ["index.html", "evidence.md", "data.json"]);
  assert.match(launch["index.html"], /<h3>Before committing<\/h3>/);
  assert.match(launch["index.html"], /<small class="illustrative-disclosure">Illustrative decision · public sources<\/small>/);
  assert.match(launch["evidence.md"], /^### Before committing$/m);
  assert.match(launch["evidence.md"], /^<small class="illustrative-disclosure">Illustrative decision · public sources<\/small>$/m);
  assert.doesNotMatch(launch["index.html"], /What to watch next/);
  assert.doesNotMatch(launch["index.html"], /Public evidence only\./);
  assert.doesNotMatch(launch["evidence.md"], /Public evidence only\./);
  assert.deepEqual(JSON.parse(launch["data.json"]), recipient);
});

test("Drop fallbacks describe the current answer without reassurance copy", async () => {
  const payload = {
    ...publicPayload,
    subtitle: undefined,
  };
  const [members, source] = await Promise.all([
    readZipMembers(buildDropCapsule(payload), [
      "index.html",
      "evidence.md",
      "llms.txt",
      "manifest.webmanifest",
    ]),
    readFile(new URL("../src/drop-capsule.ts", import.meta.url), "utf8"),
  ]);

  assert.match(members["index.html"], /A sourced answer from Driftglass\./);
  assert.match(members["evidence.md"], /^A sourced answer from Driftglass$/m);
  assert.match(members["llms.txt"], /^A sourced answer from Driftglass$/m);
  assert.equal(JSON.parse(members["manifest.webmanifest"]).description, "A sourced briefing from Driftglass");
  assert.match(source, /\|\| "A current answer from the attached public sources\."/);
  for (const output of [...Object.values(members), source]) {
    assert.doesNotMatch(output, /starting thesis|permanent conclusion|Shared intelligence from Driftglass|Shared public-evidence briefing/);
  }
});

test("Drop source relationships use the same reader-facing labels as live Shares", async () => {
  const relationships = [
    ["origin", "Original source"],
    ["independent", "Independent source"],
    ["same-family", "Related report"],
    ["echo", "Repeated report"],
    ["update", "Relationship unknown"],
  ];
  const evidence = relationships.map(([lineageRelation, label], index) => ({
    ...publicPayload.stories[0].evidence[0],
    independent: lineageRelation === "independent",
    lineageRelation,
    evidenceFamily: `family-${index + 1}`,
    title: label,
    url: `https://public.example/source-${index + 1}`,
  }));
  const payload = {
    ...publicPayload,
    stories: [{
      ...publicPayload.stories[0],
      evidence,
      evidenceCount: evidence.length,
      sourceCount: evidence.length,
      sourceFamilyCount: evidence.length,
      independentFamilyCount: 1,
      echoCount: 1,
    }],
  };
  const members = await readZipMembers(buildDropCapsule(payload), ["index.html", "evidence.md"]);
  for (const [, label] of relationships) {
    assert.match(members["index.html"], new RegExp(`<span>${label}`));
    assert.match(members["evidence.md"], new RegExp(`_\\(${label}\\)_`));
  }
  assert.doesNotMatch(members["index.html"], /<span>(?:Primary evidence|Independent evidence|Related coverage|Repeated coverage|Lineage not established)/);
});

test("Drop HTML and Markdown do not repeat a headline that already states the answer", async () => {
  const title = "Hormuz is reopening. The gas market is not back to normal.";
  const members = await readZipMembers(buildDropCapsule({
    ...publicPayload,
    title,
    reviewedAnswer: { ...publicPayload.reviewedAnswer, answer: "Treat Hormuz as open but not normalized." },
  }), ["index.html", "evidence.md"]);
  assert.equal(members["index.html"].split(title).length - 1, 2, "the HTML title and h1 keep the headline once each");
  assert.equal(members["evidence.md"].split(title).length - 1, 1, "Markdown keeps the headline once");
  assert.match(members["index.html"], /<span class="eyebrow">Analysis<\/span>/);
  assert.match(members["evidence.md"], /^## Analysis$/m);
  assert.doesNotMatch(members["index.html"], /<p class="answer">Treat Hormuz/);
});

test("forked Drop Packs turn question headlines into clean prompts and topic terms", () => {
  const title = "Has Hormuz reopened enough for LNG supply to normalize?";
  const pack = buildForkableIntelligencePack({
    ...publicPayload,
    title,
    subtitle: undefined,
    stories: [{
      ...publicPayload.stories[0],
      title: "Qatar and UAE LNG loadings lag liquefaction capacity",
      summary: "Between March and June, Qatar and UAE loadings fell 35 bcm. Production elsewhere added capacity faster, but shipping through the Strait changed before liquefaction output.",
    }],
  });
  const question = pack.missions[0].question;
  const objective = pack.routines[0].steps.find((step) => step.id === "prepare")?.args?.objective;
  const memoryQuestion = pack.memory.questions[0].title;

  assert.equal(question, title);
  assert.equal(
    objective,
    `Answer this standing question: ${title} Explain the causal drivers, the strongest competing case, and the signals that would reverse the current view.`,
  );
  assert.equal(memoryQuestion, "What would change the answer to “Has Hormuz reopened enough for LNG supply to normalize”?");
  for (const text of [question, objective, memoryQuestion]) {
    assert.doesNotMatch(text, /\?\?|\?\./);
    assert.doesNotMatch(text, /[?!.]”[?!.]/u);
  }

  for (const term of ["hormuz", "lng", "qatar", "uae", "loadings", "production", "strait", "capacity", "liquefaction"]) {
    assert.ok(pack.interestTerms.includes(term), `expected topic term ${term}`);
  }
  for (const term of ["the", "and", "but", "for", "between", "enough", "elsewhere", "fell", "added", "changed", "faster", "bcm", "bcm."]) {
    assert.ok(!pack.interestTerms.includes(term), `excluded low-information or punctuated term ${term}`);
  }
  assert.ok(pack.interestTerms.every((term) => !/[.!?]$/u.test(term)));
});
