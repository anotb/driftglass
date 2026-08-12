import { HttpError, numberFrom, parseJson } from "./utils";

export interface OpenCliArgDefinition {
  name: string;
  type: string;
  required: boolean;
  valueRequired: boolean;
  positional: boolean;
  choices?: Array<string | number | boolean>;
  help: string;
  default?: unknown;
}

export interface CompanionDescriptor {
  id: string;
  name: string;
  status: string;
  version: string | null;
  platform: string;
  lastSeenAt: string | null;
}

export interface CompanionCatalogEntry {
  site: string;
  command: string;
  description: string;
  strategy: string;
  browser: boolean;
  args: OpenCliArgDefinition[];
  collectorId: string;
  collectorName: string;
  collectorStatus: string;
  collectorVersion: string | null;
  collectors: CompanionDescriptor[];
}

export interface CatalogSourceInput {
  id?: string;
  name?: string;
  collectorId?: string;
  site?: string;
  command?: string;
  params?: Record<string, unknown>;
  scheduleMinutes?: number;
  weight?: number;
  enabled?: boolean;
  runNow?: boolean;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || crypto.randomUUID();
}

function collectorDescriptor(collector: Record<string, unknown>): CompanionDescriptor | null {
  const id = typeof collector.id === "string" ? collector.id : "";
  if (!id) return null;
  const details = parseJson<Record<string, unknown>>(String(collector.details_json ?? "{}"), {});
  const platform = [details.platform, details.architecture].filter((value) => typeof value === "string" && value).join(" · ");
  return {
    id,
    name: typeof collector.name === "string" && collector.name ? collector.name : "Companion",
    status: typeof collector.status === "string" ? collector.status : "offline",
    version: typeof collector.version === "string" ? collector.version : null,
    platform,
    lastSeenAt: typeof collector.last_seen_at === "string" ? collector.last_seen_at : null,
  };
}

function normalizeArgDefinition(value: unknown): OpenCliArgDefinition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return null;
  const rawChoices = Array.isArray(record.choices)
    ? record.choices.filter((choice): choice is string | number | boolean => ["string", "number", "boolean"].includes(typeof choice)).slice(0, 100)
    : undefined;
  return {
    name,
    type: typeof record.type === "string" && record.type.trim() ? record.type.trim().toLowerCase() : "str",
    required: record.required === true,
    valueRequired: record.valueRequired === true,
    positional: record.positional === true,
    choices: rawChoices?.length ? rawChoices : undefined,
    help: typeof record.help === "string" ? record.help.slice(0, 500) : "",
    ...(record.default !== undefined ? { default: record.default } : {}),
  };
}

function normalizeCatalogRecord(value: unknown): Omit<CompanionCatalogEntry, "collectorId" | "collectorName" | "collectorStatus" | "collectorVersion" | "collectors"> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const site = typeof record.site === "string" ? record.site.trim() : "";
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(site) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(command)) return null;
  return {
    site,
    command,
    description: typeof record.description === "string" ? record.description.slice(0, 800) : "",
    strategy: typeof record.strategy === "string" ? record.strategy.slice(0, 80) : "read",
    browser: record.browser !== false,
    args: Array.isArray(record.args)
      ? record.args.map(normalizeArgDefinition).filter((arg): arg is OpenCliArgDefinition => Boolean(arg)).slice(0, 80)
      : [],
  };
}

function collectorSort(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftOnline = left.status === "online" ? 1 : 0;
  const rightOnline = right.status === "online" ? 1 : 0;
  if (leftOnline !== rightOnline) return rightOnline - leftOnline;
  const leftTime = Date.parse(String(left.last_seen_at ?? "")) || 0;
  const rightTime = Date.parse(String(right.last_seen_at ?? "")) || 0;
  return rightTime - leftTime;
}

export function catalogEntriesFromCollectors(collectors: Array<Record<string, unknown>>): CompanionCatalogEntry[] {
  const grouped = new Map<string, CompanionCatalogEntry>();
  for (const collector of [...collectors].sort(collectorSort)) {
    const descriptor = collectorDescriptor(collector);
    if (!descriptor) continue;
    const details = parseJson<Record<string, unknown>>(String(collector.details_json ?? "{}"), {});
    const entries = Array.isArray(details.catalog) ? details.catalog : [];
    for (const rawEntry of entries) {
      const entry = normalizeCatalogRecord(rawEntry);
      if (!entry) continue;
      const key = `${entry.site}/${entry.command}`;
      const existing = grouped.get(key);
      if (existing) {
        if (!existing.collectors.some((candidate) => candidate.id === descriptor.id)) existing.collectors.push(descriptor);
        continue;
      }
      grouped.set(key, {
        ...entry,
        collectorId: descriptor.id,
        collectorName: descriptor.name,
        collectorStatus: descriptor.status,
        collectorVersion: descriptor.version,
        collectors: [descriptor],
      });
    }
  }
  return [...grouped.values()].sort((left, right) => `${left.site}/${left.command}`.localeCompare(`${right.site}/${right.command}`));
}

