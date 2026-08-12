import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { memoryNeighborhood } = require("../.test-dist/memory-graph.js");

class ReadOnlyStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
  }

  bind() {
    return this;
  }

  async first() {
    this.database.calls.push({ kind: "first", query: this.query });
    return null;
  }

  async all() {
    this.database.calls.push({ kind: "all", query: this.query });
    return { success: true, results: [], meta: {} };
  }

  async run() {
    assert.fail(`memory read attempted a database write: ${this.query}`);
  }
}

test("typed references return an empty neighborhood without materializing a canonical node", async () => {
  const database = {
    calls: [],
    prepare(query) {
      return new ReadOnlyStatement(this, query);
    },
  };

  const result = await memoryNeighborhood({ DB: database }, { ref: "mission:not-materialized", limit: 20 });

  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.equal(result.stats.nodes, 0);
  assert.ok(database.calls.some((call) => /canonical_key/.test(call.query)));
  assert.ok(database.calls.every((call) => call.kind !== "run"));
});

test("reasoning compilation has no implicit Memory Graph maintenance hook", async () => {
  const source = await readFile(new URL("../src/reasoning.ts", import.meta.url), "utf8");
  const compiler = source.slice(source.indexOf("export async function buildReasoningBundle"));
  assert.doesNotMatch(compiler, /refreshEpistemicMemoryIfDue|MEMORY_WORKFLOW|refreshEpistemicMemory/);
});
