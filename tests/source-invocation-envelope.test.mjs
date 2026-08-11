import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { d1QueryEnvelope, getBudgetProfile, sourceRunConcurrency, sourceRunsPerInvocation } = require("../.test-dist/budget.js");
const {
  allocateSourceBoundaryAttempts,
  SOURCE_BOUNDARY_CALL_LIMIT,
} = require("../.test-dist/source-execution-envelope.js");
const {
  SCHEDULED_INTERVAL_MS,
  SCHEDULED_LANES,
  runScheduledLane,
  scheduledLaneAt,
  scheduledSourceConcurrency,
  scheduledSourceLimit,
  starterPackSourcePlan,
} = require("../.test-dist/scheduled-envelope.js");

test("source boundary attempt allocation is breadth-first, prioritized, and globally bounded", () => {
  assert.deepEqual(allocateSourceBoundaryAttempts([]), []);
  assert.deepEqual(allocateSourceBoundaryAttempts([{ optional: false }]), [4]);
  assert.deepEqual(
    allocateSourceBoundaryAttempts(Array.from({ length: 8 }, () => ({ optional: false }))),
    [4, 4, 4, 4, 4, 4, 3, 3],
  );
  assert.deepEqual(
    allocateSourceBoundaryAttempts(Array.from({ length: 30 }, () => ({ optional: false }))),
    Array.from({ length: 30 }, () => 1),
  );
  assert.deepEqual(
    allocateSourceBoundaryAttempts(Array.from({ length: 32 }, () => ({ optional: false }))),
    [...Array.from({ length: 30 }, () => 1), 0, 0],
  );
  assert.deepEqual(
    allocateSourceBoundaryAttempts([{ optional: false }], 0),
    [0],
  );
  assert.deepEqual(
    allocateSourceBoundaryAttempts(Array.from({ length: 32 }, () => ({ optional: false })), Number.NaN),
    [...Array.from({ length: 30 }, () => 1), 0, 0],
  );

  const mixed = [
    ...Array.from({ length: 8 }, () => ({ optional: true })),
    ...Array.from({ length: 25 }, () => ({ optional: false })),
  ];
  const mixedAssigned = allocateSourceBoundaryAttempts(mixed);
  assert.deepEqual(mixedAssigned.slice(0, 8), [1, 1, 1, 1, 1, 0, 0, 0]);
  assert.deepEqual(mixedAssigned.slice(8), Array.from({ length: 25 }, () => 1));
  assert.equal(mixedAssigned.reduce((total, attempts) => total + attempts, 0), SOURCE_BOUNDARY_CALL_LIMIT);

  for (const count of [0, 1, 8, 30, 31, 200]) {
    const assigned = allocateSourceBoundaryAttempts(Array.from({ length: count }, () => ({ optional: false })));
    assert.ok(assigned.reduce((total, attempts) => total + attempts, 0) <= SOURCE_BOUNDARY_CALL_LIMIT);
  }
});

test("Free-safe execution permits one tracked source run per Worker invocation", () => {
  assert.equal(sourceRunsPerInvocation("free-safe", 24), 1);
  assert.equal(sourceRunsPerInvocation("cheap", 24), 1, "an old profile value cannot unlock execution capacity");
  assert.equal(sourceRunConcurrency("free-safe", 3), 1);
  assert.equal(d1QueryEnvelope("free-safe"), 46);
  assert.equal(d1QueryEnvelope("cheap"), 46, "unknown capacity values fail closed");
});

test("confirmed expanded source fan-out remains positive and explicitly bounded", () => {
  assert.equal(sourceRunsPerInvocation("expanded-confirmed", 5), 5);
  assert.equal(sourceRunsPerInvocation("expanded-confirmed", 999), 12);
  assert.equal(sourceRunsPerInvocation("expanded-confirmed", 0), 1);
  assert.equal(sourceRunsPerInvocation("expanded-confirmed", Number.NaN), 1);
  assert.equal(sourceRunConcurrency("expanded-confirmed", 99), 3);
  assert.equal(d1QueryEnvelope("expanded-confirmed"), 900);
});

