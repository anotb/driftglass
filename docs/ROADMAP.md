# Roadmap

Driftglass is building toward a personal intelligence system that can follow a finite set of standing questions for years, preserve how the answers changed, and work with the reasoning model a person already uses.

## 0.9 foundation

Version 0.9 establishes the product loop:

- continuous collection from public, manual, email, and optional signed-in sources
- evolving Stories that consolidate repeated coverage and retain source relationships
- Research Missions with a current answer, next event, history, decisions, and forecasts
- source-linked answers through ChatGPT, Claude, Grok, or another capable client
- a bounded Memory Graph with dated states and proposed changes
- one Cloudflare Computer workspace per Mission
- Intelligence Packs with sources, Missions, memory, routines, and personal overlays
- portable public answers and Pack forks
- Cloudflare deployment plus an experimental local runtime

## Easier ownership

- a packaged self-hosted installation for macOS, Linux, Windows, WSL2, NAS, and small servers
- tested backup, restore, and migration between supported runtimes
- secure remote access to a locally owned instance
- clearer import and export for Missions, source history, memory, answers, and decisions

## Better question intelligence

- stronger detection of substantive changes inside long-running Stories
- better handling of conflicting sources, revisions, and claims that share an upstream origin
- per-Mission retrieval when the global Memory Graph becomes too broad
- improved decision and forecast review, outcome capture, and calibration
- richer comparisons across time, sources, and model answers

## More ways to collect and respond

- broader public and signed-in source adapters
- faster mobile capture and native notifications
- more control over what deserves an alert, a Today item, or no interruption
- portable research handoffs for clients that do not support MCP
- optional local execution for reproducible analysis inside a Mission workspace

## Packs as a shared research format

- more first-party Packs for science, markets, policy, software, and other standing questions
- Community Intelligence Pack publishing and discovery
- signed Pack provenance and update history
- source standards, budget expectations, and compatibility information that travel with a Pack
- local overlays that remain portable across Pack updates and runtime changes

## Optional automation

- progressive agent-tool discovery if the compact MCP surface becomes restrictive
- optional semantic indexes and memory projections where they improve recall
- bounded server-side reasoning for people who choose to supply a model runtime
- more scheduled methods for refreshing a Mission, testing a forecast, or preparing a decision

Public collection, Mission state, connected memory, and prepared reasoning stay in the cloud core. Model APIs, the Companion, semantic retrieval, execution backends, and model-authored memory stay opt-in.
