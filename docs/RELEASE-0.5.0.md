# Driftglass 0.5.0 — continuous intelligence release candidate

Driftglass 0.5.0 sharpens the product around one job: maintaining the longitudinal context that general assistants and one-off research sessions normally lose.

## Product model

```text
Signals become Stories
Stories inform standing Missions
Missions refresh through durable Sprints
Material gaps become Deep Research handoffs
Selected evidence becomes portable cards, Drop Capsules, or Evidence Lab artifacts
```

Driftglass owns continuous collection, provenance, change detection, source health, Story memory, personalization, and standing research state. ChatGPT owns interactive interpretation and final synthesis. ChatGPT Deep Research owns broad one-off investigation. The optional Cloudflare Computer Evidence Lab owns durable files and reproducibility for selected cases.

## Mission operators

Research Missions now preserve:

- watch, decision, hypothesis, or event mode
- expected next event and optional expected date
- manual, suggested, or always-ready Deep Research policy
- evidence threshold for suggested escalation
- open, resolved, invalidated, or superseded outcome state
- a timestamped ledger of signals, expected events, escalations, notes, and outcomes

A Mission Sprint remains a bounded refresh of configured sources. It does not attempt to reproduce open-ended research.

## Deep Research handoff

A Mission can prepare a source-aware handoff containing:

- current matched Story state
- linked source URLs and preferred domains
- structural coverage gaps
- expected next event and outcome state
- escalation score and rationale
- a research plan
- a ready-to-use ChatGPT Deep Research prompt

The handoff is exposed through the dashboard, private packet route, MCP, WebMCP, and owner API. The Mission ledger can accept the resulting conclusion without coupling Driftglass to an external model API.

## Cloudflare Drop Capsules

Every public Story, Mission, or briefing card can produce a standalone static ZIP for Cloudflare Drop. A Capsule contains:

```text
index.html
 data.json
 evidence.md
 llms.txt
 README.md
```

Mission Capsules also preserve mode, outcome, expected next event, and current conclusion. The archive contains no owner secret, cookies, or live dependency on the originating Driftglass Worker.

## Evidence Lab boundary

The optional `@cloudflare/computer` deployment is now presented as the **Evidence Lab**. It is appropriate when a selected case needs durable files, chronology, source ledgers, deterministic transformations, audits, or reusable dossier artifacts. It is not required for collection, briefing, Mission operation, or Deep Research.

The existing `labs/deep-dive-lab` path and API routes remain stable for compatibility.

## Validation state

The source-complete release candidate includes:

- seven idempotent D1 migrations
- Mission operator and ledger coverage
- Deep Research handoff routes and tools
- standalone Drop ZIP generation and CRC validation
- cross-platform Companion integrity checks
- strict offline TypeScript checks for the core and Evidence Lab
- milestone and repository contract verification

Live Cloudflare account, Kitesurf, Email Worker, Companion session, ChatGPT Task/MCP, Drop upload, and Evidence Lab validation remain release gates and are sequenced in [`docs/VALIDATION.md`](VALIDATION.md).
