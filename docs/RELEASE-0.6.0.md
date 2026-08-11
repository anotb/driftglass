# Driftglass 0.6.0 — feature-complete release candidate

Driftglass 0.6.0 closes the operational loop around continuous personal intelligence. The release does not add another general research agent. It makes standing intelligence reliable enough to use without constant dashboard maintenance.

## Mission Autopilot and Action Center

A Mission can refresh its scoped evidence on a schedule, retain its last and next Sprint times, and remind the owner before or after an expected event. The Action Center reduces all owner work to a finite queue:

- research results awaiting approval
- due Mission Sprints
- approaching or overdue expected events
- degraded sources
- recently resolved Missions

The same queue appears in the dashboard, ChatGPT briefing widget, Scheduled Task prompt, REST API, MCP, and WebMCP.

## Reviewable Deep Research write-back

Deep Research remains the broad investigation engine. Driftglass now publishes a stable result contract, stages returned conclusions as a diff, and requires an explicit confirm or reject decision before durable Mission state changes. Confirmed results update the thesis, report summary, open questions, confidence, report link, expected-event state, and ledger atomically.

## Portable Profile v2

A single Profile export carries the personal operating state that would otherwise be painful to recreate:

- sources and schedules
- Missions and operators
- expected events and outcomes
- research baselines and ledger entries
- interests and Taste Profile
- saved views

Import supports a dry-run preview and merge semantics. It is configuration and intelligence-state portability, not a bulk evidence archive.

## Deployment Readiness Doctor

The Doctor verifies schema, enabled sources, first packet, browser and Workflow bindings, active Missions, Companion status, Email intake, and pending research approvals. It also exposes the private packet, Pulse, MCP, and corpus URLs needed to connect ChatGPT and optional services.

## Current Cloudflare Evidence Lab

The optional Evidence Lab has moved from the early Cloudflare Computer alpha to the current Cloudflare Sandbox SDK. R2 is the durable source of truth; named Sandboxes provide isolated Linux search, hashing, and deterministic transformations when a case needs them. Existing core routes, folder paths, and environment variable names remain compatible.

The Lab stays separately deployable on Workers Paid. The core remains inexpensive and deployable from source.

## Product boundary

Driftglass owns continuity, evidence state, change detection, personalization, expected events, and research readiness. ChatGPT owns interpretation. Deep Research owns broad one-off synthesis. Evidence Lab owns durable artifacts and reproducibility.

No model API was added to routine collection.
