import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

async function dashboardHarness({ fetchImpl = async () => new Response("{}"), confirmImpl = () => true } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (elements.has(selector)) return elements.get(selector);
    const fields = new Map();
    const node = {
      className: "",
      dataset: {},
      disabled: false,
      hidden: false,
      href: "",
      innerHTML: "",
      open: false,
      style: {},
      textContent: "",
      value: "",
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {},
      closest() { return null; },
      querySelector(nested) { return element(`${selector} ${nested}`); },
      querySelectorAll() { return []; },
      reset() {},
      showModal() { this.open = true; },
    };
    node.elements = new Proxy({}, {
      get(_target, name) {
        if (!fields.has(name)) fields.set(name, element(`${selector} [name=${String(name)}]`));
        return fields.get(name);
      },
    });
    elements.set(selector, node);
    return node;
  };
  const location = {
    hash: "",
    href: "https://driftglass.example/",
    origin: "https://driftglass.example",
    pathname: "/",
    reload() {},
    search: "",
  };
  const context = {
    Blob,
    FormData,
    Headers,
    Intl,
    Response,
    URL,
    URLSearchParams,
    clearTimeout() {},
    console,
    document: {
      addEventListener() {},
      getElementById: (id) => element(`#${id}`),
      querySelector: (selector) => element(selector),
      querySelectorAll: () => [],
    },
    fetch: fetchImpl,
    history: { replaceState() {} },
    location,
    navigator: { clipboard: { writeText: async () => {} }, platform: "MacIntel" },
    sessionStorage: { getItem: () => "", removeItem() {}, setItem() {} },
    setTimeout: () => 1,
    addEventListener() {},
  };
  context.window = context;
  context.window.confirm = confirmImpl;
  const source = await read("public/app.js");
  runInNewContext(`${source}\n;globalThis.__recoveryTest = { state, renderIngestRecovery, actOnIngestDeadLetter };`, context, {
    filename: "public/app.js",
  });
  return { ...context.__recoveryTest, element };
}

test("owner dashboard loads and renders content-free ingest recovery state", async () => {
  const [app, html] = await Promise.all([read("public/app.js"), read("public/index.html")]);

  assert.match(html, /id="ingest-recovery-card"/);
  assert.match(html, /id="ingest-recovery-summary"/);
  assert.match(html, /id="ingest-dead-letters"/);
  assert.match(html, /This screen shows status only/);
  assert.doesNotMatch(html, /saved safely|never displays/i);
  assert.match(app, /api\("\/api\/ingest\/dead-letters\?limit=100"\)/);
  assert.match(app, /function renderIngestRecovery\(\)/);
  assert.match(app, /record\.provider/);
  assert.match(app, /record\.attempts/);
  assert.match(app, /record\.reason/);
  assert.doesNotMatch(app, /record\.source_id|record\.queue_name|record\.body_bytes/);
  assert.doesNotMatch(app, /body_json|body_hash|queue_message_id|source_run_id/);
});

test("retry and dismiss require confirmation and refresh both readiness views", async () => {
  const app = await read("public/app.js");

  assert.match(app, /window\.confirm\("Try saving this collected item once more\?/);
  assert.match(app, /window\.confirm\("Dismiss this item\? Its private recovery copy will be erased/);
  assert.match(app, /api\(`\/api\/ingest\/dead-letters\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}`,[\s\S]*method: "POST"/);
  assert.match(app, /button\.disabled = true;[\s\S]*await refreshIngestRecovery\(\);[\s\S]*button\.disabled = false;/);
  assert.match(app, /async function refreshIngestRecovery\(\)[\s\S]*api\("\/api\/readiness"\)[\s\S]*api\("\/api\/ingest\/dead-letters\?limit=100"\)[\s\S]*renderReadiness\(\);[\s\S]*renderIngestRecovery\(\);/);
  assert.match(app, /button\.matches\("\.ingest-dead-letter-action"\)/);
});

test("rendering ignores private recovery fields and confirmed retry refreshes state", async () => {
  const calls = [];
  const confirmations = [];
  let approve = false;
  const harness = await dashboardHarness({
    confirmImpl(message) { confirmations.push(message); return approve; },
    async fetchImpl(path, options) {
      calls.push({ path, method: options?.method || "GET" });
      const payload = path === "/api/readiness"
        ? { ok: true, score: 100, releaseBlocked: false, checks: [] }
        : path.startsWith("/api/ingest/dead-letters?")
          ? { ok: true, deadLetters: [] }
          : { ok: true, queued: 1 };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
  });
  harness.state.readiness = { releaseBlocked: true, checks: [] };
  harness.state.ingestDeadLetters = [{
    id: "dead-letter-1",
    provider: "email<script>",
    source_id: "source<&>",
    queue_name: "ingest-dlq",
    attempts: 4,
    reason: "Primary retries <exhausted>",
    body_bytes: 240,
    body_json: "private collected content",
    body_hash: "private-content-hash",
    queue_message_id: "private-message-id",
    status: "unresolved",
    created_at: "2026-08-07T12:00:00.000Z",
  }];
  harness.renderIngestRecovery();
  const markup = harness.element("#ingest-dead-letters").innerHTML;
  assert.match(markup, /email&lt;script&gt;/);
  assert.match(markup, /Primary retries &lt;exhausted&gt;/);
  assert.doesNotMatch(markup, /private collected content|private-content-hash|private-message-id/);

  const button = { dataset: { deadLetter: "dead-letter-1", deadLetterAction: "retry" }, disabled: false };
  await harness.actOnIngestDeadLetter(button);
  assert.equal(calls.length, 0, "cancelled confirmation must not mutate or refresh");
  approve = true;
  await harness.actOnIngestDeadLetter(button);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ["/api/ingest/dead-letters/dead-letter-1/retry", "POST"],
    ["/api/readiness", "GET"],
    ["/api/ingest/dead-letters?limit=100", "GET"],
  ]);
  assert.equal(confirmations.length, 2);
  assert.equal(harness.state.readiness.releaseBlocked, false);
  assert.deepEqual(harness.state.ingestDeadLetters, []);
  assert.equal(button.disabled, false);
});
