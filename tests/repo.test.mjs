import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url));
const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

test("hosted Relay is byte-identical and hash-pinned", async () => {
  const [source, hosted, manifestRaw] = await Promise.all([
    read("driftglass-relay/driftglass-relay.mjs"),
    read("public/relay/driftglass-relay.mjs"),
    read("public/relay/manifest.json"),
  ]);
  assert.deepEqual(hosted, source);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  assert.equal(manifest.sha256, createHash("sha256").update(source).digest("hex"));
});

test("Cloudflare resources remain auto-provisionable", async () => {
  const config = JSON.parse((await read("wrangler.jsonc")).toString("utf8"));
  assert.equal(config.d1_databases[0].database_id, undefined);
  assert.equal(config.d1_databases[0].database_name, "driftglass-db");
  assert.equal(config.r2_buckets[0].bucket_name, "driftglass-evidence");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.r2_buckets[0].binding, "EVIDENCE");
  assert.equal(config.durable_objects.bindings[0].name, "MISSION_COMPUTER");
  assert.equal(config.durable_objects.bindings[0].class_name, "MissionComputer");
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *"]);
});

test("ingest Queue durability is isolated and bounded in production and staging", async () => {
  const config = JSON.parse((await read("wrangler.jsonc")).toString("utf8"));
  for (const [label, target, prefix] of [
    ["production", config, "driftglass"],
    ["staging", config.env.staging, "driftglass-staging"],
  ]) {
    const producers = new Map(target.queues.producers.map((producer) => [producer.binding, producer.queue]));
    assert.equal(producers.get("INGEST_QUEUE"), `${prefix}-ingest`, label);
    assert.equal(producers.get("INGEST_DLQ"), `${prefix}-ingest-dlq`, label);
    assert.equal(producers.get("INGEST_QUARANTINE"), `${prefix}-ingest-quarantine`, label);
    const primary = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest`);
    const deadLetter = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest-dlq`);
    const quarantine = target.queues.consumers.find((consumer) => consumer.queue === `${prefix}-ingest-quarantine`);
    assert.deepEqual(
      { batch: primary?.max_batch_size, concurrency: primary?.max_concurrency, dlq: primary?.dead_letter_queue },
      { batch: 1, concurrency: 1, dlq: `${prefix}-ingest-dlq` },
      label,
    );
    assert.deepEqual(
      { batch: deadLetter?.max_batch_size, concurrency: deadLetter?.max_concurrency, dlq: deadLetter?.dead_letter_queue },
      { batch: 1, concurrency: 1, dlq: `${prefix}-ingest-quarantine` },
      label,
    );
    assert.deepEqual(
      {
        batch: quarantine?.max_batch_size,
        concurrency: quarantine?.max_concurrency,
        retries: quarantine?.max_retries,
        retryDelay: quarantine?.retry_delay,
        dlq: quarantine?.dead_letter_queue,
      },
      { batch: 1, concurrency: 1, retries: 20, retryDelay: 3_600, dlq: undefined },
      label,
    );
    assert.equal(target.vars.INGEST_QUEUE_NAME, `${prefix}-ingest`, label);
    assert.equal(target.vars.INGEST_DLQ_NAME, `${prefix}-ingest-dlq`, label);
    assert.equal(target.vars.INGEST_QUARANTINE_NAME, `${prefix}-ingest-quarantine`, label);
  }
});

test("staging is isolated, non-indexed, and deploys with Wrangler migrations", async () => {
  const [configRaw, packageRaw, schema] = await Promise.all([
    read("wrangler.jsonc"), read("package.json"), read("src/schema.ts"),
  ]);
  const config = JSON.parse(configRaw.toString("utf8"));
  const pkg = JSON.parse(packageRaw.toString("utf8"));
  const staging = config.env.staging;

  assert.equal(staging.vars.PUBLIC_INDEXING, "disabled");
  assert.deepEqual(staging.triggers.crons, []);
  assert.deepEqual(staging.secrets.required, ["DRIFTGLASS_SECRET"]);
  assert.equal(staging.d1_databases[0].database_id, undefined);
  assert.equal(staging.d1_databases[0].database_name, "driftglass-staging-db");
  assert.equal(staging.r2_buckets[0].bucket_name, "driftglass-staging-evidence");
  assert.equal(staging.queues.producers[0].queue, "driftglass-staging-ingest");
  assert.ok(staging.workflows.every((workflow) => workflow.name.startsWith("driftglass-staging-")));
  assert.equal(staging.ai_search_namespaces[0].namespace, "driftglass-staging");
  assert.ok(staging.assets.run_worker_first.includes("/*"));
  for (const route of ["/share/*", "/robots.txt", "/sitemap.xml"]) {
    assert.ok(config.assets.run_worker_first.includes(route));
  }
  assert.match(pkg.scripts.deploy, /d1 migrations apply|db:migrate:remote/);
  assert.match(pkg.scripts["deploy:staging"], /db:migrate:staging/);
  assert.match(schema.toString("utf8"), /verifySchema/);
  assert.doesNotMatch(schema.toString("utf8"), /db\.exec\(migration\.sql\)/);
});

