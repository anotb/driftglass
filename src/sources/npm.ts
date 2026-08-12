import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseText } from "../utils";
import {
  boundedPackageDescription,
  PACKAGE_DESCRIPTION_MAX_BYTES,
  readPackageMetadataResponse,
  settlePackageRequests,
} from "./package-runtime";

interface NpmConfig {
  packages?: string[];
  includePrereleases?: boolean;
  perPackage?: number;
  watchTerms?: string[];
}

interface NpmPackument {
  name?: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, Record<string, unknown>>;
  time?: Record<string, string>;
  homepage?: string;
  repository?: string | { url?: string };
}

interface NpmPackageResult {
  items: NormalizedItemInput[];
  metadataMode: "packument" | "dist-tags";
  deferredTaggedVersions: number;
}

interface OversizedNpmPackage {
  oversizedPackageName: string;
}

interface TaggedNpmFallbackState {
  packageIndex: number;
  packageName: string;
  encodedPackage: string;
  tags: Record<string, string>;
  versions: string[];
  items: NormalizedItemInput[];
  nextVersionIndex: number;
  stopped: boolean;
}

const NPM_DIST_TAGS_MAX_BYTES = 128_000;
const NPM_EXTERNAL_REQUESTS_PER_RUN = 48;

function packageUrl(name: string, packument: NpmPackument): string {
  const repository = typeof packument.repository === "string" ? packument.repository : packument.repository?.url;
  if (repository?.includes("github.com")) return repository.replace(/^git\+/, "").replace(/\.git$/, "");
  return packument.homepage || `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
}

function isPrerelease(version: string): boolean {
  return version.includes("-");
}

function chooseVersions(packument: NpmPackument, includePrereleases: boolean, limit: number): string[] {
  const tags = packument["dist-tags"] ?? {};
  const preferred = [tags.latest, includePrereleases ? tags.next : undefined]
    .filter((value): value is string => typeof value === "string"
      && Boolean(value)
      && (includePrereleases || !isPrerelease(value)));
  const versions = Object.keys(packument.versions ?? {})
    .filter((version) => includePrereleases || !isPrerelease(version))
    // The registry's abbreviated packument omits `time` and serializes
    // versions oldest-first. Reverse that stable order before applying any
    // available timestamps so a release monitor never fills its bounded tail
    // with the package's oldest versions.
    .reverse()
    .sort((left, right) => {
      const rightTime = Date.parse(packument.time?.[right] ?? "");
      const leftTime = Date.parse(packument.time?.[left] ?? "");
      if (Number.isFinite(rightTime) && Number.isFinite(leftTime)) return rightTime - leftTime;
      if (Number.isFinite(rightTime)) return 1;
      if (Number.isFinite(leftTime)) return -1;
      return 0;
    });
  return [...new Set([...preferred, ...versions])].slice(0, limit);
}

function releaseItem(
  packageName: string,
  version: string,
  packument: NpmPackument,
  versionMetadata: Record<string, unknown>,
  distTags: Record<string, string>,
  watchTerms: string[],
  metadataMode: "packument" | "dist-tags",
): NormalizedItemInput {
  const description = boundedPackageDescription(versionMetadata.description ?? packument.description);
  const publishedAt = packument.time?.[version];
  const text = [
    description.text,
    `Package: ${packageName}`,
    `Version: ${version}`,
  ].filter(Boolean).join("\n\n");
  return {
    externalId: `${packageName}@${version}`,
    url: packageUrl(packageName, { ...packument, ...versionMetadata } as NpmPackument),
    title: `${packageName} ${version}`,
    text,
    publishedAt,
    metadata: {
      platform: "npm",
      package: packageName,
      version,
      prerelease: isPrerelease(version),
      distTags,
      watchTerms,
      registryMetadataMode: metadataMode,
      releaseTimestampAvailable: Boolean(publishedAt),
      descriptionTruncated: description.truncated,
      descriptionOriginalBytes: description.originalBytes,
      descriptionBytes: description.textBytes,
    },
  };
}

function packageMetadataExceededBound(error: unknown, packageName: string): boolean {
  return error instanceof Error && error.message === `${packageName}: package metadata exceeds 3 MB`;
}

async function cancelFailedResponse(response: Response): Promise<void> {
  await response.body?.cancel("upstream response was not successful").catch(() => undefined);
}

function taggedVersions(tags: Record<string, string>, includePrereleases: boolean, limit: number): string[] {
  const preferredTags = ["latest", "next", "canary", "beta", "rc", "alpha", "experimental", "dev"];
  const tagNames = [
    ...preferredTags.filter((tag) => Object.hasOwn(tags, tag)),
    ...Object.keys(tags).filter((tag) => !preferredTags.includes(tag)).sort(),
  ];
  return [...new Set(tagNames.map((tag) => tags[tag]).filter((version): version is string => Boolean(version)))]
    .filter((version) => includePrereleases || !isPrerelease(version))
    .slice(0, limit);
}

async function openTaggedVersionFallback(
  packageIndex: number,
  packageName: string,
  includePrereleases: boolean,
  limit: number,
): Promise<TaggedNpmFallbackState> {
  const encodedPackage = encodeURIComponent(packageName);
  const tagsResponse = await fetchWithTimeout(`https://registry.npmjs.org/-/package/${encodedPackage}/dist-tags`, {
    redirect: "manual",
    headers: {
      accept: "application/json",
      "user-agent": "Driftglass/0.2 (package release monitor)",
    },
  }, 15_000);
  if (!tagsResponse.ok) {
    await cancelFailedResponse(tagsResponse);
    throw new Error(`${packageName}: dist-tags HTTP ${tagsResponse.status}`);
  }
  const tagsText = await readBoundedResponseText(
    tagsResponse,
    NPM_DIST_TAGS_MAX_BYTES,
    `${packageName}: dist-tags metadata exceeds 128 KB`,
  );
  const parsedTags = JSON.parse(tagsText) as unknown;
  if (!parsedTags || typeof parsedTags !== "object" || Array.isArray(parsedTags)) {
    throw new Error(`${packageName}: dist-tags metadata is invalid`);
  }
  const tags = Object.fromEntries(Object.entries(parsedTags)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
  const versions = taggedVersions(tags, includePrereleases, limit);
  if (versions.length === 0) throw new Error(`${packageName}: no tagged release version found`);
  return {
    packageIndex,
    packageName,
    encodedPackage,
    tags,
    versions,
    items: [],
    nextVersionIndex: 0,
    stopped: false,
  };
}

