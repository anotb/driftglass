import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  budgetStatus,
  getBudgetProfile,
  limitsForProfile,
  reserve,
  reserveMonthly,
} = require("../.test-dist/budget.js");

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

function fixture(profile, { custom, executionCapacity } = {}) {
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
  if (executionCapacity) {
    database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("execution_capacity", executionCapacity);
  }
  return { database, d1: new SqliteD1(database) };
}

function usage(database, dimension) {
  return Number(database.prepare("SELECT SUM(units) AS units FROM usage_daily WHERE dimension = ?").get(dimension)?.units ?? 0);
}

test("an unconfirmed Cheap plan enforces Free daily and monthly Worker limits atomically", async () => {
  const state = fixture("cheap");
  const free = limitsForProfile("free");
  const cheap = limitsForProfile("cheap");
  const profile = await getBudgetProfile(state.d1);

  assert.equal(profile.profile, "cheap");
  assert.equal(profile.executionCapacity, "free-safe");
  assert.equal(profile.limits.source_runs_day, cheap.source_runs_day, "the selected plan remains visible");
  assert.deepEqual(profile.plannedLimits, profile.limits);
  assert.equal(profile.effectiveLimits.source_runs_day, free.source_runs_day);
  assert.equal(profile.effectiveLimits.ai_search_queries_month, free.ai_search_queries_month);
  assert.equal(profile.effectiveLimits.r2_class_a_ops_day, cheap.r2_class_a_ops_day, "R2 keeps its independent selected limit");

  const daily = await reserve(state.d1, "source_runs", free.source_runs_day, { test: "daily-cap" });
  const dailyOverflow = await reserve(state.d1, "source_runs", 1, { test: "daily-overflow" });
  assert.equal(daily.allowed, true);
  assert.equal(dailyOverflow.allowed, false);
  assert.equal(dailyOverflow.remaining, 0);
  assert.equal(usage(state.database, "source_runs"), free.source_runs_day, "a denied reservation adds no usage");

  const monthly = await reserveMonthly(state.d1, "ai_search_queries", free.ai_search_queries_month, { test: "monthly-cap" });
  const monthlyOverflow = await reserveMonthly(state.d1, "ai_search_queries", 1, { test: "monthly-overflow" });
  assert.equal(monthly.allowed, true);
  assert.equal(monthlyOverflow.allowed, false);
  assert.equal(monthlyOverflow.remaining, 0);
  assert.equal(usage(state.database, "ai_search_queries"), free.ai_search_queries_month, "monthly denial is also non-mutating");

  const r2 = await reserve(state.d1, "r2_class_a_ops", cheap.r2_class_a_ops_day, { test: "independent-r2-cap" });
  const r2Overflow = await reserve(state.d1, "r2_class_a_ops", 1, { test: "independent-r2-overflow" });
  assert.equal(r2.allowed, true);
  assert.equal(r2Overflow.allowed, false);
  assert.equal(usage(state.database, "r2_class_a_ops"), cheap.r2_class_a_ops_day);

  const status = await budgetStatus(state.d1);
  assert.deepEqual(status.limits, status.effectiveLimits);
  assert.equal(status.limits.source_runs_day, free.source_runs_day);
  assert.equal(status.plannedLimits.source_runs_day, cheap.source_runs_day);
  assert.equal(status.limits.r2_class_a_ops_day, cheap.r2_class_a_ops_day);
});

test("an unconfirmed custom plan is Free-capped without raising lower custom limits", async () => {
  const state = fixture("custom", {
    custom: {
      source_runs_day: 50_000,
      ai_search_queries_month: 500_000,
      memory_writes_day: 3,
      r2_class_a_ops_day: 12_345,
      r2_write_bytes_day: 7_654_321,
    },
  });
  const free = limitsForProfile("free");
  const profile = await getBudgetProfile(state.d1);

  assert.equal(profile.limits.source_runs_day, 50_000);
  assert.equal(profile.effectiveLimits.source_runs_day, free.source_runs_day);
  assert.equal(profile.effectiveLimits.ai_search_queries_month, free.ai_search_queries_month);
  assert.equal(profile.effectiveLimits.memory_writes_day, 3);
  assert.equal(profile.effectiveLimits.r2_class_a_ops_day, 12_345);
  assert.equal(profile.effectiveLimits.r2_write_bytes_day, 7_654_321);
});

test("exact expanded confirmation activates the selected Cheap limits", async () => {
  const state = fixture("cheap", { executionCapacity: "expanded-confirmed" });
  const cheap = limitsForProfile("cheap");
  const status = await budgetStatus(state.d1);

  assert.equal(status.executionCapacity, "expanded-confirmed");
  assert.deepEqual(status.effectiveLimits, cheap);
  assert.deepEqual(status.plannedLimits, cheap);

  assert.equal((await reserve(state.d1, "source_runs", cheap.source_runs_day)).allowed, true);
  assert.equal((await reserveMonthly(state.d1, "ai_search_queries", cheap.ai_search_queries_month)).allowed, true);
  assert.equal(usage(state.database, "source_runs"), cheap.source_runs_day);
  assert.equal(usage(state.database, "ai_search_queries"), cheap.ai_search_queries_month);
});

test("zero effective limits stay blocked and surface as degraded", async () => {
  const state = fixture("custom", {
    custom: {
      browser_ms_day: 0,
      ai_search_queries_month: 0,
      memory_writes_day: 10,
    },
  });

  const status = await budgetStatus(state.d1);
  assert.equal(status.remaining.browser_ms, 0);
  assert.equal(status.remaining.ai_search_queries, 0);
  assert.equal(status.utilization.browser_ms, 1);
  assert.equal(status.utilization.ai_search_queries, 1);
  assert.equal(status.degraded.includes("browser_ms"), true);
  assert.equal(status.degraded.includes("ai_search_queries"), true);
  assert.equal(status.degraded.includes("memory_writes"), false, "positive unused limits retain their prior status");

  assert.equal((await reserve(state.d1, "browser_ms", 1)).allowed, false);
  assert.equal((await reserveMonthly(state.d1, "ai_search_queries", 1)).allowed, false);
  assert.equal(usage(state.database, "browser_ms"), 0);
  assert.equal(usage(state.database, "ai_search_queries"), 0);
});
