# Changelog

## 0.9.0 — 2026-08-07

### Auditable Judgment Loop

- Added immutable hashed Evidence-State Receipts stored in R2 and indexed in D1 before model reasoning begins.
- Added prepared reasoning tasks, provider/model result recording, review, typed memory proposals, and cross-model comparison over identical context.
- Added a durable decision, forecast, thesis, and commitment ledger with outcomes, review dates, and calibration.
- Added a finite Judgment workspace in the dashboard and Action Center.

### Evidence quality and efficient collection

- Added evidence-family lineage across origin, independent, same-family, update, and echo relations.
- Added echo-resistant context selection and provenance-aware source scorecards.
- Added yield-aware adaptive source cadence with failure and empty-run backoff, high-signal acceleration, and Budget Governor enforcement.

### Intelligence Pack v3

- Added deterministic Intelligence Routines executed through Cloudflare Workflows without a hidden model loop.
- Added local Pack overlays, capture of existing customizations, conflict-aware upstream updates, and portable customized Pack forks.
- Preserved cloud-only Pack value while keeping Companion lanes optional.

### Provider-neutral reasoning

- Added `next_reasoning_task` and temporal `compare_memory` to the compact reasoning MCP.
- Added explicit operations tools for receipts, model results, decisions, routines, memory checkpoints, and Pack customizations.
- Kept model calls in ChatGPT, Claude, Grok, or another chosen client rather than adding a mandatory provider API.

### Release hardening

- Split compact-read and operations MCP capabilities with independent key derivation; existing compact URLs remain valid, while operations clients must reconnect with the new owner-only URL.
- Bounded source scorecard scans and corrected lineage aggregation so repeated joins cannot inflate source value.
- Made receipt fingerprints deterministic across identical evidence states by excluding random receipt IDs and generation time.
- Added R2 cleanup for failed receipt creation, race-safe task deduplication, and idempotent model-run completion.
- Expanded the release contract to 77 passing tests.

## 0.8.0 — 2026-08-07

- Added a bounded provenance-aware Memory Graph spanning Stories, Missions, sources, entities, findings, expectations, decisions, and outcomes.
- Added Free-tier-safe native Workflow maintenance for deterministic structural memory, with bounded phases, run history, and no unsafe inline fallback.
- Added Story Claim nodes linked directly to supporting source evidence, plus model-proposed semantic patches that require explicit approval.
- Added an on-demand Memory Integrity Audit for contradictions, overdue expectations, orphan nodes, provenance gaps, and supersession integrity.
- Added Intelligence Packs v2 with cloud sources, optional Companion sources, Mission operators, saved views, Entities, Claims, Findings, Questions, Expectations, evidence policy, playbooks, provider hints, output contracts, budgets, and update URLs.
- Added Pack cost preview using existing load, source-specific item yield, Queue messages, browser fallback share, scheduled Workflows, memory writes, and per-invocation D1 install safety; retained cloud-only installation, dormant Companion lanes, Agent Skill export, bounded update checks, and explicit updates.
- Added source-aware, token-honest reasoning bundles and complete interface kits for ChatGPT, Claude remote MCP, Grok custom MCP connectors, and generic MCP clients without requiring model APIs inside Driftglass.
- Added a visible context-quality gate across evidence depth, source diversity, provenance, Memory Graph continuity, recency, contrary-case coverage, and cloud independence.
- Split MCP into a compact ten-tool read-only reasoning profile and an explicit operations profile for state changes.
- Added separately budgeted cloud-core and cloud-plus-Companion Pack projections, with cloud-only install and update as the default.
- Added budget-aware Memory Graph projection into Mission Computers and Portable Profile v3 for Packs, playbooks, budget, graph policy, and approved memory patches.
- Added conservative Free and Cheap application budget profiles with runtime deferral across source runs, Queues, Workflows, browser use, memory writes, AI Search, and Computer sync.
- Added an optional checkpoint bridge to Cloudflare Agent Memory while retaining D1 as canonical memory.
- Preserved Computer-native Missions, Kitesurf-first browsing, broad cloud-only coverage, optional Companion sources, ChatGPT Deep Research handoffs, Drop Capsules, and all prior operating loops.

## 0.7.0 — 2026-08-07

