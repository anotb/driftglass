
export type MemoryNodeType = "story" | "mission" | "source" | "entity" | "claim" | "finding" | "decision" | "question" | "expectation" | "event" | "preference" | "pack" | "outcome";
export type MemoryNodeStatus = "active" | "superseded" | "resolved" | "retracted" | "archived";
export type MemoryRelation =
  | "observed_in"
  | "relevant_to"
  | "mentions"
  | "tracks"
  | "asks"
  | "updates"
  | "resolves"
  | "contradicts"
  | "supports"
  | "related_to"
  | "defined_by"
  | "contains"
  | "supersedes"
  | "depends_on"
  | "caused_by"
  | "answers"
  | "prefers"
  | "about"
  | "expects"
  | "evidence_for"
  | "evidence_against"
  | "derived_from";

export interface MemoryNodeRecord {
  id: string;
  node_type: MemoryNodeType;
  canonical_key: string;
  label: string;
  summary: string;
  aliases_json: string;
  metadata_json: string;
  importance: number;
  confidence: number;
  occurred_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  status: MemoryNodeStatus;
  superseded_by: string | null;
  source_ref: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

export interface MemoryEdgeRecord {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relation: MemoryRelation;
  weight: number;
  confidence: number;
  evidence_json: string;
  metadata_json: string;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  status: "active" | "superseded" | "retracted";
  rationale: string;
}

export interface MemoryPatchNode {
  key: string;
  type: MemoryNodeType;
  label: string;
  summary?: string;
  aliases?: string[];
  importance?: number;
  confidence?: number;
  occurredAt?: string | null;
  sourceRef?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryPatchEdge {
  from: string;
  to: string;
  relation: MemoryRelation;
  weight?: number;
  confidence?: number;
  rationale?: string;
  evidence?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryPatch {
  schemaVersion: "1";
  title: string;
  nodes: MemoryPatchNode[];
  edges: MemoryPatchEdge[];
  supersede?: Array<{ node: string; by?: string; reason?: string }>;
}

export interface MemoryProposalRecord {
  id: string;
  scope_kind: "global" | "mission" | "story" | "pack";
  scope_id: string | null;
  provider: string;
  title: string;
  patch_json: string;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

export interface IntelligencePackEntity {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  description?: string;
  importance?: number;
}

export type EvidenceRole = "primary" | "authoritative" | "independent" | "practitioner" | "discovery" | "context";

export interface IntelligencePackEvidencePolicy {
  minPrimarySources?: number;
  minIndependentSources?: number;
  maxDiscoveryShare?: number;
  maxEvidenceAgeHours?: number;
  preferredDomains?: string[];
}

export type RuntimeKind = "worker" | "kitesurf" | "chromium" | "computer" | "companion";
export type RuntimeTaskKind = "collect" | "render" | "browse" | "transform" | "compare" | "compile-context" | "inspect" | "publish";
export type RuntimeAccess = "public" | "authenticated" | "private";
export type RuntimePersistence = "none" | "session" | "mission";

export interface RuntimeTaskSpec {
  id?: string;
  kind: RuntimeTaskKind;
  description?: string;
  access?: RuntimeAccess;
  persistence?: RuntimePersistence;
  missionId?: string;
  sourceId?: string;
  requiresBrowser?: boolean;
  requiresFiles?: boolean;
  requiresHumanIntervention?: boolean;
  multiStep?: boolean;
  publicFallback?: boolean;
  preferredRuntime?: RuntimeKind | "auto";
  estimatedBrowserMs?: number;
  estimatedWorkflowSteps?: number;
}

export interface RuntimeCandidate {
  runtime: RuntimeKind;
  mode: string;
  available: boolean;
  score: number;
  estimatedClass: "free" | "cheap" | "metered";
  reasons: string[];
  requirements: string[];
}

export interface RuntimePlan {
  schemaVersion: "1";
  task: RuntimeTaskSpec;
  primary: RuntimeCandidate | null;
  fallbacks: RuntimeCandidate[];
  blocked: boolean;
  cloudOnly: boolean;
  companionOptional: boolean;
  rationale: string[];
  generatedAt: string;
}

export type IntelligenceRoutineAction =
  | "refresh-sources"
  | "wait-for-ingest"
  | "rebuild-mission"
  | "sync-computer"
  | "audit-memory"
  | "compile-context"
  | "prepare-research"
  | "checkpoint-memory";

export interface IntelligenceRoutineStep {
  id: string;
  name?: string;
  action: IntelligenceRoutineAction;
  runtime?: RuntimeKind | "auto";
  optional?: boolean;
  sourceIds?: string[];
  waitSeconds?: number;
  reasoningTask?: ReasoningTask;
  target?: ReasoningTarget;
  args?: Record<string, unknown>;
}

export interface IntelligenceRoutineDefinition {
  id: string;
  name: string;
  description?: string;
  missionId?: string;
  enabled?: boolean;
  scheduleMinutes?: number | null;
  budgetClass?: "light" | "standard" | "deep";
  trigger?: "manual" | "scheduled" | "evidence-change" | "expected-event";
  steps: IntelligenceRoutineStep[];
}

export interface IntelligenceRoutineRecord {
  id: string;
  pack_id: string | null;
  mission_id: string | null;
  name: string;
  description: string;
  definition_json: string;
  enabled: number;
  schedule_minutes: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntelligenceRoutineRunRecord {
  id: string;
  routine_id: string;
  workflow_id: string | null;
  status: "queued" | "running" | "complete" | "partial" | "deferred" | "failed";
  plan_json: string;
  result_json: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntelligenceRoutineWorkflowParams {
  runId: string;
  routineId: string;
  trigger?: "manual" | "scheduled" | "pack" | "model";
  requestedAt?: string;
}

export interface MemoryCheckpointRecord {
  id: string;
  scope_kind: "global" | "mission" | "story" | "pack";
  scope_id: string | null;
  title: string;
  reason: string;
  snapshot_r2_key: string;
  snapshot_hash: string;
  summary_json: string;
  diff_json: string;
  created_at: string;
}

export interface ReasoningReceiptRecord {
  id: string;
  scope_kind: "global" | "mission" | "story" | "pack";
  scope_id: string | null;
  task: ReasoningTask;
  target: ReasoningTarget;
  title: string;
  objective: string;
  bundle_version: number;
  bundle_hash: string;
  bundle_r2_key: string;
  quality_json: string;
  estimated_tokens: number;
  evidence_count: number;
  independent_family_count: number;
  provider_label: string | null;
  model_label: string | null;
  result_json: string;
  result_r2_key: string | null;
  confidence: number | null;
  citations_json: string;
  decision_note: string | null;
  status: "prepared" | "completed" | "reviewed" | "rejected" | "archived";
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReasoningRunRecord {
  id: string;
  receipt_id: string;
  provider_label: string;
  model_label: string | null;
  client_label: string | null;
  status: "started" | "completed" | "reviewed" | "rejected" | "failed";
  response_hash: string | null;
  response_r2_key: string | null;
  response_summary: string;
  structured_result_json: string;
  audit_json: string;
  outcome_json: string;
  confidence: number | null;
  rating: number | null;
  memory_proposal_id: string | null;
  started_at: string;
  completed_at: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReasoningRunEventRecord {
  id: string;
  run_id: string;
  event_type: "started" | "completed" | "reviewed" | "rejected" | "failed" | "rated" | "memory-proposed";
  detail_json: string;
  created_at: string;
}

export interface IntelligencePackOverlayPatch {
  disableSources?: string[];
  sourceOverrides?: Record<string, Partial<{ name: string; config: Record<string, unknown>; scheduleMinutes: number; weight: number; enabled: boolean }>>;
  addSources?: StarterPack["sources"];
  disableMissions?: string[];
  missionOverrides?: Record<string, Record<string, unknown>>;
  addMissions?: NonNullable<IntelligencePackManifest["missions"]>;
  evidencePolicy?: Partial<IntelligencePackEvidencePolicy>;
  reasoning?: Partial<NonNullable<IntelligencePackManifest["reasoning"]>>;
  budget?: Partial<NonNullable<IntelligencePackManifest["budget"]>>;
  addInterestTerms?: string[];
  removeInterestTerms?: string[];
}

export interface IntelligencePackOverlayRecord {
  id: string;
  base_pack_id: string;
  name: string;
  description: string;
  base_version: string;
  overlay_json: string;
  status: "active" | "conflicted" | "disabled";
  conflicts_json: string;
  created_at: string;
  updated_at: string;
}

export interface IntelligencePackManifest {
  driftglassPack: "2" | "3";
  id: string;
  version: string;
  name: string;
  description: string;
  author?: string;
  homepage?: string;
  updateUrl?: string;
  category?: string;
  icon?: string;
  featured?: boolean;
  requiresCompanion?: boolean;
  sources?: StarterPack["sources"];
  cloudSources?: StarterPack["sources"];
  companionSources?: StarterPack["sources"];
  missions?: Array<{
    id: string;
    name: string;
    question?: string;
    terms?: string[];
    sourceScope?: string[];
    status?: "active" | "paused" | "complete";
    priority?: number;
    cadenceMinutes?: number;
    mode?: MissionMode;
    researchPolicy?: MissionResearchPolicy;
    sprintPolicy?: MissionSprintPolicy;
    alertThreshold?: number;
    expectedNextEvent?: string;
    expectedBy?: string | null;
    reminderLeadDays?: number;
  }>;
  views?: Array<{ id: string; name: string; query: string; filters?: Record<string, unknown> }>;
  memory?: {
    entities?: IntelligencePackEntity[];
    claims?: Array<{ id: string; title: string; summary: string; confidence?: number; importance?: number; validFrom?: string; validTo?: string }>;
    findings?: Array<{ id: string; title: string; summary: string; confidence?: number; importance?: number }>;
    questions?: Array<{ id: string; title: string; summary?: string; importance?: number }>;
    expectations?: Array<{ id: string; title: string; summary?: string; expectedBy?: string; confidence?: number; importance?: number }>;
    relations?: Array<{ from: string; to: string; relation: MemoryRelation; weight?: number; confidence?: number; rationale?: string }>;
  };
  reasoning?: {
    skill?: { name?: string; description?: string; instructions: string; references?: Array<{ name: string; content: string }> };
    briefingContract?: string[];
    researchPlaybooks?: Array<{ id: string; name: string; task?: ReasoningTask; instructions: string; trigger?: string }>;
    providerHints?: Partial<Record<"chatgpt" | "claude" | "grok" | "generic", string>>;
    outputContract?: string[];
  };
  routines?: IntelligenceRoutineDefinition[];
  lineage?: {
    forkedFrom?: string;
    upstreamPackId?: string;
    upstreamVersion?: string;
    sourceDropUrl?: string;
  };
  evidencePolicy?: IntelligencePackEvidencePolicy;
  budget?: { profile?: "free" | "cheap" | "custom"; maxSources?: number; browserMinutesPerDay?: number; workflowStepsPerDay?: number; projectedRunsPerDay?: number };
  interestTerms?: string[];
}

export interface IntelligencePackRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  icon: string;
  manifest_json: string;
  source_url: string | null;
  enabled: number;
  budget_profile: string;
  installed_at: string;
  updated_at: string;
}

export type BudgetProfileName = "free" | "cheap" | "custom";
export type ExecutionCapacity = "free-safe" | "expanded-confirmed";
export type UsageDimension =
  | "browser_ms"
  | "workflow_steps"
  | "ai_search_queries"
  | "memory_writes"
  | "source_runs"
  | "queue_messages"
  | "computer_sync_bytes"
  | "r2_class_a_ops"
  | "r2_class_b_ops"
  | "r2_write_bytes";

export interface UsageDailyRecord {
  day: string;
  dimension: UsageDimension;
  units: number;
  metadata_json: string;
  updated_at: string;
}

export type ReasoningTarget = "chatgpt" | "claude" | "grok" | "generic";
export type ReasoningTask = "daily-brief" | "investigate" | "decision" | "challenge" | "deep-research" | "memory-update";
export type ReasoningSourceScope = "open" | "personal" | "share";

export interface ReasoningBundle {
  schemaVersion: "2" | "3";
  generatedAt: string;
  target: ReasoningTarget;
  task: ReasoningTask;
  sourceScope: ReasoningSourceScope;
  title: string;
  objective: string;
  tokenBudget: number;
  mission?: { id: string; name: string; question: string; currentThesis?: string; expectedNextEvent?: string };
  executiveContext: string[];
  memory: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    timeline: Array<Record<string, unknown>>;
    rationale: string[];
  };
  evidence: Array<Record<string, unknown>>;
  coverage: {
    evidenceCount: number;
    storyCount: number;
    sourceCount: number;
    sourceFamilyCount: number;
    independentFamilyCount: number;
    echoCount: number;
    echoShare: number;
    sourceFamilies: string[];
    sourceKinds: string[];
    sourceRoles: Record<string, number>;
    primarySourceCount: number;
    independentSourceCount: number;
    discoveryShare: number;
    cloudEvidenceCount: number;
    localEvidenceCount: number;
    newestAt?: string;
    oldestAt?: string;
    freshnessHours?: number;
  };
  relevantPacks: Array<{ id: string; name: string; version: string; evidencePolicy?: IntelligencePackEvidencePolicy }>;
  contextBudget: {
    estimatedTokens: number;
    sectionChars: Record<string, number>;
    truncatedSections: string[];
    /** Added in schema v3. Older saved v2/v3 bundles may not contain it. */
    evidenceSelection?: {
      storyWindowLimit: number;
      evidenceWindowLimit: number;
      contextWindowStoryCount: number;
      contextWindowEvidenceCount: number;
      contextWindowSourceCount: number;
      preprocessingOmittedEvidenceCount: number;
      preprocessingOmittedSourceCount: number;
      eligibleCandidateEvidenceCount: number;
      eligibleCandidateSourceCount: number;
      selectedCandidateEvidenceCount: number;
      selectedCandidateSourceCount: number;
      fittingOmittedEvidenceCount: number;
      fittingOmittedSourceCount: number;
      clippedExcerptCount: number;
      hasMoreStories: boolean;
      hasMoreEvidence: boolean;
    };
  };
  quality: {
    score: number;
    grade: "insufficient" | "usable" | "strong";
    dimensions: {
      evidenceDepth: number;
      sourceDiversity: number;
      provenance: number;
      memoryContinuity: number;
      recency: number;
      challengeCoverage: number;
      cloudIndependence: number;
      echoResistance: number;
    };
    blockers: string[];
    recommendations: string[];
    deepResearchRecommended: boolean;
  };
  contradictions: Array<Record<string, unknown>>;
  gaps: string[];
  openQuestions: string[];
  playbooks: Array<{ id: string; name: string; instructions: string }>;
  instructions: string[];
  outputContract: string[];
  /** Optional machine-readable structured-result contract. Historical receipts may omit it. */
  resultContract?: Record<string, unknown>;
  memoryPatchContract: Record<string, unknown>;
  mcpUrl?: string;
  operationsMcpUrl?: string;
  packetUrl?: string;
  receiptId?: string;
}

export interface ReasoningPlaybookRecord {
  id: string;
  pack_id: string | null;
  name: string;
  task: ReasoningTask;
  instructions: string;
  trigger_json: string;
  provider_hints_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface IntelligencePackPreview {
  packId: string;
  name: string;
  sourceCount: number;
  cloudSourceCount: number;
  immediatelyRunnableCloudSourceCount: number;
  credentialDeferredSourceCount: number;
  companionSourceCount: number;
  cloudCoverage: number;
  projectedSourceRunsPerDay: number;
  projectedQueueMessagesPerDay: number;
  projectedBrowserMinutesPerDay: number;
  projectedWorkflowStepsPerDay: number;
  memorySeedWrites: number;
  estimatedInstallQueries: number;
  installFitsInvocation: boolean;
  withCompanionEstimatedInstallQueries: number;
  withCompanionInstallFitsInvocation: boolean;
  withCompanionSourceRunsPerDay: number;
  withCompanionQueueMessagesPerDay: number;
  withCompanionBrowserMinutesPerDay: number;
  withCompanionWorkflowStepsPerDay: number;
  profile: BudgetProfileName;
  fitsProfile: boolean;
  fitsWithCompanion: boolean;
  evidencePolicy?: IntelligencePackEvidencePolicy;
  warnings: string[];
  companionWarnings: string[];
  routineCount?: number;
  projectedRoutineStepsPerDay?: number;
}
export type SourceKind =
  | "hackernews"
  | "lobsters"
  | "bluesky"
  | "arxiv"
  | "github_releases"
  | "github_activity"
  | "openalex"
  | "npm_releases"
  | "pypi_releases"
  | "web"
  | "web_feed"
  | "collector"
  | "email"
  | "manual";

export type AccessClass = "public" | "authenticated-local" | "subscriber-local" | "private";
export type RenderEngine = "direct" | "kitesurf" | "chromium";
export type RenderStrategy = "adaptive" | "direct" | "kitesurf" | "chromium";

export interface RenderProfile {
  hostname: string;
  preferred_engine: "kitesurf" | "chromium";
  kitesurf_successes: number;
  kitesurf_failures: number;
  kitesurf_consecutive_failures: number;
  kitesurf_avg_ms: number | null;
  chromium_successes: number;
  chromium_failures: number;
  chromium_consecutive_failures: number;
  chromium_avg_ms: number | null;
  last_engine: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  updated_at: string;
}

export interface MissionSprintWorkflowParams {
  mode?: "sprint";
  runId: string;
  missionId: string;
  sourceIds?: string[];
}

export interface MissionMatchMaintenanceWorkflowParams {
  mode: "match-maintenance";
  missionId: string;
  reason: string;
}

export interface MissionComputerSyncWorkflowParams {
  mode: "computer-sync";
  missionId: string;
  reason: string;
}

export type MissionWorkflowParams =
  | MissionSprintWorkflowParams
  | MissionMatchMaintenanceWorkflowParams
  | MissionComputerSyncWorkflowParams;

export interface MissionRunRecord {
  id: string;
  mission_id: string;
  workflow_id: string | null;
  status: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled";
  source_ids_json: string;
  result_json: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryGraphWorkflowParams {
  runId: string;
  force?: boolean;
  maxStories?: number;
  requestedAt?: string;
}

export interface MemoryGraphRunRecord {
  id: string;
  status: "queued" | "running" | "complete" | "partial" | "deferred" | "failed";
  node_writes: number;
  edge_writes: number;
  details_json: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  workflow_id: string | null;
  profile: string;
  phase: string;
  updated_at: string;
}

export type Env = Omit<Cloudflare.Env, "INGEST_QUEUE" | "INGEST_DLQ" | "INGEST_QUARANTINE" | "OAUTH_KV" | "BROWSER"> & {
  INGEST_QUEUE: Queue<IngestMessage>;
  /** Exhausted primary messages; consumed by this Worker's bounded failure recorder. */
  INGEST_DLQ: Queue<IngestMessage>;
  /** Final bounded recovery consumer: D1 first, deterministic private R2 fallback second. */
  INGEST_QUARANTINE: Queue<IngestMessage>;
  /** Cloudflare-only token and grant storage for the direct /mcp connection. */
  OAUTH_KV?: KVNamespace;
  /** Optional rendered-page fallback. Direct HTTP source reading works without it. */
  BROWSER?: BrowserBinding;
  /** Optional deployment-local gate for a fixed public, read-only product example. */
  PUBLIC_SHOWCASE_MODE?: string;
  INGEST_QUEUE_NAME: string;
  INGEST_DLQ_NAME: string;
  INGEST_QUARANTINE_NAME: string;
  GITHUB_TOKEN?: string;
  /** Optional OpenAlex credential; never persisted in source configuration. */
  OPENALEX_API_KEY?: string;
  DEEP_DIVE_LAB_URL?: string;
  DEEP_DIVE_LAB_TOKEN?: string;
};


export type MissionMode = "watch" | "decision" | "hypothesis" | "event";
export type MissionResearchPolicy = "manual" | "suggest" | "always";
export type MissionSprintPolicy = "manual" | "scheduled";
export type MissionExpectedEventStatus = "pending" | "occurred" | "missed" | "rescheduled" | "none";
export type MissionOutcomeStatus = "open" | "resolved" | "invalidated" | "superseded";

export interface MissionOperatorRecord {
  mission_id: string;
  mode: MissionMode;
  research_policy: MissionResearchPolicy;
  alert_threshold: number;
  expected_next_event: string;
  expected_by: string | null;
  outcome_status: MissionOutcomeStatus;
  outcome_summary: string;
  resolved_at: string | null;
  last_escalated_at: string | null;
  sprint_policy: MissionSprintPolicy;
  next_sprint_at: string | null;
  last_sprint_at: string | null;
  reminder_lead_days: number;
  expected_event_status: MissionExpectedEventStatus;
  updated_at: string;
}

export interface MissionEventRecord {
  id: string;
  mission_id: string;
  event_type: "note" | "signal" | "expected-event" | "outcome" | "escalation" | "reminder" | "sprint" | "research-result";
  title: string;
  detail: string;
  story_id: string | null;
  metadata_json: string;
  dedupe_key?: string | null;
  occurred_at: string;
  created_at: string;
}

export interface MissionResearchStateRecord {
  mission_id: string;
  current_thesis: string;
  report_summary: string;
  open_questions_json: string;
  report_title: string;
  report_url: string | null;
  confidence: number | null;
  last_research_at: string | null;
  last_handoff_id: string | null;
  updated_at: string;
}

export interface ResearchResultImportRecord {
  id: string;
  mission_id: string;
  status: "pending" | "confirmed" | "rejected" | "expired";
  payload_json: string;
  diff_json: string;
  source: string;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
}

export interface MissionAction {
  id: string;
  kind: "research-result" | "expected-soon" | "expected-overdue" | "sprint-due" | "source-degraded" | "source-prerequisite" | "mission-resolved" | "reasoning-ready" | "decision-review" | "routine-failed" | "pack-conflict";
  severity: "info" | "attention" | "urgent";
  missionId?: string;
  missionName?: string;
  title: string;
  detail: string;
  dueAt?: string | null;
  action?: string;
  metadata?: Record<string, unknown>;
}

export interface MissionRecord {
  id: string;
  name: string;
  question: string;
  terms_json: string;
  source_scope_json: string;
  status: "active" | "paused" | "complete";
  priority: number;
  cadence_minutes: number;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MissionMatchRecord {
  mission_id: string;
  story_id: string;
  match_score: number;
  matched_terms_json: string;
  first_matched_at: string;
  last_matched_at: string;
}

export interface MissionBriefingSection {
  id: string;
  name: string;
  question: string;
  priority: number;
  mode: MissionMode;
  researchPolicy: MissionResearchPolicy;
  alertThreshold: number;
  expectedNextEvent: string;
  expectedBy: string | null;
  outcomeStatus: MissionOutcomeStatus;
  outcomeSummary: string;
  sprintPolicy: MissionSprintPolicy;
  nextSprintAt: string | null;
  expectedEventStatus: MissionExpectedEventStatus;
  researchBaseline: {
    currentThesis: string;
    reportSummary: string;
    openQuestions: string[];
    confidence: number | null;
    lastResearchAt: string | null;
  };
  escalationCandidate: boolean;
  matches: Array<{
    storyId: string;
    title: string;
    score: number;
    changedAt: string;
    matchScore: number;
    matchedTerms: string[];
  }>;
}

export interface PublicShareRecord {
  id: string;
  token_hash: string;
  kind: "story" | "mission" | "briefing";
  title: string;
  payload_json: string;
  expires_at: string;
  view_count: number;
  created_at: string;
}

export interface TasteTermRecord {
  term: string;
  weight: number;
  positive_count: number;
  negative_count: number;
  last_story_id: string | null;
  updated_at: string;
}

export interface TasteSourceRecord {
  source_id: string;
  source_name: string;
  source_kind: SourceKind;
  weight: number;
  positive_count: number;
  negative_count: number;
  updated_at: string;
}

export interface RankingExplanation {
  storyId: string;
  title: string;
  storedScore: number;
  effectiveScore: number;
  feedbackAdjustment: number;
  muted: boolean;
  components: Array<{
    id: string;
    label: string;
    raw: number;
    weight: number;
    contribution: number;
    explanation: string;
  }>;
  taste: {
    matchedPositive: Array<{ term: string; weight: number }>;
    matchedNegative: Array<{ term: string; weight: number }>;
    sourceSignals: Array<{ sourceId: string; sourceName: string; weight: number }>;
  };
  feedback: Array<{ action: string; note?: string; createdAt: string }>;
  missions: Array<{ id: string; name: string; matchScore: number; matchedTerms: string[] }>;
  reasons: string[];
}

export interface SourceCadenceRecord {
  source_id: string;
  mode: "fixed" | "adaptive";
  base_minutes: number;
  min_minutes: number;
  max_minutes: number;
  effective_minutes: number;
  next_run_at: string | null;
  yield_ema: number;
  latency_ema_ms: number;
  success_ema: number;
  empty_streak: number;
  failure_streak: number;
  high_signal_streak: number;
  last_reason: string;
  updated_at: string;
}

export interface EvidenceLineageRecord {
  item_id: string;
  story_id: string;
  family_key: string;
  origin_item_id: string | null;
  origin_family_key: string | null;
  relation: "origin" | "independent" | "same-family" | "echo" | "update";
  title_similarity: number;
  body_similarity: number;
  independent: number;
  rationale: string;
  created_at: string;
  updated_at: string;
}

export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  config_json: string;
  enabled: number;
  schedule_minutes: number;
  weight: number;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  health_score: number;
  created_at: string;
  updated_at: string;
}

export interface NormalizedItemInput {
  externalId?: string;
  url?: string;
  title: string;
  text?: string;
  author?: string;
  publishedAt?: string;
  observedAt?: string;
  accessClass?: AccessClass;
  metadata?: Record<string, unknown>;
  raw?: string;
}

export interface IngestMessageInput {
  sourceId: string;
  item: NormalizedItemInput;
  provider?: string;
  emailReceiptClaim?: EmailReceiptQueueClaim;
  sourceRunId?: string;
  sourceRunItemIndex?: number;
}

export interface EmailReceiptQueueClaim {
  messageId: string;
  claimToken: string;
}

export interface IngestPreparationProvenance {
  version: 1;
  queueMessageLimitBytes: number;
  originalTextBytes: number;
  queuedTextBytes: number;
  textTruncated: boolean;
  originalMetadataBytes: number;
  queuedMetadataBytes: number;
  metadataTruncated: boolean;
  originalRawBytes: number;
  rawDisposition: "none" | "stored-public-r2" | "unstored-public" | "discarded-restricted";
}

export type QueuedNormalizedItemInput = Omit<NormalizedItemInput, "raw">;

export interface IngestMessage {
  sourceId: string;
  item: QueuedNormalizedItemInput;
  provider?: string;
  /** Correlates one queued item with aggregate durable-ingestion progress. */
  sourceRunId?: string;
  sourceRunItemIndex?: number;
  /** Internal claim reconciled after a private Email item is successfully ingested. */
  emailReceiptClaim?: EmailReceiptQueueClaim;
  /** Managed R2 object written by the queue producer. Only honored for public items. */
  rawR2Key?: string;
  preparation?: IngestPreparationProvenance;
}

export type InboxReceiptOutcome =
  | "queue-pending"
  | "queued"
  | "queued-unkeyed"
  | "queue-failed"
  | "duplicate-reused"
  | "legacy-duplicate";

export type InboxReceiptQueueState = "pending" | "queued" | "failed" | "unkeyed";

export interface InboxReceiptRecord {
  id: string;
  source_id: string;
  message_id: string | null;
  dedupe_key: string | null;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  received_at: string;
  last_received_at: string;
  delivery_count: number;
  item_count: number;
  outcome: InboxReceiptOutcome;
  queue_state: InboxReceiptQueueState;
  queue_claim_token: string | null;
  queue_claimed_at: string | null;
  metadata_json: string;
}

export interface ItemRecord {
  id: string;
  source_id: string;
  external_id: string | null;
  url: string | null;
  canonical_url: string | null;
  title: string;
  text: string;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  content_hash: string;
  raw_r2_key: string | null;
  access_class: AccessClass;
  metadata_json: string;
  created_at: string;
}

export type ItemIngestStage = 0 | 1 | 2 | 3 | 4;

export interface ItemIngestCompletionRecord {
  item_id: string;
  origin_key_hash: string | null;
  story_id: string | null;
  stage: ItemIngestStage;
  lease_token: string | null;
  lease_expires_at: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StoryRecord {
  id: string;
  canonical_key: string;
  title: string;
  summary: string;
  status: string;
  first_seen_at: string;
  last_changed_at: string;
  score: number;
  relevance: number;
  novelty: number;
  importance: number;
  confidence: number;
  source_count: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface CollectorRecord {
  id: string;
  name: string;
  capabilities_json: string;
  status: string;
  last_seen_at: string | null;
  version: string | null;
  details_json: string;
}

export interface CollectorJob {
  id: string;
  collector_id: string | null;
  source_id: string;
  source_run_id: string | null;
  operation: string;
  args_json: string;
  status: string;
  lease_expires_at: string | null;
  attempts: number;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceAdapterResult {
  items: NormalizedItemInput[];
  provider: string;
  details?: Record<string, unknown>;
}

export interface BriefingPacketStory {
  id: string;
  title: string;
  summary: string;
  score: number;
  relevance: number;
  novelty: number;
  importance: number;
  confidence: number;
  sourceCount: number;
  changedAt: string;
  change: {
    kind: "new" | "changed" | "recurring";
    previousBriefingAt?: string;
    scoreDelta: number;
    sourceCountDelta: number;
    newEvidenceCount: number;
  };
  evidence: Array<{
    itemId: string;
    source: string;
    sourceKind?: string;
    title: string;
    url: string | null;
    author: string | null;
    publishedAt: string | null;
    observedAt: string;
    excerpt: string;
    accessClass: string;
    provider?: string;
    familyKey?: string;
    sourceRelationship?: string;
    independent?: boolean;
  }>;
}

export interface BriefingPacket {
  schemaVersion: "1";
  generatedAt: string;
  previousBriefingAt?: string;
  periodStart: string;
  periodEnd: string;
  coverage: {
    healthySources: number;
    degradedSources: number;
    offlineCollectors: number;
    notes: string[];
  };
  calibration: Array<{
    storyId?: string;
    storyTitle?: string;
    action: string;
    note?: string;
    createdAt: string;
  }>;
  missions: MissionBriefingSection[];
  actions: MissionAction[];
  resolvedMissions: Array<{
    id: string;
    name: string;
    question: string;
    outcomeStatus: string;
    outcomeSummary: string;
    resolvedAt: string;
  }>;
  stories: BriefingPacketStory[];
}

export interface SavedViewRecord {
  id: string;
  name: string;
  query: string;
  filters_json: string;
  created_at: string;
  updated_at: string;
}

export interface SourceSuggestion {
  id: string;
  confidence: number;
  reason: string;
  source: {
    id: string;
    name: string;
    kind: SourceKind;
    config: Record<string, unknown>;
    scheduleMinutes: number;
    weight: number;
  };
}

export interface StarterPack {
  id: string;
  name: string;
  description: string;
  category?: string;
  icon?: string;
  featured?: boolean;
  requiresCompanion?: boolean;
  sources: Array<{
    id: string;
    name: string;
    kind: SourceKind;
    config: Record<string, unknown>;
    scheduleMinutes: number;
    weight: number;
  }>;
  interestTerms: string[];
}

export interface RelayResult {
  items: NormalizedItemInput[];
  provider: string;
  diagnostics?: Record<string, unknown>;
}

export type CollectorDispatchPhase = "dispatching" | "retryable" | "accepted";

export interface CollectorDispatchState {
  version: 1;
  fingerprint: string;
  attemptId: string;
  attemptStartedAt: string;
  phase: CollectorDispatchPhase;
  plannedCount: number;
  acceptedCount: number;
  collectionPartial: boolean;
}

export interface CollectorResultSummary {
  provider: string;
  collectedCount: number;
  acceptedCount: number;
  diagnostics: Record<string, number | boolean>;
  dispatch?: CollectorDispatchState;
  completionId?: string;
}

export type ReasoningTaskStatus = "queued" | "ready" | "claimed" | "completed" | "dismissed" | "expired" | "failed";
export interface ReasoningTaskRecord {
  id: string;
  scope_kind: "global" | "mission" | "story" | "dossier";
  scope_id: string | null;
  task: ReasoningTask;
  target: ReasoningTarget;
  objective: string;
  priority: number;
  reason: string;
  status: ReasoningTaskStatus;
  dedupe_key: string;
  receipt_id: string | null;
  due_at: string | null;
  expires_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type DecisionType = "decision" | "forecast" | "commitment" | "thesis";
export type DecisionStatus = "open" | "resolved" | "reversed" | "expired";
export interface DecisionRecord {
  id: string;
  mission_id: string | null;
  story_id: string | null;
  reasoning_task_id: string | null;
  reasoning_receipt_id: string | null;
  decision_type: DecisionType;
  title: string;
  statement: string;
  rationale: string;
  options_json: string;
  evidence_json: string;
  tags_json: string;
  status: DecisionStatus;
  confidence: number;
  expected_outcome: string;
  review_at: string | null;
  outcome_summary: string;
  outcome_value: number | null;
  calibration_score: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface DecisionReviewRecord {
  id: string;
  decision_id: string;
  observed_outcome: string;
  actual_value: number | null;
  quality_score: number | null;
  calibration_score: number | null;
  lesson: string;
  evidence_json: string;
  provider: string;
  created_at: string;
}

export interface IntelligencePackSnapshotRecord {
  id: string;
  pack_id: string;
  version: string;
  manifest_json: string;
  checksum: string;
  source_url: string | null;
  event_type: string;
  created_at: string;
}

export interface LivingDossier {
  schemaVersion: "1";
  generatedAt: string;
  query: string;
  focus?: { id: string; type: string; label: string; summary: string };
  thesis: string[];
  entities: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  contradictions: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  missions: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  timeline: Array<Record<string, unknown>>;
  evidenceCoverage: { sources: number; domains: number; primaryOrAuthoritative: number; latestAt?: string };
  openQuestions: string[];
  quality: { grade: "strong" | "usable" | "insufficient"; score: number; blockers: string[] };
}
