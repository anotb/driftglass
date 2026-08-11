# Driftglass Intelligence Packs

An Intelligence Pack is a portable domain module for Driftglass. It can contain cloud-only sources, optional Companion sources, standing Research Missions, Memory Graph seeds, focused views, reasoning playbooks, provider-specific hints, and an explicit Free/Cheap budget contract.

Lens v1 files remain installable. Driftglass upgrades them into Pack v3 internally, but new community modules should use this format.

## Design requirements

- A Pack must remain useful without a Companion. Signed-in sources belong in `companionSources` and install disabled until the user pairs a Companion.
- Prefer primary, official, and deterministic cloud sources for the baseline.
- Keep schedules within the declared budget profile. The install preview reports projected source runs, Queue volume, Browser use, Workflow steps, and memory writes.
- Memory seeds should define durable entities and standing questions, not copy transient news.
- Reasoning playbooks should improve the model's method and output contract rather than prewrite the conclusion.

## Install

A public raw JSON URL can be previewed and installed from Driftglass, ChatGPT MCP, or the owner API:

```text
POST /api/intelligence-packs/preview
POST /api/intelligence-packs/install-url
```

## Contribute

1. Copy an example from `intelligence-packs/examples/`.
2. Use stable, unique IDs.
3. Run `npm run intelligence-packs:check`.
4. Open a pull request.
