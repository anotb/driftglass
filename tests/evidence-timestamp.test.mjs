import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  canonicalEvidenceTimestamp,
  canonicalEvidenceTimestampSql,
} = require("../.test-dist/evidence-timestamp.js");

test("JavaScript and SQLite enforce the same explicit evidence timestamp policy", () => {
  const cases = [
    ["2026-08-07T01:41:49Z", "2026-08-07T01:41:49.000Z"],
    ["  2026-08-07T01:41:49Z  ", "2026-08-07T01:41:49.000Z"],
    ["\t2026-08-07T01:41:49Z\n", null],
    ["2026-08-07T03:41:49+02:00", "2026-08-07T01:41:49.000Z"],
    ["2026-08-07T03:41:49.123+02:00", "2026-08-07T01:41:49.123Z"],
    ["2026-08-07T01:41:49.0009Z", null],
    ["2026-08-07T03:41:49.1236+02:00", null],
    ["Wed, 29 Jul 2026 01:53:39 GMT", "2026-07-29T01:53:39.000Z"],
    ["Wed, 9 Jul 2026 01:53:39 +0000", "2026-07-09T01:53:39.000Z"],
    ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
    ["Fri, 31 Dec 9999 23:59:59 GMT", "9999-12-31T23:59:59.000Z"],
    ["1000-01-01T00:00:00+14:00", null],
    ["9999-12-31T23:59:59-14:00", null],
    ["2026-08-07", null],
    ["2026-08-07T01:41:49", null],
    ["2026-02-30T01:41:49Z", null],
    ["Wed, 31 Feb 2026 01:53:39 GMT", null],
    ["2461000", null],
    [2461000, null],
    ["2026-08-07T01:41:49+14:01", null],
    ["2026-08-07T24:00:00Z", null],
  ];
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE evidence_timestamp_fixture(value)");
  const insert = database.prepare("INSERT INTO evidence_timestamp_fixture(value) VALUES (?)");
  const expression = canonicalEvidenceTimestampSql("value");
  const select = database.prepare(`SELECT ${expression} AS canonical FROM evidence_timestamp_fixture`);

  for (const [value, expected] of cases) {
    database.exec("DELETE FROM evidence_timestamp_fixture");
    insert.run(value);
    assert.equal(canonicalEvidenceTimestamp(value), expected, `JavaScript policy mismatch for ${value}`);
    assert.equal(select.get().canonical ?? null, expected, `SQLite policy mismatch for ${value}`);
  }
});
