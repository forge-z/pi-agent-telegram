import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type {
  StoredAggregators,
  StoredSetup,
  StoredTelegram,
} from "./setup.js";
import { validAggregatorUserId, validTelegramToken } from "./setup.js";
import { readFileSync } from "node:fs";
import {
  createModels,
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { knownModelRows } from "./providers.js";
import type {
  ModelThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { McpConfig } from "./mcp.js";
import {
  anySubscriptionAuthenticated,
  chatgptAuthMode,
  subscriptionSetupPending,
} from "./subscription-auth.js";
import {
  canonicalProviderId,
  isApiKeyProviderId,
  isOfficialProviderId,
  registerOfficialProviders,
} from "./native-providers.js";

type Env = Record<string, string | undefined>;
const secret = (env: Env, name: string) =>
  env[`${name}_FILE`]
    ? readFileSync(env[`${name}_FILE`]!, "utf8").trim()
    : env[name]?.trim();
/** Ignore .env.example placeholders and a pasted Authorization header prefix. */
export function operatorSecret(env: Env, name: string) {
  const raw = secret(env, name);
  if (!raw || /^replace_with/i.test(raw)) return undefined;
  const value = raw.replace(/^Bearer\s+/i, "").trim();
  return value || undefined;
}
function validToolNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 200,
    )
  );
}
function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: JSON inválido`);
  }
}
function endpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Endpoint inválido");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      "Endpoint exige HTTPS sem credenciais/query (HTTP somente loopback).",
    );
  return url.href.replace(/\/$/, "");
}
/** Hosted Composio Connect MCP. Project URLs use `x-api-key` instead. */
export const COMPOSIO_CONNECT_URL = "https://connect.composio.dev/mcp";
export const COMPOSIO_SERVER_NAME = "composio";

/**
 * Header Composio documents for this host.
 * `connect.composio.dev` takes `x-consumer-api-key`. Every other hosted MCP URL
 * takes `x-api-key`.
 */
export function composioAuthHeader(url: string) {
  return new URL(url).hostname.toLowerCase() === "connect.composio.dev"
    ? "x-consumer-api-key"
    : "x-api-key";
}

/**
 * Project and session MCP URLs scope the user with a `user_id` query.
 * Connect identifies the user by the consumer key and does not take that query.
 */
export function composioSendsUserId(url: string) {
  return new URL(url).hostname.toLowerCase() !== "connect.composio.dev";
}

/** Same public-endpoint check the MCP list uses. */
export function validatePublicEndpoint(value: string) {
  return endpoint(value);
}

function blank(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Executor and Composio from the volume, with env vars overriding each field.
 * A complete env pair also turns that aggregator on. `MCP_SERVERS_JSON` does not
 * come through here.
 */
export function mcpServersFromAggregators(
  env: Env,
  stored?: StoredAggregators,
): McpConfig[] {
  const record = stored?.record;
  const choice = record?.choice;
  const executorUrl = blank(env.EXECUTOR_MCP_URL);
  const executorToken =
    operatorSecret(env, "EXECUTOR_TOKEN") || stored?.executorToken;
  const composioUrl = blank(env.COMPOSIO_MCP_URL);
  const composioKey =
    operatorSecret(env, "COMPOSIO_API_KEY") || stored?.composioKey;
  const composioUser = blank(env.COMPOSIO_USER_ID) || record?.composio?.userId;
  const legacy = !record;
  const envExecutor = Boolean(
    executorUrl && operatorSecret(env, "EXECUTOR_TOKEN"),
  );
  const envComposio = Boolean(
    composioUrl && operatorSecret(env, "COMPOSIO_API_KEY"),
  );
  const wantExecutor = legacy
    ? envExecutor
    : choice === "executor" || choice === "both" || envExecutor;
  const wantComposio = legacy
    ? envComposio
    : choice === "composio" || choice === "both" || envComposio;
  const servers: McpConfig[] = [];
  if (wantExecutor) {
    const url = executorUrl || record?.executor?.url;
    if (url && executorToken)
      servers.push({
        name: "executor",
        url: endpoint(url),
        mode: "direct",
        token: executorToken,
      });
  }
  if (wantComposio) {
    const url = composioUrl || record?.composio?.url;
    if (url && composioKey) {
      const normalized = endpoint(url);
      const sendUser = composioSendsUserId(normalized);
      if (sendUser && !composioUser)
        throw new Error(
          "COMPOSIO_USER_ID ausente para esta URL MCP do Composio.",
        );
      if (sendUser && composioUser && !validAggregatorUserId(composioUser))
        throw new Error("COMPOSIO_USER_ID inválido.");
      servers.push({
        name: COMPOSIO_SERVER_NAME,
        url: normalized,
        mode: "direct",
        token: composioKey,
        tokenHeader: composioAuthHeader(normalized),
        ...(sendUser && composioUser ? { userId: composioUser } : {}),
      });
    }
  }
  return servers;
}

function parseMcpList(parsed: unknown, env: Env): McpConfig[] {
  if (!Array.isArray(parsed) || parsed.length > 20)
    throw new Error("MCP deve ser uma lista de até 20 servidores.");
  return parsed.map((v: Record<string, unknown>) => {
    if (
      !v ||
      typeof v.name !== "string" ||
      typeof v.url !== "string" ||
      v.token !== undefined
    )
      throw new Error(
        "MCP: use name/url e tokenEnv ou tokenFile; apenas modo direct ou deferred.",
      );
    if (v.mode !== undefined && v.mode !== "direct" && v.mode !== "deferred")
      throw new Error(
        "MCP: use name/url e tokenEnv ou tokenFile; apenas modo direct ou deferred.",
      );
    let alwaysLoad: string[] | undefined;
    if (v.alwaysLoad !== undefined) {
      if (!validToolNameList(v.alwaysLoad))
        throw new Error("MCP alwaysLoad inválido.");
      alwaysLoad = v.alwaysLoad;
    }
    if (
      v.tokenEnv !== undefined &&
      (typeof v.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(v.tokenEnv))
    )
      throw new Error("MCP tokenEnv inválido.");
    const tokenValue = v.tokenEnv
      ? operatorSecret(env, String(v.tokenEnv))
      : undefined;
    if (v.tokenEnv && !tokenValue)
      throw new Error(
        `Variável de token MCP ausente (${String(v.tokenEnv)}). Use a chave crua, sem prefixo Bearer.`,
      );
    if (v.tokenFile !== undefined && typeof v.tokenFile !== "string")
      throw new Error("MCP tokenFile inválido.");
    if (
      v.tokenHeader !== undefined &&
      (typeof v.tokenHeader !== "string" ||
        !/^[\w-]{1,64}$/.test(v.tokenHeader))
    )
      throw new Error("MCP tokenHeader inválido.");
    if (
      v.userId !== undefined &&
      (typeof v.userId !== "string" || !validAggregatorUserId(v.userId))
    )
      throw new Error("MCP userId inválido.");
    return {
      name: v.name,
      url: endpoint(v.url),
      mode: v.mode === "deferred" ? "deferred" : "direct",
      ...(tokenValue ? { token: tokenValue } : {}),
      ...(v.tokenFile ? { tokenFile: String(v.tokenFile) } : {}),
      ...(typeof v.tokenHeader === "string"
        ? { tokenHeader: v.tokenHeader }
        : {}),
      ...(typeof v.userId === "string" ? { userId: v.userId } : {}),
      ...(alwaysLoad ? { alwaysLoad } : {}),
      ...(v.allowedTools ? { allowedTools: v.allowedTools as string[] } : {}),
      ...(v.deniedTools ? { deniedTools: v.deniedTools as string[] } : {}),
    };
  });
}

export function readConfig(
  env: Env = process.env,
  stored?: StoredAggregators,
  telegram?: StoredTelegram,
) {
  // A placeholder left in the environment is not an override: the volume token stands.
  const fromEnv = secret(env, "TELEGRAM_BOT_TOKEN");
  const envToken =
    fromEnv && !/replace_with/i.test(fromEnv) ? fromEnv : undefined;
  if (envToken && !validTelegramToken(envToken))
    throw new Error("Configure TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN_FILE.");
  const token = envToken || telegram?.token;
  const allowlist = (
    value: string | undefined,
    name: "TELEGRAM_ALLOWED_USERS" | "TELEGRAM_ALLOWED_CHATS",
    negative = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed)
      throw new Error(
        `Configure ${name} (IDs numéricos separados por vírgula; supergrupos usam ID negativo).`,
      );
    const rows = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      !rows.length ||
      rows.some(
        (s) =>
          !(negative ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(s) ||
          !Number.isSafeInteger(Number(s)),
      )
    )
      throw new Error(
        `${name} inválido: use IDs numéricos separados por vírgula${
          negative ? " (supergrupos nativos com ID negativo)" : ""
        }.`,
      );
    return [...new Set(rows)];
  };
  if (!token) throw new SetupRequiredError("token do Telegram");
  if (!validTelegramToken(token))
    throw new Error("Configure TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN_FILE.");
  const usersSource =
    env.TELEGRAM_ALLOWED_USERS?.trim() || telegram?.users?.join(",");
  if (!usersSource)
    throw new SetupRequiredError("usuários permitidos do Telegram");
  const users = allowlist(usersSource, "TELEGRAM_ALLOWED_USERS");
  const chatsRaw = env.TELEGRAM_ALLOWED_CHATS?.trim();
  const chats = chatsRaw
    ? allowlist(env.TELEGRAM_ALLOWED_CHATS, "TELEGRAM_ALLOWED_CHATS", true)
    : [...users];
  const explicitMcp = env.MCP_SERVERS_JSON?.trim();
  const rawMcp = env.MCP_CONFIG_FILE
    ? readFileSync(env.MCP_CONFIG_FILE, "utf8")
    : explicitMcp && explicitMcp !== "[]"
      ? explicitMcp
      : undefined;
  const mcp: McpConfig[] = rawMcp
    ? parseMcpList(json(rawMcp, "MCP"), env)
    : mcpServersFromAggregators(env, stored);
  return {
    token,
    users,
    chats,
    mcp,
    dir: env.DATA_DIR ?? "data",
  };
}
/** When TELEGRAM_ALLOWED_CHATS lists the bot id instead of the human chat id (typical DM mistake). */
export function telegramAllowlistMisconfiguration(
  botId: number,
  config: { users: string[]; chats: string[] },
) {
  const bot = String(botId);
  if (!config.chats.includes(bot)) return;
  const userHint = config.users.length
    ? " Omita TELEGRAM_ALLOWED_CHATS (o padrão é copiar ALLOWED_USERS) ou use o user id, não o id do bot."
    : " Em DM privada, o chat id é o user id (não o id do bot).";
  return `TELEGRAM_ALLOWED_CHATS contém ${bot}, que é o id do bot, não do chat.${userHint}`;
}
/** Fixed id of the single OpenAI-compatible provider described by LLM_* env vars. */
export const LLM_PROVIDER_ID = "llm";
/** GET /models carries no metadata, so discovered models start at conservative limits. */
const DISCOVERED_CONTEXT_WINDOW = 32768;
const DISCOVERED_MAX_TOKENS = 4096;
interface LlmModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Present when `LLM_MODELS` pins an explicit level list instead of `true`/`false`. */
  thinkingLevelMap?: ThinkingLevelMap;
}
const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
/**
 * `true` keeps the standard levels (no map), a `+` separated list pins exactly the
 * levels the upstream model accepts — DeepSeek, for example, rejects `minimal` and
 * `medium` and supports `max`. Levels outside the list are mapped to `null`, which is
 * how pi-ai hides an unsupported level.
 */
function parseThinkingLevels(
  id: string,
  value: string,
): ThinkingLevelMap | undefined {
  if (value === "true") return undefined;
  const levels = value
    .split("+")
    .map((level) => level.trim())
    .filter(Boolean);
  if (
    !levels.length ||
    levels.some(
      (level) => !MODEL_THINKING_LEVELS.includes(level as ModelThinkingLevel),
    )
  )
    throw new Error(
      `LLM_MODELS inválido para ${id}: reasoning aceita false, true ou níveis separados por + (${MODEL_THINKING_LEVELS.join("+")}).`,
    );
  const allowed = new Set(levels);
  return Object.fromEntries(
    MODEL_THINKING_LEVELS.map((level) => [
      level,
      allowed.has(level) ? level : null,
    ]),
  ) as ThinkingLevelMap;
}
/**
 * `id` or `id|contextWindow|maxTokens|reasoning`. Discovery cannot see whether a
 * model reasons, so reasoning/thinking stays off unless it is declared here.
 */
export function parseLlmModels(
  value: string | undefined,
): LlmModel[] | undefined {
  const rows = (value ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
  if (!rows.length) return undefined;
  const models = rows.map((row) => {
    const parts = row.split("|").map((part) => part.trim());
    const id = parts[0];
    if (!id || id.length > 200 || ![1, 4].includes(parts.length))
      throw new Error(
        "LLM_MODELS inválido: use id ou id|contextWindow|maxTokens|reasoning.",
      );
    if (parts.length === 1)
      return {
        id,
        contextWindow: DISCOVERED_CONTEXT_WINDOW,
        maxTokens: DISCOVERED_MAX_TOKENS,
        reasoning: false,
      };
    const contextWindow = Number(parts[1]);
    const maxTokens = Number(parts[2]);
    if (
      !Number.isSafeInteger(contextWindow) ||
      contextWindow < 32768 ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens <= 0 ||
      maxTokens >= contextWindow
    )
      throw new Error(
        "LLM_MODELS inválido: exige contextWindow >= 32768 e 0 < maxTokens < contextWindow.",
      );
    if (parts[3] === "false")
      return { id, contextWindow, maxTokens, reasoning: false };
    const thinkingLevelMap = parseThinkingLevels(id, parts[3]);
    return {
      id,
      contextWindow,
      maxTokens,
      reasoning: true,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    };
  });
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
async function requestModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
) {
  try {
    return await fetchImpl(`${baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === "TimeoutError"
        ? "endpoint LLM não respondeu em 10s"
        : "endpoint LLM inacessível",
    );
  }
}
/** OpenAI-compatible model listing. Never echoed back as an error message. */
export async function discoverLlmModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmModel[]> {
  const response = await requestModels(baseUrl, apiKey, fetchImpl);
  // 401/403 point at the key; 404 usually means a missing version segment.
  if (!response.ok)
    throw new Error(`endpoint LLM respondeu HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new Error("catálogo inválido");
  const ids = rows
    .map((row) =>
      row &&
      typeof row === "object" &&
      typeof (row as { id?: unknown }).id === "string"
        ? (row as { id: string }).id.trim()
        : "",
    )
    .filter((id) => !!id && id.length <= 200);
  return [...new Set(ids)].map((id) => ({
    id,
    contextWindow: DISCOVERED_CONTEXT_WINDOW,
    maxTokens: DISCOVERED_MAX_TOKENS,
    reasoning: false,
  }));
}
/** Friendly names for endpoints we can identify. Anything else falls back to its host. */
const KNOWN_ENDPOINTS: Record<string, string> = {
  "api.deepseek.com": "DeepSeek",
  "api.openai.com": "OpenAI",
  "api.anthropic.com": "Anthropic",
  "api.x.ai": "xAI",
  "openrouter.ai": "OpenRouter",
  "api.mistral.ai": "Mistral",
  "api.groq.com": "Groq",
  "api.together.xyz": "Together",
  "api.cerebras.ai": "Cerebras",
  "generativelanguage.googleapis.com": "Google",
};
/** The provider id is always `llm`; this is only the name shown in menus. */
export function providerNameFromEndpoint(baseUrl: string) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (["127.0.0.1", "localhost", "[::1]"].includes(host)) return "Local";
  if (KNOWN_ENDPOINTS[host]) return KNOWN_ENDPOINTS[host];
  const label = host
    .split(".")
    .find(
      (part) =>
        ![
          "api",
          "www",
          "gw",
          "gateway",
          "llm",
          "v1",
          "com",
          "net",
          "org",
          "io",
          "ai",
        ].includes(part),
    );
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : host;
}
/**
 * What the chat model accepts. The catalog cannot tell vision apart, so it is declared:
 * LLM_INPUT=text makes a text-only model honest instead of letting the provider replace
 * an image with a text marker.
 */
function declaredInput(env: Env) {
  const raw = env.LLM_INPUT?.trim().toLowerCase();
  if (!raw) return ["text" as const, "image" as const];
  const images = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part === "image");
  return ["text" as const, ...images.map(() => "image" as const)];
}
/**
 * Registers the generic OpenAI-compatible `llm` provider from env/setup API keys.
 * ChatGPT subscription OAuth uses pi-ai providers `openai` / `openai-codex` via
 * `bootstrapModels` and `npm run login`.
 */
/**
 * No usable provider: the bot waits for `npm run setup` instead of exiting, so the
 * container keeps the terminal needed to fix it.
 */
export class SetupRequiredError extends Error {
  constructor(missing = "provedor, chave") {
    super(
      missing.includes("login")
        ? `Configuração inicial ausente (${missing}). Rode \`npm run login\` no terminal do container.`
        : `Configuração inicial ausente (${missing}). Rode \`npm run setup\` no terminal do container.`,
    );
  }
}

