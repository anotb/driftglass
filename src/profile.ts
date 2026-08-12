import {
  createMemoryProposal,
  getMemoryProposal,
  getMissionOperator,
  getMissionResearchState,
  getSetting,
  importMissionEvent,
  listIntelligencePacks,
  listMemoryProposals,
  listMissionEvents,
  listMissions,
  listReasoningPlaybooks,
  listSavedViews,
  listSources,
  listTasteSources,
  listTasteTerms,
  restoreTasteSource,
  restoreTasteTerm,
  setSetting,
  upsertMission,
  upsertMissionOperator,
  upsertMissionResearchState,
  upsertReasoningPlaybook,
  upsertSavedView,
  upsertSource,
} from "./db";
import { getBudgetProfile, setBudgetProfile, type BudgetLimits } from "./budget";
import { installIntelligencePack, parseIntelligencePack } from "./intelligence-packs";
import { approveMemoryProposal } from "./memory-graph";
import type {
  BudgetProfileName,
  Env,
  MissionEventRecord,
  ReasoningPlaybookRecord,
  SourceKind,
  TasteSourceRecord,
  TasteTermRecord,
} from "./types";
import { normalizeStringArray, parseJson } from "./utils";

interface PortableApprovedMemoryPatch {
  id: string;
  scopeKind: "global" | "mission" | "story" | "pack";
  scopeId?: string | null;
  provider: string;
  title: string;
  patch: Record<string, unknown>;
  decisionNote?: string | null;
}

interface PortablePlaybook {
  id: string;
  name: string;
  task: ReasoningPlaybookRecord["task"];
  instructions: string;
  trigger: Record<string, unknown>;
  providerHints: Record<string, string>;
  enabled: boolean;
}

export interface DriftglassProfile {
  schemaVersion: 3;
  product: "Driftglass";
  exportedAt: string;
  sources: Array<Record<string, unknown>>;
  missions: Array<Record<string, unknown>>;
  interestTerms: string[];
  taste: { terms: TasteTermRecord[]; sources: TasteSourceRecord[] };
  savedViews: Array<Record<string, unknown>>;
  intelligencePacks: Array<Record<string, unknown>>;
  approvedMemoryPatches: PortableApprovedMemoryPatch[];
  customPlaybooks: PortablePlaybook[];
  budget: { profile: BudgetProfileName; limits: BudgetLimits };
  memory: { limits: Record<string, unknown> };
}

export async function exportProfile(env: Env): Promise<DriftglassProfile> {
  const [
    sources,
    missions,
    interestTerms,
    tasteTerms,
    tasteSources,
    savedViews,
    packs,
    approvedProposals,
    playbooks,
    budget,
    memoryLimits,
  ] = await Promise.all([
    listSources(env.DB),
    listMissions(env.DB),
    getSetting(env.DB, "interest_terms"),
    listTasteTerms(env.DB, 1_000),
    listTasteSources(env.DB, 1_000),
    listSavedViews(env.DB),
    listIntelligencePacks(env.DB),
    listMemoryProposals(env.DB, { status: "approved", limit: 200 }),
    listReasoningPlaybooks(env.DB, { limit: 200 }),
    getBudgetProfile(env.DB),
    getSetting(env.DB, "memory_graph_limits"),
  ]);
  return {
    schemaVersion: 3,
    product: "Driftglass",
    exportedAt: new Date().toISOString(),
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      config: parseJson(source.config_json, {}),
      enabled: Boolean(source.enabled),
      scheduleMinutes: source.schedule_minutes,
      weight: source.weight,
    })),
    missions: await Promise.all(missions.map(async (mission) => ({
      id: mission.id,
      name: mission.name,
      question: mission.question,
      terms: parseJson(mission.terms_json, []),
      sourceScope: parseJson(mission.source_scope_json, []),
      status: mission.status,
      priority: mission.priority,
      cadenceMinutes: mission.cadence_minutes,
      operator: await getMissionOperator(env.DB, mission.id),
      researchState: await getMissionResearchState(env.DB, mission.id),
      events: await listMissionEvents(env.DB, mission.id, 200),
    }))),
    interestTerms: parseJson(interestTerms, []),
    taste: { terms: tasteTerms, sources: tasteSources },
    savedViews: savedViews.map((view) => ({ id: view.id, name: view.name, query: view.query, filters: parseJson(view.filters_json, {}) })),
    intelligencePacks: packs.map((pack) => ({
      manifest: parseJson(pack.manifest_json, {}),
      sourceUrl: pack.source_url,
      enabled: Boolean(pack.enabled),
      installedAt: pack.installed_at,
    })),
    approvedMemoryPatches: approvedProposals.map((proposal) => ({
      id: proposal.id,
      scopeKind: proposal.scope_kind,
      scopeId: proposal.scope_id,
      provider: proposal.provider,
      title: proposal.title,
      patch: parseJson(proposal.patch_json, {}),
      decisionNote: proposal.decision_note,
    })),
    customPlaybooks: playbooks
      .filter((playbook) => !playbook.pack_id)
      .map((playbook) => ({
        id: playbook.id,
        name: playbook.name,
        task: playbook.task,
        instructions: playbook.instructions,
        trigger: parseJson(playbook.trigger_json, {}),
        providerHints: parseJson(playbook.provider_hints_json, {}),
        enabled: Boolean(playbook.enabled),
      })),
    budget: { profile: budget.profile, limits: budget.limits },
    memory: { limits: parseJson(memoryLimits, {}) },
  };
}

