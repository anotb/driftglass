# Judgment Loop

Driftglass should improve reasoning without becoming a model host or an opaque autonomous agent.

The Judgment Loop does that by preserving the exact state a model saw, the result it produced, the decision the user made, and what happened afterward.

## Evidence-State Receipt

Before serious reasoning, Driftglass compiles and persists an exact receipt:

```text
reasoning/{date}/{receipt-id}/bundle.json
reasoning/{date}/{receipt-id}/bundle.md
```

The D1 record retains the bundle hash, scope, provider target, task, objective, quality gate, token estimate, truncation state, and R2 keys.

A receipt contains:

- objective and task
- Mission state and expected event
- current Stories and temporal deltas
- source-diverse evidence with family and lineage roles
- source health and access class
- relevant Memory Graph neighborhood and checkpoints
- contradictions, missing evidence, and open questions
- Pack evidence policy and reasoning playbook
- output and memory-patch contracts

The receipt is immutable. A new context produces a new receipt rather than mutating an old one.

## Prepared reasoning tasks

Deterministic routines and the Action Center can queue work such as:

- investigate a material Story change
- challenge a standing thesis
- make or revisit a decision
- prepare a Deep Research handoff
- review a proposed durable-memory update

A queued task can be materialized into an exact receipt. The compact MCP exposes the highest-priority ready task through `next_reasoning_task`.

## Provider-neutral runs

A reasoning run records:

- receipt and bundle hash
- provider, model, and client labels
- response and response hash
- structured result
- confidence and citations
- review rating and decision
- optional typed memory proposal

The model call happens in ChatGPT, Claude, Grok, or another chosen client. Driftglass stores no provider API key.

## Cross-model comparison

Several providers may reason over the same receipt. Driftglass compares:

- lexical agreement
- confidence spread
- consensus terms
- divergent pairs
- whether adjudication is warranted

Agreement is a diagnostic, not a truth score. Source evidence, provenance, and user review remain authoritative.

## Decision ledger

The ledger supports:

```text
decision · forecast · thesis · commitment
```

Each record may include:

- statement and rationale
- confidence or probability
- assumptions
- supporting Story, Mission, or Memory references
- review date
- outcome
- review notes
- calibration

Forecast reviews can produce Brier-style calibration summaries. Decisions can be projected into the Memory Graph so later reasoning sees prior commitments and outcomes.

## Review boundary

Model output never silently becomes canonical memory. A reasoning result can:

1. remain an unreviewed result,
2. be approved or rejected,
3. stage a typed memory proposal,
4. contribute to a decision review.

That preserves model flexibility without giving any current model permanent authority over the user’s intelligence state.
