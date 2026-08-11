import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  estimateMissionSprintWorkflowSteps,
  refreshMissionReminders,
  startDueMissionSprints,
} = require("../.test-dist/mission-autopilot.js");
const { startDueIntelligenceRoutines } = require("../.test-dist/intelligence-routines.js");
const { backfillEvidenceLineage } = require("../.test-dist/evidence-lineage.js");

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrations = await Promise.all(migrationNames.map(async (name) => ({
  name,
  sql: await readFile(new URL(name, migrationDirectory), "utf8"),
})));

class SqliteD1Statement {
  constructor(owner, query) {
    this.owner = owner;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.owner.record("run", this);
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.owner.record("first", this);
    return this.owner.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.owner.record("all", this);
    return { success: true, results: this.owner.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
    this.calls = [];
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
  }

  record(method, statement) {
    this.queryCount += 1;
    this.calls.push({ method, query: statement.query, values: [...statement.values] });
  }

  resetCount() {
    this.queryCount = 0;
    this.calls = [];
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  return { database, d1: new SqliteD1(database) };
}

function insertMission(database, {
  id,
  priority = 1,
  expectedBy = null,
  reminderLeadDays = 3,
  sprintPolicy = "manual",
  nextSprintAt = null,
} = {}) {
  database.prepare(
    `INSERT INTO missions(
       id, name, question, terms_json, source_scope_json, status, priority,
       cadence_minutes, created_at, updated_at
     ) VALUES (?, ?, 'Question', '[]', '[]', 'active', ?, 60, ?, ?)`,
  ).run(id, `Mission ${id}`, priority, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare(
    `INSERT INTO mission_operators(
       mission_id, expected_next_event, expected_by, outcome_status,
       sprint_policy, next_sprint_at, reminder_lead_days, expected_event_status
     ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    id,
    expectedBy ? `Expected event for ${id}` : "",
    expectedBy,
    sprintPolicy,
    nextSprintAt,
    reminderLeadDays,
    expectedBy ? "pending" : "none",
  );
}

test("mission reminders use one capped candidate read and bounded deduplicated writes", async () => {
  const { database, d1 } = fixture();
  const now = new Date("2026-08-07T12:00:00.000Z");
  for (let index = 0; index < 20; index += 1) {
    const expectedBy = index < 10
      ? new Date(now.getTime() - (10 - index) * 86_400_000).toISOString()
      : new Date(now.getTime() + (index - 9) * 3_600_000).toISOString();
    insertMission(database, { id: `reminder-${String(index).padStart(2, "0")}`, expectedBy });
  }

  d1.resetCount();
  assert.equal(await refreshMissionReminders({ DB: d1 }, now), 12);
  assert.equal(d1.queryCount, 13, "one candidate read plus twelve event writes");
  const candidateRead = d1.calls.find((call) => call.query.includes("WITH candidates AS"));
  assert.equal(candidateRead?.values.at(-1), 12);
  const firstEvents = database.prepare(
    "SELECT mission_id, title FROM mission_events ORDER BY occurred_at, mission_id",
  ).all();
  assert.equal(firstEvents.length, 12);
  assert.equal(firstEvents.filter((event) => event.title.includes("overdue")).length, 10);
  assert.equal(firstEvents.filter((event) => event.title.includes("approaching")).length, 2);

  d1.resetCount();
  assert.equal(await refreshMissionReminders({ DB: d1 }, now), 8);
  assert.equal(d1.queryCount, 9, "the next bounded page remains one read plus eight writes");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mission_events").get().count, 20);

  d1.resetCount();
  assert.equal(await refreshMissionReminders({ DB: d1 }, now), 0);
  assert.equal(d1.queryCount, 1, "dedupe is applied in the candidate read without an N+1 scan");
});

test("scheduled Mission Sprint start is hard-capped to one and stays below 50 D1 statements", async () => {
  assert.equal(estimateMissionSprintWorkflowSteps(0), 24);
  assert.equal(estimateMissionSprintWorkflowSteps(1), 28);
  assert.equal(estimateMissionSprintWorkflowSteps(30), 54);
  const { database, d1 } = fixture();
  insertMission(database, {
    id: "sprint-a",
    priority: 2,
    sprintPolicy: "scheduled",
    nextSprintAt: "2026-01-01T00:00:00.000Z",
  });
  insertMission(database, {
    id: "sprint-b",
    priority: 1,
    sprintPolicy: "scheduled",
    nextSprintAt: "2026-01-01T00:00:00.000Z",
  });
  const workflowCalls = [];
  const env = {
    DB: d1,
    MISSION_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input);
        return { id: `accepted-${input.id}` };
      },
    },
  };

  d1.resetCount();
  const started = await startDueMissionSprints(env, 99);
  assert.equal(started.length, 1);
  assert.equal(started[0].missionId, "sprint-a");
  assert.equal(workflowCalls.length, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mission_runs").get().count, 1);
  assert.equal(d1.queryCount, 10, "one scheduled Mission consumes ten D1 statements end to end");
  assert.ok(d1.queryCount < 50);
  const dueRead = d1.calls.find((call) => call.query.includes("o.sprint_policy = 'scheduled'"));
  assert.equal(dueRead?.values.at(-1), 1);
});

test("a failed scheduled Mission launch defers the poison head so the next Mission advances", async () => {
  const { database, d1 } = fixture();
  for (const [id, priority] of [["poison-sprint-a", 2], ["healthy-sprint-b", 1]]) {
    insertMission(database, {
      id,
      priority,
      sprintPolicy: "scheduled",
      nextSprintAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const workflowCalls = [];
  const env = {
    DB: d1,
    MISSION_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input.params.missionId);
        if (input.params.missionId === "poison-sprint-a") throw new Error("bounded launch failure");
        return { id: `accepted-${input.id}` };
      },
    },
  };

  d1.resetCount();
  assert.deepEqual(await startDueMissionSprints(env, 1), []);
  assert.ok(d1.queryCount < 50);
  const failed = database.prepare(
    "SELECT status, completed_at, error, result_json FROM mission_runs WHERE mission_id = 'poison-sprint-a'",
  ).get();
  assert.equal(failed.status, "failed");
  assert.ok(failed.completed_at);
  assert.match(failed.error, /Workflow start failed/);
  assert.equal(JSON.parse(failed.result_json).failedBeforeStart, true);
  const deferred = database.prepare(
    "SELECT last_sprint_at, next_sprint_at FROM mission_operators WHERE mission_id = 'poison-sprint-a'",
  ).get();
  assert.equal(deferred.last_sprint_at, null, "a rejected Workflow is not recorded as a launch");
  assert.ok(Date.parse(deferred.next_sprint_at) > Date.now(), "the poison head is deferred by one bounded slot");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM mission_events WHERE mission_id = 'poison-sprint-a' AND event_type = 'sprint'",
  ).get().count, 0);

  d1.resetCount();
  const advanced = await startDueMissionSprints(env, 1);
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].missionId, "healthy-sprint-b");
  assert.deepEqual(workflowCalls, ["poison-sprint-a", "healthy-sprint-b"]);
  assert.ok(d1.queryCount < 50);
});

test("a pre-create Mission budget deferral cannot starve the next lower-cost due Mission", async () => {
  const { database, d1 } = fixture();
  insertMission(database, {
    id: "high-cost-sprint-a",
    priority: 2,
    sprintPolicy: "scheduled",
    nextSprintAt: "2026-01-01T00:00:00.000Z",
  });
  insertMission(database, {
    id: "lower-cost-sprint-b",
    priority: 1,
    sprintPolicy: "scheduled",
    nextSprintAt: "2026-01-01T00:00:00.000Z",
  });
  const sourceIds = Array.from({ length: 5 }, (_, index) => `fairness-source-${index}`);
  for (const sourceId of sourceIds) {
    database.prepare(
      `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
       VALUES (?, ?, 'web', '{}', 1, 60, 1)`,
    ).run(sourceId, `Source ${sourceId}`);
  }
  database.prepare("UPDATE missions SET source_scope_json = ? WHERE id = 'high-cost-sprint-a'")
    .run(JSON.stringify(sourceIds));
  database.prepare("UPDATE missions SET source_scope_json = ? WHERE id = 'lower-cost-sprint-b'")
    .run(JSON.stringify([sourceIds[0]]));
  database.prepare(
    `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
     VALUES (?, 'workflow_steps', 2366, '{}', ?)`,
  ).run(new Date().toISOString().slice(0, 10), new Date().toISOString());
  const workflowCalls = [];
  const env = {
    DB: d1,
    MISSION_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input.params.missionId);
        return { id: `accepted-${input.id}` };
      },
    },
  };

  d1.resetCount();
  assert.deepEqual(await startDueMissionSprints(env, 1), []);
  assert.equal(workflowCalls.length, 0, "the over-budget Mission fails before Workflow creation");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = 'high-cost-sprint-a'",
  ).get().count, 0);
  const deferred = database.prepare(
    "SELECT last_sprint_at, next_sprint_at FROM mission_operators WHERE mission_id = 'high-cost-sprint-a'",
  ).get();
  assert.equal(deferred.last_sprint_at, null);
  assert.ok(Date.parse(deferred.next_sprint_at) > Date.now());
  assert.ok(d1.queryCount < 50);

  d1.resetCount();
  const advanced = await startDueMissionSprints(env, 1);
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].missionId, "lower-cost-sprint-b");
  assert.deepEqual(workflowCalls, ["lower-cost-sprint-b"]);
  assert.ok(d1.queryCount < 50);
});

test("scheduled Intelligence Routine plans 24 steps from one runtime context under the D1 ceiling", async () => {
  const { database, d1 } = fixture();
  const legacyRoutineId = "pack:cloudflare-agent-week:routine:daily-agent-adoption";
  const definition = {
    id: legacyRoutineId,
    name: "Bounded routine",
    scheduleMinutes: 60,
    budgetClass: "standard",
    steps: Array.from({ length: 24 }, (_, index) => ({
      id: `step-${index}`,
      name: `Step ${index}`,
      action: "wait-for-ingest",
      runtime: "worker",
    })),
  };
  for (const [index, id] of [legacyRoutineId, "routine-b"].entries()) {
    database.prepare(
      `INSERT INTO intelligence_routines(
         id, name, description, definition_json, enabled, schedule_minutes,
         next_run_at, created_at, updated_at
       ) VALUES (?, ?, '', ?, 1, 60, ?, ?, ?)`,
    ).run(
      id,
      `Routine ${id}`,
      JSON.stringify({ ...definition, id, name: `Routine ${id}` }),
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  }
  const workflowCalls = [];
  const env = {
    DB: d1,
    ROUTINE_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input);
        return { id: input.id };
      },
    },
  };

  d1.resetCount();
  const started = await startDueIntelligenceRoutines(env, 99);
  assert.equal(started.length, 1);
  assert.equal(workflowCalls.length, 1);
  assert.equal(workflowCalls[0].params.routineId, legacyRoutineId);
  assert.match(workflowCalls[0].id, /^routine-run-[a-f0-9-]+$/);
  assert.ok(workflowCalls[0].id.length <= 100);
  assert.equal(workflowCalls[0].id.includes(":"), false, "legacy D1 IDs never enter the Workflow instance ID");
  const run = database.prepare("SELECT id, routine_id, workflow_id, plan_json FROM intelligence_routine_runs").get();
  assert.equal(workflowCalls[0].id, workflowCalls[0].params.runId);
  assert.equal(run.id, workflowCalls[0].id);
  assert.equal(run.workflow_id, workflowCalls[0].id);
  assert.equal(run.routine_id, legacyRoutineId);
  assert.equal(JSON.parse(run.plan_json).runtimePlans.length, 24);
  assert.equal(d1.queryCount, 14, "24 pure plans reuse one context and consume fourteen D1 statements");
  assert.ok(d1.queryCount < 50);
  assert.equal(d1.calls.filter((call) => call.query.includes("key = ?") && call.values[0] === "runtime_policy").length, 1);
  assert.equal(d1.calls.filter((call) => call.query.includes("FROM collectors ORDER BY")).length, 1);
  const dueRead = d1.calls.find((call) => call.query.includes("FROM intelligence_routines r"));
  assert.equal(dueRead?.values.at(-1), 1);
});

test("a failed scheduled Routine launch defers the poison head so the next Routine advances", async () => {
  const { database, d1 } = fixture();
  const baseDefinition = {
    name: "Scheduled launch fairness",
    scheduleMinutes: 60,
    budgetClass: "light",
    steps: [{ id: "wait", name: "Wait", action: "wait-for-ingest", runtime: "worker" }],
  };
  for (const id of ["poison-routine-a", "healthy-routine-b"]) {
    database.prepare(
      `INSERT INTO intelligence_routines(
         id, name, description, definition_json, enabled, schedule_minutes,
         next_run_at, created_at, updated_at
       ) VALUES (?, ?, '', ?, 1, 60, '2026-01-01T00:00:00.000Z', ?, ?)`,
    ).run(
      id,
      `Routine ${id}`,
      JSON.stringify({ ...baseDefinition, id, name: `Routine ${id}` }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  }
  const workflowCalls = [];
  const env = {
    DB: d1,
    ROUTINE_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input.params.routineId);
        if (input.params.routineId === "poison-routine-a") throw new Error("bounded launch failure");
        return { id: `accepted-${input.id}` };
      },
    },
  };

  d1.resetCount();
  assert.deepEqual(await startDueIntelligenceRoutines(env, 1), []);
  assert.ok(d1.queryCount < 50);
  const failed = database.prepare(
    "SELECT status, completed_at, error FROM intelligence_routine_runs WHERE routine_id = 'poison-routine-a'",
  ).get();
  assert.equal(failed.status, "failed");
  assert.ok(failed.completed_at);
  assert.match(failed.error, /bounded launch failure/);
  const deferred = database.prepare(
    "SELECT last_run_at, next_run_at FROM intelligence_routines WHERE id = 'poison-routine-a'",
  ).get();
  assert.equal(deferred.last_run_at, null, "a rejected Workflow is not recorded as a launch");
  assert.ok(Date.parse(deferred.next_run_at) > Date.now(), "the poison head is deferred by one bounded slot");

  d1.resetCount();
  const advanced = await startDueIntelligenceRoutines(env, 1);
  assert.equal(advanced.length, 1);
  assert.deepEqual(workflowCalls, ["poison-routine-a", "healthy-routine-b"]);
  assert.equal(database.prepare(
    "SELECT status FROM intelligence_routine_runs WHERE routine_id = 'healthy-routine-b'",
  ).get().status, "queued");
  assert.ok(d1.queryCount < 50);
});

test("a malformed pre-create Routine cannot starve the next due Routine", async () => {
  const { database, d1 } = fixture();
  const healthy = {
    id: "healthy-precreate-routine-b",
    name: "Healthy pre-create Routine",
    scheduleMinutes: 60,
    budgetClass: "light",
    steps: [{ id: "wait", name: "Wait", action: "wait-for-ingest", runtime: "worker" }],
  };
  database.prepare(
    `INSERT INTO intelligence_routines(
       id, name, description, definition_json, enabled, schedule_minutes,
       next_run_at, created_at, updated_at
     ) VALUES ('malformed-precreate-routine-a', 'Malformed', '', '{"invalid":true}', 1, 60,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO intelligence_routines(
       id, name, description, definition_json, enabled, schedule_minutes,
       next_run_at, created_at, updated_at
     ) VALUES (?, ?, '', ?, 1, 60,
               '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(healthy.id, healthy.name, JSON.stringify(healthy));
  const workflowCalls = [];
  const env = {
    DB: d1,
    ROUTINE_WORKFLOW: {
      async create(input) {
        workflowCalls.push(input.params.routineId);
        return { id: `accepted-${input.id}` };
      },
    },
  };

  d1.resetCount();
  assert.deepEqual(await startDueIntelligenceRoutines(env, 1), []);
  assert.equal(workflowCalls.length, 0, "the malformed Routine fails before Workflow creation");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM intelligence_routine_runs WHERE routine_id = 'malformed-precreate-routine-a'",
  ).get().count, 0);
  const deferred = database.prepare(
    "SELECT last_run_at, next_run_at FROM intelligence_routines WHERE id = 'malformed-precreate-routine-a'",
  ).get();
  assert.equal(deferred.last_run_at, null);
  assert.ok(Date.parse(deferred.next_run_at) > Date.now());
  assert.ok(d1.queryCount < 50);

  d1.resetCount();
  const advanced = await startDueIntelligenceRoutines(env, 1);
  assert.equal(advanced.length, 1);
  assert.deepEqual(workflowCalls, ["healthy-precreate-routine-b"]);
  assert.ok(d1.queryCount < 50);
});

test("evidence-lineage backfill hard-caps at 12 and uses 26 D1 statements", async () => {
  const { database, d1 } = fixture();
  database.prepare(
    `INSERT INTO sources(id, name, kind, config_json, enabled, schedule_minutes, weight)
     VALUES ('lineage-source', 'Lineage source', 'web', '{}', 1, 60, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO stories(
       id, canonical_key, title, first_seen_at, last_changed_at
     ) VALUES ('lineage-story', 'lineage-story', 'Lineage Story', ?, ?)`,
  ).run("2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z");
  for (let index = 0; index < 20; index += 1) {
    const observedAt = new Date(Date.parse("2026-08-07T00:00:00.000Z") + index * 60_000).toISOString();
    database.prepare(
      `INSERT INTO items(
         id, source_id, external_id, url, canonical_url, title, text,
         observed_at, content_hash, metadata_json
       ) VALUES (?, 'lineage-source', ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run(
      `lineage-item-${index}`,
      `external-${index}`,
      `https://example.com/evidence/${index}`,
      `https://example.com/evidence/${index}`,
      `Evidence item ${index}`,
      `Distinct evidence body ${index}`,
      observedAt,
      `hash-${index}`,
    );
    database.prepare(
      "INSERT INTO story_items(story_id, item_id) VALUES ('lineage-story', ?)",
    ).run(`lineage-item-${index}`);
  }

  d1.resetCount();
  assert.deepEqual(await backfillEvidenceLineage({ DB: d1 }, 999), { processed: 12, failed: 0 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence_lineage").get().count, 12);
  assert.equal(d1.queryCount, 26, "one enable read, one bounded scan, and two statements per item");
  assert.ok(d1.queryCount < 50);
  assert.equal(d1.calls.filter((call) => call.query.includes("SELECT value FROM settings WHERE key = ?")).length, 1);
  const missingRead = d1.calls.find((call) => call.query.includes("LEFT JOIN evidence_lineage l"));
  assert.equal(missingRead?.values.at(-1), 12);

  d1.resetCount();
  assert.deepEqual(await backfillEvidenceLineage({ DB: d1 }, 12), { processed: 8, failed: 0 });
  assert.equal(d1.queryCount, 18);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence_lineage").get().count, 20);

  d1.resetCount();
  assert.deepEqual(await backfillEvidenceLineage({ DB: d1 }, 12), { processed: 0, failed: 0 });
  assert.equal(d1.queryCount, 2, "an empty backfill is one enable read plus one bounded candidate scan");
});
