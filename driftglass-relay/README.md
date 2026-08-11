# Driftglass Companion

Driftglass Companion unlocks personalized signed-in sources on macOS, Windows, and Linux while the always-on intelligence core remains on Cloudflare.

## How it works

- polls the Worker outward
- stores the collector credential in the operating-system credential store
- uses a dedicated OpenCLI browser profile
- discovers the installed OpenCLI read manifest
- executes fixed semantic capabilities or manifest entries marked `access=read`
- validates content-bearing output
- uploads normalized evidence and provider diagnostics
- keeps one exact successful result in a private crash-safe outbox until the Worker acknowledges it
- mirrors each Mission Computer to an ordinary local folder every 15 minutes
- pushes user-owned `notes/`, `results/`, and `exports/` back to the cloud workspace

## Install

macOS or Linux:

```bash
curl -fsSL https://YOUR-DRIFTGLASS/relay/install.sh \
  | sh -s -- https://YOUR-DRIFTGLASS
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://YOUR-DRIFTGLASS/relay/install.ps1))) https://YOUR-DRIFTGLASS
```

Generate a pairing code in the dashboard, then:

```bash
driftglass-companion pair \
  --url https://YOUR-DRIFTGLASS \
  --code PAIRING_CODE \
  --start
```

This pairs the Companion and starts Mission workspace mirroring. It does not require OpenCLI, Browser Bridge, or a signed-in browser.

## Add Reddit and X

This step is optional. Install OpenCLIApp or OpenCLI, connect the Browser Bridge extension to a dedicated browser profile, then check the public Reddit lane:

```bash
opencli doctor
opencli profile list
opencli profile rename <contextId> driftglass
opencli profile use driftglass
driftglass-companion probe --operation reddit.frontpage --limit 3 --profile driftglass
```

`opencli doctor` must report the extension connected and browser connectivity passing. `profile list` supplies the local context ID used once by `profile rename`. Probes return only the provider, item count, and timing; they do not print the feed.

Check personalized lanes separately on machines where you have already signed in:

```bash
driftglass-companion doctor --profile driftglass --probe-operation reddit.home --limit 3
driftglass-companion doctor --profile driftglass --probe-operation x.timeline --type following --limit 3
driftglass-companion doctor --profile driftglass --probe-operation x.timeline --type for-you --limit 3
```

Each personalized lane uses the session in this local profile. Pairing and workspace mirroring continue without it. Doctor reports executable, content, cloud, and full source-service readiness independently.

## Commands

```bash
driftglass-companion doctor --profile driftglass --probe-operation reddit.frontpage --limit 3
driftglass-companion catalog --profile driftglass
driftglass-companion plan --operation x.timeline --type for-you --limit 5 --profile driftglass
driftglass-companion probe --operation reddit.home --limit 5 --profile driftglass
driftglass-companion service-install
driftglass-companion service-start
driftglass-companion service-stop
driftglass-companion service-restart
driftglass-companion service-status
driftglass-companion workspace-sync
driftglass-companion workspace-search --id mission-id --query "contradiction"
driftglass-companion workspace-note --id mission-id --content "Follow up with the primary filing"
driftglass-companion workspace-push --id mission-id
driftglass-companion workspace-export --id mission-id --out mission-workspace.json
driftglass-companion workspace-import --file mission-workspace.json
driftglass-companion update --file ./driftglass-relay.mjs --sha256 TRUSTED_SHA256
driftglass-companion unpair
```

`catalog` shows the live OpenCLI read surface. `plan` shows the exact candidate provider arguments before execution. `probe` performs a bounded content-bearing check without dumping the collected feed.

`doctor` reports three independent checks: `localExecutableReady`, a requested content-bearing `contentProbe`, and an authenticated read-only `cloud` check against the paired Worker. `probeReady` is never inferred from an executable or process exit, and `serviceReady` becomes true only when all three checks pass. Without `--probe-operation`, Doctor runs in `local-only` or `paired-connectivity` mode and deliberately does not claim content or service readiness. Use `--skip-cloud` only for an explicit offline diagnostic; it produces `paired-local` mode and cannot establish service readiness.

