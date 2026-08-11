# Threat model

## Protected assets

- owner secret and private capability URLs
- Companion token and browser sessions
- Mission and Taste state
- private source content
- Mission Computer files
- Power Mode token and workspaces
- public-share tokens before expiry

## Trust zones

| Zone | Responsibility |
|---|---|
| Public Internet | Untrusted pages, posts, comments, documents, and metadata |
| Cloudflare core | Structured index, evidence, Mission Computers, packets, and shares |
| Companion | Signed-in browser access and optional local Computer mirror |
| ChatGPT | Bounded evidence and explicit owner-directed operations |
| Computer Power Mode | Separately deployed Worker-shell and Worker-JavaScript execution workspace |

## Main controls

| Risk | Control |
|---|---|
| Owner-secret disclosure | Dashboard session storage, HTTPS, one-way capability derivation, secret rotation |
| SSRF through public pages | Public URL validation, redirect validation, byte and timeout bounds |
| Browser-session leakage | Cookies remain in the local profile; Companion returns normalized evidence |
| Remote execution on desktop | Outbound polling and typed read operations; no inbound service |
| Computer path traversal | Absolute normalized paths and bounded text operations |
| Local mirror overwrite | Managed files refresh; local `notes/`, `results/`, and `exports/` remain user-owned |
| Local-to-cloud file injection | Push is limited to those three working directories with file and total-byte caps |
| Research-result corruption | Results stage as a diff and require approval |
| Prompt injection | Source text remains evidence, not instructions; deterministic preprocessing precedes ChatGPT |
| Power Mode cross-case leakage | Named Computer Durable Objects and a separate deployment token |
| Public-card leakage | Explicit selection, expiry, and no owner credentials in payloads or Capsules |
| Upstream adapter drift | Content-bearing probes, manifest validation, provider fallback, and upstream watch |

Use a dedicated Companion browser profile for research sources. Rotate the core, Companion, and Power Mode credentials independently.
