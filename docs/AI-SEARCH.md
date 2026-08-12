# Optional semantic retrieval with Cloudflare AI Search

Driftglass can project rebuildable Story, Mission, and briefing documents into Cloudflare AI Search for hybrid semantic retrieval. The sparse D1 Memory Graph remains canonical and works without AI Search.

## When it helps

AI Search is useful when the private corpus becomes large enough that exact graph recall and D1 text search no longer surface conceptual neighbors efficiently.

It provides:

- vector search
- keyword search
- reciprocal-rank fusion
- metadata filters
- semantic reranking
- matched chunks and scoring detail

## Instance

The Worker declares an AI Search namespace binding so the optional feature is available, but deployment, readiness checks, briefings, research imports, and semantic reads do not create an instance. The checked-in default is disabled.

Explicit setup creates or reconnects the built-in-storage instance named:

```text
driftglass-intelligence
```

Enable it from the dashboard or with:

```http
POST /api/ai-search/setup
Authorization: Bearer <DRIFTGLASS_SECRET>
```

That setup request is the only creation and enablement path. Its persisted setting is absent by default, so an existing instance is also left disabled until the owner explicitly runs setup.

## Indexed documents

- evolving Stories with selected evidence
- Research Missions with operator and approved research state
- recent briefing packets

D1 and Mission Computers remain the sources of truth. The index can be deleted and rebuilt.

## Synchronization

The sync process:

1. generates bounded Markdown documents
2. compares content hashes in D1
3. atomically reserves the page's bounded AI Search operation envelope
4. uploads changed documents
5. deletes stale documents
6. records indexing statistics

The monthly operation lane is shared by semantic queries and synchronization. Each query reserves two units for its namespace lookup and search before either call begins. Each sync page reserves one namespace lookup, at most 52 binding operations for a replacement, and at most 51 for a deletion. Unchanged documents consume no per-document units. Reservations are retained when a remote result is ambiguous.

The dashboard, API, MCP, and WebMCP can trigger a sync after setup. Automatic briefing and approved-research hooks synchronize only while AI Search is enabled. When it is disabled, manual semantic search and sync return `409 AI_SEARCH_DISABLED` with the setup action instead of creating an instance as a side effect.

`GET /api/ai-search/status` reports three separate states:

- `available`: the Worker has an AI Search namespace binding
- `enabled`: the owner explicitly ran setup
- `configured`: the named instance currently exists

The status read may inspect the namespace, but it never creates or enables anything.

## Query

Hybrid queries may filter results to:

```text
story
mission
briefing
```

Use AI Search to find the conceptual neighborhood, then fetch the exact Story, Mission, evidence, or Memory Graph records before making durable conclusions.

## Product boundary

AI Search is a retrieval accelerator, not canonical memory, a second editorial model, or a prerequisite for Driftglass.
