import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import ts from "typescript";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const root = new URL("../", import.meta.url);
const spec = JSON.parse(await readFile(new URL("public/openapi.json", root), "utf8"));
const apiRouteFiles = ["src/api.ts", "src/intelligence-api.ts", "src/v09-api.ts"];

function operationKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function concretePath(template) {
  return template.replace(/\{[^}]+\}/g, "probe");
}

function regexFromLiteral(node, sourceFile) {
  const literal = node.getText(sourceFile);
  const parsed = literal.match(/^\/([\s\S]*)\/([a-z]*)$/i);
  if (!parsed) return null;
  return new RegExp(parsed[1], parsed[2]);
}

function collectApiRoutes(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const matchers = new Map();
  const routes = [];

  function collectMatchers(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer;
      const target = call.expression;
      const argument = call.arguments[0];
      if (
        ts.isPropertyAccessExpression(target)
        && target.name.text === "match"
        && argument
        && argument.kind === ts.SyntaxKind.RegularExpressionLiteral
      ) {
        const pattern = regexFromLiteral(argument, sourceFile);
        if (pattern) matchers.set(node.name.text, pattern);
      }
    }
    ts.forEachChild(node, collectMatchers);
  }

  function inspectCondition(condition) {
    const methods = new Set();
    const paths = new Set();
    const matcherNames = new Set();

    function visit(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const pairs = [[node.left, node.right], [node.right, node.left]];
        for (const [left, right] of pairs) {
          if (ts.isIdentifier(left) && left.text === "path" && ts.isStringLiteral(right)) paths.add(right.text);
          if (
            ts.isPropertyAccessExpression(left)
            && ts.isIdentifier(left.expression)
            && left.expression.text === "request"
            && left.name.text === "method"
            && ts.isStringLiteral(right)
          ) {
            methods.add(right.text.toUpperCase());
          }
        }
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "includes"
        && ts.isArrayLiteralExpression(node.expression.expression)
        && node.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "path")
      ) {
        for (const element of node.expression.expression.elements) {
          if (ts.isStringLiteral(element)) paths.add(element.text);
        }
      }
      if (ts.isIdentifier(node) && matchers.has(node.text)) matcherNames.add(node.text);
      ts.forEachChild(node, visit);
    }

    visit(condition);
    for (const method of methods) {
      for (const path of paths) routes.push({ file, method, path });
      for (const name of matcherNames) routes.push({ file, method, pattern: matchers.get(name) });
    }
  }

  function collectConditions(node) {
    if (ts.isIfStatement(node)) inspectCondition(node.expression);
    ts.forEachChild(node, collectConditions);
  }

  collectMatchers(sourceFile);
  collectConditions(sourceFile);
  return routes;
}

const PUBLIC_OPERATION_EVIDENCE = new Map([
  ["GET /health", { file: "src/index.ts", marker: 'path === "/health"' }],
  ["GET /lenses/catalog.json", { asset: "public/lenses/catalog.json" }],
  ["POST /mcp/{readKey}", { file: "src/mcp.ts", marker: "authorizeMcpPath" }],
  ["POST /mcp/{operationsKey}/ops", { file: "src/mcp.ts", marker: "authorizeMcpPath" }],
  ["GET /packet/{readKey}/latest.md", { file: "src/public-routes.ts", marker: "latest\\.md" }],
  ["GET /packet/{readKey}/pulse.md", { file: "src/public-routes.ts", marker: "pulse\\.md" }],
  ["GET /packet/{readKey}/mission/{missionId}.md", { file: "src/public-routes.ts", marker: "missionMatch" }],
  ["GET /packet/{readKey}/mission/{missionId}/deep-research.md", { file: "src/public-routes.ts", marker: "missionResearchMatch" }],
  ["GET /corpus/{readKey}/index.html", { file: "src/corpus.ts", marker: 'route === "index.html"' }],
  ["GET /corpus/{readKey}/sitemap.xml", { file: "src/corpus.ts", marker: 'route === "sitemap.xml"' }],
  ["GET /corpus/{readKey}/stories/{storyId}.md", { file: "src/corpus.ts", marker: "const storyMatch = route.match" }],
  ["GET /corpus/{readKey}/missions/{missionId}.md", { file: "src/corpus.ts", marker: "const missionMatch = route.match" }],
  ["GET /robots.txt", { file: "src/discovery-routes.ts", marker: 'url.pathname === "/robots.txt"' }],
  ["GET /share/{shareToken}", { file: "src/shares.ts", marker: "url.pathname.match(/^\\/share" }],
  ["GET /share/{shareToken}/drop.zip", { file: "src/shares.ts", marker: 'match[2] === "drop.zip"' }],
  ["GET /share/{shareToken}/og.png", { file: "src/shares.ts", marker: 'match[2] === "og.png"' }],
  ["GET /sitemap.xml", { file: "src/discovery-routes.ts", marker: 'url.pathname === "/sitemap.xml"' }],
]);

