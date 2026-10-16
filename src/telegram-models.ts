import { randomBytes } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { Runtime } from "./runtime.js";
import { SettingsError, type ModelSettings } from "./settings.js";
import type { TelegramOwner } from "./telegram-chats.js";
import {
  button,
  queueControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "./telegram-controls.js";
import type { TelegramTransport } from "./telegram.js";
import { hash } from "./store.js";

const PAGE_SIZE = 8;
const guidance =
  "A escolha altera apenas esta conversa e persiste após reinício.";
interface Menu {
  conversationId: string;
  authorizationVersion: string;
  current: ModelSettings;
  version: number;
  closed: boolean;
  expiresAt: number;
}
export interface ModelMenuAction {
  id: string;
  version: number;
  action: "providers" | "models" | "select" | "cancel" | "efforts" | "effort";
  effort?: string;
  provider?: string;
  modelId?: string;
  page?: number;
}
type Provider = {
  id: string;
  name: string;
  models: ReturnType<Runtime["settings"]["catalog"]>;
  registered: NonNullable<ReturnType<Runtime["models"]["getProvider"]>>;
  authBinding: string;
};
const authBinding = (app: Runtime, provider: string) =>
  hash(
    app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      provider,
    )?.value ?? "",
  );
async function providers(app: Runtime): Promise<Provider[]> {
  // SDK checkAuth reads configuration (including environment keys) without
  // refreshing OAuth or starting a login. Never include auth data in controls.
  const rows = await Promise.all(
    app.models.getProviders().map(async (provider) => {
      try {
        const binding = authBinding(app, provider.id);
        return (await app.models.checkAuth(provider.id))
          ? {
              id: provider.id,
              name: provider.name,
              models: app.settings.catalog(provider.id),
              registered: provider,
              authBinding: binding,
            }
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return rows.filter((row): row is Provider => !!row);
}
const same = (a: ModelSettings, b: ModelSettings) =>
  a.provider === b.provider && a.modelId === b.modelId && a.effort === b.effort;
function assertCurrent(
  app: Runtime,
  owner: TelegramOwner,
  id: string,
  locked = false,
) {
  if (locked) {
    app.telegramChats.connection(owner);
    if (!app.telegramChats.owns(id, owner) || app.store.conversationDeleted(id))
      throw new SettingsError("Conversa não autorizada. Use /model novamente.");
  } else app.commands.authorize(id, { source: "telegram", ...owner });
  if (app.telegramChats.selection(owner) !== id)
    throw new SettingsError(
      "A conversa selecionada mudou. Use /model novamente.",
    );
  if (
    app.store.get(
      "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
      owner.chat,
      owner.user,
      owner.messageThreadId ?? null,
    )
  )
    throw new SettingsError(
      "Tópico fechado no estado observado. Use /model após reabri-lo.",
    );
}
function render(
  app: Runtime,
  owner: TelegramOwner,
  conversationId: string,
  menu: Menu,
  action: ModelMenuAction,
  available: Provider[],
) {
  const markup: TelegramReplyMarkup = { inline_keyboard: [] };
  const add = (
    text: string,
    next: Omit<ModelMenuAction, "id" | "version">,
  ) => ({
    text,
    callback_data: button(app, {
      kind: "model",
      owner,
      originThreadId: owner.messageThreadId ?? null,
      conversationId,
      modelMenu: { ...next, id: action.id, version: menu.version },
    }),
  });
  if (action.action === "efforts") {
    const current = available
      .find((p) => p.id === menu.current.provider)
      ?.models.find((m) => m.id === menu.current.modelId);
    for (const effort of current?.efforts ?? [])
      markup.inline_keyboard.push([
        add(`${effort === menu.current.effort ? "✓ " : ""}${effort}`, {
          action: "effort",
          provider: menu.current.provider,
          modelId: menu.current.modelId,
          effort,
        }),
      ]);
    markup.inline_keyboard.push([add("Cancelar", { action: "cancel" })]);
    // A single `off` is not a bug: the catalog declares no reasoning for this model.
    const noReasoning =
      !current ||
      current.efforts.filter((effort) => effort !== "off").length === 0;
    return {
      text: `Esforço ativo: ${menu.current.effort}\nModelo: ${menu.current.modelId}\n${
        noReasoning
          ? "Este modelo não declara níveis de raciocínio, então só existe `off`. Para habilitar low/medium/high, declare o catálogo em LLM_MODELS com `reasoning=true` ou a lista de níveis (ex.: deepseek-flash|1000000|384000|off+low+high+max).\n"
          : ""
      }${guidance}`,
      markup,
    };
  }
  const currentProvider =
    app.models.getProvider(menu.current.provider)?.name ??
    menu.current.provider;
  let text = `Configuração de modelo\nAtual: ${menu.current.modelId}\nProvedor: ${currentProvider}\n\n`;
  const provider =
    action.action === "models"
      ? available.find((p) => p.id === action.provider)
      : undefined;
  if (action.action === "models" && !provider)
    throw new SettingsError(
      "Provedor não configurado ou indisponível. Use /model novamente.",
    );
  const rows = provider?.models ?? available;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, action.page ?? 0), pages - 1);
  if (provider) {
    text += `Selecione um modelo de ${provider.name} · ${page + 1}/${pages}`;
    if (!rows.length)
      text += "\nNenhum modelo disponível no catálogo deste provedor.";
    for (const model of provider.models.slice(
      page * PAGE_SIZE,
      (page + 1) * PAGE_SIZE,
    ))
      markup.inline_keyboard.push([
        add(
          `${menu.current.provider === provider.id && menu.current.modelId === model.id ? "✓ " : ""}${model.name}${model.name === model.id ? "" : ` · ${model.id}`}`,
          { action: "select", provider: provider.id, modelId: model.id },
        ),
      ]);
  } else {
    text += "Selecione um provedor";
    if (!rows.length) text += "\nNenhum provedor configurado disponível.";
    for (const row of available.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE))
      markup.inline_keyboard.push([
        add(
          `${menu.current.provider === row.id ? "✓ " : ""}${row.name} (${row.models.length})`,
          { action: "models", provider: row.id },
        ),
      ]);
  }
  const navigation = [];
  const pageAction = {
    action: provider ? ("models" as const) : ("providers" as const),
    provider: provider?.id,
  };
  if (page > 0)
    navigation.push(add("← Anterior", { ...pageAction, page: page - 1 }));
  if (page + 1 < pages)
    navigation.push(add("Próxima →", { ...pageAction, page: page + 1 }));
  if (navigation.length) markup.inline_keyboard.push(navigation);
  if (provider)
    markup.inline_keyboard.push([
      add("← Voltar aos provedores", { action: "providers" }),
    ]);
  markup.inline_keyboard.push([add("Cancelar", { action: "cancel" })]);
  return { text: `${text}\n\n${guidance}`, markup };
}
export async function openModelMenu(
  app: Runtime,
  owner: TelegramOwner,
  id: string,
  updateId: number,
  thinking = false,
) {
  const authorizationVersion = app.store.authorizationVersion(owner, id);
  const current = await app.settings.conversation(id);
  const available = await providers(app);
  assertCurrent(app, owner, id);
  if (authorizationVersion !== app.store.authorizationVersion(owner, id))
    throw new SettingsError("A autorização mudou. Use /model novamente.");
  const prefix = `telegram:model:${updateId}`;
  // Recovery of an update with an already queued menu must not create new tokens.
  if (app.store.get("SELECT 1 FROM deliveries WHERE id=?", `${prefix}:0`))
    return;
  app.store.savepoint("telegram_model_menu", () => {
    const menu: Menu = {
      conversationId: id,
      authorizationVersion,
      current,
      version: 0,
      closed: false,
      expiresAt: Date.now() + 900000,
    };
    const menuId = randomBytes(16).toString("hex");
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      `telegram:model-menu:${menuId}`,
      JSON.stringify(menu),
    );
    const view = render(
      app,
      owner,
      id,
      menu,
      { id: menuId, version: 0, action: thinking ? "efforts" : "providers" },
      available,
    );
    queueControl(app, prefix, owner, id, view.text, view.markup);
  });
}
export async function handleModelMenu(
  app: Runtime,
  data: TelegramButton,
  messageId: number,
  transport: TelegramTransport,
  validateConnection: () => void,
) {
  const action = data.modelMenu;
  if (!action)
    throw new SettingsError("Controle inválido. Use /model novamente.");
  const key = `telegram:model-menu:${action.id}`;
  const read = () => {
    const saved = app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    const menu = saved ? (JSON.parse(saved.value) as Menu) : undefined;
    if (
      !menu ||
      menu.closed ||
      menu.expiresAt <= Date.now() ||
      menu.version !== action.version ||
      menu.conversationId !== data.conversationId ||
      menu.authorizationVersion !==
        app.store.authorizationVersion(data.owner, data.conversationId)
    )
      throw new SettingsError(
        "Menu expirado ou desatualizado. Use /model novamente.",
      );
    return menu;
  };
  const validate = () => {
    validateConnection();
    assertCurrent(app, data.owner, data.conversationId);
  };
  const menu = read();
  let text: string;
  let markup: TelegramReplyMarkup = { inline_keyboard: [] };
  const available = action.action === "cancel" ? [] : await providers(app);
  validate();
  read(); // Another callback can have navigated while auth was inspected.
  if (
    action.action !== "cancel" &&
    !same(menu.current, await app.settings.conversation(data.conversationId))
  )
    throw new SettingsError(
      "O modelo desta conversa mudou. Use /model novamente.",
    );
  validate();
  read();
  if (action.action === "select" || action.action === "effort") {
    const provider = available.find((p) => p.id === action.provider);
    const model = provider?.models.find((m) => m.id === action.modelId);
    if (!provider || !model)
      throw new SettingsError(
        "Modelo não disponível no catálogo configurado. Use /model novamente.",
      );
    const native = app.models.getModel(provider.id, model.id)!;
    // Close before awaiting configure: siblings and duplicate updates never
    // replay a potentially applied setting after an interruption.
    menu.closed = true;
    app.store.run(
      "UPDATE meta SET value=? WHERE key=?",
      JSON.stringify(menu),
      key,
    );
    const saved = await app.settings.saveConversation(
      data.conversationId,
      {
        provider: provider.id,
        modelId: model.id,
        effort:
          action.action === "effort"
            ? action.effort
            : clampThinkingLevel(native, menu.current.effort),
      },
      (current) => {
        // Runtime holds the settings lock here; authorize without its busy guard.
        validateConnection();
        assertCurrent(app, data.owner, data.conversationId, true);
        if (
          menu.authorizationVersion !==
            app.store.authorizationVersion(data.owner, data.conversationId) ||
          menu.expiresAt <= Date.now()
        )
          throw new SettingsError(
            "A autorização do menu mudou ou expirou. Use /model novamente.",
          );
        if (!same(menu.current, current))
          throw new SettingsError(
            "A conversa ou o modelo mudou. Use /model novamente.",
          );
        if (
          app.models.getProvider(provider.id) !== provider.registered ||
          authBinding(app, provider.id) !== provider.authBinding
        )
          throw new SettingsError(
            "O provedor configurado mudou. Use /model novamente.",
          );
        app.settings.validate({
          provider: provider.id,
          modelId: model.id,
          effort:
            action.action === "effort"
              ? action.effort
              : clampThinkingLevel(native, menu.current.effort),
        });
      },
    );
    text = `Modelo: ${saved.modelId}. Provedor: ${provider.name}. Esforço: ${saved.effort}.\n\n${guidance}`;
    // The user picked a model here on purpose: stop warning about an implicit default.
    app.settings.markModelNoticeShown(data.conversationId);
  } else if (action.action === "cancel") {
    menu.closed = true;
    text = `Seleção cancelada. O modelo não foi alterado por este menu.\n\n${guidance}`;
  } else {
    menu.version++;
    const view = render(
      app,
      data.owner,
      data.conversationId,
      menu,
      action,
      available,
    );
    text = view.text;
    markup = view.markup;
  }
  app.store.run(
    "UPDATE meta SET value=? WHERE key=?",
    JSON.stringify(menu),
    key,
  );
  validate();
  try {
    if (!transport.editMessage) throw new Error("Edit unavailable");
    await transport.editMessage(data.owner.chat, messageId, text, markup);
  } catch {
    // Old controls are invalidated by the durable menu version/closed state.
    validate();
    queueControl(
      app,
      `telegram:model-result:${action.id}:${menu.version}:${action.action}`,
      data.owner,
      data.conversationId,
      text,
      markup,
    );
  }
}
