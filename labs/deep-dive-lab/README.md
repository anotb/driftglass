# Driftglass Computer Power Mode

Power Mode is the optional execution upgrade for Driftglass Mission Computers.

The cloud core already gives every Research Mission a durable `@cloudflare/computer` filesystem that works without a container or model API. This separately deployable Worker adds Cloudflare Computer's fast **Worker-shell** and **Worker-JavaScript** backends against the same agent-style workspace model.

Power Mode uses the shell feature groups bundled into Computer 0.1.1's supported Worker-shell backend:

```text
file
html-to-markdown
jq
sqlite
xan
```

Core shell commands such as `cat`, `grep`, `sed`, `find`, and hashing tools remain available. The JavaScript backend runs structured modules with JSON input/results and writes outputs back into the same durable workspace. Both run in Dynamic Workers and need no Docker image.

Computer's bundle also contains `python3`, but that command depends on `node:worker_threads`, which the workerd shell isolate does not support. Use the Worker-JavaScript backend for supported structured computation.

## Deploy

```bash
cd labs/deep-dive-lab
npm ci
npx wrangler secret put DEEP_DIVE_LAB_SECRET
npm run deploy
```

The committed npm install policy permits only the exact `esbuild` and `workerd` lifecycle scripts required by Wrangler; optional native install hooks remain denied.

Then set the main Driftglass Worker secrets:

```bash
npx wrangler secret put DEEP_DIVE_LAB_URL
npx wrangler secret put DEEP_DIVE_LAB_TOKEN
```

`DEEP_DIVE_LAB_TOKEN` must equal the Lab's `DEEP_DIVE_LAB_SECRET`.

## Product role

Use Power Mode when a selected Story or Mission benefits from deterministic computation over durable files:

- timeline and source-ledger transformations
- CSV inspection with `xan`
- structured filtering with `jq`
- local SQLite analysis
- bounded Worker-JavaScript transforms
- reproducibility audits
- reusable evidence dossiers
- structured source maps, timeline gaps, evidence matrices, and claim-review queues

The ChatGPT subscription remains the reasoning surface. Power Mode is the file-and-tool workspace behind the research, not a second general chatbot.

## Existing compatibility surface

The folder and core integration names remain stable:

```text
labs/deep-dive-lab
DEEP_DIVE_LAB_URL
DEEP_DIVE_LAB_TOKEN
/api/.../deep-dive
```

The runtime returned by `/health` and `/integration` is `@cloudflare/computer` with `worker-shell` and `worker-javascript` execution. Use `POST /cases/{id}/transform` or the `run_structured_transform` MCP tool for typed JavaScript transforms.
