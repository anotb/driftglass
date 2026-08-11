import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createNodePublicFetch,
  isPublicInternetAddress,
} = require("../.test-dist/runtime/node/public-fetch.js");
const {
  fetchWithTimeout,
  readBoundedResponseText,
  setOutboundFetchImplementation,
} = require("../.test-dist/utils.js");

test("self-host public fetch rejects local and reserved address families", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:0:127.0.0.1",
    "100:0:0:1::1",
    "200::1",
    "1fff::1",
    "2001:100::1",
    "2002:7f00:1::1",
    "3ffe::1",
    "3fff::1",
    "5f00::1",
    "4000::1",
    "fe00::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "2001:20::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicInternetAddress(address), false, address);
  }
  assert.equal(isPublicInternetAddress("1.1.1.1"), true);
  assert.equal(isPublicInternetAddress("2000::1"), true);
  assert.equal(isPublicInternetAddress("2002:808:808::1"), true);
  assert.equal(isPublicInternetAddress("2606:4700:4700::1111"), true);
});

test("the outbound deadline includes hostname resolution", async () => {
  const fetchPublic = createNodePublicFetch(async () => await new Promise(() => {}));
  const restore = setOutboundFetchImplementation(fetchPublic);
  try {
    await assert.rejects(
      fetchWithTimeout("https://resolver-stall.example.test/path", {}, 25),
      /timed out/i,
    );
  } finally {
    restore();
  }
});

test("self-host public fetch rejects a public-looking hostname when DNS includes a private answer", async () => {
  const lookedUp = [];
  const fetchPublic = createNodePublicFetch(async (hostname) => {
    lookedUp.push(hostname);
    return [
      { address: "203.0.113.10", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
  });

  await assert.rejects(
    fetchPublic("https://collector.example.test/path"),
    /private or reserved network address/i,
  );
  assert.deepEqual(lookedUp, ["collector.example.test"]);
});

test("self-host DNS admission applies the ORCHIDv2 reserved-range policy", async () => {
  const fetchPublic = createNodePublicFetch(async () => [
    { address: "2001:20::1", family: 6 },
  ]);

  await assert.rejects(
    fetchPublic("https://public-looking.example.test/path"),
    /private or reserved network address/i,
  );
});

test("outbound timeout remains active until the response body finishes", async () => {
  let cancelled = false;
  const restore = setOutboundFetchImplementation(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      cancelled = true;
    },
  })));
  try {
    const response = await fetchWithTimeout("https://public.example.test/slow", {}, 25);
    await assert.rejects(
      readBoundedResponseText(response, 1_000),
      /timed out/i,
    );
    assert.equal(cancelled, true);
  } finally {
    restore();
  }
});
