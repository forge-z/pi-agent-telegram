import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveFunctions } from "./functions.js";
import {
  canonicalProviderId,
  compatEnvConfigured,
  findCatalogModel,
  isApiKeyProviderId,
  officialProvider,
  resolveSetupChoice,
  setupChoices,
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

/** Which MCP aggregators `npm run setup` turned on. Secrets stay in `credentials`. */
export type AggregatorChoice = "executor" | "composio" | "both" | "none";

export interface AggregatorRecord {
  choice: AggregatorChoice;
  executor?: { url: string };
  composio?: { url: string; userId: string };
}

export interface StoredAggregators {
  record?: AggregatorRecord;
  executorToken?: string;
  composioKey?: string;
}

export const aggregatorsKey = (mode = "live") => `aggregators:${mode}`;
/** Volume credential ids. Not env var names. */
export const EXECUTOR_VOLUME_CREDENTIAL = "mcp-executor";
export const COMPOSIO_VOLUME_CREDENTIAL = "mcp-composio";

const AGGREGATOR_CHOICES = new Set<AggregatorChoice>([
  "executor",
  "composio",
  "both",
  "none",
]);

/** Composio user ids are one token: letters, digits, and a few separators. */
export function validAggregatorUserId(value: string) {
  return /^[\w.:@+-]{1,200}$/.test(value);
}

/** Menu number or name from `npm run setup`. */
export function parseAggregatorChoice(
  value: string,
): AggregatorChoice | undefined {
  const raw = value.trim().toLowerCase();
  if (raw === "1" || raw === "executor") return "executor";
  if (raw === "2" || raw === "composio") return "composio";
  if (raw === "3" || raw === "both" || raw === "ambos") return "both";
  if (raw === "4" || raw === "none" || raw === "nenhum") return "none";
  return undefined;
}

function usableAggregatorRecord(
  value: AggregatorRecord | undefined,
): value is AggregatorRecord {
  if (!value || !AGGREGATOR_CHOICES.has(value.choice)) return false;
  if (
    value.executor !== undefined &&
    (typeof value.executor.url !== "string" || !value.executor.url)
  )
    return false;
  if (value.composio !== undefined) {
    if (typeof value.composio.url !== "string" || !value.composio.url)
      return false;
    if (!validAggregatorUserId(value.composio.userId ?? "")) return false;
  }
  return true;
}

/** Reads aggregator choice and keys before the runtime opens. Read-only. */
export function readStoredAggregators(
  dir: string,
  mode = "live",
): StoredAggregators {
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) return {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const record = readJson<AggregatorRecord>(
      db,
      "SELECT value FROM meta WHERE key=?",
      aggregatorsKey(mode),
    );
    const usable = usableAggregatorRecord(record) ? record : undefined;
    const executorToken = credentialKey(db, EXECUTOR_VOLUME_CREDENTIAL);
    const composioKey = credentialKey(db, COMPOSIO_VOLUME_CREDENTIAL);
    return {
      ...(usable ? { record: usable } : {}),
      ...(executorToken ? { executorToken } : {}),
      ...(composioKey ? { composioKey } : {}),
    };
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

/**
 * Writes the aggregator choice. A new key overwrites that credential; an omitted
 * key leaves the stored one in place. Switching the choice updates meta only:
 * the other aggregator's block stays, disabled by `choice`, and its credential
 * is never deleted. Secrets are never written into the meta row.
 */
export function writeStoredAggregators(
  db: DatabaseSync,
  record: AggregatorRecord,
  keys: { executor?: string; composio?: string } = {},
  mode = "live",
) {
  if (!usableAggregatorRecord(record))
    throw new Error("Invalid aggregator record.");
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  const previous = readJson<AggregatorRecord>(
    db,
    "SELECT value FROM meta WHERE key=?",
    aggregatorsKey(mode),
  );
  const next: AggregatorRecord = usableAggregatorRecord(previous)
    ? { ...previous, ...record }
    : record;
  db.prepare(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(aggregatorsKey(mode), JSON.stringify(next));
  const write = db.prepare(
    "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
  );
  if (keys.executor)
    write.run(
      EXECUTOR_VOLUME_CREDENTIAL,
      JSON.stringify({ type: "api_key", key: keys.executor }),
    );
  if (keys.composio)
    write.run(
      COMPOSIO_VOLUME_CREDENTIAL,
      JSON.stringify({ type: "api_key", key: keys.composio }),
    );
}

/**
 * Bot token and allowed user ids from `npm run setup`. The token is a credential,
 * same as the Executor key. User ids are not secret and live in meta. This is not
 * `telegram:bot`: that row is the runtime hash written after getMe.
 */
export const TELEGRAM_VOLUME_CREDENTIAL = "telegram-token";
export const telegramUsersKey = (mode = "live") => `telegram-users:${mode}`;

export interface StoredTelegram {
  token?: string;
  users?: string[];
}

/** Same shape `readConfig` accepts for TELEGRAM_BOT_TOKEN. */
export function validTelegramToken(value: string) {
  return /^\d+:[\w-]+$/.test(value);
}

/** Comma-separated numeric user ids. Empty or invalid is undefined. */
export function parseTelegramUserList(value: string): string[] | undefined {
  const rows = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    !rows.length ||
    rows.some(
      (item) => !/^[1-9]\d*$/.test(item) || !Number.isSafeInteger(Number(item)),
    )
  )
    return undefined;
  return [...new Set(rows)];
}

/** Reads the token and allowlist before the runtime opens. Read-only. */
export function readStoredTelegram(dir: string, mode = "live"): StoredTelegram {
  const file = join(dir, "app.sqlite");
  if (!existsSync(file)) return {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rawUsers = readJson<unknown>(
      db,
      "SELECT value FROM meta WHERE key=?",
      telegramUsersKey(mode),
    );
    const users = Array.isArray(rawUsers)
      ? parseTelegramUserList(
          rawUsers.filter((item) => typeof item === "string").join(","),
        )
      : undefined;
    const token = credentialKey(db, TELEGRAM_VOLUME_CREDENTIAL);
    const usable = token && validTelegramToken(token) ? token : undefined;
    return {
      ...(usable ? { token: usable } : {}),
      ...(users ? { users } : {}),
    };
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

/**
 * Writes the allowlist and, when `token` is non-empty, the bot token.
 * An omitted or empty token leaves the saved credential in place.
 * Secrets are never written into the meta row.
 */
export function writeStoredTelegram(
  db: DatabaseSync,
  users: string[] | undefined,
  token?: string,
  mode = "live",
) {
  const parsed = users ? parseTelegramUserList(users.join(",")) : undefined;
  if (users && !parsed)
    throw new Error(
      "TELEGRAM_ALLOWED_USERS is invalid: use numeric ids separated by commas.",
    );
  if (token && !validTelegramToken(token))
    throw new Error("Invalid Telegram bot token.");
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  if (parsed)
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(telegramUsersKey(mode), JSON.stringify(parsed));
  if (token)
    db.prepare(
      "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
    ).run(
      TELEGRAM_VOLUME_CREDENTIAL,
      JSON.stringify({ type: "api_key", key: token }),
    );
}

type SecretListener = (...args: never[]) => void;

interface SecretInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding?(encoding: BufferEncoding): void;
  resume(): void;
  pause(): void;
  on(event: string, listener: SecretListener): void;
  off(event: string, listener: SecretListener): void;
  listeners(event: string): ReadonlyArray<SecretListener>;
  removeListener(event: string, listener: SecretListener): void;
}

interface SecretOutput {
  write(chunk: string): unknown;
}

/**
 * Reads one secret line without writing it back. Raw mode stops the terminal
 * echo; readline's keypress handler is detached for the read because `pause()`
 * leaves it in place and it reprints every character. Without a TTY the line is
 * still taken from stdin and not printed.
 */
export function readHiddenSecret(
  question: string,
  input: SecretInput = process.stdin as unknown as SecretInput,
  output: SecretOutput = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    output.write(question);
    const saved: Array<[string, SecretListener]> = [];
    for (const event of ["data", "keypress"]) {
      for (const listener of input.listeners(event).slice()) {
        input.removeListener(event, listener);
        saved.push([event, listener]);
      }
    }
    let value = "";
    let raw = false;
    if (input.isTTY && input.setRawMode) {
      try {
        input.setRawMode(true);
        raw = true;
      } catch {
        raw = false;
      }
    }
    input.setEncoding?.("utf8");
    input.resume();
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      if (raw) input.setRawMode?.(false);
      input.pause();
      for (const [event, listener] of saved) input.on(event, listener);
    };
    const finish = (result: string) => {
      cleanup();
      output.write("\n");
      resolve(result);
    };
    const onData = ((chunk: string | Buffer) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          process.exit(1);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }) as SecretListener;
    input.on("data", onData);
  });
}

