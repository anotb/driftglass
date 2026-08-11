import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isMissingPathError, toErrorResponse } = require("../.test-dist/utils.js");

test("Budget Governor deferrals become a typed bounded response", async () => {
  const error = Object.assign(new Error("internal budget detail"), {
    name: "BudgetDeferredError",
    dimension: "browser_ms",
    requested: 1_000,
    remaining: 0,
  });
  const response = toErrorResponse(error);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(await response.json(), {
    ok: false,
    status: "deferred",
    code: "BUDGET_DEFERRED",
    error: "Budget Governor deferred browser_ms",
    budget: { dimension: "browser_ms", requested: 1_000, remaining: 0 },
  });
});

test("workspace missing-path errors are recognized without hiding unrelated failures", () => {
  assert.equal(isMissingPathError(Object.assign(new Error("no such file: /notes/missing.md"), { code: "ENOENT" })), true);
  assert.equal(isMissingPathError(new Error("WorkspaceFsError: no such path: /notes/missing.md")), true);
  assert.equal(isMissingPathError(new Error("Durable Object temporarily unavailable")), false);
});