test("five-minute Cron lanes are deterministic, starvation-safe, and capacity-bounded", () => {
  assert.equal(SCHEDULED_INTERVAL_MS, 300_000);
  assert.equal(SCHEDULED_LANES.length, 12);
  const origin = 300_000 * 120;
  assert.deepEqual(
    Array.from({ length: 12 }, (_, index) => scheduledLaneAt(origin + index * SCHEDULED_INTERVAL_MS)),
    SCHEDULED_LANES,
  );
  assert.deepEqual(
    SCHEDULED_LANES.map((lane, index) => lane === "source" ? index : -1).filter((index) => index >= 0),
    [0, 6],
  );
  assert.equal(scheduledSourceLimit("free-safe"), 1);
  assert.equal(scheduledSourceLimit("expanded-confirmed"), 12);
  assert.equal(scheduledSourceConcurrency("expanded-confirmed"), 3);
  assert.equal(scheduledSourceConcurrency("free-safe"), 1);
  assert.throws(() => scheduledLaneAt(Number.NaN), /invalid/);
});

test("scheduled dispatch executes exactly one selected lane and never falls through", async () => {
  const calls = [];
  const handlers = Object.fromEntries(
    [...new Set(SCHEDULED_LANES)].map((lane) => [lane, async () => { calls.push(lane); }]),
  );
  const slot = 17;
  const lane = await runScheduledLane(slot * SCHEDULED_INTERVAL_MS, handlers);
  assert.equal(lane, SCHEDULED_LANES[slot % SCHEDULED_LANES.length]);
  assert.deepEqual(calls, [lane]);
});

test("starter Pack install never combines Free-safe writes with source collection", () => {
  assert.deepEqual(starterPackSourcePlan("free-safe", true, 10), { scheduled: 10, immediate: 0, deferred: 10 });
  assert.deepEqual(starterPackSourcePlan("expanded-confirmed", true, 10), { scheduled: 10, immediate: 8, deferred: 2 });
  assert.deepEqual(starterPackSourcePlan("free-safe", false, 10), { scheduled: 0, immediate: 0, deferred: 0 });
});

test("custom budget profile and limits load in one D1 statement", async () => {
  let queries = 0;
  const db = {
    prepare(query) {
      assert.match(query, /budget_profile[\s\S]*budget_custom_limits[\s\S]*execution_capacity/);
      return {
        async all() {
          queries += 1;
          return {
            results: [
              { key: "budget_profile", value: "custom" },
              { key: "budget_custom_limits", value: JSON.stringify({ source_runs_day: 7 }) },
            ],
          };
        },
      };
    },
  };
  const result = await getBudgetProfile(db);
  assert.equal(queries, 1);
  assert.equal(result.profile, "custom");
  assert.equal(result.executionCapacity, "free-safe");
  assert.equal(result.limits.source_runs_day, 7);
  assert.equal(result.plannedLimits.source_runs_day, 7);
  assert.equal(result.effectiveLimits.source_runs_day, 7);
});

