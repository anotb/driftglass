import { budgetStatus } from "./budget";
import { listCollectorHealth, getSetting } from "./db";
import type { Env, RuntimeCandidate, RuntimeKind, RuntimePlan, RuntimeTaskSpec } from "./types";
import { isoNow, parseJson } from "./utils";

export interface RuntimeContext {
  browserAvailable: boolean;
  companionOnline: boolean;
  computerAvailable: boolean;
  computerPowerAvailable: boolean;
  budgetProfile: "free" | "cheap" | "custom";
  browserRemainingMs: number;
  workflowRemainingSteps: number;
  policy?: {
    mode?: "auto" | "cloud-first" | "quality-first";
    preferCloud?: boolean;
    allowCompanion?: boolean;
    allowComputer?: boolean;
    allowChromiumFallback?: boolean;
  };
}

const BASE_COST: Record<RuntimeKind, RuntimeCandidate["estimatedClass"]> = {
  worker: "free",
  kitesurf: "free",
  chromium: "metered",
  computer: "free",
  companion: "free",
};

function candidate(
  runtime: RuntimeKind,
  mode: string,
  available: boolean,
  score: number,
  reasons: string[],
  requirements: string[] = [],
  estimatedClass: RuntimeCandidate["estimatedClass"] = BASE_COST[runtime],
): RuntimeCandidate {
  return {
    runtime,
    mode,
    available,
    score: Math.max(0, Math.min(1, score)),
    estimatedClass,
    reasons,
    requirements,
  };
}

function preferenceBoost(runtime: RuntimeKind, task: RuntimeTaskSpec, context: RuntimeContext): number {
  if (task.preferredRuntime && task.preferredRuntime !== "auto") return task.preferredRuntime === runtime ? 0.18 : -0.05;
  if (context.policy?.mode === "quality-first" && ["computer", "chromium"].includes(runtime)) return 0.06;
  if ((context.policy?.mode === "cloud-first" || context.policy?.preferCloud !== false) && runtime === "companion") return -0.04;
  return 0;
}

export function planRuntimeTask(taskInput: RuntimeTaskSpec, context: RuntimeContext): RuntimePlan {
  const task: RuntimeTaskSpec = {
    access: "public",
    persistence: "none",
    requiresBrowser: false,
    requiresFiles: false,
    requiresHumanIntervention: false,
    multiStep: false,
    publicFallback: true,
    preferredRuntime: "auto",
    ...taskInput,
  };
  const policy = {
    mode: context.policy?.mode ?? "auto",
    preferCloud: context.policy?.preferCloud !== false,
    allowCompanion: context.policy?.allowCompanion !== false,
    allowComputer: context.policy?.allowComputer !== false,
    allowChromiumFallback: context.policy?.allowChromiumFallback !== false,
  };
  const candidates: RuntimeCandidate[] = [];

  const authenticated = task.access === "authenticated";
  const privateTask = task.access === "private";
  const persistent = task.persistence === "mission" || task.requiresFiles === true;
  const browserTask = task.requiresBrowser === true || task.kind === "render" || task.kind === "browse";
  const deepTask = task.multiStep === true || task.kind === "compare" || task.kind === "transform";
  const human = task.requiresHumanIntervention === true;

  candidates.push(candidate(
    "worker",
    task.kind === "collect" ? "source-adapter" : "edge-function",
    !authenticated && !privateTask && !persistent && !human && (!browserTask || task.publicFallback === true),
    0.86
      + (!browserTask ? 0.1 : -0.25)
      + (!deepTask ? 0.05 : -0.12)
      + preferenceBoost("worker", task, context),
    [
      "Lowest-friction Cloudflare path for APIs, feeds, public HTML, normalization, and scheduling.",
      ...(browserTask ? ["Can attempt direct HTTP before a browser runtime."] : []),
    ],
    authenticated || privateTask ? ["Publicly accessible input"] : [],
  ));

  candidates.push(candidate(
    "kitesurf",
    "stateless-agent-browser",
    context.browserAvailable && !authenticated && !privateTask && !human && policy.preferCloud,
    0.82
      + (browserTask ? 0.15 : -0.15)
      + (!deepTask ? 0.05 : -0.06)
      + (context.browserRemainingMs < Math.max(1_000, task.estimatedBrowserMs ?? 2_000) ? -0.45 : 0)
      + preferenceBoost("kitesurf", task, context),
    [
      "Agent-first public browser path for JavaScript pages, structured extraction, screenshots, and light navigation.",
      "Keeps the cloud-only installation useful without a local machine.",
    ],
    ["Cloudflare Browser binding", "Public page"],
  ));

  candidates.push(candidate(
    "chromium",
    human ? "browser-session-human-handoff" : "browser-session-compatibility",
    context.browserAvailable && !authenticated && !privateTask && policy.allowChromiumFallback,
    0.62
      + (browserTask ? 0.14 : -0.18)
      + (human ? 0.24 : 0)
      + (task.multiStep ? 0.08 : 0)
      + (context.browserRemainingMs < Math.max(5_000, task.estimatedBrowserMs ?? 6_000) ? -0.5 : 0)
      + preferenceBoost("chromium", task, context),
    [
      human ? "Full Browser Run session supports Live View and human intervention." : "Compatibility fallback when Kitesurf or direct extraction is insufficient.",
    ],
    ["Cloudflare Browser binding", "Available browser-time budget"],
    "metered",
  ));

  candidates.push(candidate(
    "computer",
    context.computerPowerAvailable && deepTask ? "power-mode" : "mission-filesystem",
    context.computerAvailable && policy.allowComputer && Boolean(task.missionId || privateTask || persistent),
    0.7
      + (persistent ? 0.2 : 0)
      + (deepTask ? 0.12 : 0)
      + (task.missionId ? 0.08 : 0)
      + (context.workflowRemainingSteps < Math.max(3, task.estimatedWorkflowSteps ?? 4) ? -0.25 : 0)
      + preferenceBoost("computer", task, context),
    [
      "Durable workspace for a standing Mission, files, comparisons, timelines, and repeatable transforms.",
      context.computerPowerAvailable
        ? "Power Mode is available for Worker-shell or Worker-JavaScript execution over the same files."
        : "Filesystem mode remains useful without the separately deployed execution add-on.",
    ],
    ["Mission ID or private workspace scope", "Cloudflare Computer binding"],
    context.computerPowerAvailable && deepTask ? "cheap" : "free",
  ));

  candidates.push(candidate(
    "companion",
    "signed-in-local-read",
    context.companionOnline && policy.allowCompanion && (authenticated || privateTask),
    0.74
      + (authenticated ? 0.24 : 0)
      + (privateTask ? 0.12 : 0)
      + preferenceBoost("companion", task, context),
    [
      "Uses the user's authenticated browser or local tools for personalized and subscriber-only sources.",
      "Returns normalized evidence while the cloud core continues independently.",
    ],
    ["Online paired Companion", "Matching read capability"],
  ));

  const available = candidates
    .filter((entry) => entry.available)
    .sort((left, right) => right.score - left.score || left.runtime.localeCompare(right.runtime));
  const primary = available[0] ?? null;
  const fallbacks = available.slice(1);
  const blocked = primary === null;
  const rationale = [
    authenticated
      ? "The task needs an authenticated source lane."
      : privateTask
        ? "The task needs a private durable workspace."
        : "The task can run from the cloud-only core.",
    persistent ? "The task benefits from Mission-scoped persistence." : "No durable workspace is required.",
    browserTask ? "Rendered browsing is relevant." : "Structured APIs or direct HTTP are preferred.",
    deepTask ? "The task spans multiple steps or artifacts." : "The task is bounded to one collection or inspection step.",
    primary ? `Selected ${primary.runtime} (${primary.mode}) because it has the highest available fit.` : "No available runtime satisfies the current access and persistence requirements.",
  ];

  return {
    schemaVersion: "1",
    task,
    primary,
    fallbacks,
    blocked,
    cloudOnly: primary ? primary.runtime !== "companion" : false,
    companionOptional: !authenticated && !privateTask,
    rationale,
    generatedAt: isoNow(),
  };
}

