import { GENERATED_MIGRATIONS } from "./generated-migrations";
import { HttpError } from "./utils";

const EXPECTED_SCHEMA_VERSION = GENERATED_MIGRATIONS.at(-1)?.version ?? 0;
const readyByDatabase = new WeakMap<D1Database, number>();

async function hasSettingsTable(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .first<{ name: string }>();
  return row?.name === "settings";
}

async function currentSchemaVersion(db: D1Database): Promise<number> {
  if (!(await hasSettingsTable(db))) return 0;
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
  const parsed = Number(row?.value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function verifySchema(db: D1Database): Promise<number> {
  const current = await currentSchemaVersion(db);
  if (current !== EXPECTED_SCHEMA_VERSION) {
    throw new HttpError(503, "D1 schema is not ready", {
      current,
      expected: EXPECTED_SCHEMA_VERSION,
      action: "Run the environment-appropriate repository deploy or migration script (`npm run deploy`, `npm run deploy:staging`, `npm run db:migrate:remote`, or `npm run db:migrate:staging`).",
    });
  }
  return current;
}

/**
 * Verifies that Wrangler's migration ledger has brought D1 to the exact schema
 * expected by this Worker. The deploy script applies migrations after automatic
 * resource provisioning; request isolates never race to execute ALTER statements.
 */
export async function ensureSchema(db: D1Database): Promise<number> {
  const ready = readyByDatabase.get(db);
  if (ready !== undefined) return ready;

  const current = await verifySchema(db);
  readyByDatabase.set(db, current);
  return current;
}

/**
 * Queue delivery can begin as soon as a new Worker version is active, while
 * the deploy command is still applying its D1 migrations. Delay the whole
 * ordinary batch explicitly so this short upgrade window cannot burn through
 * the Queue's retry allowance or acknowledge a message against an old schema.
 * The terminal quarantine consumer is the sole exception because its bounded
 * private-R2 fallback is independent of the D1 schema version.
 */
export async function ensureQueueSchema(
  db: D1Database,
  batch: Pick<MessageBatch<unknown>, "retryAll">,
  options: { allowUnavailable?: boolean; allowSchemaMismatch?: boolean } = {},
): Promise<boolean> {
  try {
    await ensureSchema(db);
    return true;
  } catch (error) {
    const schemaMismatch = error instanceof HttpError
      && error.status === 503
      && typeof error.details === "object"
      && error.details !== null
      && "current" in error.details
      && "expected" in error.details;
    // Failure queues must retain their D1-independent emergency path during a
    // database outage. Only the final quarantine consumer may also cross an
    // exact-version mismatch: it tries the private D1 store, then preserves the
    // bounded body in private R2 if that schema cannot accept it. Primary and
    // DLQ processing still wait for the exact migration version.
    if (schemaMismatch ? options.allowSchemaMismatch : options.allowUnavailable) return true;
    console.error(JSON.stringify({
      message: "Ingest Queue is waiting for the D1 schema migration",
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    }));
    batch.retryAll({ delaySeconds: 60 });
    return false;
  }
}
