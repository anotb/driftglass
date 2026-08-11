import { WorkerEntrypoint } from "cloudflare:workers";
import { getSource } from "./db";
import {
  isWorkersSubrequestLimitError,
  reconcileOrphanedPendingSourceRun,
  runSource as runSourceInInvocation,
  sourceRuntimeAccess,
} from "./sources/registry";
import type { RunSourceOptions, SourceRunResult } from "./sources/registry";
import type { Env, SourceRecord } from "./types";

const SOURCE_ID_RPC_LIMIT = 256;
const SOURCE_ERROR_NAME_LIMIT = 100;
const SOURCE_ERROR_MESSAGE_LIMIT = 500;
const SOURCE_NAME_RPC_LIMIT = 300;

type SourceRunBoundaryMetadata = {
  name: string;
  kind: SourceRecord["kind"];
};

type SourceRunBoundaryUnavailableReason = "missing" | "disabled" | "credential" | "prerequisite";

export type SourceRunBoundaryResponse =
  | { ok: true; result: SourceRunResult; source: SourceRunBoundaryMetadata }
  | {
    ok: false;
    kind: "unavailable";
    reason: SourceRunBoundaryUnavailableReason;
    source?: SourceRunBoundaryMetadata;
    code?: string;
    binding?: string;
    error: { name: string; message: string };
  }
  | { ok: false; kind: "capacity" | "error"; error: { name: string; message: string } };

export type WorkflowSourceRunOutcome =
  | { kind: "result"; result: SourceRunResult; source: SourceRunBoundaryMetadata }
  | { kind: "capacity"; error: { name: string; message: string } }
  | {
    kind: "unavailable";
    reason: SourceRunBoundaryUnavailableReason;
    source?: SourceRunBoundaryMetadata;
    code?: string;
    binding?: string;
    error: { name: string; message: string };
  };

export interface SourceRunBoundaryClient {
  runSource(sourceId: string, options?: RunSourceOptions): Promise<SourceRunBoundaryResponse>;
}

type SourceRunBoundaryFailure = Extract<SourceRunBoundaryResponse, { kind: "capacity" | "error" }>;

function boundedError(error: unknown): SourceRunBoundaryFailure {
  return {
    ok: false,
    kind: isWorkersSubrequestLimitError(error) ? "capacity" : "error",
    error: {
      name: (error instanceof Error ? error.name : "Error").slice(0, SOURCE_ERROR_NAME_LIMIT),
      message: (error instanceof Error ? error.message : String(error)).slice(0, SOURCE_ERROR_MESSAGE_LIMIT),
    },
  };
}

function sourceMetadata(source: SourceRecord): SourceRunBoundaryMetadata {
  return { name: source.name.slice(0, SOURCE_NAME_RPC_LIMIT), kind: source.kind };
}

function unavailableResponse(
  reason: SourceRunBoundaryUnavailableReason,
  message: string,
  source?: SourceRecord,
  extra: { code?: string; binding?: string } = {},
): Extract<SourceRunBoundaryResponse, { kind: "unavailable" }> {
  return {
    ok: false,
    kind: "unavailable",
    reason,
    source: source ? sourceMetadata(source) : undefined,
    code: extra.code?.slice(0, SOURCE_ERROR_NAME_LIMIT),
    binding: extra.binding?.slice(0, SOURCE_ERROR_NAME_LIMIT),
    error: { name: "SourceUnavailableError", message: message.slice(0, SOURCE_ERROR_MESSAGE_LIMIT) },
  };
}

export async function runSourceAcrossBoundary(
  boundary: SourceRunBoundaryClient,
  sourceId: string,
  options: RunSourceOptions = {},
): Promise<SourceRunResult> {
  const response = await boundary.runSource(sourceId, options);
  if (response.ok) return response.result;
  const error = new Error(response.error.message);
  error.name = response.error.name;
  throw error;
}

export function runSourceWithBoundaryFallback(
  boundary: SourceRunBoundaryClient | undefined,
  source: SourceRecord,
  env: Env,
  options: RunSourceOptions = {},
): Promise<SourceRunResult> {
  return boundary
    ? runSourceAcrossBoundary(boundary, source.id, options)
    : runSourceInInvocation(source, env, options);
}

function isBoundaryCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return isWorkersSubrequestLimitError(error)
    || /too many worker invocations|worker invocation limit|service binding.+limit|loop limit|cf-ew-via/i.test(message)
    || /\b1019\b/.test(`${code}\n${message}`);
}

export async function runWorkflowSourceAcrossBoundary(
  boundary: SourceRunBoundaryClient,
  sourceId: string,
): Promise<WorkflowSourceRunOutcome> {
  let response: SourceRunBoundaryResponse;
  try {
    response = await boundary.runSource(sourceId);
  } catch (error) {
    if (!isBoundaryCapacityError(error)) throw error;
    const bounded = boundedError(error);
    return { kind: "capacity", error: bounded.error };
  }
  if (response.ok) return { kind: "result", result: response.result, source: response.source };
  if (response.kind === "capacity") return { kind: "capacity", error: response.error };
  if (response.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: response.reason,
      source: response.source,
      code: response.code,
      binding: response.binding,
      error: response.error,
    };
  }
  const error = new Error(response.error.message);
  error.name = response.error.name;
  throw error;
}

/**
 * A loopback Service Binding gives each source its own Worker invocation and
 * therefore its own Workers Free external-subrequest envelope. The parent
 * Routine, Mission, Cron, or API invocation spends only an internal
 * Cloudflare-service subrequest on this RPC.
 */
export class SourceRunBoundary extends WorkerEntrypoint<Env> {
  async runSource(sourceId: string, options: RunSourceOptions = {}): Promise<SourceRunBoundaryResponse> {
    try {
      if (typeof sourceId !== "string" || !sourceId || sourceId.length > SOURCE_ID_RPC_LIMIT) {
        throw new Error("Source id is invalid");
      }
      const source = await getSource(this.env.DB, sourceId);
      if (!source) return unavailableResponse("missing", `Source not found: ${sourceId}`);
      if (source.enabled !== 1) {
        await reconcileOrphanedPendingSourceRun(this.env.DB, source.id);
        return unavailableResponse("disabled", "Source is disabled", source);
      }
      const access = sourceRuntimeAccess(source, this.env);
      if (!access.runnable) {
        await reconcileOrphanedPendingSourceRun(this.env.DB, source.id);
        return unavailableResponse(
          access.code === "OPENALEX_API_KEY_REQUIRED" ? "credential" : "prerequisite",
          access.detail,
          source,
          { code: access.code, binding: access.openalex?.binding },
        );
      }
      const runOptions: RunSourceOptions = options.resumeOutbox === false ? { resumeOutbox: false } : {};
      return {
        ok: true,
        result: await runSourceInInvocation(source, this.env, runOptions),
        source: sourceMetadata(source),
      };
    } catch (error) {
      return boundedError(error);
    }
  }
}