export async function runtimeContext(env: Env): Promise<RuntimeContext> {
  const [budget, collectors, policyRaw] = await Promise.all([
    budgetStatus(env.DB),
    listCollectorHealth(env.DB),
    getSetting(env.DB, "runtime_policy"),
  ]);
  const companionOnline = collectors.some((collector) => {
    const status = String(collector.status ?? "");
    const lastSeen = Date.parse(String(collector.last_seen_at ?? ""));
    return status === "online" || (Number.isFinite(lastSeen) && Date.now() - lastSeen < 10 * 60_000);
  });
  return {
    browserAvailable: Boolean(env.BROWSER),
    companionOnline,
    computerAvailable: Boolean(
      env.MISSION_COMPUTER
      || (env as Env & { readonly RUNTIME_WORKSPACE?: unknown }).RUNTIME_WORKSPACE,
    ),
    computerPowerAvailable: Boolean(env.DEEP_DIVE_LAB_URL && env.DEEP_DIVE_LAB_TOKEN),
    budgetProfile: budget.profile,
    browserRemainingMs: Number(budget.remaining.browser_ms ?? 0),
    workflowRemainingSteps: Number(budget.remaining.workflow_steps ?? 0),
    policy: parseJson(policyRaw, {}),
  };
}

export async function planRuntimeForEnv(env: Env, task: RuntimeTaskSpec): Promise<RuntimePlan> {
  return planRuntimeTask(task, await runtimeContext(env));
}

export function runtimeCapabilityCatalog(): Array<Record<string, unknown>> {
  return [
    { runtime: "worker", mode: "edge-function", bestFor: ["public APIs", "feeds", "direct HTTP", "normalization", "scheduling"], localRequired: false },
    { runtime: "kitesurf", mode: "stateless-agent-browser", bestFor: ["JavaScript pages", "structured extraction", "screenshots", "light navigation"], localRequired: false },
    { runtime: "chromium", mode: "browser-session-compatibility", bestFor: ["hard compatibility", "multi-step browser sessions", "Live View", "human intervention"], localRequired: false },
    { runtime: "computer", mode: "mission-filesystem-or-power-mode", bestFor: ["persistent Mission rooms", "files", "comparison", "deterministic transforms"], localRequired: false },
    { runtime: "companion", mode: "signed-in-local-read", bestFor: ["personalized feeds", "subscriber content", "user browser sessions"], localRequired: true },
  ];
}
