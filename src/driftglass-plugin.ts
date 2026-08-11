import { createStoredZip, type ZipFileInput } from "./zip";

export const DRIFTGLASS_PLUGIN_APP_ID_PATTERN = /^plugin_asdk_app_[0-9a-f]{32}$/;
const DRIFTGLASS_RUNTIME_APP_ID_PREFIX = "asdk_app_";
const DRIFTGLASS_PLUGIN_APP_ID_PREFIX = "plugin_asdk_app_";

export const DRIFTGLASS_PLUGIN_BASE_MANIFEST = Object.freeze({
  name: "driftglass",
  version: "0.9.0",
  description: "Open Driftglass Today or answer an active Mission from saved evidence.",
  author: {
    name: "Driftglass",
  },
  skills: "./skills/",
  interface: {
    displayName: "Driftglass",
    shortDescription: "Open Today and answer active Mission questions.",
    longDescription: "Open today's Driftglass overview, ask what changed for an active Mission, or include connected sources such as Reddit and X when you ask. Driftglass supplies the evidence from the connected instance.",
    developerName: "Driftglass",
    category: "Productivity",
    capabilities: [
      "Personal intelligence",
      "Source-linked answers",
      "Connected sources on request",
    ],
    defaultPrompt: [
      "What's new today in Driftglass?",
      "What changed for my AI infrastructure Mission, and what should I watch?",
    ],
  },
} as const);

