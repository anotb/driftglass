# Driftglass 0.7.0 — Computer-native personal intelligence

Driftglass 0.7.0 makes Cloudflare Computer a core product primitive rather than an optional case add-on.

## One Computer per Mission

Every Research Mission now receives a named `MissionComputer` Durable Object with a SQLite-backed virtual filesystem.

The Computer contains Mission state, Story and evidence indexes, ledgers, Deep Research handoffs, working notes, reviewed results, and exports. Managed evidence refreshes automatically while working directories remain durable.

Owner API, dashboard, MCP, WebMCP, Workflows, and the Companion all use the same workspace contract.

## Local mirror and write-back

The cross-platform Companion mirrors Mission Computers to a user-owned local directory every 15 minutes. Local tools can read and modify the workspace. Files under `notes/`, `results/`, and `exports/` can be pushed back into the cloud Computer.

This provides a local execution and self-controlled-files path without making the desktop the public service.

## Computer Power Mode

The compatibility path `labs/deep-dive-lab` now uses Cloudflare Computer's Worker-shell and Worker-JavaScript backends, keeping the workspace abstraction consistent from free filesystem mode through isolate execution.

Power Mode provides two isolate runtimes over the same files: Worker shell for command-oriented analysis and Worker JavaScript for typed structured transforms. It includes selected data and text tools, case APIs, audits, transform exports, dossier export, and MCP. The default configuration requires no Docker. Full Linux remains a future optional backend.

## First-class Semantic Memory

AI Search now uses the current namespace Workers binding to create and maintain a built-in-storage instance at runtime. Driftglass uploads only changed Story, Mission, and briefing documents, deletes stale records, and exposes hybrid vector + keyword search with metadata filters and reranking through the dashboard, API, MCP, and WebMCP.

## Trace-native operations

Workers traces are explicitly enabled. Custom spans identify:

- source collection
- provider and outcome
- item count
- Mission Computer synchronization
- adaptive Kitesurf/Chromium rendering
- Story and evidence counts

These spans nest with automatic fetch, D1, R2, Queue, Workflow, and Durable Object instrumentation.

## Preserved capabilities

0.7.0 keeps all prior capabilities:

- direct → Kitesurf → Chromium adaptive browsing
- broad cloud source mesh
- live signed-in OpenCLI Companion sources
- evolving Stories and Story Graphs
- Mission operators, Autopilot, Sprints, and Action Center
- Taste Profile and ranking explanations
- ChatGPT Scheduled Tasks and MCP App
- Deep Research handoff and approval loop
- first-class AI Search semantic memory
- Community Lenses
- public cards and Cloudflare Drop Capsules
- portable Profile and Readiness Doctor

## Product boundary

D1 remains the global structured index. Computer becomes the working directory for one persistent question. Workflows coordinate deterministic refreshes. ChatGPT remains the reasoning and editorial surface.

Project Think or another built-in model harness is not part of the core because it would duplicate the user's ChatGPT workflow and introduce a second inference path.
