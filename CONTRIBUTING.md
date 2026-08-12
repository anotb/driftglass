# Contributing

Driftglass is built to be useful on day one and extensible without forcing every contributor to maintain a crawler stack.

## Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Before a pull request:

```bash
npm run check
npm run relay:check
npm run lab:typecheck:offline
```

## High-value contribution areas

- new public source adapters and starter Lenses
- Companion normalizers for current OpenCLI read adapters
- story clustering, material-change detection, and source independence
- Mission operators and prediction resolution
- source-health diagnostics and content-bearing probes
- Kitesurf extraction profiles and browse telemetry
- ChatGPT App widgets, MCP tools, and evidence UX
- Computer Power Mode workspace tools and deterministic case transforms
- source-checkout deployment, onboarding, accessibility, and documentation

## Adapter contract

A source adapter should emit normalized evidence, expose its coverage and retrieval path, bound its work, and return a meaningful health result. Authenticated adapters run through the Companion and should derive their command surface from upstream `access: "read"` metadata. See [`docs/ADAPTERS.md`](docs/ADAPTERS.md).

## Upstream collaboration

OpenCLI, Agent-Reach, and other access-layer projects move quickly. Fix generic parser and browser-adapter problems upstream when practical, then keep the Driftglass integration focused on scheduling, normalization, health, and story memory. Add every integrated project to [`ACKNOWLEDGEMENTS.md`](ACKNOWLEDGEMENTS.md) with its role and license boundary.

## Product standard

A feature is complete when it has a user-facing path, a machine-readable contract where relevant, migration or schema coverage, tests, and documentation that matches the running behavior.
