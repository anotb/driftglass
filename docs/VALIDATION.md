# Validation

These checks can be reproduced from a source checkout. They build and inspect local artifacts; none publishes a Worker or changes Cloudflare resources.

## Core source checks

Install the pinned dependencies, then run the repository checks:

```bash
npm ci --no-audit --no-fund
npm run typecheck:offline
npm run lab:typecheck:offline
npm run agent-memory:typecheck:offline
npm test
node scripts/verify-repo.mjs
node --check public/app.js
node --check public/webmcp.js
node --check driftglass-relay/driftglass-relay.mjs
```

`npm test` also checks migrations, generated Relay assets, Lenses, Intelligence Packs, and the compiled Node test suite. The compact MCP contract covers 17 read-only research tools; mutations remain on the separate operations connection.

## Privacy and generated files

```bash
npm run release:privacy
npm run launch:check
git diff --check
```

The privacy command scans reachable Git history for secrets, capability URLs, personal paths, private hostnames, and unsafe tracked files. `launch:check` validates the checked-in screenshots, public Share and Drop files, manifest, and walkthrough media.

## Wrangler types and deployment dry runs

With the pinned dependencies installed:

```bash
npm run types:check
npm run check:deploy
```

`npm run check:deploy` repeats the source checks, checks Worker startup for production and staging, and runs both Wrangler deployment builds with `--dry-run`. It writes local build output under `dist/`; it does not deploy either Worker.

## Recorded 0.9.0 results

Results are snapshots. Rerun the commands after changing the source or generated files.

| Check | Date | Result | Detail |
|---|---|---|---|
| Tests | 2026-08-11 | Passed | `npm test`: 842/842 passed, 0 failed, 0 skipped. |
| Type checks | 2026-08-11 | Passed | Core Worker, Computer Power Mode, and Agent Memory bridge. |
| Privacy | 2026-08-11 | Passed | Reachable-history scan and repository contract verifier passed. |
| Generated artifacts | 2026-08-11 | Passed | `npm run launch:check` verified all nine launch artifacts, including the complete `0.9.0-launch.4` manifest and the 32.000-second H.264/AAC walkthrough. |
| Deployment dry runs | 2026-08-11 | Passed | Production and staging startup checks and Wrangler `--dry-run` builds completed. No live deployment occurred. |
| Clean-account Cloudflare deploy | 2026-08-11 | Pending, not run | Resource provisioning and first-use setup still need a clean-account run. |

The passed dry runs validate builds only. The clean-account deployment remains pending, and no live release or publication is recorded here.

## Optional component checks

Run these when changing the corresponding component:

```bash
# Experimental local runtime
npm run selfhost:build
npm run test:compile
node --test tests/runtime-node-*.test.mjs

# Cross-platform Companion
npm --prefix driftglass-relay run check

# Computer Power Mode with installed dependencies
npm install --prefix labs/deep-dive-lab --registry=https://registry.npmjs.org
npm run lab:typecheck

# Agent Memory bridge with installed dependencies
npm install --prefix labs/agent-memory-bridge --registry=https://registry.npmjs.org
npm run agent-memory:typecheck
```

Connected browser, email, signed-in source, model-client, and Cloudflare account checks need their own configured services and credentials. Keep those results separate from source and dry-run results.
