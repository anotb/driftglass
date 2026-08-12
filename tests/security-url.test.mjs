import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertPublicHttpUrl } = require("../.test-dist/security.js");
const originalLoad = Module._load;
Module._load = function driftglassSecurityUrlLoad(request, parent, isMain) {
  if (request === "cloudflare:workers") {
    return {
      tracing: {
        enterSpan: (_name, operation) => operation({ setAttribute() {} }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { captureKitesurfScreenshot, renderAdaptive } = require("../.test-dist/rendering.js");
Module._load = originalLoad;

const NON_PUBLIC_IPV4_URLS = [
  "http://0.0.0.1/",
  "http://10.0.0.1/",
  "http://100.64.0.1/",
  "http://127.0.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://172.16.0.1/",
  "http://192.0.0.1/",
  "http://192.0.2.1/",
  "http://192.88.99.1/",
  "http://192.168.0.1/",
  "http://198.18.0.1/",
  "http://198.51.100.1/",
  "http://203.0.113.1/",
  "http://224.0.0.1/",
  "http://240.0.0.1/",
  "http://255.255.255.255/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://127.1/",
];

const NON_PUBLIC_IPV6_URLS = [
  "http://[::]/",
  "http://[0:0:0:0:0:0:0:0]/",
  "http://[::1]/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://[::127.0.0.1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[0:0:0:0:0:ffff:7f00:1]/",
  "http://[::FFFF:7F00:0001]/",
  "http://[::ffff:10.0.0.1]/",
  "http://[::ffff:a00:1]/",
  "http://[::ffff:172.16.0.1]/",
  "http://[::ffff:ac10:1]/",
  "http://[::ffff:172.31.255.255]/",
  "http://[::ffff:ac1f:ffff]/",
  "http://[::ffff:192.168.0.1]/",
  "http://[::ffff:c0a8:1]/",
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[::ffff:0.0.0.0]/",
  "http://[::ffff:0:0]/",
  "http://[::ffff:100.64.0.1]/",
  "http://[::ffff:6440:1]/",
  "http://[::ffff:198.18.0.1]/",
  "http://[::ffff:c612:1]/",
  "http://[::ffff:224.0.0.1]/",
  "http://[::ffff:e000:1]/",
  "http://[::ffff:255.255.255.255]/",
  "http://[::ffff:ffff:ffff]/",
  "http://[::ffff:0:1.1.1.1]/",
  "http://[::ffff:0:127.0.0.1]/",
  "http://[64:ff9b::127.0.0.1]/",
  "http://[64:ff9b:1::1]/",
  "http://[100::1]/",
  "http://[100:0:0:1::1]/",
  "http://[200::1]/",
  "http://[400::1]/",
  "http://[800::1]/",
  "http://[1000::1]/",
  "http://[1fff::1]/",
  "http://[2001:2::1]/",
  "http://[2001:10::1]/",
  "http://[2001:20::1]/",
  "http://[2001:100::1]/",
  "http://[2001:db8::1]/",
  "http://[2002:7f00:1::1]/",
  "http://[2002:6440:1::1]/",
  "http://[3ffe::1]/",
  "http://[3fff::1]/",
  "http://[5f00::1]/",
  "http://[4000::1]/",
  "http://[8000::1]/",
  "http://[fc00::1]/",
  "http://[fe00::1]/",
  "http://[fe80::1]/",
  "http://[fec0::1]/",
  "http://[ff02::1]/",
];

const LOCAL_HOSTNAME_URLS = [
  "http://localhost./",
  "http://foo.localhost./",
  "http://printer.local./",
  "http://service.internal./",
  "http://metadata.google.internal./computeMetadata/v1/",
  "http://home.arpa/",
  "http://router.home.arpa./",
  "http://localhost%2e/",
  "http://localhost。/",
  "http://localhost．/",
  "http://localhost｡/",
];

test("public URL admission rejects non-public IPv4, IPv6, and hostname parser forms", () => {
  for (const url of [...NON_PUBLIC_IPV4_URLS, ...NON_PUBLIC_IPV6_URLS, ...LOCAL_HOSTNAME_URLS]) {
    assert.throws(
      () => assertPublicHttpUrl(url),
      (error) => error?.status === 400 && error?.message === "Private or local network URLs are not allowed",
      url,
    );
  }
});

test("public URL admission preserves globally routable addresses", () => {
  for (const url of [
    "https://1.1.1.1/",
    "https://8.8.8.8/",
    "https://[2000::1]/",
    "https://[2606:4700:4700::1111]/dns-query",
    "https://[2606:4700:4700:0:0:0:0:1111]/dns-query",
    "https://[2001:4860:4860::8888]/",
    "https://[::ffff:1.1.1.1]/",
    "https://[2002:808:808::1]/",
    "https://example.com./",
  ]) {
    assert.equal(assertPublicHttpUrl(url).protocol, "https:", url);
  }
});

test("exported direct, Kitesurf, Chromium, and screenshot boundaries reject before I/O", async () => {
  let browserCalls = 0;
  let directCalls = 0;
  const browser = {
    async fetch() {
      browserCalls += 1;
      throw new Error("browser must not run");
    },
    async quickAction() {
      browserCalls += 1;
      throw new Error("browser must not run");
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    directCalls += 1;
    throw new Error("direct fetch must not run");
  };
  try {
    for (const strategy of ["direct", "kitesurf", "chromium"]) {
      await assert.rejects(
        () => renderAdaptive({
          url: new URL("http://[ff02::1]/"),
          env: { DB: null, BROWSER: browser },
          strategy,
        }),
        (error) => error?.status === 400 && error?.message === "Private or local network URLs are not allowed",
        strategy,
      );
    }
    await assert.rejects(
      () => captureKitesurfScreenshot({
        url: new URL("http://localhost./preview"),
        env: { DB: null, BROWSER: browser },
      }),
      (error) => error?.status === 400 && error?.message === "Private or local network URLs are not allowed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(browserCalls, 0);
  assert.equal(directCalls, 0);
});
