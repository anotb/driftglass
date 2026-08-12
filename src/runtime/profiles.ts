import type { CanonicalStateLocation, RuntimeProfile } from "./ports";

export const RUNTIME_PROFILES = ["cloudflare", "selfhost", "hybrid-local-canonical"] as const;

export interface RuntimeProfileDefinition {
  readonly id: RuntimeProfile;
  readonly canonicalState: CanonicalStateLocation;
  readonly experimental: boolean;
  readonly availability: "release" | "experimental-preview" | "experimental-unavailable";
  readonly database: "d1" | "sqlite";
  readonly objects: "r2" | "filesystem";
  readonly workspace: "cloudflare-computer" | "local-directory";
  readonly optionalProjections: readonly string[];
}

function frozenDefinition(input: RuntimeProfileDefinition): RuntimeProfileDefinition {
  return Object.freeze({
    ...input,
    optionalProjections: Object.freeze([...input.optionalProjections]),
  });
}

const DEFINITIONS: Readonly<Record<RuntimeProfile, RuntimeProfileDefinition>> = Object.freeze({
  cloudflare: frozenDefinition({
    id: "cloudflare",
    canonicalState: "cloudflare",
    experimental: false,
    availability: "release",
    database: "d1",
    objects: "r2",
    workspace: "cloudflare-computer",
    optionalProjections: [],
  }),
  selfhost: frozenDefinition({
    id: "selfhost",
    canonicalState: "local",
    experimental: true,
    availability: "experimental-preview",
    database: "sqlite",
    objects: "filesystem",
    workspace: "local-directory",
    optionalProjections: [],
  }),
  "hybrid-local-canonical": frozenDefinition({
    id: "hybrid-local-canonical",
    canonicalState: "local",
    experimental: true,
    availability: "experimental-unavailable",
    database: "sqlite",
    objects: "filesystem",
    workspace: "local-directory",
    optionalProjections: ["r2", "ai-search", "cloudflare-drop", "cloudflare-computer", "edge-read-replica"],
  }),
});

export class RuntimeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeProfileError";
  }
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile {
  const candidate = String(value ?? "").trim();
  if ((RUNTIME_PROFILES as readonly string[]).includes(candidate)) return candidate as RuntimeProfile;
  throw new RuntimeProfileError(
    `Invalid runtime profile${candidate ? ` \"${candidate}\"` : ""}; expected ${RUNTIME_PROFILES.join(", ")}`,
  );
}

export function runtimeProfileDefinition(profile: RuntimeProfile | unknown): RuntimeProfileDefinition {
  return DEFINITIONS[parseRuntimeProfile(profile)];
}

/**
 * Validate and describe a profile. This never constructs services, enables
 * writes, or authorizes a canonical-state change.
 */
export function describeRuntimeProfile(
  value: unknown,
  options: { includeExperimental?: boolean; defaultProfile?: RuntimeProfile } = {},
): RuntimeProfileDefinition {
  const profile = value === undefined || value === null || String(value).trim() === ""
    ? options.defaultProfile ?? "cloudflare"
    : parseRuntimeProfile(value);
  const definition = runtimeProfileDefinition(profile);
  if (definition.experimental && options.includeExperimental !== true) {
    throw new RuntimeProfileError(
      `Runtime profile \"${profile}\" is experimental; explicitly include experimental descriptions`,
    );
  }
  return definition;
}
