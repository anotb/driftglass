# Deploy Driftglass

## Deploy from a source checkout

No Workers Paid subscription is required. Start with the Workers Free plan and Driftglass's **Free** Budget Governor profile. R2 activation is the one account-level prerequisite with a billing acknowledgement.

Install Git and Node.js 22 or newer, then deploy from a source checkout with the commands below.

### Requirements

| Before deploying | Why |
|---|---|
| A Cloudflare account | Wrangler creates the Worker and its declared resources in this account. |
| R2 activated under **Storage & databases → R2** | R2 requires a one-time subscription and billing acknowledgement even when usage stays within its monthly free allowance. Wrangler cannot accept the account terms for you. |
| Git and Node.js 22 or newer | The deploy command runs from a source checkout. |
| A fresh owner secret | Use the output of `openssl rand -hex 32` for `DRIFTGLASS_SECRET`. The checked-in placeholder is rejected. |

Use Driftglass's `npm run deploy:first` and `npm run deploy` commands. Bare `wrangler deploy` skips the D1 migration and R2 lifecycle steps.

### Deploy from the checkout

```bash
git clone https://github.com/anotb/driftglass.git
cd driftglass
npm install --registry=https://registry.npmjs.org
npx wrangler login
cp .deploy-secrets.example .deploy-secrets
# Replace the placeholder with: openssl rand -hex 32
npm run check:deploy
npm run deploy:first
```

Replace `DRIFTGLASS_SECRET=replace-me` before deployment.

The first deploy uses `.deploy-secrets` because `wrangler secret put` needs an existing Worker. Keep the file private; Git ignores it. Use `npm run deploy` for later code releases and `npx wrangler secret put DRIFTGLASS_SECRET` only to rotate the secret after the Worker exists.

### What the deploy command configures

The declared resources have no account-specific IDs. Named resources use deterministic names, and each environment declares its own unpinned OAuth KV binding. Cloudflare and Wrangler can therefore provision and reconnect the core resources on a clean account:

- Worker, static assets, and Cron Trigger; aggregate platform analytics remain available without retained request logs or traces
- D1 canonical state and Memory Graph
- dedicated OAuth grant and token KV namespace for each environment
- R2 evidence and artifacts
- primary ingest Queue, dead-letter Queue (DLQ), and quarantine Queue
- direct public-page reading; Browser Rendering is an optional post-install binding
- Mission Sprint, Memory Graph, and Intelligence Routine Workflows
- `MissionComputer` Durable Object and migration
- AI Search namespace binding only; no AI Search instance is enabled

The command deploys the cloud core. The Companion, Computer Power Mode, and Agent Memory bridge are separate optional installations.

The deployment command runs in this order:

```text
build → Worker/resource deployment → D1 migrations through binding DB
      → raw/ R2 lifecycle check/install
```

The lifecycle expires disposable `raw/` captures after 30 days. Receipts, results, checkpoints, briefings, and previews remain until removed. Migrations and lifecycle setup are idempotent. If a late step fails after resources were created, fix the reported cause and rerun the same command. An existing conflicting R2 lifecycle rule must be resolved before setup can finish.

OpenAlex is not a deployment prerequisite. OpenAlex currently requires an API key for every request, including zero-cost direct Work-ID lookups. Its free account key does not require a paid API commitment, but creating one does require signing in to or creating an OpenAlex account. After the Worker exists, add it through the runtime secret boundary:

```bash
npx wrangler secret put OPENALEX_API_KEY
# For an isolated staging environment:
npx wrangler secret put OPENALEX_API_KEY --env staging
```