export function catalogEntryForCollector(
  collectors: Array<Record<string, unknown>>,
  collectorId: string,
  site: string,
  command: string,
): CompanionCatalogEntry | null {
  const collector = collectors.find((candidate) => candidate.id === collectorId);
  if (!collector) return null;
  const descriptor = collectorDescriptor(collector);
  if (!descriptor) return null;
  const details = parseJson<Record<string, unknown>>(String(collector.details_json ?? "{}"), {});
  const raw = (Array.isArray(details.catalog) ? details.catalog : []).find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return record.site === site && record.command === command;
  });
  const entry = normalizeCatalogRecord(raw);
  return entry ? {
    ...entry,
    collectorId: descriptor.id,
    collectorName: descriptor.name,
    collectorStatus: descriptor.status,
    collectorVersion: descriptor.version,
    collectors: [descriptor],
  } : null;
}

function missing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  throw new HttpError(400, `${name} must be true or false`);
}

function numericValue(value: unknown, name: string, integer: boolean): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, `${name} must be a finite number`);
  if (integer && !Number.isInteger(parsed)) throw new HttpError(400, `${name} must be an integer`);
  if (Math.abs(parsed) > 1_000_000_000) throw new HttpError(400, `${name} is outside the supported range`);
  return parsed;
}

function arrayValue(value: unknown, name: string): Array<string | number | boolean> {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [value];
  const normalized = values
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map((item) => {
      if (["string", "number", "boolean"].includes(typeof item)) return typeof item === "string" ? item.trim().slice(0, 4_000) : item;
      throw new HttpError(400, `${name} may contain only strings, numbers, or booleans`);
    })
    .filter((item) => item !== "");
  if (normalized.length > 100) throw new HttpError(400, `${name} accepts at most 100 values`);
  return normalized;
}

function jsonValue(value: unknown, name: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, `${name} must contain valid JSON`);
  }
}

function normalizedArgValue(arg: OpenCliArgDefinition, value: unknown): unknown {
  const type = arg.type.toLowerCase();
  if (["bool", "boolean", "flag"].includes(type)) return booleanValue(value, arg.name);
  if (["int", "integer", "count"].includes(type)) return numericValue(value, arg.name, true);
  if (["float", "double", "number"].includes(type)) return numericValue(value, arg.name, false);
  if (["array", "list", "strings", "string[]"].includes(type) || Array.isArray(arg.default)) return arrayValue(value, arg.name);
  if (["json", "object", "record"].includes(type)) return jsonValue(value, arg.name);
  if (typeof value === "string") return value.trim().slice(0, 4_000);
  if (["number", "boolean"].includes(typeof value)) return value;
  throw new HttpError(400, `${arg.name} must be a string-compatible value`);
}

export function normalizeAdapterParams(entry: CompanionCatalogEntry, input: Record<string, unknown> | undefined): Record<string, unknown> {
  const params = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const definitions = new Map(entry.args.map((arg) => [arg.name, arg]));
  const unknown = Object.keys(params).filter((key) => !definitions.has(key));
  if (unknown.length) throw new HttpError(400, `Unknown argument(s) for ${entry.site}.${entry.command}: ${unknown.join(", ")}`);
  const normalized: Record<string, unknown> = {};
  for (const arg of entry.args) {
    const value = params[arg.name];
    if (missing(value)) {
      if (arg.required && arg.default === undefined) throw new HttpError(400, `${arg.name} is required for ${entry.site}.${entry.command}`);
      continue;
    }
    const next = normalizedArgValue(arg, value);
    if (arg.choices?.length && !arg.choices.some((choice) => String(choice) === String(next))) {
      throw new HttpError(400, `${arg.name} must be one of: ${arg.choices.join(", ")}`);
    }
    normalized[arg.name] = next;
  }
  return normalized;
}

export function buildCatalogSourceDefinition(
  collectors: Array<Record<string, unknown>>,
  body: CatalogSourceInput,
): {
  source: {
    id: string;
    name: string;
    kind: "collector";
    config: Record<string, unknown>;
    enabled: boolean;
    scheduleMinutes: number;
    weight: number;
  };
  entry: CompanionCatalogEntry;
  runNow: boolean;
} {
  const collectorId = typeof body.collectorId === "string" ? body.collectorId.trim() : "";
  const site = typeof body.site === "string" ? body.site.trim() : "";
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!collectorId || !site || !command) throw new HttpError(400, "collectorId, site, and command are required");
  const entry = catalogEntryForCollector(collectors, collectorId, site, command);
  if (!entry) throw new HttpError(409, `The selected Companion no longer advertises ${site}.${command}; refresh the catalog`);
  const params = normalizeAdapterParams(entry, body.params);
  const defaultName = `${site} · ${command}`;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 160) : defaultName;
  const baseId = typeof body.id === "string" && body.id.trim()
    ? slug(body.id)
    : `${slug(name)}-${slug(collectorId).slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    source: {
      id: baseId,
      name,
      kind: "collector",
      config: {
        operation: "opencli.read",
        collectorId,
        args: { site, command, params },
      },
      enabled: body.enabled !== false,
      scheduleMinutes: Math.max(15, Math.min(10_080, numberFrom(body.scheduleMinutes, 120))),
      weight: Math.max(0.1, Math.min(3, numberFrom(body.weight, 1.2))),
    },
    entry,
    runNow: body.runNow !== false,
  };
}