function sourceIdSet(value: unknown): Set<string> {
  if (!value || typeof value !== "object") return new Set();
  const profile = value as Record<string, unknown>;
  return new Set((Array.isArray(profile.sources) ? profile.sources : []).map((row) => String((row as Record<string, unknown>).id ?? "")).filter(Boolean));
}

export async function previewProfileImport(env: Env, value: unknown): Promise<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile must be a JSON object");
  const profile = value as Record<string, unknown>;
  const schemaVersion = Number(profile.schemaVersion ?? 1);
  if (![1, 2, 3].includes(schemaVersion)) throw new Error(`Unsupported profile schemaVersion ${schemaVersion}`);
  const [existingSources, existingMissions, existingPacks, existingProposals] = await Promise.all([
    listSources(env.DB),
    listMissions(env.DB),
    listIntelligencePacks(env.DB),
    listMemoryProposals(env.DB, { limit: 200 }),
  ]);
  const incomingSources = Array.isArray(profile.sources) ? profile.sources : [];
  const incomingMissions = Array.isArray(profile.missions) ? profile.missions : [];
  const incomingPacks = Array.isArray(profile.intelligencePacks) ? profile.intelligencePacks : [];
  const incomingPatches = Array.isArray(profile.approvedMemoryPatches) ? profile.approvedMemoryPatches : [];
  const existingSourceIds = new Set(existingSources.map((source) => source.id));
  const existingMissionIds = new Set(existingMissions.map((mission) => mission.id));
  const existingPackIds = new Set(existingPacks.map((pack) => pack.id));
  const existingProposalIds = new Set(existingProposals.map((proposal) => proposal.id));
  const sourceIds = sourceIdSet(profile);
  return {
    schemaVersion,
    sources: {
      total: incomingSources.length,
      new: incomingSources.filter((row) => !existingSourceIds.has(String((row as Record<string, unknown>).id ?? ""))).length,
      update: incomingSources.filter((row) => existingSourceIds.has(String((row as Record<string, unknown>).id ?? ""))).length,
    },
    missions: {
      total: incomingMissions.length,
      new: incomingMissions.filter((row) => !existingMissionIds.has(String((row as Record<string, unknown>).id ?? ""))).length,
      update: incomingMissions.filter((row) => existingMissionIds.has(String((row as Record<string, unknown>).id ?? ""))).length,
    },
    intelligencePacks: {
      total: incomingPacks.length,
      new: incomingPacks.filter((row) => {
        const manifest = (row as Record<string, unknown>).manifest as Record<string, unknown> | undefined;
        return !existingPackIds.has(String(manifest?.id ?? ""));
      }).length,
    },
    approvedMemoryPatches: {
      total: incomingPatches.length,
      new: incomingPatches.filter((row) => !existingProposalIds.has(String((row as Record<string, unknown>).id ?? ""))).length,
    },
    customPlaybooks: Array.isArray(profile.customPlaybooks) ? profile.customPlaybooks.length : 0,
    missionEvents: incomingMissions.reduce((total, row) => total + (Array.isArray((row as Record<string, unknown>).events) ? ((row as Record<string, unknown>).events as unknown[]).length : 0), 0),
    tasteTerms: Array.isArray((profile.taste as Record<string, unknown> | undefined)?.terms) ? ((profile.taste as Record<string, unknown>).terms as unknown[]).length : 0,
    tasteSources: Array.isArray((profile.taste as Record<string, unknown> | undefined)?.sources) ? ((profile.taste as Record<string, unknown>).sources as unknown[]).filter((row) => sourceIds.has(String((row as Record<string, unknown>).source_id ?? ""))).length : 0,
    savedViews: Array.isArray(profile.savedViews) ? profile.savedViews.length : 0,
    budgetProfile: schemaVersion >= 3 && profile.budget && typeof profile.budget === "object"
      ? String((profile.budget as Record<string, unknown>).profile ?? "free")
      : "unchanged",
    graphPolicy: "Derived Story/source memory is rebuilt after import; only approved durable patches are portable.",
    mode: "merge",
  };
}