Do not add the key to source JSON, a profile, Lens, Intelligence Pack, overlay, `.deploy-secrets.example`, or D1. Driftglass accepts only the binding, sends it directly to OpenAlex, allowlists returned metadata, and never includes it in source-run details or errors. Without the secret, OpenAlex sources remain visibly deferred and do not consume source-run budget or block other cloud sources. See [OpenAlex authentication](https://developers.openalex.org/guides/authentication) and the [single Work endpoint](https://developers.openalex.org/api-reference/works/get-a-single-work).

Run `npm run types` after dependency installation and configuration changes.

## Free and Cheap profiles

**Cheap is a Driftglass application profile, not a Cloudflare plan.** It is intended for an optional Workers Paid account, whose current minimum subscription is $5 per account per month; usage beyond included allocations may add charges. Paid is useful for more CPU, Queue retention, and monthly capacity, but it is not required for installation or cloud-only usefulness.

Choosing Cheap changes the daily envelope; higher per-invocation Worker limits stay Free-safe until the owner confirms Workers Paid in **Usage plan**.

| Meter | Free-first guardrail | Cost boundary to remember |
|---|---|---|
| Workers | Use the Free profile first. | Worker limits and Paid billing are account-wide. |
| R2 | Free and Cheap both stay below the same monthly R2 operation allowance under a 31-day projection. | Activation is mandatory; storage and operations beyond the R2 allowance are billable. Durable artifacts can accumulate. |
| Queues | Free reserves at most 2,500 application messages/day. A normally delivered message is roughly a write, read, and delete. | Free includes 10,000 operations/day. Retries and transfers to the DLQ or quarantine add operations; other Queues share the account allowance. |
| Browser | The default source-checkout deployment omits Browser Rendering and uses direct HTTP. Add the binding after installation to use the Free profile's 8-minute daily guardrail. | Cloudflare currently includes 10 minutes/day on Workers Free. Confirm Workers Paid before selecting Driftglass's larger Cheap profile. |
| Workflows | Free reserves 2,400 of 3,000 included steps/day. | Workflow steps and storage have their own plan meter. |
| OpenAlex | Optional free key currently includes a $1/day API allowance; shipped Pack searches run at most twice per day per source, and direct singleton lookups are zero-cost. | OpenAlex usage is an external meter. Driftglass stops on 429 and surfaces retry guidance, but the owner should inspect OpenAlex usage before increasing cadence or result limits. |
| Email Routing | Not required; Cloudflare currently offers it on Free and Paid plans. | Domain registration and the manual DNS/mail route are separate from the Worker install. |
| AI Search | Disabled until the owner opts in. | Its beta query allowance and any related Workers AI or AI Gateway charges are separate meters. |

The Budget Governor meters Driftglass-issued work, not other applications on the account. Cloudflare usage dashboards, billing alerts, and invoices remain authoritative. See [Budget Governor](BUDGET-GOVERNOR.md) for exact envelopes and current platform-source links.

## Queue failure boundary

Ingest follows a finite chain:

```text
primary Queue (up to 3 configured retries)
  → DLQ consumer (up to 3 configured retries while recording the failure)
  → bounded quarantine recovery consumer (20 hourly retries, no further DLQ)
```

The quarantine consumer first stores the failed item in the owner-private D1 dead-letter table. If D1 is unavailable, it stores one private recovery body of at most 60 KB in R2. If neither store is available, delivery retries hourly up to 20 times within Free's 24-hour Queue retention.

New collection pauses while the primary Queue has stale backlog or either recovery store contains an unresolved incident. The owner can retry or dismiss one selected incident after the primary Queue is current and the DLQ and quarantine transports are empty. An R2 recovery body is checked, recorded through the normal D1 failure path, and deleted after D1 records the resolution.

## Optional setup after deployment

- **OpenAlex:** optional. Add a free account key only through the `OPENALEX_API_KEY` Worker secret. Every OpenAlex request is authenticated; direct Work-ID lookups are zero-cost but still require the key. Packs preview how many sources run immediately and how many wait for this credential, while budget projections retain the eventual OpenAlex cost.
- **Email Routing:** optional. Add Email Routing to a Cloudflare-managed domain or dedicated subdomain, then choose **Send to a Worker** for the Driftglass address. Destination verification is required only when forwarding to another address, not for the Worker action. A dedicated subdomain preserves existing apex MX records. Driftglass rejects raw messages above 2,000,000 bytes and retains bounded attachment descriptors as private evidence, not attachment bytes.
- **AI Search:** optional. The owner must explicitly create/enable the instance from the dashboard or `POST /api/ai-search/setup`; deployment only declares its namespace binding.
- **Browser Rendering:** optional. Direct public-page reading works without it. After the initial install, add `"browser": { "binding": "BROWSER", "remote": true }` to the top level of `wrangler.jsonc` and redeploy. The Free profile stays within Cloudflare's current 10-minute daily Free allowance; confirm Workers Paid only before selecting Driftglass's larger Cheap profile.
- **Companion:** optional. Pair the macOS, Windows, or Linux service for signed-in sources and local Mission Computer mirroring; it uses the owner's machine and is not bundled into a Workers plan.
- **Computer Power Mode and Agent Memory:** optional, independently deployed extensions.

Retained Workers invocation logs and automatic traces are disabled in production and staging because private packet and MCP capabilities live in URL paths. Operational metrics come from aggregate Workers Analytics, service-specific D1, Queue, R2, and Workflow metrics, optional Browser metrics, the Budget Governor ledger, and content-free readiness state. If an operator attaches a real-time tail while debugging, they should avoid capability-bearing routes or rotate `DRIFTGLASS_SECRET` before using those URLs again.

## First run

Keep the default **Free** Budget Governor profile. Install a cloud-first Intelligence Pack, collect once, open Today, and connect the read-only Research MCP. Add the Companion, AI Search, Email Routing, Agent Memory, or Computer Power Mode when a Mission needs the corresponding source or capability.

## Local development

```bash
cp .dev.vars.local.example .dev.vars
npm install --registry=https://registry.npmjs.org
npm run db:migrate:local
npm run dev
```

`npm run dev` loads the optional GitHub, OpenAlex, and Power Mode values from `.dev.vars`. Its temporary config adds empty placeholders for those optional names; their values stay in `.dev.vars`. The file is deleted on normal exit, Ctrl-C, or termination. The deployment config still requires only `DRIFTGLASS_SECRET`; set optional production values with `wrangler secret put`.

Use remote development for Workflows, Mission Computer, and optional service behavior that the local simulator cannot fully reproduce. Kitesurf and Chromium also require remote development after the optional Browser Rendering binding is added.

## Companion

Pair from the dashboard to start Mission workspace mirroring; this baseline does not require OpenCLI or Browser Bridge. Add Reddit and X afterward by connecting Browser Bridge to a dedicated profile named `driftglass`, then check the public and personalized lanes you want. Doctor reports executable, content, cloud, and full source-service readiness independently. The Companion can run as a LaunchAgent, user systemd service, or Task Scheduler job and can target either a Cloudflare or self-hosted Driftglass URL. Self-host uses the same collector routes, source scheduler, normalized ingestion, and downstream intelligence path. Successful collections remain in a bounded private local outbox until acknowledged, so an ambiguous submission or restart replays the exact result before another job is polled.

## Optional AI Search

Initialize AI Search only after validating the canonical D1 Memory Graph. Deployment creates only the namespace binding. The dashboard's **Enable AI Search** action (or `POST /api/ai-search/setup`) is the sole instance creation and enablement path; automatic hooks and semantic reads cannot turn it on. It is a rebuildable retrieval projection and can remain disabled.

## Optional Agent Memory bridge

```bash
cd labs/agent-memory-bridge
npm install --registry=https://registry.npmjs.org
npx wrangler secret put BRIDGE_SECRET
npm run deploy
```

Use it only for approved-memory checkpoints while Agent Memory remains private beta.

## Computer Power Mode

```bash
cd labs/deep-dive-lab
npm install --registry=https://registry.npmjs.org
npx wrangler secret put DEEP_DIVE_LAB_SECRET
npm run deploy
```

Set the resulting URL and matching token on the core. The default Mission Computer filesystem works without Power Mode.

## Upgrade

```bash
npm install --registry=https://registry.npmjs.org
npx wrangler types
npx wrangler types ./src/worker-configuration.d.ts --check
npm run check:startup
npm run check:startup:staging
npm run check
npm run deploy
```

D1 migrations are additive and applied once by version. Durable Object migrations remain in `wrangler.jsonc`. Preview Intelligence Pack updates before applying them.

## Cloudflare references

- [Wrangler automatic resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [R2 activation](https://developers.cloudflare.com/r2/get-started/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), and [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Browser Rendering pricing](https://developers.cloudflare.com/browser-run/pricing/) and [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Email Routing plan availability](https://developers.cloudflare.com/email-service/), [setup](https://developers.cloudflare.com/email-service/get-started/route-emails/), [domain DNS](https://developers.cloudflare.com/email-service/configuration/domains/), and [subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)
- [AI Search limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
