# Driftglass 0.4.0 — Agent Week release candidate

Driftglass 0.4.0 turns the original cloud briefing prototype into a complete personal-intelligence system with a Cloudflare-first core, a cross-platform signed-in-source Companion, subscription-backed ChatGPT reasoning, and optional durable research workspaces.

## Headline additions

### Durable Mission Sprints

A Research Mission can now launch a Cloudflare Workflow that:

1. resolves the Mission's configured source scope;
2. runs every source as a separately retried and timed step;
3. leaves a durable window for Queue and Companion ingestion;
4. rebuilds Mission matches;
5. records a complete, partial, or failed run with source-level results.

Mission Sprint history is visible in the dashboard and through REST, MCP, and WebMCP.

### Explainable Story Graph

Every Story can now reveal its connected developments. Relations are calculated from topic overlap, shared Missions, shared sources, and temporal proximity. The graph is deterministic, bounded, and exposes the exact reason and strength for every edge.

### Agent Week execution mesh

Public pages use direct HTTP first, then Kitesurf, then Chromium when needed. Driftglass learns the successful renderer per hostname. Signed-in sources run through the optional Companion on macOS, Windows, or Linux. Cloudflare Computer remains an independently deployed Deep Dive Lab for selected Stories and Missions rather than a requirement for routine collection.

## Complete product surface

- Persistent Stories, evidence, deltas, timelines, and Signal Graphs
- Research Missions, durable Sprints, focused packets, and Pulse alerts
- Taste Profile and inspectable ranking explanations
- Cloud-only HN, Lobsters, Bluesky, arXiv, OpenAlex, GitHub, npm, PyPI, webpage, Page Feed, email, and capture sources
- OpenCLI-discovered signed-in sources through one optional Companion
- Portable Community Lenses and one-URL installation
- PWA share-target capture and bookmarklet intake
- Stateless ChatGPT MCP App plus dashboard WebMCP actions
- Expiring public intelligence cards with Kitesurf-rendered social images
- Private AI Search-ready Story and Mission corpus
- Optional Cloudflare Computer Deep Dive Lab

## Validation completed in this build

- 42 repository and contract tests pass
- Core offline strict TypeScript check passes
- Deep Dive Lab offline strict TypeScript check passes
- Six migrations apply idempotently to a clean SQLite database
- All public JSON surfaces parse successfully
- Companion JavaScript and dashboard JavaScript syntax checks pass
- Hosted Companion copy and SHA-256 manifest match byte-for-byte
- 24 completed milestones have evidence-backed repository paths
- Expanded release verifier passes

## Live release gates

The remaining gates require the target Cloudflare and browser accounts:

- clean-account Cloudflare deployment and automatic binding provisioning
- live direct/Kitesurf/Chromium route validation
- Email Worker receipt validation
- signed-in Companion checks against selected sources
- ChatGPT Scheduled Task and MCP App connection
- public-card social preview rendering on the deployed hostname
- Deep Dive Lab deployment and case export

The connected execution sequence is in [`docs/VALIDATION.md`](VALIDATION.md).
