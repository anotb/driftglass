import type {
  IntelligenceRoutineWorkflowParams,
  IngestMessage,
  MemoryGraphWorkflowParams,
  MissionWorkflowParams,
  Env,
} from "../types";
import type {
  AssetPort,
  BrowserPort,
  ClockPort,
  DatabasePort,
  DatabaseScalar,
  IngressHealth,
  IngressPort,
  MailPort,
  NotificationPort,
  ObjectBody,
  ObjectHead,
  ObjectHttpMetadata,
  ObjectListOptions,
  ObjectListResult,
  ObjectMetadata,
  ObjectPutResult,
  ObjectStorePort,
  PortableBody,
  PreparedStatementPort,
  QueryResult,
  QueueMessage,
  QueueBatchOptions,
  QueueMetricsSnapshot,
  QueueProducerPort,
  QueueSendOptions,
  QueueSendReceipt,
  RuntimeCapabilities,
  RuntimeProfile,
  RuntimeServices,
  SchedulerPort,
  SearchPort,
  SecretStorePort,
  WorkflowInstancePort,
  WorkflowPort,
  WorkflowStatus,
  WorkflowStatusName,
  WorkspacePort,
} from "./ports";
import { RuntimeProfileError, runtimeProfileDefinition } from "./profiles";

function queryResult<T>(result: D1Result<T>): QueryResult<T> {
  return {
    success: result.success,
    results: result.results,
    meta: result.meta,
  };
}

export class CloudflareD1PreparedStatement implements PreparedStatementPort {
  constructor(
    readonly native: D1PreparedStatement,
    readonly owner: CloudflareD1Database,
  ) {}

  bind(...values: DatabaseScalar[]): CloudflareD1PreparedStatement {
    return new CloudflareD1PreparedStatement(this.native.bind(...values), this.owner);
  }

  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    return column === undefined ? this.native.first<T>() : this.native.first<T>(column);
  }

  async all<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    return queryResult(await this.native.all<T>());
  }

  async run<T = Record<string, unknown>>(): Promise<QueryResult<T>> {
    return queryResult(await this.native.run<T>());
  }

  raw<T = unknown[]>(): Promise<T[]> {
    return this.native.raw<T>();
  }
}

export class CloudflareD1Database implements DatabasePort {
  constructor(readonly native: D1Database) {}

  prepare(sql: string): CloudflareD1PreparedStatement {
    return new CloudflareD1PreparedStatement(this.native.prepare(sql), this);
  }

  async batch<T = Record<string, unknown>>(statements: PreparedStatementPort[]): Promise<QueryResult<T>[]> {
    const nativeStatements = statements.map((statement) => {
      if (!(statement instanceof CloudflareD1PreparedStatement) || statement.owner !== this) {
        throw new TypeError("Cloudflare D1 batches require statements prepared by the same runtime adapter");
      }
      return statement.native;
    });
    return (await this.native.batch<T>(nativeStatements)).map(queryResult);
  }

  async exec(sql: string): Promise<QueryResult> {
    const result = await this.native.exec(sql);
    return {
      success: true,
      results: [],
      meta: { count: result.count, duration: result.duration },
    };
  }
}

function httpMetadata(metadata: R2HTTPMetadata | undefined): ObjectHttpMetadata | undefined {
  if (!metadata) return undefined;
  return {
    contentType: metadata.contentType,
    contentLanguage: metadata.contentLanguage,
    contentDisposition: metadata.contentDisposition,
    contentEncoding: metadata.contentEncoding,
    cacheControl: metadata.cacheControl,
    cacheExpiry: metadata.cacheExpiry,
  };
}

function objectHead(object: R2Object): ObjectHead {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded,
    httpMetadata: httpMetadata(object.httpMetadata),
    customMetadata: object.customMetadata,
  };
}

function objectBody(object: R2ObjectBody): ObjectBody {
  return {
    ...objectHead(object),
    body: object.body,
    text: () => object.text(),
    json: <T = unknown>() => object.json<T>(),
    arrayBuffer: () => object.arrayBuffer(),
  };
}

export class CloudflareR2ObjectStore implements ObjectStorePort {
  constructor(readonly native: R2Bucket) {}

  async put(key: string, value: PortableBody, options?: ObjectMetadata): Promise<ObjectPutResult> {
    const result = await this.native.put(key, value, options);
    return result ? { stored: true, etag: result.etag } : { stored: false };
  }