// Published operations should normally resolve to source or a public asset. Keep any deliberate
// exception here with a concrete reason so a documentation-only route cannot silently return 404.
const INTENTIONAL_EXCLUSIONS = new Map();

const REQUIRED_ONE_CLICK_OPERATIONS = [
  "GET /api/briefings/latest",
  "GET /api/capabilities",
  "GET /api/email/receipts",
  "GET /api/session",
  "GET /api/stories",
  "GET /api/stories/{storyId}",
  "GET /api/stories/{storyId}/bundle",
  "DELETE /api/sources/{sourceId}",
  "POST /api/sources/{sourceId}/run",
  "GET /api/sources/{sourceId}/runs",
  "GET /packet/{readKey}/pulse.md",
  "GET /corpus/{readKey}/index.html",
];

test("every OpenAPI operation resolves to an implemented route or explicit exclusion", async () => {
  const apiSources = await Promise.all(apiRouteFiles.map(async (file) => ({
    file,
    source: await readFile(new URL(file, root), "utf8"),
  })));
  const apiRoutes = apiSources.flatMap(({ file, source }) => collectApiRoutes(file, source));
  const publicSources = new Map();
  const unresolved = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key))) {
      const key = operationKey(method, path);
      if (path.startsWith("/api/")) {
        const concrete = concretePath(path);
        const implemented = apiRoutes.some((route) =>
          route.method === method.toUpperCase()
          && (route.path === concrete || route.pattern?.test(concrete)),
        );
        if (!implemented && !INTENTIONAL_EXCLUSIONS.has(key)) unresolved.push(key);
        continue;
      }

      const evidence = PUBLIC_OPERATION_EVIDENCE.get(key);
      if (!evidence) {
        if (!INTENTIONAL_EXCLUSIONS.has(key)) unresolved.push(key);
        continue;
      }
      if (evidence.asset) {
        await access(new URL(evidence.asset, root));
        continue;
      }
      let source = publicSources.get(evidence.file);
      if (!source) {
        source = await readFile(new URL(evidence.file, root), "utf8");
        publicSources.set(evidence.file, source);
      }
      assert.ok(source.includes(evidence.marker), `${key} is missing implementation evidence in ${evidence.file}`);
    }
  }

  for (const [key, reason] of INTENTIONAL_EXCLUSIONS) {
    assert.ok(String(reason).trim(), `${key} needs an exclusion reason`);
  }
  assert.deepEqual(unresolved, []);
});

test("OpenAPI uses canonical Pack overlay and AI Search sync contracts", async () => {
  const capacitySchema = spec.paths["/api/budget/execution-capacity"].put.requestBody.content["application/json"].schema;
  assert.deepEqual(capacitySchema.required, ["confirmedWorkersPaid"]);
  assert.equal(capacitySchema.properties.confirmedWorkersPaid.type, "boolean");

  const fork = spec.paths["/api/intelligence-packs/{packId}/fork"];
  assert.ok(fork.post, "Pack fork POST is the canonical operation");
  assert.ok(fork.get, "Pack fork GET remains a read-only compatibility operation");

  const overlay = spec.paths["/api/intelligence-pack-overlays/{overlayId}"];
  assert.equal(overlay.put, undefined, "Overlay updates use the explicit status operation");
  assert.ok(spec.paths["/api/intelligence-pack-overlays/{overlayId}/status"].post);

  const syncProperties = spec.paths["/api/ai-search/sync"].post.requestBody.content["application/json"].schema.properties;
  assert.ok(syncProperties.wait, "AI Search sync documents the source-compatible wait property");
  assert.equal(syncProperties.waitForLast, undefined);
  const apiSource = await readFile(new URL("src/api.ts", root), "utf8");
  assert.match(apiSource, /body\.wait \?\? body\.waitForLast \?\? false/);
});

