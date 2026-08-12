# Driftglass Agent Memory Bridge

An optional bridge from Driftglass's approved, queryable epistemic graph into Cloudflare Agent Memory.

The core Driftglass graph remains the portable source of truth. This bridge adds managed natural-language recall for users with Agent Memory private-beta access. It is intentionally a separate Worker so the default Driftglass deployment remains free-first and does not require a beta namespace.

## Why checkpoint ingestion

Driftglass sends explicit approved graph checkpoints, not every chat turn. Agent Memory's `ingest()` path is idempotent and performs extraction, verification, classification, temporal handling, and supersession. The bridge chunks a checkpoint below Agent Memory's per-message size limit and uses deterministic session IDs.

## Deploy

```bash
cd labs/agent-memory-bridge
npm install
npx wrangler agent-memory namespace create driftglass
npx wrangler secret put BRIDGE_SECRET
npm run deploy
```

## Sync from Driftglass

Copy the private Memory packet URL from your Driftglass Reasoning view, then:

```bash
curl -X POST "https://YOUR-BRIDGE/profiles/personal-intelligence/sync-url" \
  -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR-DRIFTGLASS/packet/PRIVATE_READ_KEY/memory.md"}'
```

## Recall

```bash
curl -X POST "https://YOUR-BRIDGE/profiles/personal-intelligence/recall" \
  -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query":"What decisions and unresolved expectations do I have around agent browsers?","thinkingLevel":"high","responseLength":"long"}'
```

Available routes:

```text
POST /profiles/:profile/sync
POST /profiles/:profile/sync-url
POST /profiles/:profile/remember
POST /profiles/:profile/recall
GET  /profiles/:profile/summary
GET  /profiles/:profile/memories
```

Agent Memory is a private beta. Driftglass works fully without this bridge.
