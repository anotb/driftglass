# Living Dossiers

A Living Dossier is the current durable answer state for one subject. It keeps the latest thesis, source trail, open questions, and earlier states together between model sessions.

## Scope

A dossier may describe:

- the entire personal-intelligence system,
- one Research Mission,
- one Story,
- or an explicit query.

## Contents

Driftglass compiles:

- current thesis and active conclusions,
- relevant entities, claims, findings, outcomes, and decisions,
- contradictions,
- chronological changes,
- current Stories,
- evidence-source and domain coverage,
- primary or authoritative evidence count,
- open questions,
- quality grade and blockers.

The document is deterministic. It is rebuilt from D1 and R2, so it remains portable across reasoning providers and can be regenerated after model changes.

## How it helps

A chat prompt usually lacks three things:

1. what was believed before,
2. what evidence changed,
3. which questions remain unresolved.

A Living Dossier supplies all three before a reasoning model starts, so ChatGPT, Claude, Grok, or another connected model can work from the question’s current state and history.

## Relationship to other Driftglass objects

- **Story:** one evolving development.
- **Mission:** one standing question or decision.
- **Memory Graph:** canonical typed long-term state.
- **Evidence-State Receipt:** frozen context for one reasoning run.
- **Living Dossier:** current readable state, regenerated whenever needed.
- **Deep Research handoff:** broader investigation plan used when current evidence is insufficient.
