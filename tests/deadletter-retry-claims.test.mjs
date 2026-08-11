import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  claimIngestDeadLetterForRetry,
  completeIngestDeadLetterRetryClaim,
  listIngestDeadLetters,
  releaseIngestDeadLetterRetryClaim,
  resolveIngestDeadLetter,
} = require("../.test-dist/db.js");

class Statement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class D1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new Statement(this.database, query);
  }
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const migration of migrations) database.exec(await readFile(new URL(migration, directory), "utf8"));
  return { database, d1: new D1(database) };
}

function insertDeadLetter(database, id, status = "unresolved", createdAt = "2026-08-07T12:00:00.000Z") {
  database.prepare(
    `INSERT INTO ingest_dead_letters(
       id, queue_message_id, queue_name, source_id, provider, attempts, reason,
       body_json, body_hash, body_bytes, status, created_at, resolved_at
     ) VALUES (?, ?, 'fixture-dlq', 'manual-inbox', 'manual', 4, 'fixture',
               '{"sourceId":"manual-inbox","item":{"title":"fixture"}}',
               'fixture-hash', 61, ?, ?, ?)`,
  ).run(id, `queue-${id}`, status, createdAt, status === "unresolved" ? null : createdAt);
}

test("dead-letter retry claims are atomic, releasable, and clear the body only after completion", async () => {
  const { database, d1 } = await fixture();
  insertDeadLetter(database, "dead-1");

  const first = await claimIngestDeadLetterForRetry(d1, "dead-1", "claim-a");
  assert.equal(first.retry_claim_token, "claim-a");
  await assert.rejects(
    claimIngestDeadLetterForRetry(d1, "dead-1", "claim-b"),
    (error) => error?.status === 409 && /already in progress/.test(error.message),
  );
  await assert.rejects(
    resolveIngestDeadLetter(d1, "dead-1", "ignored"),
    (error) => error?.status === 409 && /already in progress/.test(error.message),
  );

  await releaseIngestDeadLetterRetryClaim(d1, "dead-1", "claim-a");
  await claimIngestDeadLetterForRetry(d1, "dead-1", "claim-c");
  const completed = await completeIngestDeadLetterRetryClaim(d1, "dead-1", "claim-c");
  assert.equal(completed.status, "resolved");
  const stored = database.prepare(
    "SELECT status, body_json, body_bytes, retry_claim_token, retry_claimed_at FROM ingest_dead_letters WHERE id = 'dead-1'",
  ).get();
  assert.deepEqual({ ...stored }, {
    status: "resolved",
    body_json: "{}",
    body_bytes: 0,
    retry_claim_token: null,
    retry_claimed_at: null,
  });
});

test("actionable unresolved dead letters sort ahead of newer resolved history", async () => {
  const { database, d1 } = await fixture();
  insertDeadLetter(database, "actionable", "unresolved", "2026-08-01T00:00:00.000Z");
  for (let index = 0; index < 60; index += 1) {
    insertDeadLetter(database, `resolved-${index}`, "resolved", `2026-08-07T12:${String(index).padStart(2, "0")}:00.000Z`);
  }
  const listed = await listIngestDeadLetters(d1, 50);
  assert.equal(listed.length, 50);
  assert.equal(listed[0].id, "actionable");
  assert.equal(Object.hasOwn(listed[0], "body_json"), false);
  assert.equal(Object.hasOwn(listed[0], "retry_claim_token"), false);
});