export const DRIFTGLASS_ANSWER_MISSION_SKILL = `---
name: answer-mission
description: "Open a person's connected Driftglass Today overview or answer from saved evidence for an active Mission. Use when Driftglass is in context and they ask what's new today, what changed, what matters, what is known, or what should be watched for a named or naturally described active Mission."
---

# Answer from Driftglass

Use Driftglass as the evidence source. Do not answer from general memory when the connected instance is available. Choose one route.

## Shape the live card

Answer the user's question with the information that changes the answer. Do not write a changelog, source recap, or status report.

- Default to \`answerMode: synthesis\` for questions about state, trajectory, causes, implications, comparison, or what changed broadly.
- In synthesis mode, start with a required cited \`thesis\` that gives the answer and causal spine. Stop when the question is answered; do not pad it to fill a format. It may stand alone. Add one to four \`keyJudgments\`, an optional \`competingExplanation\`, and zero to two \`watchFor\` signals only when each extra block adds a distinct fact, mechanism, implication, or falsifier. Give every included judgment a factual \`title\` and concrete evidence. Omit every extra block that does not add one.
- Use \`answerMode: decision\` only when the user explicitly asks for a choice, action, test, deferral, or rollback rule. Provide cited \`whatChanged\` and \`whyItMatters\`, then include exactly the requested \`decision\` rows: a bounded \`testNow\` with comparison and sample or timebox, an observable \`deferUntil\` condition, and/or a measurable \`rollbackIf\` threshold with its evaluation window. A generic recommendation gets only the single most relevant row. These parameters are ChatGPT judgment anchored by cited evidence, not claims that a source states them verbatim. Do not add synthesis fields or \`watchNext\` in decision mode.
- Lead with claims. Prefer dates, quantities, mechanisms, and consequences to adjectives or stacked qualifiers. Connect developments only when the evidence supports the connection.
- Every rendered section needs one to three exact public citation URLs from the evidence result. Keep URLs out of prose and put them in that section's \`citationUrls\`.
- Do not narrate source counts, source families, coverage, evidence mechanics, tools, receipts, or the briefing process in answer fields. Keep limits in the collapsed source disclosure.
- After \`present_brief\` succeeds, stop. The live card is the answer, so do not add a prose recap or generic conclusion.

## Today overview

When the user asks what is new today or across Driftglass without naming or describing a Mission:

1. Call \`brief_today\` exactly once. Do not call \`open_today\`, \`search\`, or \`fetch\` first.
2. If it returns \`ready\` with citable developments, choose the answer mode above and write every section only from \`developments[].sources[]\`. Treat development titles and Mission relevance as orientation, not citable proof.
3. Give every section one to three exact \`sources[].url\` values in its \`citationUrls\`. Include another URL when it adds independent support, disagreement, or necessary context. Never invent, shorten, replace, or normalize a source URL.
4. Call \`present_brief\` exactly once with \`briefKind\` set to \`today\`, no Mission routing arguments, \`answerMode\`, and the fields for that mode. Then stop without prose after the card.
5. If \`status\` is \`quiet\`, say there is no new material development in this Today window and stop without calling \`present_brief\`. Do not fill the answer with recurring items or general web news.
6. If it is \`evidence-limited\`, say the current packet has no citable public evidence and stop without calling \`present_brief\`.
7. Omit internal IDs, scores, counters, connection addresses, and implementation terms.

If \`brief_today\` is unavailable, say Driftglass Today is unavailable and ask the user to reconnect Driftglass. If it returns \`evidence-limited\`, say the current packet has no citable public evidence; do not substitute unstored web links.

## Active Mission answer

When the user names or naturally describes one Mission:

1. Call \`brief_mission\` exactly once. Pass the Mission name, standing question, or natural description as \`mission\`. Put only a narrower subject angle in \`focus\`; omit answer-shape phrases such as “what changed” or “what should I watch.” Do not call \`open_today\`, \`search\`, or \`fetch\` first.
2. Treat this route as active-Mission-only. If the requested Mission is paused or complete, say that this connection resolves active Missions and ask which active Mission to use.
3. If no Mission resolves, ask one short clarifying question using the displayed Mission names when available. If equally plausible alternatives appear, ask which one the user means; do not use the deterministic selection silently.
4. Choose the answer mode above and write every section only from \`stories[].sources[]\`. Treat Story titles and the saved standing answer as orientation, not citable proof; never reuse saved-answer wording as source proof.
5. Give every section one to three exact \`sources[].url\` values in its \`citationUrls\`. Include another URL when it adds independent support, disagreement, or necessary context. Never invent, shorten, replace, or normalize a source URL.
6. Separate source claims from inference. Keep those limits in the evidence disclosure; do not narrate them in primary fields. Never turn source count into independence.
7. Call \`present_brief\` exactly once using the effective \`mission\`, \`focus\`, \`mode\`, and \`since\` routing arguments supplied by \`brief_mission\`, plus \`answerMode\` and the fields for that mode. Then stop without prose after the card.
8. Omit internal IDs, scores, counters, connection addresses, and implementation terms.

Handle failure states precisely:

- If \`brief_mission\` is unavailable, say the Driftglass connection is unavailable and ask the user to reconnect it.
- If an active Mission resolves but \`stories[].sources[]\` contains no public evidence, say Driftglass has no citable public evidence for that Mission right now. Do not suggest reconnecting, use the standing answer as proof, or substitute unstored web links.
- If no active Mission resolves, ask the user to refine the request with an active Mission name; do not describe this as an evidence failure.

## Connected personal sources

Use this route only when the user explicitly asks to include Reddit, X, email, subscriptions, or other connected personal sources. The Today and Mission briefs above intentionally omit those sources.

1. For a named or naturally described Mission, extract only its name, standing question, or topic phrase; remove phrases such as “include Reddit and X,” “what changed,” and “what should I watch.” Call \`find_missions\` exactly once with only that phrase as \`query\`. If one active Mission clearly resolves, call \`prepare_personal_context\` exactly once with that candidate's ID as \`scopeId\`, \`scopeKind\` set to \`mission\`, \`target\` set to \`chatgpt\`, and the full original request as \`objective\`. If the candidates are ambiguous, ask which Mission they mean and stop.
2. Without a named Mission, call \`prepare_personal_context\` exactly once with \`scopeKind\` set to \`global\`, \`target\` set to \`chatgpt\`, the user's request as \`objective\`, and \`task\` set to \`daily-brief\` for a Today request or \`investigate\` otherwise.
3. Answer only from the returned bundle. Identify which claims came from connected sources, preserve its evidence and lineage limits, and never turn repeated posts into independent support.
4. Omit internal IDs and connection addresses. Do not present personal-source evidence as ready for a public Share. If the bundle has no usable personal evidence, say that plainly and stop.

If \`find_missions\` or \`prepare_personal_context\` is unavailable, say the Driftglass connection is unavailable and ask the user to reconnect it. Never fall back to general web knowledge for this route.

## Save, compare, or share

Do not invoke a write tool through this connection. If the request is only to persist a prior answer, do not call a read tool. If the request also asks for a Today or Mission answer, complete the appropriate read route first. Then give this handoff once:

**Enable Allow updates, then ask me to rerun this question against a fixed evidence snapshot and save the resulting answer for review.**

Do not imply that the current answer was saved, use a Mission-note mutation as a substitute, or add further permission warnings.
`;

