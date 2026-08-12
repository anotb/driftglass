import type { Env, SourceRecord } from "../types";
import { parseJson } from "../utils";
import { openAlexAccessStatus, type OpenAlexAccessStatus } from "./openalex";

export interface SourceRuntimeAccess {
  runnable: boolean;
  code?: string;
  detail: string;
  openalex?: OpenAlexAccessStatus;
}

/**
 * Pure capability check shared by Cloudflare scheduling, readiness, the owner
 * UI, and compact MCP health. It exposes binding presence, never credential
 * material, and intentionally imports no platform runtime module.
 */
export function sourceRuntimeAccess(
  source: SourceRecord,
  env: Pick<Env, "OPENALEX_API_KEY">,
): SourceRuntimeAccess {
  if (source.kind !== "openalex") return { runnable: true, detail: "No optional source prerequisite" };
  try {
    const openalex = openAlexAccessStatus(
      parseJson<Record<string, unknown>>(source.config_json, {}),
      env.OPENALEX_API_KEY,
    );
    return {
      runnable: openalex.runnable,
      code: openalex.runnable ? undefined : "OPENALEX_API_KEY_REQUIRED",
      detail: openalex.detail,
      openalex,
    };
  } catch (error) {
    return {
      runnable: false,
      code: "OPENALEX_CONFIGURATION_INVALID",
      detail: error instanceof Error ? error.message : "OpenAlex source configuration is invalid",
    };
  }
}
