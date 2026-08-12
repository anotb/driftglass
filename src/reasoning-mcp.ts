import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildActionCenter } from "./action-center";
import { latestOrBuildBriefing } from "./briefing";
import {
  BRIEF_FLOW_INSTRUCTIONS,
  BRIEF_PRESENTATION_TOOL_DESCRIPTION,
  briefPresentationInputSchema,
  briefPresentationOutputSchema,
  briefPresentationToolResult,
  buildBriefPresentation,
  type BriefPresentationInput,
} from "./brief-presentation";
import { briefingInterfacePayload, briefingInterfaceText } from "./briefing-interface";
import { budgetStatus } from "./budget";
import {
  EDITORIAL_BRIEF_WIDGET_HTML,
  EDITORIAL_BRIEF_WIDGET_URI,
  LEGACY_EDITORIAL_BRIEF_WIDGET_URI,
} from "./chatgpt-brief-widget";
import { BRIEFING_WIDGET_HTML, BRIEFING_WIDGET_URI } from "./chatgpt-widget";
import {
  getMission,
  getMissionOperator,
  getMissionResearchState,
  listIntelligencePacks,
  listMemoryCheckpoints,
  listMissionEvents,
  listMissionMatches,
  listMissions,
  listSourceHealth,
} from "./db";
import { explainStoryRanking } from "./explain";
import { memoryGraphHealth, memoryNeighborhood } from "./memory-graph";
import {
  knowledgeFetchOutputSchema,
  knowledgeSearchOutputSchema,
  knowledgeToolResult,
} from "./mcp-knowledge";
import { buildMissionBrief, missionBriefOutputSchema, missionBriefToolResult } from "./mission-brief";
import { fetchPublicStoryKnowledge, searchPublicStoryKnowledge } from "./public-story-knowledge";
import { projectTodayBrief, todayBriefOutputSchema, todayBriefToolResult } from "./today-brief";
import { buildLivingDossier } from "./dossiers";
import { judgmentOverview } from "./judgment";
import { reasoningReceiptDetail } from "./reasoning-ledger";
import { buildReasoningBundle, buildTransientPersonalReasoningBundle, reasoningBundleMarkdown } from "./reasoning";
import type { Env, MemoryCheckpointRecord, ReasoningTarget, ReasoningTask } from "./types";
import { diffMemorySnapshots, readMemoryCheckpointSnapshot } from "./memory-checkpoints";
import { nextReasoningTask, reasoningTaskPrompt } from "./reasoning-tasks";
import { parseJson } from "./utils";

type ToolResultPromise = Promise<Awaited<ReturnType<Parameters<McpServer["registerTool"]>[2]>>>;

function readOnlyAnnotations(openWorld = false): Record<string, boolean> {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld };
}

