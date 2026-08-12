import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  installIntelligencePack,
  parseIntelligencePack,
  previewIntelligencePack,
} = require("../.test-dist/intelligence-packs.js");

class SqliteD1Statement {
  constructor(client, query) {
    this.client = client;
    this.database = client.database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    this.client.queryCount += 1;
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes || 0) } };
  }

  async first() {
    this.client.queryCount += 1;
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    this.client.queryCount += 1;
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.queryCount = 0;
  }

  prepare(query) {
    return new SqliteD1Statement(this, query);
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

async function migratedDatabase() {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const database = new DatabaseSync(":memory:");
  for (const name of names) database.exec(await readFile(new URL(name, directory), "utf8"));
  return database;
}

test("a clean Intelligence Pack install persists its parent before FK-backed routines", async () => {
  const source = await readFile(new URL("../src/intelligence-packs.ts", import.meta.url), "utf8");
  const installStart = source.indexOf("export async function installIntelligencePack");
  const parentWrite = source.indexOf("await upsertIntelligencePack(env.DB", installStart);
  const routineLoop = source.indexOf("for (const routine of pack.routines", installStart);
  assert.ok(installStart >= 0 && parentWrite > installStart && routineLoop > parentWrite);
});

test("built-in Pack URLs use the asset binding instead of a loop-protected self fetch", async () => {
  const source = await readFile(new URL("../src/intelligence-api.ts", import.meta.url), "utf8");
  assert.match(source, /target\.origin === incoming\.origin/);
  assert.match(source, /env\.ASSETS\.fetch/);
  assert.match(source, /sourceUrl: null/);
});

test("Pack parse rejects a Routine that consumes unsettled refreshed evidence", () => {
  assert.throws(() => parseIntelligencePack({
    driftglassPack: "3",
    id: "invalid-routine-pack",
    version: "1.0.0",
    name: "Invalid routine Pack",
    description: "Must fail at Pack ingress instead of every scheduled launch.",
    cloudSources: [{
      id: "docs",
      name: "Docs",
      kind: "web",
      config: { url: "https://example.com/docs" },
      scheduleMinutes: 360,
      weight: 1,
    }],
    routines: [{
      id: "stale-consumer",
      name: "Stale consumer",
      trigger: "scheduled",
      scheduleMinutes: 360,
      steps: [
        { action: "refresh-sources", sourceIds: ["docs"] },
        { action: "rebuild-mission" },
      ],
    }],
  }), /requires wait-for-ingest after refresh-sources/);
});

test("the Coding Agents Pack keeps a public, bounded, decision-bearing cloud core", async () => {
  const pack = JSON.parse(await readFile(
    new URL("../intelligence-packs/examples/coding-agents.json", import.meta.url),
    "utf8",
  ));
  const sources = pack.cloudSources;
  const byId = new Map(sources.map((source) => [source.id, source]));
  const sourceIds = [
    "coding-agent-releases",
    "coding-agent-activity",
    "coding-agent-mcp",
    "coding-agent-hn",
    "coding-agent-research",
  ];

  assert.equal(pack.version, "3.1.0");
  assert.deepEqual(sources.map((source) => source.id), sourceIds);
  assert.deepEqual(sources.map((source) => source.kind), [
    "web_feed",
    "web_feed",
    "web_feed",
    "hackernews",
    "arxiv",
  ]);
  assert.ok(sources.every((source) => !["github_releases", "github_activity", "openalex"].includes(source.kind)));

  const official = [
    ["coding-agent-releases", "https://github.com/openai/codex/releases/tag/rust-v0.147.0", 4],
    ["coding-agent-activity", "https://github.com/anthropics/claude-code/releases/tag/v2.1.226", 10],
    ["coding-agent-mcp", "https://blog.modelcontextprotocol.io/posts/2026-07-28/", 4],
  ];
  for (const [sourceId, articleUrl, maxArticles] of official) {
    const source = byId.get(sourceId);
    assert.equal(source.config.renderStrategy, "direct", sourceId);
    assert.equal(source.config.articleRenderStrategy, "direct", sourceId);
    assert.equal(source.config.fetchArticles, true, sourceId);
    assert.equal(source.config.maxArticles, maxArticles, sourceId);
    assert.equal(source.config.estimatedItemsPerRun, maxArticles, sourceId);
    const article = new URL(articleUrl);
    assert.match(`${article.pathname}${article.search}\narticle`, new RegExp(source.config.includePattern, "i"), sourceId);
    assert.notEqual(articleUrl.replace(/\/$/, ""), source.config.url.replace(/\/$/, ""), `${sourceId} cites articles, not its listing`);
  }
  assert.doesNotMatch(
    "/openai/codex/releases/tag/rust-v0.148.0-alpha.5\n0.148.0-alpha.5",
    new RegExp(byId.get("coding-agent-releases").config.includePattern, "i"),
  );
  assert.equal(byId.get("coding-agent-research").config.query, "\"coding agent\"");
  assert.equal(byId.get("coding-agent-research").config.limit, 8);
  assert.equal(byId.get("coding-agent-hn").config.minScore, 20);

  assert.deepEqual(pack.missions[0].sourceScope, sourceIds);
  assert.deepEqual(pack.routines[0].steps.find((step) => step.action === "refresh-sources").sourceIds, sourceIds);
  assert.equal(pack.budget.maxSources, 7);
  assert.equal(pack.budget.projectedRunsPerDay, 20);
});

test("shipped Pack cloud/full previews and runtime counters agree under Free", async () => {
  const expected = [
    ["ai-infrastructure-power.json", 44, 46, 516, 266],
    ["cloudflare-agent-week.json", 42, 44, 1048, 532],
    ["coding-agents.json", 46, 50, 1080, 548],
  ];
  const [apiSource, appSource] = await Promise.all([
    readFile(new URL("../src/intelligence-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(apiSource, /preview: await previewIntelligencePack\(env, pack, profile\)/);
  assert.match(appSource, /queries: preview\.estimatedInstallQueries/);
  assert.match(appSource, /queries: preview\.withCompanionEstimatedInstallQueries/);
  assert.match(appSource, /const cloudFit = Boolean\(preview\.fitsProfile\)/);
  assert.match(appSource, /const fullFit = Boolean\(preview\.fitsWithCompanion\)/);

  for (const [file, expectedCloudQueries, expectedFullQueries, expectedWorkflowSteps, expectedRoutineSteps] of expected) {
    const pack = parseIntelligencePack(JSON.parse(
      await readFile(new URL(`../intelligence-packs/examples/${file}`, import.meta.url), "utf8"),
    ));
    const cloudDatabase = await migratedDatabase();
    const cloudD1 = new SqliteD1(cloudDatabase);
    const preview = await previewIntelligencePack({ DB: cloudD1 }, pack);
    assert.equal(preview.profile, "free", `${file} previews against Free`);
    assert.equal(preview.estimatedInstallQueries, expectedCloudQueries, `${file} cloud estimate`);
    assert.equal(preview.withCompanionEstimatedInstallQueries, expectedFullQueries, `${file} full estimate`);
    assert.equal(preview.projectedWorkflowStepsPerDay, expectedWorkflowSteps, `${file} uses runtime retry ceilings`);
    assert.equal(preview.projectedRoutineStepsPerDay, expectedRoutineSteps, `${file} routine projection uses the runtime estimator`);
    assert.equal(pack.budget.workflowStepsPerDay, expectedWorkflowSteps, `${file} declares its projected Workflow cost`);
    assert.equal(preview.installFitsInvocation, true, `${file} cloud core fits the hard invocation envelope`);
    assert.equal(preview.withCompanionInstallFitsInvocation, expectedFullQueries <= 46, `${file} full hard-envelope result`);
    assert.equal(preview.fitsProfile, true, `${file} cloud core fits the complete Free projection`);
    const cloudSources = [...(pack.sources || []), ...(pack.cloudSources || [])].filter((source) => source.kind !== "collector");
    const openAlexCount = cloudSources.filter((source) => source.kind === "openalex").length;
    assert.equal(preview.credentialDeferredSourceCount, openAlexCount, `${file} reports optional OpenAlex setup`);
    assert.equal(preview.immediatelyRunnableCloudSourceCount, cloudSources.length - openAlexCount, `${file} reports immediate cloud lanes`);
    if (openAlexCount) {
      assert.match(preview.warnings.join("\n"), /OPENALEX_API_KEY/);
      const keyedPreview = await previewIntelligencePack({ DB: cloudD1, OPENALEX_API_KEY: "pack-preview-key" }, pack);
      assert.equal(keyedPreview.credentialDeferredSourceCount, 0);
      assert.equal(keyedPreview.immediatelyRunnableCloudSourceCount, cloudSources.length);
      assert.equal(keyedPreview.projectedSourceRunsPerDay, preview.projectedSourceRunsPerDay, "credential state does not understate eventual runs");
      assert.equal(keyedPreview.projectedQueueMessagesPerDay, preview.projectedQueueMessagesPerDay, "credential state does not understate eventual Queue cost");
    }

    cloudD1.queryCount = 0;
    const cloudResult = await installIntelligencePack({ DB: cloudD1 }, pack);
    assert.equal(cloudResult.preview.estimatedInstallQueries, expectedCloudQueries);
    assert.equal(cloudD1.queryCount, expectedCloudQueries, `${file} cloud runtime equals preview`);
    assert.ok(cloudD1.queryCount < 47, `${file} cloud runtime stays inside the Free hard envelope`);
    assert.equal(
      cloudDatabase.prepare("SELECT COUNT(*) AS count FROM sources WHERE kind = 'collector'").get().count,
      0,
      `${file} cloud install excludes Companion lanes`,
    );
    cloudDatabase.close();

    const fullDatabase = await migratedDatabase();
    const fullD1 = new SqliteD1(fullDatabase);
    const fullPreview = await previewIntelligencePack({ DB: fullD1 }, pack);
    if (expectedFullQueries <= 46) {
      assert.equal(fullPreview.fitsWithCompanion, true, `${file} full Pack fits the complete Free projection`);
      fullD1.queryCount = 0;
      const fullResult = await installIntelligencePack({ DB: fullD1 }, pack, null, { includeCompanionSources: true });
      assert.equal(fullResult.preview.withCompanionEstimatedInstallQueries, expectedFullQueries);
      assert.equal(fullD1.queryCount, expectedFullQueries, `${file} full runtime equals preview`);
      assert.ok(fullD1.queryCount < 47, `${file} full runtime stays inside the Free hard envelope`);
    } else {
      assert.equal(fullPreview.fitsWithCompanion, false, `${file} full Pack is correctly blocked on Free`);
      fullD1.queryCount = 0;
      await assert.rejects(
        installIntelligencePack({ DB: fullD1 }, pack, null, { includeCompanionSources: true }),
        new RegExp(`full Pack is estimated at ${expectedFullQueries} D1 queries`),
      );
      assert.equal(fullD1.queryCount, 5, `${file} blocked full install remains read-only`);
    }
    fullDatabase.close();
  }
});

test("Pack fit uses retry-aware Workflow cost near the Free daily limit", async () => {
  const pack = parseIntelligencePack(JSON.parse(
    await readFile(new URL("../intelligence-packs/examples/cloudflare-agent-week.json", import.meta.url), "utf8"),
  ));
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const remainingWorkflowSteps = 1_047;
  database.prepare(
    `INSERT INTO usage_daily(day, dimension, units, metadata_json, updated_at)
     VALUES (?, 'workflow_steps', ?, '{}', CURRENT_TIMESTAMP)`,
  ).run(new Date().toISOString().slice(0, 10), 2_400 - remainingWorkflowSteps);

  const preview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(preview.projectedWorkflowStepsPerDay, 1_048);
  assert.equal(preview.fitsProfile, false, "one step beyond the remaining retry-aware envelope must not fit");
  assert.match(preview.warnings.join("\n"), /Workflow-step envelope/);
  database.close();
});

test("an unscoped Pack Mission projection uses the runtime 30-source ceiling", async () => {
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "bounded-unscoped-mission",
    version: "1.0.0",
    name: "Bounded unscoped Mission",
    description: "Pins Pack preview to the Mission Workflow source ceiling.",
    cloudSources: [{
      id: "manual-source",
      name: "Manual source",
      kind: "manual",
      config: {},
      scheduleMinutes: 10_080,
      weight: 1,
    }],
    missions: [{
      id: "unscoped",
      name: "Unscoped Mission",
      question: "What changed?",
      sprintPolicy: "scheduled",
      cadenceMinutes: 1_440,
    }],
  });
  const database = await migratedDatabase();
  const preview = await previewIntelligencePack({ DB: new SqliteD1(database) }, pack);
  assert.equal(preview.projectedWorkflowStepsPerDay, 143, "one daily Sprint includes its bounded match-maintenance child");
  database.close();
});

test("large Pack memory seeds use byte-bounded batches with an exact Free estimate", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const summary = "bounded seed ".repeat(620).slice(0, 8_000);
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "bounded-memory-seeds",
    version: "1.0.0",
    name: "Bounded memory seeds",
    description: "Exercises more than one safe JSON-bound seed batch.",
    memory: {
      claims: Array.from({ length: 130 }, (_, index) => ({
        id: `claim-${index + 1}`,
        title: `Claim ${index + 1}`,
        summary,
      })),
    },
  });

  const preview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(preview.estimatedInstallQueries, 23, "two seed batches add exactly four D1 statements");
  assert.equal(preview.installFitsInvocation, true);
  assert.equal(preview.fitsProfile, true);
  d1.queryCount = 0;
  await installIntelligencePack({ DB: d1 }, pack);
  assert.equal(d1.queryCount, preview.estimatedInstallQueries);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes WHERE node_type = 'claim'").get().count, 130);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_edges WHERE relation = 'contains'").get().count, 130);
  database.close();
});

