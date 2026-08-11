# Memory checkpoints

The Memory Graph is temporal. A checkpoint freezes an exact bounded graph state in R2 and stores its hash, graph counts, scope, and creation reason in D1.

## Why checkpoints exist

Current-state recall alone cannot answer:

- What did I believe before this release or filing?
- Which claims appeared, disappeared, or changed confidence?
- Was a forecast resolved or merely forgotten?
- Did a model recommendation use the same memory state as another model?

A checkpoint makes those questions reproducible.

## Comparison

A checkpoint comparison reports:

- added and removed nodes
- changed node confidence, importance, validity, or content
- added and removed relations
- changed relation strength or rationale
- counts by node and relation type

The comparison is deterministic. A reasoning model may interpret its significance, but it does not decide what changed.

## Bounds

Checkpoints inherit the active Memory Graph profile. They never serialize an unbounded history into one request. Full snapshots live in R2; D1 retains compact metadata for lookup and comparison.

## Use in reasoning

Evidence-State Receipts identify the checkpoint or current graph state used during compilation. Two model runs can therefore be compared against identical evidence and memory rather than two silently changing contexts.
