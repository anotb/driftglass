const modelContext = document.modelContext || navigator.modelContext;

function api() {
  const client = window.DriftglassApi;
  if (!client?.isUnlocked?.()) throw new Error("Unlock Driftglass in this tab before using its WebMCP tools.");
  return client;
}

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function register(tool) {
  if (!modelContext?.registerTool) return;
  await modelContext.registerTool(tool);
}

const tools = [
  {
    name: "driftglass_search_stories",
    description: "Search Driftglass story memory. Use this to find prior developments, evidence clusters, tracked topics, or stories related to a question.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms or a natural-language topic." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ query, limit = 12 }) => textResult(await api().request(`/api/stories?q=${encodeURIComponent(query)}&limit=${Math.min(50, Math.max(1, limit))}`)),
  },
  {
    name: "driftglass_semantic_search",
    description: "Search Cloudflare AI Search semantic memory across Driftglass Stories, Missions, approved research state, and briefings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Conceptual or natural-language query." },
        kind: { type: "string", enum: ["story", "mission", "briefing"] },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ query, kind, limit = 12 }) => textResult(await api().request("/api/ai-search/search", {
      method: "POST",
      body: JSON.stringify({ query, kind, limit }),
    })),
  },
  {
    name: "driftglass_sync_semantic_memory",
    description: "Refresh the Cloudflare AI Search index from current Driftglass Story and Mission memory.",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    execute: async ({ force = false }) => textResult(await api().request("/api/ai-search/sync", {
      method: "POST",
      body: JSON.stringify({ force, wait: true }),
    })),
  },
  {
    name: "driftglass_get_story",
    description: "Retrieve one Driftglass story with its supporting evidence and source links.",
    inputSchema: {
      type: "object",
      properties: { storyId: { type: "string", description: "The Driftglass story ID." } },
      required: ["storyId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ storyId }) => textResult(await api().request(`/api/stories/${encodeURIComponent(storyId)}`)),
  },
  {
    name: "driftglass_get_story_graph",
    description: "Get connected developments around a Driftglass Story, including shared Missions, shared sources, topic overlap, and temporal adjacency.",
    inputSchema: {
      type: "object",
      properties: {
        storyId: { type: "string", description: "The Driftglass Story ID." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["storyId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ storyId, limit = 10 }) => textResult(await api().request(`/api/stories/${encodeURIComponent(storyId)}/graph?limit=${limit}`)),
  },
  {
    name: "driftglass_explain_ranking",
    description: "Explain why a Driftglass Story ranked, including score components, learned Taste Profile matches, feedback adjustments, and Mission matches.",
    inputSchema: {
      type: "object",
      properties: { storyId: { type: "string", description: "The Driftglass Story ID." } },
      required: ["storyId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ storyId }) => textResult(await api().request(`/api/stories/${encodeURIComponent(storyId)}/explain`)),
  },
  {
    name: "driftglass_get_taste_profile",
    description: "Inspect the explicit-interest profile Driftglass has learned from feedback, including positive and negative terms and source preferences.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/taste")),
  },
  {
    name: "driftglass_list_research_missions",
    description: "List persistent Research Missions and the newest stories matched to each question.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/missions")),
  },
  {
    name: "driftglass_prepare_deep_research",
    description: "Prepare a Driftglass Research Mission for a one-off ChatGPT Deep Research investigation, including current state, linked sources, coverage gaps, escalation recommendation, and a ready-to-use research prompt.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string", description: "The Driftglass Mission ID." } },
      required: ["missionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async ({ missionId }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/deep-research`)),
  },
  {
    name: "driftglass_record_mission_update",
    description: "Add a verified signal, expected event, outcome, escalation, or note to a Driftglass Mission's history.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: { type: "string" },
        eventType: { type: "string", enum: ["note", "signal", "expected-event", "outcome", "escalation"] },
        title: { type: "string" },
        detail: { type: "string" },
        storyId: { type: "string" },
      },
      required: ["missionId", "eventType", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ missionId, eventType, title, detail, storyId }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType, title, detail, storyId }),
    })),
  },
  {
    name: "driftglass_run_mission_sprint",
    description: "Start a durable Cloudflare Workflow that fans a Research Mission across its scoped sources, retries collection steps, waits for ingestion, and rebuilds matching Stories.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: { type: "string", description: "The Driftglass Mission ID." },
        sourceIds: { type: "array", items: { type: "string" }, description: "Optional source IDs to restrict this sprint." },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    execute: async ({ missionId, sourceIds }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/sprint`, {
      method: "POST",
      body: JSON.stringify({ sourceIds }),
    })),
  },
  {
    name: "driftglass_list_mission_sprints",
    description: "List recent durable Mission Sprint runs and their result summaries.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ missionId, limit = 20 }) => textResult(await api().request(`/api/mission-runs?limit=${limit}${missionId ? `&missionId=${encodeURIComponent(missionId)}` : ""}`)),
  },
  {
    name: "driftglass_get_action_center",
    description: "Get the small set of items Driftglass believes need attention: overdue expected events, due Mission Sprints, staged research results, and degraded sources.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/action-center")),
  },
  {
    name: "driftglass_get_mission_autopilot",
    description: "Inspect scheduled Mission evidence refreshes, next Sprint times, active runs, and expected-event status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/autopilot")),
  },
  {
    name: "driftglass_list_pending_research_results",
    description: "List structured Deep Research results waiting for confirmation before Mission memory is updated.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/research-results")),
  },
  {
    name: "driftglass_stage_research_result",
    description: "Stage a structured Deep Research result for review. This creates a diff and does not change Mission memory yet.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: { type: "string" },
        result: {
          type: "object",
          properties: {
            currentThesis: { type: "string" }, reportSummary: { type: "string" },
            openQuestions: { type: "array", items: { type: "string" } },
            reportTitle: { type: "string" }, reportUrl: { type: "string", format: "uri" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            nextExpectedEvent: { type: "string" }, nextExpectedBy: { type: "string" },
            outcomeStatus: { type: "string", enum: ["open", "resolved", "invalidated", "superseded"] },
            outcomeSummary: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["missionId", "result"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ missionId, result }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/research-results/preview`, {
      method: "POST", body: JSON.stringify({ result, source: "dashboard-webmcp" }),
    })),
  },
  {
    name: "driftglass_decide_research_result",
    description: "Confirm or reject a staged research result after review. Confirmation updates the Mission's standing answer and history.",
    inputSchema: {
      type: "object",
      properties: { importId: { type: "string" }, decision: { type: "string", enum: ["confirm", "reject"] } },
      required: ["importId", "decision"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ importId, decision }) => textResult(await api().request(`/api/research-results/${encodeURIComponent(importId)}/${decision}`, { method: "POST", body: "{}" })),
  },
  {
    name: "driftglass_open_mission_computer",
    description: "Read the current durable Cloudflare Computer inventory for a Research Mission without synchronizing or changing it.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: { type: "string" },
      },
      required: ["missionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ missionId }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/computer`)),
  },
  {
    name: "driftglass_sync_mission_computer",
    description: "Explicitly synchronize a Research Mission's durable Cloudflare Computer from current Mission state and evidence.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string" } },
      required: ["missionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    execute: async ({ missionId }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/computer/sync`, {
      method: "POST", body: "{}",
    })),
  },
  {
    name: "driftglass_read_mission_file",
    description: "Read one durable text file from a Mission Computer.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string" }, path: { type: "string" } },
      required: ["missionId", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ missionId, path }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/computer/file?path=${encodeURIComponent(path)}`)),
  },
  {
    name: "driftglass_search_mission_computer",
    description: "Search every durable file in a Mission Computer without invoking another model or search service.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string" }, query: { type: "string" } },
      required: ["missionId", "query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ missionId, query }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/computer/search?q=${encodeURIComponent(query)}`)),
  },
  {
    name: "driftglass_write_mission_note",
    description: "Save a durable working note into the user-owned Mission Computer.",
    inputSchema: {
      type: "object",
      properties: { missionId: { type: "string" }, content: { type: "string" }, title: { type: "string" }, file: { type: "string" } },
      required: ["missionId", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ missionId, content, title, file }) => textResult(await api().request(`/api/missions/${encodeURIComponent(missionId)}/computer/notes`, { method: "POST", body: JSON.stringify({ content, title, file }) })),
  },
  {
    name: "driftglass_open_deep_dive",
    description: "Create or refresh a powered Cloudflare Computer case workspace from one Driftglass story or Research Mission.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["story", "mission"] },
        id: { type: "string", description: "The Driftglass story or Mission ID." },
      },
      required: ["type", "id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    execute: async ({ type, id }) => textResult(await api().request(`/api/${type === "mission" ? "missions" : "stories"}/${encodeURIComponent(id)}/deep-dive`, {
      method: "POST",
      body: "{}",
    })),
  },

  {
    name: "driftglass_recall_memory",
    description: "Recall the bounded Driftglass Memory Graph around a topic, Story, Mission, entity, decision, finding, or source. Returns durable nodes, provenance-aware relations, and the relevant timeline.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language topic or memory label." },
        ref: { type: "string", description: "Optional exact node, Story, Mission, or source reference." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ query, ref, limit = 50 }) => {
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
      if (query) params.set("q", query);
      if (ref) params.set("ref", ref);
      return textResult(await api().request(`/api/memory?${params}`));
    },
  },
  {
    name: "driftglass_get_memory_health",
    description: "Check whether connected memory is current, supported by a clear source trail, and ready for use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/memory/health")),
  },
  {
    name: "driftglass_audit_memory",
    description: "Check connected memory for contradictions, overdue expectations, unsupported items, broken source trails, and unfinished replacements.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/memory/audit")),
  },
  {
    name: "driftglass_stage_memory_patch",
    description: "Stage a model-proposed durable-memory patch for explicit review. This does not change approved memory.",
    inputSchema: {
      type: "object",
      properties: {
        scopeKind: { type: "string", enum: ["global", "mission", "story"] },
        scopeId: { type: "string" },
        provider: { type: "string" },
        patch: { type: "object", description: "Patch matching the Driftglass memory contract." },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ scopeKind = "global", scopeId, provider = "dashboard-webmcp", patch }) => textResult(await api().request("/api/memory/proposals", {
      method: "POST", body: JSON.stringify({ scopeKind, scopeId, provider, patch }),
    })),
  },
  {
    name: "driftglass_list_memory_proposals",
    description: "List pending or decided durable-memory proposals awaiting owner review.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "expired"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async ({ status, limit = 30 }) => {
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
      if (status) params.set("status", status);
      return textResult(await api().request(`/api/memory/proposals?${params}`));
    },
  },
  {
    name: "driftglass_decide_memory_proposal",
    description: "Approve or reject a staged durable-memory proposal after explicit review.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        note: { type: "string" },
      },
      required: ["proposalId", "decision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ proposalId, decision, note }) => textResult(await api().request(`/api/memory/proposals/${encodeURIComponent(proposalId)}/${decision}`, {
      method: "POST", body: JSON.stringify({ note }),
    })),
  },
  {
    name: "driftglass_list_intelligence_packs",
    description: "List installed and available Intelligence Packs: portable domain modules with cloud-first sources, optional Companion sources, Missions, playbooks, memory seeds, and budget projections.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult({
      installed: await api().request("/api/intelligence-packs/installed"),
      catalog: await api().request("/api/intelligence-packs/catalog"),
    }),
  },
  {
    name: "driftglass_preview_intelligence_pack",
    description: "Preview an Intelligence Pack and its projected Free or Cheap Cloudflare footprint before installation.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        pack: { type: "object" },
        profile: { type: "string", enum: ["free", "cheap"], default: "free" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async ({ url, pack, profile = "free" }) => textResult(await api().request("/api/intelligence-packs/preview", {
      method: "POST", body: JSON.stringify({ url, pack, profile }),
    })),
  },
  {
    name: "driftglass_install_intelligence_pack",
    description: "Install a reviewed Intelligence Pack. Cloud-first sources work without a local Companion; optional signed-in sources can remain dormant until a Companion is paired.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        pack: { type: "object" },
        includeCompanionSources: { type: "boolean", default: false },
        allowOverBudget: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    execute: async ({ url, pack, includeCompanionSources = false, allowOverBudget = false }) => textResult(await api().request(url ? "/api/intelligence-packs/install-url" : "/api/intelligence-packs/install", {
      method: "POST", body: JSON.stringify({ url, pack, includeCompanionSources, allowOverBudget }),
    })),
  },
  {
    name: "driftglass_check_intelligence_pack_updates",
    description: "Check a bounded number of installed Intelligence Packs for explicit version updates. This runs only on demand.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20, default: 20 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    execute: async ({ limit = 20 }) => textResult(await api().request(`/api/intelligence-packs/updates?limit=${Math.min(20, Math.max(1, limit))}`)),
  },
  {
    name: "driftglass_update_intelligence_pack",
    description: "Update one installed Intelligence Pack after reviewing its newer manifest and budget projection.",
    inputSchema: {
      type: "object",
      properties: {
        packId: { type: "string" },
        includeCompanionSources: { type: "boolean", default: false },
        allowOverBudget: { type: "boolean", default: false },
      },
      required: ["packId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    execute: async ({ packId, includeCompanionSources = false, allowOverBudget = false }) => textResult(await api().request(`/api/intelligence-packs/${encodeURIComponent(packId)}/update`, {
      method: "POST",
      body: JSON.stringify({ includeCompanionSources, allowOverBudget }),
    })),
  },
  {
    name: "driftglass_get_budget_status",
    description: "Inspect the active Free or Cheap Cloudflare budget profile and current bounded-usage lanes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/budget")),
  },
  {
    name: "driftglass_create_mission",
    description: "Create a persistent Driftglass Research Mission from a question and explicit matching terms.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for the Mission." },
        question: { type: "string", description: "The standing research question." },
        terms: { type: "array", items: { type: "string" }, description: "Terms that identify relevant stories." },
        priority: { type: "number", minimum: 0.1, maximum: 5, default: 1.5 },
        mode: { type: "string", enum: ["watch", "decision", "hypothesis", "event"], default: "watch" },
        researchPolicy: { type: "string", enum: ["manual", "suggest", "always"], default: "suggest" },
        expectedNextEvent: { type: "string", description: "The next observable event that would materially update the Mission." }
      },
      required: ["name", "question", "terms"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ name, question, terms, priority = 1.5, mode = "watch", researchPolicy = "suggest", expectedNextEvent }) => textResult(await api().request("/api/missions", {
      method: "POST",
      body: JSON.stringify({ name, question, terms, priority, mode, researchPolicy, expectedNextEvent, status: "active" })
    }))
  },
  {
    name: "driftglass_install_lens",
    description: "Install a portable Driftglass Lens from a public JSON URL. Lenses add sources, Missions, schedules, and interests.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri", description: "Raw public URL of a Driftglass Lens JSON file." } },
      required: ["url"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    execute: async ({ url }) => textResult(await api().request("/api/lenses/install-url", {
      method: "POST",
      body: JSON.stringify({ url })
    }))
  },
  {
    name: "driftglass_collect_now",
    description: "Run every due Driftglass source now and return the scheduled source IDs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    execute: async () => textResult(await api().request("/api/sources/run-due", { method: "POST", body: "{}" }))
  },
  {
    name: "driftglass_publish_intelligence_card",
    description: "Publish an expiring public page with the answer and sources for a Story, Research Mission, or the latest briefing.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["story", "mission", "briefing"] },
        id: { type: "string", description: "Required for Story and Mission cards." },
        expiresDays: { type: "integer", minimum: 1, maximum: 90, default: 14 },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    execute: async ({ kind, id, expiresDays = 14 }) => textResult(await api().request("/api/shares", {
      method: "POST",
      body: JSON.stringify({ kind, id, expiresDays }),
    })),
  },
  {
    name: "driftglass_record_feedback",
    description: "Calibrate Driftglass by recording feedback on a story.",
    inputSchema: {
      type: "object",
      properties: {
        storyId: { type: "string" },
        action: { enum: ["more", "less", "track", "mute", "already-knew", "bad-source", "wrong"] },
        note: { type: "string" }
      },
      required: ["storyId", "action"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async ({ storyId, action, note }) => textResult(await api().request("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ storyId, action, note })
    }))
  },
  {
    name: "driftglass_capture_url",
    description: "Capture a public URL into Driftglass for normalization, story matching, and future briefing consideration.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri", description: "Public URL to capture." },
        title: { type: "string", description: "Optional title override." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    execute: async ({ url, title }) => textResult(await api().request("/api/manual", {
      method: "POST",
      body: JSON.stringify({ url, title }),
    })),
  },
  {
    name: "driftglass_next_reasoning_task",
    description: "Return the highest-priority finite reasoning job, including the exact objective and status. This does not call a model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/reasoning/tasks/next")),
  },
  {
    name: "driftglass_prepare_reasoning_receipt",
    description: "Save one exact evidence snapshot for a model. Personal sources are included by default; choose open for open-source evidence or share for a public-safe answer snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["chatgpt", "claude", "grok", "generic"] },
        task: { type: "string", enum: ["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"] },
        scopeKind: { type: "string", enum: ["global", "mission", "story"] },
        scopeId: { type: "string" },
        objective: { type: "string" },
        sourceScope: { type: "string", enum: ["open", "personal", "share"], default: "personal" },
        tokenBudget: { type: "integer", minimum: 2000, maximum: 50000, default: 24000 }
      },
      required: ["target", "task", "scopeKind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async (input) => textResult(await api().request("/api/reasoning/receipts", { method: "POST", body: JSON.stringify(input) })),
  },
  {
    name: "driftglass_create_memory_checkpoint",
    description: "Save the current state of connected memory for a later before-and-after comparison.",
    inputSchema: {
      type: "object",
      properties: {
        scopeKind: { type: "string", enum: ["global", "mission", "story", "pack"] },
        scopeId: { type: "string" },
        title: { type: "string" },
        reason: { type: "string" },
        force: { type: "boolean", default: false }
      },
      required: ["scopeKind"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    execute: async (input) => textResult(await api().request("/api/memory/checkpoints", { method: "POST", body: JSON.stringify(input) })),
  },
  {
    name: "driftglass_get_judgment_queue",
    description: "See what needs attention next: prepared model work, decisions due for review, scheduled research, source concerns, and Pack update conflicts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    execute: async () => textResult(await api().request("/api/judgment")),
  },
  {
    name: "driftglass_record_decision",
    description: "Record a durable decision, forecast, commitment, or thesis so Driftglass can review the outcome later.",
    inputSchema: {
      type: "object",
      properties: {
        decisionType: { type: "string", enum: ["decision", "forecast", "commitment", "thesis"] },
        title: { type: "string" },
        statement: { type: "string" },
        rationale: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        expectedOutcome: { type: "string" },
        reviewAt: { type: "string", format: "date-time" },
        missionId: { type: "string" },
        storyId: { type: "string" }
      },
      required: ["title", "statement"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    execute: async (input) => textResult(await api().request("/api/decisions", { method: "POST", body: JSON.stringify(input) })),
  },
  {
    name: "driftglass_run_intelligence_routine",
    description: "Run one scheduled research method. It may refresh evidence, update a Mission, check memory, refresh its workspace, and prepare an evidence snapshot without choosing or calling a model.",
    inputSchema: {
      type: "object",
      properties: { routineId: { type: "string" } },
      required: ["routineId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    execute: async ({ routineId }) => textResult(await api().request(`/api/routines/${encodeURIComponent(routineId)}/run`, { method: "POST", body: "{}" })),
  },

];

if (modelContext?.registerTool) {
  Promise.all(tools.map(register)).then(() => {
    document.documentElement.dataset.webmcp = "ready";
  }).catch((error) => {
    console.debug("Driftglass WebMCP registration failed", error);
  });
}
