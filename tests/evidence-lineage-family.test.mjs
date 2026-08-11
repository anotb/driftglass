import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evidenceFamilyKey } = require("../.test-dist/evidence-lineage.js");

function family({ url, author, metadata }) {
  return evidenceFamilyKey({
    item: {
      url,
      canonical_url: url,
      author,
      metadata_json: JSON.stringify(metadata),
      source_id: "collector-source",
    },
    source: { id: "collector-source", kind: "collector", config_json: "{}" },
  });
}

test("Reddit evidence groups by community before author", () => {
  assert.equal(family({
    url: "https://www.reddit.com/r/MachineLearning/comments/abc/a_post/",
    author: "individual-author",
    metadata: { subreddit: "r/MachineLearning" },
  }), "reddit.com:r/machinelearning");
});

test("X evidence keeps author families", () => {
  assert.equal(family({
    url: "https://x.com/Cloudflare/status/123",
    author: "@Cloudflare",
    metadata: {},
  }), "x.com:cloudflare");
});