  async get(key: string): Promise<ObjectBody | null> {
    const object = await this.native.get(key);
    return object ? objectBody(object) : null;
  }

  delete(key: string): Promise<void> {
    return this.native.delete(key);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const object = await this.native.head(key);
    return object ? objectHead(object) : null;
  }

  async list(options?: ObjectListOptions): Promise<ObjectListResult> {
    const result = await this.native.list(options);
    return {
      objects: result.objects.map(objectHead),
      truncated: result.truncated,
      ...(result.truncated ? { cursor: result.cursor } : {}),
    };
  }
}

export class CloudflareQueueProducerPort<T> implements QueueProducerPort<T> {
  constructor(readonly native: Queue<T>) {}

  async send(body: T, options?: QueueSendOptions): Promise<QueueSendReceipt> {
    const response = await this.native.send(body, options);
    return { metrics: response.metadata.metrics };
  }

  async sendBatch(messages: QueueMessage<T>[], options?: QueueBatchOptions): Promise<QueueSendReceipt> {
    const response = await this.native.sendBatch(messages, options);
    return { metrics: response.metadata.metrics };
  }

  metrics(): Promise<QueueMetricsSnapshot> {
    return this.native.metrics();
  }
}

class CloudflareWorkflowInstance implements WorkflowInstancePort {
  readonly id: string;

  constructor(private readonly native: WorkflowInstance) {
    this.id = native.id;
  }

  async status(): Promise<WorkflowStatus> {
    const result = await this.native.status();
    const current = result.status as string;
    const known: readonly WorkflowStatusName[] = [
      "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
    ];
    return {
      ...result,
      status: known.includes(current as WorkflowStatusName) ? current as WorkflowStatusName : "unknown",
    };
  }

  cancel(): Promise<void> {
    return this.native.terminate();
  }
}

export class CloudflareWorkflowPort<P> implements WorkflowPort<P> {
  constructor(readonly native: Workflow<P>) {}

  async create(input: { id?: string; params?: P }): Promise<WorkflowInstancePort> {
    return new CloudflareWorkflowInstance(await this.native.create(input));
  }

  async get(id: string): Promise<WorkflowInstancePort> {
    return new CloudflareWorkflowInstance(await this.native.get(id));
  }
}

export class CloudflareAssetPort implements AssetPort {
  constructor(readonly native: Fetcher) {}

  fetch(request: Request): Promise<Response> {
    return this.native.fetch(request);
  }
}

export class CloudflareEnvironmentSecretStore implements SecretStorePort {
  readonly mutable = false;

  constructor(private readonly bindings: object) {}

