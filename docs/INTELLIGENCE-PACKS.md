# Intelligence Packs v3

An Intelligence Pack is a portable analyst module for Driftglass. It packages source coverage, standing questions, epistemic starting points, evidence standards, deterministic routines, reasoning method, and a cost envelope in inspectable JSON.

It is intentionally more than a source list and less than a hosted black-box agent.

A Pack can include:

- a useful public cloud source core
- optional signed-in Companion lanes
- Research Missions, operators, expected events, and views
- seed entities, claims, findings, questions, expectations, and relations
- evidence-quality policy and preferred primary-source domains
- deterministic Intelligence Routines
- reasoning playbooks and provider hints
- output and durable-memory patch contracts
- a Free, Cheap, or custom Cloudflare budget contract
- an update URL and upstream lineage

## Cloud-first contract

Every catalog Pack must produce useful intelligence immediately after a fresh cloud-only installation. The cloud core is the default install path. A credential-gated cloud lane is allowed only when the remaining cloud core is independently useful, the Pack preview names the prerequisite, and scheduling defers that lane without consuming its budget or starving ready sources. Companion lanes are separately previewed and activated only when the owner chooses them.

A Pack preview compares:

```text
Cloud core
Cloud core + optional Companion lanes
```

It accounts for existing deployment load and projects:

- source runs per day
- expected item yield
- Queue messages and approximate underlying operations
- rendered browsing and expected fallback share
- Mission and Routine Workflow steps
- initial memory writes
- Pack-install D1 query count
- remaining Budget Governor capacity
- cloud independence

Preview also reports immediately runnable cloud sources separately from credential-deferred sources. Cost and budget projections still include every enabled Pack source so optional setup never makes the eventual operating envelope look artificially cheap. OpenAlex is the current example: all requests require the optional `OPENALEX_API_KEY` runtime secret; the credential is never valid Pack, Lens, profile, overlay, or source configuration.

Free installs reserve headroom beneath D1’s per-invocation query ceiling. Preview reports separate cloud-core and cloud-plus-Companion install estimates. A Pack that is too large to install consistently in one invocation is rejected with a recommendation to split it or choose another profile; `allowOverBudget` may override application budget projections, but never this platform safety envelope.

## Evidence policy

A Pack may specify:

- minimum primary or authoritative sources
- minimum independent evidence families
- preferred domains
- maximum discovery-source share
- maximum evidence age
- expected source roles
- required contrary-case coverage

The Context Compiler merges relevant Pack policies before selecting evidence. A Pack therefore contributes a method, not merely URLs.

## Epistemic seeds

Pack memory is provisional. It can define:

- entities and aliases
- claims with confidence and validity windows
- open questions
- falsifiable expectations and expected dates
- provisional findings
- typed relations

Seeds establish what to watch and what would change the thesis. They do not bypass evidence review or memory approval.

## Intelligence Routines

Pack v3 may include bounded deterministic routines. Routines can refresh source lanes, wait for ingestion, rebuild a Mission, synchronize a Mission Computer, audit or checkpoint memory, prepare Deep Research, or compile an exact reasoning receipt.

Routines are visible, budgeted, and executed through Cloudflare Workflows. They do not call an LLM or choose a hidden provider.

## Reasoning contract

A Pack can carry:

- task-specific playbooks
- provider hints for ChatGPT, Claude, Grok, or a generic client
- briefing and judgment contracts
- required output structure
- durable-memory proposal instructions

The same method travels with Pack JSON, the generated Agent Skill, Drop Capsules, and provider-neutral interface kits.

## Overlay and update lifecycle

A Pack can be:

- previewed from JSON or a public URL
- installed cloud-only by default
- extended with optional Companion definitions
- customized locally through an overlay
- checked on demand against its update URL
- upgraded after conflict-aware overlay reapplication
- exported as Pack JSON or Agent Skill
- exported as an independently portable customized fork

Local source and Mission changes can be captured into an overlay after the fact. Upstream updates do not silently activate new Companion lanes or erase local judgment.

See [`docs/PACK-OVERLAYS.md`](PACK-OVERLAYS.md).

## Pack versus Lens

A Lens v1 remains a lightweight source and Mission bundle. Driftglass upgrades it into the Pack model during parsing. New community modules should use Intelligence Pack v3 for evidence policy, memory, routines, budgets, and upgrade lineage.

## Community Packs

The repository ships cloud-first modules for:

- Cloudflare Agent Week
- coding agents
- AI infrastructure and power

Each includes several cloud lanes, optional signed-in enrichment where useful, a standing Mission, provisional memory, an evidence policy, deterministic routines, and a Free-tier budget contract. Contributors can add a domain module without writing Worker code.
