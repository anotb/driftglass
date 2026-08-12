import type { NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson } from "../utils";
import {
  boundedPackageDescription,
  PACKAGE_DESCRIPTION_MAX_BYTES,
  readPackageMetadataResponse,
  settlePackageRequests,
} from "./package-runtime";
import { discardRemoteSourceResponse } from "./remote-runtime";

interface PypiConfig {
  packages?: string[];
  perPackage?: number;
  watchTerms?: string[];
}

interface PypiFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
  filename?: string;
}

interface PypiResponse {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    description?: string;
    home_page?: string;
    project_url?: string;
    project_urls?: Record<string, string>;
    author?: string;
    requires_python?: string;
  };
  releases?: Record<string, PypiFile[]>;
}

function projectUrl(packageName: string, payload: PypiResponse): string {
  const urls = payload.info?.project_urls ?? {};
  return urls.Source || urls.Homepage || urls.Repository || payload.info?.project_url || payload.info?.home_page
    || `https://pypi.org/project/${encodeURIComponent(packageName)}/`;
}

function releaseTime(files: PypiFile[]): string | undefined {
  return files.find((file) => !file.yanked)?.upload_time_iso_8601 || files[0]?.upload_time_iso_8601;
}

function chooseVersions(payload: PypiResponse, limit: number): string[] {
  return Object.entries(payload.releases ?? {})
    .filter(([, files]) => files.length > 0 && files.some((file) => !file.yanked))
    .sort(([, left], [, right]) => Date.parse(releaseTime(right) ?? "") - Date.parse(releaseTime(left) ?? ""))
    .map(([version]) => version)
    .slice(0, limit);
}

export async function collectPypiReleases(source: SourceRecord): Promise<SourceAdapterResult> {
  const config = parseJson<PypiConfig>(source.config_json, {});
  const packages = normalizeStringArray(config.packages).slice(0, 40);
  if (packages.length === 0) throw new Error("PyPI source needs config.packages");
  const watchTerms = normalizeStringArray(config.watchTerms);
  const perPackage = Math.max(1, Math.min(20, numberFrom(config.perPackage, 5)));

  const settled = await settlePackageRequests(packages, async (packageName): Promise<NormalizedItemInput[]> => {
    const response = await fetchWithTimeout(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, {
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "Driftglass/0.2 (package release monitor)" },
    }, 15_000);
    if (!response.ok) {
      const status = response.status;
      await discardRemoteSourceResponse(response, "PyPI response rejected");
      throw new Error(`${packageName}: HTTP ${status}`);
    }
    const payload = JSON.parse(await readPackageMetadataResponse(response, packageName)) as PypiResponse;
    const versions = chooseVersions(payload, perPackage);
    if (versions.length === 0 && payload.info?.version) versions.push(payload.info.version);
    if (versions.length === 0) throw new Error(`${packageName}: no release version found`);
    const description = boundedPackageDescription(payload.info?.summary || payload.info?.description);
    return versions.map((version) => {
      const files = payload.releases?.[version] ?? [];
      return {
        externalId: `${packageName}@${version}`,
        url: projectUrl(packageName, payload),
        title: `${payload.info?.name || packageName} ${version}`,
        text: [description.text, `Package: ${packageName}`, `Version: ${version}`].filter(Boolean).join("\n\n"),
        author: payload.info?.author,
        publishedAt: releaseTime(files),
        metadata: {
          platform: "pypi",
          package: packageName,
          version,
          requiresPython: payload.info?.requires_python,
          files: files.length,
          watchTerms,
          descriptionTruncated: description.truncated,
          descriptionOriginalBytes: description.originalBytes,
          descriptionBytes: description.textBytes,
        },
      };
    });
  });

  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = settled.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
    : []);
  if (items.length === 0) throw new Error(`Every PyPI package failed: ${errors.join("; ")}`);
  const descriptionTruncatedItems = items.filter((item) => item.metadata?.descriptionTruncated === true).length;
  return {
    items,
    provider: "pypi-json",
    details: {
      packages,
      perPackage,
      returned: items.length,
      partial: errors.length > 0,
      errors: errors.slice(0, 10),
      descriptionMaxBytes: PACKAGE_DESCRIPTION_MAX_BYTES,
      descriptionTruncatedItems,
    },
  };
}