- Made Cloudflare Computer a core primitive: one durable SQLite-backed workspace per Research Mission.
- Added dashboard, owner API, MCP, WebMCP, Workflow, and Companion access to Mission Computer files.
- Added cross-platform local workspace mirroring and bounded write-back for notes, results, and exports.
- Rebuilt the optional compatibility Lab as Computer Power Mode using Worker-shell and Dynamic Workers without Docker.
- Enabled Workers traces and added custom spans for source collection and Mission Computer synchronization.
- Preserved Kitesurf-first browsing, Workflows, AI Search, Email Workers, Drop Capsules, ChatGPT MCP, Missions, and all 0.6 operating loops.

## 0.6.0 — 2026-08-07

- Added Mission Autopilot, expected-event reminders, and a finite Action Center across dashboard, packets, MCP, and WebMCP.
- Added reviewable Deep Research result imports with a staged diff, explicit confirmation or rejection, and atomic Mission write-back.
- Added portable Profile v2 export and dry-run merge restore for sources, Missions, operators, research state, ledger, Taste, and saved views.
- Added a Deployment Readiness Doctor with private integration inventory.
- Migrated the optional Evidence Lab from the early Cloudflare Computer alpha to the current Cloudflare Sandbox SDK, with R2-backed durable case files and compatible core routes.
- Updated Agent Week starter sources to track Sandboxes, Artifacts, and `cloudflare/sandbox-sdk`.

## 0.5.0 — 2026-08-07

### Continuous intelligence boundary

- Defined Driftglass as the longitudinal collection, provenance, Story-memory, and standing-question layer that complements ChatGPT rather than recreating a general research engine.
- Added a public responsibility map for Driftglass, ChatGPT conversation, Scheduled Tasks, Deep Research, AI Search, and the optional Evidence Lab.
- Reframed the Computer add-on as an artifact and reproducibility workspace while preserving its existing deployment and API paths.

### Mission operators and research escalation

- Added Mission modes, expected next events, expected dates, Deep Research policy, alert thresholds, outcome state, and a durable Mission ledger.
- Added source-aware Deep Research handoffs with current state, linked sources, preferred domains, coverage gaps, escalation rationale, a research plan, and a ready-to-use prompt.
- Added dashboard, packet, REST, MCP, and WebMCP surfaces for Mission operation, research preparation, and ledger write-back.

### Cloudflare Drop Capsules

- Added standalone static ZIP generation for public Story, Mission, and briefing shares.
- Capsules include HTML, structured JSON, evidence Markdown, `llms.txt`, and publication guidance without credentials or live service dependencies.
- Mission Capsules preserve operator context including mode, outcome, expected next event, and current conclusion.
- Added live-card and Drop-Capsule choices to the sharing interface.

### Release hardening

- Added a seventh idempotent D1 migration for Mission operators and events.
- Added ZIP integrity and CRC tests plus repository contracts for Mission, Deep Research, and Drop surfaces.
- Preserved all 0.4 collection, Story Graph, Mission Sprint, Companion, Kitesurf, ChatGPT, Lens, card, and Evidence Lab capabilities.

## 0.4.0 — 2026-08-07

### Durable Mission operations

- Added **Durable Mission Sprints** powered by Cloudflare Workflows. A sprint resolves a Mission's source scope, runs each source as an independently retried step, leaves a durable ingestion window, rebuilds Mission matches, and stores a visible result record.
- Added Mission run history, status APIs, dashboard controls, read-only MCP inspection, and unlocked WebMCP execution.
- Added a sixth D1 migration for Mission run state and Workflow linkage.

### Story intelligence graph

- Added a deterministic **Story Graph** that connects related developments through topic overlap, shared Research Missions, shared sources, and temporal adjacency.
- Added Story Graph APIs, MCP and WebMCP tools, and an interactive connected-developments panel inside Story evidence.
- Kept graph construction explainable and model-free so it remains fast, inspectable, and available on the Cloudflare free path.

### Release hardening

- Expanded the repository contract to 42 passing tests.
- Kept the one-deploy cloud core, optional cross-platform Companion, Kitesurf-first renderer, ChatGPT surface, and optional Computer Deep Dive Lab aligned under one machine-readable milestone ledger.

## 0.3.0 — 2026-08-07

### Personalization and explainability

