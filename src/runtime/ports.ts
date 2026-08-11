/**
 * Runtime-neutral contracts for Driftglass infrastructure.
 *
 * Keep these interfaces free of Cloudflare and Node implementation types. The
 * current Worker continues to use its native bindings directly while domain
 * seams are migrated incrementally behind these contracts.
 */

export type RuntimeProfile = "cloudflare" | "selfhost" | "hybrid-local-canonical";
export type CanonicalStateLocation = "cloudflare" | "local";

export interface CanonicalMigrationManifest {
  readonly version: 1;
  readonly migrationId: string;
  readonly fromProfile: RuntimeProfile | "empty";
  readonly toProfile: RuntimeProfile;
  readonly fromCanonicalState: CanonicalStateLocation | "empty";
  readonly toCanonicalState: CanonicalStateLocation;
  readonly schemaVersion: number;
  readonly migrationHead: string;
  readonly sourceManifestSha256: string;
  readonly importedManifestSha256: string;
  readonly targetInstanceId: string;
  readonly verifiedAt: string;
}

export interface CanonicalAuthorityReceipt extends CanonicalMigrationManifest {
  /** SHA-256 over the canonical JSON form of every other receipt field. */
  readonly receiptSha256: string;
}

export type RuntimeAuthority =
  | {
      readonly mode: "platform-binding";
      readonly profile: "cloudflare";
      readonly canonicalState: "cloudflare";
      readonly writable: true;
    }
  | {
      readonly mode: "verified-receipt";
      readonly profile: "selfhost" | "hybrid-local-canonical";
      readonly canonicalState: "local";
      readonly writable: true;
      readonly receipt: CanonicalAuthorityReceipt;
    };

export type DatabaseScalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

export interface QueryResult<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: Record<string, unknown>;
  error?: string;
}

export interface PreparedStatementPort {
  bind(...values: DatabaseScalar[]): PreparedStatementPort;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
  run<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface DatabasePort {
  prepare(sql: string): PreparedStatementPort;
  batch<T = Record<string, unknown>>(statements: PreparedStatementPort[]): Promise<QueryResult<T>[]>;
  exec(sql: string): Promise<QueryResult>;
}

export type PortableBody = string | Uint8Array | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>;

export interface ObjectHttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface ObjectMetadata {
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
  onlyIf?: {
    etagMatches?: string;
    etagDoesNotMatch?: string;
    uploadedBefore?: Date;
    uploadedAfter?: Date;
  };
}

export interface ObjectBody {
  key: string;
  size: number;
  etag?: string;
  uploaded?: Date;
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface ObjectHead {
  key: string;
  size: number;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface ObjectListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ObjectListResult {
  objects: ObjectHead[];
  truncated: boolean;
  cursor?: string;
}

export interface ObjectPutResult {
  stored: boolean;
  etag?: string;
}

export interface ObjectStorePort {
  put(key: string, value: PortableBody, options?: ObjectMetadata): Promise<ObjectPutResult>;
  get(key: string): Promise<ObjectBody | null>;
  delete(key: string): Promise<void>;
  head?(key: string): Promise<ObjectHead | null>;
  list?(options?: ObjectListOptions): Promise<ObjectListResult>;
}

export interface QueueSendOptions {
  contentType?: "text" | "bytes" | "json" | "v8";
  delaySeconds?: number;
}

export interface QueueBatchOptions {
  delaySeconds?: number;
}

export interface QueueMessage<T> {
  body: T;
  contentType?: QueueSendOptions["contentType"];
  delaySeconds?: number;
}

export interface QueueMetricsSnapshot {
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestamp?: Date;
}

export interface QueueSendReceipt {
  id?: string;
  created?: boolean;
  metrics?: QueueMetricsSnapshot;
}

/** Producer/client surface only. Lease, ack, retry, and DLQ belong to a worker port in Phase 4. */
export interface QueueProducerPort<T = unknown> {
  send(body: T, options?: QueueSendOptions): Promise<QueueSendReceipt>;
  sendBatch(messages: QueueMessage<T>[], options?: QueueBatchOptions): Promise<QueueSendReceipt>;
  metrics?(): Promise<QueueMetricsSnapshot>;
}

export type WorkflowStatusName =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export interface WorkflowStatus {
  status: WorkflowStatusName;
  error?: { name?: string; message: string };
  output?: unknown;
}

export interface WorkflowInstancePort {
  readonly id: string;
  status(): Promise<WorkflowStatus>;
  cancel?(): Promise<void>;
}

export interface WorkflowPort<P = unknown> {
  create(input: { id?: string; params?: P }): Promise<WorkflowInstancePort>;
  get?(id: string): Promise<WorkflowInstancePort>;
}

export interface JobSpec {
  type: string;
  payload?: unknown;
}

export interface SchedulerPort {
  registerInterval(id: string, minutes: number, job: JobSpec): Promise<void>;
  registerAt(id: string, at: Date, job: JobSpec): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface WorkspaceEntry {
  name: string;
  isDirectory: boolean;
}

export interface WorkspaceGrepHit {
  path: string;
  line?: number;
  text?: string;
}

export interface WorkspaceArchive {
  readonly version: 1;
  readonly missionId: string;
  readonly sourceProfile: RuntimeProfile;
  readonly sourceCanonicalState: CanonicalStateLocation;
  readonly schemaVersion: number;
  readonly migrationHead: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly body: Uint8Array;
    readonly size: number;
    readonly sha256: string;
    readonly updatedAt?: string;
  }>;
  readonly manifestSha256: string;
}

export interface Workspace {
  fs: {
    readFile(path: string, encoding?: "utf8"): Promise<string | Uint8Array>;
    writeFile(path: string, data: PortableBody): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<WorkspaceEntry[]>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    grep(query: string, path?: string): Promise<WorkspaceGrepHit[]>;
  };
  runtime?: {
    exec(command: string, options?: Record<string, unknown>): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs?: number;
    }>;
  };
  export(): Promise<WorkspaceArchive>;
  import(archive: WorkspaceArchive): Promise<void>;
}

export interface WorkspacePort {
  forMission(missionId: string): Promise<Workspace>;
}

export interface BrowserRenderOptions {
  selector?: string;
  includeLinks?: boolean;
  strategy?: "adaptive" | "direct" | "lightweight" | "full-browser";
  timeoutMs?: number;
  privacy?: "local-only" | "cloud-allowed";
}

export interface BrowserRenderResult {
  engine: string;
  ok: boolean;
  status?: number;
  finalUrl?: string;
  title?: string;
  text: string;
  html?: string;
  degraded?: boolean;
  elapsedMs?: number;
  attempts?: Array<Record<string, unknown>>;
}

export interface BrowserPort {
  render(url: URL, options?: BrowserRenderOptions): Promise<BrowserRenderResult>;
}

export interface SearchDocument {
  id: string;
  kind?: string;
  title?: string;
  body?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score?: number;
  document?: SearchDocument;
  metadata?: Record<string, unknown>;
}

export interface SearchPort {
  upsert(document: SearchDocument): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: string, options?: { kind?: string; limit?: number }): Promise<SearchResult[]>;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; contentType?: string; body: PortableBody }>;
}

