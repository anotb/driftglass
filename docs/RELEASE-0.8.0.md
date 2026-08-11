# Driftglass 0.8.0 — Durable Memory and Intelligence Packs

Driftglass 0.8.0 turns the continuous-intelligence system into a durable, portable reasoning substrate without adding a mandatory model API or mandatory local service.

## Epistemic Memory Graph

- typed nodes for Stories, Missions, Sources, Packs, Entities, Claims, Findings, Decisions, Questions, Expectations, Events, and Preferences
- provenance-aware relations such as evidence-for, evidence-against, supports, contradicts, updates, supersedes, expects, and resolves
- structural Claim nodes linked directly to supporting source evidence
- confidence, importance, validity windows, rationale, and supersession
- typed model-proposed semantic patches with explicit approve or reject flow
- Integrity Audit for contradictions, overdue expectations, unsupported conclusions, orphans, provenance gaps, and supersession defects
- bounded recall and timeline APIs across dashboard, MCP, WebMCP, Portable Profile, and Mission Computers

### Native Memory Workflow

Memory maintenance now runs through a dedicated Cloudflare Workflow. Free mode keeps a 350-node / 1,200-edge working graph and Cheap mode keeps 500 / 2,000. Entities, sources, Missions, Packs, Story batches, evidence links, Mission matches, and pruning are separate idempotent phases.

There is no oversized single-request fallback. Missing Workflow configuration produces a visible deferred state.

## Intelligence Packs v2

- useful cloud source core plus optional Companion enrichment
- Missions with mode, research policy, sprint policy, alert threshold, and expected event
- seed Entities, Claims, Findings, Questions, Expectations, and typed relations
- evidence roles, preferred domains, freshness limits, primary-source requirements, independent-source requirements, and discovery-share limits
- reasoning playbooks, provider hints, briefing contract, output contract, and memory-patch contract
- separate Free or Cheap projections for cloud core and optional signed-in lanes
- existing deployment load included in the projection
- Queue volume estimated from source yield rather than one fixed multiplier
- per-invocation D1 install safety check before writes
- cloud-only installation as the default
- JSON and Agent Skill export
- bounded update checks and explicit upgrades
- Lens v1 backward compatibility

The three shipped Packs are cloud-first analyst modules for Cloudflare Agent Week, coding agents, and AI infrastructure and power.

## Serious subscription-model reasoning

The Context Compiler supports ChatGPT, Claude, Grok, and generic MCP clients. A bundle contains:

- objective and scope
- current Mission thesis and expected event
- source-diverse evidence with explicit evidence roles, source health, weight, domain, provider, and access class
- bounded Memory Graph neighborhood and chronology
- contradictions, gaps, and open questions
- relevant Pack evidence policies and playbooks
- task-specific output contract
- typed durable-memory patch contract
- compact reasoning and explicit operations MCP URLs

The compiler reports the actual estimated context size and exactly which sections were truncated. An oversized or weak bundle is downgraded rather than described as sufficient.

Every bundle receives a visible quality grade across evidence depth, source diversity, provenance, memory continuity, recency, challenge coverage, and cloud independence.

## Compact MCP by default

The normal endpoint contains exactly ten read-only tools:

```text
open_today
prepare_context
search
fetch
get_mission
recall_memory
explain_story
get_action_center
get_system_health
list_intelligence_packs
```

The larger `/ops` endpoint is separate and explicit. It contains Mission, Pack, feedback, Computer, research-result, and durable-memory mutations.

## Current subscription interfaces

- **ChatGPT:** custom App/MCP, bounded Scheduled Task packets, Deep Research handoff, and interface kit
- **Claude:** remote MCP, Claude Code with Mission Computer files, Agent Skill, and interface kit
- **Grok:** custom MCP connector instructions and URL, plus provider-neutral Markdown and JSON
- **Generic:** compact MCP or complete bounded interface kit

Driftglass stores no model API key and does not call a model for every item.

## Cost discipline

- conservative Free application envelope
- explicit Cheap envelope
- real reservations in source collection, Queue ingestion, browsing, Workflows, memory, AI Search, Pack installation, and Computer synchronization
- roughly three Queue operations accounted for per delivered message
- Pack install query estimate with Free invocation headroom
- native Workflow graph maintenance under D1 query limits
- full → compact → deferred graph projection under pressure

## Portable Profile v3

Profile export and dry-run merge restore cover:

- sources and Missions
- Mission operators, research state, and ledger
- Intelligence Packs
- custom reasoning playbooks
- budget profile and graph policy
- approved durable-memory patches
- Taste Profile and saved views

Transient Story and source graph nodes rebuild from canonical data after restore.

## Optional latest-generation services

The core D1 graph remains portable. Cloudflare AI Search is an optional rebuildable retrieval index. The separately deployable Agent Memory bridge can receive approved checkpoints for private-beta users. Every Mission retains its Cloudflare Computer workspace, while the Companion remains optional enrichment and local mirroring.

## Frozen validation

The source release passes:

- 66 Node tests with zero failures
- strict offline TypeScript for the core
- strict offline TypeScript for Computer Power Mode
- strict offline TypeScript for the Agent Memory bridge
- 12 ordered D1 migrations
- Lens and Intelligence Pack catalog validation
- 50-complete / 2-next milestone verification
- repository-contract verification
- dashboard, WebMCP, service-worker, and Companion syntax checks
- public JSON metadata parsing

Connected dependency installation, generated Wrangler types, `wrangler check`, deployment dry run, clean-account resource provisioning, real browser sessions, and live ChatGPT/Claude/Grok connections remain the release gates.
