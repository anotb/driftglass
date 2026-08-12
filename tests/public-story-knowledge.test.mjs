import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  fetchPublicStoryKnowledge,
  searchPublicStoryKnowledge,
} = require("../.test-dist/public-story-knowledge.js");

const aggregateStory = {
  id: "story-mixed",
  canonical_key: "mixed",
  title: "PRIVATE aggregate title",
  summary: "PRIVATE aggregate summary from a connected account",
  status: "active",
  first_seen_at: "2026-08-08T08:00:00.000Z",
  last_changed_at: "2026-08-09T15:00:00.000Z",
  score: 99,
  relevance: 1,
  novelty: 1,
  importance: 1,
  confidence: 1,
  source_count: 2,
  metadata_json: "{}",
  created_at: "2026-08-08T08:00:00.000Z",
  updated_at: "2026-08-09T15:00:00.000Z",
};

const publicEvidence = {
  id: "item-public",
  source_id: "source-public",
  external_id: null,
  url: null,
  canonical_url: "https://authority.example/public-filing",
  title: "Public filing changes the schedule",
  text: "The authority moved the public filing deadline to September.",
  author: "Public authority",
  published_at: "2026-08-08T09:00:00.000Z",
  observed_at: "2026-08-08T10:00:00.000Z",
  content_hash: "public-hash",
  raw_r2_key: null,
  access_class: "public",
  metadata_json: "{}",
  created_at: "2026-08-08T10:00:00.000Z",
  source_name: "Public authority",
  source_kind: "web",
  source_health_score: 0.9,
  family_key: "authority.example",
  lineage_relation: "origin",
  lineage_independent: 1,
};

const privateEvidence = {
  ...publicEvidence,
  id: "item-private",
  source_id: "source-private",
  canonical_url: "https://private.example/connected-post",
  title: "PRIVATE connected-source headline",
  text: "PRIVATE connected-source excerpt",
  observed_at: "2026-08-09T15:00:00.000Z",
  access_class: "private",
  source_name: "Connected account",
  source_kind: "collector",
  family_key: "private.example",
};

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

  async first() {
    this.database.queries.push(this.query);
    if (this.query.includes("SELECT * FROM stories WHERE id = ?")) return aggregateStory;
    assert.fail(`unexpected first query: ${this.query}`);
  }

  async all() {
    this.database.queries.push(this.query);
    if (this.query.includes("WITH matching_stories AS") && this.query.includes("GROUP BY si.story_id")) {
      return {
        success: true,
        results: [{
          story_id: aggregateStory.id,
          title: publicEvidence.title,
          canonical_url: publicEvidence.canonical_url,
          url: publicEvidence.url,
          public_changed_at: publicEvidence.observed_at,
          evidence_rank: 1,
        }],
        meta: {},
      };
    }
    if (this.query.includes("SELECT i.*") && this.query.includes("FROM story_items")) {
      return { success: true, results: [privateEvidence, publicEvidence], meta: {} };
    }
    assert.fail(`unexpected all query: ${this.query}`);
  }
}

class ReadOnlyD1 {
  constructor() {
    this.queries = [];
  }

  prepare(query) {
    return new Statement(this, query);
  }
}

test("compact Story search and fetch rebuild every visible field from eligible public evidence", async () => {
  const searchDb = new ReadOnlyD1();
  const search = await searchPublicStoryKnowledge(searchDb, "deadline", 10);
  const fetchDb = new ReadOnlyD1();
  const document = await fetchPublicStoryKnowledge(fetchDb, aggregateStory.id);

  assert.deepEqual(search, {
    results: [{
      id: aggregateStory.id,
      title: "Public filing changes the schedule",
      url: "https://authority.example/public-filing",
    }],
  });
  assert.ok(document);
  assert.equal(document.title, "Public filing changes the schedule");
  assert.equal(document.url, "https://authority.example/public-filing");
  assert.equal(document.metadata.changedAt, publicEvidence.observed_at);
  assert.equal(document.metadata.distinctSources, 1);
  assert.equal(document.metadata.evidence.length, 1);
  assert.equal(document.metadata.evidence[0].accessClass, "public");

  const serialized = JSON.stringify({ search, document });
  assert.doesNotMatch(serialized, /PRIVATE|private\.example|connected-source/);
  assert.equal(searchDb.queries.length, 1, "compact search must consume exactly one D1 statement");
  const publicSearch = searchDb.queries[0];
  assert.match(publicSearch, /i\.access_class = 'public'/);
  assert.match(publicSearch, /source\.kind NOT IN \('email', 'collector'\)/);
  assert.doesNotMatch(publicSearch, /FROM stories|s\.title|s\.summary|s\.score|s\.last_changed_at/);
  assert.doesNotMatch(publicSearch, /SELECT \* FROM stories WHERE id = \?/);
});