/** Hidden prompt. A saved secret is never echoed, not even its last characters. */
export function secretPrompt(label: string, saved: boolean): string {
  const name = label.trim();
  return saved
    ? `${name} [saved] (hidden, Enter keeps current): `
    : `${name} (hidden): `;
}

export type SetupMenuSection = "gateway" | "text" | "image" | "audio" | "mcp";

export type SetupMenuCommand = SetupMenuSection | "restart" | "exit";

/** Last line of every section submenu. */
export const SAVE_AND_BACK = "Save and back";
/** Last line of the main menu. Restarts the process; it does not redeploy. */
export const SAVE_AND_RESTART = "Save and restart gateway";

const MAIN_MENU: Record<string, SetupMenuCommand> = {
  "1": "gateway",
  gateway: "gateway",
  "setup gateway": "gateway",
  "2": "text",
  text: "text",
  "text model": "text",
  "3": "image",
  image: "image",
  "image model": "image",
  "4": "audio",
  audio: "audio",
  "audio model": "audio",
  "5": "mcp",
  mcp: "mcp",
  "mcp platform": "mcp",
  s: "restart",
  save: "restart",
  "save and restart": "restart",
  "save and restart gateway": "restart",
  q: "exit",
  exit: "exit",
  quit: "exit",
};

