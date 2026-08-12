# Optional Agent Memory bridge

The Agent Memory bridge is a separately deployable accelerator for accounts with Cloudflare Agent Memory access.

Driftglass sends approved epistemic-memory checkpoints rather than raw chat transcripts or every ranking event. The bridge:

- chunks approved checkpoints into bounded messages
- uses deterministic checkpoint session IDs
- supports natural-language recall and summaries
- leaves canonical graph state in D1
- can be removed or rebuilt without losing Driftglass memory

Deploy it from `labs/agent-memory-bridge/`. The cloud core does not require this private-beta surface.