test("Cron, run-due, starter Packs, and owner controls use the persisted execution capacity", async () => {
  const [workerSource, apiSource, intelligenceApiSource, readinessSource, profileSource, appSource, htmlSource] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/intelligence-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/profile.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(workerSource, /runScheduledLane\(scheduledAt,/);
  assert.match(workerSource, /scheduledSourceLimit\(executionCapacity\)/);
  assert.match(workerSource, /scheduledSourceConcurrency\(executionCapacity\)/);
  assert.match(workerSource, /dueSources\(env\.DB, isoNow\(\), \{ deferOpenAlex: !env\.OPENALEX_API_KEY\?\.trim\(\) \}\)/);
  assert.match(workerSource, /\.filter\(\(source\) => sourceRuntimeAccess\(source, env\)\.runnable\)[\s\S]*\.slice\(0, invocationLimit\)/);
  assert.match(workerSource, /invocationLimit === 1[\s\S]*runSource\(sources\[0\]!?, env\)/);
  assert.match(workerSource, /new Date\(controller\.scheduledTime\)/);
  assert.doesNotMatch(workerSource, /startDueMissionSprints\(env, 3\)/);
  assert.doesNotMatch(workerSource, /backfillEvidenceLineage\(env, 40\)/);

  assert.match(apiSource, /path === "\/api\/sources\/run-due"[\s\S]*sourceRunsPerInvocation\(executionCapacity, 12\)/);
  assert.match(apiSource, /sourceRunConcurrency\(executionCapacity, 3\)/);
  assert.match(apiSource, /dueSources\(env\.DB, isoNow\(\), \{ deferOpenAlex: !env\.OPENALEX_API_KEY\?\.trim\(\) \}\)/);
  assert.match(apiSource, /access\.filter\(\(entry\) => entry\.access\.runnable\)[\s\S]*\.slice\(0, invocationLimit\)/);
  assert.match(apiSource, /prerequisiteDeferred: deferred\.length/);
  assert.match(apiSource, /selected\.slice\(index, index \+ concurrency\)/);
  assert.match(apiSource, /starterPackSourcePlan\(executionCapacity, body\.runNow !== false, pack\.sources\.length\)/);
  assert.match(apiSource, /\.\.\.plan/);
  assert.match(intelligenceApiSource, /path === "\/api\/budget\/execution-capacity"[\s\S]*typeof body\.confirmedWorkersPaid !== "boolean"[\s\S]*setExecutionCapacity/);
  assert.match(readinessSource, /executionCapacity: budget\.executionCapacity/);
  assert.match(profileSource, /budget: \{ profile: budget\.profile, limits: budget\.limits \}/);
  assert.doesNotMatch(profileSource, /budget:\s*\{[^}]*executionCapacity/);
  assert.match(htmlSource, /id="workers-paid-confirmed"/);
  assert.match(appSource, /\/api\/budget\/execution-capacity/);
  assert.match(appSource, /const limitKeys = \{[\s\S]*ai_search_queries: "ai_search_queries_month"/);
  assert.match(appSource, /const effectiveLimits = budget\.effectiveLimits \|\| budget\.limits \|\| \{\}/);
  assert.match(appSource, /const plannedLimits = budget\.plannedLimits \|\| effectiveLimits/);
  assert.match(appSource, /const limit = Number\(effectiveLimits\[limitKeys\[dimension\]\] \?\? 0\)/);
  assert.doesNotMatch(appSource, /const limit = used \+ remaining/);
  assert.match(appSource, /\$\{budgetValue\(dimension, remaining\)\} left/);
  assert.doesNotMatch(appSource, /reserved headroom/);
  assert.match(appSource, /const previous = !confirmedWorkersPaid[\s\S]*control\.disabled = true[\s\S]*await api\("\/api\/budget\/execution-capacity"[\s\S]*saved = true;[\s\S]*await loadAll\(\)[\s\S]*if \(!saved\) control\.checked = previous[\s\S]*toast\(error\.message, "error"\)[\s\S]*control\.disabled = false/);
});

test("multi-source callers use an ID-only loopback boundary with self-host fallback", async () => {
  const [boundarySource, routineSource, missionSource, workerSource, apiSource, wranglerSource] = await Promise.all([
    readFile(new URL("../src/source-run-boundary.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routine-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mission-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  assert.match(boundarySource, /class SourceRunBoundary extends WorkerEntrypoint<Env>/);
  assert.match(boundarySource, /async runSource\(sourceId: string/);
  assert.match(boundarySource, /getSource\(this\.env\.DB, sourceId\)/);
  assert.doesNotMatch(boundarySource, /source\.config_json/);
  assert.match(boundarySource, /SOURCE_ERROR_MESSAGE_LIMIT = 500/);
  assert.match(boundarySource, /kind: isWorkersSubrequestLimitError\(error\) \? "capacity" : "error"/);

  assert.match(routineSource, /allocateSourceBoundaryAttempts\(requests\)/);
  assert.match(routineSource, /retries: \{ limit: assignedAttempts - 1/);
  assert.match(routineSource, /runWorkflowSourceAcrossBoundary\(boundary, sourceId\)/);
  assert.match(missionSource, /allocateSourceBoundaryAttempts\(sourceIds\.map/);
  assert.match(missionSource, /retries: \{ limit: assignedAttempts - 1/);
  assert.match(missionSource, /runWorkflowSourceAcrossBoundary\(boundary, sourceId\)/);

  assert.match(workerSource, /ctx\.exports\.SourceRunBoundary/);
  assert.match(apiSource, /runSourceWithBoundaryFallback\([\s\S]*ctx\.exports\.SourceRunBoundary,[\s\S]*\{ resumeOutbox: false \}/);
  assert.match(apiSource, /runSourceWithBoundaryFallback\([\s\S]*ctx\.exports\.SourceRunBoundary,[\s\S]*\{ resumeOutbox: !resumedOutbox \}/);

  const compatibilityDate = wranglerSource.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  assert.ok(compatibilityDate && compatibilityDate >= "2025-11-17", "ctx.exports must be enabled by compatibility date");
  assert.doesNotMatch(wranglerSource, /enable_ctx_exports/, "the now-default compatibility flag must not be repeated");
});
