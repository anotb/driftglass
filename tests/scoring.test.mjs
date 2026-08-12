import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  canonicalKey,
  importanceFromMetadata,
  jaccard,
  relevanceFromTerms,
  storyScore,
  tokenize,
} = require("../.test-dist/scoring.js");
const { canonicalizeUrl, stableStringify, readBoundedResponseText, readJson, HttpError } = require("../.test-dist/utils.js");

test("tokenize removes noise while preserving meaningful terms", () => {
  assert.deepEqual(tokenize("The NEW Cloudflare Agents launch for browser automation"), [
    "cloudflare",
    "agents",
    "launch",
    "browser",
    "automation",
  ]);
});

test("canonical story keys are stable across title word order", () => {
  const left = canonicalKey("Cloudflare launches new agent browser", "https://www.cloudflare.com/blog/post?utm_source=x");
  const right = canonicalKey("New browser agent launches at Cloudflare", "https://cloudflare.com/blog/post");
  assert.equal(left, right);
});

test("jaccard separates near-duplicates from unrelated stories", () => {
  assert.ok(jaccard("Cloudflare launches agent browser runtime", "Agent browser runtime launched by Cloudflare") > 0.7);
  assert.ok(jaccard("Cloudflare launches agent browser runtime", "Massachusetts weekend beach tide forecast") < 0.2);
});

test("relevance grows with explicit interest matches", () => {
  const terms = ["Cloudflare", "coding agents", "data centers"];
  assert.ok(relevanceFromTerms("Cloudflare adds new tools for coding agents", terms) > relevanceFromTerms("A restaurant changed its menu", terms));
});

test("importance uses evidence metadata without exceeding one", () => {
  assert.ok(importanceFromMetadata({ platform: "github", score: 500, comments: 100, views: 1_000_000 }) <= 1);
  assert.ok(importanceFromMetadata({ platform: "github", score: 500 }) > importanceFromMetadata({}));
});

test("story scoring rewards relevance and corroboration", () => {
  const base = storyScore({ relevance: 0.4, novelty: 0.7, importance: 0.5, confidence: 0.6, sourceCount: 1, sourceWeight: 1, ageHours: 3 });
  const strong = storyScore({ relevance: 0.9, novelty: 0.7, importance: 0.8, confidence: 0.9, sourceCount: 4, sourceWeight: 1.4, ageHours: 3 });
  assert.ok(strong > base);
  assert.ok(strong <= 100);
});

test("URL canonicalization removes tracking and normalizes the host", () => {
  assert.equal(
    canonicalizeUrl("https://www.Example.com/a/?utm_source=x&ref=feed&id=7#section"),
    "https://example.com/a?id=7",
  );
});

test("stableStringify sorts object keys recursively", () => {
  assert.equal(stableStringify({ b: 2, a: { z: 3, y: 1 } }), '{"a":{"y":1,"z":3},"b":2}');
});


test("readJson enforces the byte limit even without Content-Length", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ value: "x".repeat(128) })));
      controller.close();
    },
  });
  const request = new Request("https://example.com/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  });
  await assert.rejects(() => readJson(request, 32), (error) => error instanceof HttpError && error.status === 413);
});

test("readJson parses a bounded JSON stream", async () => {
  const request = new Request("https://example.com/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readJson(request, 64), { ok: true });
});

test("bounded upstream response reads cancel a chunked body at the real byte limit", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20));
      controller.enqueue(new Uint8Array(20));
    },
    cancel() {
      cancelled = true;
    },
  }));
  await assert.rejects(
    () => readBoundedResponseText(response, 32, "package metadata exceeds its bound"),
    /package metadata exceeds its bound/,
  );
  assert.equal(cancelled, true);
});

const { tasteAdjustedRelevance } = require("../.test-dist/taste.js");

test("Taste Profile compounds explicit feedback into future relevance", () => {
  const learned = [
    { term: "kitesurf", weight: 1.4, positive_count: 3, negative_count: 0, last_story_id: null, updated_at: "" },
    { term: "celebrity gossip", weight: -1.2, positive_count: 0, negative_count: 2, last_story_id: null, updated_at: "" },
  ];
  const positive = tasteAdjustedRelevance("Cloudflare Kitesurf agent browser launch", ["cloudflare"], learned);
  const neutral = tasteAdjustedRelevance("Cloudflare quarterly office update", ["cloudflare"], learned);
  const negative = tasteAdjustedRelevance("Celebrity gossip dominates weekend coverage", [], learned);
  assert.ok(positive.value > neutral.value);
  assert.ok(negative.value < 0.5);
  assert.equal(positive.matchedPositive[0].term, "kitesurf");
});
