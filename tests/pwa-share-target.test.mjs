import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not isolate ${name}`);
}

test("the root share target prefills Capture and removes query parameters from history", () => {
  const elements = {
    "#bookmarklet": { href: "" },
    "#capture-form [name=url]": { value: "" },
    "#capture-form [name=title]": { value: "" },
  };
  const views = [];
  const replacements = [];
  const context = {
    URL,
    location: {
      origin: "https://driftglass.example",
      href: "https://driftglass.example/?title=Shared%20signal&text=Useful%20context&url=https%3A%2F%2Fsource.example%2Fitem#capture",
    },
    $: (selector) => elements[selector],
    setView: (view) => views.push(view),
    history: { replaceState: (...args) => replacements.push(args) },
  };
  vm.runInNewContext([
    functionSource(appSource, "sharedCaptureInput"),
    functionSource(appSource, "initializeCaptureTools"),
    "initializeCaptureTools();",
  ].join("\n"), context);

  assert.equal(elements["#capture-form [name=url]"].value, "https://source.example/item");
  assert.equal(elements["#capture-form [name=title]"].value, "Shared signal");
  assert.deepEqual(views, ["capture"]);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0][2], "https://driftglass.example/#capture");
  assert.equal(replacements[0][2].includes("source.example"), false);
});

test("a controlled share navigation never persists its title, text, or URL in CacheStorage", async () => {
  const listeners = new Map();
  const cachePuts = [];
  const cacheMatches = [];
  let fetchCall = null;
  const shell = new Response("shell", { status: 200, headers: { "content-type": "text/html", "cache-control": "no-cache" } });
  const context = {
    URL,
    Response,
    location: { origin: "https://driftglass.example" },
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({
        addAll: async () => undefined,
        put: async (...args) => cachePuts.push(args),
      }),
      match: async (request) => {
        cacheMatches.push(request);
        return request === "/index.html" ? shell.clone() : undefined;
      },
    },
    fetch: async (request, options) => {
      fetchCall = { request, options };
      return shell.clone();
    },
  };
  vm.runInNewContext(workerSource, context);
  const listener = listeners.get("fetch");
  assert.equal(typeof listener, "function");
  const request = {
    method: "GET",
    mode: "navigate",
    url: "https://driftglass.example/?title=Private%20title&text=Private%20text&url=https%3A%2F%2Fsource.example%2Fprivate",
    headers: new Headers({ accept: "text/html" }),
  };
  let responsePromise;
  listener({ request, respondWith: (value) => { responsePromise = value; } });
  const response = await responsePromise;

  assert.equal(await response.text(), "shell");
  assert.equal(fetchCall.request, request);
  assert.equal(fetchCall.options.cache, "no-store");
  assert.equal(cachePuts.length, 0);
  assert.equal(cacheMatches.length, 0);

  context.fetch = async () => { throw new Error("offline"); };
  responsePromise = undefined;
  listener({ request, respondWith: (value) => { responsePromise = value; } });
  assert.equal(await (await responsePromise).text(), "shell");
  assert.deepEqual(cacheMatches, ["/index.html"]);
  assert.equal(cachePuts.length, 0);
});
