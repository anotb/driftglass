# Portable Runtime

Driftglass has two runtime profiles. Cloudflare provides the full hosted product. The local runtime is an experimental preview for one machine.

| | Cloudflare | Experimental local preview |
|---|---|---|
| Best for | The full hosted product | Trying Driftglass without a Cloudflare account |
| Canonical state | D1, R2, and one Cloudflare Computer per Mission | SQLite, local evidence files, and local Mission directories |
| Network | A Cloudflare Worker | `127.0.0.1` or `::1` only |
| Requirements | Git, Node.js 22+, Cloudflare account, activated R2 | Git and Node.js 24.4+ |
| Model API key | Not required | Not required |

Choose one canonical store for a library. Driftglass does not keep Cloudflare and local state in sync.

## Cloudflare

The Cloudflare/core package uses a Node.js 22 baseline. Activate R2 in the target Cloudflare account, then run:

```bash
git clone https://github.com/anotb/driftglass.git
cd driftglass
npm install --registry=https://registry.npmjs.org
npx wrangler login
cp .deploy-secrets.example .deploy-secrets
# Replace replace-me with the output of: openssl rand -hex 32
npm run check:deploy
npm run deploy:first
```

This creates the Worker resources, applies D1 migrations, and configures expiry for disposable `raw/` captures. See [Deploy Driftglass](DEPLOY.md) for Cloudflare deployment details, costs, staging, upgrades, and optional services.

## Experimental local preview

The local persistence implementation requires Node.js 24.4 or newer:

```bash
git clone https://github.com/anotb/driftglass.git
cd driftglass
npm install --registry=https://registry.npmjs.org
npm run selfhost:build
node dist/selfhost/driftglass-selfhost.mjs init --data-dir "$PWD/.local-driftglass"
node dist/selfhost/driftglass-selfhost.mjs serve --data-dir "$PWD/.local-driftglass"
```

Open `http://127.0.0.1:8787`. The `init` command prints the path to the owner-secret file. Read that file locally when the dashboard asks for the secret.

Run the long-lived `serve` command directly so Ctrl-C can close the database and background work cleanly. Stop it before rebuilding `dist/selfhost`.

### Connect a local client

Keep the service running. In another terminal, ask Driftglass to verify the connection and print client settings:

```bash
node dist/selfhost/driftglass-selfhost.mjs doctor \
  --data-dir "$PWD/.local-driftglass" \
  --origin http://127.0.0.1:8787
```

`doctor` prints two stdio MCP configurations:

- `read` exposes the compact 17-tool research interface.
- `approval` can save and review answers against fixed evidence snapshots.

Use the printed `command` and `args` in Codex, Claude Desktop, or another client that can start a local stdio process. The read connection is equivalent to:

```bash
node dist/selfhost/driftglass-selfhost.mjs connect \
  --data-dir "$PWD/.local-driftglass" \
  --origin http://127.0.0.1:8787 \
  --access read
```

Change `read` to `approval` only for a client that should save results. Browser-based model clients cannot start a local stdio process; use a separately configured authenticated tunnel if one needs remote access. Do not expose the loopback HTTP service directly.

### Back up and restore

Stop the service before creating a backup:

```bash
node dist/selfhost/driftglass-selfhost.mjs backup create \
  --data-dir "$PWD/.local-driftglass" \
  --destination "$PWD/driftglass-backup"

node dist/selfhost/driftglass-selfhost.mjs backup verify \
  --source "$PWD/driftglass-backup"
```

Restore into a new or empty directory:

```bash
node dist/selfhost/driftglass-selfhost.mjs restore \
  --source "$PWD/driftglass-backup" \
  --data-dir "$PWD/.restored-driftglass"
```

The backup contains the SQLite snapshot, evidence objects, Mission files, and checksums. It excludes the owner secret. Restore verifies the archive and creates a new owner secret and local authority record.

## What works locally

- dashboard, authenticated API, and direct public-URL or manual capture
- restart-safe collection, automatic source checks, Stories, Missions, and Today
- scheduled Mission reminders and a Mission-aware daily brief
- local Mission workspaces with persistent `notes/`, `results/`, and `exports/`
- deterministic connected-memory refresh and recall over SQLite
- compact read MCP and the separately authorized answer-review connection
- checksummed backup, verification, and clean-target restore

## Current limits

- Pages that require the Kitesurf or Chromium fallback cannot be collected locally yet.
- Mission Sprints and Intelligence Routines do not resume an interrupted step locally.
- Local Mission workspaces do not include execution-backed Power Mode.
- Public sharing and access from another device require separately configured secure ingress.
- Cloudflare-to-local and local-to-Cloudflare library migration is not available.
- Native installers, containers, service-manager packages, and broad operating-system and client coverage are unfinished.

## Data and security

The local service accepts only numeric loopback addresses. Its owner secret stays in the permission-restricted `runtime/owner-secret` file and is not placed in client command arguments or environment variables.

Use an explicit absolute data-directory path. Driftglass rejects a filesystem root and will adopt only a new directory, an empty directory, or a directory with its matching managed marker. Do not point it at an unrelated folder. The directory contains private evidence, memory, and Mission files, so protect it like the source material it holds.

Moving between Cloudflare and local changes the authority that may accept writes. Copying SQLite or object files by hand is not a migration. Until an export, import, checksum, and authority-change flow ships, start a separate library instead of trying to merge the two stores.
