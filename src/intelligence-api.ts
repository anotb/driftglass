import {
  getIntelligencePack,
  getMemoryProposal,
  listIntelligencePacks,
  listMemoryProposals,
} from "./db";
import { budgetStatus, setBudgetProfile, setExecutionCapacity, type BudgetLimits } from "./budget";
import { refreshEpistemicMemory } from "./epistemic-memory";
import { driftglassPluginDownloadResponse } from "./driftglass-plugin-api";
import { intelligenceOverview } from "./intelligence";
import {
  checkIntelligencePackUpdates,
  fetchIntelligencePack,
  installIntelligencePack,
  intelligencePackSkillZip,
  parseIntelligencePack,
  previewIntelligencePack,
  updateInstalledIntelligencePack,
} from "./intelligence-packs";
import {
  approveMemoryProposal,
  memoryGraphAudit,
  memoryGraphHealth,
  memoryNeighborhood,
  memoryPatchContract,
  memoryTimeline,
  rejectMemoryProposal,
  stageMemoryProposal,
} from "./memory-graph";
import {
  buildReasoningBundle,
  reasoningBundleMarkdown,
  reasoningInterfaceKitZip,
  reasoningSkillZip,
} from "./reasoning";
import { assertPublicHttpUrl, baseUrlFor, deriveMcpCapabilityKeys } from "./security";
import type { BudgetProfileName, Env, ReasoningSourceScope, ReasoningTarget, ReasoningTask } from "./types";
import { HttpError, json, parseJson, readBoundedResponseJson, readBoundedResponseText, readJson } from "./utils";
import { handleV09Api } from "./v09-api";

function zipResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9_.-]+/gi, "-")}"`,
      "cache-control": "no-store",
    },
  });
}

function bundleInput(body: Record<string, unknown>, request: Request) {
  const target = ["chatgpt", "claude", "grok", "generic"].includes(String(body.target))
    ? String(body.target) as ReasoningTarget
    : "chatgpt";
  const task = ["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"].includes(String(body.task))
    ? String(body.task) as ReasoningTask
    : "investigate";
  const scopeKind = ["global", "mission", "story"].includes(String(body.scopeKind))
    ? String(body.scopeKind) as "global" | "mission" | "story"
    : undefined;
  const sourceScope = ["open", "personal", "share"].includes(String(body.sourceScope))
    ? String(body.sourceScope) as ReasoningSourceScope
    : "personal";
  return {
    target,
    task,
    scopeKind,
    scopeId: typeof body.scopeId === "string" ? body.scopeId.slice(0, 120) : undefined,
    objective: typeof body.objective === "string" ? body.objective.slice(0, 2_000) : undefined,
    tokenBudget: Number.isFinite(Number(body.tokenBudget)) ? Number(body.tokenBudget) : undefined,
    sourceScope,
    request,
  };
}

function normalizedPackRecord(row: Awaited<ReturnType<typeof getIntelligencePack>> extends infer T ? Exclude<T, null> : never) {
  return { ...row, manifest: parseJson(row.manifest_json, {}), manifest_json: undefined };
}

async function packFromOwnerUrl(
  request: Request,
  env: Env,
  rawUrl: string,
): Promise<{ pack: ReturnType<typeof parseIntelligencePack>; sourceUrl: string | null }> {
  const target = assertPublicHttpUrl(rawUrl);
  const incoming = new URL(request.url);
  if (
    target.origin === incoming.origin &&
    /^\/intelligence-packs\/[a-z0-9][a-z0-9._-]*\.json$/i.test(target.pathname)
  ) {
    // A Worker subrequest to its own workers.dev hostname is loop-protected and
    // can return 404. Read trusted built-in Pack assets through the binding.
    const response = await env.ASSETS.fetch(new Request(target, { headers: { accept: "application/json" } }));
    if (!response.ok) throw new Error(`Built-in Intelligence Pack returned HTTP ${response.status}`);
    const text = await readBoundedResponseText(response, 1_500_000, "Intelligence Pack exceeds 1.5 MB");
    return { pack: parseIntelligencePack(JSON.parse(text)), sourceUrl: null };
  }
  return { pack: await fetchIntelligencePack(target.toString()), sourceUrl: target.toString() };
}

