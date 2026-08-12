import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalogSourceDefinition,
  catalogEntriesFromCollectors,
  normalizeAdapterParams,
} from "../.test-dist/catalog.js";

const collectors = [
  {
    id: "companion-windows",
    name: "Desk PC",
    status: "offline",
    version: "0.9.0",
    last_seen_at: "2026-08-07T10:00:00.000Z",
    details_json: JSON.stringify({
      platform: "win32",
      architecture: "x64",
      catalog: [{
        site: "twitter",
        command: "timeline",
        description: "Read the live X home timeline",
        strategy: "cookie",
        browser: true,
        args: [
          { name: "type", type: "str", choices: ["for-you", "following"], default: "for-you" },
          { name: "limit", type: "int", default: 20 },
          { name: "include-media", type: "bool" },
        ],
      }],
    }),
  },
  {
    id: "companion-mac",
    name: "Primary Companion",
    status: "online",
    version: "0.9.0",
    last_seen_at: "2026-08-07T10:05:00.000Z",
    details_json: JSON.stringify({
      platform: "darwin",
      architecture: "arm64",
      catalog: [{
        site: "twitter",
        command: "timeline",
        description: "Read the live X home timeline",
        strategy: "cookie",
        browser: true,
        args: [
          { name: "type", type: "str", choices: ["for-you", "following"], default: "for-you" },
          { name: "limit", type: "int", default: 20 },
          { name: "include-media", type: "bool" },
        ],
      }],
    }),
  },
];

test("catalog groups identical live adapters and prefers an online Companion", () => {
  const catalog = catalogEntriesFromCollectors(collectors);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].collectorId, "companion-mac");
  assert.equal(catalog[0].collectors.length, 2);
  assert.equal(catalog[0].args[0].choices[0], "for-you");
});

test("manifest arguments are normalized by their live schema", () => {
  const entry = catalogEntriesFromCollectors(collectors)[0];
  assert.deepEqual(normalizeAdapterParams(entry, {
    type: "following",
    limit: "35",
    "include-media": "true",
  }), {
    type: "following",
    limit: 35,
    "include-media": true,
  });
  assert.throws(() => normalizeAdapterParams(entry, { type: "random" }), /must be one of/);
  assert.throws(() => normalizeAdapterParams(entry, { surprise: "nope" }), /Unknown argument/);
});

test("catalog source definitions pin jobs to the Companion that advertised the adapter", () => {
  const built = buildCatalogSourceDefinition(collectors, {
    id: "x-for-you",
    collectorId: "companion-mac",
    site: "twitter",
    command: "timeline",
    params: { type: "for-you", limit: "50" },
    runNow: true,
  });
  assert.equal(built.source.id, "x-for-you");
  assert.equal(built.source.kind, "collector");
  assert.equal(built.source.config.collectorId, "companion-mac");
  assert.deepEqual(built.source.config.args, {
    site: "twitter",
    command: "timeline",
    params: { type: "for-you", limit: 50 },
  });
  assert.equal(built.runNow, true);
});
