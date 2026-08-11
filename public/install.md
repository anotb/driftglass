# Install Driftglass 0.9.0

Use the Cloudflare path for 0.9. The local source-checkout path is an experimental loopback preview. Neither path requires a model API key for reasoning through a compatible ChatGPT, Claude, Grok, or other subscription client.

## Install on Cloudflare

### Requirements

Install Git and Node.js 22 or newer. You also need:

| Requirement | What to do |
|---|---|
| Cloudflare account | Sign in with Wrangler before deploying. |
| R2 activated | Open **Storage & databases → R2** and accept the billing terms. R2 includes a monthly free allowance, but Wrangler cannot accept the account terms for you. |
| Owner secret | Run `openssl rand -hex 32` and use the output for `DRIFTGLASS_SECRET`. |

### Deploy

Clone the repository, activate R2, then run:

```bash
git clone https://github.com/anotb/driftglass.git
cd driftglass
npm install --registry=https://registry.npmjs.org
npx wrangler login
cp .deploy-secrets.example .deploy-secrets
# Replace the placeholder with the output of: openssl rand -hex 32
npm run check:deploy
npm run deploy:first
```

Use `npm run deploy` for later code releases. Use `npx wrangler secret put DRIFTGLASS_SECRET` to rotate the owner secret after the Worker exists.

Wrangler provisions D1, R2, three Queues, a dedicated OAuth KV namespace for that environment, the `MissionComputer` Durable Object, Workflows, the Browser binding, static assets, and Cron. Email Routing, AI Search, OpenAlex, the Companion, Computer Power Mode, and Agent Memory are optional setup after deployment.

If an ingest item still cannot be saved after bounded Queue retries, Driftglass keeps one private recovery copy and pauses new collection. The owner can retry or dismiss the item from the dashboard. See the [deployment guide](https://github.com/anotb/driftglass/blob/main/docs/DEPLOY.md) for the recovery boundary.

For an isolated, non-indexed staging installation with separate resources, copy `.deploy-secrets.example` to `.deploy-secrets.staging`, replace the placeholder, and run `npm run deploy:staging:first`. Staging also disables Cron.

## Run the experimental local preview

The local persistence implementation requires Git and Node.js 24.4 or newer:

```bash
git clone https://github.com/anotb/driftglass.git
cd driftglass
npm install
npm run selfhost:build
node dist/selfhost/driftglass-selfhost.mjs init --data-dir /ABSOLUTE/PATH/driftglass-data
node dist/selfhost/driftglass-selfhost.mjs serve --data-dir /ABSOLUTE/PATH/driftglass-data --port 8787
```

Open `http://127.0.0.1:8787`. Run the long-lived service directly with Node so Ctrl-C can finish shutdown work.

The preview includes the dashboard, direct capture, restart-safe collection, Stories, connected memory, local Mission workspaces, Mission briefs, reminders, local MCP, and checked backup/restore. Browser fallbacks, interrupted Mission Sprint and Routine replay, packaged installation, secure remote access, and broad operating-system/client coverage are unfinished. See [Portable Runtime](https://github.com/anotb/driftglass/blob/main/docs/PORTABLE-RUNTIME.md).

## First useful session

1. Enter the owner secret and run the setup check.
2. Keep the **Free** usage profile.
3. Preview and install one featured Intelligence Pack using its cloud sources.
4. Run collection once, then open **Today**.
5. Choose a Mission and read its current question, recent changes, and next event.
6. Connect a reasoning client and ask for the current answer, what supports it, the strongest alternative case, and what would change it.
7. Save the cited answer if it should carry into the next Mission update.

OpenAlex sources wait for an optional `OPENALEX_API_KEY`; other Pack sources continue. OpenAlex requires a key for every request. Add it only as a Worker secret:

```bash
npx wrangler secret put OPENALEX_API_KEY
```

## Connect an agent or reasoning client

The dashboard's **Reasoning** view provides the connection address for that installation. The default Research connection can read briefings, Missions, Stories, memory, and prepared work. It cannot change state.

The separate **Allow updates** connection can save an answer, decision, Pack change, Computer note, or memory proposal. Its capability key is independent from the Research connection, so copy each full address from the dashboard.

### ChatGPT

For a Cloudflare install, choose **Connect ChatGPT**. Driftglass opens ChatGPT's Plugins page and copies the installation address. Create the connection, paste the address, and approve it in Driftglass.

After setup, Driftglass is available from **Tools** in a new ChatGPT Work chat. For steadier Today and Mission routing, choose **Add @Driftglass** in the dashboard, paste the technical app ID from ChatGPT, and install the downloaded plugin in ChatGPT desktop. The plugin still calls your Driftglass installation directly; it does not add a Driftglass relay.

For a self-hosted install, choose **Open tunnel settings** in the ChatGPT card. Create a Secure MCP Tunnel in an OpenAI Platform account, download `tunnel-client`, and copy the Research setup shown by Driftglass. The tunnel carries MCP traffic outward from the machine; it does not call an OpenAI model. Local clients can connect directly without the tunnel.

### Claude

Use the compact remote MCP, the generated Agent Skill, or the exported Markdown/JSON context. Claude Code can also work in a locally mirrored Mission workspace.

### Other clients and agents

Use the compact MCP where supported. An agent can discover the current tool and path contract from:

- `/llms.txt`
- `/llms-full.txt`
- `/.well-known/mcp.json`
- `/.well-known/driftglass.json`
- `/.well-known/agent.json`
- `/openapi.json`

Portable context bundles are available when the client does not support MCP.

## Optional Companion

Generate a pairing code in Driftglass and run the displayed installer on macOS, Windows, or Linux. The Companion starts local Mission workspace mirroring without OpenCLI or a browser profile.

To add signed-in Reddit, X, YouTube, subscriber, or other browser sources, connect OpenCLI's Browser Bridge to a dedicated profile named `driftglass` and run the probe shown by Driftglass. A source becomes active after its content probe passes. Cloud sources continue while the Companion is offline.

## Optional services

- **OpenAlex:** add an account key through the `OPENALEX_API_KEY` Worker secret.
- **Email Routing:** configure a Cloudflare-managed domain or subdomain and route the selected address to the Worker.
- **AI Search:** enable a rebuildable semantic index from the dashboard or `POST /api/ai-search/setup`; deployment creates no instance by default.
- **Computer Power Mode:** add Worker shell and JavaScript transforms to Mission Computers.
- **Agent Memory bridge:** project approved checkpoints while the service remains private beta.

## Cost posture

Workers Paid is not required. Start with Workers Free and Driftglass's **Free** profile. The optional **Cheap** profile is a larger Driftglass usage envelope intended for a small Workers Paid account; it is not a Cloudflare plan or fixed total price.

Cloudflare meters Workers, D1, R2, Queues, Browser, Workflows, and optional services at the account level. Review the current platform dashboards and billing alerts before raising the Driftglass limits. The [deployment guide](https://github.com/anotb/driftglass/blob/main/docs/DEPLOY.md) and [Budget Governor](https://github.com/anotb/driftglass/blob/main/docs/BUDGET-GOVERNOR.md) contain the current meter boundaries and source links.

## Machine-readable surfaces

- `/openapi.json`
- `/llms.txt`
- `/llms-full.txt`
- `/.well-known/agent.json`
- `/.well-known/driftglass.json`
- `/.well-known/mcp.json`
- `/robots.txt`
- `/sitemap.xml`
