import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  BROWSER_ADMISSION_MAX_WAIT_MS,
  BrowserAdmissionDeferredError,
  CHEAP_BROWSER_QUICK_ACTION_INTERVAL_MS,
  CHEAP_BROWSER_SESSION_INTERVAL_MS,
  FREE_BROWSER_QUICK_ACTION_INTERVAL_MS,
  FREE_BROWSER_SESSION_INTERVAL_MS,
  browserAdmissionInterval,
  claimBrowserAdmission,
} = require("../.test-dist/browser-admission.js");

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

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
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

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT
    );
  `);
  return { database, d1: new SqliteD1(database) };
}

test("browser admission intervals expand only after explicit confirmation", () => {
  assert.equal(browserAdmissionInterval("session", "free-safe"), FREE_BROWSER_SESSION_INTERVAL_MS);
  assert.equal(browserAdmissionInterval("session", "cheap"), FREE_BROWSER_SESSION_INTERVAL_MS, "an old profile value fails closed");
  assert.equal(browserAdmissionInterval("session", "expanded-confirmed"), CHEAP_BROWSER_SESSION_INTERVAL_MS);
  assert.equal(browserAdmissionInterval("quick-action", "free-safe"), FREE_BROWSER_QUICK_ACTION_INTERVAL_MS);
  assert.equal(browserAdmissionInterval("quick-action", "expanded-confirmed"), CHEAP_BROWSER_QUICK_ACTION_INTERVAL_MS);
  assert.equal(FREE_BROWSER_SESSION_INTERVAL_MS, 30_000);
  assert.equal(CHEAP_BROWSER_SESSION_INTERVAL_MS, 9_000);
  assert.equal(FREE_BROWSER_QUICK_ACTION_INTERVAL_MS, 10_000);
  assert.equal(CHEAP_BROWSER_QUICK_ACTION_INTERVAL_MS, 100);
});

test("concurrent Free-safe session claims receive ordered slots and fail beyond the bounded wait", async () => {
  const state = fixture();
  const nowMs = Date.UTC(2026, 7, 8, 5, 0, 0);
  const settled = await Promise.allSettled([
    claimBrowserAdmission(state.d1, "session", "free-safe", { nowMs }),
    claimBrowserAdmission(state.d1, "session", "free-safe", { nowMs }),
    claimBrowserAdmission(state.d1, "session", "free-safe", { nowMs }),
  ]);

  const claims = settled
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value)
    .sort((left, right) => left.scheduledAtMs - right.scheduledAtMs);
  assert.deepEqual(claims.map((claim) => claim.waitMs), [0, 30_000]);
  const rejection = settled.find((entry) => entry.status === "rejected")?.reason;
  assert.ok(rejection instanceof BrowserAdmissionDeferredError);
  assert.equal(rejection.status, 429);
  assert.equal(rejection.details.code, "BROWSER_ADMISSION_BUSY");
  assert.equal(rejection.kind, "session");

  const next = await claimBrowserAdmission(state.d1, "session", "free-safe", { nowMs: nowMs + 30_000 });
  assert.equal(next.waitMs, 30_000);
});

test("Quick Action and session schedules are independent and capacity-specific", async () => {
  const state = fixture();
  const nowMs = Date.UTC(2026, 7, 8, 6, 0, 0);
  const freeQuick = await Promise.all([
    claimBrowserAdmission(state.d1, "quick-action", "free-safe", { nowMs }),
    claimBrowserAdmission(state.d1, "quick-action", "free-safe", { nowMs }),
  ]);
  assert.deepEqual(freeQuick.map((claim) => claim.waitMs), [0, 10_000]);

  const expandedSession = await claimBrowserAdmission(state.d1, "session", "expanded-confirmed", { nowMs });
  assert.equal(expandedSession.waitMs, 0);
  assert.equal(expandedSession.intervalMs, 9_000);
});

test("corrupt or excessively future scheduler state fails closed without replacement", async () => {
  const nowMs = Date.UTC(2026, 7, 8, 7, 0, 0);
  for (const value of ["12junk", "", String(nowMs + BROWSER_ADMISSION_MAX_WAIT_MS + 1)]) {
    const state = fixture();
    state.database.prepare(
      "INSERT INTO settings(key, value) VALUES ('browser_admission_next_session_ms', ?)",
    ).run(value);
    await assert.rejects(
      () => claimBrowserAdmission(state.d1, "session", "free-safe", { nowMs }),
      (error) => error instanceof BrowserAdmissionDeferredError && error.status === 429,
    );
    assert.equal(
      state.database.prepare("SELECT value FROM settings WHERE key = 'browser_admission_next_session_ms'").get().value,
      value,
    );
  }
});