export function createReasoningMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "driftglass-reasoning", version: "0.9.0" },
    {
      instructions: `${BRIEF_FLOW_INSTRUCTIONS} Use open_today only for the broader visual overview, search and fetch for wider Story exploration, and prepare_context for deeper open-source work. Call prepare_personal_context only when the user explicitly asks to use connected Reddit, X, email, subscriptions, or other personal sources. After prepare_personal_context, answer only from its returned bundle in roughly 90–160 words. Lead with the strongest supported consequence and use the concrete facts, dates, and quantities in the bundle. Identify connected-source claims and preserve access and lineage limits. Use one or two plain-English paragraphs with no headings, checklist, report recap, count narration, coverage narration, or tool narration. Do not browse or add general knowledge, and do not append a memory patch unless the user explicitly asked for one. For an answer that should be saved, compared, or shared, switch to the separately authorized approval connection, prepare a fixed source set, then record and review the answer against it.`,
    },
  );

  server.registerResource("driftglass-briefing", BRIEFING_WIDGET_URI, {}, async () => ({
    contents: [{
      uri: BRIEFING_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: BRIEFING_WIDGET_HTML,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "A compact Mission-first Driftglass briefing showing new and materially changed Stories.",
        "openai/widgetPrefersBorder": true,
      },
    }],
  }));

  server.registerResource("driftglass-editorial-brief", EDITORIAL_BRIEF_WIDGET_URI, {}, async () => ({
    contents: [{
      uri: EDITORIAL_BRIEF_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: EDITORIAL_BRIEF_WIDGET_HTML,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "An answer-first synthesis or decision written by ChatGPT from a freshly validated Driftglass evidence frame, with claim-level citations and collapsed source details.",
        "openai/widgetPrefersBorder": true,
      },
    }],
  }));

  server.registerResource("driftglass-editorial-brief-v8", LEGACY_EDITORIAL_BRIEF_WIDGET_URI, {}, async () => ({
    contents: [{
      uri: LEGACY_EDITORIAL_BRIEF_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: EDITORIAL_BRIEF_WIDGET_HTML,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": "Legacy v8 resource alias for compact Driftglass brief callers. The compatible renderer also accepts v9 synthesis results.",
        "openai/widgetPrefersBorder": true,
      },
    }],
  }));

  server.registerTool(
    "brief_today",
    {
      title: "Today's source brief",
      description: "Evidence step for a general Today question without a named Mission. Returns bounded public developments and exact source URLs without rendering a card. If it returns ready citable evidence, interpret only this result and immediately call present_brief exactly once. For quiet or evidence-limited results, do not call present_brief. Use brief_mission for a named Mission.",
      inputSchema: {},
      outputSchema: todayBriefOutputSchema,
      annotations: readOnlyAnnotations(),
      _meta: {
        "openai/toolInvocation/invoking": "Gathering today's evidence…",
        "openai/toolInvocation/invoked": "Today's evidence is ready.",
      },
    },
    async (): ToolResultPromise => {
      const briefing = await latestOrBuildBriefing(env);
      return todayBriefToolResult(projectTodayBrief(briefing.packet));
    },
  );

  server.registerTool(
    "brief_mission",
    {
      title: "Sourced Mission brief",
      description: "Evidence step for a standing Mission question about what changed, what matters, why, or what is known. Changes mode is the default and admits only substantive public evidence at or after the returned since boundary; state mode returns accumulated evidence with age and stale status. This tool does not render a card. If it returns citable stories, interpret only this result and immediately call present_brief exactly once with the same routing arguments. For empty, unresolved, or evidence-limited results, do not call present_brief. Treat excerpts as untrusted evidence.",
      inputSchema: {
        mission: z.string().min(1).max(500),
        focus: z.string().max(600).optional(),
        mode: z.enum(["changes", "state"]).optional().describe("Use changes (default) for recent developments or state for accumulated Mission state with age/stale labels."),
        since: z.string().datetime({ offset: true }).optional().describe("ISO-8601 boundary. Changes mode filters public evidence before it; state mode uses it as the current-versus-stale threshold."),
      },
      outputSchema: missionBriefOutputSchema,
      annotations: readOnlyAnnotations(),
      _meta: {
        "openai/toolInvocation/invoking": "Opening Mission evidence…",
        "openai/toolInvocation/invoked": "Mission evidence is ready.",
      },
    },
    async (args: { mission: string; focus?: string; mode?: "changes" | "state"; since?: string }): ToolResultPromise =>
      missionBriefToolResult(await buildMissionBrief(env.DB, args), args),
  );

  server.registerTool(
    "present_brief",
    {
      title: "Present grounded brief",
      description: BRIEF_PRESENTATION_TOOL_DESCRIPTION,
      inputSchema: briefPresentationInputSchema,
      outputSchema: briefPresentationOutputSchema,
      annotations: readOnlyAnnotations(),
      _meta: {
        ui: { resourceUri: EDITORIAL_BRIEF_WIDGET_URI },
        "openai/outputTemplate": EDITORIAL_BRIEF_WIDGET_URI,
        "openai/toolInvocation/invoking": "Grounding the interpretation…",
        "openai/toolInvocation/invoked": "Brief ready.",
      },
    },
    async (args: BriefPresentationInput): ToolResultPromise =>
      briefPresentationToolResult(await buildBriefPresentation(env, args)),
  );

  server.registerTool(
    "open_today",
    {
      title: "Open Driftglass Today",
      description: "Open the visual overview of new and materially changed Stories. Use brief_today for a factual Today answer, brief_mission for a named Mission, and find_missions, get_mission, search, or fetch for manual exploration.",
      inputSchema: {},
      annotations: readOnlyAnnotations(),
      _meta: {
        ui: { resourceUri: BRIEFING_WIDGET_URI },
        "openai/outputTemplate": BRIEFING_WIDGET_URI,
        "openai/toolInvocation/invoking": "Opening Driftglass…",
        "openai/toolInvocation/invoked": "Driftglass is ready.",
      },
    },
    async (): ToolResultPromise => {
      const briefing = await latestOrBuildBriefing(env);
      const payload = briefingInterfacePayload(briefing.packet);
      return {
        structuredContent: payload,
        content: [{ type: "text", text: briefingInterfaceText(payload) }],
      };
    },
  );

  server.registerTool(
    "next_reasoning_task",
    {
      title: "Open the next prepared reasoning task",
      description: "Return the next model-ready task and its fixed evidence snapshot without changing it. Use this to turn continuous monitoring into deliberate reasoning work.",
      inputSchema: {},
      annotations: readOnlyAnnotations(),
    },
    async (): ToolResultPromise => {
      const task = await nextReasoningTask(env);
      if (!task) return { structuredContent: { task: null }, content: [{ type: "text", text: "No reasoning task is ready." }] };
      if (!task.receipt_id || task.status !== "ready") {
        return {
          structuredContent: { task, receipt: null },
          content: [{ type: "text", text: `${reasoningTaskPrompt(task)}

The fixed evidence snapshot is still being prepared by Driftglass.` }],
        };
      }
      const detail = await reasoningReceiptDetail(env, task.receipt_id);
      return {
        structuredContent: { task, ...detail },
        content: [{ type: "text", text: reasoningTaskPrompt(task) }],
      };
    },
  );

  server.registerTool(
    "prepare_context",
    {
      title: "Prepare evidence for deeper reasoning",
      description: "Prepare an investigation brief from open-source evidence and the visible Mission frame. Use the personal-source tool only when the user asks for connected sources or memory.",
      inputSchema: {
        target: z.enum(["chatgpt", "claude", "grok", "generic"]).optional(),
        task: z.enum(["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"]).optional(),
        scopeKind: z.enum(["global", "mission", "story"]).optional(),
        scopeId: z.string().max(120).optional(),
        objective: z.string().max(2000).optional(),
        tokenBudget: z.number().int().min(2000).max(50000).optional(),
      },
      annotations: readOnlyAnnotations(),
    },
    async (args: { target?: ReasoningTarget; task?: ReasoningTask; scopeKind?: "global" | "mission" | "story"; scopeId?: string; objective?: string; tokenBudget?: number }): ToolResultPromise => {
      const bundle = await buildReasoningBundle(env, { ...args, sourceScope: "open" });
      return {
        structuredContent: {
          bundle,
          persistence: {
            recordable: false,
            next: "Use prepare_reasoning_receipt through the approval connection before producing an answer that should be saved or compared.",
          },
        },
        content: [{ type: "text", text: `${reasoningBundleMarkdown(bundle)}\n\nThis brief is temporary. Create a fixed evidence snapshot before saving a consequential answer.` }],
      };
    },
  );

  server.registerTool(
    "prepare_personal_context",
    {
      title: "Use my personal sources",
      description: "Use only when the user asks to include connected personal sources. Sends excerpts from Reddit, X, email, subscriptions, and other signed-in sources to this model for one transient answer. Answer only from the returned bundle in roughly 90–160 words. Lead with the strongest supported consequence and use its concrete facts, dates, and quantities. Identify connected-source claims, preserve access and lineage limits, and use one or two plain-English paragraphs with no headings, checklist, report recap, count or coverage narration, or tool narration. Do not browse, add general knowledge, or append a memory patch unless the user explicitly requests it.",
      inputSchema: {
        target: z.enum(["chatgpt", "claude", "grok", "generic"]).optional(),
        task: z.enum(["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"]).optional(),
        scopeKind: z.enum(["global", "mission", "story"]).optional(),
        scopeId: z.string().max(120).optional(),
        objective: z.string().max(2000).optional(),
        tokenBudget: z.number().int().min(2000).max(50000).optional(),
      },
      annotations: readOnlyAnnotations(),
      _meta: {
        "openai/toolInvocation/invoking": "Gathering personal sources…",
        "openai/toolInvocation/invoked": "Personal-source context is ready.",
      },
    },
    async (args: { target?: ReasoningTarget; task?: ReasoningTask; scopeKind?: "global" | "mission" | "story"; scopeId?: string; objective?: string; tokenBudget?: number }): ToolResultPromise => {
      const bundle = await buildTransientPersonalReasoningBundle(env, args);
      return {
        structuredContent: {
          bundle,
          persistence: {
            recordable: false,
            next: "Use the approval connection to save an answer with its exact evidence snapshot.",
          },
        },
        content: [{ type: "text", text: `${reasoningBundleMarkdown(bundle)}\n\nUse only this returned bundle. Lead with the strongest supported consequence and use its concrete facts, dates, and quantities. Answer in roughly 90–160 words as one or two plain-English paragraphs. Do not use headings, a checklist, report recap, count or coverage narration, or tool narration. Identify connected-source claims and preserve their access and lineage limits. Do not browse, add general knowledge, or append a memory patch unless the user explicitly requested one.` }],
      };
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search Driftglass Story memory",
      description: "Find Story IDs with public source links. Results are navigation candidates; call fetch on the decisive Stories before making factual claims.",
      inputSchema: { query: z.string().min(1).max(300) },
      outputSchema: knowledgeSearchOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ query }: { query: string }): ToolResultPromise => {
      return knowledgeToolResult(await searchPublicStoryKnowledge(env.DB, query, 10));
    },
  );

  server.registerTool(
    "find_missions",
    {
      title: "Find Research Missions",
      description: "Find a standing Research Mission by name, question, or topic. Mission results are navigation only, not citable evidence.",
      inputSchema: {
        query: z.string().max(300).optional(),
        status: z.enum(["active", "paused", "complete", "all"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: readOnlyAnnotations(),
    },
    async ({ query, status, limit }: { query?: string; status?: "active" | "paused" | "complete" | "all"; limit?: number }): ToolResultPromise => {
      const missions = await listMissions(env.DB, status === "all" ? undefined : status ?? "active");
      const needle = String(query || "").trim().toLocaleLowerCase();
      const results = missions
        .filter((mission) => {
          if (!needle) return true;
          const terms = parseJson<string[]>(mission.terms_json, []);
          return [mission.name, mission.question, ...terms].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
        })
        .slice(0, limit ?? 20)
        .map((mission) => ({
          id: mission.id,
          name: mission.name,
          question: mission.question,
          status: mission.status,
          terms: parseJson<string[]>(mission.terms_json, []).slice(0, 12),
          updatedAt: mission.updated_at,
        }));
      const text = results.length
        ? results.map((mission) => `${mission.name} (${mission.id})\n${mission.question}`).join("\n\n")
        : "No matching Research Mission was found.";
      return { structuredContent: { missions: results }, content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a Driftglass Story",
      description: "Fetch one decisive Story as a citable document. Cite its non-empty public url; if url is empty, disclose that no public source link is available.",
      inputSchema: { id: z.string().min(1).max(100) },
      outputSchema: knowledgeFetchOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ id }: { id: string }): ToolResultPromise => {
      const document = await fetchPublicStoryKnowledge(env.DB, id);
      if (!document) {
        return { isError: true, content: [{ type: "text", text: `No public evidence is available for Story: ${id}` }] };
      }
      return knowledgeToolResult(document);
    },
  );

  server.registerTool(
    "get_mission",
    {
      title: "Get a Research Mission",
      description: "Open one standing question and navigation candidates. Mission material is context, not a citable source: fetch the decisive Story IDs before factual conclusions.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: readOnlyAnnotations(),
    },
    async ({ id }: { id: string }): ToolResultPromise => {
      const [mission, operator, research, matches, events, dossier] = await Promise.all([
        getMission(env.DB, id),
        getMissionOperator(env.DB, id),
        getMissionResearchState(env.DB, id),
        listMissionMatches(env.DB, id, 12),
        listMissionEvents(env.DB, id, 30),
        buildLivingDossier(env, { scopeKind: "mission", scopeId: id }),
      ]);
      if (!mission) return { isError: true, content: [{ type: "text", text: `Mission not found: ${id}` }] };
      const storyCandidates = matches.map((match) => ({
        storyId: String(match.story_id ?? ""),
        title: String(match.title ?? ""),
        changedAt: String(match.last_changed_at ?? ""),
        matchedTerms: parseJson<string[]>(String(match.matched_terms_json ?? "[]"), []),
      }));
      const payload = {
        mission,
        operator,
        research,
        storyCandidates,
        events,
        dossier,
        sourceSequence: "Mission context is navigation only. Fetch decisive Story IDs before factual conclusions.",
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "recall_memory",
    {
      title: "Recall connected Driftglass memory",
      description: "Retrieve the nearby memory for an entity, Mission, Story, decision, finding, question, or expectation.",
      inputSchema: {
        ref: z.string().max(200).optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(80).optional(),
      },
      annotations: readOnlyAnnotations(),
    },
    async ({ ref, query, limit }: { ref?: string; query?: string; limit?: number }): ToolResultPromise => {
      const graph = await memoryNeighborhood(env, { ref, query, limit: limit ?? 50 });
      const payload = {
        stats: graph.stats,
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          type: node.node_type,
          label: node.label,
          summary: node.summary,
          status: node.status,
          importance: node.importance,
          confidence: node.confidence,
          occurredAt: node.occurred_at,
          sourceRef: node.source_ref,
        })),
        edges: graph.edges.map((edge) => ({
          id: edge.id,
          from: edge.from_node_id,
          to: edge.to_node_id,
          relation: edge.relation,
          weight: edge.weight,
          confidence: edge.confidence,
          rationale: edge.rationale,
          evidence: parseJson(edge.evidence_json, []),
        })),
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "compare_memory",
    {
      title: "Compare memory over time",
      description: "Compare two saved memory states, or the latest two states for a global, Mission, Story, or Pack scope. Use this to explain how the standing answer changed.",
      inputSchema: {
        scopeKind: z.enum(["global", "mission", "story", "pack"]).optional(),
        scopeId: z.string().max(120).optional(),
        fromCheckpointId: z.string().max(120).optional(),
        toCheckpointId: z.string().max(120).optional(),
      },
      annotations: readOnlyAnnotations(),
    },
    async ({ scopeKind, scopeId, fromCheckpointId, toCheckpointId }: { scopeKind?: MemoryCheckpointRecord["scope_kind"]; scopeId?: string; fromCheckpointId?: string; toCheckpointId?: string }): ToolResultPromise => {
      const byId = async (id: string): Promise<MemoryCheckpointRecord | null> => env.DB.prepare("SELECT * FROM memory_checkpoints WHERE id = ?").bind(id).first<MemoryCheckpointRecord>();
      let from: MemoryCheckpointRecord | null = fromCheckpointId ? await byId(fromCheckpointId) : null;
      let to: MemoryCheckpointRecord | null = toCheckpointId ? await byId(toCheckpointId) : null;
      if (!from || !to) {
        const checkpoints = await listMemoryCheckpoints(env.DB, { scopeKind: scopeKind ?? "global", scopeId, limit: 2 });
        to ??= checkpoints[0] ?? null;
        from ??= checkpoints.find((checkpoint) => checkpoint.id !== to?.id) ?? null;
      }
      if (!to) return { isError: true, content: [{ type: "text", text: "No saved memory state exists for this scope." }] };
      const [fromSnapshot, toSnapshot] = await Promise.all([
        from ? readMemoryCheckpointSnapshot(env, from) : Promise.resolve(null),
        readMemoryCheckpointSnapshot(env, to),
      ]);
      if (!toSnapshot) return { isError: true, content: [{ type: "text", text: "The saved memory state is unavailable." }] };
      const diff = diffMemorySnapshots(fromSnapshot, toSnapshot, from?.id ?? null);
      const currentNodes = new Map(toSnapshot.nodes.map((node) => [node.id, node]));
      const previousNodes = new Map((fromSnapshot?.nodes ?? []).map((node) => [node.id, node]));
      const describe = (ids: string[]) => ids.slice(0, 40).map((id) => currentNodes.get(id) ?? previousNodes.get(id) ?? { id });
      const payload = {
        from: from ? { id: from.id, title: from.title, createdAt: from.created_at, hash: from.snapshot_hash } : null,
        to: { id: to.id, title: to.title, createdAt: to.created_at, hash: to.snapshot_hash },
        diff,
        addedNodes: describe(diff.addedNodes),
        changedNodes: describe(diff.changedNodes),
        removedNodes: describe(diff.removedNodes),
      };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "explain_story",
    {
      title: "Explain why a Story matters",
      description: "Inspect ranking composition, explicit Taste signals, and why a Story entered the briefing.",
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: readOnlyAnnotations(),
    },
    async ({ id }: { id: string }): ToolResultPromise => {
      const explanation = await explainStoryRanking(env, id);
      if (!explanation) return { isError: true, content: [{ type: "text", text: `Story not found: ${id}` }] };
      return { structuredContent: { explanation }, content: [{ type: "text", text: JSON.stringify({ explanation }, null, 2) }] };
    },
  );

  server.registerTool(
    "get_action_center",
    {
      title: "Show what needs attention",
      description: "Return expected events, due Missions, pending research decisions, and sources that actually need attention.",
      inputSchema: {},
      annotations: readOnlyAnnotations(),
    },
    async (): ToolResultPromise => {
      const center = await buildActionCenter(env);
      return { structuredContent: center, content: [{ type: "text", text: JSON.stringify(center, null, 2) }] };
    },
  );

  server.registerTool(
    "get_system_health",
    {
      title: "Check Driftglass sources, memory, and usage plan",
      description: "Check whether collection, connected memory, and the selected usage plan are ready for reliable reasoning.",
      inputSchema: {},
      annotations: readOnlyAnnotations(),
    },
    async (): ToolResultPromise => {
      const [memory, budget, sources, judgment] = await Promise.all([memoryGraphHealth(env), budgetStatus(env.DB), listSourceHealth(env.DB), judgmentOverview(env)]);
      const payload = { memory, budget, sources, judgment: { summary: judgment.summary, calibration: judgment.calibration, topSourceScorecards: (judgment.sourceScorecards as unknown[]).slice(0, 8) } };
      return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    "list_intelligence_packs",
    {
      title: "List installed Intelligence Packs",
      description: "See installed Packs and what each adds: sources, Missions, starter memory, source standards, and research methods.",
      inputSchema: {},
      annotations: readOnlyAnnotations(),
    },
    async (): ToolResultPromise => {
      const packs = (await listIntelligencePacks(env.DB)).map((pack) => ({
        id: pack.id,
        name: pack.name,
        version: pack.version,
        description: pack.description,
        category: pack.category,
        enabled: pack.enabled === 1,
        manifest: parseJson(pack.manifest_json, {}),
      }));
      return { structuredContent: { packs }, content: [{ type: "text", text: JSON.stringify({ packs }, null, 2) }] };
    },
  );

  return server;
}
