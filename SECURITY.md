# Security policy

## Reporting

Use GitHub private vulnerability reporting for credential disclosure, authentication bypass, SSRF, unintended social writes, path traversal, cross-Mission data access, or remote execution issues.

## Security boundaries

| Component | Boundary |
|---|---|
| Core Worker | Single trusted owner, private dashboard secret, derived read capability URLs |
| Mission Computer | One named Durable Object workspace per Mission |
| Companion | Outbound polling, platform credential store, dedicated browser profile |
| Local mirror | Managed cloud files plus user-owned `notes/`, `results/`, and `exports/` |
| Computer Power Mode | Separate Worker secret and isolated case Computer IDs |
| Public shares | Explicit, expiring, credential-free payloads |

The Companion uploads normalized evidence, not browser credentials. Its workspace push surface accepts only the working directories and enforces per-file and aggregate size bounds.

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
