import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";

/**
 * Official pi-ai providers (package 1.5.0 `builtinProviders()`), keyed by the
 * library's own id. The generic `llm` client is not one of them.
 */
let cached: Provider[] | undefined;
function officialProviders(): Provider[] {
  cached ??= builtinProviders();
  return cached;
}

/** Wizard ids that used to mean a native host behind the compat `llm` client. */
const LEGACY_ALIASES: Record<string, string> = {
  gemini: "google",
  "opencode-zen": "opencode",
};

export function canonicalProviderId(id: string) {
  const value = id.trim().toLowerCase();
  return LEGACY_ALIASES[value] ?? value;
}

export function isOfficialProviderId(id: string) {
  const canonical = canonicalProviderId(id);
  return officialProviders().some((provider) => provider.id === canonical);
}

export function officialProvider(id: string) {
  const canonical = canonicalProviderId(id);
  return officialProviders().find((provider) => provider.id === canonical);
}

/** API-key auth, as opposed to oauth-only ids such as `openai-codex`. */
export function isApiKeyProviderId(id: string) {
  return Boolean(officialProvider(id)?.auth.apiKey);
}

/**
 * Anthropic stays on the API-key route. pi-ai also ships Claude Pro/Max OAuth;
 * this bot does not collect that login (ChatGPT/Codex OAuth is unchanged).
 */
function anthropicApiKeyProvider(): Provider {
  const anthropic = anthropicProvider();
  const apiKey = anthropic.auth.apiKey;
  if (!apiKey) return anthropic;
  return {
    ...anthropic,
    auth: {
      apiKey: {
        ...apiKey,
        resolve: async ({ ctx, credential, signal }) => {
          const key = credential?.key ?? (await ctx.env("ANTHROPIC_API_KEY"));
          signal.throwIfAborted();
          if (!key || key.includes("sk-ant-oat")) return undefined;
          return apiKey.resolve({
            ctx: {
              env: async (name: string) =>
                name === "ANTHROPIC_API_KEY" ? key : undefined,
              fileExists: async () => false,
            },
            credential: credential ? { type: "api_key", key } : undefined,
            signal,
          });
        },
      },
    },
  };
}

/** Registers every built-in pi-ai provider. Anthropic OAuth is left off. */
export function registerOfficialProviders(models: MutableModels) {
  for (const provider of officialProviders()) {
    models.setProvider(
      provider.id === "anthropic" ? anthropicApiKeyProvider() : provider,
    );
  }
}

/**
 * One `prompt({ type: "secret" })` and a real endpoint: the setup wizard can
 * store `{ type: "api_key", key }` and the catalog is usable. Providers whose
 * login asks for more than the key (Bedrock, Vertex, Azure, Cloudflare) stay
 * registered for the runtime but are not offered as a key prompt.
 */
function singleSecretApiKey(provider: Provider) {
  const login = provider.auth.apiKey?.login;
  if (!login) return false;
  const source = login.toString();
  const prompts = source.match(/prompt\(/g)?.length ?? 0;
  if (
    prompts !== 1 ||
    !source.includes('type: "secret"') ||
    source.includes("select")
  )
    return false;
  const models = provider.getModels();
  if (!models.length) return false;
  if (provider.baseUrl) return true;
  return models.some((model) => Boolean(model.baseUrl));
}

export interface SetupChoice {
  id: string;
  name: string;
  kind: "native" | "compat";
  hint: string;
  baseUrl?: string;
}

const COMPAT_CHOICE: SetupChoice = {
  id: "custom",
  name: "Outro (OpenAI-compatible)",
  kind: "compat",
  hint: "reserva opcional: proxy ou host sem provedor nativo",
};

let choices: SetupChoice[] | undefined;
/** Native API-key providers in menu order, plus the compat reserve at the end. */
export function setupChoices(): SetupChoice[] {
  if (choices) return choices;
  const native = officialProviders()
    .filter(singleSecretApiKey)
    .map((provider): SetupChoice => ({
      id: provider.id,
      name: provider.name,
      kind: "native",
      hint: "catálogo oficial",
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt"));
  choices = [...native, COMPAT_CHOICE];
  return choices;
}

export function resolveSetupChoice(answer: string): SetupChoice | undefined {
  const raw = answer.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return { ...COMPAT_CHOICE, baseUrl: raw };
  const menu = setupChoices();
  const index = Number(raw);
  if (Number.isSafeInteger(index) && index >= 1 && index <= menu.length)
    return menu[index - 1];
  const id = canonicalProviderId(raw);
  return menu.find((choice) => choice.id === id);
}

export function findCatalogModel(
  providerId: string,
  modelId: string,
): Model<string> | undefined {
  const provider = officialProvider(providerId);
  if (!provider) return undefined;
  const bare = modelId.replace(/^models\//, "");
  return provider
    .getModels()
    .find((model) => model.id === modelId || model.id === bare);
}

/** Non-empty LLM_BASE_URL / LLM_API_KEY (or a key file). Placeholders do not count. */
export function compatEnvConfigured(env: Record<string, string | undefined>) {
  const set = (name: string) => {
    if (env[`${name}_FILE`]?.trim()) return true;
    const raw = env[name]?.trim();
    return Boolean(raw && !/^replace_with/i.test(raw));
  };
  return set("LLM_BASE_URL") || set("LLM_API_KEY");
}
