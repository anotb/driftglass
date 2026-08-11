import test from "node:test";
import assert from "node:assert/strict";

const npmAdapter = await import("../.test-dist/sources/npm.js");
const pypiAdapter = await import("../.test-dist/sources/pypi.js");
const packageRuntime = await import("../.test-dist/sources/package-runtime.js");

function source(kind, config) {
  return {
    id: `${kind}-test`, name: kind, kind, config_json: JSON.stringify(config), enabled: 1,
    schedule_minutes: 60, weight: 1, last_run_at: null, last_success_at: null,
    last_error: null, health_score: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

test("npm release adapter returns recent stable versions when abbreviated metadata omits time", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: "agents",
    description: "Cloudflare Agents SDK",
    "dist-tags": { latest: "0.21.0-beta.1", next: "0.21.0-beta.1" },
    versions: { "0.19.0": {}, "0.20.0": {}, "0.21.0-beta.1": {} },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await npmAdapter.collectNpmReleases(source("npm_releases", { packages: ["agents"], perPackage: 2 }));
  assert.equal(result.provider, "npm-registry");
  assert.deepEqual(result.items.map((item) => item.externalId), ["agents@0.20.0", "agents@0.19.0"]);
  assert.ok(result.items.every((item) => item.metadata.prerelease === false));
  assert.equal(result.details.perPackage, 2);
});

test("PyPI release adapter returns newest non-yanked versions", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    info: { name: "openai", version: "3.1.0", summary: "OpenAI Python client", project_urls: { Source: "https://github.com/openai/openai-python" } },
    releases: {
      "3.0.0": [{ upload_time_iso_8601: "2026-07-01T00:00:00.000Z", yanked: false }],
      "3.1.0": [{ upload_time_iso_8601: "2026-08-01T00:00:00.000Z", yanked: false }],
      "3.2.0": [{ upload_time_iso_8601: "2026-08-06T00:00:00.000Z", yanked: true }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await pypiAdapter.collectPypiReleases(source("pypi_releases", { packages: ["openai"], perPackage: 2 }));
  assert.equal(result.provider, "pypi-json");
  assert.deepEqual(result.items.map((item) => item.externalId), ["openai@3.1.0", "openai@3.0.0"]);
  assert.equal(result.items[0].url, "https://github.com/openai/openai-python");
});

async function exerciseBoundedRegistry(adapter, kind, payloadForPackage) {
  const original = globalThis.fetch;
  const packages = Array.from({ length: 40 }, (_, index) => `package-${index}`);
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.redirect, "manual");
    active += 1;
    maxActive = Math.max(maxActive, active);
    const pathParts = String(url).split("/").filter(Boolean);
    const packageName = decodeURIComponent(pathParts.at(-1) === "json" ? pathParts.at(-2) : pathParts.at(-1));
    await new Promise((resolve) => setImmediate(resolve));
    if (packageName === "package-7") {
      active -= 1;
      return new Response("unavailable", { status: 503 });
    }
    const response = new Response(JSON.stringify(payloadForPackage(packageName)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    active -= 1;
    return response;
  };
  try {
    const result = await adapter(source(kind, { packages, perPackage: 1 }));
    assert.equal(maxActive, packageRuntime.PACKAGE_FETCH_CONCURRENCY);
    assert.equal(active, 0);
    assert.equal(result.items.length, 39);
    assert.deepEqual(
      result.items.map((item) => item.externalId?.split("@")[0]),
      packages.filter((packageName) => packageName !== "package-7"),
      "bounded batches preserve package order around a per-package failure",
    );
    assert.equal(result.details.partial, true);
    assert.equal(result.details.errors.length, 1);
    assert.equal(result.details.descriptionMaxBytes, packageRuntime.PACKAGE_DESCRIPTION_MAX_BYTES);
    assert.equal(result.details.descriptionTruncatedItems, 39);
    assert.ok(result.items.every((item) => item.metadata.descriptionTruncated === true));
    assert.ok(result.items.every((item) => item.metadata.descriptionBytes <= packageRuntime.PACKAGE_DESCRIPTION_MAX_BYTES));
  } finally {
    globalThis.fetch = original;
  }
}

test("npm and PyPI bound active registry bodies while preserving ordered partial results", async () => {
  const longDescription = "💡".repeat(3_000);
  await exerciseBoundedRegistry(npmAdapter.collectNpmReleases, "npm_releases", (packageName) => ({
    name: packageName,
    description: longDescription,
    "dist-tags": { latest: "1.0.0" },
    versions: { "1.0.0": {} },
    time: { "1.0.0": "2026-08-01T00:00:00.000Z" },
  }));
  await exerciseBoundedRegistry(pypiAdapter.collectPypiReleases, "pypi_releases", (packageName) => ({
    info: { name: packageName, version: "1.0.0", summary: longDescription },
    releases: { "1.0.0": [{ upload_time_iso_8601: "2026-08-01T00:00:00.000Z", yanked: false }] },
  }));
});

test("npm replaces an oversized packument with bounded current tagged releases", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  const requested = [];
  const redirectModes = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    requested.push(href);
    redirectModes.push(init?.redirect);
    if (href.endsWith("/oversized-package")) {
      return new Response(new ReadableStream({
        start(controller) {
          const chunkBytes = Math.floor(packageRuntime.PACKAGE_METADATA_MAX_BYTES / 2) + 1;
          controller.enqueue(new Uint8Array(chunkBytes));
          controller.enqueue(new Uint8Array(chunkBytes));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/-/package/oversized-package/dist-tags")) {
      return new Response(JSON.stringify({
        latest: "2.0.0",
        next: "2.1.0-beta.1",
        legacy: "1.9.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const version = decodeURIComponent(href.split("/").at(-1));
    return new Response(JSON.stringify({
      name: "oversized-package",
      version,
      description: `Release ${version}`,
      repository: { url: "https://github.com/example/oversized-package.git" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await npmAdapter.collectNpmReleases(source("npm_releases", {
    packages: ["oversized-package"],
    includePrereleases: true,
    perPackage: 5,
  }));

  assert.equal(cancelled, true);
  assert.deepEqual(result.items.map((item) => item.externalId), [
    "oversized-package@2.0.0",
    "oversized-package@2.1.0-beta.1",
    "oversized-package@1.9.0",
  ]);
  assert.ok(result.items.every((item) => item.publishedAt === undefined));
  assert.ok(result.items.every((item) => item.metadata.releaseTimestampAvailable === false));
  assert.ok(result.items.every((item) => item.metadata.registryMetadataMode === "dist-tags"));
  assert.equal(result.details.partial, false);
  assert.equal(result.details.boundedMetadataFallbackPackages, 1);
  assert.equal(result.details.boundedMetadataFallbackDeferredVersions, 0);
  assert.equal(result.details.boundedMetadataFallbackCoverage, null);
  assert.equal(result.details.boundedMetadataFallbackRequests, 4);
  assert.equal(result.details.registryRequests, 5);
  assert.equal(result.details.registryRequestLimit, 48);
  assert.equal(requested.length, 5, "one bounded packument, one tag list, and three version documents");
  assert.deepEqual([...new Set(redirectModes)], ["manual"], "registry requests never follow redirects implicitly");
});

test("npm keeps max-config oversized fallbacks inside the external request envelope", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const packages = Array.from({ length: 40 }, (_, index) => `oversized-${index}`);
  const tags = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    index === 0 ? "latest" : `channel-${String(index).padStart(2, "0")}`,
    `2.0.${index}`,
  ]));
  let requests = 0;
  let cancelled = 0;
  globalThis.fetch = async (url) => {
    requests += 1;
    const target = new URL(String(url));
    const segments = target.pathname.split("/").filter(Boolean);
    if (target.pathname.includes("/-/package/")) {
      return new Response(JSON.stringify(tags), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (segments.length === 1) {
      return new Response(new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }), {
        status: 200,
        headers: { "content-length": String(packageRuntime.PACKAGE_METADATA_MAX_BYTES + 1) },
      });
    }
    const version = decodeURIComponent(segments.at(-1));
    const packageName = decodeURIComponent(segments.at(-2));
    return new Response(JSON.stringify({ name: packageName, version, description: `Release ${version}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await npmAdapter.collectNpmReleases(source("npm_releases", {
    packages,
    includePrereleases: true,
    perPackage: 20,
  }));

  assert.equal(cancelled, 40);
  assert.equal(requests, 48);
  assert.equal(result.items.length, 4);
  assert.equal(new Set(result.items.map((item) => item.metadata.package)).size, 4);
  assert.equal(result.details.partial, true);
  assert.equal(result.details.oversizedMetadataPackages, 40);
  assert.equal(result.details.boundedMetadataFallbackPackages, 4);
  assert.equal(result.details.boundedMetadataFallbackDeferredPackages, 36);
  assert.equal(result.details.boundedMetadataFallbackDeferredVersions, 76);
  assert.match(result.details.boundedMetadataFallbackCoverage, /request envelope/);
  assert.equal(result.details.boundedMetadataFallbackRequests, 8);
  assert.equal(result.details.registryRequests, 48);
  assert.equal(result.details.registryRequestLimit, 48);
});

test("npm cancels every non-OK registry response body before failing", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  for (const failingPhase of ["packument", "dist-tags", "version"]) {
    let failedBodyCancellations = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      const failedResponse = () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unavailable"));
        },
        cancel() {
          failedBodyCancellations += 1;
        },
      }), { status: 503 });

      if (failingPhase === "packument") return failedResponse();
      if (href.includes("/-/package/")) {
        if (failingPhase === "dist-tags") return failedResponse();
        return new Response(JSON.stringify({ latest: "2.0.0" }), { status: 200 });
      }
      if (href.endsWith("/oversized-package")) {
        return new Response(new ReadableStream(), {
          status: 200,
          headers: { "content-length": String(packageRuntime.PACKAGE_METADATA_MAX_BYTES + 1) },
        });
      }
      return failedResponse();
    };

    await assert.rejects(
      () => npmAdapter.collectNpmReleases(source("npm_releases", {
        packages: ["oversized-package"],
        perPackage: 1,
      })),
      /Every npm package failed/,
    );
    assert.equal(failedBodyCancellations, 1, `${failingPhase} response body was cancelled`);
  }
});

async function assertOversizedRegistryBodyIsCancelled(adapter, kind) {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const chunkBytes = Math.floor(packageRuntime.PACKAGE_METADATA_MAX_BYTES / 2) + 1;
      controller.enqueue(new Uint8Array(chunkBytes));
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      () => adapter(source(kind, { packages: ["oversized-package"], perPackage: 1 })),
      /package metadata exceeds 3 MB/,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = original;
  }
}

test("PyPI cancels chunked metadata responses at the real 3 MB boundary", async () => {
  await assertOversizedRegistryBodyIsCancelled(pypiAdapter.collectPypiReleases, "pypi_releases");
});
