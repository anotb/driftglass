import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { limitsForProfile } = require("../.test-dist/budget.js");
const {
  deleteEvidenceObjects,
  evidencePutByteLength,
  getEvidenceObject,
  listEvidenceObjects,
  putEmergencyRecoveryObject,
  putEvidenceObject,
  putEvidenceObjects,
} = require("../.test-dist/r2-budget.js");

class SqliteD1Statement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database, query);
  }
}

function budgetDatabase(profile = "free", custom = undefined) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL,
      units REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(day, dimension)
    );
  `);
  database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("budget_profile", profile);
  if (custom) {
    database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("budget_custom_limits", JSON.stringify(custom));
  }
  return { database, d1: new SqliteD1(database) };
}

function recordingEnv(database, { getResult = null, putError, putErrorAt, listResult = { objects: [], truncated: false } } = {}) {
  const calls = { deletes: [], gets: [], lists: [], puts: [] };
  return {
    calls,
    env: {
      DB: database.d1,
      EVIDENCE: {
        async delete(keys) { calls.deletes.push(keys); },
        async get(key) {
          calls.gets.push(key);
          return getResult;
        },
        async put(key, value, options) {
          calls.puts.push({ key, value, options });
          if (putError || calls.puts.length === putErrorAt) throw putError ?? new Error("partial R2 failure");
          return { key };
        },
        async list(options) {
          calls.lists.push(options);
          return listResult;
        },
      },
    },
  };
}

function usage(database) {
  return Object.fromEntries(
    database.prepare("SELECT dimension, units FROM usage_daily ORDER BY dimension").all()
      .map((row) => [row.dimension, Number(row.units)]),
  );
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(url));
    else if (entry.name.endsWith(".ts")) files.push(url);
  }
  return files;
}

test("Free and Cheap R2 lanes retain headroom beneath the same account-wide monthly allowance", () => {
  const free = limitsForProfile("free");
  const cheap = limitsForProfile("cheap");

  assert.equal(free.r2_class_a_ops_day, 10_000);
  assert.equal(free.r2_class_b_ops_day, 50_000);
  assert.equal(free.r2_write_bytes_day, 100 * 1024 * 1024);
  assert.equal(cheap.r2_class_a_ops_day, 20_000);
  assert.equal(cheap.r2_class_b_ops_day, 200_000);
  assert.equal(cheap.r2_write_bytes_day, 200 * 1024 * 1024);

  assert.ok(cheap.r2_class_a_ops_day * 31 <= 620_000);
  assert.ok(cheap.r2_class_b_ops_day * 31 <= 6_200_000);
  assert.ok(cheap.r2_write_bytes_day * 31 < 10 * 1024 * 1024 * 1024);
  assert.equal(
    limitsForProfile("custom", { r2_write_bytes_day: "not-a-number" }).r2_write_bytes_day,
    free.r2_write_bytes_day,
    "invalid custom values fail back to the bounded Free lane",
  );
});

test("budgeted puts reserve exact UTF-8 bytes and Class A before touching R2", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database);

  await putEvidenceObject(fixture.env, "raw/fixture.txt", "A😀");

  assert.equal(evidencePutByteLength("A😀"), 5);
  assert.equal(evidencePutByteLength(new Uint8Array([1, 2, 3])), 3);
  assert.equal(evidencePutByteLength(new Blob(["four"])), 4);
  assert.deepEqual(usage(database.database), { r2_class_a_ops: 1, r2_write_bytes: 5 });
  assert.equal(fixture.calls.puts.length, 1);
});

test("batch puts aggregate exact bytes and Class A count into two conservative reservations", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database);
  await putEvidenceObjects(fixture.env, [
    { key: "raw/a.txt", value: "A😀" },
    { key: "raw/b.txt", value: new Uint8Array([1, 2, 3]) },
    { key: "raw/c.txt", value: "four" },
  ]);
  assert.deepEqual(usage(database.database), { r2_class_a_ops: 3, r2_write_bytes: 12 });
  assert.equal(fixture.calls.puts.length, 3);
});

test("a partial batch-put failure removes every unique candidate key and keeps reservations", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database, { putErrorAt: 2 });
  const requests = [
    { key: "raw/partial-a.txt", value: "alpha" },
    { key: "raw/partial-b.txt", value: "beta" },
    { key: "raw/partial-c.txt", value: "gamma" },
  ];
  await assert.rejects(putEvidenceObjects(fixture.env, requests), /partial R2 failure/);
  assert.deepEqual(fixture.calls.deletes, [requests.map((request) => request.key)]);
  assert.deepEqual(usage(database.database), { r2_class_a_ops: 3, r2_write_bytes: 14 });
  assert.equal(fixture.calls.puts.length, 2);
});

test("an oversized first write is typed-deferred without an R2 mutation", async () => {
  const database = budgetDatabase("custom", { r2_write_bytes_day: 4, r2_class_a_ops_day: 10 });
  const fixture = recordingEnv(database);

  await assert.rejects(
    putEvidenceObject(fixture.env, "raw/too-large.txt", "12345"),
    (error) => error?.name === "BudgetDeferredError"
      && error.dimension === "r2_write_bytes"
      && error.requested === 5
      && error.remaining === 4,
  );

  assert.equal(fixture.calls.puts.length, 0);
  assert.deepEqual(usage(database.database), {});
});

test("budgeted gets count misses and stop before R2 when the Class B lane is full", async () => {
  const database = budgetDatabase("custom", { r2_class_b_ops_day: 1 });
  const fixture = recordingEnv(database);

  assert.equal(await getEvidenceObject(fixture.env, "public-shares/missing.png"), null);
  await assert.rejects(
    getEvidenceObject(fixture.env, "public-shares/still-missing.png"),
    (error) => error?.name === "BudgetDeferredError" && error.dimension === "r2_class_b_ops",
  );

  assert.equal(fixture.calls.gets.length, 1);
  assert.deepEqual(usage(database.database), { r2_class_b_ops: 1 });
});

test("R2 list reserves Class A while deletion remains free", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database);
  await listEvidenceObjects(fixture.env, { prefix: "recovery/ingest-quarantine/", limit: 1 });
  await deleteEvidenceObjects(fixture.env, "recovery/ingest-quarantine/dead.json");
  assert.equal(fixture.calls.lists.length, 1);
  assert.deepEqual(fixture.calls.deletes, ["recovery/ingest-quarantine/dead.json"]);
  assert.deepEqual(usage(database.database), { r2_class_a_ops: 1 });
});

test("D1-unavailable emergency writes are prefix, size, and idempotency bounded", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database);
  const digest = "a".repeat(64);
  const key = `recovery/ingest-quarantine/${digest}.json`;
  assert.equal(await putEmergencyRecoveryObject(fixture.env, key, '{"ok":true}'), "stored");
  assert.deepEqual(fixture.calls.puts[0].options.onlyIf, { etagDoesNotMatch: "*" });
  assert.deepEqual(usage(database.database), {}, "emergency write cannot reserve through unavailable D1");
  await assert.rejects(
    putEmergencyRecoveryObject(fixture.env, `raw/${digest}.json`, "{}"),
    /restricted to deterministic quarantine incident keys/,
  );
  await assert.rejects(
    putEmergencyRecoveryObject(fixture.env, key, "x".repeat(60_001)),
    /between 1 and 60000 bytes/,
  );
});

test("unknown-length streams are rejected before reservation or upload", async () => {
  const database = budgetDatabase();
  const fixture = recordingEnv(database);

  await assert.rejects(
    putEvidenceObject(fixture.env, "raw/stream.txt", new ReadableStream()),
    /streams must be bounded before upload/,
  );
  assert.equal(fixture.calls.puts.length, 0);
  assert.deepEqual(usage(database.database), {});
});

test("every core EVIDENCE put/get goes through the budget boundary", async () => {
  const files = await sourceFiles(new URL("../src/", import.meta.url));
  const bypasses = [];
  for (const file of files) {
    if (file.pathname.endsWith("/r2-budget.ts")) continue;
    const source = await readFile(file, "utf8");
    if (/\.EVIDENCE\s*\.\s*(?:put|get)\s*\(/.test(source)) bypasses.push(file.pathname);
  }
  assert.deepEqual(bypasses, []);

  const shares = await readFile(new URL("../src/shares.ts", import.meta.url), "utf8");
  assert.match(shares, /const cached = await getEvidenceObject\(env, key\)/);
  assert.match(shares, /catch \{\s*return applyShareHeaders/s, "public OG exhaustion falls back to a public static image");
});

test("the dashboard presents evidence-storage usage with binary byte formatting", async () => {
  const [app, page] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(app, /r2_class_a_ops: "R2 write operations"/);
  assert.match(app, /r2_class_b_ops: "R2 read operations"/);
  assert.match(app, /r2_write_bytes: "R2 storage"/);
  assert.match(app, /dimension === "r2_write_bytes"[\s\S]+MiB/);
  assert.match(page, /Keep costs predictable/);
});
