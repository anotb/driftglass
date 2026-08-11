# Forkable intelligence

Driftglass treats an intelligence setup as something that can be shared, inspected, installed, and independently evolved.

## Intelligence Pack

A Pack is the reusable analyst module. Pack v3 may include:

- public cloud sources
- optional Companion enrichment
- Missions and expected events
- memory seeds and typed relations
- evidence policy
- deterministic Intelligence Routines
- reasoning and output contracts
- budget envelope
- upstream lineage and update URL

Local changes are stored as overlays. Upstream updates reapply the overlay and report conflicts. The effective customized setup can be exported as a new Pack fork.

## Intelligence Drop

A Drop Capsule is a static Cloudflare Drop-compatible ZIP containing:

- human-readable intelligence page
- structured data and evidence Markdown
- agent-readable instructions
- PWA metadata
- a cloud-only Pack fork that continues monitoring the public evidence lanes

A recipient may read the artifact without Driftglass, upload it to Cloudflare Drop, or install the embedded Pack into their own deployment.

## Distribution ladder

```text
live private state
    ↓ publish selected evidence
public intelligence card
    ↓ export portable snapshot
Cloudflare Drop Capsule
    ↓ continue monitoring
forkable Intelligence Pack
    ↓ customize safely
Pack overlay and independent fork
```

## Git and Cloudflare Artifacts

Ordinary Git repositories remain the stable open-source transport for Pack catalogs and community contribution. Cloudflare Artifacts is a promising future optional bridge for versioned Git-compatible Mission outputs, but it is not required by the Free core while access and plan availability remain limited.

The distribution loop must work today with static files, GitHub, Cloudflare Drop, and one Worker deployment.