- Added a transparent **Taste Profile** that learns recurring topic and source preferences from explicit Story feedback.
- Future ingestion now combines configured interests with learned positive and negative signals.
- Added a full “Why this appeared” score decomposition with relevance, novelty, importance, confidence, corroboration, recency, feedback adjustments, Mission matches, and learned terms.
- Added `explain_ranking` and `get_personalization_profile` to the ChatGPT MCP app plus matching WebMCP tools.

### Sharing and portable installs

- Added Kitesurf-rendered 1200×630 social previews for public Story, Mission, and briefing cards, cached in R2.
- Added a branded static preview fallback and a link from a public card to the setup guide.
- Added a validated Community Lens catalog, deep-link installation, submission template, and bundled Coding Agents and AI Infrastructure Lenses.
- Added Page Feeds, PWA share-target intake, bookmarklet capture, and installable dashboard shell.

### Source and alert expansion

- Added GitHub Activity collection for releases, issues, pull requests, and pushes.
- Added OpenAlex collection for current papers, open-access filtering, citation metadata, and research discovery.
- Added deterministic Story deltas and **Pulse**, a high-threshold packet for frequent ChatGPT alerts that emits `NO_SIGNAL` on quiet runs.
- Added a private AI Search corpus over Stories and Research Missions.

### Companion and Cloudflare Agent Week

- Added explicit start, stop, restart, status, install, and uninstall controls for LaunchAgent, Task Scheduler, and user systemd services.
- Added a real ChatGPT MCP App widget and expanded browser-agent actions for ranking explanations, Taste Profile inspection, Lens installation, capture, collection, feedback, Deep Dives, and public-card publishing.
- Added public intelligence-card Open Graph images generated through Cloudflare Kitesurf.

## 0.2.0 — 2026-08-07

### Personal intelligence

- Added persistent **Research Missions** with term matching, backfill, focused packets, and dedicated ChatGPT task prompts.
- Added Story and Mission research bundles.
- Added deterministic Deep Dive dossier generation.
- Added explicit email intake receipts and newsletter/signal ingestion.
- Expanded starter Lenses for Cloudflare Agent Week, frontier AI, coding agents, infrastructure, research, and open-source tooling.

### Cloudflare Agents Week stack

- Added adaptive public-page routing: direct HTTP → **Kitesurf** → Chromium.
- Added per-host browser profiles and renderer telemetry.
- Added stateless MCP using the current Agents SDK handler.
- Added dashboard WebMCP tools.
- Added agent-readiness files: `llms.txt`, `llms-full.txt`, MCP card, and Driftglass capability card.
- Added the first optional **Deep Dive Lab** using the then-current Cloudflare Computer alpha; release 0.6.0 supersedes that runtime with the Sandbox SDK.

### Source mesh

- Added Lobsters, Bluesky, arXiv, npm Releases, and PyPI Releases.
- Expanded GitHub, HN, and webpage source configuration.
- Added smart source discovery for GitHub, npm, PyPI, Bluesky, arXiv, and URLs.
- Added direct manual capture and Email Worker intake.

### Cross-platform Companion

- Reworked the local Relay as **Driftglass Companion** for macOS, Windows, and Linux.
- Added macOS Keychain, Windows DPAPI, Linux Secret Service, and private-file credential paths.
- Added LaunchAgent, user systemd, and Task Scheduler service installation.
- Added OpenCLI manifest discovery and generic `opencli.read` execution for entries marked `access=read`.
- Expanded fixed read capabilities across X, Reddit, YouTube, LinkedIn, Instagram, Facebook, and TikTok.
- Added `catalog`, `plan`, `probe`, and `doctor` commands.

### UX and release engineering

- Rebuilt the dashboard around Today, Missions, Sources, Capture, Companion, Browse Lab, ChatGPT, and System.
- Added PWA metadata and service worker.
- Added portable config import/export.
- Added a machine-readable milestone ledger and validator.
- Added upstream version watch automation and acknowledgement policy.
- Added one-click Deep Dive actions and core-to-Lab dossier proxying.

## 0.1.0 — 2026-08-07

- Initial Cloudflare-first personal-intelligence core.
- HN, GitHub Releases, webpages, manual capture, D1 Story memory, R2 evidence, Queue ingestion, Cron, private packet, stateless MCP, and macOS Relay prototype.
