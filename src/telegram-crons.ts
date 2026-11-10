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
  title: "Title",
  prompt: "Instruction",
  schedule: "Schedule",
  timezone: "Timezone",
};
const key = (id: string) => `telegram:cron-menu:${id}`;
const invalid = () =>
  new TaskError(
    "Menu expired, out of date, or authorization changed. Use /crons again.",
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
    return { text: "Menu closed. Use /crons to open it again.", markup };
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
    text = `Telegram schedules · ${page + 1}/${pages}\nDestinations stay in their original topics. The menu does not start a run.`;
    if (!tasks.length) text += "\nNo authorized Telegram schedule.";
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
    if (page) nav.push(add("← Previous", { action: "list", page: page - 1 }));
    if (page + 1 < pages)
      nav.push(add("Next →", { action: "list", page: page + 1 }));
    if (nav.length) markup.inline_keyboard.push(nav);
    markup.inline_keyboard.push([add("Create schedule", { action: "new" })]);
    markup.inline_keyboard.push([add("Close", { action: "close" })]);
  } else {
    capture(task);
    text = `${task.title}\n${task.enabled ? "Active" : "Paused"} · ${task.kind}\nSchedule: ${task.schedule}\nTimezone: ${task.timezone}\nNext: ${task.nextRun === null ? "—" : new Date(task.nextRun).toISOString()}\nSaved delivery: ${task.delivery}${task.destinationReason ? ` · blocked: ${task.destinationReason}` : ""}${task.lastError ? `\nLast error: ${task.lastError.slice(0, 300)}` : ""}\nFixed destination: ${task.destinationMessageThreadId == null ? "no topic" : `topic ${task.destinationMessageThreadId}`} · conversation ${task.conversationId}\n\n${task.prompt.slice(0, 1800)}${task.prompt.length > 1800 ? "… (instruction shortened)" : ""}`;
    if (action.action === "delete") {
      text +=
        "\n\nDelete this schedule? History and occurrences already admitted will be kept.";
      markup.inline_keyboard.push([
        add("Confirm delete", { action: "remove" }),
        add("Cancel", { action: "detail" }),
      ]);
    } else if (action.action === "edit") {
      for (const field of Object.keys(fields) as Field[])
        markup.inline_keyboard.push([
          add(fields[field], { action: "field", field }),
        ]);
      markup.inline_keyboard.push([add("Cancel", { action: "detail" })]);
    } else if (action.action === "save" && menu.edit) {
      text = `Confirm change to ${fields[menu.edit.action.field!]}?\n\n${menu.edit.value!}\n\nThis schedule's destination will be kept.`;
      markup.inline_keyboard.push([
        add("Confirm change", { action: "save" }),
        add("Cancel", { action: "detail" }),
      ]);
    } else {
      markup.inline_keyboard.push([
        add(task.enabled ? "Pause" : "Resume", { action: "toggle" }),
      ]);
      markup.inline_keyboard.push([add("Run now", { action: "run" })]);
      markup.inline_keyboard.push([
        add("Edit…", { action: "edit" }),
        add("Delete…", { action: "delete" }),
      ]);
      markup.inline_keyboard.push([
        add("← Schedules", {
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
        "Create a schedule in this topic. Reply directly to this message with 4 lines:\nTitle\nSchedule (5-field cron OR an ISO date with offset)\nIANA timezone (e.g. America/Sao_Paulo)\nFull instruction (may continue on more lines)\n\nYou will review and confirm before it is saved. Use /crons to cancel.",
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
          "Confirmed schedule creation in this topic.",
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
        `Schedule saved: ${task.title}. Fixed destination: this chat/topic. Use /crons to manage it.`,
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
      notice = `Manual run of ${task.title} started. The result follows the saved delivery and the next time does not change.`;
    } catch (error) {
      notice =
        error instanceof Error ? error.message : "Could not start the run.";
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
              ? "Use a 5-field cron, for example: 0 9 * * *."
              : "Use a future ISO date with Z/offset."
            : action.field === "timezone"
              ? "Use an IANA timezone, for example: America/Sao_Paulo or UTC."
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
          `Edit ${fields[action.field]} of ${task.title}.\nReply directly to this message with the new value. ${guidance}\nThe change still needs confirmation. Use /crons to leave.`,
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
          "Provide a title, schedule, timezone, and instruction (up to 12000 characters). Use /crons to start over.",
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
        `Confirm this schedule in this topic?\nTitle: ${title}\nSchedule: ${schedule}\nTimezone: ${timezone}\n\n${prompt}\n\nThe original destination will be kept.`,
        {
          inline_keyboard: [
            [
              {
                text: "Confirm create",
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
                text: "Cancel",
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
        : "Edit not authorized. Use /crons again.",
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
