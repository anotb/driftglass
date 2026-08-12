# Product boundary

Driftglass provides continuous personal intelligence for questions that change over time. It gathers selected sources, preserves where claims came from, keeps earlier answers and decisions, and prepares source-linked context for the reasoning model a person already uses.

ChatGPT, Claude, Grok, Deep Research, and the open web remain the places for interpretation and broader investigation. Driftglass supplies the current evidence and the history behind it.

## Responsibility map

| Layer | Owns | Does not own |
|---|---|---|
| Driftglass core | collection, provenance, sparse Memory Graph, Story continuity, source health, Missions, expected events, Pack configuration, cost control, approvals | final broad synthesis or a mandatory model loop |
| Mission Computer | durable files, ledgers, notes, evidence indexes, handoffs, reviewed results, exports | the global cross-Mission index or an opinionated autonomous agent |
| Intelligence Pack | domain sources, Mission operators, starter memory, evidence policy, playbooks, provider hints, output and memory-patch contracts, budget contract | credentials, private browser sessions, or a model subscription |
| ChatGPT conversation | interpretation, comparison, judgment, recommendations, interactive reasoning | always-on monitoring and canonical longitudinal state |
| ChatGPT Scheduled Tasks | proactive finite briefings and high-threshold alerts | durable source state or exhaustive collection |
| ChatGPT Deep Research | broad one-off investigation, new-source discovery, contradiction resolution, cited synthesis | continuous monitoring or canonical Mission memory |
| Claude / Claude Code | deep analysis, technical work, Agent Skills, MCP-assisted reasoning | Driftglass-owned persistence and collection |
| Grok and other MCP clients | alternative reasoning perspective and current social interpretation | canonical memory and source provenance |
| AI Search | optional semantic retrieval accelerator over rebuildable Driftglass documents | canonical memory, Mission state, or approval decisions |
| Agent Memory bridge | optional checkpoint projection for Cloudflare's private-beta memory service | canonical D1 Memory Graph |
| Computer Power Mode | bounded transforms over durable workspaces | routine collection or final editorial judgment |
| Cloudflare Drop | portable publication of selected static intelligence | live private state |

## Canonical memory

The sparse D1 Memory Graph is the source of truth for durable knowledge. It stores a bounded set of typed nodes and provenance-aware relations across Stories, Missions, sources, entities, questions, findings, expectations, decisions, and outcomes.

Structural memory is refreshed deterministically from Driftglass state through a native Cloudflare Workflow whose phases remain inside the Free D1 invocation envelope. A reasoning model may propose semantic memory changes through a typed patch, but those changes remain staged until explicitly approved. Supersession is preserved rather than silently rewriting history.

AI Search and Agent Memory are projections that can be rebuilt. They improve retrieval without owning truth.

## Intelligence Packs

An Intelligence Pack is the portable unit of domain intelligence. A Pack may contain:

- cloud-only sources
- optional Companion sources
- Research Missions, operators, and expected events
- saved views
- Entities, Claims, Findings, Questions, Expectations, and typed relations
- evidence roles and quality policy
- domain playbooks
- model-specific hints
- output and durable-memory patch contracts
- a Free, Cheap, or custom budget contract
- an update URL

Installation always produces separate cloud-core and cloud-plus-Companion change and cost previews. Companion sources can be omitted or installed dormant, so a Pack remains useful in a cloud-only deployment and updates never silently activate local lanes.

## Prepared context

Driftglass prepares a source-linked reasoning bundle at the depth selected by the user. The bundle contains:

- the actual objective
- current Mission and thesis state
- source-diverse evidence with explicit role, health, weight, domain, provider, and access class
- durable memory and timeline
- contradictions and gaps
- Pack playbooks
- explicit uncertainty
- a required output contract
- an optional durable-memory patch contract
- actual estimated context size and explicit truncation details

The bundle reports evidence depth, source diversity, provenance, memory continuity, recency, contrary-case coverage, and cloud independence. It also reports its estimated size and anything omitted from the selected source window. The connected model can fetch more source detail when needed and keeps its conclusions separate from proposed memory changes. Normal reasoning uses the compact read-only MCP; the operations MCP is connected separately for explicit state changes.

## What a Mission is

A Mission exists when a question benefits from state across time.

Good Missions:

- What changes in Codex or Claude Code should I adopt?
- Is grid capacity becoming the binding constraint on AI infrastructure?
- What event would invalidate this thesis?
- Which Cloudflare agent capabilities are ready to use now?

A good Mission answers:

1. What are we trying to know or decide?
2. What observable event would update the answer?
3. What changed since the prior state?
4. When should monitoring escalate into broader research?

A one-off explanation, fixed-document summary, or ordinary comparison belongs directly in a reasoning model or Deep Research.
