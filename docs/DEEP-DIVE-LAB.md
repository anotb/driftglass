# Computer Power Mode

Computer Power Mode is the optional execution tier for selected Driftglass Stories and Research Missions.

Existing integrations can keep using:

```text
labs/deep-dive-lab
DEEP_DIVE_LAB_URL
DEEP_DIVE_LAB_TOKEN
/api/.../deep-dive
```

In the product, this tier appears as Cloudflare Computer.

## Runtime

Computer Power Mode uses:

- `@cloudflare/computer`
- a SQLite-backed Computer filesystem
- Worker Loader
- `WorkerShellBackend` for command-oriented transforms
- `WorkerJavaScriptBackend` for structured modules
- two isolate backends over the same durable files
- a separate MCP server

The default deployment does not build a Docker image. The same workspace can later select a container backend for workloads that need native packages.

## Case workspace

```text
case.json
bundle.json
research-plan.md
evidence.ndjson
timeline.md
sources.csv
claims.json
notes.md
audit.md
dossier.md
evidence/
```

## Operations

- list and read files
- search evidence
- append findings and notes
- build timelines and source inventories
- run deterministic hashes and audits
- generate and export dossiers

Computer Power Mode complements ChatGPT Deep Research. Deep Research expands and synthesizes evidence; Computer Power Mode preserves and transforms the working case.
