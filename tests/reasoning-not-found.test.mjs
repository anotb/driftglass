import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
let compareReasoningRuns;
let reasoningReceiptDetail;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === "cloudflare:workers") return { WorkflowEntrypoint: class WorkflowEntrypoint {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ compareReasoningRuns, reasoningReceiptDetail } = require("../.test-dist/reasoning-ledger.js"));
} finally {
  Module._load = originalLoad;
}
const { HttpError, toErrorResponse } = require("../.test-dist/utils.js");

class MissingReceiptStatement {
  bind() {
    return this;
  }

  async first() {
    return null;
  }
}

const missingReceiptEnv = {
  DB: {
    prepare(query) {
      assert.match(query, /FROM reasoning_receipts WHERE id = \?/);
      return new MissingReceiptStatement();
    },
  },
};

for (const [label, read] of [
  ["receipt detail", reasoningReceiptDetail],
  ["run comparison", compareReasoningRuns],
]) {
  test(`missing reasoning ${label} returns a typed 404`, async () => {
    let caught;
    try {
      await read(missingReceiptEnv, "receipt-does-not-exist");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof HttpError);
    assert.equal(caught.status, 404);
    assert.equal(caught.message, "Reasoning receipt not found");

    const response = toErrorResponse(caught);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Reasoning receipt not found",
    });
  });
}
