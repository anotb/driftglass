# Budget Governor

Driftglass is designed to remain useful on Cloudflare Free and predictable on an inexpensive Workers Paid account.

## Free application envelope

The default envelope deliberately reserves platform headroom:

| Dimension | Driftglass envelope |
|---|---:|
| Rendered browsing | 8 minutes/day |
| Workflow steps | 2,400/day |
| AI Search operations | 15,000/month |
| Memory writes | 5,000/day |
| Source runs | 240/day |
| Queue messages | 2,500/day |
| Mission Computer synchronization | 20 MiB/day |
| R2 Class A operations | 10,000/day |
| R2 Class B operations | 50,000/day |
| R2 submitted write bytes | 100 MiB/day |

These are application ceilings, not promises that every Cloudflare plan has identical allowances forever.

## Cheap profile

The Cheap profile raises application ceilings for a small Workers Paid deployment while retaining explicit limits. It is not an unlimited mode and does not assume startup credits will remain available.

Daily planning and execution capacity are separate. Selecting Cheap or a larger custom plan preserves that planned profile, but its Worker-backed effective limits stay at the lower of the selected values and the Free envelope until the owner confirms Workers Paid in **Usage plan**. This applies to rendered browsing, Workflow steps, AI Search operations, Memory writes, source runs, Queue messages, and Mission Computer bytes, including both daily and monthly lanes. The Budget API reports `plannedLimits` and `effectiveLimits` separately; the existing `limits` field remains an alias of the effective limits used for enforcement. Missing or invalid capacity is always Free-safe. Confirmation also unlocks the larger D1 invocation envelope, multi-source fanout, and faster browser admission, and stays local to this installation.

Rendered browsing is capped at 15 minutes/day. That is 7.5 hours in a 30-day month or 7.75 hours in a 31-day month, retaining at least 22.5% headroom beneath the current 10-hour/month Browser Run inclusion on Workers Paid. Usage above Cloudflare's included amount is billable, so the application ceiling is intentionally below the platform allowance rather than an overage target.

The AI Search operation lane is only an envelope. Driftglass does not create, enable, query, or synchronize an AI Search instance until the owner explicitly runs setup. A semantic query reserves two monthly units before its namespace lookup and search. A sync page reserves one namespace lookup, up to 52 binding operations for each changed document, and up to 51 for each deletion. The per-key bounds cover one 50-result item lookup, every possible exact-key delete in that result, and an upload when required. A 12-document replacement page therefore reserves at most 625 units. Failed or ambiguous calls keep their reservation.

The Cheap R2 lanes are 20,000 Class A operations/day, 200,000 Class B operations/day, and 200 MiB of submitted write-body bytes/day. These application days reset at 00:00 UTC. R2's included allowance is independent of the Workers Free or Paid plan, so explicit Cheap or custom R2 limits remain effective while Worker execution is Free-safe. Cheap does not assume a larger R2 inclusion.

## R2 envelope and retention

As of August 2026, R2 Standard storage includes 10 GB-month, one million Class A operations, and ten million Class B operations per account per month. The daily Cheap ceilings project to at most 620,000 Class A operations, 6.2 million Class B operations, and 6.05 GiB of submitted write bodies in a 31-day month. Those projections retain 38% operation headroom. If the writes were unique disposable `raw/` captures, their 30-day lifecycle would keep that prefix near the same bounded input rate and below the storage inclusion; overwrites and retained artifacts make lifetime inventory a separate concern. The Free ceilings are lower still.

Every core `EVIDENCE` put and get crosses one reservation boundary. Puts reserve their exact buffered UTF-8 or binary byte length and one Class A operation before R2 is called. Gets reserve one Class B operation before R2 is called, including misses. Unknown-length streams are rejected until the caller supplies a bounded body. A failed request keeps its reservation conservatively because the platform may still account for the attempted operation. Deletes remain unmetered because Cloudflare currently classifies object deletion as a free operation.

One narrowly bounded exception preserves exhausted Queue evidence when D1 itself is unavailable and therefore cannot record a budget reservation. The active quarantine consumer may issue one conditional, deterministic R2 put under `recovery/ingest-quarantine/`, with an owner-private JSON body capped at 60,000 bytes. It attempts the normal D1 dead-letter store first, never writes outside that prefix, and acknowledges only after D1 or R2 succeeds. Re-delivery targets the same key; if both stores fail it retries hourly, at most 20 times within Free's 24-hour Queue retention. Once D1 returns, all listing and reading of fallback objects uses the normal metered Class A/Class B boundaries. Each normal enqueue preflight and each Readiness Doctor evaluation reserves one Class A list operation so a fallback object remains a hard collection/release blocker; owner list views reserve another Class A operation, while opening a selected incident for retry/dismiss reserves one Class B read. A selected owner retry does not list or require removal of other durable D1/R2 incidents, so incidents can be repaired one at a time; it still requires observable, non-stale primary transport and empty DLQ/quarantine transports. Retry or dismissal first integrity-checks and materializes the exact private body through the normal D1 path, including tracked-run and Email Queue-failure reconciliation. The standard atomic action clears the D1 body, and only then is the private R2 body deleted; the content-free D1 audit retains its original hash, size metadata, and R2 provenance. This emergency write can appear in Cloudflare's account-wide R2 usage without a matching D1 budget-ledger entry, so the R2 dashboard remains authoritative.

