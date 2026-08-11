import { recordPackInstall, setSetting, getSetting, upsertMission, upsertSource } from "./db";
import { assertPublicHttpUrl } from "./security";
import { normalizeGithubRepositories } from "./sources/github-config";
import { normalizeOpenAlexConfig } from "./sources/openalex";
import type { Env, SourceKind, StarterPack } from "./types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseText } from "./utils";

const SOURCE_KINDS: SourceKind[] = [
  "hackernews", "lobsters", "bluesky", "arxiv", "openalex", "github_releases", "github_activity",
  "npm_releases", "pypi_releases", "web", "web_feed", "collector", "manual", "email",
];

export interface PortableLens {
  driftglassLens: "1";
  id: string;
  name: string;
  description: string;
  author?: string;
  homepage?: string;
  category?: string;
  icon?: string;
  requiresCompanion?: boolean;
  sources: Array<{
    id: string;
    name: string;
    kind: SourceKind;
    config: Record<string, unknown>;
    scheduleMinutes: number;
    weight: number;
    enabled?: boolean;
  }>;
  missions?: Array<{
    id: string;
    name: string;
    question?: string;
    terms?: string[];
    sourceScope?: string[];
    status?: "active" | "paused" | "complete";
    priority?: number;
    cadenceMinutes?: number;
  }>;
  interestTerms?: string[];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || crypto.randomUUID();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Lens must be a JSON object");
  return value as Record<string, unknown>;
}

export function starterPackAsLens(pack: StarterPack): PortableLens {
  return {
    driftglassLens: "1",
    id: pack.id,
    name: pack.name,
    description: pack.description,
    category: pack.category,
    icon: pack.icon,
    requiresCompanion: pack.requiresCompanion,
    sources: pack.sources.map((source) => ({ ...source, enabled: true })),
    interestTerms: pack.interestTerms,
  };
}

export function parsePortableLens(value: unknown): PortableLens {
  const input = record(value);
  if (String(input.driftglassLens ?? "") !== "1") throw new Error("Unsupported Driftglass Lens version");
  const name = String(input.name ?? "").trim().slice(0, 180);
  if (!name) throw new Error("Lens name is required");
  const id = slug(String(input.id ?? name));
  const rawSources = Array.isArray(input.sources) ? input.sources.slice(0, 500) : [];
  if (!rawSources.length) throw new Error("Lens must include at least one source");

  const sources = rawSources.map((entry, index) => {
    const source = record(entry);
    const sourceName = String(source.name ?? "").trim().slice(0, 160);
    const kind = String(source.kind ?? "") as SourceKind;
    if (!sourceName) throw new Error(`Lens source ${index + 1} needs a name`);
    if (!SOURCE_KINDS.includes(kind)) throw new Error(`Lens source ${index + 1} has unsupported kind ${kind}`);
    const rawConfig = source.config && typeof source.config === "object" && !Array.isArray(source.config)
      ? source.config as Record<string, unknown>
      : {};
    const config = kind === "openalex"
      ? normalizeOpenAlexConfig(rawConfig)
      : kind === "github_releases" || kind === "github_activity"
        ? { ...rawConfig, repos: normalizeGithubRepositories(rawConfig.repos, kind === "github_activity" ? 20 : 25) }
        : rawConfig;
    return {
      id: slug(String(source.id ?? `${id}-${sourceName}`)),
      name: sourceName,
      kind,
      config,
      scheduleMinutes: Math.max(15, Math.min(10_080, numberFrom(source.scheduleMinutes, 120))),
      weight: Math.max(0.1, Math.min(3, numberFrom(source.weight, 1))),
      enabled: source.enabled !== false,
    };
  });

  const missions = (Array.isArray(input.missions) ? input.missions.slice(0, 100) : []).map((entry, index) => {
    const mission = record(entry);
    const missionName = String(mission.name ?? "").trim().slice(0, 180);
    if (!missionName) throw new Error(`Lens mission ${index + 1} needs a name`);
    const status = ["active", "paused", "complete"].includes(String(mission.status))
      ? String(mission.status) as "active" | "paused" | "complete"
      : "active";
    return {
      id: slug(String(mission.id ?? `${id}-${missionName}`)),
      name: missionName,
      question: String(mission.question ?? "").trim().slice(0, 1_000),
      terms: normalizeStringArray(mission.terms).slice(0, 100),
      sourceScope: normalizeStringArray(mission.sourceScope).slice(0, 100),
      status,
      priority: Math.max(0.1, Math.min(5, numberFrom(mission.priority, 1))),
      cadenceMinutes: Math.max(15, Math.min(43_200, numberFrom(mission.cadenceMinutes, 360))),
    };
  });

  let homepage: string | undefined;
  if (typeof input.homepage === "string" && input.homepage.trim()) homepage = assertPublicHttpUrl(input.homepage).toString();

  return {
    driftglassLens: "1",
    id,
    name,
    description: String(input.description ?? "").trim().slice(0, 2_000),
    author: typeof input.author === "string" ? input.author.trim().slice(0, 180) : undefined,
    homepage,
    category: typeof input.category === "string" ? input.category.trim().slice(0, 100) : undefined,
    icon: typeof input.icon === "string" ? input.icon.trim().slice(0, 12) : undefined,
    requiresCompanion: input.requiresCompanion === true,
    sources,
    missions,
    interestTerms: normalizeStringArray(input.interestTerms).slice(0, 300),
  };
}

export async function installPortableLens(env: Env, lens: PortableLens): Promise<{ sources: number; missions: number }> {
  for (const source of lens.sources) {
    await upsertSource(env.DB, {
      id: source.id,
      name: source.name,
      kind: source.kind,
      config: source.config,
      enabled: source.enabled !== false,
      scheduleMinutes: source.scheduleMinutes,
      weight: source.weight,
    });
  }
  for (const mission of lens.missions ?? []) await upsertMission(env.DB, mission);
  const existing = normalizeStringArray(parseJson<unknown>(await getSetting(env.DB, "interest_terms"), []));
  await setSetting(env.DB, "interest_terms", JSON.stringify([...new Set([...existing, ...(lens.interestTerms ?? [])])]));
  await recordPackInstall(env.DB, `lens:${lens.id}`, lens.sources.length, {
    name: lens.name,
    author: lens.author,
    homepage: lens.homepage,
    requiresCompanion: Boolean(lens.requiresCompanion),
    communityLens: true,
  });
  return { sources: lens.sources.length, missions: lens.missions?.length ?? 0 };
}

export async function fetchPortableLens(urlValue: string): Promise<PortableLens> {
  const url = assertPublicHttpUrl(urlValue);
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { accept: "application/json", "user-agent": "Driftglass/0.2 Lens installer" },
  }, 20_000);
  if (!response.ok) throw new Error(`Lens URL returned HTTP ${response.status}`);
  assertPublicHttpUrl(response.url || url.toString());
  const text = await readBoundedResponseText(response, 1_000_000, "Lens file exceeds 1 MB");
  try {
    return parsePortableLens(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid Lens: ${error instanceof Error ? error.message : String(error)}`);
  }
}