export interface NotificationPort {
  send(message: MailMessage): Promise<{ id?: string }>;
}

export interface MailPort extends NotificationPort {
  poll?(options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

export interface SecretStorePort {
  readonly mutable: boolean;
  get(name: string): Promise<string | null>;
  set?(name: string, value: string): Promise<void>;
  delete?(name: string): Promise<void>;
}

export interface AssetPort {
  fetch(request: Request): Promise<Response>;
}

export interface IngressHealth {
  ok: boolean;
  mode: string;
  publicUrl?: string;
  detail?: string;
}

export interface IngressPort {
  publicUrl(): Promise<string | null>;
  health(): Promise<IngressHealth>;
}

export interface ClockPort {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RuntimeCapabilityState {
  readonly platformAvailable: boolean;
  readonly facadeIntegrated: boolean;
  readonly requiredForProfile: boolean;
  readonly health: "not-checked" | "healthy" | "unhealthy";
  readonly detail: string;
}

export interface RuntimeCapabilities {
  database: RuntimeCapabilityState;
  objects: RuntimeCapabilityState;
  queue: RuntimeCapabilityState;
  workflows: RuntimeCapabilityState;
  scheduler: RuntimeCapabilityState;
  workspace: RuntimeCapabilityState;
  browser: RuntimeCapabilityState;
  search: RuntimeCapabilityState;
  assets: RuntimeCapabilityState;
  mail: RuntimeCapabilityState;
  notifications: RuntimeCapabilityState;
  secrets: RuntimeCapabilityState;
  ingress: RuntimeCapabilityState;
}

export interface RuntimeServices<
  QueueBodies extends object = object,
  WorkflowParams extends object = object,
> {
  readonly profile: RuntimeProfile;
  readonly canonicalState: CanonicalStateLocation;
  readonly experimental: boolean;
  readonly authority: RuntimeAuthority;
  readonly database: DatabasePort;
  readonly objects: ObjectStorePort;
  readonly queues: { readonly [K in keyof QueueBodies]: QueueProducerPort<QueueBodies[K]> };
  readonly workflows: { readonly [K in keyof WorkflowParams]: WorkflowPort<WorkflowParams[K]> };
  readonly assets: AssetPort;
  readonly secrets: SecretStorePort;
  readonly ingress: IngressPort;
  readonly clock: ClockPort;
  readonly scheduler?: SchedulerPort;
  readonly workspace?: WorkspacePort;
  readonly browser?: BrowserPort;
  readonly search?: SearchPort;
  readonly mail?: MailPort;
  readonly notifications?: NotificationPort;
  readonly capabilities: RuntimeCapabilities;
}