test("an individually oversized memory seed is rejected during read-only preview", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "oversized-memory-seed",
    version: "1.0.0",
    name: "Oversized memory seed",
    description: "Must fail before installation mutates D1.",
    memory: {
      entities: [{ id: "oversized", name: "Oversized", aliases: ["x".repeat(1_010_000)] }],
    },
  });

  await assert.rejects(
    previewIntelligencePack({ DB: d1 }, pack),
    /exceeds the safe D1 bulk-write size/,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, 0);
  database.close();
});

test("Pack preview keeps every daily profile Free-safe until expanded capacity is confirmed", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "six-mission-envelope",
    version: "1.0.0",
    name: "Six Mission envelope",
    description: "Pins Pack installation below the Free D1 statement ceiling.",
    missions: Array.from({ length: 6 }, (_, index) => ({
      id: `mission-${index + 1}`,
      name: `Mission ${index + 1}`,
      question: `What changed for Mission ${index + 1}?`,
      terms: [`term-${index + 1}`],
    })),
  });

  const freePreview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(freePreview.estimatedInstallQueries, 55);
  assert.equal(freePreview.installFitsInvocation, false);
  assert.equal(freePreview.fitsProfile, false);
  d1.queryCount = 0;
  await assert.rejects(
    installIntelligencePack({ DB: d1 }, pack, null, { allowOverBudget: true }),
    /current per-invocation safety envelope/,
  );
  assert.equal(d1.queryCount, 5, "a forced oversized Free install stops after read-only preview");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs").get().count, 0);

  database.prepare(
    "INSERT INTO settings(key, value) VALUES ('budget_profile', 'custom') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
  const customPreview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(customPreview.profile, "custom");
  assert.equal(customPreview.installFitsInvocation, false, "custom planning does not confirm expanded capacity");
  d1.queryCount = 0;
  await assert.rejects(
    installIntelligencePack({ DB: d1 }, pack, null, { allowOverBudget: true }),
    /current per-invocation safety envelope/,
  );
  assert.equal(d1.queryCount, 5, "a forced oversized custom install stops after read-only preview");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs").get().count, 0);

  database.prepare("UPDATE settings SET value = 'cheap' WHERE key = 'budget_profile'").run();
  const cheapFreeSafePreview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(cheapFreeSafePreview.profile, "cheap");
  assert.equal(cheapFreeSafePreview.installFitsInvocation, false, "Cheap daily planning stays on the Free-safe invocation envelope");
  await assert.rejects(
    installIntelligencePack({ DB: d1 }, pack, null, { allowOverBudget: true }),
    /current per-invocation safety envelope/,
  );

  database.prepare(
    "INSERT INTO settings(key, value) VALUES ('execution_capacity', 'expanded-confirmed') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run();
  d1.queryCount = 0;
  const result = await installIntelligencePack({ DB: d1 }, pack);
  assert.equal(result.preview.installFitsInvocation, true);
  assert.equal(d1.queryCount, 55, "preview estimate matches the complete default install invocation");
});

