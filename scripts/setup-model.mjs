#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import {
  COMPOSIO_CONNECT_URL,
  LLM_PROVIDER_ID,
  bootstrapModels,
  composioAuthHeader,
  composioSendsUserId,
  environmentModels,
  mcpServersFromAggregators,
  officialModels,
  operatorSecret,
  SetupRequiredError,
  validatePublicEndpoint,
} from "../dist/src/config.js";
import { PROVIDERS } from "../dist/src/providers.js";
import {
  officialProvider,
  resolveSetupChoice,
  setupChoices,
} from "../dist/src/native-providers.js";
import { probeImageSupport, providerErrorHint } from "../dist/src/vision.js";
import {
  formatSetupMenu,
  functionKeyId,
  imageModelBelongsToProvider,
  imageSectionPlan,
  isChatModelId,
  modelIdsFromListBody,
  modelsForSection,
  requestGatewayRestart,
  SAVE_AND_BACK,
  sectionSummary,
  migrateLegacyOfficialSetup,
  modelAcceptsImages,
  UNAVAILABLE_MODEL,
  parseAggregatorChoice,
  parseTelegramUserList,
  readHiddenSecret as hidden,
  readStoredAggregators,
  readStoredSetup,
  readStoredTelegram,
  routeAudioMenu,
  routeGatewayMenu,
  routeImageMenu,
  routeMcpMenu,
  routeSetupMenu,
  routeTelegramMenu,
  routeTextMenu,
  secretPrompt,
  setupKey,
  setupMenuStatus,
  telegramChatsNote,
  validAggregatorUserId,
  validTelegramToken,
  writeStoredAggregators,
  writeStoredSetup,
  writeStoredTelegram,
} from "../dist/src/setup.js";
import {
  modelDefaultsConfirmedKey,
  modelDefaultsKey,
} from "../dist/src/settings.js";
import { Store, SqlCredentials } from "../dist/src/store.js";
import {
  oauthInteractionFromReadline,
  runSubscriptionLogin,
  subscriptionChatCatalog,
  writeChatgptAuthMode,
} from "../dist/src/subscription-login.js";

const MODE = "live";
const usage = `Usage: npm run setup -- [options]

  With no arguments, in a terminal, a menu edits one section at a time:
  Setup gateway, text model, image model, audio model, MCP platform.
  Save & exit writes the volume. Exit without saving leaves it unchanged.

  --list                      show the current state
  --provider <id|url>         chatgpt | openai-codex | a pi-ai provider id
                              (anthropic, openai, google, groq, openrouter, xai,
                              deepseek, opencode, opencode-go, …)
                              | gemini (alias of google) | opencode-zen (alias of opencode)
                              | custom | URL
  --key-stdin                 read the API key from stdin (keeps it out of history and ps)
  --model <id>                model id in that provider's catalog
  --effort <level>            off|minimal|low|medium|high|xhigh|max
  --vision <id|none>          image model (none disables; omitted keeps the saved one)
  --audio <id|none>           transcription model (none disables)
  --audio-api <openai|gemini> audio request shape
  --audio-language <code>     transcription language (empty = detect)
  --dry-run                   show what would be written, without writing
  --aggregators <choice>      executor | composio | both | none
  --executor-url <url>        Executor MCP URL (with --aggregators)
  --executor-token-stdin      Executor token from stdin
  --composio-url <url>        Composio MCP URL (default: Connect)
  --composio-user <id>        Composio user id
  --composio-key-stdin        Composio key from stdin
  --telegram-token-stdin      bot token from stdin
  --telegram-users <ids>      comma-separated numeric user ids
                              (empty keeps the saved list)

A saved secret is never printed. Enter keeps it. One secret per stdin.
TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, COMPOSIO_* and EXECUTOR_* override
the volume when set. TELEGRAM_ALLOWED_CHATS and TZ stay environment-only.
LLM_API_KEY still feeds the compat reserve ("Other") and is read when
--key-stdin is absent. LLM_BASE_URL and LLM_API_KEY are not required and do not
replace a saved official setup. Without a terminal, use the flags.`;

function fail(message, code = 1) {
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
}

const options = {
  list: false,
  model: undefined,
  effort: undefined,
  audioLanguage: undefined,
  audioApi: undefined,
  audio: undefined,
  vision: undefined,
  keyStdin: false,
  provider: undefined,
  dryRun: false,
  aggregators: undefined,
  executorUrl: undefined,
  executorTokenStdin: false,
  composioUrl: undefined,
  composioUser: undefined,
  composioKeyStdin: false,
  telegramTokenStdin: false,
  telegramUsers: undefined,
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--list") options.list = true;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--model") options.model = argv[(index += 1)];
  else if (arg === "--effort") options.effort = argv[(index += 1)];
  else if (arg === "--provider") options.provider = argv[(index += 1)];
  else if (arg === "--key-stdin") options.keyStdin = true;
  else if (arg === "--vision") options.vision = argv[(index += 1)];
  else if (arg === "--audio") options.audio = argv[(index += 1)];
  else if (arg === "--audio-api") options.audioApi = argv[(index += 1)];
  else if (arg === "--audio-language")
    options.audioLanguage = argv[(index += 1)] ?? "";
  else if (arg === "--aggregators") options.aggregators = argv[(index += 1)];
  else if (arg === "--executor-url") options.executorUrl = argv[(index += 1)];
  else if (arg === "--executor-token-stdin") options.executorTokenStdin = true;
  else if (arg === "--composio-url") options.composioUrl = argv[(index += 1)];
  else if (arg === "--composio-user") options.composioUser = argv[(index += 1)];
  else if (arg === "--composio-key-stdin") options.composioKeyStdin = true;
  else if (arg === "--telegram-token-stdin") options.telegramTokenStdin = true;
  else if (arg === "--telegram-users")
    options.telegramUsers = argv[(index += 1)] ?? "";
  else if (arg === "--help" || arg === "-h") {
    console.log(usage);
    process.exit(0);
  } else fail(`Unknown argument: ${arg}\n\n${usage}`, 2);
}

