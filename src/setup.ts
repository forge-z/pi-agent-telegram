import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * What `npm run setup` records: the chosen provider, endpoint, model and the optional
 * per-function backends. The API key is not here - it goes to the `credentials` table,
 * the same place pi-ai already reads from.
 */
export interface SetupRecord {
  providerId: string;
  baseUrl: string;
  modelId: string;
  effort?: string;
  /** Probe result for the chat model, so runtime stops guessing it reads images. */
  chatVision?: boolean;
  vision?: { modelId: string; baseUrl?: string };
  audio?: {
    modelId: string;
    api: "openai" | "gemini";
    baseUrl: string;
    language?: string;
  };
}

export const setupKey = (mode = "live") => `setup:${mode}`;

export interface StoredSetup {
  record?: SetupRecord;
  apiKey?: string;
}

/**
 * Reads the setup before the runtime opens, so the provider can be registered with the
 * stored endpoint and key. Read-only on purpose: a running bot waiting for setup must
 * never block the wizard writing to the same database.
 */
export function readStoredSetup(dir: string, mode = "live"): StoredSetup {
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) return {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(setupKey(mode)) as { value?: string } | undefined;
    const credential = db
      .prepare("SELECT value FROM credentials WHERE provider='llm'")
      .get() as { value?: string } | undefined;
    const record = row?.value
      ? (JSON.parse(row.value) as SetupRecord)
      : undefined;
    const apiKey = credential?.value
      ? (JSON.parse(credential.value) as { key?: string }).key
      : undefined;
    // A record without an endpoint is a half-written row (an old wizard bug): treat it
    // as "not configured" instead of failing every attempt to start.
    return {
      ...(record?.modelId && record.baseUrl ? { record } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  } catch {
    /* Missing tables or an unreadable row mean "not configured yet". */
    return {};
  } finally {
    db?.close();
  }
}

/** Writes the setup; used by the wizard, which runs while the bot may be up. */
/** Credential ids for the optional backends, next to the chat key in `credentials`. */
export const functionKeyId = (kind: "vision" | "audio") => `llm-${kind}`;

export function writeStoredSetup(
  db: DatabaseSync,
  record: SetupRecord,
  keys: { chat?: string; vision?: string; audio?: string } = {},
  mode = "live",
) {
  // The wizard may run on a fresh volume, before the app created its schema.
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  db.prepare(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(setupKey(mode), JSON.stringify(record));
  const write = db.prepare(
    "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
  );
  if (keys.chat)
    write.run("llm", JSON.stringify({ type: "api_key", key: keys.chat }));
  // A function on another host needs its own key; empty removes a stale one.
  for (const kind of ["vision", "audio"] as const) {
    const key = keys[kind];
    if (key)
      write.run(functionKeyId(kind), JSON.stringify({ type: "api_key", key }));
    else
      db.prepare("DELETE FROM credentials WHERE provider=?").run(
        functionKeyId(kind),
      );
  }
}
