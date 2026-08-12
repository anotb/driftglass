# Portable capsules and Cloudflare Drop

Driftglass uses one product language across hosts:

- **Share** is the action.
- **Shared Story**, **Shared Mission**, and **Shared Briefing** are the recipient experiences.
- A **portable capsule** is the downloadable ZIP.
- **Cloudflare Drop** is one optional place to host that ZIP.

## Live share

The default Share is an expiring page served by the originating Driftglass. It includes a readable public-evidence briefing, source links, a structured JSON representation, and an Open Graph preview.

Use it when the recipient should get a link that expires and remains connected to the source deployment.

## Portable capsule

Every Shared Story, Mission, or Briefing can be downloaded as a standalone ZIP:

```text
index.html                recipient-facing briefing
data.json                 structured recipient copy
evidence.md               readable source record
driftglass-pack.json      optional Pack for continuing the question
llms.txt                  compact discovery guide
README.md                 contents and hosting notes
```

The capsule has no owner secret, cookies, database connection, or dependency on the originating Driftglass. It can be read locally or served by any static host. Cloudflare Drop is convenient, but not required.

## Recipient experience

The live page, Markdown, and capsule lead with the finding. Each finding states whether the public evidence is independently corroborated, partially corroborated, lineage-unclear, or single-source, then provides the source record. Driftglass does not turn deterministic collection scores into prose certainty or invent a “why it matters” claim that the evidence does not support.

The structured copy contains no internal Story IDs, execution counters, or configuration fields. The optional Pack is separate because it is an installation artifact, not part of the briefing.

## Public-evidence boundary

Sharing is fail-closed. Driftglass rebuilds each Shared Story from evidence whose access class is `public`. Email, Companion/collector, subscriber-local, authenticated-local, and private evidence is excluded.

Stored Story titles, summaries, scores, and Mission operator conclusions may have been influenced by private material, so they are not copied into the public projection. Title, summary, evidence status, lineage, and change time are rebuilt from the surviving public evidence. Legacy Mission context is dropped when a stored Share is read. A Story, Mission, or Briefing with no public evidence is rejected.

Share schema v2 carries an explicit public-evidence marker and per-item public access marker. Older schemas cannot prove the boundary and must be regenerated. Capsule generation validates the same schema before producing any output.

`PUBLIC_INDEXING` controls each live representation. When disabled, HTML, JSON, Open Graph images, and ZIP responses send `X-Robots-Tag: noindex, nofollow` and are not publicly cached. A capsule generated in that mode also contains a noindex meta tag and a disallowing `robots.txt`. Indexing is opt-in.

## Publish with Cloudflare Drop

1. Create a Share in Driftglass.
2. Download the portable capsule.
3. Open Cloudflare Drop and upload the ZIP.
4. Share the preview, or claim it into a Cloudflare account if it should persist.

## Choosing the format

| Need | Use |
|---|---|
| Expiring link connected to its source deployment | Live Share |
| Independent, static recipient copy | Portable capsule |
| Optional zero-setup host for the capsule | Cloudflare Drop |
| Reusable source and Mission configuration | Intelligence Pack |
| Private executable evidence workspace | Mission Computer |
| Model-led synthesis or judgment | Reasoning interface |