test("OpenAPI matches Pack install creation statuses and the evidence-lineage read modes", async () => {
  const intelligenceApi = await readFile(new URL("src/intelligence-api.ts", root), "utf8");
  const installStart = intelligenceApi.indexOf('if (["/api/intelligence-packs/install", "/api/intelligence-packs/import"]');
  const installUrlStart = intelligenceApi.indexOf('if (path === "/api/intelligence-packs/install-url"');
  const installUrlEnd = intelligenceApi.indexOf("const packSkillMatch", installUrlStart);
  assert.ok(installStart >= 0 && installUrlStart > installStart && installUrlEnd > installUrlStart);
  assert.match(intelligenceApi.slice(installStart, installUrlStart), /status:\s*201/);
  assert.match(intelligenceApi.slice(installUrlStart, installUrlEnd), /status:\s*201/);

  for (const path of [
    "/api/intelligence-packs/install",
    "/api/intelligence-packs/install-url",
  ]) {
    const responses = spec.paths[path].post.responses;
    assert.ok(responses["201"], `${path} documents the runtime creation status`);
    assert.equal(responses["200"], undefined, `${path} does not advertise a status the runtime never returns`);
  }

  const lineage = spec.paths["/api/evidence/lineage"].get;
  const parameters = new Map(lineage.parameters.map((parameter) => [parameter.name, parameter]));
  assert.deepEqual([...parameters.keys()], ["storyId", "familyKey", "limit"]);
  assert.equal(parameters.get("storyId").schema.maxLength, 200);
  assert.equal(parameters.get("familyKey").schema.maxLength, 240);
  assert.equal(parameters.get("limit").schema.minimum, 1);
  assert.equal(parameters.get("limit").schema.maximum, 500);
  assert.equal(parameters.get("limit").schema.default, 100);

  const variants = lineage.responses["200"].content["application/json"].schema.oneOf;
  assert.equal(variants.length, 2);
  assert.ok(variants.some((variant) => variant.required.includes("summary")), "the unfiltered aggregate shape remains documented");
  const detailed = variants.find((variant) => variant.required.includes("lineage"));
  assert.ok(detailed, "the filtered detailed shape is documented");
  assert.equal(
    detailed.properties.lineage.items.$ref,
    "#/components/schemas/EvidenceLineageRecord",
  );
  assert.ok(lineage.responses["400"], "invalid filters have a documented client-error response");
});

test("OpenAPI fully describes owner-authenticated Share creation", () => {
  const operation = spec.paths["/api/shares"].post;
  assert.deepEqual(operation.security, [{ ownerSecret: [] }]);

  const requestRef = operation.requestBody.content["application/json"].schema.$ref;
  assert.equal(operation.requestBody.required, true);
  assert.equal(requestRef, "#/components/schemas/PublicShareCreateRequest");
  const request = spec.components.schemas.PublicShareCreateRequest;
  assert.deepEqual(request.required, ["kind"]);
  assert.equal(request.additionalProperties, false);
  assert.deepEqual(request.properties.kind.enum, ["story", "mission", "briefing"]);
  assert.equal(request.properties.id.type, "string");
  assert.equal(request.properties.expiresDays.minimum, 1);
  assert.equal(request.properties.expiresDays.maximum, 90);
  assert.equal(request.properties.reviewedRunId.type, "string");

  const created = operation.responses["201"].content["application/json"].schema;
  assert.equal(created.$ref, "#/components/schemas/PublicShareCreateResponse");
  const response = spec.components.schemas.PublicShareCreateResponse;
  assert.deepEqual(response.required, ["ok", "share"]);
  assert.deepEqual(response.properties.share.required, ["id", "url", "dropUrl", "expiresAt", "payload"]);
  assert.equal(response.properties.share.properties.url.format, "uri");
  assert.equal(response.properties.share.properties.dropUrl.format, "uri");
  assert.equal(response.properties.share.properties.expiresAt.format, "date-time");

  for (const path of ["/share/{shareToken}", "/share/{shareToken}/drop.zip", "/share/{shareToken}/og.png"]) {
    assert.equal(spec.paths[path].head, undefined, `${path} does not advertise unsupported HEAD semantics`);
  }
});

test("OpenAPI documents the high-value one-click read and source-control surface", () => {
  const documented = new Set();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key))) {
      documented.add(operationKey(method, path));
    }
  }
  for (const operation of REQUIRED_ONE_CLICK_OPERATIONS) assert.ok(documented.has(operation), operation);
  assert.ok(spec.paths["/api/manual"].post.responses["200"], "manual capture documents its runtime 200 response");
  assert.equal(spec.paths["/api/manual"].post.responses["201"], undefined);
  assert.match(
    spec.paths["/api/email/receipts"].get.description,
    /queued receipt proves Queue acceptance; poll Story detail/i,
  );
});