const dir = process.env.DATA_DIR?.trim() || "data";
/** Whole stdin, for `--key-stdin`: the key never appears in argv or shell history. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Same host, so the chat key can be reused (Groq serves chat and audio). */
function host(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Model id from a numbered catalog entry or a typed id. */
function officialIdForUrl(baseUrl) {
  if (!baseUrl) return undefined;
  let target = "";
  try {
    target = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  return setupChoices().find((choice) => {
    if (choice.kind !== "native" || !choice.baseUrl) return false;
    try {
      return new URL(choice.baseUrl).host.toLowerCase() === target;
    } catch {
      return false;
    }
  })?.id;
}

/** Transcription backends a chat endpoint cannot provide. */
const AUDIO_PROVIDERS = [
  {
    name: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    hint: "whisper-1 accepts ogg",
  },
  {
    name: "Groq",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    hint: "fast",
  },
  {
    name: "Gemini",
    api: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    hint: "inline audio JSON",
  },
  {
    name: "Other (custom endpoint)",
    api: "openai",
    baseUrl: "",
    model: "",
    hint: "enter the URL, format, and model",
  },
];

/** Number from the audio list, or a custom endpoint. */
function pickAudio(answer) {
  const index = Number(answer);
  if (
    Number.isSafeInteger(index) &&
    index >= 1 &&
    index <= AUDIO_PROVIDERS.length
  )
    return AUDIO_PROVIDERS[index - 1];
  return undefined;
}

/** URL root the app will use; a plain number picks from the curated list. */
function providerFromAnswer(answer) {
  const raw = String(answer ?? "").trim();
  if (/^https?:\/\//i.test(raw)) return { id: "custom", baseUrl: raw };
  const index = Number(raw);
  const entry =
    Number.isSafeInteger(index) && index >= 1 && index <= PROVIDERS.length
      ? PROVIDERS[index - 1]
      : PROVIDERS.find((candidate) => candidate.id === raw);
  return entry ? { id: entry.id, baseUrl: entry.baseUrl } : undefined;
}

/** Validates the key on the spot: a broken key is worth knowing before the model list. */
async function listModels(baseUrl, apiKey) {
  const root = baseUrl.replace(/\/+$/, "");
  const gemini =
    /generativelanguage\.googleapis\.com/.test(root) && !/\/openai/.test(root);
  try {
    const response = await fetch(`${root}/models`, {
      headers: gemini
        ? { "x-goog-api-key": apiKey }
        : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = providerErrorHint(text);
      return {
        ok: false,
        detail: `HTTP ${response.status}${hint ? `: ${hint}` : ""}`,
      };
    }
    const ids = modelIdsFromListBody(JSON.parse(text));
    return ids.length
      ? { ok: true, ids }
      : { ok: false, detail: "no models listed" };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.name : "no response",
    };
  }
}

/** Known provider for this endpoint, so the stored record names it. */
function providerIdFor(baseUrl) {
  const hit = PROVIDERS.find(
    (entry) => entry.baseUrl && entry.baseUrl === baseUrl,
  );
  return hit?.id ?? "custom";
}
let models;
let catalog = [];
/**
 * Provider and key in effect. Both the menu and the flags path fill this, and commit()
 * reads it - recomputing from the environment is how the typed key got lost.
 */
const resolved = {
  chatVision: undefined,
  baseUrl: "",
  apiKey: "",
  providerId: "custom",
  audioKey: "",
  mode: "api",
  /** `native` uses the pi-ai catalog; `compat` is the generic `llm` reserve. */
  kind: "compat",
  /** pi-ai provider id for defaults (/model). */
  piProviderId: LLM_PROVIDER_ID,
};

function activeProviderId() {
  return resolved.piProviderId;
}

function isSubscriptionChoice(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (
    value === "0" ||
    value === "chatgpt" ||
    value === "subscription" ||
    value === "openai-codex" ||
    value === "openai-subscription"
  );
}

function subscriptionPiProvider(raw) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return value === "openai" ? "openai" : "openai-codex";
}

async function loadSubscriptionCatalog(readline, piProviderId) {
  const store = new Store(dir);
  const credentials = new SqlCredentials(store);
  const stored = readStoredSetup(dir);
  try {
    models = await bootstrapModels(credentials, process.env, { stored });
  } catch (error) {
    if (error instanceof SetupRequiredError) {
      models = await bootstrapModels(
        credentials,
        { ...process.env, LLM_AUTH: "chatgpt" },
        { stored },
      );
    } else throw error;
  }
  if (!(await models.checkAuth(piProviderId))) {
    if (!readline) {
      store.close();
      const err = new Error(
        "ChatGPT subscription is not authenticated. Run `npm run login`, or `npm run setup` in an interactive terminal (docker exec -it).",
      );
      err.code = "SUBSCRIPTION_LOGIN_REQUIRED";
      throw err;
    }
    const deviceAnswer = await readline.question(
      "Device-code login (recommended on a VPS)? [Y/n]: ",
    );
    const deviceCodeOnly = !/^n/i.test(String(deviceAnswer).trim());
    console.log(
      "Follow the OAuth login below (device code, or paste the redirect URL if asked).",
    );
    const interaction = oauthInteractionFromReadline(readline, {
      deviceCodeOnly,
    });
    await runSubscriptionLogin(store, models, piProviderId, interaction, {
      deviceCodeOnly,
    });
  } else {
    writeChatgptAuthMode(store);
  }
  resolved.mode = "subscription";
  resolved.piProviderId = piProviderId;
  resolved.providerId = piProviderId;
  resolved.baseUrl = models.getProvider(piProviderId)?.baseUrl ?? "";
  resolved.apiKey = "";
  catalog = subscriptionChatCatalog(models, piProviderId);
  store.close();
  if (!catalog.length)
    fail("No chat model is available for the authenticated subscription.");
}

function inferChatVision(entry) {
  const model = models.getModel(activeProviderId(), entry.id);
  return modelAcceptsImages(model?.input);
}

function toCatalogEntry(model) {
  return {
    id: String(model.id).replace(/^models\//, ""),
    efforts: getSupportedThinkingLevels(model),
    input: model.input,
    api: model.api,
  };
}

/**
 * Registered after the provider and key are known: on a fresh volume nothing is stored
 * yet, so the catalog cannot be built first.
 */
async function loadCatalog(baseUrl, apiKey) {
  try {
    models = await environmentModels(
      {
        ...process.env,
        ...(baseUrl ? { LLM_BASE_URL: baseUrl } : {}),
        ...(apiKey ? { LLM_API_KEY: apiKey } : {}),
      },
      { stored: readStoredSetup(dir) },
    );
  } catch (error) {
    fail(
      error instanceof Error && error.message
        ? `${error.message}\nOn a first run, choose the provider and the key.`
        : "The model catalog failed.",
    );
  }
  catalog = models
    .getModels(LLM_PROVIDER_ID)
    .filter((model) => isChatModelId(model.id))
    .map(toCatalogEntry);
  resolved.mode = "api";
  resolved.kind = "compat";
  resolved.piProviderId = LLM_PROVIDER_ID;
  if (!catalog.length)
    fail("No chat model in the catalog. Check the provider and the key.");
}

/** Official catalog is static: no GET /models, and the key is not required to list it. */
function loadNativeCatalog(providerId) {
  const store = new Store(dir);
  try {
    models = officialModels(new SqlCredentials(store));
  } finally {
    store.close();
  }
  const provider = models.getProvider(providerId);
  if (!provider) fail(`Unknown native provider: ${providerId}.`);
  resolved.mode = "api";
  resolved.kind = "native";
  resolved.piProviderId = providerId;
  resolved.providerId = providerId;
  resolved.baseUrl = provider.baseUrl ?? "";
  catalog = models
    .getModels(providerId)
    .filter((model) => isChatModelId(model.id))
    .map(toCatalogEntry);
  if (!catalog.length)
    fail("That provider's official catalog has no chat model.");
  if (!resolved.baseUrl) {
    const sample = models.getModel(providerId, catalog[0].id);
    resolved.baseUrl = sample?.baseUrl ?? "";
  }
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dir, "app.sqlite"));
let dbClosed = false;
function closeDb() {
  if (dbClosed) return;
  dbClosed = true;
  db.close();
}
db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
const migrated = migrateLegacyOfficialSetup(db, process.env, MODE);
if (migrated)
  console.log(
    `Volume migrated to the official provider ${migrated.providerId}/${migrated.modelId}.`,
  );
const defaultsKey = modelDefaultsKey(MODE);
const confirmedKey = modelDefaultsConfirmedKey(MODE);
const setupMetaKey = setupKey(MODE);
const readMeta = (key) => {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return row ? row.value : undefined;
};
function current() {
  const raw = readMeta(defaultsKey);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.modelId === "string") return value;
  } catch {
    /* A corrupt row is treated as "nothing chosen yet". */
  }
  return undefined;
}
/** The stored record already holds the per-function models: one source, one key. */
function currentFunctions() {
  const raw = readMeta(setupMetaKey);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return {
      ...(value?.vision ? { vision: value.vision } : {}),
      ...(value?.audio ? { audio: value.audio } : {}),
    };
  } catch {
    return {};
  }
}
/** What the environment already declares. Env wins at runtime, so the menu shows it. */
function envSelection() {
  const env = process.env;
  const selection = {};
  const vision = env.VISION_MODEL?.trim();
  if (vision) selection.vision = { modelId: vision };
  const audio = env.AUDIO_MODEL?.trim();
  if (audio) selection.audio = { modelId: audio };
  const api = env.AUDIO_API?.trim().toLowerCase();
  const language = env.AUDIO_LANGUAGE?.trim();
  if (selection.audio) {
    if (api === "openai" || api === "gemini") selection.audio.api = api;
    if (language) selection.audio.language = language;
  }
  return selection;
}
/** Stored choice merged with the env, which is what the bot will actually use. */
function effectiveFunctions() {
  const stored = currentFunctions();
  const env = envSelection();
  const vision = env.vision ?? stored.vision;
  const base = env.audio ?? stored.audio;
  const audio = base
    ? {
        ...base,
        ...(env.audio?.api ? { api: env.audio.api } : {}),
        ...(env.audio?.language ? { language: env.audio.language } : {}),
      }
    : undefined;
  return { ...(vision ? { vision } : {}), ...(audio ? { audio } : {}) };
}
/** Saving a different model than the env declares is a silent no-op at runtime. */
function warnEnvPrecedence(selection) {
  const env = envSelection();
  for (const kind of ["vision", "audio"]) {
    const variable = kind === "vision" ? "VISION_MODEL" : "AUDIO_MODEL";
    const fromVars = env[kind]?.modelId;
    const saved = selection[kind]?.modelId;
    if (fromVars && saved && saved !== fromVars)
      console.log(
        `! ${variable} is set in the environment (${fromVars}) and wins. Unset it for ${saved} to apply.`,
      );
  }
}

function functionLabel(selection, chatSees = resolved.chatVision) {
  const env = envSelection();
  const vision = selection.vision?.modelId
    ? `${selection.vision.modelId}${env.vision?.modelId === selection.vision.modelId ? " (env)" : ""}`
    : chatSees
      ? "the text model"
      : "off";
  const audio = selection.audio?.modelId
    ? `${selection.audio.modelId}${selection.audio.language ? ` (${selection.audio.language})` : ""}${env.audio?.modelId === selection.audio.modelId ? " (env)" : ""}`
    : "not set";
  return `image: ${vision} · audio: ${audio}`;
}

