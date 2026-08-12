import { getIntelligencePack, getIntelligencePackOverlay, getMissionOperator, listIntelligencePackOverlays, listMissions, listSources, upsertIntelligencePackOverlay } from "./db";
import { sha256 } from "./security";
import { normalizeOpenAlexConfig } from "./sources/openalex";
import type {
  IntelligencePackManifest,
  IntelligencePackOverlayPatch,
  IntelligencePackOverlayRecord,
  IntelligencePackSnapshotRecord,
} from "./types";
import { isoNow, parseJson, stableStringify } from "./utils";

function rows<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

function clonePack(pack: IntelligencePackManifest): IntelligencePackManifest {
  return JSON.parse(JSON.stringify(pack)) as IntelligencePackManifest;
}

function uniqueTerms(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function applyPackOverlay(
  pack: IntelligencePackManifest,
  overlay: IntelligencePackOverlayPatch,
): { pack: IntelligencePackManifest; conflicts: string[] } {
  const output = clonePack(pack);
  const conflicts: string[] = [];
  const cloud = [...(output.cloudSources ?? []), ...(output.sources ?? [])];
  const companion = [...(output.companionSources ?? [])];
  const sourceMap = new Map([...cloud, ...companion].map((source) => [source.id, source]));

  for (const sourceId of overlay.disableSources ?? []) {
    if (!sourceMap.has(sourceId)) conflicts.push(`Source ${sourceId} no longer exists upstream.`);
    sourceMap.delete(sourceId);
  }
  for (const [sourceId, patch] of Object.entries(overlay.sourceOverrides ?? {})) {
    const source = sourceMap.get(sourceId);
    if (!source) {
      conflicts.push(`Source override ${sourceId} no longer matches an upstream source.`);
      continue;
    }
    sourceMap.set(sourceId, {
      ...source,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config: { ...source.config, ...patch.config } } : {}),
      ...(patch.scheduleMinutes !== undefined ? { scheduleMinutes: patch.scheduleMinutes } : {}),
      ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
    });
  }
  for (const source of overlay.addSources ?? []) sourceMap.set(source.id, source);
  output.sources = [];
  output.cloudSources = [...sourceMap.values()].filter((source) => source.kind !== "collector");
  output.companionSources = [...sourceMap.values()].filter((source) => source.kind === "collector");
  for (const source of output.cloudSources) {
    if (source.kind === "openalex") source.config = normalizeOpenAlexConfig(source.config);
  }

  const missionMap = new Map((output.missions ?? []).map((mission) => [mission.id, mission]));
  for (const missionId of overlay.disableMissions ?? []) {
    if (!missionMap.has(missionId)) conflicts.push(`Mission ${missionId} no longer exists upstream.`);
    missionMap.delete(missionId);
  }
  for (const [missionId, patch] of Object.entries(overlay.missionOverrides ?? {})) {
    const mission = missionMap.get(missionId);
    if (!mission) {
      conflicts.push(`Mission override ${missionId} no longer matches an upstream Mission.`);
      continue;
    }
    missionMap.set(missionId, { ...mission, ...patch } as IntelligencePackManifest["missions"] extends Array<infer T> ? T : never);
  }
  for (const mission of overlay.addMissions ?? []) missionMap.set(mission.id, mission);
  output.missions = [...missionMap.values()];

  output.evidencePolicy = { ...(output.evidencePolicy ?? {}), ...(overlay.evidencePolicy ?? {}) };
  output.reasoning = { ...(output.reasoning ?? {}), ...(overlay.reasoning ?? {}) };
  output.budget = { ...(output.budget ?? {}), ...(overlay.budget ?? {}) };
  const removed = new Set(overlay.removeInterestTerms ?? []);
  output.interestTerms = uniqueTerms([
    ...(output.interestTerms ?? []).filter((term) => !removed.has(term)),
    ...(overlay.addInterestTerms ?? []),
  ]);
  return { pack: output, conflicts };
}

interface AppliedOverlayState {
  pack: IntelligencePackManifest;
  overlays: string[];
  conflicts: string[];
  evaluations: Array<{
    record: IntelligencePackOverlayRecord;
    patch: IntelligencePackOverlayPatch;
    conflicts: string[];
  }>;
}

function applyOverlayRecords(
  pack: IntelligencePackManifest,
  records: IntelligencePackOverlayRecord[],
): AppliedOverlayState {
  let output = pack;
  const conflicts: string[] = [];
  const applied: string[] = [];
  const evaluations: AppliedOverlayState["evaluations"] = [];
  for (const record of records) {
    const patch = parseJson<IntelligencePackOverlayPatch>(record.overlay_json, {});
    const result = applyPackOverlay(output, patch);
    output = result.pack;
    applied.push(record.id);
    conflicts.push(...result.conflicts.map((conflict) => `${record.name}: ${conflict}`));
    evaluations.push({ record, patch, conflicts: result.conflicts });
  }
  return { pack: output, overlays: applied, conflicts, evaluations };
}

