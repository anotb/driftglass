# Adapter contract

Driftglass separates source semantics from the tool that happens to provide them.

## Cloud adapters

A cloud adapter receives a `SourceRecord` and returns:

```ts
{
  items: NormalizedItemInput[];
  provider: string;
  details?: Record<string, unknown>;
}
```

Every item should include a stable platform ID or canonical URL, useful title/text, observed time, access class, and metadata needed for provenance.

Current adapters:

```text
hackernews
lobsters
bluesky
arxiv
github_releases
github_activity
npm_releases
pypi_releases
openalex
web
web_feed
collector
```

Manual and email items enter through dedicated intake paths.

### OpenAlex authentication boundary

OpenAlex requires an API key for every request. Driftglass reads the optional free account key only from the `OPENALEX_API_KEY` runtime secret; source configuration has a strict allowlist and cannot contain credentials. Search and bounded direct Work-ID modes both defer before network, D1 run creation, outbox work, or budget reservation when the secret is absent. Direct singleton requests are zero-cost according to OpenAlex, but still authenticated. Rate-limit and rejected-key errors expose a safe code and action without retaining the request URL, response body, or key.

## Adaptive web adapter

The webpage adapter supports:

```json
{
  "url": "https://example.com/changelog",
  "mode": "monitor",
  "renderStrategy": "adaptive",
  "selector": "main"
}
```

Strategies:

- `adaptive`: direct, then learned Kitesurf/Chromium route
- `direct`
- `kitesurf`
- `chromium`

The result records the actual engine and attempts.

## Companion capabilities

### Fixed semantic capabilities

Examples:

```text
x.timeline
x.bookmarks
reddit.home
reddit.thread
youtube.transcript
linkedin.timeline
```

A fixed capability may change its upstream command while retaining the same normalized meaning.

Browser-backed OpenCLI candidates run a semantic preflight before collection. The Companion requires Browser Bridge connectivity and, when configured, the exact dedicated `driftglass` profile; an installed binary or zero exit from `opencli doctor` is not enough when its output says the extension is disconnected. A failed preflight skips OpenCLI immediately so an allowlisted fallback may run. Manifest entries marked `browser: false` do not require this bridge check.

Use `reddit.frontpage` as the initial public content probe. Treat `reddit.home`, `x.timeline` with `type: following`, and `x.timeline` with `type: for-you` as distinct optional personalized lanes. Each must pass its own content-bearing probe on the machine that owns the signed-in profile.

### Dynamic OpenCLI capabilities

The Companion reads OpenCLI’s installed `cli-manifest.json` and advertises only entries with:

```json
{ "access": "read" }
```

Driftglass exposes those through:

```text
opencli.read
```

with bounded `site`, `command`, and argument values. The cloud supplies a typed `site`, `command`, and parameter object. The server validates it against the exact manifest advertised by the selected Companion before the job is queued.

## Generated source configuration

The Companion heartbeat includes strategy, browser requirement, description, defaults, choices, positional metadata, and argument types. The dashboard renders those fields automatically, while `src/catalog.ts` performs the authoritative normalization and validation.

## Health contract

A run is successful only when:

1. transport or command execution completed
2. output parsed into the expected structure
3. at least one usable item exists when the source semantics expect content
4. login walls, partial pagination, and empty valid sources remain distinguishable
5. provider and fallback diagnostics are recorded

The Node self-host runtime exposes the same `/collector/*` contract as the Worker and its local scheduler queues `collector` sources through the normal source runner. Once Browser Bridge is ready, Companion output therefore enters the same canonical ingest, dedupe/versioning, Story clustering, Mission matching, Memory Graph, scheduled briefing, and MCP source-trail path in both profiles.

## Adding an adapter

1. Add the SourceKind or Companion capability.
2. Implement normalization.
3. Add content-bearing fixtures.
4. Add malformed, empty, partial, and auth-error cases.
5. Add source discovery and dashboard configuration where useful.
6. Add a starter Lens only when it creates a coherent user outcome.


## Mission Sprint execution contract

Cloud adapters and Companion-backed sources can participate in a durable Mission Sprint without changing their adapter interface. The Workflow resolves the Mission source scope, calls the normal source runner in independently retried steps, waits for Queue or Companion ingestion, and rebuilds Mission matches. Adapter failures remain source-level results rather than collapsing the entire sprint.

## Story Graph contract

The graph consumes normalized Story state rather than upstream-specific objects. Edges expose a relation type, numeric strength, human-readable reasons, shared Mission names, and shared source names. The graph must remain reproducible from D1 state and cannot depend on a model-only hidden score.
