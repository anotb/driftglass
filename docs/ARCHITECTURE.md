# Architecture

## System shape

```text
public APIs / releases / research / pages / optional email / explicit captures
                              │
                              ▼
              Cloudflare Worker + Cron + Workflows
                    │             │
                    │             └── direct → Kitesurf → Chromium
                    ▼
                 Queue ingestion
                    │
                    ▼
       D1 global Story / Mission / Taste index
         │                 │                   │
         │                 │                   └── R2 evidence and shares
         │                 ▼
         │       MissionComputer Durable Object
         │       SQLite-backed virtual filesystem
         │                 │
         │        files / notes / handoffs / results
         │          ┌──────┴──────────┐
         ▼          ▼                 ▼
   finite packets  chosen model surface  local Companion mirror
                                      │
                                local tools / agents

optional rebuildable projections
  D1 Memory Graph → AI Search / Agent Memory

optional Computer Power Mode
  Worker Loader → Dynamic Workers → Worker-shell / Worker-JavaScript backends
```

## Global index

D1 is authoritative for structured state:

- sources and run health
- normalized items
- persistent Stories
- Story evidence and relationships
- Research Missions and operators
- Autopilot and expected events
- Mission Sprint history
- research-result approvals
- exact reasoning receipts, reviewed results, decisions, and forecasts
- feedback and Taste Profile
- public shares
- render telemetry
- Companion pairing and jobs

R2 stores larger evidence objects, public-card assets, and generated artifacts.

Queues isolate collection from idempotent ingestion. Workflows provide durable Mission Sprints with independently retried source steps.
Deterministic Intelligence Routines also use bounded Workflow steps and never contain a hidden model loop.

## Mission Computer

Each Mission ID maps to one `MissionComputer` Durable Object. `@cloudflare/computer` installs a SQLite-backed filesystem into that object.

The default Computer has no execution backend. This is intentional: the core only needs durable files, while a chosen capable subscription surface supplies reasoning and the Companion can supply local execution.

Managed files are refreshed from D1 after Mission changes and Sprints. User-owned directories survive refreshes:

```text
/notes/
/results/
/exports/
```

The owner API, MCP, WebMCP, dashboard, and Companion all operate on the same workspace contract.

## Local mirror

The Companion runs on macOS, Windows, or Linux and polls outbound. It performs two roles:

1. signed-in source collection through live OpenCLI read adapters
2. local Mission Computer mirroring

Managed files refresh every 15 minutes while local `notes/`, `results/`, and `exports/` remain user-owned. Those directories can be pushed back into the cloud Computer.

This creates a local/self-controlled execution path without making the local machine the application server.

Email intake is another optional ingress. It exists only after the owner configures an Email Routing address for the Worker; it is not part of the zero-setup core.

## Computer Power Mode

`labs/deep-dive-lab` is independently deployable and keeps its compatibility name. Its product role is Computer Power Mode.

It configures:

- a `CaseComputer` Durable Object
- `WorkspaceServiceProxy`
- a Worker Loader binding
- `WorkerShellBackend`
- `WorkerJavaScriptBackend`
- selected command groups for text and data work

The default backend is an isolate shell. It does not need Docker or a container. A full Linux backend can be added later while preserving the same workspace files and external routes.

## Adaptive browser mesh

Page collection starts with direct HTTP. When the owner adds the optional Browser Rendering binding, Driftglass can try Kitesurf before Chromium for pages that need rendering.

```text
direct fetch
    ↓ thin or failed
Kitesurf CDP
    ↓ incompatible
Chromium Browser Run
```

Per-host telemetry records engine, success, latency, content size, browser usage, and recent failure streak. The route can adapt by hostname.

## Reasoning boundary

Cloudflare performs deterministic preparation:

- fetching
- normalization
- exact deduplication
- Story resolution
- ranking inputs
- Mission matching
- source health
- packet construction
- Computer synchronization

A chosen capable subscription surface performs final interpretation and deeper research. No general model loop is required in the core.

## Observability

Private packet and MCP capabilities are bearer values carried in URL paths, so retained invocation logs and automatic traces are disabled. Operational health uses aggregate Workers Analytics, service-specific D1, Queue, R2, Workflow, and Browser metrics, the Budget Governor ledger, and content-free readiness records. Source collection and Mission Computer code retains span boundaries for an optional redacting telemetry adapter.