/** Main menu choice. Unknown input is undefined so the loop can ask again. */
export function routeSetupMenu(answer: string): SetupMenuCommand | undefined {
  return MAIN_MENU[answer.trim().toLowerCase()];
}

export type SectionStatus = "configured" | "not set";

export interface SetupMenuStatus {
  gateway: SectionStatus;
  text: SectionStatus;
  image: SectionStatus;
  audio: SectionStatus;
  mcp: SectionStatus;
}

export function setupMenuStatus(input: {
  gateway: boolean;
  text: boolean;
  image: boolean;
  audio: boolean;
  mcp: boolean;
}): SetupMenuStatus {
  const state = (on: boolean): SectionStatus => (on ? "configured" : "not set");
  return {
    gateway: state(input.gateway),
    text: state(input.text),
    image: state(input.image),
    audio: state(input.audio),
    mcp: state(input.mcp),
  };
}

const MENU_LABELS: Record<keyof SetupMenuStatus, string> = {
  gateway: "Setup gateway",
  text: "Text model",
  image: "Image model",
  audio: "Audio model",
  mcp: "MCP platform",
};

/** Main menu text. `detail` is a short parenthetical after configured / not set. */
export function formatSetupMenu(
  status: SetupMenuStatus,
  detail: Partial<Record<keyof SetupMenuStatus, string>> = {},
): string {
  const line = (index: number, key: keyof SetupMenuStatus) => {
    const extra = detail[key]?.trim();
    const state = extra ? `${status[key]} (${extra})` : status[key];
    return `${index} - ${MENU_LABELS[key].padEnd(14)} ${state}`;
  };
  return [
    "Setup",
    line(1, "gateway"),
    line(2, "text"),
    line(3, "image"),
    line(4, "audio"),
    line(5, "mcp"),
    "",
    `s - ${SAVE_AND_RESTART}`,
    "q - Exit without saving",
  ].join("\n");
}

const SAVE_BACK: Record<string, "save"> = {
  s: "save",
  save: "save",
  "save and back": "save",
};

function routeSection<T extends string>(
  answer: string,
  table: Record<string, T>,
): T | "back" | "save" | undefined {
  const key = answer.trim().toLowerCase();
  if (key === "b" || key === "back") return "back";
  return SAVE_BACK[key] ?? table[key];
}

export function routeGatewayMenu(answer: string) {
  return routeSection(answer, {
    "1": "telegram",
    telegram: "telegram",
  } as const);
}

export function routeTelegramMenu(answer: string) {
  return routeSection(answer, {
    "1": "token",
    token: "token",
    "2": "users",
    users: "users",
    t: "test",
    test: "test",
  } as const);
}

export function routeTextMenu(answer: string) {
  return routeSection(answer, {
    "1": "provider",
    provider: "provider",
    "2": "model",
    model: "model",
    "3": "key",
    key: "key",
    "4": "effort",
    effort: "effort",
    t: "test",
    test: "test",
  } as const);
}

export type ImageMenuAction =
  | "use-text"
  | "separate"
  | "provider"
  | "model"
  | "key"
  | "test"
  | "disable"
  | "back"
  | "save";

/**
 * Image submenu. A multimodal text model offers "use the text model" first.
 * A text-only model asks for a provider before a model.
 */
