import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reasoningOutputContract, reasoningResultContract } = require("../.test-dist/reasoning.js");

const evidenceUrls = [
  "https://example.com/primary",
  "https://example.net/independent",
  "https://example.org/contrary",
  "https://example.edu/follow-up",
  "https://example.dev/extra",
];

test("decision schema encodes every finite list bound enforced by the review contract", () => {
  const schema = reasoningResultContract("decision", evidenceUrls);
  const properties = schema.properties;

  assert.deepEqual(Object.keys(properties).slice(0, 3), ["recommendation", "confidence", "summary"]);
  assert.deepEqual([properties.options.minItems, properties.options.maxItems], [2, 3]);
  assert.deepEqual([properties.strongestEvidence.minItems, properties.strongestEvidence.maxItems], [2, 4]);
  assert.deepEqual([properties.evidenceGaps.minItems, properties.evidenceGaps.maxItems], [1, 4]);
  assert.deepEqual([properties.reversibleNextSteps.minItems, properties.reversibleNextSteps.maxItems], [1, 4]);
  assert.deepEqual([properties.irreversibleCommitments.minItems, properties.irreversibleCommitments.maxItems], [0, 3]);
  assert.deepEqual([properties.citations.minItems, properties.citations.maxItems], [2, 4]);
  assert.deepEqual(properties.citations.items.enum, evidenceUrls.slice(0, 5));
  assert.equal(Object.hasOwn(properties, "memoryPatch"), false, "Memory proposals must remain a separate reviewed contract");
});

test("every contracted decision string is nonempty and size-bounded", () => {
  const schema = reasoningResultContract("decision", evidenceUrls);
  const strings = [];
  const visit = (value, path = "result") => {
    if (!value || typeof value !== "object") return;
    if (value.type === "string") strings.push({ path, schema: value });
    for (const [key, child] of Object.entries(value)) {
      if (key === "description" || key === "enum") continue;
      if (Array.isArray(child)) child.forEach((entry, index) => visit(entry, `${path}.${key}[${index}]`));
      else visit(child, `${path}.${key}`);
    }
  };
  visit(schema);

  assert.ok(strings.length >= 10);
  for (const entry of strings) {
    assert.equal(entry.schema.minLength, 1, `${entry.path} must reject empty text`);
    assert.ok(Number.isInteger(entry.schema.maxLength) && entry.schema.maxLength > 0, `${entry.path} must have a finite maximum`);
  }
  assert.equal(schema.properties.summary.maxLength, 8_000);
});

test("decision prompt counts align with the schema and stay recommendation-first", () => {
  const contract = reasoningOutputContract("decision", evidenceUrls).join("\n");

  assert.match(contract, /Lead with one concise recommendation and confidence/);
  assert.match(contract, /two or three viable options/);
  assert.match(contract, /two to 4 strongest-evidence claims and two to 4 unique citations/);
  assert.match(contract, /only when it changes what the user should do/);
  assert.match(contract, /irreversible commitments only when the recommendation actually requires one/);
  assert.match(contract, /durable-memory proposal separate/);
});

test("citation bounds shrink to available receipt evidence instead of inviting invented URLs", () => {
  const oneUrlSchema = reasoningResultContract("decision", [evidenceUrls[0]]);
  assert.deepEqual([oneUrlSchema.properties.citations.minItems, oneUrlSchema.properties.citations.maxItems], [1, 1]);
  assert.deepEqual(oneUrlSchema.properties.citations.items.enum, [evidenceUrls[0]]);
  assert.match(reasoningOutputContract("decision", [evidenceUrls[0]]).join("\n"), /one available exact receipt URL/);

  const noUrlSchema = reasoningResultContract("decision", []);
  assert.deepEqual([noUrlSchema.properties.citations.minItems, noUrlSchema.properties.citations.maxItems], [0, 0]);
  assert.deepEqual([noUrlSchema.properties.strongestEvidence.minItems, noUrlSchema.properties.strongestEvidence.maxItems], [0, 0]);
  assert.match(reasoningOutputContract("decision", []).join("\n"), /No citable evidence URL is available/);

  const oversizedUrl = `https://example.com/${"x".repeat(4_100)}`;
  const boundedSchema = reasoningResultContract("decision", [evidenceUrls[0], oversizedUrl]);
  assert.deepEqual(boundedSchema.properties.citations.items.enum, [evidenceUrls[0]]);
  assert.deepEqual([boundedSchema.properties.citations.minItems, boundedSchema.properties.citations.maxItems], [1, 1]);
});

