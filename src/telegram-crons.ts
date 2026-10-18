import { telegramConversationRoute } from "./task-telegram.js";
import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime.js";
import { TaskError, type Task } from "./tasks.js";
import type { TelegramOwner } from "./telegram-chats.js";
import {
  button,
  credentialBinding,
  queueControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "./telegram-controls.js";
import type { TelegramTransport, TelegramUpdate } from "./telegram.js";
import { childIds, hash } from "./store.js";

type Field = "title" | "prompt" | "schedule" | "timezone";
export interface CronMenuAction {
  id: string;
  version: number;
  action:
    | "new"
    | "create"
    | "list"
    | "detail"
    | "toggle"
    | "run"
    | "edit"
    | "field"
    | "save"
    | "delete"
    | "remove"
    | "close";
  page?: number;
  taskId?: string;
  taskHash?: string;
  authorizationVersion?: string;
  field?: Field;
}
interface Target {
  taskId: string;
  taskHash: string;
  authorizationVersion: string;
}
interface Menu {
  conversationId: string;
  menuId: string;
  owner: TelegramOwner;
  selection: string | null;
  authorizationVersion: string;
  credentialBinding: string;
  version: number;
  expiresAt: number;
  closed: boolean;
  targets: Target[];
  draft?: {
    deliveryId: string;
    previewPrefix?: string;
    value?: {
      title: string;
      prompt: string;
      kind: "once" | "cron";
      schedule: string;
      timezone: string;
    };
  };
  edit?: {
    action: CronMenuAction;
    deliveryId: string;
    value?: string;
    previewPrefix?: string;
  };
}
const fields: Record<Field, string> = {
  title: "Título",
  prompt: "Instrução",
  schedule: "Agenda",
  timezone: "Fuso",
};
const key = (id: string) => `telegram:cron-menu:${id}`;
const invalid = () =>
  new TaskError(
    "Menu expirado, desatualizado ou autorização mudou. Use /crons novamente.",
  );
function save(app: Runtime, id: string, menu: Menu) {
  app.store.run(
    "INSERT OR REPLACE INTO meta VALUES (?,?)",
    key(id),
    JSON.stringify(menu),
  );
}
function target(app: Runtime, owner: TelegramOwner, taskId: string) {
  const task = app.tasks.get(taskId);
  if (!task || !app.isTelegramConversation(task.conversationId))
    throw invalid();
  app.commands.authorize(task.conversationId, {
    source: "telegram",
    chat: owner.chat,
    user: owner.user,
    messageThreadId: app.store.telegramThread(task.conversationId),
  });
  return task;
}
function read(
  app: Runtime,
  id: string,
  owner: TelegramOwner,
  version?: number,
  allowClosed = false,
) {
  const row = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    key(id),
  );
  const menu: Menu | undefined = row && JSON.parse(row.value);
  if (
    !menu ||
    (menu.closed && !allowClosed) ||
    menu.expiresAt <= Date.now() ||
    (version !== undefined && menu.version !== version) ||
    JSON.stringify(menu.owner) !== JSON.stringify(owner) ||
    menu.credentialBinding !== credentialBinding(app) ||
    menu.authorizationVersion !==
      app.store.authorizationVersion(owner, menu.conversationId) ||
    menu.selection !== (app.telegramChats.selection(owner) ?? null)
  )
    throw invalid();
  app.telegramChats.connection(owner);
  app.telegramChats.assertCreationAuthority(menu.conversationId, owner);
  return menu;
}
function queue(
  app: Runtime,
  prefix: string,
  menu: Pick<Menu, "conversationId" | "owner"> &
    Partial<Pick<Menu, "menuId" | "version" | "targets">>,
  text: string,
  markup?: TelegramReplyMarkup,
  forceReply = false,
) {
  queueControl(app, prefix, menu.owner, menu.conversationId, text, markup);
  const parts = app.store.all<{ id: string }>(
    "SELECT id FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
    ...childIds(prefix),
  );
  const configured = app.telegramChats.configuredOwner(menu.owner);
  if (configured)
    for (const part of parts)
      app.store.run(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        `telegram:control-route:${part.id}`,
        JSON.stringify({
          ...menu.owner,
          botId: configured.botId,
          credentialBinding: configured.credentialBinding,
        }),
      );
  for (const part of parts) {
    if (menu.menuId)
      app.store.run(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        `telegram:cron-delivery:${part.id}`,
        JSON.stringify({
          menuId: menu.menuId,
          version: menu.version,
          targets: menu.targets ?? [],
        }),
      );
    for (const item of menu.targets ?? []) {
      const task = app.tasks.get(item.taskId);
      if (task)
        app.store.run(
          "INSERT OR IGNORE INTO telegram_control_parts VALUES (?,?)",
          part.id,
          task.conversationId,
        );
    }
  }
  const last = parts.at(-1)?.id;
  if (forceReply && last)
    app.store.run(
      "INSERT OR REPLACE INTO meta VALUES (?,?)",
      `telegram:force-reply:${last}`,
      "true",
    );
  return last!;
}
function assertFullPreview(
  app: Runtime,
  prefix: string | undefined,
  messageId: number,
) {
  if (!prefix) throw invalid();
  const parts = app.store.all<{ state: string; result: string | null }>(
    "SELECT state,result FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
    ...childIds(prefix),
  );
  const last = parts.at(-1)?.result;
  const receipt = last ? JSON.parse(last) : undefined;
  if (
    !parts.length ||
    parts.some((part) => part.state !== "sent") ||
    (receipt?.message_id ?? receipt?.result?.message_id) !== messageId
  )
    throw invalid();
}
function render(
  app: Runtime,
  id: string,
  menu: Menu,
  action: CronMenuAction,
  task?: Task,
) {
  const markup: TelegramReplyMarkup = { inline_keyboard: [] };
  const add = (
    text: string,
    next: Partial<CronMenuAction> & Pick<CronMenuAction, "action">,
    rowTask = task,
  ) => ({
    text,
    callback_data: button(app, {
      kind: "cron",
      owner: menu.owner,
      originThreadId: menu.owner.messageThreadId ?? null,
      conversationId: menu.conversationId,
      cronMenu: {
        id,
        version: menu.version,
        ...(rowTask
          ? {
              taskId: rowTask.id,
              taskHash: hash(JSON.stringify(rowTask)),
              authorizationVersion: app.store.authorizationVersion(
                menu.owner,
                rowTask.conversationId,
              ),
            }
          : {}),
        ...next,
      },
    }),
  });
  menu.targets = [];
  const capture = (row: Task) =>
    menu.targets.push({
      taskId: row.id,
      taskHash: hash(JSON.stringify(row)),
      authorizationVersion: app.store.authorizationVersion(
        menu.owner,
        row.conversationId,
      ),
    });
  let text: string;
  if (action.action === "close")
    return { text: "Menu encerrado. Use /crons para abrir novamente.", markup };
  if (!task) {
    const tasks = app.tasks.list().filter((row) => {
      try {
        target(app, menu.owner, row.id);
        return true;
      } catch {
        return false;
      }
    });
    const pages = Math.max(1, Math.ceil(tasks.length / 8));
    const page = Math.min(Math.max(0, action.page ?? 0), pages - 1);
    text = `Agendamentos Telegram · ${page + 1}/${pages}\nOs destinos permanecem nos tópicos de origem. Nenhuma execução é iniciada pelo menu.`;
    if (!tasks.length) text += "\nNenhum agendamento Telegram autorizado.";
    for (const row of tasks.slice(page * 8, (page + 1) * 8)) {
      capture(row);
      markup.inline_keyboard.push([
        add(
          `${row.enabled ? "▶" : "⏸"} ${row.title}`,
          { action: "detail" },
          row,
        ),
      ]);
    }
    const nav = [];
    if (page) nav.push(add("← Anterior", { action: "list", page: page - 1 }));
    if (page + 1 < pages)
      nav.push(add("Próxima →", { action: "list", page: page + 1 }));
    if (nav.length) markup.inline_keyboard.push(nav);
    markup.inline_keyboard.push([add("Criar agendamento", { action: "new" })]);
    markup.inline_keyboard.push([add("Fechar", { action: "close" })]);
  } else {
    capture(task);
    text = `${task.title}\n${task.enabled ? "Ativo" : "Pausado"} · ${task.kind}\nAgenda: ${task.schedule}\nFuso: ${task.timezone}\nPróxima: ${task.nextRun === null ? "—" : new Date(task.nextRun).toISOString()}\nEntrega salva: ${task.delivery}${task.destinationReason ? ` · bloqueada: ${task.destinationReason}` : ""}${task.lastError ? `\nÚltimo erro: ${task.lastError.slice(0, 300)}` : ""}\nDestino fixo: ${task.destinationMessageThreadId == null ? "sem tópico" : `tópico ${task.destinationMessageThreadId}`} · conversa ${task.conversationId}\n\n${task.prompt.slice(0, 1800)}${task.prompt.length > 1800 ? "… (instrução abreviada)" : ""}`;
    if (action.action === "delete") {
      text +=
        "\n\nConfirmar exclusão deste agendamento? O histórico e ocorrências já admitidas serão preservados.";
      markup.inline_keyboard.push([
        add("Confirmar exclusão", { action: "remove" }),
        add("Cancelar", { action: "detail" }),
      ]);
    } else if (action.action === "edit") {
      for (const field of Object.keys(fields) as Field[])
        markup.inline_keyboard.push([
          add(fields[field], { action: "field", field }),
        ]);
      markup.inline_keyboard.push([add("Cancelar", { action: "detail" })]);
    } else if (action.action === "save" && menu.edit) {
      text = `Confirmar alteração de ${fields[menu.edit.action.field!]}?\n\n${menu.edit.value!}\n\nO destino deste agendamento será preservado.`;
      markup.inline_keyboard.push([
        add("Confirmar alteração", { action: "save" }),
        add("Cancelar", { action: "detail" }),
      ]);
    } else {
      markup.inline_keyboard.push([
        add(task.enabled ? "Pausar" : "Retomar", { action: "toggle" }),
      ]);
      markup.inline_keyboard.push([add("Rodar agora", { action: "run" })]);
      markup.inline_keyboard.push([
        add("Editar…", { action: "edit" }),
        add("Excluir…", { action: "delete" }),
      ]);
      markup.inline_keyboard.push([
        add("← Agendamentos", {
          action: "list",
          taskId: undefined,
          taskHash: undefined,
          authorizationVersion: undefined,
        }),
      ]);
    }
  }
  return { text, markup };
}
export function openCronMenu(
  app: Runtime,
  owner: TelegramOwner,
  conversationId: string,
  updateId: number,
) {
  const prefix = `telegram:crons:${updateId}`;
  if (app.store.get("SELECT 1 FROM deliveries WHERE id=?", `${prefix}:0`))
    return;
  app.store.savepoint("telegram_cron_menu", () => {
    app.store.run(
      "UPDATE meta SET value=json_set(value,'$.closed',json('true')) WHERE key GLOB 'telegram:cron-menu:*' AND json_extract(value,'$.owner')=?",
      JSON.stringify(owner),
    );
    const id = randomBytes(16).toString("hex");
    const menu: Menu = {
      conversationId,
      menuId: id,
      targets: [],
      owner,
      selection: app.telegramChats.selection(owner) ?? null,
      authorizationVersion: app.store.authorizationVersion(
        owner,
        conversationId,
      ),
      credentialBinding: credentialBinding(app),
      version: 0,
      closed: false,
      expiresAt: Date.now() + 900000,
    };
    save(app, id, menu);
    const view = render(app, id, menu, { id, version: 0, action: "list" });
    queue(app, prefix, menu, view.text, view.markup);
  });
}
export async function handleCronMenu(
  app: Runtime,
  data: TelegramButton,
  messageId: number,
  transport: TelegramTransport,
) {
  const action = data.cronMenu;
  if (!action) throw invalid();
  if (action.action === "new" || action.action === "create") {
    const menu = read(app, action.id, data.owner, action.version);
    app.commands.authorize(menu.conversationId, {
      source: "telegram",
      ...menu.owner,
    });
    menu.version++;
    if (action.action === "new") {
      const deliveryId = queue(
        app,
        `telegram:cron-new:${action.id}:${menu.version}`,
        menu,
        "Criar agendamento neste tópico. Responda diretamente a esta mensagem com 4 linhas:\nTítulo\nAgenda (cron de 5 campos OU data ISO com offset)\nFuso IANA (ex.: America/Sao_Paulo)\nInstrução completa (pode continuar em mais linhas)\n\nVocê revisará e confirmará antes de salvar. Use /crons para cancelar.",
        undefined,
        true,
      );
      menu.draft = { deliveryId };
      app.store.run(
        "INSERT INTO meta VALUES (?,?)",
        `telegram:cron-prompt:${deliveryId}`,
        JSON.stringify({
          conversationId: menu.conversationId,
          menuId: action.id,
          deliveryId,
          owner: menu.owner,
        }),
      );
      save(app, action.id, menu);
    } else {
      if (!menu.draft?.value) throw invalid();
      assertFullPreview(app, menu.draft.previewPrefix, messageId);
      const route = telegramConversationRoute(app.store, menu.conversationId);
      if (
        !route ||
        route.chat !== menu.owner.chat ||
        route.user !== menu.owner.user ||
        route.messageThreadId !== (menu.owner.messageThreadId ?? null)
      )
        throw invalid();
      menu.closed = true; // Claim before any await; duplicate confirmation cannot create twice.
      save(app, action.id, menu);
      const requestId = `telegram:cron-create:${action.id}`;
      app.store.savepoint("cron_create_origin", () => {
        app.store.run(
          "INSERT OR IGNORE INTO requests(conversationId,requestId,text,source,chat,status) VALUES (?,?,?,'telegram',?,'done')",
          menu.conversationId,
          requestId,
          "Criar agendamento confirmado neste tópico.",
          menu.owner.chat,
        );
        app.store.run(
          "INSERT OR IGNORE INTO request_telegram_routes VALUES (?,?,?,?,?,?,'authorized',NULL)",
          menu.conversationId,
          requestId,
          route.chat,
          route.user,
          route.botId,
          route.messageThreadId,
        );
      });
      const task = await app.tasks.create(
        {
          ...menu.draft.value,
          conversationId: menu.conversationId,
          delivery: "web_telegram",
        },
        requestId,
        { source: "telegram", conversationId: menu.conversationId, requestId },
      );
      queue(
        app,
        `telegram:cron-created:${action.id}`,
        menu,
        `Agendamento salvo: ${task.title}. Destino fixo: este chat/tópico. Use /crons para gerenciar.`,
      );
    }
    return;
  }
  let view: { text: string; markup: TelegramReplyMarkup } | undefined;
  let menu!: Menu;
  let notice: string | undefined;
  if (action.action === "run") {
    // Running a schedule is asynchronous, so it happens before the synchronous savepoint
    // block; the freshness checks below still guard the menu.
    const menu = read(app, action.id, data.owner, action.version);
    app.commands.authorize(menu.conversationId, {
      source: "telegram",
      ...menu.owner,
    });
    const taskId = action.taskId;
    if (!taskId) throw invalid();
    const task = target(app, data.owner, taskId);
    if (
      hash(JSON.stringify(task)) !== action.taskHash ||
      action.authorizationVersion !==
        app.store.authorizationVersion(data.owner, task.conversationId)
    )
      throw invalid();
    try {
      await app.tasks.runNow(task.id);
      notice = `Execução manual de ${task.title} iniciada. O resultado segue a entrega configurada e o próximo horário não muda.`;
    } catch (error) {
      notice =
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar a execução.";
    }
    menu.version++;
    save(app, action.id, menu);
    view = render(app, action.id, menu, { ...action, action: "detail" }, task);
  }
  if (!view)
    app.store.savepoint("telegram_cron_action", () => {
      menu = read(app, action.id, data.owner, action.version);
      let task = action.taskId
        ? target(app, data.owner, action.taskId)
        : undefined;
      if (
        task &&
        (hash(JSON.stringify(task)) !== action.taskHash ||
          action.authorizationVersion !==
            app.store.authorizationVersion(data.owner, task.conversationId))
      )
        throw invalid();
      menu.version++;
      if (action.action === "field") {
        if (!task || !action.field || !Object.hasOwn(fields, action.field))
          throw invalid();
        const guidance =
          action.field === "schedule"
            ? task.kind === "cron"
              ? "Use cron de 5 campos, por exemplo: 0 9 * * *."
              : "Use data ISO futura com Z/offset."
            : action.field === "timezone"
              ? "Use um fuso IANA, por exemplo: America/Sao_Paulo ou UTC."
              : "";
        menu.targets = [
          {
            taskId: task.id,
            taskHash: hash(JSON.stringify(task)),
            authorizationVersion: app.store.authorizationVersion(
              data.owner,
              task.conversationId,
            ),
          },
        ];
        const deliveryId = queue(
          app,
          `telegram:cron-edit:${action.id}:${menu.version}`,
          menu,
          `Editar ${fields[action.field]} de ${task.title}.\nResponda diretamente a esta mensagem com o novo valor. ${guidance}\nA alteração ainda exigirá confirmação. Use /crons para sair.`,
          undefined,
          true,
        );
        menu.edit = {
          action: { ...action, version: menu.version },
          deliveryId,
        };
        app.store.run(
          "INSERT INTO meta VALUES (?,?)",
          `telegram:cron-prompt:${deliveryId}`,
          JSON.stringify({
            conversationId: menu.conversationId,
            menuId: action.id,
            deliveryId,
            owner: menu.owner,
          }),
        );
      } else {
        if (action.action === "save") {
          if (!task || !menu.edit?.value || menu.edit.action.taskId !== task.id)
            throw invalid();
          assertFullPreview(app, menu.edit.previewPrefix, messageId);
          task = app.tasks.edit(task.id, {
            [menu.edit.action.field!]: menu.edit.value,
          });
        } else if (action.action === "toggle") {
          if (!task) throw invalid();
          task = app.tasks.setEnabled(task.id, !task.enabled);
        } else if (action.action === "remove") {
          if (!task) throw invalid();
          app.tasks.remove(task.id);
          task = undefined;
        }
        menu.edit = undefined;
        menu.closed = action.action === "close";
        view = render(
          app,
          action.id,
          menu,
          {
            ...action,
            action: ["save", "toggle"].includes(action.action)
              ? "detail"
              : action.action,
          },
          task,
        );
      }
      save(app, action.id, menu);
    });
  if (!view) return;
  if (notice) view = { ...view, text: `${notice}\n\n${view.text}` };
  try {
    if (!transport.editMessage) throw new Error("Edit unavailable");
    await transport.editMessage(
      data.owner.chat,
      messageId,
      view.text,
      view.markup,
    );
  } catch {
    // The state/version is committed before network I/O; never repeat mutations.
    assertCronScope(app, menu, menu.targets);
    if (
      menu.credentialBinding !== credentialBinding(app) ||
      menu.authorizationVersion !==
        app.store.authorizationVersion(data.owner, menu.conversationId)
    )
      throw invalid();
    queue(
      app,
      `telegram:cron-result:${action.id}:${menu.version}`,
      menu,
      view.text,
      view.markup,
    );
  }
}
/** Only replies to a durable, owned edit prompt are consumed; ordinary messages stay ordinary. */
export function acceptCronReply(
  app: Runtime,
  owner: TelegramOwner,
  message: NonNullable<TelegramUpdate["message"]>,
  updateId: number,
) {
  const receipt = cronReplyReceipt(app, owner, message);
  if (!receipt) return false;
  const reply = message.reply_to_message!;
  const id = receipt.menuId;
  try {
    const configured = app.telegramChats.configuredOwner(owner);
    if (!configured || reply.from?.id !== configured.botId) throw invalid();
    const menu = read(app, id, owner);
    if (menu.draft) {
      if (
        menu.draft.deliveryId !== receipt.deliveryId ||
        menu.draft.value ||
        !message.text ||
        JSON.stringify(menu.owner) !== JSON.stringify(owner)
      )
        throw invalid();
      const [title, schedule, timezone, ...instructions] =
        message.text.split(/\r?\n/);
      const prompt = instructions.join("\n").trim();
      if (
        !title?.trim() ||
        !schedule?.trim() ||
        !timezone?.trim() ||
        !prompt ||
        message.text.length > 12000
      )
        throw new TaskError(
          "Informe título, agenda, fuso e instrução (até 12000 caracteres). Use /crons para recomeçar.",
        );
      menu.draft.value = {
        title: title.trim(),
        schedule: schedule.trim(),
        timezone: timezone.trim(),
        prompt,
        kind: /^\d{4}-\d{2}-\d{2}T/.test(schedule) ? "once" : "cron",
      };
      menu.version++;
      menu.draft.previewPrefix = `telegram:cron-new-preview:${updateId}`;
      save(app, id, menu);
      queue(
        app,
        menu.draft.previewPrefix,
        menu,
        `Confirmar agendamento neste tópico?\nTítulo: ${title}\nAgenda: ${schedule}\nFuso: ${timezone}\n\n${prompt}\n\nO destino de origem será preservado.`,
        {
          inline_keyboard: [
            [
              {
                text: "Confirmar criação",
                callback_data: button(app, {
                  kind: "cron",
                  owner,
                  originThreadId: owner.messageThreadId ?? null,
                  conversationId: menu.conversationId,
                  cronMenu: { id, version: menu.version, action: "create" },
                }),
              },
            ],
            [
              {
                text: "Cancelar",
                callback_data: button(app, {
                  kind: "cron",
                  owner,
                  originThreadId: owner.messageThreadId ?? null,
                  conversationId: menu.conversationId,
                  cronMenu: { id, version: menu.version, action: "close" },
                }),
              },
            ],
          ],
        },
      );
      return true;
    }
    if (
      !menu.edit ||
      menu.edit.deliveryId !== receipt.deliveryId ||
      menu.version !== menu.edit.action.version
    )
      throw invalid();
    const action = menu.edit!.action;
    const task = target(app, owner, action.taskId!);
    if (
      hash(JSON.stringify(task)) !== action.taskHash ||
      action.authorizationVersion !==
        app.store.authorizationVersion(owner, task.conversationId) ||
      menu.edit!.value !== undefined ||
      !message.text ||
      message.text.length > 12000
    )
      throw invalid();
    menu.version++;
    menu.edit!.value = message.text;
    menu.edit!.previewPrefix = `telegram:cron-preview:${updateId}`;
    const view = render(app, id, menu, { ...action, action: "save" }, task);
    save(app, id, menu);
    queue(app, menu.edit!.previewPrefix, menu, view.text, view.markup);
  } catch (error) {
    app.telegramChats.connection(owner);
    queue(
      app,
      `telegram:cron-reply-error:${updateId}`,
      { conversationId: receipt.conversationId, owner },
      error instanceof TaskError
        ? error.message
        : "Edição não autorizada. Use /crons novamente.",
    );
  }
  return true;
}

