import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import type { Credential, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Runtime } from "./runtime.js";
import { functionKeyId, setupKey, type SetupRecord } from "./setup.js";
import { LLM_PROVIDER_ID } from "./config.js";

export interface ModelSettings {
  provider: string;
  modelId: string;
  effort: ModelThinkingLevel;
}
export class SettingsError extends Error {}
/** Globals live in app.sqlite, so `npm run setup-model` can write them directly. */
export const modelDefaultsKey = (mode = "live") =>
  `model-defaults-selection:${mode}`;
/** Written only when the default was chosen on purpose (setup-model or /model). */
export const modelDefaultsConfirmedKey = (mode = "live") =>
  `model-defaults-confirmed:${mode}`;
/** One-shot "no default chosen yet" notice, tracked per conversation. */
const modelNoticeKey = (conversationId: string) =>
  `model-notice:${conversationId}`;
export class Settings {
  constructor(private app: Runtime) {
    // Environment/Compose is a bootstrap hint, never a restart policy. Keep
    // demo and live isolated, including migration of provider-scoped defaults.
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      this.defaultsKey,
      JSON.stringify(this.defaults()),
    );
  }
  /** Keys the wizard stored for a backend on another host, keyed by function. */
  setupKeys(): { vision?: string; audio?: string } {
    const read = (id: string) => {
      const row = this.app.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider=?",
        id,
      );
      if (!row) return undefined;
      try {
        return (JSON.parse(row.value) as { key?: string }).key || undefined;
      } catch {
        return undefined;
      }
    };
    return {
      vision: read(functionKeyId("vision")),
      audio: read(functionKeyId("audio")),
    };
  }
  /** The record written by `npm run setup`: provider, model and the optional backends. */
  setup(): SetupRecord | undefined {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      setupKey(this.app.options.mode ?? "demo"),
    );
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value) as SetupRecord;
      return parsed && typeof parsed.modelId === "string" ? parsed : undefined;
    } catch {
      /* A hand-edited row must not break the turn; the setup just stays unset. */
      return undefined;
    }
  }
  private get initialProvider() {
    return (
      this.app.options.provider ??
      this.app.models.getProviders()[0]?.id ??
      (this.app.options.mode === "live" ? LLM_PROVIDER_ID : "faux")
    );
  }
  private get defaultsKey() {
    return modelDefaultsKey(this.app.options.mode ?? "demo");
  }
  get provider() {
    return this.defaults().provider;
  }
  private credential(provider: string): Credential | undefined {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      provider,
    );
    return row ? (JSON.parse(row.value) as Credential) : undefined;
  }
  defaults(): ModelSettings {
    const row =
      this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        this.defaultsKey,
      ) ??
      this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `model-defaults:${this.initialProvider}`,
      );
    if (row) {
      try {
        return this.validate(
          JSON.parse(row.value) as Record<string, unknown>,
          this.initialProvider,
        );
      } catch {
        /* A removed catalog entry must not break all new conversations. */
      }
    }
    const provider = this.initialProvider;
    const modelId =
      this.app.options.modelId ??
      (this.app.options.mode === "live"
        ? this.catalog(provider)[0]?.id
        : "faux-1");
    // MODEL_PROVIDER/MODEL_ID leaving the environment must not leave live
    // conversations without a model: fall back to the first catalog entry.
    if (!modelId)
      throw new SettingsError(
        "Nenhum modelo disponível. Confira LLM_BASE_URL/LLM_MODELS e rode npm run setup-model.",
      );
    const model = this.app.models.getModel(provider, modelId);
    // The stored setup is a bootstrap, so a model it names must exist: failing here is
    // better than silently running another one.
    if (this.app.options.modelId && !model)
      throw new SettingsError(
        `O modelo ${this.app.options.modelId} do setup não está no catálogo do provedor. Rode npm run setup.`,
      );
    const wanted = this.app.options.effort;
    const levels = model ? getSupportedThinkingLevels(model) : [];
    return {
      provider,
      modelId,
      effort:
        wanted && levels.includes(wanted as ModelThinkingLevel)
          ? (wanted as ModelThinkingLevel)
          : model
            ? clampThinkingLevel(model, "high")
            : "high",
    };
  }
  catalog(provider = this.provider) {
    const registered = this.app.models.getProvider(provider);
    const models = this.app.models.getModels(provider);
    return (
      registered?.filterModels?.(models, this.credential(provider)) ?? models
    ).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      efforts: getSupportedThinkingLevels(model),
    }));
  }
  validate(
    value: Record<string, unknown>,
    fallbackProvider = this.provider,
  ): ModelSettings {
    const provider = value.provider ?? fallbackProvider;
    if (
      typeof provider !== "string" ||
      typeof value.modelId !== "string" ||
      typeof value.effort !== "string"
    )
      throw new SettingsError("Escolha provider, modelo e esforço");
    const model = this.app.models.getModel(provider, value.modelId);
    if (
      !model ||
      !this.catalog(provider).some((entry) => entry.id === value.modelId)
    )
      throw new SettingsError("Modelo não disponível no catálogo do Pi");
    if (
      !getSupportedThinkingLevels(model).includes(
        value.effort as ModelThinkingLevel,
      )
    )
      throw new SettingsError("Esforço não suportado por este modelo");
    return {
      provider,
      modelId: value.modelId,
      effort: value.effort as ModelThinkingLevel,
    };
  }
  saveDefaults(value: Record<string, unknown>) {
    const settings = this.validate(value);
    this.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      this.defaultsKey,
      JSON.stringify(settings),
    );
    this.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      modelDefaultsConfirmedKey(this.app.options.mode ?? "demo"),
      "true",
    );
    return settings;
  }
  hasExplicitDefaults() {
    return !!this.app.store.get(
      "SELECT 1 FROM meta WHERE key=?",
      modelDefaultsConfirmedKey(this.app.options.mode ?? "demo"),
    );
  }
  /**
   * Notice while no default was chosen on purpose: the first catalog model is
   * used meanwhile. Returns nothing once a choice exists or after one warning.
   */
  pendingModelNotice(conversationId: string) {
    try {
      // Demo runs have no operator to configure anything; only live deploys warn.
      if (this.app.options.mode !== "live") return undefined;
      if (this.hasExplicitDefaults()) return undefined;
      if (
        this.app.store.get(
          "SELECT 1 FROM meta WHERE key=?",
          modelNoticeKey(conversationId),
        )
      )
        return undefined;
      const current = this.defaults();
      return `Aviso: nenhum modelo padrão foi escolhido; usando ${current.provider}/${current.modelId} com esforço ${current.effort}. Ajuste com /model e /thinking, ou defina o padrão no terminal do container com npm run setup-model.`;
    } catch {
      /* A missing or removed catalog must not block the reply path. */
      return undefined;
    }
  }
  markModelNoticeShown(conversationId: string) {
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      modelNoticeKey(conversationId),
      "1",
    );
  }
  async conversation(id: string): Promise<ModelSettings> {
    const agent = await (await this.app.conversation(id)).agent(context);
    return {
      provider: agent.model?.provider ?? this.defaults().provider,
      modelId: agent.model?.modelId ?? this.defaults().modelId,
      effort: agent.thinkingLevel,
    };
  }
  async saveConversation(
    id: string,
    value: Record<string, unknown>,
    beforeSave?: (current: ModelSettings) => void,
  ) {
    return this.app.withConversationSettings(id, async (conversation) => {
      const agent = await conversation.agent(context);
      const settings = this.validate(
        value,
        agent.model?.provider ?? this.provider,
      );
      const active = await this.app.harness.inspect(context);
      if (
        active.tasks.some(
          ({ record }) => String(record.conversationId) === id,
        ) ||
        this.app.store.get(
          "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
          id,
        )
      )
        throw new SettingsError(
          "Aguarde a conversa concluir antes de mudar provider, modelo e esforço",
        );
      // Native controls recheck their owner and original selection under the
      // same settings lock, after asynchronous inspections and before configure.
      beforeSave?.({
        provider: agent.model?.provider ?? this.defaults().provider,
        modelId: agent.model?.modelId ?? this.defaults().modelId,
        effort: agent.thinkingLevel,
      });
      await conversation.configure(
        {
          model: { provider: settings.provider, modelId: settings.modelId },
          thinkingLevel: settings.effort,
        },
        context,
      );
      return settings;
    });
  }
}