test("saved synthesis tasks require one direct answer shape without duplicate answer fields", () => {
  for (const task of ["investigate", "challenge", "deep-research"]) {
    const schema = reasoningResultContract(task, evidenceUrls);
    const properties = schema.properties;

    assert.equal(schema.additionalProperties, false, task);
    assert.deepEqual(schema.required, ["schemaVersion", "answerMode", "summary", "confidence", "strongestEvidence", "citations"]);
    assert.equal(properties.schemaVersion.const, "1");
    assert.equal(properties.answerMode.const, "synthesis");
    assert.equal(properties.summary.maxLength, 900);
    assert.match(properties.summary.description, /direct answer and causal spine/i);
    assert.deepEqual([properties.strongestEvidence.minItems, properties.strongestEvidence.maxItems], [1, 4]);
    assert.deepEqual(properties.strongestEvidence.items.required, ["title", "claim", "citationUrl"]);
    assert.deepEqual(properties.strongestEvidence.items.properties.citationUrl.enum, evidenceUrls);
    assert.deepEqual([properties.citations.minItems, properties.citations.maxItems], [1, 4]);
    assert.equal(properties.citations.uniqueItems, true);
    assert.equal(properties.strongestEvidence.items.properties.title.maxLength, 100);
    assert.equal(properties.strongestEvidence.items.properties.claim.maxLength, 600);
    assert.equal(properties.watchFor.maxItems, 2);
    assert.equal(properties.strongestContraryCase.properties.text.maxLength, 600);
    assert.equal(properties.watchFor.items.properties.text.maxLength, 360);
    assert.equal(properties.strongestContraryCase.properties.citationUrls.minItems, 1);
    assert.equal(properties.strongestContraryCase.properties.citationUrls.maxItems, 3);
    assert.equal(properties.watchFor.items.properties.citationUrls.minItems, 1);
    assert.equal(properties.watchFor.items.properties.citationUrls.maxItems, 3);
    assert.equal(schema.required.includes("strongestContraryCase"), false);
    assert.equal(schema.required.includes("watchFor"), false);
    assert.equal(Object.hasOwn(properties, "answer"), false);
    assert.equal(Object.hasOwn(properties, "keyJudgments"), false);
  }
});

test("decision extras are optional instead of forcing an audit checklist", () => {
  const schema = reasoningResultContract("decision", evidenceUrls);
  assert.deepEqual(schema.required, ["recommendation", "confidence", "summary", "options", "strongestEvidence", "citations"]);
  for (const field of ["strongestContraryCase", "evidenceGaps", "reversalTrigger", "reversibleNextSteps", "irreversibleCommitments"]) {
    assert.equal(schema.required.includes(field), false, field);
  }
});

test("investigate prompt asks for information, not a padded research audit", () => {
  const contract = reasoningOutputContract("investigate", evidenceUrls).join("\n");
  assert.match(contract, /direct answer and causal spine/i);
  assert.match(contract, /concrete facts, quantities, dates, and mechanisms/i);
  assert.match(contract, /one to 4 strongest-evidence claims and one to 4 unique citations/i);
  assert.match(contract, /only when it adds a distinct fact or mechanism/i);
  assert.match(contract, /Stop when the question is answered/i);
  assert.match(contract, /do not pad/i);
  assert.doesNotMatch(contract, /important coverage gap|generic recap.*strongest contradiction/i);
});

test("saved synthesis citation bounds shrink to the exact receipt URL set", () => {
  const noUrls = reasoningResultContract("investigate", []);
  assert.deepEqual([noUrls.properties.strongestEvidence.minItems, noUrls.properties.strongestEvidence.maxItems], [0, 0]);
  assert.deepEqual([noUrls.properties.citations.minItems, noUrls.properties.citations.maxItems], [0, 0]);
  assert.deepEqual([
    noUrls.properties.watchFor.items.properties.citationUrls.minItems,
    noUrls.properties.watchFor.items.properties.citationUrls.maxItems,
  ], [0, 0]);

  const oneUrl = reasoningResultContract("challenge", [evidenceUrls[0]]);
  assert.deepEqual([oneUrl.properties.strongestEvidence.minItems, oneUrl.properties.strongestEvidence.maxItems], [1, 1]);
  assert.deepEqual([oneUrl.properties.citations.minItems, oneUrl.properties.citations.maxItems], [1, 1]);
  assert.deepEqual(oneUrl.properties.citations.items.enum, [evidenceUrls[0]]);
});

test("daily briefs and memory updates remain outside saved reasoning result contracts", () => {
  assert.deepEqual(reasoningResultContract("daily-brief", evidenceUrls), {});
  assert.deepEqual(reasoningResultContract("memory-update", evidenceUrls), {});
});