export function cronReplyReceipt(
  app: Runtime,
  owner: TelegramOwner,
  message: NonNullable<TelegramUpdate["message"]>,
) {
  const reply = message.reply_to_message;
  if (!reply || !Number.isSafeInteger(reply.message_id)) return;
  const row = app.store.get<{ value: string }>(
    "SELECT m.value FROM meta m JOIN deliveries d ON m.key='telegram:cron-prompt:'||d.id WHERE d.state='sent' AND d.chat=? AND json_valid(d.result) AND COALESCE(json_extract(d.result,'$.message_id'),json_extract(d.result,'$.result.message_id'))=? LIMIT 1",
    owner.chat,
    reply.message_id,
  );
  return row
    ? (JSON.parse(row.value) as {
        menuId: string;
        deliveryId: string;
        owner: TelegramOwner;
        conversationId: string;
      })
    : undefined;
}

function assertCronScope(app: Runtime, menu: Menu, targets: Target[]) {
  read(app, menu.menuId, menu.owner, menu.version, true);
  for (const item of targets) {
    const task = target(app, menu.owner, item.taskId);
    if (
      hash(JSON.stringify(task)) !== item.taskHash ||
      item.authorizationVersion !==
        app.store.authorizationVersion(menu.owner, task.conversationId)
    )
      throw invalid();
  }
}
export function assertCronDelivery(app: Runtime, deliveryId: string) {
  const row = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    `telegram:cron-delivery:${deliveryId}`,
  );
  if (!row) return;
  const receipt = JSON.parse(row.value) as {
    menuId: string;
    version: number;
    targets: Target[];
  };
  const saved = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    key(receipt.menuId),
  );
  if (!saved) throw invalid();
  const menu = JSON.parse(saved.value) as Menu;
  if (menu.version !== receipt.version) throw invalid();
  assertCronScope(app, menu, receipt.targets);
}
