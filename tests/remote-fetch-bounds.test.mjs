import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function driftglassRemoteFetchTestLoad(request, parent, isMain) {
  if (request === "cloudflare:workers") {
    return {
      tracing: {
        enterSpan: (_name, operation) => operation({ setAttribute() {} }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { collectArxiv } = require("../.test-dist/sources/arxiv.js");
const { collectBluesky } = require("../.test-dist/sources/bluesky.js");
const { collectGithubReleases } = require("../.test-dist/sources/github.js");
const { collectGithubActivity } = require("../.test-dist/sources/github-activity.js");
const { collectHackerNews } = require("../.test-dist/sources/hackernews.js");
const { collectLobsters } = require("../.test-dist/sources/lobsters.js");
const { collectOpenAlex } = require("../.test-dist/sources/openalex.js");
const { collectPypiReleases } = require("../.test-dist/sources/pypi.js");
const { collectWeb } = require("../.test-dist/sources/web.js");
const { collectWebFeed } = require("../.test-dist/sources/web-feed.js");
const {
  fetchPublicSourceResponse,
  MAX_PUBLIC_SOURCE_REQUESTS,
  REMOTE_SOURCE_FETCH_CONCURRENCY,
} = require("../.test-dist/sources/remote-runtime.js");
const { fetchIntelligencePack } = require("../.test-dist/intelligence-packs.js");
const { fetchPortableLens } = require("../.test-dist/lenses.js");
const { browserMarkdown, renderAdaptive } = require("../.test-dist/rendering.js");
const { readBoundedResponseText } = require("../.test-dist/utils.js");
Module._load = originalLoad;

function source(kind, config) {
  return {
    id: `${kind}-bounded-test`,
    name: kind,
    kind,
    config_json: JSON.stringify(config),
    enabled: 1,
    schedule_minutes: 60,
    weight: 1,
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    health_score: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function oversizedChunkedResponse(maxBytes, contentType, declaredLength) {
  const chunkBytes = Math.floor(maxBytes / 2) + 1;
  let chunks = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      while (chunks < 2) {
        chunks += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      }
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: {
      "content-type": contentType,
      ...(declaredLength === undefined ? {} : { "content-length": String(declaredLength) }),
    },
  });
  return { response, wasCancelled: () => cancelled };
}

function githubReleaseAtomFixture() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry data-fixture="valid-opening-attribute">
    <id>tag:github.com,2008:Repository/123/v1.2.3</id>
    <updated>2020-01-02T12:34:56Z</updated>
    <link type="text/html" data-rel="self" data-href="https://example.test/spoofed" rel="alternate" href="https://github.com/example/project/releases/tag/v1.2.3"/>
    <title>Project 1.2.3</title>
    <content type="html">&lt;h2&gt;Highlights&lt;/h2&gt;&lt;p&gt;Faster sync &amp;amp; safer retries.&lt;/p&gt;</content>
    <author><name>octocat</name></author>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123/v1.3.0-alpha.1</id>
    <updated>2020-01-03T13:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/project/releases/tag/v1.3.0-alpha.1"/>
    <title>Project 1.3 alpha</title>
    <content type="html">&lt;p&gt;Preview only.&lt;/p&gt;</content>
    <author><name>octocat</name></author>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123/v1.2.2</id>
    <updated>2019-12-20T08:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/example/project/releases/tag/v1.2.2"/>
    <title>Project 1.2.2</title>
    <content type="html">&lt;p&gt;Maintenance release.&lt;/p&gt;</content>
    <author><name>hubot</name></author>
  </entry>
</feed>`;
}

function appendGithubReleaseAtomEntry(xml, entry) {
  return xml.replace("</feed>", `${entry}\n</feed>`);
}

async function collectGithubReleaseAtomXml(xml, config = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(xml, {
    status: 200,
    headers: { "content-type": "application/atom+xml" },
  });
  try {
    return await collectGithubReleases(source("github_releases", {
      repos: ["example/project"],
      perRepo: 10,
      includePrereleases: true,
      ...config,
    }), {});
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("an underreported Content-Length cannot bypass the streamed byte limit", async () => {
  const oversized = oversizedChunkedResponse(64, "text/plain", 1);
  await assert.rejects(
    () => readBoundedResponseText(oversized.response, 64, "underreported response exceeds 64 bytes"),
    /underreported response exceeds 64 bytes/,
  );
  assert.equal(oversized.wasCancelled(), true);
});

async function assertFetchOverflow(maxBytes, contentType, operation, expected, expectedRedirect) {
  const originalFetch = globalThis.fetch;
  const oversized = oversizedChunkedResponse(maxBytes, contentType);
  globalThis.fetch = async (_input, init = {}) => {
    if (expectedRedirect) assert.equal(init.redirect, expectedRedirect);
    return oversized.response;
  };
  try {
    await assert.rejects(operation, expected);
    assert.equal(oversized.wasCancelled(), true, "the oversized upstream stream must be cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Bluesky routes topic search to the primary AppView and keeps author feeds on the public cache", async () => {
  const originalFetch = globalThis.fetch;
  const origins = [];
  globalThis.fetch = async (input) => {
    origins.push(new URL(String(input)).origin);
    return new Response(JSON.stringify({ posts: [], feed: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await collectBluesky(source("bluesky", { mode: "search", query: "workers" }));
    await collectBluesky(source("bluesky", { mode: "author", actor: "example.com" }));
    assert.deepEqual(origins, ["https://api.bsky.app", "https://public.api.bsky.app"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external source adapters cancel chunked bodies at source-specific limits", async (t) => {
  const cases = [
    {
      name: "Bluesky",
      maxBytes: 3_000_000,
      run: () => collectBluesky(source("bluesky", { query: "workers" })),
      expected: /Bluesky response exceeds 3 MB/,
    },
    {
      name: "OpenAlex",
      maxBytes: 8_000_000,
      run: () => collectOpenAlex(
        source("openalex", { query: "workers" }),
        { OPENALEX_API_KEY: "openalex-byte-bound-test-key" },
      ),
      expected: /OpenAlex response exceeds 8 MB/,
    },
    {
      name: "Lobsters",
      maxBytes: 2_000_000,
      run: () => collectLobsters(source("lobsters", {})),
      expected: /Lobsters response exceeds 2 MB/,
    },
    {
      name: "Hacker News",
      maxBytes: 256_000,
      run: () => collectHackerNews(source("hackernews", { limit: 1 })),
      expected: /Hacker News story list exceeds 256 KB/,
    },
    {
      name: "GitHub Releases",
      maxBytes: 2_000_000,
      run: () => collectGithubReleases(source("github_releases", { repos: ["example/project"] }), {}),
      contentType: "application/atom+xml",
      expected: /GitHub releases Atom feed exceeds 2 MB/,
    },
    {
      name: "GitHub activity",
      maxBytes: 4_000_000,
      run: () => collectGithubActivity(source("github_activity", { repos: ["example/project"] }), {}),
      expected: /GitHub events response exceeds 4 MB/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => assertFetchOverflow(
      fixture.maxBytes,
      fixture.contentType ?? "application/json",
      fixture.run,
      fixture.expected,
      "manual",
    ));
  }
});

test("multi-endpoint JSON adapters bound aggregate live responses", async (t) => {
  const repos = Array.from({ length: 20 }, (_, index) => `example/project-${index}`);
  for (const fixture of [
    {
      name: "GitHub Releases",
      run: () => collectGithubReleases(source("github_releases", { repos }), { GITHUB_TOKEN: "test-token" }),
    },
    { name: "GitHub activity", run: () => collectGithubActivity(source("github_activity", { repos }), {}) },
  ]) {
    await t.test(fixture.name, async () => {
      const originalFetch = globalThis.fetch;
      let active = 0;
      let maxActive = 0;
      globalThis.fetch = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        await fixture.run();
        assert.equal(active, 0);
        assert.equal(maxActive, REMOTE_SOURCE_FETCH_CONCURRENCY);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test("GitHub release Atom rejects incomplete roots and unbalanced entry structure", async (t) => {
  await t.test("truncated feed root", async () => {
    await assert.rejects(
      collectGithubReleaseAtomXml("<?xml version=\"1.0\"?><feed><entry></entry>"),
      /Every GitHub repository failed: example\/project: GitHub releases Atom feed has an incomplete or malformed feed root/,
    );
  });
  await t.test("truncated entry inside a complete root", async () => {
    await assert.rejects(
      collectGithubReleaseAtomXml("<?xml version=\"1.0\"?><feed><entry><id>unfinished<\/id><\/feed>"),
      /Every GitHub repository failed: example\/project: GitHub releases Atom feed has unbalanced or truncated entry structure/,
    );
  });
  await t.test("unexpected closing entry", async () => {
    await assert.rejects(
      collectGithubReleaseAtomXml("<?xml version=\"1.0\"?><feed></entry></feed>"),
      /Every GitHub repository failed: example\/project: GitHub releases Atom feed has an unexpected closing entry tag/,
    );
  });
  await t.test("closing entry with attributes", async () => {
    await assert.rejects(
      collectGithubReleaseAtomXml("<?xml version=\"1.0\"?><feed><entry></entry bogus></feed>"),
      /Every GitHub repository failed: example\/project: GitHub releases Atom feed has a malformed closing entry tag/,
    );
  });
});

test("GitHub release Atom fails a mixed feed when any entry lacks confined identity", async (t) => {
  const updated = "<updated>2020-01-04T00:00:00Z</updated>";
  const validLink = "<link rel=\"alternate\" href=\"https://github.com/example/project/releases/tag/v2.0.0\"/>";
  const stableId = "<id>tag:github.com,2008:Repository/123/v2.0.0</id>";
  const cases = [
    {
      name: "missing stable id",
      entry: `<entry>${updated}${validLink}<title>Missing id</title></entry>`,
      expected: /missing a stable GitHub Atom id/,
    },
    {
      name: "missing alternate link",
      entry: `<entry>${stableId}${updated}<title>Missing link</title></entry>`,
      expected: /must have exactly one alternate release link/,
    },
    {
      name: "wrong repository link",
      entry: `<entry>${stableId}${updated}<link rel="alternate" href="https://github.com/other/project/releases/tag/v2.0.0"/></entry>`,
      expected: /alternate link escaped the configured repository/,
    },
    {
      name: "malformed link",
      entry: `<entry>${stableId}${updated}<link rel="alternate" href="https:\/\/[bad"/></entry>`,
      expected: /has a malformed alternate link/,
    },
    {
      name: "data attributes are not Atom link attributes",
      entry: `<entry>${stableId}${updated}<link data-rel="alternate" data-href="https://github.com/example/project/releases/tag/v2.0.0"/></entry>`,
      expected: /has a malformed alternate link/,
    },
    {
      name: "stable id and link disagree",
      entry: `<entry>${stableId}${updated}<link rel="alternate" href="https://github.com/example/project/releases/tag/v2.0.1"/></entry>`,
      expected: /entry id and alternate release tag disagree/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const mixed = appendGithubReleaseAtomEntry(githubReleaseAtomFixture(), fixture.entry);
      await assert.rejects(collectGithubReleaseAtomXml(mixed), fixture.expected);
    });
  }
});

test("GitHub release Atom requires a valid updated time instead of defaulting replay to now", async () => {
  const mixed = appendGithubReleaseAtomEntry(
    githubReleaseAtomFixture(),
    `<entry>
      <id>tag:github.com,2008:Repository/123/v2.0.0</id>
      <updated>not-a-timestamp</updated>
      <link rel="alternate" href="https://github.com/example/project/releases/tag/v2.0.0"/>
      <title>Invalid time</title>
    </entry>`,
  );
  await assert.rejects(
    collectGithubReleaseAtomXml(mixed),
    /missing or invalid updated timestamp/,
  );
});

test("anonymous GitHub Releases bypasses the REST rate-limit bucket with content-bearing Atom", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let apiCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    requests.push({ url: url.toString(), headers, redirect: init.redirect });
    if (url.hostname === "api.github.com") {
      apiCalls += 1;
      return new Response("API rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    }
    return new Response(githubReleaseAtomFixture(), {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    });
  };

  try {
    const result = await collectGithubReleases(source("github_releases", {
      repos: ["example/project"],
      perRepo: 2,
      includePrereleases: false,
      watchTerms: ["workers"],
    }), {});

    assert.equal(apiCalls, 0, "zero-config collection must not enter GitHub's shared anonymous REST bucket");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://github.com/example/project/releases.atom");
    assert.equal(requests[0].redirect, "manual");
    assert.equal(requests[0].headers.get("authorization"), null);
    assert.equal(requests[0].headers.get("accept"), "application/atom+xml");
    assert.equal(result.provider, "github-atom");
    assert.deepEqual(result.items, [
      {
        externalId: "example/project:release-tag:v1.2.3",
        url: "https://github.com/example/project/releases/tag/v1.2.3",
        title: "example/project: Project 1.2.3",
        text: "Highlights Faster sync & safer retries.",
        author: "octocat",
        observedAt: "2020-01-02T12:34:56.000Z",
        accessClass: "public",
        metadata: {
          platform: "github",
          repository: "example/project",
          tag: "v1.2.3",
          atomEntryId: "tag:github.com,2008:Repository/123/v1.2.3",
          prereleaseTagSignal: false,
          prereleaseSignalCoverage: "incomplete",
          releaseUpdatedAt: "2020-01-02T12:34:56.000Z",
          timestampSource: "atom-updated",
          identityScheme: "repository-tag-v1",
          watchTerms: ["workers"],
        },
      },
      {
        externalId: "example/project:release-tag:v1.2.2",
        url: "https://github.com/example/project/releases/tag/v1.2.2",
        title: "example/project: Project 1.2.2",
        text: "Maintenance release.",
        author: "hubot",
        observedAt: "2019-12-20T08:00:00.000Z",
        accessClass: "public",
        metadata: {
          platform: "github",
          repository: "example/project",
          tag: "v1.2.2",
          atomEntryId: "tag:github.com,2008:Repository/123/v1.2.2",
          prereleaseTagSignal: false,
          prereleaseSignalCoverage: "incomplete",
          releaseUpdatedAt: "2019-12-20T08:00:00.000Z",
          timestampSource: "atom-updated",
          identityScheme: "repository-tag-v1",
          watchTerms: ["workers"],
        },
      },
    ]);
    assert.deepEqual(result.details, {
      repos: ["example/project"],
      returned: 2,
      partial: false,
      errors: [],
      transport: "atom",
      identityScheme: "repository-tag-v1",
      observationTimeSource: "atom-updated",
      prereleaseFilter: "best-effort-tag-signal",
      prereleaseFilterCoverage: "incomplete",
      inferredPrereleasesExcluded: 1,
    });
    assert.equal(Object.hasOwn(result.items[0], "publishedAt"), false);
    assert.equal(result.items[0].observedAt, "2020-01-02T12:34:56.000Z");
    assert.ok(Date.parse(result.items[0].observedAt) < Date.now() - 365 * 24 * 60 * 60 * 1_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub release identity is deterministic across Atom and REST transports", async () => {
  const atom = await collectGithubReleaseAtomXml(githubReleaseAtomFixture(), { perRepo: 1, includePrereleases: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 987,
    tag_name: "v1.2.3",
    name: "Project 1.2.3",
    body: "Highlights Faster sync & safer retries.",
    html_url: "https://github.com/example/project/releases/tag/v1.2.3",
    published_at: "2020-01-02T12:00:00Z",
    draft: false,
    prerelease: false,
    author: { login: "octocat" },
  }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const rest = await collectGithubReleases(source("github_releases", {
      repos: ["example/project"],
      perRepo: 1,
      includePrereleases: false,
    }), { GITHUB_TOKEN: "test-token" });
    assert.equal(atom.items.length, 1);
    assert.equal(rest.items.length, 1);
    assert.equal(atom.items[0].externalId, "example/project:release-tag:v1.2.3");
    assert.equal(atom.items[0].externalId, rest.items[0].externalId);
    assert.equal(atom.items[0].url, rest.items[0].url);
    assert.equal(atom.items[0].title, rest.items[0].title);
    assert.equal(atom.items[0].text, rest.items[0].text);
    assert.equal(atom.items[0].author, rest.items[0].author);
    assert.equal(Object.hasOwn(atom.items[0], "publishedAt"), false);
    assert.equal(atom.items[0].observedAt, "2020-01-02T12:34:56.000Z");
    assert.equal(atom.items[0].metadata.identityScheme, "repository-tag-v1");
    assert.equal(rest.items[0].metadata.identityScheme, "repository-tag-v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anonymous GitHub release feeds use exactly one Free-safe subrequest per repository", async () => {
  const originalFetch = globalThis.fetch;
  const repos = Array.from({ length: 25 }, (_, index) => `example/project-${index}`);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const url = new URL(String(input));
    assert.equal(url.hostname, "github.com");
    assert.match(url.pathname, /^\/example\/project-\d+\/releases\.atom$/);
    assert.equal(init.redirect, "manual");
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return new Response("<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    });
  };

  try {
    const result = await collectGithubReleases(source("github_releases", { repos }), {});
    assert.equal(calls, repos.length);
    assert.ok(calls <= 50, "the aggregate public path must fit the Workers Free ceiling");
    assert.equal(maxActive, REMOTE_SOURCE_FETCH_CONCURRENCY);
    assert.equal(result.provider, "github-atom");
    assert.equal(result.items.length, 0);
    assert.equal(result.details.transport, "atom");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token-backed GitHub Releases stays on REST when GitHub returns 403", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), headers: new Headers(init.headers), redirect: init.redirect });
    return new Response("forbidden", { status: 403 });
  };
  try {
    await assert.rejects(
      collectGithubReleases(
        source("github_releases", { repos: ["example/project"] }),
        { GITHUB_TOKEN: "test-token" },
      ),
      /Every GitHub repository failed: example\/project: HTTP 403/,
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /^https:\/\/api\.github\.com\//);
    assert.equal(requests[0].headers.get("authorization"), "Bearer test-token");
    assert.equal(requests[0].redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hacker News reserves the feed request within the Workers Free subrequest ceiling", async () => {
  const originalFetch = globalThis.fetch;
  const feedIds = Array.from({ length: 50 }, (_, index) => index + 1);
  const fetchedItemIds = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    const url = new URL(String(input));
    if (url.pathname.endsWith("stories.json")) {
      return new Response(JSON.stringify(feedIds), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const id = Number(url.pathname.match(/\/item\/(\d+)\.json$/)?.[1]);
    fetchedItemIds.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return new Response(JSON.stringify({
      id,
      by: `author-${id}`,
      time: 1_700_000_000 + id,
      title: `Story ${id}`,
      url: `https://example.com/story-${id}`,
      score: id,
      type: "story",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await collectHackerNews(source("hackernews", { feed: "best", limit: 50 }));
    assert.equal(calls, 50, "one feed fetch plus item fetches must fit the Free-plan ceiling");
    assert.deepEqual(fetchedItemIds, feedIds.slice(0, 49));
    assert.deepEqual(result.items.map((item) => item.externalId), feedIds.slice(0, 49).map(String));
    assert.deepEqual(result.details, { feed: "best", requested: 49, returned: 49, partial: false, failures: 0 });
    assert.equal(maxActive, REMOTE_SOURCE_FETCH_CONCURRENCY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batched manual-response failures release bodies before the next connection batch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await t.test("Hacker News items", async () => {
    let cancelled = 0;
    let calls = 0;
    globalThis.fetch = async (input, init = {}) => {
      calls += 1;
      assert.equal(init.redirect, "manual");
      if (String(input).includes("stories.json")) {
        return new Response(JSON.stringify(Array.from({ length: 8 }, (_, index) => index + 1)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
        status: 302,
        headers: { location: "https://example.com/redirect" },
      });
    };
    const result = await collectHackerNews(source("hackernews", { limit: 8 }));
    assert.equal(calls, 9);
    assert.equal(cancelled, 8);
    assert.equal(result.details.failures, 8);
  });

  for (const fixture of [
    {
      name: "GitHub activity",
      run: () => collectGithubActivity(source("github_activity", {
        repos: Array.from({ length: 8 }, (_, index) => `example/repo-${index}`),
      }), {}),
    },
    {
      name: "PyPI",
      run: () => collectPypiReleases(source("pypi_releases", {
        packages: Array.from({ length: 8 }, (_, index) => `package-${index}`),
      })),
    },
  ]) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      let cancelled = 0;
      globalThis.fetch = async (_input, init = {}) => {
        calls += 1;
        assert.equal(init.redirect, "manual");
        return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
          status: 302,
          headers: { location: "https://example.com/redirect" },
        });
      };
      await assert.rejects(fixture.run, /Every .* failed/i);
      assert.equal(calls, 8);
      assert.equal(cancelled, 8);
    });
  }
});