test("v0.9 remains Kitesurf-first, cross-platform, and PWA-ready", async () => {
  const [pkgRaw, renderer, relay, html, manifest] = await Promise.all([
    read("package.json"), read("src/rendering.ts"), read("driftglass-relay/driftglass-relay.mjs"),
    read("public/index.html"), read("public/manifest.webmanifest"),
  ]);
  const pkg = JSON.parse(pkgRaw.toString("utf8"));
  assert.equal(pkg.version, "0.9.0");
  assert.match(renderer.toString("utf8"), /browser=kitesurf/);
  assert.match(renderer.toString("utf8"), /\["kitesurf", "chromium"\]/);
  assert.match(relay.toString("utf8"), /macOS, Windows, and Linux/);
  assert.match(html.toString("utf8"), /manifest\.webmanifest/);
  const appManifest = JSON.parse(manifest.toString("utf8"));
  assert.equal(appManifest.short_name, "Driftglass");
  assert.match(appManifest.name, /^Driftglass/);
});

test("every Mission gets a free Cloudflare Computer and Power Mode stays independently deployable", async () => {
  const [rootPackageRaw, rootConfigRaw, missionComputer, labPackageRaw, labWorker, labConfigRaw] = await Promise.all([
    read("package.json"), read("wrangler.jsonc"), read("src/mission-computer.ts"),
    read("labs/deep-dive-lab/package.json"), read("labs/deep-dive-lab/src/index.ts"), read("labs/deep-dive-lab/wrangler.jsonc"),
  ]);
  const rootPackage = JSON.parse(rootPackageRaw.toString("utf8"));
  const rootConfig = JSON.parse(rootConfigRaw.toString("utf8"));
  const labPackage = JSON.parse(labPackageRaw.toString("utf8"));
  const labConfig = JSON.parse(labConfigRaw.toString("utf8"));
  assert.equal(rootPackage.dependencies["@cloudflare/computer"], "0.1.1");
  assert.equal(rootConfig.durable_objects.bindings[0].name, "MISSION_COMPUTER");
  assert.equal(rootConfig.durable_objects.bindings[0].class_name, "MissionComputer");
  assert.equal(rootConfig.migrations[0].new_sqlite_classes[0], "MissionComputer");
  assert.match(missionComputer.toString("utf8"), /withWorkspace/);
  assert.match(missionComputer.toString("utf8"), /freeTierCapable: true/);
  assert.match(missionComputer.toString("utf8"), /deep-research\.md/);
  assert.equal(labPackage.dependencies["@cloudflare/computer"], "0.1.1");
  assert.equal(labPackage.dependencies["@cloudflare/sandbox"], undefined);
  assert.match(labWorker.toString("utf8"), /WorkerShellBackend/);
  assert.match(labWorker.toString("utf8"), /WorkerJavaScriptBackend/);
  assert.match(labWorker.toString("utf8"), /WorkspaceServiceProxy/);
  assert.match(labWorker.toString("utf8"), /sha256sum/);
  assert.equal(labConfig.worker_loaders[0].binding, "LOADER");
  assert.equal(labConfig.durable_objects.bindings[0].class_name, "CaseComputer");
  assert.ok(!labConfig.containers);
});

test("the dashboard exposes the WebMCP product contract", async () => {
  const [webmcp, html] = await Promise.all([
    read("public/webmcp.js"), read("public/index.html"),
  ]);
  assert.match(webmcp.toString("utf8"), /driftglass_open_deep_dive/);
  assert.match(webmcp.toString("utf8"), /driftglass_capture_url/);
  assert.match(html.toString("utf8"), /\/webmcp\.js/);
});