function save(settings) {
  const statement = db.prepare(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  statement.run(defaultsKey, JSON.stringify(settings));
  statement.run(confirmedKey, "true");
}
function label(settings) {
  return settings
    ? `${settings.provider}/${settings.modelId} · ${settings.effort}`
    : "none chosen (implicit: first catalog model)";
}
function printState(baseUrl) {
  const provider = activeProviderId();
  console.log(`Provider: ${provider}`);
  console.log(
    resolved.mode === "subscription"
      ? "Authentication: ChatGPT subscription (OAuth on the volume; same as LLM_AUTH=chatgpt)"
      : resolved.kind === "native"
        ? `Address: official catalog${resolved.baseUrl ? ` (${resolved.baseUrl})` : ""}`
        : `Address: ${baseUrl || process.env.LLM_BASE_URL?.trim() || "(not set)"} (compat path)`,
  );
  console.log(`Global default: ${label(current())}`);
  console.log(`Functions: ${functionLabel(effectiveFunctions())}`);
  console.log(telegramLabel());
  console.log(aggregatorLabel());
  console.log(`Catalog (${catalog.length}):`);
  for (const entry of catalog)
    console.log(
      `  ${provider}/${entry.id}  —  effort: ${entry.efforts.join(" ")}`,
    );
}
function entryFor(input) {
  const raw = String(input ?? "").trim();
  const provider = activeProviderId();
  const id = raw.startsWith(`${provider}/`)
    ? raw.slice(provider.length + 1)
    : raw.startsWith(`${LLM_PROVIDER_ID}/`)
      ? raw.slice(LLM_PROVIDER_ID.length + 1)
      : raw;
  const entry = catalog.find((candidate) => candidate.id === id);
  if (!entry)
    fail(`Unknown model: ${raw || "(empty)"}. Use --list to see the options.`);
  return entry;
}
function effortFor(entry, input) {
  const previous = current();
  const requested = String(input ?? "").trim();
  if (!requested)
    return previous && entry.efforts.includes(previous.effort)
      ? previous.effort
      : clampThinkingLevel(
          models.getModel(activeProviderId(), entry.id),
          "high",
        );
  if (!entry.efforts.includes(requested))
    fail(`Invalid effort for ${entry.id}: use ${entry.efforts.join("|")}.`);
  return requested;
}
function audioFields(audio) {
  return {
    modelId: audio.modelId,
    api: audio.api ?? "openai",
    baseUrl:
      audio.baseUrl ||
      process.env.AUDIO_BASE_URL?.trim() ||
      (audio.api === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://api.openai.com/v1"),
    ...(audio.language ? { language: audio.language } : {}),
  };
}

/** Vision and audio keys. An empty string lets writeStoredSetup drop a stale key. */
function functionKeys(functions, apiKey) {
  const chatHost = host(resolved.baseUrl);
  return {
    ...(functions.vision
      ? {
          vision:
            resolved.visionKey ||
            operatorSecret(process.env, "VISION_API_KEY") ||
            apiKey ||
            "",
        }
      : {}),
    ...(functions.audio
      ? {
          audio:
            resolved.audioKey ||
            operatorSecret(process.env, "AUDIO_API_KEY") ||
            (host(functions.audio.baseUrl) === chatHost ? apiKey : "") ||
            "",
        }
      : {}),
  };
}

function commitSubscription(entry, effort, functions = currentFunctions()) {
  const provider = resolved.piProviderId;
  const settings = { provider, modelId: entry.id, effort };
  const registered = models.getProvider(provider);
  const record = {
    providerId: provider,
    baseUrl: registered?.baseUrl ?? resolved.baseUrl,
    modelId: entry.id,
    effort,
    authMode: "chatgpt",
    ...(resolved.chatVision === undefined
      ? {}
      : { chatVision: resolved.chatVision }),
    ...(functions.vision ? { vision: functions.vision } : {}),
    ...(functions.audio ? { audio: audioFields(functions.audio) } : {}),
  };
  if (options.dryRun) {
    console.log(
      `(dry-run) would save ${label(settings)} as the global default.`,
    );
    return;
  }
  save(settings);
  writeStoredSetup(db, record, functionKeys(functions), MODE);
  writeChatgptAuthMode(new Store(dir));
  console.log(`Global default: ${label(settings)}`);
  console.log(
    `Saved on the volume (${record.providerId}, authMode=chatgpt). LLM_AUTH=chatgpt is optional; the volume record is enough.`,
  );
  console.log(`Database: ${join(dir, "app.sqlite")}`);
  console.log(
    "New conversations use this default. /model in Telegram still overrides one conversation.",
  );
}

function commit(entry, effort, functions = currentFunctions()) {
  if (resolved.mode === "subscription")
    return commitSubscription(entry, effort, functions);
  const provider = activeProviderId();
  const registered = models.getModel(provider, entry.id);
  const baseUrl = (registered?.baseUrl || resolved.baseUrl || "").replace(
    /\/+$/,
    "",
  );
  const apiKey = resolved.apiKey || undefined;
  if (!apiKey || !baseUrl)
    fail("Provider or key is missing: the record would not be usable.");
  const settings = { provider, modelId: entry.id, effort };
  const record = {
    providerId: resolved.kind === "native" ? provider : resolved.providerId,
    baseUrl,
    modelId: entry.id,
    effort,
    // Omitted when the probe did not run (flags path until it does): absent means
    // "unknown", and runtime then falls back to what the catalog declares.
    ...(resolved.chatVision === undefined
      ? {}
      : { chatVision: resolved.chatVision }),
    ...(functions.vision ? { vision: functions.vision } : {}),
    ...(functions.audio ? { audio: audioFields(functions.audio) } : {}),
  };
  if (options.dryRun) {
    console.log(
      `(dry-run) would save ${label(settings)} as the global default.`,
    );
    return;
  }
  save(settings);
  // From here on the app starts without LLM_* in the environment.
  writeStoredSetup(
    db,
    record,
    {
      ...(apiKey ? { chat: apiKey } : {}),
      // A backend on the chat host inherits the chat key; otherwise the operator must
      // have provided one (menu prompt, or VISION_API_KEY / AUDIO_API_KEY).
      ...(functions.vision
        ? {
            vision:
              resolved.visionKey ||
              operatorSecret(process.env, "VISION_API_KEY") ||
              apiKey,
          }
        : {}),
      ...(functions.audio
        ? {
            audio:
              resolved.audioKey ||
              operatorSecret(process.env, "AUDIO_API_KEY") ||
              (host(functions.audio.baseUrl) === host(baseUrl) ? apiKey : ""),
          }
        : {}),
    },
    MODE,
  );
  console.log(`Global default: ${label(settings)}`);
  console.log(
    resolved.kind === "native"
      ? `Saved on the volume (${record.providerId}). The key is in credentials under that id. LLM_* is not required.`
      : `Saved on the volume (${record.providerId}, compat path). LLM_* is no longer required.`,
  );
  console.log(`Database: ${join(dir, "app.sqlite")}`);
  console.log(
    "New conversations use this default. /model in Telegram still overrides one conversation.",
  );
}
function readBackendKeys() {
  const read = (id) => {
    const row = db
      .prepare("SELECT value FROM credentials WHERE provider=?")
      .get(id);
    if (!row?.value) return undefined;
    try {
      return JSON.parse(row.value).key || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    vision: read(functionKeyId("vision")),
    audio: read(functionKeyId("audio")),
  };
}

function loadSession() {
  const stored = readStoredSetup(dir);
  const telegram = readStoredTelegram(dir);
  const aggregators = readStoredAggregators(dir);
  const functions = currentFunctions();
  const keys = readBackendKeys();
  const record = stored.record;
  let vision = functions.vision ? { ...functions.vision } : undefined;
  if (
    record &&
    vision?.modelId &&
    !imageModelBelongsToProvider(record.providerId, vision.modelId, {
      imageBaseUrl: vision.baseUrl,
      textBaseUrl: record.baseUrl,
    })
  ) {
    console.log(
      `Image model ${vision.modelId} does not belong to ${record.providerId}. It will not be used.`,
    );
    vision = undefined;
  }
  const choice = record ? resolveSetupChoice(record.providerId) : undefined;
  return {
    telegram: {
      hasToken: Boolean(telegram.token),
      users: telegram.users ? [...telegram.users] : undefined,
      newToken: undefined,
    },
    text: {
      providerId: record?.providerId,
      baseUrl: record?.baseUrl || "",
      modelId: record?.modelId,
      effort: record?.effort,
      authMode: record?.authMode,
      kind:
        record?.authMode === "chatgpt"
          ? "subscription"
          : choice?.kind || "compat",
      apiKey: stored.apiKey,
      newKey: undefined,
      chatVision: record?.chatVision,
    },
    image: {
      choice: undefined,
      vision,
      key: keys.vision,
      newKey: undefined,
      sameAsText: !vision?.baseUrl,
      listedIds: undefined,
    },
    audio: {
      audio: functions.audio ? { ...functions.audio } : undefined,
      key: keys.audio,
      newKey: undefined,
      off: false,
    },
    mcp: {
      choice: aggregators.record?.choice,
      executorUrl: aggregators.record?.executor?.url,
      composioUrl: aggregators.record?.composio?.url,
      composioUser: aggregators.record?.composio?.userId,
      executorToken: aggregators.executorToken,
      composioKey: aggregators.composioKey,
      newExecutor: undefined,
      newComposio: undefined,
    },
  };
}

function sessionRecord(session) {
  const text = session.text;
  if (!text.modelId) return undefined;
  const selection = selectionOf(session);
  return {
    providerId: text.providerId || "",
    baseUrl: text.baseUrl || "",
    modelId: text.modelId,
    ...(text.effort ? { effort: text.effort } : {}),
    ...(text.authMode ? { authMode: text.authMode } : {}),
    ...(text.chatVision === undefined ? {} : { chatVision: text.chatVision }),
    ...selection,
  };
}

function summaryOf(session) {
  return sectionSummary({
    env: process.env,
    setup: sessionRecord(session),
    keys: {
      vision:
        session.image.choice === "off" || session.image.choice === "text"
          ? undefined
          : session.image.newKey || session.image.key,
      audio: session.audio.off
        ? undefined
        : session.audio.newKey || session.audio.key,
    },
  });
}

function sessionStatus(session, summary) {
  const textReady = Boolean(
    session.text.modelId &&
    (session.text.authMode === "chatgpt" ||
      session.text.apiKey ||
      session.text.newKey),
  );
  const mcpOn = Boolean(session.mcp.choice && session.mcp.choice !== "none");
  return setupMenuStatus({
    gateway: Boolean(
      (session.telegram.hasToken || session.telegram.newToken) &&
      session.telegram.users?.length,
    ),
    text: textReady,
    image: summary.imageOn && session.image.choice !== "off",
    audio: summary.audioOn && !session.audio.off,
    mcp: mcpOn,
  });
}

function printMain(session) {
  const summary = summaryOf(session);
  console.log(
    `\n${formatSetupMenu(sessionStatus(session, summary), {
      text: session.text.modelId
        ? `${session.text.providerId}/${session.text.modelId}`
        : "",
      image: summary.imageOn ? summary.image : "",
      audio: summary.audioOn ? summary.audio : "",
      mcp: session.mcp.choice || "",
    })}`,
  );
}

function printSectionEnd() {
  console.log("b - Back");
  console.log(`s - ${SAVE_AND_BACK}`);
}

async function askSecret(readline, label, saved) {
  readline.pause();
  try {
    return (await hidden(secretPrompt(label, saved))).trim();
  } finally {
    readline.resume();
  }
}

function selectionOf(session) {
  const vision =
    session.image.choice === "text" || session.image.choice === "off"
      ? undefined
      : session.image.vision;
  const audio = session.audio.off ? undefined : session.audio.audio;
  return {
    ...(vision?.modelId ? { vision } : {}),
    ...(audio?.modelId ? { audio } : {}),
  };
}

async function ensureCatalog(session, readline) {
  const text = session.text;
  if (!text.providerId) return false;
  const providerId = text.providerId;
  const same =
    catalog.length &&
    (text.authMode === "chatgpt"
      ? resolved.mode === "subscription" && resolved.piProviderId === providerId
      : text.kind === "native"
        ? resolved.kind === "native" && resolved.piProviderId === providerId
        : resolved.kind === "compat" && resolved.baseUrl === text.baseUrl);
  if (same) return true;
  if (text.authMode === "chatgpt") {
    try {
      await loadSubscriptionCatalog(
        readline,
        providerId === "openai" ? "openai" : "openai-codex",
      );
      return catalog.length > 0;
    } catch (error) {
      console.log(
        error instanceof Error
          ? error.message
          : "Subscription catalog is unavailable.",
      );
      return false;
    }
  }
  const key = text.newKey || text.apiKey;
  if (text.kind === "native") {
    if (!key) return false;
    resolved.apiKey = key;
    loadNativeCatalog(providerId);
    return catalog.length > 0;
  }
  if (!text.baseUrl || !key) return false;
  resolved.baseUrl = text.baseUrl;
  resolved.apiKey = key;
  resolved.providerId = providerIdFor(text.baseUrl);
  await loadCatalog(text.baseUrl, key);
  return catalog.length > 0;
}

async function detectChatVision(session) {
  if (!session.text.modelId) return undefined;
  const id = session.text.modelId;
  if (session.text.authMode === "chatgpt" || session.text.kind === "native") {
    const model = models?.getModel(activeProviderId(), id);
    session.text.chatVision = modelAcceptsImages(model?.input);
    console.log(
      session.text.chatVision
        ? `Text model ${id} accepts images (pi-ai catalog).`
        : `Text model ${id} does not accept images (pi-ai catalog).`,
    );
    return session.text.chatVision;
  }
  const key = session.text.newKey || session.text.apiKey;
  if (!key || !session.text.baseUrl) {
    console.log(
      "A text provider and API key are required to test image input.",
    );
    return undefined;
  }
  const probe = await probeImageSupport({
    modelId: id,
    baseUrl: session.text.baseUrl,
    apiKey: key,
  });
  session.text.chatVision = probe.verdict === "vision";
  const name =
    probe.verdict === "vision"
      ? "accepts images"
      : probe.verdict === "text"
        ? "does not accept images"
        : "image support could not be confirmed";
  console.log(
    `Text model ${id}: ${name}${probe.detail ? ` (${probe.detail})` : ""}.`,
  );
  return session.text.chatVision;
}

async function persistSetup(readline, session) {
  const text = session.text;
  if (
    !text.modelId ||
    !(text.authMode === "chatgpt" || text.apiKey || text.newKey)
  )
    return "Choose a text provider, model, and key first.";
  const separate = session.image.vision;
  if (
    session.image.choice === "separate" &&
    separate?.modelId &&
    session.image.sameAsText &&
    text.providerId &&
    !imageModelBelongsToProvider(text.providerId, separate.modelId, {
      imageBaseUrl: separate.baseUrl,
      textBaseUrl: text.baseUrl,
    })
  )
    return `${separate.modelId} does not belong to ${text.providerId}. Choose a model from that provider.`;
  if (!(await ensureCatalog(session, readline)))
    return "The model catalog could not be loaded.";
  const entry = catalog.find((item) => item.id === text.modelId);
  if (!entry) return `Unknown model: ${text.modelId}.`;
  if (text.chatVision === undefined) await detectChatVision(session);
  const effort =
    text.effort && entry.efforts.includes(text.effort)
      ? text.effort
      : effortFor(entry, "");
  resolved.chatVision = text.chatVision;
  resolved.visionKey =
    session.image.choice === "text" || session.image.choice === "off"
      ? ""
      : session.image.newKey ||
        (session.image.sameAsText ? "" : session.image.key) ||
        "";
  resolved.audioKey = session.audio.off
    ? ""
    : session.audio.newKey || session.audio.key || "";
  commit(entry, effort, selectionOf(session));
  return "";
}

async function testTelegram(draft) {
  const token = draft.newToken || readStoredTelegram(dir).token;
  if (!token) {
    console.log("Set a bot token first.");
    return;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    const hint = providerErrorHint(body);
    let username = "";
    try {
      username = JSON.parse(body)?.result?.username || "";
    } catch {
      username = "";
    }
    if (!response.ok || !username) {
      console.log(
        `Telegram test failed: HTTP ${response.status}${hint ? `: ${hint}` : ""}.`,
      );
      return;
    }
    console.log(`Connected as @${username}.`);
  } catch {
    console.log("Telegram test failed: no response.");
  }
}

async function gatewayMenu(readline, session) {
  for (;;) {
    console.log("\nSetup gateway");
    console.log("1 - Telegram");
    printSectionEnd();
    const action = routeGatewayMenu(await readline.question("Choice: "));
    if (!action) {
      console.log("Unknown choice.");
      continue;
    }
    if (action === "back" || action === "save") return;
    await telegramMenu(readline, session);
  }
}

async function telegramMenu(readline, session) {
  const draft = structuredClone(session.telegram);
  for (;;) {
    console.log("\nTelegram");
    console.log(
      draft.hasToken || draft.newToken
        ? "Bot token: [saved]"
        : "Bot token: not set",
    );
    console.log(`Allowed users: ${draft.users?.join(", ") || "not set"}`);
    console.log(telegramChatsNote(process.env.TELEGRAM_ALLOWED_CHATS));
    console.log("1 - Bot token");
    console.log("2 - Allowed user ids");
    console.log("t - Test connection (getMe)");
    printSectionEnd();
    const action = routeTelegramMenu(await readline.question("Choice: "));
    if (!action) {
      console.log("Unknown choice.");
      continue;
    }
    if (action === "back") return;
    if (action === "save") {
      const tokenOk = Boolean(draft.newToken || draft.hasToken);
      if (!tokenOk || !draft.users?.length) {
        console.log("A bot token and allowed user ids are both required.");
        continue;
      }
      persistTelegram(draft.users, draft.newToken);
      session.telegram = draft;
      return;
    }
    if (action === "token") {
      const typed = await askSecret(
        readline,
        "Bot token",
        Boolean(draft.hasToken || draft.newToken),
      );
      if (!typed) continue;
      if (!validTelegramToken(typed)) {
        console.log("Invalid bot token. Use the form 123456:ABC…");
        continue;
      }
      draft.newToken = typed;
      draft.hasToken = true;
      continue;
    }
    if (action === "users") {
      const current = draft.users?.join(",") || "";
      const answer = (
        await readline.question(
          `Allowed user ids, comma-separated${current ? ` [${current}]` : ""}: `,
        )
      ).trim();
      const users = parseTelegramUserList(answer || current);
      if (!users) {
        console.log("Enter numeric user ids separated by commas.");
        continue;
      }
      draft.users = users;
      continue;
    }
    await testTelegram(draft);
  }
}

async function configureTextProvider(readline, draft) {
  console.log(
    "Official pi-ai providers. The key is stored on the volume under the provider id.",
  );
  console.log("  [0] ChatGPT (Plus/Pro subscription — OAuth, no API key)");
  const menu = setupChoices();
  menu.forEach((entry, index) =>
    console.log(
      `  [${index + 1}] ${entry.name}${entry.hint ? ` — ${entry.hint}` : ""}`,
    ),
  );
  const defaultHint =
    draft.authMode === "chatgpt" ? "0" : draft.providerId || "1";
  const providerAnswer = (
    await readline.question(`\nProvider [${defaultHint}]: `)
  ).trim();
  const chosen = providerAnswer || String(defaultHint);
  if (
    isSubscriptionChoice(chosen) ||
    (!providerAnswer && draft.authMode === "chatgpt")
  ) {
    let piProviderId =
      draft.authMode === "chatgpt" &&
      (draft.providerId === "openai" || draft.providerId === "openai-codex")
        ? draft.providerId
        : "openai";
    const named =
      providerAnswer &&
      providerAnswer !== "0" &&
      providerAnswer !== "chatgpt" &&
      providerAnswer !== "subscription";
    if (named) piProviderId = subscriptionPiProvider(providerAnswer);
    else {
      const subFlow = (
        await readline.question(
          "Subscription [1] Sign in with ChatGPT (openai) [2] legacy Codex (openai-codex) [1]: ",
        )
      ).trim();
      piProviderId = subFlow === "2" ? "openai-codex" : "openai";
    }
    await loadSubscriptionCatalog(readline, piProviderId);
    draft.providerId = resolved.providerId;
    draft.baseUrl = resolved.baseUrl;
    draft.authMode = "chatgpt";
    draft.kind = "subscription";
    draft.apiKey = undefined;
    draft.newKey = undefined;
    draft.chatVision = undefined;
    if (!catalog.some((entry) => entry.id === draft.modelId))
      draft.modelId = undefined;
    return;
  }
  const picked = resolveSetupChoice(chosen);
  if (!picked) {
    console.log("Unknown provider. Use a number, an id, or a base URL.");
    return;
  }
  if (picked.kind === "native") {
    const same = resolveSetupChoice(draft.providerId ?? "")?.id === picked.id;
    let apiKey = same ? draft.newKey || draft.apiKey : undefined;
    if (!apiKey) apiKey = await askSecret(readline, "API key", false);
    if (!apiKey) {
      console.log("API key is missing.");
      return;
    }
    resolved.apiKey = apiKey;
    loadNativeCatalog(picked.id);
    draft.providerId = picked.id;
    draft.baseUrl = resolved.baseUrl;
    draft.kind = "native";
    draft.authMode = undefined;
    draft.newKey = apiKey;
    draft.apiKey = apiKey;
    draft.chatVision = undefined;
    if (!catalog.some((entry) => entry.id === draft.modelId))
      draft.modelId = undefined;
    console.log(
      `Key saved for ${picked.id} — ${catalog.length} models in the official catalog.`,
    );
    return;
  }
  let pickedUrl = picked.baseUrl;
  if (!pickedUrl)
    pickedUrl = (
      await readline.question(
        "Provider base URL (for example https://my-provider/v1): ",
      )
    ).trim();
  if (!pickedUrl) {
    console.log("Provider URL is missing.");
    return;
  }
  let apiKey =
    host(pickedUrl) === host(draft.baseUrl)
      ? draft.newKey || draft.apiKey
      : undefined;
  if (!apiKey) apiKey = await askSecret(readline, "API key", false);
  if (!apiKey) {
    console.log("API key is missing.");
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    const check = await listModels(pickedUrl, apiKey);
    if (check.ok) {
      console.log(`Key accepted — ${check.ids.length} models listed.`);
      break;
    }
    console.log(`${pickedUrl} rejected the key (${check.detail}).`);
    if (attempt >= 2) {
      console.log("Invalid API key.");
      return;
    }
    apiKey = await askSecret(readline, "API key", false);
    if (!apiKey) return;
  }
  resolved.baseUrl = pickedUrl;
  resolved.apiKey = apiKey;
  resolved.providerId = providerIdFor(pickedUrl);
  await loadCatalog(pickedUrl, apiKey);
  draft.providerId = resolved.providerId;
  draft.baseUrl = pickedUrl;
  draft.kind = "compat";
  draft.authMode = undefined;
  draft.newKey = apiKey;
  draft.apiKey = apiKey;
  draft.chatVision = undefined;
  if (!catalog.some((entry) => entry.id === draft.modelId))
    draft.modelId = undefined;
}

async function configureTextModel(readline, draft) {
  if (!catalog.length) {
    console.log("Choose a provider first.");
    return;
  }
  const picked = await pickListedModel(
    readline,
    catalog,
    draft.modelId,
    `${activeProviderId()}/`,
  );
  if (!catalog.some((entry) => entry.id === picked)) {
    console.log(`Unknown model: ${picked}.`);
    return;
  }
  draft.modelId = picked;
  draft.chatVision = undefined;
}

async function configureEffort(readline, draft) {
  const entry = catalog.find((item) => item.id === draft.modelId);
  if (!entry) {
    console.log("Choose a model first.");
    return;
  }
  console.log(`Effort for ${entry.id}: ${entry.efforts.join(" ")}`);
  const answer = (
    await readline.question(
      `Effort${draft.effort ? ` [${draft.effort}]` : ""}: `,
    )
  ).trim();
  if (answer && !entry.efforts.includes(answer)) {
    console.log(`Invalid effort. Use ${entry.efforts.join("|")}.`);
    return;
  }
  draft.effort = answer || draft.effort || effortFor(entry, "");
}

async function testText(draft) {
  if (!draft.modelId) {
    console.log("Choose a model first.");
    return;
  }
  if (draft.authMode === "chatgpt") {
    if (!models) {
      console.log("Choose the ChatGPT provider first.");
      return;
    }
    const ok = await models.checkAuth(draft.providerId);
    console.log(
      ok
        ? "Subscription is authenticated."
        : "Subscription is not authenticated.",
    );
    return;
  }
  const key = draft.newKey || draft.apiKey;
  if (!key || !draft.baseUrl) {
    console.log("A provider and API key are required before a test.");
    return;
  }
  const listed = await listModels(draft.baseUrl, key);
  if (!listed.ok) {
    console.log(`Text model test failed: ${listed.detail}.`);
    return;
  }
  const ids = listed.ids.map((id) => id.replace(/^models\//, ""));
  console.log(
    ids.includes(draft.modelId)
      ? `Text model test passed. ${draft.modelId} is listed (${ids.length} models).`
      : `Key accepted (${ids.length} models). ${draft.modelId} was not in the list; the official catalog may still serve it.`,
  );
}

async function textMenu(readline, session) {
  const draft = structuredClone(session.text);
  for (;;) {
    const keySaved = Boolean(draft.newKey || draft.apiKey);
    console.log("\nText model");
    console.log(`Provider: ${draft.providerId || "not set"}`);
    console.log(`Model: ${draft.modelId || "not set"}`);
    console.log(
      draft.authMode === "chatgpt"
        ? "API key: ChatGPT subscription (OAuth)"
        : `API key: ${keySaved ? "[saved]" : "not set"}`,
    );
    console.log(`Effort: ${draft.effort || "not set"}`);
    console.log("1 - Provider");
    console.log("2 - Model");
    console.log("3 - API key");
    console.log("4 - Effort");
    console.log("t - Test");
    printSectionEnd();
    const action = routeTextMenu(await readline.question("Choice: "));
    if (!action) {
      console.log("Unknown choice.");
      continue;
    }
    if (action === "back") return;
    if (action === "save") {
      const previous = session.text;
      session.text = draft;
      const error = await persistSetup(
        draft.authMode === "chatgpt" ? readline : undefined,
        session,
      );
      if (error) {
        session.text = previous;
        console.log(error);
        continue;
      }
      return;
    }
    if (action === "provider") await configureTextProvider(readline, draft);
    else if (action === "model") {
      await ensureCatalog({ text: draft }, undefined);
      await configureTextModel(readline, draft);
    } else if (action === "key") {
      if (draft.authMode === "chatgpt") {
        console.log(
          "The ChatGPT subscription uses OAuth, not an API key. Choose the provider to sign in.",
        );
        continue;
      }
      const typed = await askSecret(
        readline,
        "API key",
        Boolean(draft.newKey || draft.apiKey),
      );
      if (!typed) continue;
      draft.newKey = typed;
      draft.apiKey = typed;
      resolved.apiKey = typed;
    } else if (action === "effort") await configureEffort(readline, draft);
    else await testText(draft);
  }
}

function textProviderModels() {
  return catalog.map((entry) => ({
    id: entry.id,
    input: entry.input,
    api: entry.api,
    acceptsImages: modelAcceptsImages(entry.input),
  }));
}

async function discoverModels({ providerId, baseUrl, apiKey }) {
  const rows = [];
  const seen = new Set();
  const add = (entry) => {
    const id = String(entry.id || "").replace(/^models\//, "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push({ ...entry, id });
  };
  if (providerId && officialProvider(providerId)) {
    const store = new Store(dir);
    try {
      const registry = officialModels(new SqlCredentials(store));
      for (const model of registry.getModels(providerId))
        add(toCatalogEntry(model));
    } finally {
      store.close();
    }
  }
  if (baseUrl && apiKey) {
    const listed = await listModels(baseUrl, apiKey);
    if (listed.ok) {
      const live = new Set(listed.ids);
      const known = rows.filter((row) => live.has(row.id));
      rows.length = 0;
      seen.clear();
      for (const row of known) add(row);
      for (const id of listed.ids) add({ id });
    }
  }
  return rows;
}

async function pickListedModel(readline, entries, current, prefix = "") {
  const ids = entries.map((entry) => entry.id);
  entries.forEach((entry, index) =>
    console.log(
      `  [${index + 1}] ${prefix}${entry.id}${entry.efforts?.length ? `  (effort: ${entry.efforts.join(" ")})` : ""}`,
    ),
  );
  if (!ids.length) console.log("No models listed. Enter a model id.");
  const bare = current?.replace(/^models\//, "");
  const known = Boolean(bare && ids.includes(bare));
  if (bare && ids.length && !known)
    console.log(`${bare}: ${UNAVAILABLE_MODEL}`);
  const hint = known ? bare : ids[0];
  const answer = (
    await readline.question(`Model${hint ? ` [${hint}]` : ""}: `)
  ).trim();
  if (!answer) return hint || bare || "";
  const index = Number(answer);
  const picked =
    Number.isSafeInteger(index) && ids[index - 1]
      ? ids[index - 1]
      : answer.replace(/^models\//, "");
  return picked;
}

async function pickImageProvider(readline, session, draft) {
  console.log("Image provider");
  console.log("  [0] Same as the text provider (reuses its API key)");
  PROVIDERS.forEach((entry, index) =>
    console.log(
      `  [${index + 1}] ${entry.name}${entry.hint ? ` — ${entry.hint}` : ""}`,
    ),
  );
  const answer = (await readline.question("Provider: ")).trim();
  if (!answer) return;
  if (answer === "0") {
    const stored = draft.vision?.modelId;
    const storedOk =
      stored &&
      session.text.providerId &&
      imageModelBelongsToProvider(session.text.providerId, stored, {
        imageBaseUrl: draft.vision?.baseUrl,
        textBaseUrl: session.text.baseUrl,
      });
    const imageModels = modelsForSection(textProviderModels(), "image");
    const plan = imageSectionPlan({
      chatSeesImages: false,
      textModelId: session.text.modelId,
      providerModels: imageModels.map((model) => ({
        id: model.id,
        acceptsImages: modelAcceptsImages(model.input) || !model.input?.length,
      })),
      storedModelId: storedOk ? stored : undefined,
    });
    if (plan.ignoredForeignModel && stored)
      console.log(
        `${stored} is not a ${session.text.providerId} model. Default is ${plan.modelId}.`,
      );
    draft.choice = "separate";
    draft.sameAsText = true;
    draft.vision = { modelId: plan.modelId || "" };
    draft.listed = imageModels;
    draft.newKey = undefined;
    console.log(
      plan.modelId
        ? `Default image model: ${plan.modelId}. Open Model to pick from the list.`
        : "Choose a model from this provider.",
    );
    return;
  }
  const picked = providerFromAnswer(answer);
  if (!picked) {
    console.log("Unknown image provider.");
    return;
  }
  let base = picked.baseUrl;
  if (!base)
    base = (await readline.question("Image provider base URL: ")).trim();
  if (!base) {
    console.log("Image provider URL is missing.");
    return;
  }
  const same = host(base) === host(session.text.baseUrl);
  let key = same ? session.text.newKey || session.text.apiKey : "";
  if (!key) {
    const typed = await askSecret(
      readline,
      "Image API key",
      Boolean(draft.key || draft.newKey),
    );
    key = typed || draft.newKey || draft.key || "";
    if (typed) draft.newKey = typed;
  }
  if (!key) {
    console.log("Image API key is missing.");
    return;
  }
  draft.choice = "separate";
  draft.sameAsText = same;
  const imageModels = modelsForSection(
    await discoverModels({
      providerId: officialIdForUrl(base),
      baseUrl: base,
      apiKey: key,
    }),
    "image",
  );
  draft.listed = imageModels;
  const plan = imageSectionPlan({
    chatSeesImages: false,
    providerModels: imageModels.map((model) => ({
      id: model.id,
      acceptsImages: modelAcceptsImages(model.input) || !model.input?.length,
    })),
  });
  draft.vision = { modelId: plan.modelId || "", baseUrl: base };
  if (!imageModels.length)
    console.log("Could not list image models. Enter a model id.");
  console.log(
    draft.vision.modelId
      ? `Default image model: ${draft.vision.modelId}. Open Model to pick from the list.`
      : "Enter a model id from this provider.",
  );
}

async function pickImageModel(readline, session, draft) {
  if (draft.choice !== "separate") {
    console.log("Choose a provider first.");
    return;
  }
  let entries = draft.listed || [];
  if (!entries.length) {
    const base = draft.vision?.baseUrl || session.text.baseUrl;
    const key =
      draft.newKey ||
      (draft.sameAsText
        ? session.text.newKey || session.text.apiKey
        : draft.key) ||
      session.text.newKey ||
      session.text.apiKey;
    entries = draft.sameAsText
      ? modelsForSection(textProviderModels(), "image")
      : modelsForSection(
          await discoverModels({
            providerId: officialIdForUrl(base),
            baseUrl: base,
            apiKey: key,
          }),
          "image",
        );
    draft.listed = entries;
  }
  const modelId = await pickListedModel(
    readline,
    entries,
    draft.vision?.modelId,
  );
  if (!modelId) {
    console.log("Model id is missing.");
    return;
  }
  draft.vision = { ...(draft.vision || {}), modelId };
}

async function testImage(session, draft, chatSeesImages) {
  const usingText =
    draft.choice !== "separate" && (chatSeesImages || draft.choice === "text");
  if (usingText) {
    console.log(
      session.text.chatVision
        ? `Image test: ${session.text.modelId} accepts images, so image input uses the text model.`
        : `Image test: ${session.text.modelId} does not accept images.`,
    );
    return;
  }
  const vision = draft.vision;
  if (!vision?.modelId) {
    console.log("Choose an image model first.");
    return;
  }
  if (
    draft.sameAsText &&
    session.text.providerId &&
    !imageModelBelongsToProvider(session.text.providerId, vision.modelId, {
      imageBaseUrl: vision.baseUrl,
      textBaseUrl: session.text.baseUrl,
    })
  ) {
    console.log(
      `${vision.modelId} does not belong to ${session.text.providerId}. The test was not sent.`,
    );
    return;
  }
  const base = vision.baseUrl || session.text.baseUrl;
  const key =
    draft.newKey ||
    (draft.sameAsText
      ? session.text.newKey || session.text.apiKey
      : draft.key) ||
    session.text.newKey ||
    session.text.apiKey;
  if (!base || !key) {
    console.log("An image provider and API key are required before a test.");
    return;
  }
  const verdict = await probeImageSupport({
    modelId: vision.modelId,
    baseUrl: base,
    apiKey: key,
  });
  const label = {
    vision: "accepts images",
    text: "text only",
    unknown: "not confirmed",
  }[verdict.verdict];
  console.log(
    `${vision.modelId}: ${label}${verdict.detail ? ` (${verdict.detail})` : ""}.`,
  );
}

async function imageMenu(readline, session) {
  if (!session.text.modelId) {
    console.log(
      "Set a text model first. Image input depends on whether that model accepts images.",
    );
    return;
  }
  if (!(await ensureCatalog(session, undefined))) {
    console.log("The text model catalog could not be loaded.");
    return;
  }
  const sees = await detectChatVision(session);
  if (sees === undefined) return;
  const draft = structuredClone(session.image);
  if (
    draft.vision?.modelId &&
    draft.choice !== "off" &&
    draft.choice !== "text"
  )
    draft.choice = "separate";
  else if (sees && draft.choice !== "separate") draft.choice = "text";
  for (;;) {
    console.log("\nImage model");
    if (sees && draft.choice !== "separate") {
      console.log(`Text model ${session.text.modelId} accepts images.`);
      console.log(
        "Image input uses that model. No separate image model is required.",
      );
      console.log("1 - Use the text model");
      console.log("2 - Choose a separate image model");
      console.log("t - Test");
    } else {
      console.log(
        sees
          ? `A separate image model overrides nothing while ${session.text.modelId} accepts images. Pick one only if you want it stored.`
          : `Text model ${session.text.modelId} does not accept images.`,
      );
      if (!sees)
        console.log(
          "Choose an image provider, then a model from that provider.",
        );
      console.log(`Image model: ${draft.vision?.modelId || "not set"}`);
      if (sees) console.log("text - Use the text model");
      console.log("1 - Provider");
      console.log("2 - Model");
      console.log("3 - API key");
      console.log("t - Test");
      console.log("- - Disable");
    }
    printSectionEnd();
    const action = routeImageMenu(
      await readline.question("Choice: "),
      sees && draft.choice !== "separate",
    );
    if (!action) {
      console.log("Unknown choice.");
      continue;
    }
    if (action === "back") return;
    if (action === "save") {
      if (
        !sees &&
        draft.choice !== "off" &&
        draft.choice !== "text" &&
        !draft.vision?.modelId
      ) {
        console.log("Choose an image provider and a model, or disable image.");
        continue;
      }
      const previous = session.image;
      session.image = draft;
      const error = await persistSetup(undefined, session);
      if (error) {
        session.image = previous;
        console.log(error);
        continue;
      }
      return;
    }
    if (action === "use-text") {
      draft.choice = "text";
      draft.vision = undefined;
      console.log(`Image model: ${session.text.modelId} (the text model).`);
    } else if (action === "disable") {
      draft.choice = "off";
      draft.vision = undefined;
      console.log("Image model disabled.");
    } else if (action === "separate" || action === "provider")
      await pickImageProvider(readline, session, draft);
    else if (action === "model") await pickImageModel(readline, session, draft);
    else if (action === "key") {
      const typed = await askSecret(
        readline,
        "Image API key",
        Boolean(draft.newKey || draft.key),
      );
      if (typed) {
        draft.newKey = typed;
        draft.sameAsText = false;
      }
    } else if (action === "test") await testImage(session, draft, sees);
  }
}

async function configureAudioProvider(readline, session, draft) {
  AUDIO_PROVIDERS.forEach((entry, index) =>
    console.log(
      `  [${index + 1}] ${entry.name}${entry.model ? ` — ${entry.model}` : ""}${entry.hint ? ` (${entry.hint})` : ""}`,
    ),
  );
  const picked = pickAudio((await readline.question("Provider: ")).trim());
  if (!picked) {
    console.log("Unknown audio provider.");
    return;
  }
  let base = picked.baseUrl;
  let api = picked.api;
  let model = picked.model;
  if (!base) {
    base = (await readline.question("Transcription base URL: ")).trim();
    const format = (
      await readline.question(
        "Format [1] OpenAI multipart [2] Gemini JSON [1]: ",
      )
    ).trim();
    api = format === "2" ? "gemini" : "openai";
    model = (await readline.question("Transcription model id: ")).trim();
    if (!base || !model) {
      console.log("Audio needs a URL and a model.");
      return;
    }
  }
  const same = host(base) === host(session.text.baseUrl);
  let key = same ? session.text.newKey || session.text.apiKey : "";
  if (!key) {
    const typed = await askSecret(
      readline,
      "Audio API key",
      Boolean(draft.newKey || draft.key),
    );
    key = typed || draft.newKey || draft.key || "";
    if (typed) draft.newKey = typed;
  }
  if (!key) {
    console.log("Audio API key is missing.");
    return;
  }
  const entries = modelsForSection(
    await discoverModels({
      providerId: api === "gemini" ? "google" : officialIdForUrl(base),
      baseUrl: base,
      apiKey: key,
    }),
    "audio",
  );
  const presetOk = Boolean(
    model && entries.some((entry) => entry.id === model),
  );
  if (model && entries.length && !presetOk)
    console.log(`${model}: ${UNAVAILABLE_MODEL}`);
  draft.off = false;
  draft.listed = entries;
  draft.audio = {
    modelId: presetOk ? model : entries[0]?.id || model,
    api,
    baseUrl: base,
    ...(draft.audio?.language ? { language: draft.audio.language } : {}),
  };
  console.log(
    "The model must accept OGG/Opus (whisper-1, Gemini, and Groq do). Voice notes are transcribed at runtime. Open Model to pick from the list.",
  );
}

async function testAudio(session, draft) {
  const audio = draft.audio;
  if (draft.off || !audio?.modelId || !audio.baseUrl) {
    console.log("Choose an audio provider and model first.");
    return;
  }
  const key =
    draft.newKey ||
    draft.key ||
    (host(audio.baseUrl) === host(session.text.baseUrl)
      ? session.text.newKey || session.text.apiKey
      : "");
  if (!key) {
    console.log("Audio API key is missing.");
    return;
  }
  try {
    const response = await fetch(
      `${audio.baseUrl.replace(/\/+$/, "")}/models`,
      {
        headers:
          audio.api === "gemini"
            ? { "x-goog-api-key": key }
            : { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    const body = await response.text();
    const hint = providerErrorHint(body);
    if (!response.ok) {
      console.log(
        `Audio test failed: HTTP ${response.status}${hint ? `: ${hint}` : ""}.`,
      );
      return;
    }
    console.log(
      `Audio endpoint accepted the key. Voice notes use ${audio.modelId}. The model must accept OGG/Opus.`,
    );
  } catch {
    console.log("Audio test failed: no response.");
  }
}

async function audioMenu(readline, session) {
  const draft = structuredClone(session.audio);
  for (;;) {
    console.log("\nAudio model");
    console.log(
      "Used for Telegram voice notes. The runtime transcribes them with this model.",
    );
    console.log(
      `Provider model: ${draft.off ? "disabled" : draft.audio?.modelId || "not set"}`,
    );
    console.log(
      `API key: ${draft.newKey || draft.key ? "[saved]" : host(draft.audio?.baseUrl) === host(session.text.baseUrl) && (session.text.apiKey || session.text.newKey) ? "[reused from text model]" : "not set"}`,
    );
    console.log(`Language: ${draft.audio?.language || "auto"}`);
    console.log("1 - Provider");
    console.log("2 - Model");
    console.log("3 - API key");
    console.log("4 - Language");
    console.log("t - Test");
    console.log("- - Disable");
    printSectionEnd();
    const action = routeAudioMenu(await readline.question("Choice: "));
    if (!action) {
      console.log("Unknown choice.");
      continue;
    }
    if (action === "back") return;
    if (action === "save") {
      const previous = session.audio;
      session.audio = draft;
      const error = await persistSetup(undefined, session);
      if (error) {
        session.audio = previous;
        console.log(error);
        continue;
      }
      return;
    }
    if (action === "provider")
      await configureAudioProvider(readline, session, draft);
    else if (action === "model") {
      if (!draft.audio?.baseUrl) {
        console.log("Choose a provider first.");
        continue;
      }
      const key =
        draft.newKey ||
        draft.key ||
        (host(draft.audio.baseUrl) === host(session.text.baseUrl)
          ? session.text.newKey || session.text.apiKey
          : "");
      const entries =
        draft.listed ||
        modelsForSection(
          await discoverModels({
            providerId:
              draft.audio.api === "gemini"
                ? "google"
                : officialIdForUrl(draft.audio.baseUrl),
            baseUrl: draft.audio.baseUrl,
            apiKey: key,
          }),
          "audio",
        );
      draft.listed = entries;
      const modelId = await pickListedModel(
        readline,
        entries,
        draft.audio.modelId,
      );
      if (modelId) draft.audio = { ...draft.audio, modelId };
    } else if (action === "key") {
      const typed = await askSecret(
        readline,
        "Audio API key",
        Boolean(draft.newKey || draft.key),
      );
      if (typed) draft.newKey = typed;
    } else if (action === "language") {
      if (!draft.audio) {
        console.log("Choose a provider first.");
        continue;
      }
      const current = draft.audio.language || "auto";
      const answer = (
        await readline.question(`Language [${current}]: `)
      ).trim();
      const language = answer && answer !== "auto" ? answer : "";
      draft.audio = { ...draft.audio };
      if (language) draft.audio.language = language;
      else delete draft.audio.language;
    } else if (action === "disable") {
      draft.off = true;
      draft.audio = undefined;
      console.log("Audio model disabled.");
    } else await testAudio(session, draft);
  }
}

async function mcpFields(readline, draft) {
  if (draft.choice === "executor" || draft.choice === "both") {
    const current =
      process.env.EXECUTOR_MCP_URL?.trim() || draft.executorUrl || "";
    draft.executorUrl =
      (
        await readline.question(
          `Executor URL${current ? ` [${current}]` : ""}: `,
        )
      ).trim() || current;
    const typed = await askSecret(
      readline,
      "Executor token",
      Boolean(draft.executorToken || draft.newExecutor),
    );
    if (typed) draft.newExecutor = typed;
  }
  if (draft.choice === "composio" || draft.choice === "both") {
    const current =
      process.env.COMPOSIO_MCP_URL?.trim() ||
      draft.composioUrl ||
      COMPOSIO_CONNECT_URL;
    draft.composioUrl =
      (await readline.question(`Composio MCP URL [${current}]: `)).trim() ||
      current;
    const currentUser =
      process.env.COMPOSIO_USER_ID?.trim() || draft.composioUser || "";
    draft.composioUser =
      (
        await readline.question(
          `User id${currentUser ? ` [${currentUser}]` : ""}: `,
        )
      ).trim() || currentUser;
    const typed = await askSecret(
      readline,
      "Composio key",
      Boolean(draft.composioKey || draft.newComposio),
    );
    if (typed) draft.newComposio = typed;
  }
  if (draft.choice === "none")
    console.log(
      "MCP platform set to none. Saved Executor and Composio credentials are kept.",
    );
}

function saveMcp(draft) {
  if (!draft.choice) return "Choose Executor, Composio, both, or none.";
  const built = aggregatorFields({
    choice: draft.choice,
    executorUrl: draft.executorUrl,
    executorToken: draft.newExecutor || draft.executorToken,
    composioUrl: draft.composioUrl,
    composioUser: draft.composioUser,
    composioKey: draft.newComposio || draft.composioKey,
  });
  if (built.error) return built.error;
  persistAggregators(built.record, {
    ...(draft.newExecutor ? { executor: draft.newExecutor } : {}),
    ...(draft.newComposio ? { composio: draft.newComposio } : {}),
  });
  return "";
}

async function mcpMenu(readline, session) {
  const draft = structuredClone(session.mcp);
  for (;;) {
    console.log("\nMCP platform");
    console.log(
      "Switching platform keeps the other credential. None turns both off without deleting keys.",
    );
    console.log(`Choice: ${draft.choice || "not set"}`);
    console.log("1 - Executor");
    console.log("2 - Composio");
    console.log("3 - Both");
    console.log("4 - None");
    printSectionEnd();
    const action = routeMcpMenu(await readline.question("Choice: "));
    if (!action) {
      console.log("Unknown choice. Use 1, 2, 3, 4, or s.");
      continue;
    }
    if (action === "back") return;
    if (action === "save") {
      const error = saveMcp(draft);
      if (error) {
        console.log(error);
        continue;
      }
      session.mcp = draft;
      return;
    }
    draft.choice = action;
    await mcpFields(readline, draft);
  }
}

function processRows() {
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      rows.push({
        pid: Number(entry),
        command: readFileSync(`/proc/${entry}/cmdline`, "utf8"),
      });
    } catch {
      /* The process exited between readdir and read. */
    }
  }
  return rows;
}

function restartGateway() {
  closeDb();
  let result;
  try {
    result = requestGatewayRestart(processRows(), process.pid);
  } catch (error) {
    console.log(
      error instanceof Error
        ? `Gateway was not restarted: ${error.message}`
        : "Gateway was not restarted.",
    );
    return;
  }
  if (!result.restarted) {
    console.log(
      "Saved. No gateway is running in this container. Start it to apply the volume. Changing environment variables (TZ, TELEGRAM_*, LLM_*, EXECUTOR_*, COMPOSIO_*, CONFIG_FILE) still needs a new container.",
    );
    return;
  }
  console.log(
    `Gateway process ${result.pid} was asked to exit (SIGTERM). The container restart policy starts it again and it re-reads app.sqlite and config.yaml. Redeploying the image is not required. Environment variable changes still need a new container.`,
  );
}

async function interactive() {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const session = loadSession();
  console.log(
    "Enter keeps a saved value. Secrets stay hidden. Save and back writes that section. Save and restart gateway reloads the running bot from the volume.",
  );
  try {
    for (;;) {
      printMain(session);
      const action = routeSetupMenu(await readline.question("Choice: "));
      if (!action) {
        console.log("Unknown choice.");
        continue;
      }
      if (action === "exit") {
        console.log(
          "Exited without saving this visit. Sections already saved stay on the volume.",
        );
        return;
      }
      if (action === "restart") {
        const textReady = Boolean(
          session.text.modelId &&
          (session.text.authMode === "chatgpt" ||
            session.text.apiKey ||
            session.text.newKey),
        );
        if (textReady) {
          const error = await persistSetup(
            session.text.authMode === "chatgpt" ? readline : undefined,
            session,
          );
          if (error) {
            console.log(error);
            continue;
          }
        }
        restartGateway();
        return;
      }
      if (action === "gateway") await gatewayMenu(readline, session);
      else if (action === "text") await textMenu(readline, session);
      else if (action === "image") await imageMenu(readline, session);
      else if (action === "audio") await audioMenu(readline, session);
      else await mcpMenu(readline, session);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("Cancelled.");
      return;
    }
    throw error;
  } finally {
    readline.close();
  }
}
const functionFlags =
  options.vision !== undefined ||
  options.audio !== undefined ||
  options.audioApi !== undefined ||
  options.audioLanguage !== undefined;
const hasFlags =
  options.list ||
  options.dryRun ||
  options.model !== undefined ||
  options.effort !== undefined ||
  options.aggregators !== undefined ||
  options.telegramTokenStdin ||
  options.telegramUsers !== undefined ||
  functionFlags;

function aggregatorLabel() {
  const stored = readStoredAggregators(dir);
  if (!stored.record) return "MCP platform: not set (environment applies)";
  const choice = stored.record.choice;
  const parts = [choice];
  const executorOn = choice === "executor" || choice === "both";
  const composioOn = choice === "composio" || choice === "both";
  if (stored.record.executor)
    parts.push(
      `executor ${stored.record.executor.url}${stored.executorToken ? " (token on volume)" : ""}${executorOn ? "" : " (off)"}`,
    );
  if (stored.record.composio)
    parts.push(
      `composio ${stored.record.composio.url} user ${stored.record.composio.userId}${stored.composioKey ? " (key on volume)" : ""}${composioOn ? "" : " (off)"}`,
    );
  return `MCP platform: ${parts.join(" · ")}`;
}

function telegramLabel() {
  const stored = readStoredTelegram(dir);
  const users = stored.users?.length
    ? stored.users.join(",")
    : "none on the volume";
  return `Telegram: ${stored.token ? "token on the volume" : "no token on the volume"}; users ${users}`;
}

function persistTelegram(users, token) {
  if (options.dryRun) {
    console.log(`(dry-run) telegram: ${users.length} user(s).`);
    return;
  }
  writeStoredTelegram(db, users, token, MODE);
  console.log(
    token
      ? "Telegram saved on the volume. The token is in credentials."
      : "Telegram saved on the volume. The previous token was kept.",
  );
}

function persistAggregators(record, keys) {
  if (options.dryRun) {
    console.log(`(dry-run) MCP platform: ${record.choice}.`);
    return;
  }
  writeStoredAggregators(db, record, keys, MODE);
  console.log(
    `MCP platform saved on the volume (${record.choice}). Keys are in credentials.`,
  );
  warnIfNoAggregator();
}

function warnIfNoAggregator() {
  const stored = readStoredAggregators(dir);
  if (mcpServersFromAggregators(process.env, stored).length === 0)
    console.log(
      "! Warning: no MCP platform is active with a credential. The bot starts without MCP tools.",
    );
}

function aggregatorFields({
  choice,
  executorUrl,
  executorToken,
  composioUrl,
  composioUser,
  composioKey,
}) {
  try {
    const record = { choice };
    const keys = {};
    if (choice === "executor" || choice === "both") {
      if (!executorUrl) return { error: "Executor URL is missing." };
      record.executor = { url: validatePublicEndpoint(executorUrl) };
      if (executorToken) keys.executor = executorToken;
      else if (!operatorSecret(process.env, "EXECUTOR_TOKEN"))
        return {
          error:
            "Executor token is missing. Enter it in the menu, or set EXECUTOR_TOKEN.",
        };
    }
    if (choice === "composio" || choice === "both") {
      const url = validatePublicEndpoint(composioUrl || COMPOSIO_CONNECT_URL);
      if (!validAggregatorUserId(composioUser || ""))
        return { error: "Composio user id is invalid." };
      record.composio = { url, userId: composioUser };
      if (composioKey) keys.composio = composioKey;
      else if (!operatorSecret(process.env, "COMPOSIO_API_KEY"))
        return {
          error:
            "Composio key is missing. Enter it in the menu, or set COMPOSIO_API_KEY.",
        };
      const header = composioAuthHeader(url);
      console.log(
        composioSendsUserId(url)
          ? `  Composio: header ${header}; user id is sent as user_id.`
          : `  Composio: header ${header}. The user id stays on the volume.`,
      );
    }
    return { record, keys };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function telegramFromFlags() {
  if (!options.telegramTokenStdin && options.telegramUsers === undefined)
    return;
  const stored = readStoredTelegram(dir);
  const typed = options.telegramTokenStdin ? (await readStdin()).trim() : "";
  if (typed && !validTelegramToken(typed))
    fail("Invalid Telegram bot token. Use the form 123456:ABC…");
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const envTokenUsable =
    envToken && !/replace_with/i.test(envToken) && validTelegramToken(envToken)
      ? envToken
      : undefined;
  if (!typed && !stored.token && !envTokenUsable)
    fail(
      "Telegram bot token is missing. Use --telegram-token-stdin or the menu.",
      2,
    );
  const usersText =
    options.telegramUsers !== undefined
      ? options.telegramUsers.trim() ||
        stored.users?.join(",") ||
        process.env.TELEGRAM_ALLOWED_USERS?.trim() ||
        ""
      : stored.users?.join(",") ||
        process.env.TELEGRAM_ALLOWED_USERS?.trim() ||
        "";
  const users = parseTelegramUserList(usersText);
  if (!users)
    fail(
      "Telegram users are missing or invalid. Use --telegram-users with comma-separated numeric ids.",
      2,
    );
  persistTelegram(users, typed || undefined);
}

async function aggregatorsFromFlags() {
  const choice = parseAggregatorChoice(options.aggregators || "");
  if (!choice)
    fail(`Invalid MCP platform: ${options.aggregators}\n\n${usage}`, 2);
  const stored = readStoredAggregators(dir);
  let executorToken = stored.executorToken;
  let composioKey = stored.composioKey;
  if (options.executorTokenStdin) {
    const typed = (await readStdin()).trim();
    if (typed) executorToken = typed;
  } else if (options.composioKeyStdin) {
    const typed = (await readStdin()).trim();
    if (typed) composioKey = typed;
  }
  const built = aggregatorFields({
    choice,
    executorUrl:
      options.executorUrl ||
      process.env.EXECUTOR_MCP_URL?.trim() ||
      stored.record?.executor?.url,
    executorToken,
    composioUrl:
      options.composioUrl ||
      process.env.COMPOSIO_MCP_URL?.trim() ||
      stored.record?.composio?.url ||
      COMPOSIO_CONNECT_URL,
    composioUser:
      options.composioUser ||
      process.env.COMPOSIO_USER_ID?.trim() ||
      stored.record?.composio?.userId,
    composioKey,
  });
  if (built.error) fail(built.error);
  persistAggregators(built.record, built.keys);
}
const writes =
  options.model !== undefined || options.effort !== undefined || functionFlags;
/** Selection from flags; `none` clears a function, absent keeps what is stored. */
function selectionFromFlags() {
  // Absent keeps what is stored, never the env value: pressing Enter or omitting a
  // flag must not copy an env-declared model into the database, otherwise removing
  // the variable later would keep a model nobody chose.
  const stored = currentFunctions();
  const pick = (flag, stored) =>
    flag === undefined
      ? stored
      : flag === "none" || flag === ""
        ? undefined
        : { ...(stored ?? {}), modelId: flag };
  const vision = pick(options.vision, stored.vision);
  const audioPick = pick(options.audio, stored.audio);
  const audio = audioPick
    ? {
        ...audioPick,
        ...(options.audioApi ? { api: options.audioApi } : {}),
        ...(options.audioLanguage
          ? { language: options.audioLanguage }
          : options.audioLanguage === ""
            ? { language: "" }
            : {}),
      }
    : undefined;
  return { ...(vision ? { vision } : {}), ...(audio ? { audio } : {}) };
}
try {
  if (
    [
      options.keyStdin,
      options.composioKeyStdin,
      options.executorTokenStdin,
      options.telegramTokenStdin,
    ].filter(Boolean).length > 1
  )
    fail("stdin can carry only one secret per run.", 2);
  if (!hasFlags) {
    if (!process.stdin.isTTY)
      fail(
        `No interactive terminal. Use --provider and --key-stdin (or LLM_API_KEY for the compat path) and --model, or --telegram-token-stdin and --telegram-users.\n\n${usage}`,
        2,
      );
    await interactive();
  } else {
    // Non-interactive path: flags, then the environment, then the stored setup.
    // Telegram first so a token on stdin is consumed before anything else reads it.
    await telegramFromFlags();
    const stored = readStoredSetup(dir);
    const subscriptionFlags =
      options.provider && isSubscriptionChoice(options.provider);
    if (subscriptionFlags) {
      const piProviderId =
        options.provider === "openai-codex" ? "openai-codex" : "openai";
      await loadSubscriptionCatalog(undefined, piProviderId);
    } else {
      const picked = options.provider
        ? resolveSetupChoice(options.provider)
        : stored.record?.providerId
          ? resolveSetupChoice(stored.record.providerId)
          : undefined;
      const stdinKey = options.keyStdin
        ? (await readStdin()).trim()
        : undefined;
      const envKey = operatorSecret(process.env, "LLM_API_KEY");
      const sameNative =
        picked?.kind === "native" &&
        resolveSetupChoice(stored.record?.providerId ?? "")?.id === picked.id;
      // A stored official key beats a leftover LLM_API_KEY. --key-stdin still wins.
      const apiKey =
        stdinKey ||
        (sameNative ? stored.apiKey : undefined) ||
        envKey ||
        (picked?.kind === "native" ? undefined : stored.apiKey);
      if (options.provider && !picked)
        fail(`Invalid provider: ${options.provider}\n\n${usage}`, 2);
      else if (picked?.kind === "native") {
        if (!apiKey && writes)
          fail(
            "API key is missing: use --key-stdin (or LLM_API_KEY for this setup run only).",
          );
        if (apiKey) {
          resolved.apiKey = apiKey;
          loadNativeCatalog(picked.id);
        }
      } else {
        const baseUrl =
          (picked?.kind === "compat" ? picked.baseUrl : undefined) ||
          process.env.LLM_BASE_URL?.trim() ||
          (stored.record?.authMode === "chatgpt"
            ? undefined
            : stored.record?.baseUrl);
        if (baseUrl && apiKey) {
          resolved.baseUrl = baseUrl;
          resolved.apiKey = apiKey;
          resolved.providerId = providerIdFor(baseUrl);
          await loadCatalog(baseUrl, apiKey);
        } else if (writes && !subscriptionFlags && options.provider)
          fail(
            "Provider or key is missing: use --provider and --key-stdin, or --provider chatgpt|openai-codex after login.",
          );
      }
    }
    const baseUrl =
      resolved.baseUrl ||
      process.env.LLM_BASE_URL?.trim() ||
      stored.record?.baseUrl;
    if (
      !writes &&
      !catalog.length &&
      stored.record?.authMode === "chatgpt" &&
      stored.record.providerId
    ) {
      try {
        await loadSubscriptionCatalog(
          undefined,
          stored.record.providerId === "openai" ? "openai" : "openai-codex",
        );
      } catch (error) {
        if (!(
          error instanceof Error && error.code === "SUBSCRIPTION_LOGIN_REQUIRED"
        ))
          throw error;
      }
    }
    if (!writes) {
      if (options.aggregators !== undefined) await aggregatorsFromFlags();
      printState(baseUrl);
    } else if (!catalog.length && subscriptionFlags)
      fail("Catalog is empty: check the subscription login.");
    else if (writes) {
      const entry = entryFor(
        options.model ?? current()?.modelId ?? catalog[0]?.id,
      );
      const selection = functionFlags
        ? selectionFromFlags()
        : currentFunctions();
      if (resolved.chatVision === undefined) {
        if (resolved.mode === "subscription" || resolved.kind === "native") {
          resolved.chatVision = inferChatVision(entry);
          console.log(
            `Text model: ${resolved.chatVision ? "accepts images (catalog)" : "does NOT accept images (catalog)"}`,
          );
        } else {
          const probe = await probeImageSupport({
            modelId: entry.id,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
          });
          resolved.chatVision = probe.verdict === "vision";
          console.log(
            `Text model: ${probe.verdict === "vision" ? "accepts images" : probe.verdict === "text" ? "does NOT accept images" : "not confirmed"}${probe.detail ? ` (${probe.detail})` : ""}`,
          );
        }
      }
      commit(entry, effortFor(entry, options.effort), selection);
      if (functionFlags) {
        if (options.dryRun)
          console.log(`(dry-run) would save ${functionLabel(selection)}.`);
        else console.log(`Functions: ${functionLabel(selection)}`);
        warnEnvPrecedence(selection);
      }
      if (options.aggregators !== undefined) await aggregatorsFromFlags();
    }
  }
} finally {
  closeDb();
}