test("Pack invocation safety distinguishes the cloud core from optional Companion lanes", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "companion-query-envelope",
    version: "1.0.0",
    name: "Companion query envelope",
    description: "Keeps optional local lanes out of the cloud-core D1 estimate.",
    cloudSources: [{
      id: "cloud-manual",
      name: "Cloud manual lane",
      kind: "manual",
      scheduleMinutes: 10_080,
    }],
    companionSources: Array.from({ length: 14 }, (_, index) => ({
      id: `companion-${index + 1}`,
      name: `Companion lane ${index + 1}`,
      kind: "collector",
      scheduleMinutes: 10_080,
      config: { operation: "browser_history" },
    })),
  });

  const preview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(preview.estimatedInstallQueries, 21);
  assert.equal(preview.installFitsInvocation, true);
  assert.equal(preview.withCompanionEstimatedInstallQueries, 49);
  assert.equal(preview.withCompanionInstallFitsInvocation, false);
  assert.equal(preview.fitsProfile, true);
  assert.equal(preview.fitsWithCompanion, false);

  d1.queryCount = 0;
  await assert.rejects(
    installIntelligencePack({ DB: d1 }, pack, null, {
      allowOverBudget: true,
      includeCompanionSources: true,
    }),
    /full Pack is estimated at 49 D1 queries/,
  );
  assert.equal(d1.queryCount, 5, "the oversized Companion path stops after read-only preview");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs").get().count, 0);
});

