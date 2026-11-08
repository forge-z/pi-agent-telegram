import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalProviderId,
  compatEnvConfigured,
  findCatalogModel,
  isApiKeyProviderId,
  officialProvider,
} from "./native-providers.js";

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
  /** Persisted on the volume; equivalent to `LLM_AUTH=chatgpt` when env is unset. */
  authMode?: "chatgpt";
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
 * Where the chat API key is stored. Official providers use their pi-ai id.
 * ChatGPT/Codex and the compat reserve keep using `llm` (the OAuth token
 * itself lives under `openai` / `openai-codex`, written by pi-ai login).
 */
export function chatCredentialProvider(record: SetupRecord) {
  if (record.authMode === "chatgpt" || record.providerId === "openai-codex")
    return "llm";
  const id = canonicalProviderId(record.providerId);
  return isApiKeyProviderId(id) ? id : "llm";
}

function credentialKey(db: DatabaseSync, provider: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM credentials WHERE provider=?")
    .get(provider) as { value?: string } | undefined;
  if (!row?.value) return undefined;
  try {
    const key = (JSON.parse(row.value) as { key?: string }).key;
    return key || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the setup before the runtime opens, so the provider can be registered with the
 * stored endpoint and key. Read-only on purpose: a running bot waiting for setup must
 * never block the wizard writing to the same database.
 */
/** Same predicate `readStoredSetup` uses: a half-written row is not a provider. */
export function usableSetupRecord(
  record: SetupRecord | undefined,
): record is SetupRecord {
  if (!record?.modelId) return false;
  const subscription =
    record.authMode === "chatgpt" ||
    record.providerId === "openai" ||
    record.providerId === "openai-codex";
  return Boolean(record.baseUrl || subscription);
}

export function readStoredSetup(dir: string, mode = "live"): StoredSetup {
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) return {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(setupKey(mode)) as { value?: string } | undefined;
    const record = row?.value
      ? (JSON.parse(row.value) as SetupRecord)
      : undefined;
    const usable = usableSetupRecord(record) ? record : undefined;
    // Official rows keep the key under the pi-ai id. Older volumes still have it
    // under `llm`; that fallback keeps a pre-migration bot able to start.
    const subscription =
      usable?.authMode === "chatgpt" || usable?.providerId === "openai-codex";
    const apiKey = subscription
      ? credentialKey(db, "llm")
      : usable
        ? (credentialKey(db, canonicalProviderId(usable.providerId)) ??
          credentialKey(db, usable.providerId) ??
          credentialKey(db, "llm"))
        : credentialKey(db, "llm");
    // A record without an endpoint is a half-written row (an old wizard bug): treat it
    // as "not configured" instead of failing every attempt to start.
    return {
      ...(usable ? { record: usable } : {}),
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
    write.run(
      chatCredentialProvider(record),
      JSON.stringify({ type: "api_key", key: keys.chat }),
    );
  else if (
    record.authMode === "chatgpt" ||
    record.providerId === "openai-codex"
  )
    db.prepare("DELETE FROM credentials WHERE provider=?").run("llm");
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

function readJson<T>(db: DatabaseSync, sql: string, ...params: string[]) {
  const row = db.prepare(sql).get(...params) as { value?: string } | undefined;
  if (!row?.value) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Copies a legacy `credentials.provider='llm'` key onto the native provider when
 * the saved model exists in that provider's official catalog. Leftover LLM_* env
 * skips the rewrite so an explicit compat override is left alone. A model the
 * catalog does not know stays on `llm` and the bot keeps its previous endpoint.
 */
export function migrateLegacyOfficialSetup(
  db: DatabaseSync,
  env: Record<string, string | undefined>,
  mode = "live",
): { providerId: string; modelId: string } | undefined {
  if (compatEnvConfigured(env)) return undefined;
  const record = readJson<SetupRecord>(
    db,
    "SELECT value FROM meta WHERE key=?",
    setupKey(mode),
  );
  if (!usableSetupRecord(record)) return undefined;
  if (record.authMode === "chatgpt" || record.providerId === "openai-codex")
    return undefined;
  const providerId = canonicalProviderId(record.providerId);
  if (!isApiKeyProviderId(providerId)) return undefined;
  const model = findCatalogModel(providerId, record.modelId);
  if (!model) return undefined;
  const native = readJson<{ type?: string; key?: string }>(
    db,
    "SELECT value FROM credentials WHERE provider=?",
    providerId,
  );
  const legacy = readJson<{ type?: string; key?: string }>(
    db,
    "SELECT value FROM credentials WHERE provider=?",
    "llm",
  );
  if (!native?.key && !legacy?.key) return undefined;
  const baseUrl =
    model.baseUrl || officialProvider(providerId)?.baseUrl || record.baseUrl;
  if (!baseUrl) return undefined;
  const defaultsKey = `model-defaults-selection:${mode}`;
  const defaults = readJson<{
    provider?: string;
    modelId?: string;
    effort?: string;
  }>(db, "SELECT value FROM meta WHERE key=?", defaultsKey);
  const defaultsModel = defaults?.modelId?.replace(/^models\//, "");
  const sameModel =
    defaultsModel === model.id ||
    defaultsModel === record.modelId.replace(/^models\//, "");
  const defaultsNeedWrite = Boolean(
    defaults && sameModel && defaults.provider !== providerId,
  );
  const recordCurrent =
    record.providerId === providerId &&
    record.modelId === model.id &&
    record.baseUrl === baseUrl;
  if (native?.key && recordCurrent && !defaultsNeedWrite) return undefined;
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  if (!native?.key && legacy?.key) {
    db.prepare(
      "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
    ).run(providerId, JSON.stringify({ type: "api_key", key: legacy.key }));
  }
  if (!recordCurrent) {
    const next: SetupRecord = {
      ...record,
      providerId,
      baseUrl,
      modelId: model.id,
    };
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(setupKey(mode), JSON.stringify(next));
  }
  if (defaults && defaultsNeedWrite) {
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      defaultsKey,
      JSON.stringify({ ...defaults, provider: providerId, modelId: model.id }),
    );
  }
  return { providerId, modelId: model.id };
}
