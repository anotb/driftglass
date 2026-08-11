import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  effectiveIntelligencePack,
  reconcileEffectiveIntelligencePack,
} = require("../.test-dist/pack-overlays.js");

function overlayRecord() {
  return {
    id: "overlay-one",
    base_pack_id: "pack-one",
    name: "Owner additions",
    description: "Local terms",
    base_version: "1.0.0",
    overlay_json: JSON.stringify({ addInterestTerms: ["read contract"] }),
    status: "active",
    conflicts_json: "[]",
    created_at: "2026-08-07T00:00:00.000Z",
    updated_at: "2026-08-07T00:00:00.000Z",
  };
}

class OverlayStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
  }

  bind() {
    return this;
  }

  async all() {
    this.database.calls.push({ kind: "all", query: this.query });
    return { success: true, results: [overlayRecord()], meta: {} };
  }

  async run() {
    this.database.calls.push({ kind: "run", query: this.query });
    return { success: true, results: [], meta: { changes: 1 } };
  }
}

function database() {
  return {
    calls: [],
    prepare(query) {
      return new OverlayStatement(this, query);
    },
  };
}

const pack = {
  driftglassPack: "3",
  id: "pack-one",
  name: "Pack one",
  version: "2.0.0",
  description: "Test pack",
  cloudSources: [],
  missions: [],
  interestTerms: [],
};

test("effective Pack reads apply overlays in memory without reconciliation writes", async () => {
  const db = database();
  const result = await effectiveIntelligencePack({ DB: db }, pack);
  assert.deepEqual(result.pack.interestTerms, ["read contract"]);
  assert.equal(result.overlays.length, 1);
  assert.ok(db.calls.every((call) => call.kind !== "run"));
});

test("explicit Pack update reconciliation persists overlay status", async () => {
  const db = database();
  const result = await reconcileEffectiveIntelligencePack({ DB: db }, pack);
  assert.deepEqual(result.pack.interestTerms, ["read contract"]);
  assert.ok(db.calls.some((call) => call.kind === "run" && /intelligence_pack_overlays/.test(call.query)));
});
