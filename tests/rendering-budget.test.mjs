import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function driftglassRenderingBudgetLoad(request, parent, isMain) {
  if (request === "cloudflare:workers") {
    return {
      tracing: {
        enterSpan: (_name, operation) => operation({ setAttribute() {} }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  BROWSER_CALL_RESERVATION_MS,
  BROWSER_CALL_TIMEOUT_MS,
  KITESURF_SESSION_RESERVATION_MS,
  captureKitesurfScreenshot,
  renderAdaptive,
} = require("../.test-dist/rendering.js");
const { setOutboundFetchImplementation } = require("../.test-dist/utils.js");
Module._load = originalLoad;

class SqliteD1Statement {
  constructor(owner, query) {
    this.owner = owner;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.owner.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(profile = "cheap", custom) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE usage_daily (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL,
      units REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(day, dimension)
    );
    CREATE TABLE render_profiles (
      hostname TEXT PRIMARY KEY,
      preferred_engine TEXT NOT NULL DEFAULT 'kitesurf',
      kitesurf_successes INTEGER NOT NULL DEFAULT 0,
      kitesurf_failures INTEGER NOT NULL DEFAULT 0,
      kitesurf_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      kitesurf_avg_ms REAL,
      chromium_successes INTEGER NOT NULL DEFAULT 0,
      chromium_failures INTEGER NOT NULL DEFAULT 0,
      chromium_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      chromium_avg_ms REAL,
      last_engine TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE render_attempts (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      hostname TEXT NOT NULL,
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      elapsed_ms INTEGER NOT NULL,
      browser_ms INTEGER,
      content_length INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("budget_profile", profile);
  if (custom !== undefined) {
    database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("budget_custom_limits", JSON.stringify(custom));
  }
  return { database, d1: new SqliteD1(database) };
}

function browserUsage(database) {
  return Number(database.prepare("SELECT units FROM usage_daily WHERE dimension = 'browser_ms'").get()?.units ?? 0);
}

class FakeCdpSocket {
  constructor({ confirmClose = true, emptyContent = false, finalUrl = "https://example.com/" } = {}) {
    this.confirmClose = confirmClose;
    this.emptyContent = emptyContent;
    this.finalUrl = finalUrl;
    this.listeners = new Map();
    this.commands = [];
  }

  accept() {}

  addEventListener(type, listener, options = {}) {
    const wrapped = options?.once
      ? (event) => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...event });
  }

  send(raw) {
    const command = JSON.parse(raw);
    this.commands.push(command.method);
    if (command.method === "Browser.close" && !this.confirmClose) {
      queueMicrotask(() => this.emit("close", { code: 1006 }));
      return;
    }
    let result = {};
    if (command.method === "Target.getTargets") result = { targetInfos: [{ type: "page", targetId: "page-1" }] };
    if (command.method === "Target.attachToTarget") result = { sessionId: "session-1" };
    if (command.method === "Runtime.evaluate") {
      if (command.params?.expression === "document.readyState") {
        result = { result: { value: "complete" } };
      } else if (command.params?.expression === "location.href") {
        result = { result: { value: this.finalUrl } };
      } else {
        result = { result: { value: this.emptyContent
          ? { text: "", html: "", finalUrl: this.finalUrl }
          : { text: "Rendered through Kitesurf", html: "<main>Rendered through Kitesurf</main>", finalUrl: this.finalUrl } } };
      }
    }
    if (command.method === "Page.captureScreenshot") result = { data: "AQID" };
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ id: command.id, result }) });
      if (command.method === "Page.navigate") {
        queueMicrotask(() => this.emit("message", {
          data: JSON.stringify({ method: "Page.loadEventFired", sessionId: command.sessionId, params: {} }),
        }));
      }
    });
  }

  close(code = 1000) {
    queueMicrotask(() => this.emit("close", { code }));
  }
}

test("direct rendering validates each redirect before following it", async () => {
  const state = fixture();
  const calls = [];
  const restore = setOutboundFetchImplementation(async (input, init) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input).toString(), redirect: init?.redirect });
    return new Response(null, {
      status: 302,
      headers: { location: "http://localhost./admin" },
    });
  });
  try {
    await assert.rejects(
      () => renderAdaptive({
        url: new URL("https://example.com/start"),
        env: { DB: state.d1 },
        strategy: "direct",
      }),
      /Private or local network URLs are not allowed/,
    );
  } finally {
    restore();
  }
  assert.deepEqual(calls, [{ url: "https://example.com/start", redirect: "manual" }]);
});