test("action-center cards keep their two-child layout on desktop and mobile", async () => {
  const [app, styles] = await Promise.all([read("public/app.js"), read("public/styles.css")]);
  const appSource = app.toString("utf8");
  const css = styles.toString("utf8");
  const actionTemplate = appSource.split("\n").find((line) => line.includes('return `<article class="action-item'));
  assert.ok(actionTemplate, "action-center card renderer is present");
  assert.match(actionTemplate, /<article class="action-item[^>]+><div>/);
  assert.match(actionTemplate, /<\/div><button class="secondary action-center-button"/);
  assert.doesNotMatch(actionTemplate, /action-signal/);
  assert.match(css, /\.action-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.action-item\s*\{\s*grid-template-columns:\s*1fr;\s*\}[\s\S]*?\.action-item button\s*\{\s*grid-column:\s*1;/);
  assert.doesNotMatch(css, /\.action-signal\b/);
});

test("launch build cannot bless stale captures and Chrome CDP stays loopback-bound", async () => {
  const [builder, music, capture, checker, contract] = await Promise.all([
    read("scripts/build-launch-assets.mjs"),
    read("scripts/build-walkthrough-music.mjs"),
    read("scripts/capture-launch-assets.mjs"),
    read("scripts/check-launch-assets.mjs"),
    read("scripts/walkthrough-contract.mjs"),
  ]);
  const buildSource = builder.toString("utf8");
  const musicSource = music.toString("utf8");
  const captureSource = capture.toString("utf8");
  const checkerSource = checker.toString("utf8");
  const contractSource = contract.toString("utf8");
  assert.match(buildSource, /writeLaunchManifest\(\{ captureComplete = false, captureFingerprint, modelInsertBinding \} = \{\}\)/);
  assert.match(buildSource, /const complete = captureComplete && artifacts\.length === FINAL_ARTIFACTS\.length/);
  assert.match(buildSource, /complete \? \{ captureFingerprint \} : \{\}/);
  assert.match(buildSource, /complete \? \{ modelInsert: normalizedModelInsert \} : \{\}/);
  assert.match(captureSource, /writeLaunchManifest\(\{[\s\S]*captureComplete: !previewOnly,[\s\S]*captureFingerprint,[\s\S]*modelInsertBinding:/);
  assert.match(captureSource, /loadApprovedModelInsertBinding\(\)/);
  assert.match(captureSource, /computeLaunchCaptureInputFingerprint/);
  assert.match(captureSource, /--encode-preview[\s\S]*await buildLaunchAssets\(\)[\s\S]*await writeLaunchManifest\(\)/);
  assert.match(captureSource, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(captureSource, /Chrome exposed an unexpected CDP endpoint/);
  assert.doesNotMatch(captureSource, /action: "scroll-story-sources"/);
  assert.match(captureSource, /writeWalkthroughMusic/);
  assert.match(captureSource, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(captureSource, /did not settle at deterministic geometry/);
  assert.match(captureSource, /scrollbar-width:none!important/);
  assert.match(musicSource, /no recorded samples or third-party audio/i);
  assert.match(contractSource, /WALKTHROUGH_DURATION_SECONDS = 32/);
  assert.match(checkerSource, /every walkthrough scroll is a distinct burst of one second or less/);
  assert.match(checkerSource, /walkthrough contains its original background score/);
  assert.match(checkerSource, /manifest\.captureFingerprint, expectedCaptureFingerprint/);
  assert.match(checkerSource, /resolveLaunchModelInsertBinding\(\{ sourceProfile: sourceBoundaryHasShowcase/);
  assert.match(checkerSource, /parseFfmpegMaxVolume\(edgeVolumeRaw\)/);
  assert.match(checkerSource, /sourceBoundaryHasShowcase/);
  assert.match(checkerSource, /if \(sourceBoundaryHasShowcase\)[\s\S]*CLOUDFLARE-SHOWCASE\.md/);
});

test("cloud source mesh and Mission Computer integration are represented in the product surface", async () => {
  const [registry, api, types, html, app] = await Promise.all([
    read("src/sources/registry.ts"), read("src/api.ts"), read("src/types.ts"), read("public/index.html"), read("public/app.js"),
  ]);
  assert.match(registry.toString("utf8"), /collectNpmReleases/);
  assert.match(registry.toString("utf8"), /collectPypiReleases/);
  assert.match(types.toString("utf8"), /DEEP_DIVE_LAB_URL/);
  assert.match(api.toString("utf8"), /\/deep-dive/);
  assert.match(html.toString("utf8"), /npm releases/);
  assert.match(app.toString("utf8"), /Open workspace/);
  assert.match(app.toString("utf8"), /Mission workspace/);
});

test("Page Feeds, portable Lenses, PWA share intake, and AI Search semantic memory ship together", async () => {
  const [registry, webFeed, lenses, lensExample, manifestRaw, app, corpus, api] = await Promise.all([
    read("src/sources/registry.ts"), read("src/sources/web-feed.ts"), read("src/lenses.ts"),
    read("lenses/examples/cloudflare-agent-week.json"), read("public/manifest.webmanifest"),
    read("public/app.js"), read("src/corpus.ts"), read("src/api.ts"),
  ]);
  assert.match(registry.toString("utf8"), /collectWebFeed/);
  assert.match(webFeed.toString("utf8"), /includeLinks/);
  assert.match(lenses.toString("utf8"), /driftglassLens/);
  assert.equal(JSON.parse(lensExample.toString("utf8")).driftglassLens, "1");
  assert.equal(JSON.parse(manifestRaw.toString("utf8")).share_target.action, "/");
  assert.match(app.toString("utf8"), /current\.searchParams\.get\("url"\)/);
  assert.match(app.toString("utf8"), /current\.searchParams\.get\("title"\)/);
  assert.match(app.toString("utf8"), /current\.searchParams\.get\("text"\)/);
  assert.match(corpus.toString("utf8"), /sitemap\.xml/);
  assert.match(api.toString("utf8"), /aiSearchCorpusUrl/);
});

test("ChatGPT surface includes a real MCP App widget, deterministic deltas, and scheduled checks", async () => {
  const [mcp, widget, briefing, routes, html] = await Promise.all([
    read("src/mcp.ts"), read("src/chatgpt-widget.ts"), read("src/briefing.ts"),
    read("src/public-routes.ts"), read("public/index.html"),
  ]);
  assert.match(mcp.toString("utf8"), /open_today/);
  assert.match(mcp.toString("utf8"), /text\/html;profile=mcp-app/);
  assert.match(mcp.toString("utf8"), /openai\/outputTemplate/);
  assert.match(widget.toString("utf8"), /ui\/notifications\/tool-result/);
  assert.match(briefing.toString("utf8"), /newEvidenceCount/);
  assert.match(routes.toString("utf8"), /Driftglass scheduled check/);
  assert.match(routes.toString("utf8"), /NO_SIGNAL/);
  assert.match(html.toString("utf8"), /Scheduled check/);
});


test("live Companion manifests generate validated source forms", async () => {
  const [catalog, api, app, html] = await Promise.all([
    read("src/catalog.ts"), read("src/api.ts"), read("public/app.js"), read("public/index.html"),
  ]);
  assert.match(catalog.toString("utf8"), /catalogEntryForCollector/);
  assert.match(catalog.toString("utf8"), /Unknown argument\(s\)/);
  assert.match(api.toString("utf8"), /\/api\/catalog\/source/);
  assert.match(app.toString("utf8"), /catalog-add/);
  assert.match(app.toString("utf8"), /adapter-fields/);
  assert.match(html.toString("utf8"), /id="adapter-dialog"/);
});

test("public intelligence cards ship as expiring evidence-linked pages", async () => {
  const [migration, shares, publicSharePage, api, app, html] = await Promise.all([
    read("migrations/0004_public_intelligence.sql"), read("src/shares.ts"), read("src/public-share-page.ts"),
    read("src/api.ts"), read("public/app.js"), read("public/index.html"),
  ]);
  assert.match(migration.toString("utf8"), /public_shares/);
  assert.match(shares.toString("utf8"), /handlePublicShare/);
  assert.match(publicSharePage.toString("utf8"), /class="brand">Driftglass/);
  assert.match(shares.toString("utf8"), /drop\.zip/);
  assert.match(api.toString("utf8"), /\/api\/shares/);
  assert.match(app.toString("utf8"), /share-briefing/);
  assert.match(html.toString("utf8"), /Share what matters/);
});

test("every deployment exposes an agent-readable install and API surface", async () => {
  const [routes, agentRaw, openapiRaw, install, llms] = await Promise.all([
    read("src/discovery-routes.ts"), read("public/.well-known/agent.json"), read("public/openapi.json"),
    read("public/install.md"), read("public/llms-full.txt"),
  ]);
  assert.match(routes.toString("utf8"), /robots\.txt/);
  assert.match(routes.toString("utf8"), /sitemap\.xml/);
  const agent = JSON.parse(agentRaw.toString("utf8"));
  assert.equal(agent.openapi, "/openapi.json");
  const openapi = JSON.parse(openapiRaw.toString("utf8"));
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/api/catalog/source"]);
  assert.ok(openapi.paths["/api/shares"]);
  assert.match(install.toString("utf8"), /First useful session/);
  assert.match(llms.toString("utf8"), /optional Companion adds signed-in sources/);
});

test("portable Lenses, Intelligence Packs, and public cards form a distribution loop", async () => {
  const [lensCatalogRaw, lensSchemaRaw, publicSharePage, roadmap] = await Promise.all([
    read("public/lenses/catalog.json"), read("public/lenses/schema.json"), read("src/public-share-page.ts"), read("docs/ROADMAP.md"),
  ]);
  const catalog = JSON.parse(lensCatalogRaw.toString("utf8"));
  const schema = JSON.parse(lensSchemaRaw.toString("utf8"));
  assert.ok(Array.isArray(catalog.lenses) && catalog.lenses.length >= 3);
  assert.equal(schema.$id, "https://driftglass.dev/lenses/schema.json");
  assert.match(publicSharePage.toString("utf8"), /twitter:card/);
  assert.match(roadmap.toString("utf8"), /Community (?:Lens|Intelligence Pack)/);
});

test("GitHub activity and OpenAlex extend the zero-config cloud source mesh", async () => {
  const [registry, activity, openalex, packs, html] = await Promise.all([
    read("src/sources/registry.ts"), read("src/sources/github-activity.ts"), read("src/sources/openalex.ts"),
    read("src/packs.ts"), read("public/index.html"),
  ]);
  assert.match(registry.toString("utf8"), /collectGithubActivity/);
  assert.match(registry.toString("utf8"), /collectOpenAlex/);
  assert.match(activity.toString("utf8"), /events_url|events/);
  assert.match(openalex.toString("utf8"), /api\.openalex\.org/);
  assert.match(packs.toString("utf8"), /github_activity/);
  assert.match(packs.toString("utf8"), /openalex/);
  assert.match(html.toString("utf8"), /GitHub activity/);
  assert.match(html.toString("utf8"), /OpenAlex/);
});

test("community Lenses are validated, catalogued, and installable by URL", async () => {
  const [catalogRaw, schemaRaw, api, app, issueTemplate] = await Promise.all([
    read("public/lenses/catalog.json"), read("lenses/schema.json"), read("src/api.ts"), read("public/app.js"),
    read(".github/ISSUE_TEMPLATE/lens-submission.yml"),
  ]);
  const catalog = JSON.parse(catalogRaw.toString("utf8"));
  assert.ok(catalog.lenses.length >= 3);
  assert.match(schemaRaw.toString("utf8"), /github_activity/);
  assert.match(schemaRaw.toString("utf8"), /openalex/);
  assert.match(api.toString("utf8"), /lenses\/install-url/);
  assert.match(app.toString("utf8"), /processPendingInstalls/);
  assert.match(issueTemplate.toString("utf8"), /Lens/);
});

test("Taste Profile, ranking explanations, and answer-led social preview cards close the learning and sharing loops", async () => {
  const [migration, taste, explain, mcp, webmcp, shares, publicSharePage, app, og, ogFingerprint, shareFallback, shareFallbackFingerprint, ogBuilder] = await Promise.all([
    read("migrations/0005_personalization.sql"), read("src/taste.ts"), read("src/explain.ts"), read("src/mcp.ts"),
    read("public/webmcp.js"), read("src/shares.ts"), read("src/public-share-page.ts"), read("public/app.js"), read("public/icons/driftglass-og.png"),
    read("public/icons/driftglass-og.source.sha256"),
    read("public/icons/driftglass-share-fallback.png"),
    read("public/icons/driftglass-share-fallback.source.sha256"),
    read("scripts/build-social-card.mjs"),
  ]);
  assert.match(migration.toString("utf8"), /taste_terms/);
  assert.match(taste.toString("utf8"), /learnFromFeedback/);
  assert.match(explain.toString("utf8"), /feedbackAdjustment/);
  assert.match(mcp.toString("utf8"), /explain_ranking/);
  assert.match(webmcp.toString("utf8"), /driftglass_publish_intelligence_card/);
  assert.match(shares.toString("utf8"), /captureKitesurfScreenshot/);
  assert.match(shares.toString("utf8"), /renderPublicSharePage/);
  assert.match(publicSharePage.toString("utf8"), /og:image/);
  assert.match(shares.toString("utf8"), /driftglass-share-fallback\.png/);
  assert.doesNotMatch(shares.toString("utf8"), /new URL\("\/icons\/driftglass-og\.png"/);
  assert.match(app.toString("utf8"), /Taste Profile/);
  assert.ok(og.byteLength > 10_000);
  assert.equal(og.readUInt32BE(16), 1200);
  assert.equal(og.readUInt32BE(20), 630);
  assert.ok(shareFallback.byteLength > 10_000);
  assert.equal(shareFallback.readUInt32BE(16), 1200);
  assert.equal(shareFallback.readUInt32BE(20), 630);
  assert.match(ogBuilder.toString("utf8"), /Keep a current answer/);
  assert.match(ogBuilder.toString("utf8"), /Has Gulf LNG supply/);
  assert.match(ogBuilder.toString("utf8"), /font\.layout\(text\)/);
  assert.doesNotMatch(ogBuilder.toString("utf8"), /Evidence-backed|CHATGPT|TASTE PROFILE/i);
  assert.match(ogFingerprint.toString("utf8"), /^[a-f0-9]{64}\n$/);
  assert.match(shareFallbackFingerprint.toString("utf8"), /^[a-f0-9]{64}\n$/);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "driftglass-social-card-"));
  const reencodedPath = join(temporaryDirectory, "reencoded.png");
  const stalePath = join(temporaryDirectory, "stale.png");
  const metadataPath = join(temporaryDirectory, "metadata.png");
  const builderPath = join(repository, "scripts", "build-social-card.mjs");
  try {
    await sharp(og).png({ compressionLevel: 0, palette: false }).toFile(reencodedPath);
    await execFileAsync(process.execPath, [builderPath, "--check", "--check-file", reencodedPath], { cwd: repository });

    await sharp(og).composite([{
      input: { create: { width: 12, height: 12, channels: 4, background: "#13151c" } },
      left: 500,
      top: 500,
    }]).png({ compressionLevel: 9 }).toFile(stalePath);
    await assert.rejects(
      execFileAsync(process.execPath, [builderPath, "--check", "--check-file", stalePath], { cwd: repository }),
      /Social card pixels are stale/,
    );

    await sharp(og).withMetadata({
      exif: { IFD0: { ImageDescription: "PRIVATE-CHAT-HISTORY" } },
    }).png().toFile(metadataPath);
    await assert.rejects(
      execFileAsync(process.execPath, [builderPath, "--check", "--check-file", metadataPath], { cwd: repository }),
      /Social card contains unsafe PNG chunk/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Companion can install and control a per-user service on all three desktop platforms", async () => {
  const relay = (await read("driftglass-relay/driftglass-relay.mjs")).toString("utf8");
  for (const command of ["service-install", "service-start", "service-stop", "service-restart", "service-status"]) {
    assert.match(relay, new RegExp(command));
  }
  assert.match(relay, /launchctl/);
  assert.match(relay, /schtasks/);
  assert.match(relay, /systemctl/);
});


test("Mission operators, Deep Research handoffs, and Drop Capsules preserve the product boundary", async () => {
  const [migration, deepResearch, routes, mcp, webmcp, shares, capsule, app, html, boundary, dropDoc, openapiRaw] = await Promise.all([
    read("migrations/0007_mission_operators.sql"), read("src/deep-research.ts"), read("src/public-routes.ts"),
    read("src/mcp.ts"), read("public/webmcp.js"), read("src/shares.ts"), read("src/drop-capsule.ts"),
    read("public/app.js"), read("public/index.html"), read("docs/PRODUCT-BOUNDARY.md"), read("docs/CLOUDFLARE-DROP.md"),
    read("public/openapi.json"),
  ]);
  assert.match(migration.toString("utf8"), /mission_operators/);
  assert.match(migration.toString("utf8"), /mission_events/);
  assert.match(deepResearch.toString("utf8"), /coverageGaps/);
  assert.match(deepResearch.toString("utf8"), /researchPlan/);
  assert.match(deepResearch.toString("utf8"), /research_policy === "always"/);
  assert.match(routes.toString("utf8"), /deep-research\.md/);
  assert.match(mcp.toString("utf8"), /prepare_deep_research/);
  assert.match(mcp.toString("utf8"), /record_mission_update/);
  assert.match(webmcp.toString("utf8"), /driftglass_prepare_deep_research/);
  assert.match(shares.toString("utf8"), /buildDropCapsule/);
  assert.doesNotMatch(shares.toString("utf8"), /getMissionOperator/);
  assert.doesNotMatch(shares.toString("utf8"), /Current conclusion/);
  assert.match(capsule.toString("utf8"), /llms\.txt/);
  assert.match(capsule.toString("utf8"), /recipientShareDocument/);
  assert.match(app.toString("utf8"), /Prepare for Deep Research/);
  assert.match(html.toString("utf8"), /Next signal that could change the answer/);
  assert.match(boundary.toString("utf8"), /continu(?:ous|ity layer for) personal intelligence/i);
  assert.match(dropDoc.toString("utf8"), /portable capsule/i);
  const openapi = JSON.parse(openapiRaw.toString("utf8"));
  assert.ok(openapi.paths["/api/missions/{missionId}/deep-research"]);
  assert.ok(openapi.paths["/share/{shareToken}/drop.zip"]);
});

test("Durable Mission Sprints use Cloudflare Workflows and expose visible run history", async () => {
  const [configRaw, workflow, migration, api, autopilot, app, mcp, webmcp] = await Promise.all([
    read("wrangler.jsonc"), read("src/mission-workflow.ts"), read("migrations/0006_mission_sprints.sql"),
    read("src/api.ts"), read("src/mission-autopilot.ts"), read("public/app.js"), read("src/mcp.ts"), read("public/webmcp.js"),
  ]);
  const config = JSON.parse(configRaw.toString("utf8"));
  assert.equal(config.workflows[0].binding, "MISSION_WORKFLOW");
  assert.equal(config.workflows[0].class_name, "MissionSprintWorkflow");
  assert.match(workflow.toString("utf8"), /WorkflowEntrypoint/);
  assert.match(workflow.toString("utf8"), /step\.sleep/);
  assert.match(workflow.toString("utf8"), /retries: \{ limit: 3/);
  assert.match(workflow.toString("utf8"), /step\.do\("fail mission sprint"[\s\S]*updateMissionRun/);
  assert.match(workflow.toString("utf8"), /startMissionMatchMaintenance/);
  assert.match(workflow.toString("utf8"), /evaluateMissionMatchesAcrossBoundary/);
  assert.match(migration.toString("utf8"), /mission_runs/);
  assert.match(api.toString("utf8"), /missionSprintMatch/);
  assert.match(autopilot.toString("utf8"), /Workflow start failed/);
  assert.match(app.toString("utf8"), /Check for updates/);
  assert.match(mcp.toString("utf8"), /list_mission_sprints/);
  assert.match(webmcp.toString("utf8"), /driftglass_run_mission_sprint/);
});

test("Story Graph connects adjacent developments across Missions and sources", async () => {
  const [graph, api, mcp, webmcp, app] = await Promise.all([
    read("src/story-graph.ts"), read("src/api.ts"), read("src/mcp.ts"), read("public/webmcp.js"), read("public/app.js"),
  ]);
  assert.match(graph.toString("utf8"), /shared-mission/);
  assert.match(graph.toString("utf8"), /shared-sources/);
  assert.match(graph.toString("utf8"), /same-development/);
  assert.match(graph.toString("utf8"), /cheapScore/);
  assert.match(graph.toString("utf8"), /slice\(0, 30\)/);
  assert.match(api.toString("utf8"), /storyGraphMatch/);
  assert.match(mcp.toString("utf8"), /get_story_graph/);
  assert.match(webmcp.toString("utf8"), /driftglass_get_story_graph/);
  assert.match(app.toString("utf8"), /Connected developments/);
});


test("feature-complete operations close the Mission loop without adding a model runtime", async () => {
  const [migration, autopilot, actions, results, profile, readiness, api, mcp, webmcp, app, html] = await Promise.all([
    read("migrations/0008_feature_complete.sql"), read("src/mission-autopilot.ts"), read("src/action-center.ts"),
    read("src/research-results.ts"), read("src/profile.ts"), read("src/readiness.ts"), read("src/api.ts"),
    read("src/mcp.ts"), read("public/webmcp.js"), read("public/app.js"), read("public/index.html"),
  ]);
  assert.match(migration.toString("utf8"), /research_result_imports/);
  assert.match(migration.toString("utf8"), /sprint_policy/);
  assert.match(autopilot.toString("utf8"), /startDueMissionSprints/);
  assert.match(actions.toString("utf8"), /expected-overdue/);
  assert.match(results.toString("utf8"), /stageResearchResult/);
  assert.match(results.toString("utf8"), /confirmResearchResult/);
  assert.match(profile.toString("utf8"), /schemaVersion: 3/);
  assert.match(readiness.toString("utf8"), /Web reading/);
  assert.match(api.toString("utf8"), /\/api\/action-center/);
  assert.match(api.toString("utf8"), /missionResearchPreviewMatch/);
  assert.match(mcp.toString("utf8"), /get_action_center/);
  assert.match(mcp.toString("utf8"), /stage_research_result/);
  assert.match(webmcp.toString("utf8"), /driftglass_decide_research_result/);
  assert.match(app.toString("utf8"), /renderActionCenter/);
  assert.match(app.toString("utf8"), /Review proposed update/);
  assert.match(html.toString("utf8"), /Scheduled check/);
  assert.match(html.toString("utf8"), /Setup check/);
});

test("Mission Computers remain instrumented durable workspaces without retaining capability URLs", async () => {
  const [configRaw, computer, registry, workflow, mcp, webmcp] = await Promise.all([
    read("wrangler.jsonc"), read("src/mission-computer.ts"), read("src/sources/registry.ts"),
    read("src/mission-workflow.ts"), read("src/mcp.ts"), read("public/webmcp.js"),
  ]);
  const config = JSON.parse(configRaw.toString("utf8"));
  for (const observability of [config.observability, config.env.staging.observability]) {
    assert.equal(observability.enabled, false);
    assert.equal(observability.logs.enabled, false);
    assert.equal(observability.logs.invocation_logs, false);
    assert.equal(observability.traces.enabled, false);
  }
  assert.match(computer.toString("utf8"), /tracing\.enterSpan\("driftglass\.mission_computer\.load"/);
  assert.match(computer.toString("utf8"), /tracing\.enterSpan\("driftglass\.mission_computer\.render"/);
  assert.match(computer.toString("utf8"), /tracing\.enterSpan\("driftglass\.mission_computer\.commit"/);
  assert.match(computer.toString("utf8"), /\/notes\//);
  assert.match(computer.toString("utf8"), /\/results\//);
  assert.match(computer.toString("utf8"), /\/exports\//);
  assert.match(computer.toString("utf8"), /importMissionComputerFiles/);
  assert.match(registry.toString("utf8"), /tracing\.enterSpan\("driftglass\.source\.collect"/);
  assert.match((await read("src/rendering.ts")).toString("utf8"), /tracing\.enterSpan\("driftglass\.render\.adaptive"/);
  assert.match(workflow.toString("utf8"), /loadMissionComputerAcrossBoundary/);
  assert.match(workflow.toString("utf8"), /renderMissionComputerAcrossBoundary/);
  assert.match(workflow.toString("utf8"), /commitMissionComputerAcrossBoundary/);
  assert.match(mcp.toString("utf8"), /open_mission_computer/);
  assert.match(webmcp.toString("utf8"), /driftglass_open_mission_computer/);
});

test("Companion mirrors Mission Computers locally and supports bounded write-back", async () => {
  const [relay, collectors, relayReadme] = await Promise.all([
    read("driftglass-relay/driftglass-relay.mjs"), read("src/collectors.ts"), read("driftglass-relay/README.md"),
  ]);
  const source = relay.toString("utf8");
  assert.match(source, /workspace-sync/);
  assert.match(source, /workspace-push/);
  assert.match(source, /workspace-import/);
  assert.match(source, /workspaceMirror/);
  assert.match(source, /\/collector\/workspaces/);
  assert.match(collectors.toString("utf8"), /importMissionComputerFiles/);
  assert.match(collectors.toString("utf8"), /request\.method === "PUT"/);
  assert.match(relayReadme.toString("utf8"), /notes\/`, `results\/`, and `exports\//);
  assert.match(relayReadme.toString("utf8"), /ordinary local folder every 15 minutes/);
});