The byte lane measures bytes submitted by application-issued puts; it is not a live R2 inventory quota. Overwriting an object consumes the submitted-byte lane again even when net stored bytes do not grow. The deploy workflow configures a 30-day lifecycle only for disposable `raw/` captures, and Cloudflare says expired objects are typically removed within 24 hours. Exact reasoning receipts, results, memory checkpoints, briefings, and public previews are durable and can accumulate until the owner removes them. Check the R2 usage dashboard and configure a billing alert; platform analytics and invoices remain the storage and billing source of truth.

R2 allowances are account-wide. Other Workers, buckets, dashboard operations, lifecycle configuration, and external S3 clients consume the same account allowance without appearing in Driftglass's D1 ledger. The Class B boundary itself performs one atomic D1 usage write per object read. Free therefore stops at 50,000 R2 reads/day, preserving roughly half of [D1's current Free daily write allowance](https://developers.cloudflare.com/d1/platform/pricing/) for actual product state. Public social-preview requests can consume this lane; once it is exhausted, the share route serves the bundled public fallback image without reading R2 or exposing private evidence.

Current limits and classifications: [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## Enforcement

Reservations occur in actual execution paths for:

- cloud and Companion source collection
- Queue ingestion
- R2 evidence and artifact puts/gets
- Kitesurf and Chromium rendering
- Mission, Memory, and Routine Workflows
- AI Search
- approved memory patches
- Mission Computer synchronization
- Intelligence Pack installation

When capacity is unavailable, non-critical work is deferred, compacted, or slowed rather than silently creating overage.

Mission Computer reservations cover every submitted write body. Managed synchronization computes the changed files first and includes its generated Mission README, seed READMEs, latest-sync state, and manifest before making one atomic byte reservation. A denied full sync may retry one compact candidate; a failed reservation records no usage, so the compact candidate is not charged twice. Companion imports reserve their unique file bodies plus `last-local-push.json`, and note appends reserve the complete rewritten note. No directory or file mutation begins after a denial. Failed or ambiguous writes retain their reservation conservatively.

Every Kitesurf session atomically reserves 90 seconds of Browser capacity before it starts. That conservative maximum covers Driftglass's 28-second operation deadline plus Cloudflare's documented 60-second inactivity window when an explicit browser close cannot be confirmed. A normal `Browser.close` acknowledgement or clean transport close lets Driftglass settle the reservation to measured session wall time; a timeout, failed connection cleanup, or otherwise ambiguous close retains all 90 seconds and suppresses an overlapping fallback.

Each Chromium Quick Action reserves 30 seconds. Chromium also declares a 16-second navigation timeout and an 8-second post-load action timeout. A render that requests links reserves both 30-second calls before the first call starts and treats a failed or malformed links response as failed coverage. The full adaptive Kitesurf-to-Chromium ladder can therefore require up to 120 seconds of application capacity without links or 150 seconds with links, although an ambiguously open Kitesurf session stops the ladder before Chromium starts.

Browser starts are coordinated across Worker invocations through two atomic D1 schedules rather than isolate-local timers. Free-safe execution admits Kitesurf sessions 30 seconds apart and Quick Actions 10 seconds apart. Confirmed expanded capacity admits sessions nine seconds apart, bounding Driftglass to the ten concurrent sessions included in the Paid Browser envelope even if each unconfirmed session occupies its full 88-second risk window, and admits Quick Actions 100 milliseconds apart. A caller waits at most 30 seconds for its claimed slot; corrupt or implausibly future scheduler state fails closed with a typed `429` response. A canceled caller may waste a slot but cannot cause another caller to start early.

After a completed call, the ledger atomically releases the unused reservation and retains only measured browser time: confirmed Kitesurf session wall time, or the sum of finite `X-Browser-Ms-Used` values from Chromium responses (bounded wall time is the fallback when a header is absent). This settlement replaces the old post-call spend, so a call is not charged twice. Raw finite vendor telemetry remains in render-attempt records even if it exceeds the declared reservation; the budget charge stays at the reserved maximum and marks the measurement uncertain. The current Quick Action binding does not expose an abort signal, so the 28-second deadline covers both response acquisition and bounded body consumption, retains the full reservation on ambiguity, and never starts an adaptive fallback that could overlap platform work. These D1 schedules coordinate this Driftglass deployment only; Cloudflare's account dashboard remains authoritative for other Workers, platform concurrency, billing, and usage outside Driftglass. See Cloudflare's current [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/) and [pricing](https://developers.cloudflare.com/browser-run/pricing/).

## Adaptive cadence

Adaptive cadence changes how the source-run allowance is allocated.

- high-signal sources may accelerate within configured minimums,
- repeated empty runs back off,
- failures and poor health back off more aggressively,
- stable sources converge toward their configured baseline,
- deterministic daily jitter prevents unnecessary synchronized bursts.

The cadence engine never bypasses `requireBudget`. It can improve freshness and reduce waste, but cannot turn the Free profile into an unbounded crawler.

## D1 invocation safety

Free D1 constraints apply per invocation as well as over time. Driftglass uses safeguards including:

1. Built-in public source runs stage exact Queue bodies through set-based JSON inserts, with at most 6 staging statements, 20 raw-bearing items, 800 messages, and 4 MB of message bodies per run. The active producer working set is capped at 10,000 messages and 32 MB.
2. Pack install preview estimates the complete D1 invocation before writes. The
   current formula is 19 fixed statements, plus 2 per source, 6 per Mission, 1
   per view, 2 per byte-bounded memory-seed batch, and 1 per relation, research
   playbook, skill, or Routine. Each seed batch keeps its JSON value below 1 MB;
   one set-based node upsert returns the persisted canonical IDs and one
   set-based `contains`-edge upsert preserves them on retries. Free and custom
   use a 46-statement safety envelope; an explicit local confirmation enables
   the 900-statement envelope. Regression fixtures measure the three shipped cloud cores at 42–44
   statements, a two-batch 130-seed install at 23, and a six-Mission install at
   55; the last is rejected before the first write under Free-safe execution.
3. Memory refresh runs through small native Workflow phases.
4. Intelligence Routines use bounded step counts.
5. Pack overlay application and fork export remain bounded.
6. Graph projection degrades from full to compact before it is deferred.

The producer-outbox limits are chosen against Free's 50-query invocation ceiling. The five-minute Cron trigger executes exactly one deterministic lane per invocation: two source slots remain 30 minutes apart and each maintenance lane receives an hourly slot without being starved by perpetually due sources. A failed scheduled Mission or Routine candidate is deferred for one hour so the oldest poisoned candidate cannot monopolize its lane. Deep Research rotates every evaluated candidate, including a non-escalation or compiler failure. An old Memory run is reconciled against the authoritative Workflow instance: queued, running, paused, waiting, and waiting-for-pause instances retain exclusive graph ownership; unknown, malformed, or future statuses also fail closed. Only a positively terminal or confidently missing instance may be replaced, and an atomic D1 election ensures one replacement owner. AI Search advances past failed documents, gives each failure two fair retry attempts per generation, and closes a partial generation instead of pinning later pages. Free-safe execution runs at most one due tracked source in a source lane; confirmed expanded capacity may run at most 12 with concurrency capped at three. Starter Pack installation leaves all new sources due until expanded capacity is confirmed instead of combining Pack writes and collection in one invocation. The 800-message per-run cap matches the largest current built-in npm/PyPI adapter output and uses set-based staging rather than one statement per message. Those package adapters keep at most four registry response bodies active and cap untrusted per-item description text at 4,000 UTF-8 bytes, recording original and retained byte counts when truncation occurs. If rich output still exceeds the 4 MB body or six-statement staging envelope, Driftglass takes the largest contiguous prefix that fits and records the exact deferred count as partial collection coverage; it does not reject or silently truncate the whole collection. A producer entry drains at most one prior Queue batch before collection; if it claims prior work, it returns that canonical resumed run instead of creating or budgeting a duplicate collection. Up to 20 Page Feed-shaped raw captures share two aggregate D1 reservations—exact submitted bytes and Class A count—before bounded R2 puts begin. The owner drain is capped at six Queue batches, while scheduled and producer-entry drains use one.

The production trigger itself contributes exactly 288 scheduled Worker invocations in a 24-hour day before manual traffic, Queue consumers, Workflows, or Companion polling. Staging intentionally has no Cron. Connected Free/Cheap calibration must include those trigger invocations and each lane's measured D1 statements rather than treating the application budget alone as platform billing truth.

Each outbox message normally causes approximately two D1 row writes over its full lifecycle: one immutable insert and one later cascade delete. A confirmed Queue handoff advances only the run header cursor; exact bodies remain capacity-counted and recoverable until the source-run receipt ledger is terminally accounted. Maintenance then deletes at most one terminal run per invocation, bounding the cascade to 800 messages and 4 MB. Header inserts and handoff checkpoints add bounded per-run writes. This is an application-level estimate for envelope planning, not a Cloudflare billing promise; D1 analytics and account billing remain authoritative.

## Intelligence Pack preview

Pack preview shows:

- current configured load
- cloud core
- optional Companion-enhanced plan
- expected item yield
- Queue work
- browser fallback share
- Mission and Routine Workflow steps
- initial memory writes
- install-query safety
- selected profile fit
- cloud independence

A useful cloud core may be installed even when every optional signed-in lane would exceed the selected profile.

## Why application budgets

Cloudflare products account for work in different units and plan allowances may evolve. A unified application envelope keeps optional services from independently consuming the budget and provides one understandable product control surface.