export async function handleIntelligenceApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const v09 = await handleV09Api(request, env, _ctx);
  if (v09) return v09;

  if (path === "/api/intelligence/overview" && request.method === "GET") {
    return json({ ok: true, ...(await intelligenceOverview(env, request)) });
  }

  if (path === "/api/memory/health" && request.method === "GET") {
    const health = await memoryGraphHealth(env);
    return json({ ok: true, health, memory: health });
  }
  if (path === "/api/memory/audit" && request.method === "GET") {
    return json({ ok: true, audit: await memoryGraphAudit(env) });
  }
  if (path === "/api/memory/refresh" && request.method === "POST") {
    const body: { force?: boolean; maxStories?: number } = await readJson<{ force?: boolean; maxStories?: number }>(request).catch(() => ({} as { force?: boolean; maxStories?: number }));
    const result = await refreshEpistemicMemory(env, { force: Boolean(body.force), maxStories: body.maxStories });
    return json({ ok: true, result }, { status: result.status === "queued" || result.status === "running" ? 202 : 200 });
  }
  if (["/api/memory", "/api/memory/search", "/api/memory/neighborhood"].includes(path) && request.method === "GET") {
    const query = (url.searchParams.get("q") || "").slice(0, 500);
    const ref = (url.searchParams.get("ref") || "").slice(0, 200);
    const limit = Math.max(1, Math.min(150, Number(url.searchParams.get("limit") || 60)));
    const [graph, timeline] = await Promise.all([
      memoryNeighborhood(env, { query: query || undefined, ref: ref || undefined, limit }),
      memoryTimeline(env, { query: query || undefined, ref: ref || undefined, limit: Math.min(60, limit) }),
    ]);
    return path === "/api/memory"
      ? json({ ok: true, ...graph, timeline })
      : json({ ok: true, graph, timeline, ...graph });
  }
  if (path === "/api/memory/timeline" && request.method === "GET") {
    const query = (url.searchParams.get("q") || "").slice(0, 500);
    const ref = (url.searchParams.get("ref") || "").slice(0, 200);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    return json({ ok: true, timeline: await memoryTimeline(env, { query: query || undefined, ref: ref || undefined, limit }) });
  }
  if (path === "/api/memory/contract" && request.method === "GET") {
    return json({ ok: true, contract: memoryPatchContract() });
  }
  if (path === "/api/memory/proposals" && request.method === "GET") {
    const status = url.searchParams.get("status");
    return json({
      ok: true,
      proposals: await listMemoryProposals(env.DB, {
        status: ["pending", "approved", "rejected", "expired"].includes(String(status))
          ? status as "pending" | "approved" | "rejected" | "expired"
          : undefined,
        scopeKind: url.searchParams.get("scopeKind") || undefined,
        scopeId: url.searchParams.get("scopeId") || undefined,
        limit: Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50))),
      }),
    });
  }
  if (path === "/api/memory/proposals" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request, 1_500_000);
    const staged = await stageMemoryProposal(env, {
      scopeKind: typeof body.scopeKind === "string" ? body.scopeKind : "global",
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      provider: typeof body.provider === "string" ? body.provider : "dashboard",
      patch: body.patch ?? body,
    });
    return json({ ok: true, ...staged }, { status: 201 });
  }
  const proposalDecision = path.match(/^\/api\/memory\/proposals\/([^/]+)\/(approve|reject)$/);
  if (proposalDecision && request.method === "POST") {
    const id = decodeURIComponent(proposalDecision[1] ?? "");
    const body = await readJson<{ note?: string }>(request).catch(() => ({} as { note?: string }));
    const proposal = await getMemoryProposal(env.DB, id);
    if (!proposal) throw new HttpError(404, "Memory proposal not found");
    if (proposalDecision[2] === "reject") {
      await rejectMemoryProposal(env, id, body.note);
      return json({ ok: true, id, status: "rejected" });
    }
    return json({ ok: true, id, status: "approved", result: await approveMemoryProposal(env, id, body.note) });
  }

  if (path === "/api/budget" && request.method === "GET") {
    return json({ ok: true, budget: await budgetStatus(env.DB) });
  }
  if (path === "/api/budget" && request.method === "PUT") {
    const body = await readJson<{ profile?: BudgetProfileName; custom?: Partial<BudgetLimits> }>(request);
    const profile: BudgetProfileName = body.profile === "cheap" || body.profile === "custom" ? body.profile : "free";
    await setBudgetProfile(env.DB, profile, body.custom);
    return json({ ok: true, budget: await budgetStatus(env.DB) });
  }
  if (path === "/api/budget/execution-capacity" && request.method === "PUT") {
    const body = await readJson<{ confirmedWorkersPaid?: unknown }>(request);
    if (typeof body.confirmedWorkersPaid !== "boolean") {
      throw new HttpError(400, "confirmedWorkersPaid must be true or false");
    }
    await setExecutionCapacity(
      env.DB,
      body.confirmedWorkersPaid ? "expanded-confirmed" : "free-safe",
    );
    return json({ ok: true, budget: await budgetStatus(env.DB) });
  }

  if (path === "/api/reasoning/providers" && request.method === "GET") {
    const base = baseUrlFor(request, env.PUBLIC_BASE_URL);
    const { readKey, operationsKey } = await deriveMcpCapabilityKeys(env.DRIFTGLASS_SECRET);
    const mcpUrl = `${base}/mcp/${readKey}`;
    const operationsMcpUrl = `${base}/mcp/${operationsKey}/ops`;
    return json({
      ok: true,
      mcpUrl,
      operationsMcpUrl,
      defaultProfile: "reasoning",
      providers: {
        chatgpt: {
          interface: "Your Missions, scheduled checks, and broader research",
          modelBilling: "ChatGPT subscription",
          mcpUrl: `${base}/mcp`,
          operationsMcpUrl,
          guidance: "Today and Mission briefs start with open sources. Ask ChatGPT to use your personal sources when you want connected Reddit, X, email, or subscriptions included; use Allow updates only to save suggestions for review.",
        },
        claude: {
          interface: "Private connection + Claude Code + downloadable model instructions",
          modelBilling: "Claude subscription or Claude Code",
          mcpUrl,
          operationsMcpUrl,
          command: `claude mcp add --transport http driftglass ${mcpUrl}`,
          operationsCommand: `claude mcp add --transport http driftglass-ops ${operationsMcpUrl}`,
          guidance: "Connect Driftglass for evidence and memory. Use Allow updates when you want Claude to save Mission, Pack, or memory suggestions for review.",
        },
        grok: {
          interface: "Private connection + downloadable model instructions",
          modelBilling: "Grok subscription",
          mcpUrl,
          operationsMcpUrl,
          guidance: "Connect Driftglass for evidence and memory. Use Allow updates if your Grok client supports actions and you want suggestions saved for review.",
        },
        generic: {
          interface: "Private connection or a focused evidence brief",
          modelBilling: "chosen by the user",
          mcpUrl,
          operationsMcpUrl,
          guidance: "Connect Driftglass for normal reasoning. Use Allow updates only when you want the model to save suggestions for review.",
        },
      },
    });
  }
  if (path === "/api/reasoning/chatgpt-plugin.zip" && request.method === "POST") {
    return driftglassPluginDownloadResponse(request, env.DRIFTGLASS_SECRET);
  }
  if (["/api/reasoning/compile", "/api/reasoning/context", "/api/reasoning/bundle"].includes(path) && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const bundle = await buildReasoningBundle(env, bundleInput(body, request));
    return json({ ok: true, bundle, markdown: reasoningBundleMarkdown(bundle) });
  }
  if (path === "/api/reasoning/skill.zip" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const bundle = await buildReasoningBundle(env, bundleInput(body, request));
    return zipResponse(reasoningSkillZip(bundle), `driftglass-${bundle.task}-skill.zip`);
  }
  if (path === "/api/reasoning/interface-kit.zip" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const bundle = await buildReasoningBundle(env, bundleInput(body, request), {
      includeOperationsCapability: body.includeOperations === true,
    });
    return zipResponse(reasoningInterfaceKitZip(bundle), `driftglass-${bundle.task}-interface-kit.zip`);
  }

  if (path === "/api/intelligence-packs/catalog" && request.method === "GET") {
    const response = await env.ASSETS.fetch(new Request(new URL("/intelligence-packs/catalog.json", request.url)));
    if (!response.ok) throw new HttpError(500, "Intelligence Pack catalog is unavailable");
    const payload = await readBoundedResponseJson<Record<string, unknown>>(
      response,
      1_000_000,
      "Intelligence Pack catalog exceeds 1 MB",
    );
    return json({ ok: true, ...(payload as Record<string, unknown>) });
  }
  if (path === "/api/intelligence-packs/schema" && request.method === "GET") {
    const response = await env.ASSETS.fetch(new Request(new URL("/intelligence-packs/schema.json", request.url)));
    if (!response.ok) throw new HttpError(500, "Intelligence Pack schema is unavailable");
    return new Response(response.body, {
      headers: {
        "content-type": "application/schema+json; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (path === "/api/intelligence-packs/updates" && request.method === "GET") {
    return json({ ok: true, updates: await checkIntelligencePackUpdates(env, Number(url.searchParams.get("limit") || 20)) });
  }
  const updatePackMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/update$/);
  if (updatePackMatch && request.method === "POST") {
    const body: { allowOverBudget?: boolean; includeCompanionSources?: boolean } = await readJson<{ allowOverBudget?: boolean; includeCompanionSources?: boolean }>(request).catch(() => ({}));
    const result = await updateInstalledIntelligencePack(env, decodeURIComponent(updatePackMatch[1] ?? ""), {
      allowOverBudget: body.allowOverBudget === true,
      includeCompanionSources: body.includeCompanionSources === true,
    });
    return json({ ok: true, ...result });
  }
  if (["/api/intelligence-packs", "/api/intelligence-packs/installed"].includes(path) && request.method === "GET") {
    const packs = await listIntelligencePacks(env.DB);
    return json({ ok: true, packs: packs.map((pack) => normalizedPackRecord(pack)) });
  }
  if (["/api/intelligence-packs/preview", "/api/intelligence-packs/preview-url"].includes(path) && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request, 2_000_000);
    const fetched = typeof body.url === "string" ? await packFromOwnerUrl(request, env, body.url) : null;
    const pack = fetched?.pack ?? parseIntelligencePack(body.pack ?? body);
    const profile = body.profile === "cheap" || body.profile === "custom" || body.profile === "free"
      ? body.profile as BudgetProfileName
      : undefined;
    return json({
      ok: true,
      pack,
      sourceUrl: fetched?.sourceUrl ?? undefined,
      preview: await previewIntelligencePack(env, pack, profile),
    });
  }
  if (["/api/intelligence-packs/install", "/api/intelligence-packs/import"].includes(path) && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request, 2_000_000);
    const pack = parseIntelligencePack(body.pack ?? body);
    const result = await installIntelligencePack(env, pack, null, {
      allowOverBudget: body.allowOverBudget === true,
      includeCompanionSources: body.includeCompanionSources === true,
    });
    return json({ ok: true, pack, ...result }, { status: 201 });
  }
  if (path === "/api/intelligence-packs/install-url" && request.method === "POST") {
    const body = await readJson<{ url?: string; allowOverBudget?: boolean; includeCompanionSources?: boolean }>(request);
    if (!body.url) throw new HttpError(400, "Intelligence Pack URL is required");
    const fetched = await packFromOwnerUrl(request, env, body.url);
    const result = await installIntelligencePack(env, fetched.pack, fetched.sourceUrl, {
      allowOverBudget: body.allowOverBudget === true,
      includeCompanionSources: body.includeCompanionSources === true,
    });
    return json({ ok: true, pack: fetched.pack, ...result }, { status: 201 });
  }
  const packSkillMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/skill\.zip$/);
  if (packSkillMatch && request.method === "GET") {
    const row = await getIntelligencePack(env.DB, decodeURIComponent(packSkillMatch[1] ?? ""));
    if (!row) throw new HttpError(404, "Intelligence Pack not found");
    const pack = parseIntelligencePack(parseJson(row.manifest_json, {}));
    return zipResponse(intelligencePackSkillZip(pack), `driftglass-${pack.id}-${pack.version}-skill.zip`);
  }
  if (path === "/api/intelligence-packs/skill.zip" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request, 2_000_000);
    const pack = parseIntelligencePack(body.pack ?? body);
    return zipResponse(intelligencePackSkillZip(pack), `driftglass-${pack.id}-skill.zip`);
  }

  const packExportMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)\/export$/);
  if (packExportMatch && request.method === "GET") {
    const row = await getIntelligencePack(env.DB, decodeURIComponent(packExportMatch[1] ?? ""));
    if (!row) throw new HttpError(404, "Intelligence Pack not found");
    const pack = parseIntelligencePack(parseJson(row.manifest_json, {}));
    return new Response(`${JSON.stringify(pack, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${pack.id}-${pack.version}.intelligence-pack.json"`,
        "cache-control": "no-store",
      },
    });
  }
  const installedPackMatch = path.match(/^\/api\/intelligence-packs\/([^/]+)$/);
  if (installedPackMatch && request.method === "GET") {
    const pack = await getIntelligencePack(env.DB, decodeURIComponent(installedPackMatch[1] ?? ""));
    if (!pack) throw new HttpError(404, "Intelligence Pack not found");
    return json({ ok: true, pack: normalizedPackRecord(pack) });
  }

  return null;
}
