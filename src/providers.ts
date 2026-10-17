/** Providers offered by `npm run setup`. Data, not logic: adding one is a single row. */
export interface ProviderEntry {
  id: string;
  name: string;
  /** Chat endpoint root, used verbatim (the adapter appends `/chat/completions`). */
  baseUrl: string;
  docs: string;
  /** One line shown next to the choice. */
  hint?: string;
  /**
   * Known models as `id|contextWindow|maxTokens|reasoning`, the same syntax as
   * LLM_MODELS. Discovery lists ids only, so without this every model reports no
   * reasoning and `/thinking` offers "off" alone.
   */
  models?: Record<string, string>;
}

const CUSTOM_PROVIDER_ID = "custom";

export const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    docs: "https://api-docs.deepseek.com",
    models: {
      // 1M context, 384K output; DeepSeek rejects minimal/medium and accepts max.
      "deepseek-flash": "deepseek-flash|1000000|384000|off+low+high+max",
    },
  },
  {
    id: "gemini",
    name: "Gemini (Google AI Studio)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docs: "https://ai.google.dev/gemini-api/docs/openai",
    hint: "superfície OpenAI-compatible; a raiz já inclui /v1beta/openai",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    docs: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    docs: "https://opencode.ai/docs/zen",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    docs: "https://opencode.ai/docs/zen",
    hint: "catálogo separado do Zen; a mesma chave pode não valer",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    docs: "https://openrouter.ai/docs",
  },
  {
    id: CUSTOM_PROVIDER_ID,
    name: "Outro (OpenAI-compatible)",
    baseUrl: "",
    docs: "",
    hint: "informe a URL raiz, por exemplo https://meu-provedor/v1",
  },
];

/**
 * Rows for the models this endpoint is known to serve, keyed by id without the
 * `models/` prefix some providers add. Unknown ids are absent and keep discovery's
 * conservative defaults.
 */
export function knownModelRows(baseUrl: string): Record<string, string> {
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return {};
  }
  const entry = PROVIDERS.find((candidate) => {
    try {
      return new URL(candidate.baseUrl).host.toLowerCase() === host;
    } catch {
      return false;
    }
  });
  return entry?.models ?? {};
}
