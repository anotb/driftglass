# Runtime fabric

Driftglass presents one source and Mission experience while choosing the least expensive capable runtime underneath it.

```text
request or routine step
        ↓
capability, privacy, persistence, and budget requirements
        ↓
Worker → Kitesurf → Chromium → Mission Computer → Companion
```

## Runtime roles

| Runtime | Use it for | Avoid using it for |
|---|---|---|
| Worker | APIs, feeds, direct HTTP, parsing, deterministic transforms, orchestration | logged-in personal sessions or long stateful investigation |
| Kitesurf | public JavaScript pages, extraction, screenshots, short agent-oriented browse work | sites requiring full Chromium compatibility or personal cookies |
| Chromium | compatibility fallback for public pages that Kitesurf cannot render correctly | default collection path |
| Mission Computer | durable files, timelines, notes, checkpoints, dossiers, and bounded deterministic routines for one standing question | global cross-Mission indexing |
| Companion | signed-in or personalized sources and local Mission Computer mirroring | mandatory cloud operation |

The owner adds a source or starts a Routine. They do not choose browser engines or execution substrates.

## Routing inputs

The router considers:

- public versus authenticated access
- whether a browser is required
- whether Chromium compatibility is required
- whether work needs durable Mission files
- whether a local signed-in session is available
- selected Free, Cheap, or custom budget
- recent renderer and source health
- runtime preference declared by a deterministic Routine step

## Cloud independence

Every shipped Intelligence Pack contains a useful public cloud core. Companion lanes are optional enrichment and install dormant unless explicitly enabled.

A disconnected Companion can reduce coverage but cannot disable:

- public source collection
- Story and Mission continuity
- Memory Graph recall
- Mission Computers
- evidence receipts
- ChatGPT or Claude reasoning over cloud evidence

## Budget behavior

A runtime plan is evaluated through the Budget Governor before work begins. Under pressure Driftglass may:

- defer a low-priority run
- remain on direct HTTP
- postpone browser rendering
- reduce a derived Computer projection
- schedule a Routine later

Canonical D1 and R2 state is not discarded to satisfy a derived-work budget.
