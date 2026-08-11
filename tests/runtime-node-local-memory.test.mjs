import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const nodeMinor = Number(process.versions.node.split(".")[1] ?? 0);
const node24 = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 4) ? test : test.skip;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "migrations");
const compiledRoot = process.env.DRIFTGLASS_TEST_DIST || join(repositoryRoot, ".test-dist");
const cleanupRoots = [];

after(() => {
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
});

function loadLocalMemoryRefresher() {
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "cloudflare:workers") {
        return {
          WorkflowEntrypoint: class WorkflowEntrypoint {},
          tracing: { trace: (_name, operation) => operation },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    return require(join(compiledRoot, "runtime/node/local-memory.js")).LocalMemoryRefresher;
  } finally {
    Module._load = originalLoad;
  }
}

node24("local memory refresh keeps connected recall across a restart", async () => {
  const { NodeSQLiteDatabase } = require(join(compiledRoot, "runtime/node/database.js"));
  const { runLocalMigrations } = require(join(compiledRoot, "runtime/node/migrations.js"));
  const { memoryNeighborhood } = require(join(compiledRoot, "memory-graph.js"));
  const LocalMemoryRefresher = loadLocalMemoryRefresher();
  const root = mkdtempSync(join(realpathSync(tmpdir()), "driftglass-local-memory-"));
  cleanupRoots.push(root);
  const databasePath = join(root, "driftglass.sqlite3");
  let database = new NodeSQLiteDatabase(databasePath);
  await runLocalMigrations(database, migrationsDirectory);

  const now = new Date().toISOString();
  await database.batch([
    database.prepare(
      `INSERT INTO sources(
         id, name, kind, config_json, enabled, schedule_minutes, weight,
         last_run_at, last_success_at, last_error, health_score, created_at, updated_at
       ) VALUES (?, ?, 'manual', '{}', 1, 10080, 1, NULL, NULL, NULL, 1, ?, ?)`,
    ).bind("local-memory-source", "Manual inbox", now, now),
    database.prepare(
      `INSERT INTO items(
         id, source_id, external_id, url, canonical_url, title, text,
         observed_at, content_hash, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(
      "local-memory-item",
      "local-memory-source",
      "local-memory-item",
      "https://example.com/local-memory-marker",
      "https://example.com/local-memory-marker",
      "Portable memory restart marker",
      "A saved Story should remain connected to its claim and source after restart.",
      now,
      "local-memory-content-hash",
    ),
    database.prepare(
      `INSERT INTO stories(
         id, canonical_key, title, summary, first_seen_at, last_changed_at,
         score, relevance, novelty, importance, confidence, source_count, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, 10, 1, 1, 1, 1, 1, '{}')`,
    ).bind(
      "local-memory-story",
      "local-memory-story",
      "Portable memory restart marker",
      "A saved Story should remain connected to its claim and source after restart.",
      now,
      now,
    ),
    database.prepare("INSERT INTO story_items(story_id, item_id) VALUES (?, ?)")
      .bind("local-memory-story", "local-memory-item"),
    database.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('memory_graph_dirty', '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(now),
  ]);

  let env = { DB: database };
  const firstProcess = new LocalMemoryRefresher(() => env, { pollMs: 100 });
  assert.deepEqual(await firstProcess.initialize(), { recoveredInterruptedRefresh: false });
  assert.deepEqual(await firstProcess.tick(), { due: true, status: "complete" });
  await firstProcess.close();

  const beforeRestart = await memoryNeighborhood(env, { query: "Portable memory restart marker", limit: 20 });
  assert.ok(beforeRestart.nodes.some((node) => node.node_type === "story"));
  assert.ok(beforeRestart.nodes.some((node) => node.node_type === "claim"));
  assert.ok(beforeRestart.nodes.some((node) => node.node_type === "source"));
  assert.deepEqual(
    [...new Set(beforeRestart.edges.map((edge) => edge.relation))].sort(),
    ["derived_from", "evidence_for", "observed_in"],
  );
  const runId = await database.prepare(
    "SELECT id FROM memory_graph_runs ORDER BY started_at DESC LIMIT 1",
  ).first("id");
  database.close();

  database = new NodeSQLiteDatabase(databasePath);
  env = { DB: database };
  const restartedProcess = new LocalMemoryRefresher(() => env, { pollMs: 100 });
  assert.deepEqual(await restartedProcess.initialize(), { recoveredInterruptedRefresh: false });
  assert.deepEqual(await restartedProcess.tick(), { due: false });
  const afterRestart = await memoryNeighborhood(env, { query: "Portable memory restart marker", limit: 20 });
  assert.deepEqual(
    afterRestart.nodes.map((node) => node.id).sort(),
    beforeRestart.nodes.map((node) => node.id).sort(),
  );
  assert.equal(
    await database.prepare("SELECT id FROM memory_graph_runs ORDER BY started_at DESC LIMIT 1").first("id"),
    runId,
  );
  await restartedProcess.close();
  database.close();
});