test("direct rendering follows a bounded public redirect", async () => {
  const state = fixture();
  const calls = [];
  const restore = setOutboundFetchImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input).toString();
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://1.1.1.1/final" },
      });
    }
    return new Response("public body", { headers: { "content-type": "text/plain" } });
  });
  try {
    const result = await renderAdaptive({
      url: new URL("https://example.com/start"),
      env: { DB: state.d1 },
      strategy: "direct",
    });
    assert.equal(result.engine, "direct");
    assert.equal(result.finalUrl, "https://1.1.1.1/final");
  } finally {
    restore();
  }
  assert.deepEqual(calls, ["https://example.com/start", "https://1.1.1.1/final"]);
});

test("zero Browser budget defers before acquiring Kitesurf or Chromium", async () => {
  const state = fixture("custom", { browser_ms_day: 0 });
  let browserCalls = 0;
  const browser = {
    async fetch() {
      browserCalls += 1;
      throw new Error("must not acquire Kitesurf");
    },
    async quickAction() {
      browserCalls += 1;
      throw new Error("must not acquire Chromium");
    },
  };

  await assert.rejects(
    () => renderAdaptive({
      url: new URL("https://example.com/"),
      env: { DB: state.d1, BROWSER: browser },
      strategy: "kitesurf",
    }),
    (error) => error?.name === "BudgetDeferredError"
      && error.dimension === "browser_ms"
      && error.requested === KITESURF_SESSION_RESERVATION_MS
      && error.remaining === 0,
  );
  assert.equal(browserCalls, 0);
  assert.equal(browserUsage(state.database), 0);
});