async function persistOverlayReconciliation(
  db: D1Database,
  pack: IntelligencePackManifest,
  evaluations: AppliedOverlayState["evaluations"],
): Promise<void> {
  for (const { record, patch, conflicts } of evaluations) {
    await upsertIntelligencePackOverlay(db, {
      id: record.id,
      basePackId: record.base_pack_id,
      name: record.name,
      description: record.description,
      baseVersion: pack.version,
      overlay: patch as Record<string, unknown>,
      status: conflicts.length ? "conflicted" : "active",
      conflicts,
    });
  }
}

export async function applyActivePackOverlays(
  db: D1Database,
  pack: IntelligencePackManifest,
): Promise<{ pack: IntelligencePackManifest; overlays: string[]; conflicts: string[] }> {
  const records = (await listIntelligencePackOverlays(db, pack.id)).filter((record) => record.status !== "disabled");
  const result = applyOverlayRecords(pack, records);
  return { pack: result.pack, overlays: result.overlays, conflicts: result.conflicts };
}

export async function createPackOverlay(
  db: D1Database,
  input: { packId: string; packVersion: string; name: string; description?: string; patch: IntelligencePackOverlayPatch },
): Promise<IntelligencePackOverlayRecord> {
  const installed = await getIntelligencePack(db, input.packId);
  if (!installed) throw new Error(`Intelligence Pack not found: ${input.packId}`);
  // Validate the effective source configuration before the overlay JSON itself
  // is allowed into D1. This closes the overlay-only credential storage path.
  applyPackOverlay(
    parseJson<IntelligencePackManifest>(installed.manifest_json, {} as IntelligencePackManifest),
    input.patch,
  );
  const id = `overlay-${input.packId}-${(await sha256(`${input.name}:${stableStringify(input.patch)}`)).slice(0, 16)}`;
  await upsertIntelligencePackOverlay(db, {
    id,
    basePackId: input.packId,
    name: input.name.trim().slice(0, 160),
    description: (input.description ?? "").trim().slice(0, 1_000),
    baseVersion: input.packVersion,
    overlay: input.patch as Record<string, unknown>,
    status: "active",
    conflicts: [],
  });
  const record = await getIntelligencePackOverlay(db, id);
  if (!record) throw new Error("Pack overlay was stored but could not be read");
  return record;
}