test("GitHub adapters reject repository paths before using a token-bearing request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(
      collectGithubReleases(source("github_releases", { repos: ["../../user/repos?ignore="] }), { GITHUB_TOKEN: "not-sent" }),
      /owner\/repository/i,
    );
    await assert.rejects(
      collectGithubActivity(source("github_activity", { repos: ["valid/repo/events"] }), { GITHUB_TOKEN: "not-sent" }),
      /owner\/repository/i,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("arXiv, Web, and Page Feed cancel chunked document bodies instead of slicing after buffering", async (t) => {
  await t.test("arXiv", () => assertFetchOverflow(
    4_000_000,
    "application/atom+xml",
    () => collectArxiv(source("arxiv", { query: "workers" })),
    /arXiv response exceeds 4 MB/,
    "manual",
  ));
  await t.test("Web", () => assertFetchOverflow(
    3_000_000,
    "text/html",
    () => collectWeb(source("web", { url: "https://example.com/", renderStrategy: "direct" }), {}),
    /Page is larger than the 3 MB direct-fetch limit/,
    "manual",
  ));
  await t.test("Page Feed", () => assertFetchOverflow(
    3_000_000,
    "text/html",
    () => collectWebFeed(source("web_feed", { url: "https://example.com/", renderStrategy: "direct" }), {}),
    /Listing page exceeds the 3 MB direct-fetch limit/,
    "manual",
  ));
});

test("public source redirects are revalidated and stop after four total requests", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let calls = 0;
  let cancelled = 0;
  globalThis.fetch = async (_input, init = {}) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    if (calls === MAX_PUBLIC_SOURCE_REQUESTS) return new Response("ok", { status: 200 });
    return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
      status: 302,
      headers: { location: `/hop-${calls}` },
    });
  };
  const followed = await fetchPublicSourceResponse("https://example.com/start");
  assert.equal(followed.requests, MAX_PUBLIC_SOURCE_REQUESTS);
  assert.equal(followed.finalUrl.toString(), "https://example.com/hop-3");
  assert.equal(calls, MAX_PUBLIC_SOURCE_REQUESTS);
  assert.equal(cancelled, MAX_PUBLIC_SOURCE_REQUESTS - 1);

  calls = 0;
  cancelled = 0;
  globalThis.fetch = async (_input, init = {}) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), {
      status: 302,
      headers: { location: `/overflow-${calls}` },
    });
  };
  await assert.rejects(
    fetchPublicSourceResponse("https://example.com/start"),
    /exceeded the redirect limit/,
  );
  assert.equal(calls, MAX_PUBLIC_SOURCE_REQUESTS);
  assert.equal(cancelled, MAX_PUBLIC_SOURCE_REQUESTS);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  };
  await assert.rejects(fetchPublicSourceResponse("https://example.com/start"), /public hostname|Private/i);
  assert.equal(calls, 1, "a non-public redirect is rejected before a second fetch");
});