test("Kitesurf deadline aborts the binding request and conservatively retains its maximum reservation", async () => {
  const state = fixture();
  let browserCalls = 0;
  let observedSignal;
  const browser = {
    fetch(_input, init) {
      browserCalls += 1;
      observedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        observedSignal.addEventListener("abort", () => reject(new Error("binding aborted")), { once: true });
      });
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === BROWSER_CALL_TIMEOUT_MS ? 0 : delay,
    ...args,
  );
  try {
    await assert.rejects(
      () => renderAdaptive({
        url: new URL("https://example.com/"),
        env: { DB: state.d1, BROWSER: browser },
        strategy: "kitesurf",
      }),
      /Browser call timed out/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(browserCalls, 1);
  assert.equal(observedSignal.aborted, true);
  assert.equal(browserUsage(state.database), KITESURF_SESSION_RESERVATION_MS);
  const attempt = state.database.prepare(
    "SELECT status, browser_ms, error FROM render_attempts WHERE engine = 'kitesurf'",
  ).get();
  assert.equal(attempt.status, "failed");
  assert.ok(Number(attempt.browser_ms) < KITESURF_SESSION_RESERVATION_MS);
  assert.match(attempt.error, /Browser call timed out/);
});

test("confirmed Kitesurf close settles below the 90-second leak envelope", async () => {
  const state = fixture();
  const socket = new FakeCdpSocket();
  const browser = {
    async fetch() {
      return { status: 101, webSocket: socket };
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 350 ? 0 : delay,
    ...args,
  );
  let result;
  try {
    result = await renderAdaptive({
      url: new URL("https://example.com/"),
      env: { DB: state.d1, BROWSER: browser },
      strategy: "kitesurf",
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(result.engine, "kitesurf");
  assert.ok(socket.commands.includes("Browser.close"));
  assert.ok(browserUsage(state.database) > 0);
  assert.ok(browserUsage(state.database) < KITESURF_SESSION_RESERVATION_MS);
  const metadata = JSON.parse(state.database.prepare("SELECT metadata_json FROM usage_daily").get().metadata_json);
  assert.equal(metadata.reservedUnits, KITESURF_SESSION_RESERVATION_MS);
  assert.equal(metadata.measurementUncertain, false);
});

test("Kitesurf rejects a reported non-public final URL", async () => {
  const state = fixture();
  const socket = new FakeCdpSocket({ finalUrl: "http://localhost./redirected" });
  const browser = {
    async fetch() {
      return { status: 101, webSocket: socket };
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 350 ? 0 : delay,
    ...args,
  );
  try {
    await assert.rejects(
      () => renderAdaptive({
        url: new URL("https://example.com/"),
        env: { DB: state.d1, BROWSER: browser },
        strategy: "kitesurf",
      }),
      /Private or local network URLs are not allowed/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(socket.commands.includes("Page.navigate"));
  assert.ok(socket.commands.includes("Browser.close"));
  assert.equal(state.database.prepare("SELECT status FROM render_attempts").get().status, "failed");
});

test("unconfirmed Kitesurf close retains 90 seconds and suppresses adaptive Chromium fallback", async () => {
  const state = fixture();
  const socket = new FakeCdpSocket({ confirmClose: false, emptyContent: true });
  let chromiumCalls = 0;
  const browser = {
    async fetch() {
      return { status: 101, webSocket: socket };
    },
    async quickAction() {
      chromiumCalls += 1;
      return Response.json({ result: "must not run" });
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 350 ? 0 : delay,
    ...args,
  );
  try {
    await assert.rejects(
      () => renderAdaptive({
        url: new URL("https://example.com/"),
        env: { DB: state.d1, BROWSER: browser },
        strategy: "adaptive",
      }),
      /Adaptive rendering failed/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(chromiumCalls, 0);
  assert.equal(browserUsage(state.database), KITESURF_SESSION_RESERVATION_MS);
  const attempt = state.database.prepare("SELECT status, error FROM render_attempts WHERE engine = 'kitesurf'").get();
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, /no usable page content/);
});

test("Kitesurf screenshots share admission and confirmed-close settlement", async () => {
  const state = fixture();
  const socket = new FakeCdpSocket();
  const browser = {
    async fetch() {
      return { status: 101, webSocket: socket };
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 650 ? 0 : delay,
    ...args,
  );
  let bytes;
  try {
    bytes = await captureKitesurfScreenshot({
      url: new URL("https://example.com/card"),
      env: { DB: state.d1, BROWSER: browser },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.ok(socket.commands.includes("Page.captureScreenshot"));
  assert.ok(socket.commands.includes("Browser.close"));
  assert.ok(browserUsage(state.database) > 0);
  assert.ok(browserUsage(state.database) < KITESURF_SESSION_RESERVATION_MS);
  const attempt = state.database.prepare("SELECT status, content_length FROM render_attempts").get();
  assert.equal(attempt.status, "success");
  assert.equal(attempt.content_length, 3);
});

test("Kitesurf screenshot rejects a delayed non-public redirect before capture", async () => {
  const state = fixture();
  const socket = new FakeCdpSocket();
  const browser = {
    async fetch() {
      return { status: 101, webSocket: socket };
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 650) {
      socket.finalUrl = "http://metadata.google.internal./";
      return originalSetTimeout(callback, 0, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    await assert.rejects(
      () => captureKitesurfScreenshot({
        url: new URL("https://example.com/card"),
        env: { DB: state.d1, BROWSER: browser },
      }),
      /Private or local network URLs are not allowed/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(socket.commands.includes("Page.navigate"));
  assert.equal(socket.commands.includes("Page.captureScreenshot"), false);
  assert.equal(state.database.prepare("SELECT status FROM render_attempts").get().status, "failed");
});

test("Chromium reserves both Quick Actions then settles once to their summed vendor telemetry", async () => {
  const state = fixture();
  const calls = [];
  const browser = {
    async quickAction(action, options) {
      calls.push({ action, options });
      if (action === "links") {
        return Response.json({ success: true, result: ["https://example.com/docs"] }, {
          headers: { "x-browser-ms-used": "123" },
        });
      }
      return Response.json({ success: true, result: "Rendered body" }, {
        headers: { "x-browser-ms-used": "321" },
      });
    },
  };

  const result = await renderAdaptive({
    url: new URL("https://example.com/"),
    env: { DB: state.d1, BROWSER: browser },
    strategy: "chromium",
    includeLinks: true,
  });

  assert.deepEqual(calls.map((call) => call.action), ["markdown", "links"]);
  for (const call of calls) {
    assert.equal(call.options.gotoOptions.timeout, 16_000);
    assert.equal(call.options.actionTimeout, 8_000);
  }
  assert.equal(result.browserMs, 444);
  assert.equal(result.attempts[0].browserMs, 444);
  assert.equal(browserUsage(state.database), 444, "the maximum reservation is reconciled, not charged again");
  const attempt = state.database.prepare(
    "SELECT status, browser_ms FROM render_attempts WHERE engine = 'chromium'",
  ).get();
  assert.equal(attempt.status, "success");
  assert.equal(attempt.browser_ms, 444);
  const usage = state.database.prepare(
    "SELECT units, metadata_json FROM usage_daily WHERE dimension = 'browser_ms'",
  ).get();
  const metadata = JSON.parse(usage.metadata_json);
  assert.equal(metadata.reservedUnits, BROWSER_CALL_RESERVATION_MS * 2);
  assert.equal(metadata.chargedUnits, 444);
  assert.equal(metadata.releasedUnits, (BROWSER_CALL_RESERVATION_MS * 2) - 444);
});

test("vendor telemetry above the declared maximum remains visible while the ledger stays conservatively capped", async () => {
  const state = fixture();
  const browser = {
    async quickAction() {
      return Response.json({ success: true, result: "Rendered body" }, {
        headers: { "x-browser-ms-used": String(BROWSER_CALL_RESERVATION_MS + 777) },
      });
    },
  };

  const result = await renderAdaptive({
    url: new URL("https://example.com/"),
    env: { DB: state.d1, BROWSER: browser },
    strategy: "chromium",
  });

  assert.equal(result.browserMs, BROWSER_CALL_RESERVATION_MS + 777);
  assert.equal(browserUsage(state.database), BROWSER_CALL_RESERVATION_MS);
  const attempt = state.database.prepare("SELECT browser_ms FROM render_attempts").get();
  assert.equal(attempt.browser_ms, BROWSER_CALL_RESERVATION_MS + 777);
  const metadata = JSON.parse(state.database.prepare("SELECT metadata_json FROM usage_daily").get().metadata_json);
  assert.equal(metadata.measurementUncertain, true);
});

test("Chromium body consumption shares the 28-second call deadline and cancels a stalled stream", async () => {
  const state = fixture();
  let canceledWith = "";
  const browser = {
    async quickAction() {
      return new Response(new ReadableStream({
        pull() {
          return new Promise(() => undefined);
        },
        cancel(reason) {
          canceledWith = String(reason ?? "");
        },
      }), {
        headers: {
          "content-type": "application/json",
          "x-browser-ms-used": "9",
        },
      });
    },
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === BROWSER_CALL_TIMEOUT_MS ? 0 : delay,
    ...args,
  );
  try {
    await assert.rejects(
      () => renderAdaptive({
        url: new URL("https://example.com/"),
        env: { DB: state.d1, BROWSER: browser },
        strategy: "chromium",
      }),
      /Browser call timed out/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(canceledWith, "response body read aborted");
  assert.equal(browserUsage(state.database), BROWSER_CALL_RESERVATION_MS);
  const attempt = state.database.prepare("SELECT status, error FROM render_attempts").get();
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, /Browser call timed out/);
});

test("a failed Chromium links call fails the render instead of claiming complete Page Feed coverage", async () => {
  const state = fixture();
  const calls = [];
  const browser = {
    async quickAction(action) {
      calls.push(action);
      if (action === "links") {
        return new Response("unavailable", {
          status: 503,
          headers: { "x-browser-ms-used": "17" },
        });
      }
      return Response.json({ success: true, result: "Rendered body" }, {
        headers: { "x-browser-ms-used": "23" },
      });
    },
  };

  await assert.rejects(
    () => renderAdaptive({
      url: new URL("https://example.com/"),
      env: { DB: state.d1, BROWSER: browser },
      strategy: "chromium",
      includeLinks: true,
    }),
    /Chromium links Quick Action returned 503/,
  );
  assert.deepEqual(calls, ["markdown", "links"]);
  const attempt = state.database.prepare(
    "SELECT status, error FROM render_attempts WHERE engine = 'chromium'",
  ).get();
  assert.equal(attempt.status, "failed");
  assert.match(attempt.error, /links Quick Action returned 503/);
});

test("an empty selector scrape cannot pass raw JSON through as usable page content", async () => {
  const state = fixture();
  const browser = {
    async quickAction() {
      return Response.json({ success: true, result: [{ selector: ".missing", results: [] }] }, {
        headers: { "x-browser-ms-used": "11" },
      });
    },
  };

  await assert.rejects(
    () => renderAdaptive({
      url: new URL("https://example.com/"),
      env: { DB: state.d1, BROWSER: browser },
      strategy: "chromium",
      selector: ".missing",
    }),
    /Chromium Quick Action returned no usable text/,
  );
  assert.equal(browserUsage(state.database), 11);
});
