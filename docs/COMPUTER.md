# Cloudflare Computer in Driftglass

Cloudflare Computer is the working-memory layer of Driftglass.

## Three compatible modes

| Mode | Runtime | Best use |
|---|---|---|
| Mission Computer | Durable Object filesystem only | Always-on state, notes, evidence, handoffs, reviewed results |
| Local mirror | Companion on macOS, Windows, or Linux | Editors, coding agents, local scripts, local models, Git |
| Computer Power Mode | Worker shell + Worker JavaScript | Reproducible command and structured transforms in Cloudflare |

The Mission workspace format is portable across all three.

## Core Mission Computer

Every Research Mission has a named `MissionComputer` Durable Object. The filesystem is backed by Durable Object SQLite and synchronized from canonical D1 state.

```text
README.md
mission.md
state/mission.json
state/operator.json
state/research.json
state/latest-sync.json
ledger/events.ndjson
ledger/sprints.ndjson
stories/index.ndjson
evidence/index.ndjson
handoffs/deep-research.md
notes/
results/
exports/
```

Managed files refresh automatically. Working directories are preserved.

Each refresh writes a current projection of up to 32 matched Stories and 32 source items, chosen breadth-first across the Mission. `state/latest-sync.json` records how many matched Stories and source items were included and whether more remain. D1 stays canonical for collected material outside that workspace snapshot.

## ChatGPT and browser-agent tools

Agents can:

- open a Mission Computer
- read a file
- search the workspace
- append a durable note
- export the workspace

The same operations are available through owner APIs, MCP, WebMCP, and the dashboard.

## Local mirror

```bash
driftglass-companion workspace-sync --id MISSION_ID
driftglass-companion workspace-list --id MISSION_ID
driftglass-companion workspace-search --id MISSION_ID --query "Kitesurf"
driftglass-companion workspace-note --id MISSION_ID --content "Finding"
driftglass-companion workspace-push --id MISSION_ID
driftglass-companion workspace-export --id MISSION_ID
```

The background service refreshes managed files every 15 minutes. Local files under `notes/`, `results/`, and `exports/` are preserved and can be pushed back.

## Power Mode

`labs/deep-dive-lab` adds two fast isolate backends against Computer workspaces: Worker shell for familiar text/data commands and Worker JavaScript for typed structured transforms. Its external path and environment names remain stable for compatibility.

Built-in JavaScript transforms currently produce source maps, timeline-gap reports, evidence matrices, and claim-review queues under `exports/`. Full Linux container execution remains an optional future backend for workloads that actually need native binaries or networked package installs.
