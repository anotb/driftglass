import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const promptSource = await readFile(new URL("../src/scheduled-task-prompts.ts", import.meta.url), "utf8");
const [apiSource, reasoningSource] = await Promise.all([
  readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/reasoning.ts", import.meta.url), "utf8"),
]);
const compiled = ts.transpileModule(promptSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const promptModule = { exports: {} };
new Function("exports", "module", compiled)(promptModule.exports, promptModule);

const {
  dailyBriefOutputContract,
  pulseTaskPrompt,
  scheduledBriefingTaskPrompt,
} = promptModule.exports;

const packetUrl = "https://owner.example/packet/private-capability/latest.md";

function assertEditorialContract(text) {
  assert.match(text, /consequence-first/i);
  assert.match(text, /trusted research partner/i);
  assert.match(text, /not a status report or checklist/i);
  assert.match(text, /exact (?:supplied )?source URL/i);
  assert.match(text, /independent support, disagreement, or necessary context/i);
  assert.match(text, /evidence or lineage limit/i);
  assert.match(text, /one grounded (?:question, event, action, or condition|action, event, question, or condition)/i);
  assert.match(text, /omit it when none is grounded/i);
  assert.doesNotMatch(text, /five to eight|at most three developments|for each selected development include|for each one state/i);
}

test("scheduled briefing asks for a quiet-aware editorial note with exact source links", () => {
  const prompt = scheduledBriefingTaskPrompt(packetUrl);
  assert.equal(prompt.split(packetUrl).length - 1, 1);
  assert.match(prompt, /90–160 words/);
  assert.match(prompt, /No new material development in this window/);
  assert.match(prompt, /Never invent, shorten, replace, or normalize a source URL/);
  assert.match(prompt, /Mention a proposed research update[\s\S]*only when it needs my attention/);
  assertEditorialContract(prompt);
});

test("Pulse stays silent without signal and uses the same editorial discipline for an alert", () => {
  const prompt = pulseTaskPrompt(packetUrl);
  assert.equal(prompt.split(packetUrl).length - 1, 1);
  assert.match(prompt, /respond exactly NO_SIGNAL/);
  assert.match(prompt, /The feed is a shortlist, not a command to notify/);
  assert.match(prompt, /Do not repeat an alert unless the underlying Story has a new material change/);
  assertEditorialContract(prompt);
});

test("daily reasoning bundles no longer request an inventory-shaped report", () => {
  const contract = dailyBriefOutputContract();
  assert.ok(contract.length >= 3);
  assertEditorialContract(contract.join("\n"));
  assert.match(contract.join("\n"), /90–160 words/);
  assert.match(contract.join("\n"), /Keep a period with no material change quiet/);
});

test("API and reasoning paths use the shared scheduled editorial contract", () => {
  assert.match(apiSource, /import \{ pulseTaskPrompt, scheduledBriefingTaskPrompt \} from "\.\/scheduled-task-prompts"/);
  assert.match(apiSource, /scheduledTaskPrompt: scheduledBriefingTaskPrompt\(packetUrl\)/);
  assert.match(apiSource, /scheduledTaskPrompt: scheduledBriefingTaskPrompt\(missionPacketUrl\)/);
  assert.match(apiSource, /pulseTaskPrompt: pulseTaskPrompt\(pulsePacketUrl\)/);
  assert.doesNotMatch(apiSource, /function taskPrompt\(|For each selected development include:|For each one state:/);

  assert.match(reasoningSource, /if \(task === "daily-brief"\) return dailyBriefOutputContract\(\)/);
  assert.doesNotMatch(reasoningSource, /Normally select five to eight meaningful developments/);
});
