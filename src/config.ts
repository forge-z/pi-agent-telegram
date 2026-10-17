import { readFileSync } from "node:fs";
import {
  createModels,
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  ModelThinkingLevel,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { McpConfig } from "./mcp.js";

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
/** MCP list JSON unless MCP_CONFIG_FILE is set. Explicit MCP_SERVERS_JSON wins over EXECUTOR_MCP_URL. */
export function resolveMcpServersJson(env: Env = process.env) {
  const explicit = env.MCP_SERVERS_JSON?.trim();
  if (explicit && explicit !== "[]") return explicit;
  const url = env.EXECUTOR_MCP_URL?.trim();
  // URL alone must not block startup; wire Executor only when the token is present.
  if (url && operatorSecret(env, "EXECUTOR_TOKEN"))
    return JSON.stringify([
      { name: "executor", url, tokenEnv: "EXECUTOR_TOKEN" },
    ]);
  return explicit ?? "[]";
}
export function readConfig(env: Env = process.env) {
  const token = secret(env, "TELEGRAM_BOT_TOKEN");
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
  if (!token || !/^\d+:[\w-]+$/.test(token))
    throw new Error("Configure TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN_FILE.");
  const users = allowlist(env.TELEGRAM_ALLOWED_USERS, "TELEGRAM_ALLOWED_USERS");
  const chatsRaw = env.TELEGRAM_ALLOWED_CHATS?.trim();
  const chats = chatsRaw
    ? allowlist(env.TELEGRAM_ALLOWED_CHATS, "TELEGRAM_ALLOWED_CHATS", true)
    : [...users];
  const rawMcp = env.MCP_CONFIG_FILE
    ? readFileSync(env.MCP_CONFIG_FILE, "utf8")
    : resolveMcpServersJson(env);
  const parsed = json(rawMcp, "MCP");
  if (!Array.isArray(parsed) || parsed.length > 20)
    throw new Error("MCP deve ser uma lista de até 20 servidores.");
  const mcp: McpConfig[] = parsed.map((v: Record<string, unknown>) => {
    if (
      !v ||
      typeof v.name !== "string" ||
      typeof v.url !== "string" ||
      v.mode === "legacy" ||
      v.token !== undefined
    )
      throw new Error(
        "MCP: use name/url e tokenEnv ou tokenFile; apenas modo direct.",
      );
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
    return {
      name: v.name,
      url: endpoint(v.url),
      mode: "direct",
      readTools: [],
      actionTools: [],
      ...(tokenValue ? { token: tokenValue } : {}),
      ...(v.tokenFile ? { tokenFile: String(v.tokenFile) } : {}),
      ...(v.allowedTools ? { allowedTools: v.allowedTools as string[] } : {}),
      ...(v.deniedTools ? { deniedTools: v.deniedTools as string[] } : {}),
    };
  });
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
/** Validated `LLM_BASE_URL`: HTTPS (loopback may use HTTP), no credentials/query, no trailing slash. */
export function llmBaseUrl(env: Env = process.env) {
  const raw = env.LLM_BASE_URL?.trim();
  if (!raw)
    throw new Error("Configure LLM_BASE_URL (endpoint OpenAI-compatible).");
  return endpoint(raw);
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
 * Registers the one OpenAI-compatible provider from LLM_BASE_URL and LLM_API_KEY.
 * LLM_MODELS declares the catalog explicitly (and is the only way to enable
 * reasoning); without it the catalog is read from `GET {LLM_BASE_URL}/models`.
 * No credential store or OAuth registration: only server-side API keys.
 */
export async function environmentModels(
  env: Env = process.env,
  deps: { fetch?: typeof fetch } = {},
): Promise<MutableModels> {
  const baseUrl = llmBaseUrl(env);
  const key = operatorSecret(env, "LLM_API_KEY");
  if (!key) throw new Error("Configure LLM_API_KEY ou LLM_API_KEY_FILE.");
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
  }
  if (!catalog.length)
    throw new Error(
      "Nenhum modelo disponível. Verifique LLM_BASE_URL ou defina LLM_MODELS.",
    );
  const models = createModels();
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
        // part is sent or replaced by a text marker; the catalog cannot tell vision
        // apart. deepseek-flash reads images, and a text-only model now fails loudly
        // on the first image instead of silently getting a marker.
        input: ["text" as const, "image" as const],
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
  return models;
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
