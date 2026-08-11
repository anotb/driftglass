# Reasoning interfaces

Driftglass does not need to own the model call to improve the quality of model reasoning.

Its job is to prepare exact, source-diverse, temporally aware evidence and preserve what happened afterward.

## Research connection

The default connection is deliberately compact. Cloud installs expose an OAuth-protected endpoint:

```text
/mcp
```

Self-hosted installs offer the same tools locally over stdio or through an optional Secure MCP Tunnel. Existing capability URLs remain available for compatible MCP clients.

It exposes:

```text
brief_mission
brief_today
open_today
next_reasoning_task
prepare_context
prepare_personal_context
search
find_missions
fetch
get_mission
recall_memory
compare_memory
explain_story
get_action_center
get_system_health
list_intelligence_packs
```

`brief_mission` is the primary path for a natural question about a standing Mission. `brief_today` returns the current curated developments with citable open sources in one call. `prepare_context` keeps that open-source boundary for deeper work. When the user explicitly asks to include connected Reddit, X, email, subscriptions, or other signed-in sources, `prepare_personal_context` sends bounded excerpts to the current model. `open_today` remains the visual overview; `search` and `fetch` remain available for wider exploration.

`brief_mission` carries up to four matched Stories and 24 public source items in total. It gives each returned Story an initial share, then uses open slots for the best remaining items. Its coverage fields report how many eligible items were carried or omitted inside each Story's indexed 48-item window and flag older linked material.

This connection works with ChatGPT, Claude, and other MCP clients.

## Allow updates

Actions that save or change anything use a separate connection:

```text
/mcp/{private-operations-key}/ops
```

It supports Mission Sprints, result recording, decision reviews, Intelligence Routines, Pack overlays, Mission workspace notes, and approved memory changes. Connect it only when those actions are useful.

Research and Allow updates use different keys, and one address cannot substitute for the other. Copy each complete address from the owner dashboard. Existing update connections from an earlier 0.9.0 build must be reconnected with the newly displayed address.

## Connection kits

The owner dashboard can export provider setup files and the current bounded reasoning bundle. The normal kit contains only the Research connection. **Include Allow updates** adds the second connection.

## Evidence-State Receipts

For serious reasoning, Driftglass persists an exact receipt before the model sees it.

The receipt contains:

- objective and task
- current Mission state and thesis
- expected next observable event
- prior decisions and conclusions
- source-diverse evidence with lineage and evidence roles
- source health, family identity, domain, provider, and access class
- relevant Memory Graph neighborhood and checkpoints
- chronology and material changes
- contradictions and missing evidence
- open questions
- Intelligence Pack evidence policy and playbook
- output and memory-patch contracts
- actual estimated tokens and truncation details

The JSON and Markdown artifacts share a bundle hash. A result is recorded against that hash, making later review and provider comparison traceable.

For a Mission with many sources, the model receives the highest-ranked source items that fit the chosen context budget. The brief says how much of the current bounded Mission window it carries and whether more matching material remains. A larger export budget can carry more from that same window; it does not turn the receipt into complete history.

Each receipt records one source scope:

- `personal` includes open and connected personal sources, Memory, and standing Mission context.
- `open` uses open evidence and the visible Mission frame without connected Memory or private source state.
- `share` is compiled only from public evidence and the visible Mission title and question. It omits Memory, standing answers, decisions, source health outside that evidence, Pack and overlay context, and private connection addresses.

Only a reviewed result from a `share` receipt can be added to a public Share. The public Story evidence is still rebuilt independently through the existing public-only projection.

## Context-quality gate

Every receipt receives:

```text
strong · usable · insufficient
```

Quality dimensions include:

- evidence depth
- independent-family diversity
- primary or authoritative provenance
- anti-echo resistance
- temporal memory continuity
- recency
- contrary-case coverage
- cloud independence

Blockers and recommended improvements travel with the receipt. Thin evidence is not converted into a polished but shallow answer.

## ChatGPT

For a Cloudflare install, **Connect ChatGPT** opens ChatGPT's Plugins page and copies that instance's `/mcp` address. ChatGPT completes OAuth against the same Worker. Connected apps appear in the dashboard and remain until the owner disconnects them. Each person connects to their own installation; there is no shared Driftglass proxy.

For a self-hosted install, local clients use stdio. ChatGPT on the web can connect through OpenAI's outbound Secure MCP Tunnel after the owner creates the tunnel IDs and starts `tunnel-client`. It runs beside Driftglass, reaches the local stdio bridge, and makes the outbound HTTPS connection. Research and Allow updates use separate tunnel profiles and separate tunnel IDs.

For either setup, once Driftglass shows Connected, the bare connection is available from **Tools** in a new ChatGPT Work chat. Tool choice on that path is still up to ChatGPT. The dashboard can also generate a small personal plugin: paste the connection's `plugin_asdk_app...` ID under **Add @Driftglass**, install the download in ChatGPT desktop, then begin a new Work chat with `@Driftglass`. Its skill routes a general request to `brief_today`, a named Mission to `brief_mission`, and an explicit request to include Reddit, X, email, or subscriptions to `prepare_personal_context`.

When selected, Driftglass routes a named Mission question to `brief_mission` and a general Today question to `brief_today`, each in one call. Scheduled Tasks can read finite scheduled-check packets. The packet retains its complete bounded evidence and source trail; its generated prompt asks for one concise, consequence-first note with exact source links, one grounded watch point when available, and no filler on a quiet day. Pulse stays silent with `NO_SIGNAL` when nothing material survives review. `next_reasoning_task` opens work prepared by Intelligence Routines. Deep Research is appropriate when a Mission requires broader current-source discovery, contradiction resolution, or a cited one-off report.

The generated plugin contains the shared routing skill plus a per-installation app mapping; evidence traffic still goes straight to that person's Worker or tunnel. A public one-install version may later use OpenAI's Template MCP URLs if Driftglass is approved for that program. Driftglass does not need a shared gateway for the current path.

A completed response can be recorded against the exact receipt and optionally stage a typed memory proposal for review.

## Claude

Use the Research connection for ordinary reasoning. Claude Code can combine it with a locally mirrored Mission workspace. Driftglass also exports model instructions and provider-neutral Markdown/JSON receipts.

## Grok and other clients

Where a remote MCP connector is available, use the Research connection. Otherwise, use the exact Markdown or JSON receipt. Provider and model labels are recorded only when the user returns a result; Driftglass does not require an xAI API key.

## Provider comparison

Several models can reason over the same receipt. Driftglass compares agreement, confidence spread, consensus terms, and divergent pairs. That comparison helps identify ambiguity or the need for adjudication, but it never replaces source evidence or user judgment.

## Durable write-back

A reasoning result may propose:

- a Mission update
- a decision or forecast
- new findings, questions, or expectations
- supporting or contradicting relations
- supersession of an outdated conclusion

Driftglass validates and stages durable-memory changes. Canonical memory changes only after review.

See [`docs/JUDGMENT-LOOP.md`](JUDGMENT-LOOP.md).