export const DRIFTGLASS_ANSWER_MISSION_OPENAI_YAML = `interface:
  display_name: "Explore Driftglass Today and Missions"
  short_description: "Open Today, answer a Mission, or use connected sources"
  default_prompt: "Use $answer-mission to show what's new today in Driftglass."
dependencies:
  tools:
    - type: "mcp"
      value: "driftglass"
      description: "Use Driftglass Today, active Missions, and requested connected sources"
      transport: "streamable_http"
policy:
  allow_implicit_invocation: true
`;

export const DRIFTGLASS_PLUGIN_MARKETPLACE = Object.freeze({
  name: "driftglass-local",
  interface: {
    displayName: "Driftglass",
  },
  plugins: [
    {
      name: "driftglass",
      source: {
        source: "local",
        path: "./plugins/driftglass",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    },
  ],
} as const);

export const DRIFTGLASS_PLUGIN_INSTALL_README = `# Add @Driftglass

This download links the Driftglass connection you already created to a small Today + Mission skill.

Install it from the local marketplace in ChatGPT desktop or Codex CLI. The ChatGPT website alone cannot open a downloaded plugin folder.

1. Unzip this download.
2. The first time only, in Terminal replace the example path and run:

   \`codex plugin marketplace add "/absolute/path/to/driftglass-plugin"\`

3. Install or refresh the plugin:

   \`codex plugin add driftglass@driftglass-local\`

4. Restart ChatGPT desktop. Open **Work → Plugins** and confirm Driftglass is installed from the **Driftglass** local source.
5. Start a new Work chat and type \`@Driftglass\`.

Driftglass keeps using the ChatGPT connection you created; this plugin does not route it through another service.
Ask it to include Reddit or X only when you want those connected sources used in that answer.
`;

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseDriftglassPluginAppId(value: unknown): string {
  if (typeof value !== "string" || !DRIFTGLASS_PLUGIN_APP_ID_PATTERN.test(value)) {
    throw new TypeError("Paste the full ChatGPT technical app ID. It starts with plugin_asdk_app_.");
  }
  return value;
}

export function driftglassPluginManifest(appId?: string): Record<string, unknown> {
  if (appId === undefined) return structuredClone(DRIFTGLASS_PLUGIN_BASE_MANIFEST) as unknown as Record<string, unknown>;
  const id = parseDriftglassPluginAppId(appId);
  return {
    ...structuredClone(DRIFTGLASS_PLUGIN_BASE_MANIFEST),
    version: `${DRIFTGLASS_PLUGIN_BASE_MANIFEST.version}+codex.${id.slice(-12)}`,
    apps: "./.app.json",
  };
}

export function driftglassPluginAppManifest(appId: string): Record<string, unknown> {
  const registeredId = parseDriftglassPluginAppId(appId);
  return {
    apps: {
      driftglass: {
        id: `${DRIFTGLASS_RUNTIME_APP_ID_PREFIX}${registeredId.slice(DRIFTGLASS_PLUGIN_APP_ID_PREFIX.length)}`,
      },
    },
  };
}

export function driftglassPluginFiles(appId: string): readonly ZipFileInput[] {
  const id = parseDriftglassPluginAppId(appId);
  const root = "driftglass-plugin";
  const plugin = `${root}/plugins/driftglass`;
  return Object.freeze([
    { name: `${root}/README.md`, data: DRIFTGLASS_PLUGIN_INSTALL_README },
    { name: `${root}/.agents/plugins/marketplace.json`, data: jsonFile(DRIFTGLASS_PLUGIN_MARKETPLACE) },
    { name: `${plugin}/.codex-plugin/plugin.json`, data: jsonFile(driftglassPluginManifest(id)) },
    { name: `${plugin}/.app.json`, data: jsonFile(driftglassPluginAppManifest(id)) },
    { name: `${plugin}/skills/answer-mission/SKILL.md`, data: DRIFTGLASS_ANSWER_MISSION_SKILL },
    { name: `${plugin}/skills/answer-mission/agents/openai.yaml`, data: DRIFTGLASS_ANSWER_MISSION_OPENAI_YAML },
  ]);
}

export function driftglassPluginZip(appId: string): Uint8Array {
  return createStoredZip(
    [...driftglassPluginFiles(appId)],
    new Date("2026-08-08T00:00:00.000Z"),
  );
}