test("Page Feed redirect worst case stays below the Workers Free ceiling", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    const url = new URL(String(input));
    const hop = Number(url.searchParams.get("hop") ?? 0);
    if (hop < 3) {
      return new Response(null, {
        status: 302,
        headers: { location: `${url.pathname}?hop=${hop + 1}` },
      });
    }
    if (url.pathname === "/listing") {
      const links = Array.from({ length: 20 }, (_, index) =>
        `<a href="/article-${index}">Article number ${index} with enough discovery text</a>`).join("");
      return new Response(`<html><head><title>Listing</title></head><body>${links}</body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(`<html><head><title>${url.pathname}</title></head><body>Useful article text.</body></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  const result = await collectWebFeed(source("web_feed", {
    url: "https://example.com/listing",
    renderStrategy: "direct",
    articleRenderStrategy: "direct",
    maxArticles: 20,
  }), {});
  assert.equal(calls, 48, "four listing requests plus eleven four-request article chains");
  assert.equal(result.items.length, 11);
  assert.equal(result.details.capacityMaxArticles, 11);
  assert.equal(result.details.capacityDeferredArticles, 9);
  assert.equal(result.details.partial, true);
});

test("direct and Chromium rendering reject and cancel chunked oversized responses", async (t) => {
  const statement = {
    bind() { return this; },
    async first() { return null; },
  };
  const db = { prepare() { return statement; } };
  await t.test("direct renderer", () => assertFetchOverflow(
    3_000_000,
    "text/html",
    () => renderAdaptive({ url: new URL("https://example.com/"), env: { DB: db }, strategy: "direct" }),
    /Page is larger than the 3 MB direct-fetch limit/,
  ));

  const oversized = oversizedChunkedResponse(4_000_000, "application/json");
  await assert.rejects(
    () => browserMarkdown(oversized.response),
    /Chromium Quick Action response exceeds 4 MB/,
  );
  assert.equal(oversized.wasCancelled(), true);
});

test("Lens and Intelligence Pack installers cancel chunked oversized manifests", async (t) => {
  await t.test("Lens", () => assertFetchOverflow(
    1_000_000,
    "application/json",
    () => fetchPortableLens("https://example.com/lens.json"),
    /Lens file exceeds 1 MB/,
  ));
  await t.test("Intelligence Pack", () => assertFetchOverflow(
    1_500_000,
    "application/json",
    () => fetchIntelligencePack("https://example.com/pack.json"),
    /Intelligence Pack exceeds 1.5 MB/,
  ));
});
