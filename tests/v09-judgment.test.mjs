import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { livingDossierMarkdown } = require("../.test-dist/dossiers.js");
const { decisionFingerprint } = require("../.test-dist/decision-ledger.js");
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Living Dossiers preserve thesis, gaps, decisions, and evidence quality without generating a generic summary", () => {
  const markdown = livingDossierMarkdown({
    schemaVersion: "1",
    generatedAt: "2026-08-07T20:00:00.000Z",
    query: "Should Cloudflare Computer remain core to Driftglass?",
    focus: { id: "mission-computer", type: "mission", label: "Cloudflare Computer", summary: "Track fit and maturity." },
    thesis: ["Computer is valuable as a persistent Mission workspace, not as the global index."],
    entities: [],
    claims: [],
    contradictions: [{ from: "preview maturity", to: "core dependency" }],
    decisions: [{ title: "Keep Computer additive", status: "open", confidence: 0.78, statement: "Use filesystem-only core and optional execution backends." }],
    missions: [],
    stories: [{ title: "Computer gains Worker-shell backend", changedAt: "2026-08-07T18:00:00.000Z", sourceCount: 3, summary: "The execution ladder expands." }],
    timeline: [],
    evidenceCoverage: { sources: 4, domains: 3, primaryOrAuthoritative: 2, latestAt: "2026-08-07T18:00:00.000Z" },
    openQuestions: ["When does the preview API stabilize?"],
    quality: { grade: "strong", score: 82, blockers: [] },
  });
  assert.match(markdown, /Current thesis/);
  assert.match(markdown, /Keep Computer additive/);
  assert.match(markdown, /When does the preview API stabilize/);
  assert.match(markdown, /Primary or authoritative: 2/);
  assert.doesNotMatch(markdown, /Here is a comprehensive summary/i);
});

test("Decision fingerprints are stable across provider labels but change when the actual judgment changes", async () => {
  const base = {
    missionId: "mission-computer",
    decisionType: "forecast",
    title: "Computer stabilizes",
    statement: "Cloudflare Computer reaches a stable API before 2027.",
    confidence: 0.7,
    expectedOutcome: "Stable release is announced.",
    reviewAt: "2027-01-01T00:00:00.000Z",
  };
  const first = await decisionFingerprint(base);
  const second = await decisionFingerprint({ ...base, confidence: 0.9, rationale: "A different model was more confident." });
  const changed = await decisionFingerprint({ ...base, statement: "Cloudflare Computer does not reach a stable API before 2027." });
  assert.equal(first, second, "confidence and model commentary must not create a different judgment identity");
  assert.notEqual(first, changed);
});

test("v0.9 exposes the full Judgment Loop and temporal Memory checkpoint surface without adding a model dependency", async () => {
  const [pkgRaw, api, app, html, mcp, routines, lineage] = await Promise.all([
    read("package.json"), read("src/v09-api.ts"), read("public/app.js"), read("public/index.html"),
    read("src/reasoning-mcp.ts"), read("src/intelligence-routines.ts"), read("src/evidence-lineage.ts"),
  ]);
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.version, "0.9.0");
  assert.doesNotMatch(JSON.stringify(pkg.dependencies), /openai|anthropic|xai/i);
  for (const route of [
    "/api/judgment", "/api/dossiers", "/api/source-scorecards", "/api/reasoning/receipts",
    "/api/decisions", "/api/routines", "/api/memory/checkpoints/compare",
  ]) assert.match(api, new RegExp(route.replaceAll("/", "\\/")));
  for (const id of ["judgment-inbox", "reasoning-result-form", "dossier-form", "source-scorecards", "memory-checkpoints"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /Brief prepared/);
  assert.match(app, /Latest memory states compared/);
  assert.match(mcp, /next_reasoning_task/);
  assert.match(routines, /compile-context/);
  assert.match(lineage, /Likely repeated coverage/);
});