export function routeImageMenu(
  answer: string,
  chatSeesImages: boolean,
): ImageMenuAction | undefined {
  const raw = answer.trim().toLowerCase();
  if (raw === "b" || raw === "back") return "back";
  if (SAVE_BACK[raw]) return "save";
  if (raw === "t" || raw === "test") return "test";
  if (raw === "-" || raw === "disable") return "disable";
  if (raw === "text") return "use-text";
  if (chatSeesImages) {
    if (raw === "1" || raw === "text") return "use-text";
    if (raw === "2" || raw === "separate") return "separate";
    return undefined;
  }
  if (raw === "1" || raw === "provider") return "provider";
  if (raw === "2" || raw === "model") return "model";
  if (raw === "3" || raw === "key") return "key";
  return undefined;
}

export function routeAudioMenu(answer: string) {
  return routeSection(answer, {
    "1": "provider",
    provider: "provider",
    "2": "model",
    model: "model",
    "3": "key",
    key: "key",
    "4": "language",
    language: "language",
    t: "test",
    test: "test",
    "-": "disable",
    disable: "disable",
  } as const);
}

export function routeMcpMenu(
  answer: string,
): AggregatorChoice | "back" | "save" | undefined {
  const raw = answer.trim().toLowerCase();
  if (raw === "b" || raw === "back") return "back";
  if (SAVE_BACK[raw]) return "save";
  return parseAggregatorChoice(answer);
}

/** Chat models. Transcription ids stay out of the text and image lists. */
const NOT_CHAT =
  /(tts|whisper|transcri|embedding|embed-|aqa|imagen|veo|dall-e|moderation|realtime)/i;

