import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function loadBudgetCapacityLabel() {
  const start = appSource.indexOf("function budgetCapacityLabel(");
  const end = appSource.indexOf("\nfunction renderBudget()", start);
  assert.ok(start >= 0 && end > start, "budget capacity label helper is present");
  const context = {};
  vm.runInNewContext(`${appSource.slice(start, end)}\nthis.label = budgetCapacityLabel;`, context);
  return context.label;
}

test("the budget selector preserves Custom as a displayed state, not a selectable preset", () => {
  assert.match(appSource, /const option = customOption \|\| document\.createElement\("option"\)/);
  assert.match(appSource, /option\.value = "custom"/);
  assert.match(appSource, /option\.disabled = true/);
  assert.match(appSource, /selector\.value = "custom"/);
  assert.match(appSource, /customOption\?\.remove\(\)/);
});

test("lower-only and Free-capped custom profiles retain accurate capacity labels", () => {
  const label = loadBudgetCapacityLabel();
  assert.equal(label("custom", false, false), "Custom limits active");
  assert.equal(label("custom", false, true), "Custom plan selected · Free ceiling active");
  assert.equal(label("custom", true, true), "Custom limits · higher Worker limits confirmed");
  assert.equal(label("cheap", false, true), "Low-cost plan selected · Free limits active");
});