async function fetchNextTaggedVersion(state: TaggedNpmFallbackState, watchTerms: string[]): Promise<boolean> {
  const version = state.versions[state.nextVersionIndex];
  if (!version || state.stopped) return false;
  state.nextVersionIndex += 1;
  const response = await fetchWithTimeout(
    `https://registry.npmjs.org/${state.encodedPackage}/${encodeURIComponent(version)}`,
    {
      redirect: "manual",
      headers: {
        accept: "application/json",
        "user-agent": "Driftglass/0.2 (package release monitor)",
      },
    },
    15_000,
  );
  if (!response.ok) {
    await cancelFailedResponse(response);
    throw new Error(`${state.packageName}@${version}: HTTP ${response.status}`);
  }
  const raw = await readPackageMetadataResponse(response, `${state.packageName}@${version}`);
  const metadata = JSON.parse(raw) as Record<string, unknown>;
  state.items.push(releaseItem(
    state.packageName,
    version,
    metadata,
    metadata,
    state.tags,
    watchTerms,
    "dist-tags",
  ));
  return true;
}

export async function collectNpmReleases(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<NpmConfig>(source.config_json, {});
  const packages = normalizeStringArray(config.packages).slice(0, 40);
  if (packages.length === 0) throw new Error("npm source needs config.packages");
  const watchTerms = normalizeStringArray(config.watchTerms);
  const perPackage = Math.max(1, Math.min(20, numberFrom(config.perPackage, 5)));
  let fallbackRequests = 0;
  const reserveFallbackRequest = () => {
    if (packages.length + fallbackRequests >= NPM_EXTERNAL_REQUESTS_PER_RUN) return false;
    fallbackRequests += 1;
    return true;
  };
  const remainingFallbackRequests = () => NPM_EXTERNAL_REQUESTS_PER_RUN - packages.length - fallbackRequests;

  // Reserve the full base-package pass first. Oversized responses become
  // deterministic second-phase candidates, so one fallback cannot starve a
  // later configured package's primary request.
  const initial = await settlePackageRequests(packages, async (packageName): Promise<NpmPackageResult | OversizedNpmPackage> => {
    const response = await fetchWithTimeout(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      redirect: "manual",
      headers: {
        accept: "application/vnd.npm.install-v1+json, application/json;q=0.9",
        "user-agent": "Driftglass/0.2 (package release monitor)",
      },
    }, 15_000);
    if (!response.ok) {
      await cancelFailedResponse(response);
      throw new Error(`${packageName}: HTTP ${response.status}`);
    }
    let raw: string;
    try {
      raw = await readPackageMetadataResponse(response, packageName);
    } catch (error) {
      if (packageMetadataExceededBound(error, packageName)) {
        return { oversizedPackageName: packageName };
      }
      throw error;
    }
    const packument = JSON.parse(raw) as NpmPackument;
    const versions = chooseVersions(packument, Boolean(config.includePrereleases), perPackage);
    if (versions.length === 0) throw new Error(`${packageName}: no release version found`);
    const distTags = packument["dist-tags"] ?? {};
    return {
      items: versions.map((version) => releaseItem(
        packageName,
        version,
        packument,
        packument.versions?.[version] ?? {},
        distTags,
        watchTerms,
        "packument",
      )),
      metadataMode: "packument",
      deferredTaggedVersions: 0,
    };
  });

  const packageResults = new Array<NpmPackageResult | undefined>(packages.length);
  const oversizedCandidates: Array<{ packageIndex: number; packageName: string }> = [];
  const errors: string[] = [];
  for (const [packageIndex, result] of initial.entries()) {
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      continue;
    }
    if (!("oversizedPackageName" in result.value)) {
      packageResults[packageIndex] = result.value;
      continue;
    }
    oversizedCandidates.push({ packageIndex, packageName: result.value.oversizedPackageName });
  }

  // Diversity first: give as many oversized packages as possible one bounded
  // tag document plus one exact version document. Only then spend remaining
  // slots round-robin on deeper per-package coverage.
  const fallbackStates: TaggedNpmFallbackState[] = [];
  let fallbackDeferredPackages = 0;
  for (const candidate of oversizedCandidates) {
    if (remainingFallbackRequests() < 2) {
      fallbackDeferredPackages += 1;
      continue;
    }
    try {
      if (!reserveFallbackRequest()) throw new Error("npm bounded metadata fallback exhausted its request envelope");
      const state = await openTaggedVersionFallback(
        candidate.packageIndex,
        candidate.packageName,
        Boolean(config.includePrereleases),
        perPackage,
      );
      if (!reserveFallbackRequest()) throw new Error("npm bounded metadata fallback exhausted its request envelope");
      await fetchNextTaggedVersion(state, watchTerms);
      fallbackStates.push(state);
    } catch (error) {
      fallbackDeferredPackages += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let madeProgress = true;
  while (remainingFallbackRequests() > 0 && madeProgress) {
    madeProgress = false;
    for (const state of fallbackStates) {
      if (remainingFallbackRequests() <= 0) break;
      if (state.stopped || state.nextVersionIndex >= state.versions.length) continue;
      if (!reserveFallbackRequest()) break;
      madeProgress = true;
      try {
        await fetchNextTaggedVersion(state, watchTerms);
      } catch (error) {
        state.stopped = true;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  for (const state of fallbackStates) {
    packageResults[state.packageIndex] = {
      items: state.items,
      metadataMode: "dist-tags",
      deferredTaggedVersions: state.versions.length - state.items.length,
    };
  }

  const completedPackageResults = packageResults.filter((result): result is NpmPackageResult => Boolean(result));
  const items = completedPackageResults.flatMap((result) => result.items);
  const fallbackDeferredVersions = completedPackageResults.reduce((sum, result) => sum + result.deferredTaggedVersions, 0);
  if (items.length === 0) throw new Error(`Every npm package failed: ${errors.join("; ")}`);
  const descriptionTruncatedItems = items.filter((item) => item.metadata?.descriptionTruncated === true).length;
  const fallbackCoverageLimited = fallbackDeferredPackages > 0 || fallbackDeferredVersions > 0;
  const fallbackCoverage = fallbackCoverageLimited
    ? "Tagged release coverage was shortened to stay within the bounded npm request envelope or because an upstream request failed."
    : null;
  return {
    items,
    provider: "npm-registry",
    details: {
      packages,
      perPackage,
      returned: items.length,
      partial: errors.length > 0 || fallbackCoverageLimited,
      errors: errors.slice(0, 10),
      oversizedMetadataPackages: oversizedCandidates.length,
      boundedMetadataFallbackPackages: completedPackageResults.filter((result) => result.metadataMode === "dist-tags").length,
      boundedMetadataFallbackDeferredPackages: fallbackDeferredPackages,
      boundedMetadataFallbackDeferredVersions: fallbackDeferredVersions,
      boundedMetadataFallbackCoverage: fallbackCoverage,
      boundedMetadataFallbackRequests: fallbackRequests,
      registryRequests: packages.length + fallbackRequests,
      registryRequestLimit: NPM_EXTERNAL_REQUESTS_PER_RUN,
      descriptionMaxBytes: PACKAGE_DESCRIPTION_MAX_BYTES,
      descriptionTruncatedItems,
    },
  };
}