The background loop keeps transient heartbeat and job-poll failures inside the process. Failures share the same bounded 15–120 second retry backoff as idle polling. Heartbeat attempt times are recorded before network I/O, so a failed detailed catalog heartbeat is not retried rapidly; the next detailed attempt remains on the six-hour cadence.

Every Companion request has a total deadline that remains active while its response body is read. JSON responses, workspace downloads, local workspace files, searches, imports, exports, and pushes all have explicit file-count and byte limits. An oversized or stalled server response is cancelled before it can consume unbounded memory or disk.

Before a successful collection is submitted, the Companion atomically stores its exact bounded JSON request in a mode-`0600` file under the per-user state directory. A network failure, HTTP `409`, or server error leaves that record intact. The same bytes replay after a restart and before any new job poll; collection is not executed again, and a failed success submission is never converted into an `ok:false` result. Doctor reports only whether this outbox is empty, pending, or invalid plus its byte count and age—it never prints evidence contents. `unpair` first obtains acknowledgement for a pending result and aborts without removing the credential if that is not possible.

The OpenCLI catalog is bounded by serialized bytes rather than an arbitrary entry count. `catalog` and outbound heartbeats expose the total, advertised count, payload limit, and an explicit truncation flag if an unusually large manifest exceeds that bound.

## Platform integration

| OS | Credential storage | Background service |
|---|---|---|
| macOS | Keychain | LaunchAgent |
| Windows | DPAPI-protected local credential | Task Scheduler |
| Linux | Secret Service where available, private file fallback | user systemd |

LaunchAgent and systemd definitions use a controlled `PATH` containing the resolved Node, Companion, and discovered collector locations plus standard system directories. Ambient credentials are never serialized into service definitions.

Pairing credentials are passed to macOS Keychain, Windows PowerShell/DPAPI, and Linux Secret Service through private standard input. They are never placed in child-process arguments or environment variables.

## Verified updates

The paired Driftglass server is a data endpoint, not a code-signing authority. The Companion therefore never downloads and executes an update from the paired origin. Download a release through a channel you trust, obtain its SHA-256 digest independently, and then install that exact local file:

```bash
driftglass-companion update \
  --file ./driftglass-relay.mjs \
  --sha256 TRUSTED_SHA256
```

The command bounds and syntax-checks the candidate, verifies the supplied digest, and atomically replaces only the Companion executable that was invoked. A missing or mismatched digest leaves the current executable unchanged. Use `--restart false` when you want to restart the background service yourself.

## Upstream roles

- OpenCLI: primary browser-backed execution and dynamic read manifest
- Agent-Reach: optional routing and diagnostic context
- twitter-cli, rdt-cli, twscrape, and other tools: optional fallback candidates behind stable Driftglass capability semantics

## Portable local workspaces

`workspace-sync` mirrors each Cloudflare Mission Computer into a normal folder on the current machine:

- macOS/Linux: `~/.local/share/driftglass/workspaces/`
- Windows: `%LOCALAPPDATA%\driftglass\workspaces\`

The layout matches the cloud workspace: Mission state, Story files, evidence, handoffs, notes, and exports remain ordinary Markdown, JSON, NDJSON, and CSV files. The local copy can be searched and annotated without running a Cloudflare execution backend, and exported/imported as one JSON workspace bundle.

## Computer portability

The cloud Computer is the canonical live workspace. The local mirror is a plain-file escape hatch for editors, coding agents, scripts, local models, Git, backup, and offline work. It is not tied to a Cloudflare execution backend.

Managed files from Driftglass are refreshed on sync. Local working files under `notes/`, `results/`, and `exports/` are preserved and may be pushed back explicitly.

Workspace directories are private to the current operating-system user. Sync, push, search, import, and export reject symbolic links, unsafe cross-platform names, oversized payloads, and paths that resolve outside the selected Mission workspace. Export destinations may be chosen explicitly, but an existing symbolic-link destination is refused.
