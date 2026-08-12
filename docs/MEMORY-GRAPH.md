# Sparse epistemic Memory Graph

Driftglass keeps a provenance-aware graph of the claims, findings, questions, decisions, forecasts, and source relationships worth carrying between briefings. It stores selected durable state instead of chat transcripts or every source paragraph.

## Canonical layer

D1 is the portable source of truth. The active Budget Governor profile determines the structural refresh envelope:

| Profile | Missions | Stories | Sources | Evidence rows | Durable graph cap |
|---|---:|---:|---:|---:|---:|
| Free | 12 | 40 | 24 | 120 | 350 nodes / 1,200 edges |
| Cheap | 25 | 80 | 60 | 400 | 500 nodes / 2,000 edges |
| Custom | 30 | 90 | 70 | 500 | 500 nodes / 2,000 edges |

Independent proposal and recall bounds remain:

```text
50 pending semantic proposals
80 nodes in one recalled neighborhood
```

The graph stores durable state, not every source paragraph or conversation turn.

## Native Workflow maintenance

Graph maintenance runs through a dedicated Cloudflare Workflow rather than one oversized Worker invocation. The workflow separates planning, entities, sources, Missions, Packs, Story batches, evidence links, Mission matches, and final pruning into small idempotent steps.

This matters for Free mode because D1 limits the number of queries a single Worker invocation can make. Driftglass therefore has no hidden inline fallback. If the `MEMORY_WORKFLOW` binding is unavailable, refresh returns a visible deferred state instead of attempting unsafe single-request maintenance.

A refresh records:

- queue and workflow identifiers
- active Budget Governor profile
- current phase
- estimated Workflow steps and memory writes
- nodes and edges written
- pruning and truncation
- completion, partial, deferred, or failed state

Only one refresh may be active at a time.

## Memory model

Node types include:

```text
Story · Mission · Source · Pack · Entity
Claim · Finding · Decision · Question · Expectation · Event · Preference
```

Relations preserve epistemic meaning and provenance:

```text
observed_in · evidence_for · evidence_against
supports · contradicts · updates · supersedes
asks · answers · expects · resolves
mentions · about · relevant_to · contains
```

Nodes and edges can carry confidence, importance, validity windows, source references, rationale, and supersession.

## Structural and semantic memory

Structural memory is rebuilt deterministically from approved Driftglass state. Story Claim nodes summarize the current detected development, while source evidence links preserve which records support that claim.

Semantic findings, decisions, expectations, questions, and relations arrive as typed model proposals. Each patch is schema-validated, bounded, deduplicated, and held for approval. A reasoning subscription may suggest durable memory; it never silently becomes canonical truth.

## Memory and Mission Computers

Each Mission Computer receives a projection of its relevant graph. Synchronization degrades deliberately under budget pressure:

```text
full graph projection → compact projection → defer
```

The D1 graph remains canonical, so a deferred Computer sync cannot lose durable memory. The local Companion may mirror the Mission Computer, but neither recall nor cloud collection depends on a Companion being present.

## Integrity audit

The on-demand audit checks:

- unresolved contradictions
- overdue expectations
- unsupported durable conclusions
- orphaned nodes
- incomplete supersession chains
- provenance gaps
- configured graph bounds

It does not run on every dashboard load, keeping D1 reads predictable while making a serious reasoning session inspectable.

## Optional retrieval accelerators

Cloudflare AI Search may index rebuildable Story, Mission, briefing, and approved-memory documents for semantic retrieval. The optional Agent Memory bridge can project approved checkpoints into Cloudflare Agent Memory for managed natural-language recall.

Both are accelerators. Neither replaces the D1 Memory Graph, and Driftglass remains usable without either service.