test("allowOverBudget still overrides an application projection when the install invocation is safe", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "forceable-budget-overage",
    version: "1.0.0",
    name: "Forceable budget overage",
    description: "Exceeds the Queue projection without exceeding the D1 invocation envelope.",
    cloudSources: [{
      id: "high-volume-hackernews",
      name: "High-volume Hacker News",
      kind: "hackernews",
      scheduleMinutes: 15,
    }],
  });

  const preview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(preview.installFitsInvocation, true);
  assert.equal(preview.fitsProfile, false);
  assert.ok(preview.projectedQueueMessagesPerDay > 2_500);

  const result = await installIntelligencePack({ DB: d1 }, pack, null, { allowOverBudget: true });
  assert.equal(result.sources, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs WHERE id = ?").get(pack.id).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sources WHERE id = ?").get("high-volume-hackernews").count, 1);
  assert.equal(
    database.prepare("SELECT units FROM usage_daily WHERE dimension = 'memory_writes'").get().units,
    1,
    "the projection override still reserves the Pack installation write",
  );
});

test("allowOverBudget cannot bypass a denied Pack installation write reservation", async () => {
  const database = await migratedDatabase();
  const d1 = new SqliteD1(database);
  database.prepare(
    `INSERT INTO settings(key, value) VALUES
       ('budget_profile', 'custom'),
       ('budget_custom_limits', '{"memory_writes_day":0}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "denied-forced-pack",
    version: "1.0.0",
    name: "Denied forced Pack",
    description: "The cadence projection may be overridden, but installation writes may not.",
    cloudSources: [{
      id: "denied-forced-source",
      name: "Denied forced source",
      kind: "hackernews",
      scheduleMinutes: 15,
    }],
  });

  const preview = await previewIntelligencePack({ DB: d1 }, pack);
  assert.equal(preview.installFitsInvocation, true);
  assert.equal(preview.fitsProfile, false);
  await assert.rejects(
    installIntelligencePack({ DB: d1 }, pack, null, { allowOverBudget: true }),
    (error) => error?.name === "BudgetDeferredError"
      && error?.dimension === "memory_writes"
      && error?.requested === 1,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_packs").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sources WHERE id = ?").get("denied-forced-source").count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM usage_daily").get().count, 0);
});

test("Pack retry reuses canonical memory row IDs for contains edges and declared relations", async () => {
  const database = await migratedDatabase();
  const pack = parseIntelligencePack({
    driftglassPack: "3",
    id: "canonical-reuse",
    version: "1.0.0",
    name: "Canonical reuse regression",
    description: "Exercises a partially persisted Pack retry.",
    memory: {
      entities: [{ id: "entity-seed", type: "company", name: "Existing entity" }],
      claims: [{ id: "claim-seed", title: "Existing claim", summary: "Claim seed" }],
      findings: [{ id: "finding-seed", title: "Existing finding", summary: "Finding seed" }],
      questions: [{ id: "question-seed", title: "Existing question?", summary: "Question seed" }],
      expectations: [{ id: "expectation-seed", title: "Existing expectation", summary: "Expectation seed" }],
      relations: [
        { from: "entity-seed", to: "claim-seed", relation: "supports" },
        { from: "claim-seed", to: "finding-seed", relation: "related_to" },
        { from: "finding-seed", to: "question-seed", relation: "answers" },
        { from: "expectation-seed", to: "entity-seed", relation: "relevant_to" },
      ],
    },
  });
  const canonicalRows = [
    { id: "persisted-pack-row", type: "pack", key: "pack:canonical-reuse" },
    { id: "persisted-entity-row", type: "entity", key: "entity:entity-seed" },
    { id: "persisted-claim-row", type: "claim", key: "claim:canonical-reuse:claim-seed" },
    { id: "persisted-finding-row", type: "finding", key: "finding:canonical-reuse:finding-seed" },
    { id: "persisted-question-row", type: "question", key: "question:canonical-reuse:question-seed" },
    { id: "persisted-expectation-row", type: "expectation", key: "expectation:canonical-reuse:expectation-seed" },
  ];

  database.prepare(
    "INSERT INTO intelligence_packs(id, name, version, description, manifest_json) VALUES (?, ?, ?, ?, ?)",
  ).run(pack.id, pack.name, pack.version, pack.description, JSON.stringify(pack));
  const seedNode = database.prepare(
    "INSERT INTO memory_nodes(id, node_type, canonical_key, label) VALUES (?, ?, ?, ?)",
  );
  for (const row of canonicalRows) seedNode.run(row.id, row.type, row.key, `Pre-existing ${row.type}`);
  database.prepare(
    "INSERT INTO memory_edges(id, from_node_id, to_node_id, relation) VALUES (?, ?, ?, ?)",
  ).run("persisted-partial-edge", "persisted-pack-row", "persisted-entity-row", "contains");

  const env = { DB: new SqliteD1(database) };
  const first = await installIntelligencePack(env, pack, null, { allowOverBudget: true });
  assert.equal(first.entities, 5);

  const selectedEdges = () => database.prepare(
    "SELECT id, from_node_id, to_node_id, relation FROM memory_edges ORDER BY from_node_id, to_node_id, relation",
  ).all();
  const firstEdges = selectedEdges();
  assert.equal(firstEdges.filter((edge) => edge.relation === "contains").length, 5);
  assert.equal(firstEdges.length, 9);
  assert.equal(
    firstEdges.find((edge) => edge.from_node_id === "persisted-pack-row" && edge.to_node_id === "persisted-entity-row")?.id,
    "persisted-partial-edge",
    "a partially persisted edge is updated in place",
  );
  const persistedIds = new Set(canonicalRows.map((row) => row.id));
  assert.ok(firstEdges.every((edge) => persistedIds.has(edge.from_node_id) && persistedIds.has(edge.to_node_id)));
  for (const expected of [
    ["persisted-entity-row", "persisted-claim-row", "supports"],
    ["persisted-claim-row", "persisted-finding-row", "related_to"],
    ["persisted-finding-row", "persisted-question-row", "answers"],
    ["persisted-expectation-row", "persisted-entity-row", "relevant_to"],
  ]) {
    assert.ok(firstEdges.some((edge) => (
      edge.from_node_id === expected[0] && edge.to_node_id === expected[1] && edge.relation === expected[2]
    )));
  }

  const phantomIds = [
    "pack:canonical-reuse",
    "entity:entity-seed",
    "claim:canonical-reuse-claim-seed",
    "finding:canonical-reuse-finding-seed",
    "question:canonical-reuse-question-seed",
    "expectation:canonical-reuse-expectation-seed",
  ];
  const placeholders = phantomIds.map(() => "?").join(", ");
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS count FROM memory_nodes WHERE id IN (${placeholders})`).get(...phantomIds).count,
    0,
    "upserts must not invent IDs when a canonical row already exists",
  );

  await installIntelligencePack(env, pack, null, { allowOverBudget: true });
  assert.deepEqual(selectedEdges(), firstEdges, "retrying the Pack does not duplicate or relink memory edges");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, canonicalRows.length);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intelligence_pack_snapshots").get().count, 1);
});