export async function importProfile(env: Env, value: unknown): Promise<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile must be a JSON object");
  const profile = value as Record<string, unknown>;
  const schemaVersion = Number(profile.schemaVersion ?? 1);
  if (![1, 2, 3].includes(schemaVersion)) throw new Error(`Unsupported profile schemaVersion ${schemaVersion}`);

  const incomingBudget = schemaVersion >= 3 && profile.budget && typeof profile.budget === "object"
    ? profile.budget as Record<string, unknown>
    : null;
  if (incomingBudget) {
    const configured = String(incomingBudget.profile ?? "free");
    const budgetProfile: BudgetProfileName = configured === "cheap" || configured === "custom" ? configured : "free";
    const limits = incomingBudget.limits && typeof incomingBudget.limits === "object"
      ? incomingBudget.limits as Partial<BudgetLimits>
      : undefined;
    await setBudgetProfile(env.DB, budgetProfile, limits);
  }
  const memory = schemaVersion >= 3 && profile.memory && typeof profile.memory === "object"
    ? profile.memory as Record<string, unknown>
    : null;
  if (memory?.limits && typeof memory.limits === "object") {
    await setSetting(env.DB, "memory_graph_limits", JSON.stringify(memory.limits));
  }

  let packs = 0;
  for (const entry of (Array.isArray(profile.intelligencePacks) ? profile.intelligencePacks : []).slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    try {
      const pack = parseIntelligencePack(row.manifest ?? row);
      await installIntelligencePack(env, pack, typeof row.sourceUrl === "string" ? row.sourceUrl : null, {
        allowOverBudget: true,
        // Source rows below restore any local adapters explicitly configured by the owner.
        includeCompanionSources: false,
      });
      packs += 1;
    } catch (error) {
      console.error("Profile Pack restore failed", error);
    }
  }

  const sourceRows = (Array.isArray(profile.sources) ? profile.sources : []).slice(0, 1_000) as Record<string, unknown>[];
  const missionRows = (Array.isArray(profile.missions) ? profile.missions : []).slice(0, 250) as Record<string, unknown>[];
  let sources = 0;
  let missions = 0;
  let events = 0;
  for (const row of sourceRows) {
    const id = String(row.id ?? "").trim();
    const name = String(row.name ?? "").trim();
    const kind = String(row.kind ?? "") as SourceKind;
    if (!id || !name || !kind) continue;
    await upsertSource(env.DB, {
      id,
      name,
      kind,
      config: row.config && typeof row.config === "object" ? row.config as Record<string, unknown> : {},
      enabled: row.enabled !== false,
      scheduleMinutes: Number(row.scheduleMinutes ?? 60),
      weight: Number(row.weight ?? 1),
    });
    sources += 1;
  }
  for (const row of missionRows) {
    const id = String(row.id ?? "").trim();
    const name = String(row.name ?? "").trim();
    if (!id || !name) continue;
    await upsertMission(env.DB, {
      id,
      name,
      question: String(row.question ?? ""),
      terms: normalizeStringArray(row.terms),
      sourceScope: normalizeStringArray(row.sourceScope),
      status: ["active", "paused", "complete"].includes(String(row.status)) ? row.status as "active" | "paused" | "complete" : "active",
      priority: Number(row.priority ?? 1),
      cadenceMinutes: Number(row.cadenceMinutes ?? 360),
    });
    const operator = row.operator && typeof row.operator === "object" ? row.operator as Record<string, unknown> : null;
    if (operator) {
      await upsertMissionOperator(env.DB, {
        missionId: id,
        mode: operator.mode as any,
        researchPolicy: operator.research_policy as any,
        alertThreshold: Number(operator.alert_threshold ?? 0.65),
        expectedNextEvent: String(operator.expected_next_event ?? ""),
        expectedBy: operator.expected_by ? String(operator.expected_by) : null,
        outcomeStatus: operator.outcome_status as any,
        outcomeSummary: String(operator.outcome_summary ?? ""),
        resolvedAt: operator.resolved_at ? String(operator.resolved_at) : null,
        lastEscalatedAt: operator.last_escalated_at ? String(operator.last_escalated_at) : null,
        sprintPolicy: operator.sprint_policy as any,
        nextSprintAt: operator.next_sprint_at ? String(operator.next_sprint_at) : null,
        lastSprintAt: operator.last_sprint_at ? String(operator.last_sprint_at) : null,
        reminderLeadDays: Number(operator.reminder_lead_days ?? 3),
        expectedEventStatus: operator.expected_event_status as any,
      });
    }
    const research = row.researchState && typeof row.researchState === "object" ? row.researchState as Record<string, unknown> : null;
    if (research) {
      await upsertMissionResearchState(env.DB, {
        missionId: id,
        currentThesis: String(research.current_thesis ?? ""),
        reportSummary: String(research.report_summary ?? ""),
        openQuestions: parseJson(String(research.open_questions_json ?? "[]"), []),
        reportTitle: String(research.report_title ?? ""),
        reportUrl: research.report_url ? String(research.report_url) : null,
        confidence: research.confidence === null || research.confidence === undefined ? null : Number(research.confidence),
        lastResearchAt: research.last_research_at ? String(research.last_research_at) : null,
        lastHandoffId: research.last_handoff_id ? String(research.last_handoff_id) : null,
      });
    }
    for (const event of (Array.isArray(row.events) ? row.events : []).slice(0, 500)) {
      if (!event || typeof event !== "object") continue;
      await importMissionEvent(env.DB, event as MissionEventRecord);
      events += 1;
    }
    missions += 1;
  }
  if (Array.isArray(profile.interestTerms)) await setSetting(env.DB, "interest_terms", JSON.stringify(normalizeStringArray(profile.interestTerms).slice(0, 500)));
  const taste = profile.taste && typeof profile.taste === "object" ? profile.taste as Record<string, unknown> : {};
  for (const term of (Array.isArray(taste.terms) ? taste.terms : []).slice(0, 2_000)) {
    if (term && typeof term === "object") await restoreTasteTerm(env.DB, term as TasteTermRecord);
  }
  const existingSourceIds = new Set((await listSources(env.DB)).map((source) => source.id));
  for (const source of (Array.isArray(taste.sources) ? taste.sources : []).slice(0, 2_000)) {
    if (source && typeof source === "object" && existingSourceIds.has(String((source as Record<string, unknown>).source_id ?? ""))) {
      await restoreTasteSource(env.DB, source as TasteSourceRecord);
    }
  }
  for (const view of (Array.isArray(profile.savedViews) ? profile.savedViews : []).slice(0, 250)) {
    if (!view || typeof view !== "object") continue;
    const row = view as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const name = String(row.name ?? "").trim();
    if (!id || !name) continue;
    await upsertSavedView(env.DB, { id, name, query: String(row.query ?? ""), filters: row.filters && typeof row.filters === "object" ? row.filters as Record<string, unknown> : {} });
  }

  let playbooks = 0;
  for (const entry of (Array.isArray(profile.customPlaybooks) ? profile.customPlaybooks : []).slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const name = String(row.name ?? "").trim();
    const instructions = String(row.instructions ?? "").trim();
    if (!id || !name || !instructions) continue;
    await upsertReasoningPlaybook(env.DB, {
      id,
      name,
      task: ["daily-brief", "investigate", "decision", "challenge", "deep-research", "memory-update"].includes(String(row.task))
        ? row.task as ReasoningPlaybookRecord["task"]
        : "investigate",
      instructions,
      trigger: row.trigger && typeof row.trigger === "object" ? row.trigger as Record<string, unknown> : {},
      providerHints: row.providerHints && typeof row.providerHints === "object" ? row.providerHints as Record<string, string> : {},
      enabled: row.enabled !== false,
    });
    playbooks += 1;
  }

  let memoryPatches = 0;
  for (const entry of (Array.isArray(profile.approvedMemoryPatches) ? profile.approvedMemoryPatches : []).slice(0, 200)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    if (!id || await getMemoryProposal(env.DB, id)) continue;
    try {
      await createMemoryProposal(env.DB, {
        id,
        scopeKind: ["global", "mission", "story", "pack"].includes(String(row.scopeKind))
          ? row.scopeKind as PortableApprovedMemoryPatch["scopeKind"]
          : "global",
        scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
        provider: String(row.provider ?? "profile-restore"),
        title: String(row.title ?? "Restored durable memory"),
        patch: row.patch && typeof row.patch === "object" ? row.patch as Record<string, unknown> : {},
      });
      await approveMemoryProposal(env, id, String(row.decisionNote ?? "Restored from Portable Profile v3"));
      memoryPatches += 1;
    } catch (error) {
      console.error("Profile memory patch restore failed", error);
    }
  }
  await setSetting(env.DB, "memory_graph_dirty", "1");
  return { sources, missions, events, packs, playbooks, memoryPatches };
}
