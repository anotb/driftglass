# AGENTS.md

## Mission

Build Driftglass as a finite, continuous personal intelligence system where every standing Research Mission has a durable Cloudflare Computer.

## Non-negotiable architecture

- Cloudflare-only mode must remain useful.
- Each Mission maps to one `MissionComputer` Durable Object.
- D1 remains the global structured index; Computer is the per-Mission working directory.
- The core Computer must work without an execution backend.
- Optional Power Mode uses Computer's Worker-shell backend and remains independently deployable.
- One optional cross-platform Companion provides signed-in collection and local Computer mirroring.
- ChatGPT, Claude, Grok, or another capable subscription surface performs final interpretation; Driftglass compiles and hashes exact Evidence-State Receipts.
- Serious model output is recorded against a receipt, reviewed, and may only propose durable memory changes.
- Decisions and forecasts retain review dates, outcomes, and calibration.
- The default MCP remains compact and read-only; mutations stay in the separately connected operations MCP.
- No mandatory model API key.
- Public-page rendering stays direct → Kitesurf → Chromium.
- Source adapters remain replaceable and content-bearing health checks matter more than process exit codes.
- Intelligence Packs must have a useful cloud core; Companion lanes remain optional and separately budgeted.
- Local Pack changes belong in overlays so upstream updates remain available.
- Intelligence Routines are deterministic Workflows and must not become hidden model loops.
- Evidence lineage and source-family independence must remain visible to the Context Compiler.
- D1 Memory Graph is canonical; AI Search and Agent Memory remain rebuildable accelerators.
- Exact Evidence-State Receipts are immutable once created; new evidence creates a new receipt.
- Intelligence Routines are deterministic bounded Workflows, not hidden model loops.
- Model results, decisions, and memory proposals remain distinct until explicit review.
- Every high-cost path must reserve Budget Governor capacity or degrade predictably.

## Engineering style

- TypeScript for Worker code.
- Dependency-light Companion.
- Deterministic functions should be pure and tested.
- Preserve provenance and explicit partial coverage.
- Managed Computer files may refresh; `notes/`, `results/`, and `exports/` must survive.
- Cloud-to-local jobs are typed; local-to-cloud pushes are bounded to working directories.
- Keep compatibility routes and environment names unless a migration is provided.
- Do not put development commentary or internal notes into product documentation.

## Before completion

```bash
npm run typecheck:offline
npm run lab:typecheck:offline
npm run agent-memory:typecheck:offline
npm test
node scripts/verify-repo.mjs
node --check public/app.js
node --check public/webmcp.js
node --check driftglass-relay/driftglass-relay.mjs
```

With current dependencies and Cloudflare credentials:

```bash
npx wrangler types --check
npx wrangler check
npm run check:deploy
```