export async function storePackSnapshot(
  db: D1Database,
  input: { pack: IntelligencePackManifest; sourceUrl?: string | null; eventType?: string },
): Promise<IntelligencePackSnapshotRecord> {
  for (const source of [...(input.pack.sources ?? []), ...(input.pack.cloudSources ?? []), ...(input.pack.companionSources ?? [])]) {
    if (source.kind === "openalex") normalizeOpenAlexConfig(source.config);
  }
  const checksum = await sha256(stableStringify(input.pack));
  const existing = await db.prepare(
    "SELECT * FROM intelligence_pack_snapshots WHERE pack_id = ? AND checksum = ?",
  ).bind(input.pack.id, checksum).first<IntelligencePackSnapshotRecord>();
  if (existing) return existing;
  const id = `pack-snapshot-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO intelligence_pack_snapshots(id, pack_id, version, manifest_json, checksum, source_url, event_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.pack.id,
    input.pack.version,
    JSON.stringify(input.pack),
    checksum,
    input.sourceUrl ?? input.pack.updateUrl ?? null,
    input.eventType ?? "install",
    isoNow(),
  ).run();
  const snapshot = await db.prepare("SELECT * FROM intelligence_pack_snapshots WHERE id = ?").bind(id).first<IntelligencePackSnapshotRecord>();
  if (!snapshot) throw new Error("Pack snapshot was stored but could not be read");
  return snapshot;
}

export async function listPackSnapshots(db: D1Database, packId: string, limit = 30): Promise<IntelligencePackSnapshotRecord[]> {
  return rows(await db.prepare(
    "SELECT * FROM intelligence_pack_snapshots WHERE pack_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(packId, Math.max(1, Math.min(100, limit))).all<IntelligencePackSnapshotRecord>());
}

export async function effectiveIntelligencePack(
  env: { DB: D1Database },
  pack: IntelligencePackManifest,
): Promise<{ pack: IntelligencePackManifest; overlays: IntelligencePackOverlayRecord[]; conflicts: string[] }> {
  const records = (await listIntelligencePackOverlays(env.DB, pack.id)).filter((record) => record.status !== "disabled");
  const result = applyOverlayRecords(pack, records);
  return { pack: result.pack, overlays: records, conflicts: result.conflicts };
}

/** Reconcile overlay status only from an explicit Pack update mutation. */
export async function reconcileEffectiveIntelligencePack(
  env: { DB: D1Database },
  pack: IntelligencePackManifest,
): Promise<{ pack: IntelligencePackManifest; overlays: IntelligencePackOverlayRecord[]; conflicts: string[] }> {
  const records = (await listIntelligencePackOverlays(env.DB, pack.id)).filter((record) => record.status !== "disabled");
  const result = applyOverlayRecords(pack, records);
  await persistOverlayReconciliation(env.DB, pack, result.evaluations);
  return { pack: result.pack, overlays: records, conflicts: result.conflicts };
}


function packSourceMap(pack: IntelligencePackManifest): Map<string, NonNullable<IntelligencePackManifest["cloudSources"]>[number]> {
  return new Map([...(pack.sources ?? []), ...(pack.cloudSources ?? []), ...(pack.companionSources ?? [])].map((source) => [source.id, source]));
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export async function deriveInstalledPackOverlay(
  env: { DB: D1Database },
  pack: IntelligencePackManifest,
): Promise<{ patch: IntelligencePackOverlayPatch; summary: Record<string, number> }> {
  const [sources, missions] = await Promise.all([listSources(env.DB), listMissions(env.DB)]);
  const currentSources = new Map(sources.map((source) => [source.id, source]));
  const currentMissions = new Map(missions.map((mission) => [mission.id, mission]));
  const patch: IntelligencePackOverlayPatch = {};
  const disableSources: string[] = [];
  const sourceOverrides: NonNullable<IntelligencePackOverlayPatch["sourceOverrides"]> = {};
  for (const [sourceId, base] of packSourceMap(pack)) {
    const current = currentSources.get(sourceId);
    if (!current) {
      // A missing signed-in lane usually means the cloud-only install was selected, not that the owner disabled it.
      if (base.kind !== "collector") disableSources.push(sourceId);
      continue;
    }
    if (current.enabled !== 1) disableSources.push(sourceId);
    const override: Record<string, unknown> = {};
    if (current.name !== base.name) override.name = current.name;
    const config = parseJson<Record<string, unknown>>(current.config_json, {});
    if (!same(config, base.config)) override.config = config;
    if (current.schedule_minutes !== base.scheduleMinutes) override.scheduleMinutes = current.schedule_minutes;
    if (Math.abs(current.weight - base.weight) > 0.0001) override.weight = current.weight;
    if (Object.keys(override).length) sourceOverrides[sourceId] = override;
  }
  if (disableSources.length) patch.disableSources = disableSources;
  if (Object.keys(sourceOverrides).length) patch.sourceOverrides = sourceOverrides;

  const disableMissions: string[] = [];
  const missionOverrides: NonNullable<IntelligencePackOverlayPatch["missionOverrides"]> = {};
  for (const base of pack.missions ?? []) {
    const current = currentMissions.get(base.id);
    if (!current) { disableMissions.push(base.id); continue; }
    const operator = await getMissionOperator(env.DB, base.id);
    const currentValue = {
      name: current.name,
      question: current.question,
      terms: parseJson<string[]>(current.terms_json, []),
      sourceScope: parseJson<string[]>(current.source_scope_json, []),
      status: current.status,
      priority: current.priority,
      cadenceMinutes: current.cadence_minutes,
      mode: operator?.mode,
      researchPolicy: operator?.research_policy,
      sprintPolicy: operator?.sprint_policy,
      alertThreshold: operator?.alert_threshold,
      expectedNextEvent: operator?.expected_next_event || undefined,
      expectedBy: operator?.expected_by,
      reminderLeadDays: operator?.reminder_lead_days,
    };
    const baseValue = {
      name: base.name,
      question: base.question ?? "",
      terms: base.terms ?? [],
      sourceScope: base.sourceScope ?? [],
      status: base.status ?? "active",
      priority: base.priority ?? 1,
      cadenceMinutes: base.cadenceMinutes ?? 360,
      mode: base.mode ?? "watch",
      researchPolicy: base.researchPolicy ?? "suggest",
      sprintPolicy: base.sprintPolicy ?? "manual",
      alertThreshold: base.alertThreshold ?? 0.65,
      expectedNextEvent: base.expectedNextEvent || undefined,
      expectedBy: base.expectedBy ?? null,
      reminderLeadDays: base.reminderLeadDays ?? 3,
    };
    if (!same(currentValue, baseValue)) missionOverrides[base.id] = currentValue;
  }
  if (disableMissions.length) patch.disableMissions = disableMissions;
  if (Object.keys(missionOverrides).length) patch.missionOverrides = missionOverrides;
  return {
    patch,
    summary: {
      disabledSources: disableSources.length,
      sourceOverrides: Object.keys(sourceOverrides).length,
      disabledMissions: disableMissions.length,
      missionOverrides: Object.keys(missionOverrides).length,
    },
  };
}