export function isChatModelId(id: string): boolean {
  return !NOT_CHAT.test(id.replace(/^models\//, ""));
}

export function modelAcceptsImages(
  input: readonly string[] | undefined,
): boolean {
  return Boolean(input?.includes("image"));
}

export interface ListedModel {
  id: string;
  input?: readonly string[];
  api?: string;
}

/** Gemini generateContent accepts inline audio. Other catalogs name transcription models. */
export function modelAcceptsAudio(model: ListedModel): boolean {
  if (model.input?.includes("audio")) return true;
  const id = model.id.replace(/^models\//, "");
  if (/whisper|transcri/i.test(id)) return true;
  return model.api === "google-generative-ai" && /^gemini-/i.test(id);
}

export function modelsForSection(
  models: readonly ListedModel[],
  section: "text" | "image" | "audio",
): ListedModel[] {
  if (section === "audio") return models.filter(modelAcceptsAudio);
  const chat = models.filter((model) => isChatModelId(model.id));
  if (section === "text") return chat;
  return chat.filter(
    (model) => modelAcceptsImages(model.input) || !model.input?.length,
  );
}

export function providerModels(providerId: string): ListedModel[] | undefined {
  const provider = officialProvider(providerId);
  if (!provider) return undefined;
  return provider.getModels().map((model) => ({
    id: model.id.replace(/^models\//, ""),
    input: model.input,
    api: model.api,
  }));
}

export function modelIdsFromListBody(body: unknown): string[] {
  const record = body as {
    data?: { id?: string; name?: string }[];
    models?: { id?: string; name?: string }[];
  };
  const raw = record?.data ?? record?.models ?? [];
  return raw
    .map((model) => (model?.id || model?.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

export const UNAVAILABLE_MODEL = "unavailable, pick another";

function providerIdForUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  for (const choice of setupChoices()) {
    if (choice.kind !== "native" || !choice.baseUrl) continue;
    try {
      if (new URL(choice.baseUrl).host.toLowerCase() === host) return choice.id;
    } catch {
      /* A catalog URL the runtime would also reject. */
    }
  }
  return undefined;
}

function resolvedModelLabel(
  modelId: string,
  baseUrl: string | undefined,
  section: "image" | "audio",
): string {
  const bare = modelId.replace(/^models\//, "");
  const providerId = providerIdForUrl(baseUrl);
  const listed = providerId
    ? modelsForSection(providerModels(providerId) ?? [], section)
    : [];
  if (listed.length && !listed.some((model) => model.id === bare))
    return UNAVAILABLE_MODEL;
  const slug = providerId === "google" ? "gemini" : providerId;
  return slug ? `${slug}/${bare}` : bare;
}

function chatSeesImages(setup: SetupRecord | undefined): boolean {
  if (!setup) return false;
  if (setup.chatVision !== undefined) return setup.chatVision;
  const model = providerModels(setup.providerId)?.find(
    (item) => item.id === setup.modelId.replace(/^models\//, ""),
  );
  return modelAcceptsImages(model?.input);
}

/**
 * The same vision and audio the runtime resolves. "text model" only when that
 * model accepts images and no separate vision model resolved.
 */
export function sectionSummary(input: {
  env: Record<string, string | undefined>;
  setup?: SetupRecord;
  keys?: { vision?: string; audio?: string };
}): { imageOn: boolean; image: string; audioOn: boolean; audio: string } {
  const resolved = resolveFunctions(input.env, input.setup, input.keys ?? {});
  const image = resolved.vision
    ? resolvedModelLabel(
        resolved.vision.modelId,
        resolved.vision.baseUrl,
        "image",
      )
    : chatSeesImages(input.setup)
      ? "text model"
      : "";
  const audio = resolved.audio
    ? resolvedModelLabel(
        resolved.audio.modelId,
        resolved.audio.baseUrl,
        "audio",
      )
    : "";
  return {
    imageOn: Boolean(image),
    image,
    audioOn: Boolean(audio),
    audio,
  };
}

function endpointHost(value: string | undefined) {
  if (!value) return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A stored image model may be reused only when it belongs to the selected provider,
 * or when it has its own endpoint. A bare Gemini id on a DeepSeek row does not.
 */
export function imageModelBelongsToProvider(
  providerId: string,
  modelId: string,
  endpoints: { imageBaseUrl?: string; textBaseUrl?: string } = {},
): boolean {
  const imageHost = endpointHost(endpoints.imageBaseUrl);
  const textHost = endpointHost(endpoints.textBaseUrl);
  if (imageHost && textHost && imageHost !== textHost) return true;
  const choice = resolveSetupChoice(providerId);
  if (!choice || choice.kind !== "native") return true;
  return Boolean(findCatalogModel(choice.id, modelId));
}

export interface ProviderModelChoice {
  id: string;
  acceptsImages?: boolean;
}

/**
 * Default image model for the setup menu.
 * Multimodal text: use that model and do not ask for another.
 * Otherwise the default is a model of the selected image provider.
 * A stored id from a different provider is ignored.
 */
export function imageSectionPlan(input: {
  chatSeesImages: boolean;
  textModelId?: string;
  providerModels?: readonly ProviderModelChoice[];
  storedModelId?: string;
  storedSeparate?: boolean;
}): {
  mode: "text-model" | "separate";
  modelId?: string;
  ignoredForeignModel: boolean;
  needsProvider: boolean;
} {
  const stored = input.storedModelId?.replace(/^models\//, "");
  if (input.chatSeesImages && !input.storedSeparate) {
    return {
      mode: "text-model",
      modelId: input.textModelId,
      ignoredForeignModel: Boolean(stored && stored !== input.textModelId),
      needsProvider: false,
    };
  }
  const models = input.providerModels ?? [];
  if (!models.length) {
    return {
      mode: "separate",
      ignoredForeignModel: Boolean(stored),
      needsProvider: true,
    };
  }
  const ids = models.map((model) => model.id.replace(/^models\//, ""));
  const storedFits = Boolean(stored && ids.includes(stored));
  const preferred =
    models.find((model) => model.acceptsImages)?.id.replace(/^models\//, "") ??
    ids[0];
  return {
    mode: "separate",
    modelId: storedFits ? stored : preferred,
    ignoredForeignModel: Boolean(stored && !storedFits),
    needsProvider: false,
  };
}

export interface GatewayProcess {
  pid: number;
  command: string;
}

function isGatewayCommand(command: string): boolean {
  const text = command.replaceAll("\0", " ").trim();
  if (!text || /setup-model\.mjs/.test(text)) return false;
  return (
    /(?:^|\s)node(?:\s|$)/.test(text) &&
    /(?:dist\/src\/main\.js|src\/main\.ts)(?:\s|$)/.test(text)
  );
}

export function selectGatewayProcess(
  rows: readonly GatewayProcess[],
  selfPid: number,
): GatewayProcess | undefined {
  return rows.find(
    (row) =>
      row.pid !== selfPid && row.pid > 0 && isGatewayCommand(row.command),
  );
}

export function requestGatewayRestart(
  rows: readonly GatewayProcess[],
  selfPid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): { restarted: boolean; pid?: number } {
  const target = selectGatewayProcess(rows, selfPid);
  if (!target) return { restarted: false };
  kill(target.pid, "SIGTERM");
  return { restarted: true, pid: target.pid };
}

/** Allowed chats are an environment override. Setup does not store them. */
export function telegramChatsNote(envValue: string | undefined): string {
  const current = envValue?.trim();
  return current
    ? `Allowed chats come from TELEGRAM_ALLOWED_CHATS (${current}). Setup does not store them.`
    : "Allowed chats come from TELEGRAM_ALLOWED_CHATS. Setup does not store them; when unset, the bot uses the allowed user ids.";
}