  async get(name: string): Promise<string | null> {
    const value = (this.bindings as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  }
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

export class CloudflareIngressPort implements IngressPort {
  constructor(private readonly baseUrl: string | null) {}

  async publicUrl(): Promise<string | null> {
    return this.baseUrl;
  }

  async health(): Promise<IngressHealth> {
    return {
      ok: Boolean(this.baseUrl),
      mode: "workers-https",
      ...(this.baseUrl ? { publicUrl: this.baseUrl } : { detail: "deployment URL is resolved by the platform" }),
    };
  }
}

interface CloudflareQueueBodies {
  ingest: IngestMessage;
  deadLetter: IngestMessage;
  quarantine: IngestMessage;
}

interface CloudflareWorkflowParams {
  mission: MissionWorkflowParams;
  memory: MemoryGraphWorkflowParams;
  routine: IntelligenceRoutineWorkflowParams;
}

export type CloudflareRuntimeServices = RuntimeServices<CloudflareQueueBodies, CloudflareWorkflowParams>;

export interface CloudflareRuntimeOptions {
  profile?: RuntimeProfile;
  browser?: BrowserPort;
  workspace?: WorkspacePort;
  scheduler?: SchedulerPort;
  search?: SearchPort;
  mail?: MailPort;
  notifications?: NotificationPort;
  ingress?: IngressPort;
  clock?: ClockPort;
}

function capability(
  platformAvailable: boolean,
  facadeIntegrated: boolean,
  requiredForProfile: boolean,
  detail: string,
) {
  return Object.freeze({ platformAvailable, facadeIntegrated, requiredForProfile, health: "not-checked" as const, detail });
}

function cloudflareCapabilities(env: Env, options: CloudflareRuntimeOptions): RuntimeCapabilities {
  return {
    database: capability(Boolean(env.DB), true, true, "D1 binding; health belongs to request readiness"),
    objects: capability(Boolean(env.EVIDENCE), true, true, "R2 binding; health belongs to request readiness"),
    queue: capability(Boolean(env.INGEST_QUEUE && env.INGEST_DLQ && env.INGEST_QUARANTINE), true, true, "Cloudflare Queue producer bindings"),
    workflows: capability(Boolean(env.MISSION_WORKFLOW && env.MEMORY_WORKFLOW && env.ROUTINE_WORKFLOW), true, true, "Cloudflare Workflow client bindings"),
    scheduler: capability(true, Boolean(options.scheduler), true, "Worker scheduled handler exists; scheduler façade extraction is pending"),
    workspace: capability(Boolean(env.MISSION_COMPUTER), Boolean(options.workspace), true, "one Mission Computer Durable Object per Mission; façade extraction is pending"),
    browser: capability(Boolean(env.BROWSER), Boolean(options.browser), false, "optional Kitesurf and Chromium fallbacks; direct HTTP remains available"),
    search: capability(Boolean(env.AI_SEARCH), Boolean(options.search), false, "AI Search is an opt-in rebuildable projection"),
    assets: capability(Boolean(env.ASSETS), true, true, "Workers Assets binding"),
    mail: capability(false, Boolean(options.mail), false, "Email routing is optional and not discoverable from Worker bindings"),
    notifications: capability(false, Boolean(options.notifications), false, "outbound notifications are optional"),
    secrets: capability(Boolean(env.DRIFTGLASS_SECRET), true, true, "allowlisted read-only Worker secret bindings"),
    ingress: capability(true, true, true, "Workers HTTPS; URL health is checked separately"),
  };
}

function cloudflareSecrets(env: Env): Record<string, string | undefined> {
  return {
    DRIFTGLASS_SECRET: env.DRIFTGLASS_SECRET,
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    OPENALEX_API_KEY: env.OPENALEX_API_KEY,
    DEEP_DIVE_LAB_TOKEN: env.DEEP_DIVE_LAB_TOKEN,
  };
}

/**
 * Build the Cloudflare façade without changing the current Worker entrypoint.
 * A future local factory must verify a persisted canonical-authority receipt.
 * No self-host or hybrid factory exists in Phase 1.
 */
export function createCloudflareRuntime(env: Env, options: CloudflareRuntimeOptions = {}): CloudflareRuntimeServices {
  if (options.profile !== undefined && options.profile !== "cloudflare") {
    throw new RuntimeProfileError(
      `Runtime profile \"${options.profile}\" is unavailable; Cloudflare is the sole current writable factory`,
    );
  }
  const profile = runtimeProfileDefinition("cloudflare");
  const ingress = options.ingress ?? new CloudflareIngressPort(env.PUBLIC_BASE_URL || null);
  return Object.freeze({
    profile: profile.id,
    canonicalState: profile.canonicalState,
    experimental: profile.experimental,
    authority: Object.freeze({
      mode: "platform-binding" as const,
      profile: "cloudflare" as const,
      canonicalState: "cloudflare" as const,
      writable: true as const,
    }),
    database: new CloudflareD1Database(env.DB),
    objects: new CloudflareR2ObjectStore(env.EVIDENCE),
    queues: Object.freeze({
      ingest: new CloudflareQueueProducerPort<IngestMessage>(env.INGEST_QUEUE),
      deadLetter: new CloudflareQueueProducerPort<IngestMessage>(env.INGEST_DLQ),
      quarantine: new CloudflareQueueProducerPort<IngestMessage>(env.INGEST_QUARANTINE),
    }),
    workflows: Object.freeze({
      mission: new CloudflareWorkflowPort(env.MISSION_WORKFLOW),
      memory: new CloudflareWorkflowPort(env.MEMORY_WORKFLOW),
      routine: new CloudflareWorkflowPort(env.ROUTINE_WORKFLOW),
    }),
    assets: new CloudflareAssetPort(env.ASSETS),
    secrets: new CloudflareEnvironmentSecretStore(cloudflareSecrets(env)),
    ingress,
    clock: options.clock ?? new SystemClock(),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.mail ? { mail: options.mail } : {}),
    ...(options.notifications ? { notifications: options.notifications } : {}),
    capabilities: Object.freeze(cloudflareCapabilities(env, options)),
  });
}
