# Evidence lineage and source scorecards

A large source count can still represent one original report copied many times. Driftglass therefore separates evidence volume from evidence independence.

## Evidence families

A family key is derived from the strongest stable identity available:

- explicit publisher or family metadata
- GitHub repository
- npm or PyPI package
- publisher domain
- authenticated author or account
- subreddit or community
- configured source identity

## Lineage relations

Within a Story, evidence may be classified as:

| Relation | Meaning |
|---|---|
| `origin` | First observed or meaningfully independent evidence family |
| `independent` | Separate corroborating family |
| `same-family` | Different item from the same underlying publisher or account family |
| `update` | New information from an existing origin or family |
| `echo` | Repetition with high title or body similarity and little new information |

Classification is deterministic and bounded. It uses canonical URLs, family identity, title similarity, body similarity, and chronology.

## Context selection

The Context Compiler:

- prefers independent families,
- keeps primary and authoritative items visible,
- preserves meaningful updates,
- limits same-family repetition,
- omits low-value echoes before the token budget is spent,
- reports independent-family and omitted-echo counts.

This does not remove community reaction. It makes clear when reaction is discovery or interpretation rather than independent factual confirmation.

## Source scorecards

Each source receives an inspectable scorecard based on recent operation:

- useful item yield
- Mission match contribution
- independent-family contribution
- echo rate
- successful run rate
- latency
- recent failures

The scorecard recommends one of:

```text
accelerate · keep · slow · repair · pause
```

## Adaptive cadence

Cadence is changed gradually using exponential moving averages and deterministic daily jitter.

- repeated failures back off,
- repeated empty successful runs back off,
- sustained high-signal runs accelerate,
- poor health enforces a minimum backoff,
- stable sources converge toward their configured baseline.

Every run still requires a Budget Governor reservation. Adaptive cadence reallocates work within the selected envelope; it does not create an unlimited polling mode.
