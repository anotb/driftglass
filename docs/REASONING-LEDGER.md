# Reasoning ledger

Driftglass keeps a record of the source state a model used and the answer it returned. No model API key is required.

## Evidence-State Receipt

A receipt is an immutable, hashed Markdown and JSON package containing:

- objective and task
- Mission and decision state
- selected evidence and source-family lineage
- Memory Graph continuity and checkpoint references
- contradictions, gaps, and open questions
- Pack playbook and evidence policy
- actual estimated context size and truncation details
- required output and optional memory-patch contracts

D1 stores receipt metadata and R2 stores the exact bundles.

## Model runs

A result recorded against a receipt preserves:

- provider, model, and client labels
- receipt and bundle hashes
- raw and structured output
- citations and confidence
- response hash
- review and rating
- proposed memory or decision changes

ChatGPT, Claude, Grok, or another client can use the same receipt. Driftglass compares the outputs without treating agreement as truth.

## Judgment queue

Continuous monitoring and deterministic Routines create a finite queue of work such as:

- investigate a material Story change
- challenge a Mission thesis
- revisit a decision
- prepare broader Deep Research
- review a memory proposal

The queue ranks work and can legitimately be empty.

## Review boundary

Model output may remain an unreviewed result, be approved or rejected, stage a typed Memory Graph proposal, or support a decision review. It never silently rewrites canonical memory.