async function registerLlmApiKeyProvider(
  models: MutableModels,
  env: Env,
  deps: {
    fetch?: typeof fetch;
    stored?: StoredSetup;
  },
) {
  // Compat reserve only. A complete official CLI setup never reaches this function,
  // so leftover LLM_* cannot put the bot back on the generic `llm` provider.
  // Inside this reserve, env still wins over a stored compat endpoint.
  const rawBase =
    env.LLM_BASE_URL?.trim() || deps.stored?.record?.baseUrl?.trim();
  const key = operatorSecret(env, "LLM_API_KEY") || deps.stored?.apiKey;
  // Half a configuration is still "not configured": waiting is recoverable, exiting
  // leaves a container that the platform restarts forever.
  if (!rawBase && !key) throw new SetupRequiredError();
  if (!rawBase) throw new SetupRequiredError("endpoint do provedor");
  if (!key) throw new SetupRequiredError("chave de API");
  const baseUrl = endpoint(rawBase);
  let catalog = parseLlmModels(env.LLM_MODELS);
  if (!catalog) {
    try {
      catalog = await discoverLlmModels(baseUrl, key, deps.fetch ?? fetch);
    } catch (error) {
      const reason = error instanceof Error ? ` (${error.message})` : "";
      throw new Error(
        `Catálogo de modelos indisponível em LLM_BASE_URL${reason}; defina LLM_MODELS explicitamente.`,
      );
    }
    // Discovery reports ids only, so every model would claim no reasoning and offer
    // "off" alone. Curated rows restore limits and levels for the ids we know;
    // anything else keeps the conservative defaults.
    const known = knownModelRows(baseUrl);
    if (Object.keys(known).length)
      catalog =
        parseLlmModels(
          catalog
            .map(
              (model) => known[model.id.replace(/^models\//, "")] ?? model.id,
            )
            .join(","),
        ) ?? catalog;
  }
  if (!catalog.length)
    throw new Error(
      "Nenhum modelo disponível. Verifique LLM_BASE_URL ou defina LLM_MODELS.",
    );
  models.setProvider(
    createProvider({
      id: LLM_PROVIDER_ID,
      name: providerNameFromEndpoint(baseUrl),
      baseUrl,
      models: catalog.map((model) => ({
        id: model.id,
        name: model.id,
        api: "openai-completions" as const,
        provider: LLM_PROVIDER_ID,
        baseUrl,
        // The declared input is what the provider uses to decide whether an image
        // part is sent or replaced by a text marker; LLM_INPUT declares it.
        input: declaredInput(env),
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.thinkingLevelMap
          ? { thinkingLevelMap: model.thinkingLevelMap }
          : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      auth: {
        apiKey: {
          name: "API key",
          resolve: async () => ({
            auth: { apiKey: key, baseUrl },
            source: "Environment API key",
          }),
        },
      },
      api: openAICompletionsApi(),
    }),
  );
}

function usableCredential(credential: Credential | undefined) {
  if (!credential) return false;
  if (credential.type === "oauth") return Boolean(credential.access);
  return Boolean(credential.key);
}

async function readCredential(
  credentials: CredentialStore,
  providerId: string,
) {
  try {
    return await credentials.read(canonicalProviderId(providerId));
  } catch {
    return undefined;
  }
}

/**
 * A complete official CLI setup (native key, or ChatGPT/Codex record) wins over
 * leftover LLM_BASE_URL / LLM_API_KEY. A compat record, or a legacy `llm` key
 * whose model is not in the native catalog, does not.
 */
async function officialVolumeWins(
  credentials: CredentialStore,
  stored: StoredSetup | undefined,
) {
  const record = stored?.record;
  if (
    record &&
    (record.authMode === "chatgpt" || record.providerId === "openai-codex")
  )
    return true;
  if (record && isApiKeyProviderId(record.providerId)) {
    return usableCredential(
      await readCredential(credentials, record.providerId),
    );
  }
  if (record) return false;
  try {
    const listed = await credentials.list();
    return listed.some(
      (row) =>
        isOfficialProviderId(row.providerId) &&
        (row.type === "api_key" || row.type === "oauth"),
    );
  } catch {
    return false;
  }
}

async function storedOfficialReady(
  models: MutableModels,
  credentials: CredentialStore,
  stored: StoredSetup | undefined,
) {
  const candidates: string[] = [];
  const record = stored?.record;
  if (record?.providerId && isOfficialProviderId(record.providerId))
    candidates.push(canonicalProviderId(record.providerId));
  try {
    for (const row of await credentials.list()) {
      if (isOfficialProviderId(row.providerId)) candidates.push(row.providerId);
    }
  } catch {
    /* An unreadable store is "not configured", not a crash. */
  }
  for (const id of [...new Set(candidates)]) {
    if (!usableCredential(await readCredential(credentials, id))) continue;
    try {
      if (await models.checkAuth(id)) return true;
    } catch {
      /* Provider missing or store closed — try the next credential. */
    }
  }
  return false;
}

/** Catalog of official providers, with no compat `llm` registration and no startup throw. */
export function officialModels(credentials?: CredentialStore): MutableModels {
  const models = createModels(credentials ? { credentials } : {});
  registerOfficialProviders(models);
  return models;
}

/**
 * Runtime registry. With a credential store, every built-in pi-ai provider is
 * registered (ChatGPT/Codex OAuth included). The generic `llm` provider is
 * registered only as a compat reserve, and never when an official CLI setup
 * is already complete.
 */
export async function bootstrapModels(
  credentials: CredentialStore | undefined,
  env: Env = process.env,
  deps: {
    fetch?: typeof fetch;
    stored?: StoredSetup;
  } = {},
): Promise<MutableModels> {
  const models = createModels(credentials ? { credentials } : {});
  if (credentials) registerOfficialProviders(models);

  const official =
    !!credentials && (await officialVolumeWins(credentials, deps.stored));

  let llmRegistered = false;
  if (!official) {
    try {
      await registerLlmApiKeyProvider(models, env, deps);
      llmRegistered = true;
    } catch (error) {
      if (!(error instanceof SetupRequiredError)) throw error;
      if (!credentials) throw error;
    }
  }

  if (llmRegistered) return models;

  if (
    credentials &&
    (await storedOfficialReady(models, credentials, deps.stored))
  )
    return models;

  const record = deps.stored?.record;
  const wantsSubscription =
    chatgptAuthMode(env) ||
    record?.authMode === "chatgpt" ||
    record?.providerId === "openai-codex" ||
    subscriptionSetupPending(
      record?.authMode === "chatgpt" || record?.providerId === "openai-codex"
        ? record
        : undefined,
    );
  if (credentials && wantsSubscription) {
    if (await anySubscriptionAuthenticated(models)) return models;
    throw new SetupRequiredError("login ChatGPT");
  }
  if (credentials && (await anySubscriptionAuthenticated(models)))
    return models;

  throw new SetupRequiredError();
}

/**
 * Provider/model the stored volume selected. Compat records stay unset here so
 * the `llm` default row written by the wizard remains the source.
 */
export async function preferredVolumeSelection(
  models: MutableModels,
  credentials: CredentialStore,
  stored: StoredSetup | undefined,
): Promise<{ provider: string; modelId: string; effort?: string } | undefined> {
  const record = stored?.record;
  if (
    record?.modelId &&
    record.providerId &&
    models.getProvider(canonicalProviderId(record.providerId))
  ) {
    const provider = canonicalProviderId(record.providerId);
    const subscription =
      record.authMode === "chatgpt" || record.providerId === "openai-codex";
    if (
      subscription ||
      usableCredential(await readCredential(credentials, provider))
    ) {
      const bare = record.modelId.replace(/^models\//, "");
      const model =
        models.getModel(provider, record.modelId) ??
        models.getModel(provider, bare);
      if (model || subscription)
        return {
          provider,
          modelId: model?.id ?? bare,
          ...(record.effort ? { effort: record.effort } : {}),
        };
    }
  }
  if (record) return undefined;
  let listed: readonly { providerId: string; type: "api_key" | "oauth" }[] = [];
  try {
    listed = await credentials.list();
  } catch {
    return undefined;
  }
  for (const row of listed) {
    if (!isOfficialProviderId(row.providerId)) continue;
    if (!usableCredential(await readCredential(credentials, row.providerId)))
      continue;
    try {
      if (!(await models.checkAuth(row.providerId))) continue;
    } catch {
      continue;
    }
    const model = models
      .getModels(row.providerId)
      .find(
        (item) =>
          !/(tts|whisper|transcri|embedding|embed-|imagen|veo|dall-e|moderation|realtime)/i.test(
            item.id,
          ),
      );
    if (model) return { provider: row.providerId, modelId: model.id };
  }
  return undefined;
}

/** Test and setup-script entry: compat API-key provider only (no volume credentials). */
export async function environmentModels(
  env: Env = process.env,
  deps: {
    fetch?: typeof fetch;
    stored?: StoredSetup;
  } = {},
): Promise<MutableModels> {
  return bootstrapModels(undefined, env, deps);
}

const startupSecret =
  /(?:Bearer\s+\S+|sk-[\w-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,})/i;
/** Operator-safe startup errors only; never echo transport bodies or secrets. */
export function startupErrorMessage(error: unknown) {
  const fallback =
    "Falha ao iniciar. Verifique configuração, volume e conectividade; detalhes privados omitidos.";
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message || message.length > 320 || startupSecret.test(message))
    return fallback;
  return message;
}

/** Values stay in memory; error and Telegram output must not echo configured credentials. */
export function secretRedactor(env: Env = process.env, mcp: McpConfig[] = []) {
  const names = new Set(
    Object.keys(env)
      .filter((name) =>
        /(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:_FILE)?$/.test(name),
      )
      .map((name) => name.replace(/_FILE$/, "")),
  );
  const values = [...names].map((name) => secret(env, name));
  for (const server of mcp) {
    if (server.token) values.push(server.token);
    if (server.tokenFile)
      values.push(readFileSync(server.tokenFile, "utf8").trim());
  }
  const known = [
    ...new Set(
      values
        .filter((v): v is string => !!v && v.length >= 6)
        .flatMap((value) => [
          value,
          value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;"),
          encodeURIComponent(value),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) =>
    known.reduce((safe, value) => safe.split(value).join("[REDACTED]"), text);
}
