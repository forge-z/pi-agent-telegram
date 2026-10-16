import { randomBytes } from "node:crypto";
import type { Runtime } from "./runtime.js";
import type { TelegramOwner } from "./telegram-chats.js";
import type { CronMenuAction } from "./telegram-crons.js";
import type { ModelMenuAction } from "./telegram-models.js";
import { childIds, hash, type Store } from "./store.js";
import { telegramIdentity } from "./telegram-identity.js";

export interface TelegramReplyMarkup {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}
export interface TelegramButton {
  kind: "model" | "mcp" | "mcp-check" | "cron";
  owner: TelegramOwner;
  originThreadId: number | null;
  conversationId: string;
  callId?: string;
  callHash?: string;
  verification?: "review" | "done" | "not-executed";
  interactionId?: string;
  interactionHash?: string;
  reviewVersion?: number;
  reviewHash?: string;
  authorizationVersion?: string;
  decision?: "accept" | "decline";
  modelMenu?: ModelMenuAction;
  cronMenu?: CronMenuAction;
  credentialBinding: string;
  expiresAt: number;
  used?: boolean;
}
export function button(
  app: Runtime,
  data: Omit<TelegramButton, "credentialBinding" | "expiresAt">,
) {
  const key = `pi:${randomBytes(16).toString("hex")}`;
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    `telegram:button:${key}`,
    JSON.stringify({
      ...data,
      credentialBinding: credentialBinding(app),
      expiresAt: Date.now() + 86400000,
    }),
  );
  return key;
}
export function credentialBinding(app: Runtime) {
  return hash(
    app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    )?.value ?? "",
  );
}
export function topicRouteKey(owner: TelegramOwner) {
  return `topic:${JSON.stringify([owner.chat, owner.user, owner.messageThreadId ?? null])}`;
}
export function queueControl(
  app: Runtime,
  prefix: string,
  owner: TelegramOwner,
  conversationId: string,
  text: string,
  markup?: TelegramReplyMarkup,
) {
  app.store.savepoint("telegram_native_control", () => {
    app.store.queueTelegram(
      prefix,
      owner.chat,
      text,
      3500,
      conversationId,
      owner.messageThreadId,
    );
    // Attach controls only to the last message if formatting splits the text.
    const parts = app.store.all<{ id: string }>(
      "SELECT id FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      ...childIds(prefix),
    );
    if (app.options.telegramOnly) {
      const identity = telegramIdentity(app.store, owner);
      if (identity) {
        const route = JSON.stringify({
          ...owner,
          botId: identity.botId,
          credentialBinding: identity.credentialBinding,
        });
        for (const part of parts) {
          app.store.run(
            "INSERT OR IGNORE INTO meta VALUES (?,?)",
            `telegram:control-route:${part.id}`,
            route,
          );
        }
      }
    }
    const last = parts.at(-1);
    if (last && markup) {
      app.store.run(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        `telegram:markup:${last.id}`,
        JSON.stringify(markup),
      );
      for (const control of markup.inline_keyboard.flat()) {
        if (!control.callback_data) continue;
        const saved = app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `telegram:button:${control.callback_data}`,
        );
        const route = saved
          ? (JSON.parse(saved.value) as TelegramButton)
          : undefined;
        const target = route?.conversationId;
        for (const part of parts) {
          if (target)
            app.store.run(
              "INSERT OR IGNORE INTO telegram_control_parts VALUES (?,?)",
              part.id,
              target,
            );
          if (route)
            app.store.run(
              "INSERT OR IGNORE INTO telegram_control_parts VALUES (?,?)",
              part.id,
              topicRouteKey(route.owner),
            );
        }
      }
    }
  });
}

/** Bot API has no topic enumeration. Names and closed state are observations only. */
export function observeTopic(
  app: Runtime,
  owner: TelegramOwner,
  event: {
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
    forum_topic_closed?: object;
    forum_topic_reopened?: object;
  },
  updateId: number,
  botId: string,
  messageDate: number,
) {
  if (owner.messageThreadId === undefined) return;
  const name =
    event.forum_topic_created?.name ?? event.forum_topic_edited?.name;
  const safeName =
    typeof name === "string" &&
    Array.from(name).length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(name)
      ? name
      : undefined;
  const closed = event.forum_topic_closed
    ? 1
    : event.forum_topic_reopened || event.forum_topic_created
      ? 0
      : null;
  const date =
    Number.isSafeInteger(messageDate) && messageDate >= 0 ? messageDate : 0;
  const newer = (field: "name" | "state") =>
    `(excluded.${field}BotId IS NOT telegram_known_topics.${field}BotId OR excluded.${field}Date>telegram_known_topics.${field}Date OR (excluded.${field}Date=telegram_known_topics.${field}Date AND excluded.${field}UpdateId>telegram_known_topics.${field}UpdateId))`;
  // A delayed creation event cannot undo a name already observed/confirmed for this bot.
  const nameChanged = `excluded.name IS NOT NULL AND ${newer("name")}${event.forum_topic_created ? " AND telegram_known_topics.nameBotId IS NOT excluded.nameBotId" : ""}`;
  const stateChanged = `excluded.closed IS NOT NULL AND ${newer("state")}`;
  // Name edits and ordinary messages do not imply a state transition (or vice versa).
  app.store.run(
    `INSERT INTO telegram_known_topics(chat,user,messageThreadId,name,closed,nameUpdateId,nameBotId,nameDate,stateUpdateId,stateBotId,stateDate) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,user,messageThreadId) DO UPDATE SET
      name=CASE WHEN ${nameChanged} THEN excluded.name ELSE telegram_known_topics.name END,
      nameUpdateId=CASE WHEN ${nameChanged} THEN excluded.nameUpdateId ELSE telegram_known_topics.nameUpdateId END,
      nameBotId=CASE WHEN ${nameChanged} THEN excluded.nameBotId ELSE telegram_known_topics.nameBotId END,
      nameDate=CASE WHEN ${nameChanged} THEN excluded.nameDate ELSE telegram_known_topics.nameDate END,
      closed=CASE WHEN ${stateChanged} THEN excluded.closed ELSE telegram_known_topics.closed END,
      stateUpdateId=CASE WHEN ${stateChanged} THEN excluded.stateUpdateId ELSE telegram_known_topics.stateUpdateId END,
      stateBotId=CASE WHEN ${stateChanged} THEN excluded.stateBotId ELSE telegram_known_topics.stateBotId END,
      stateDate=CASE WHEN ${stateChanged} THEN excluded.stateDate ELSE telegram_known_topics.stateDate END`,
    owner.chat,
    owner.user,
    owner.messageThreadId,
    safeName ?? null,
    closed,
    safeName === undefined ? -1 : updateId,
    safeName === undefined ? null : botId,
    safeName === undefined ? 0 : date,
    closed === null ? -1 : updateId,
    closed === null ? null : botId,
    closed === null ? 0 : date,
  );
  syncTopicTitle(app, owner);
}

/** Persist the observed canonical name without making another external edit. */
export function syncTopicTitle(app: Runtime, owner: TelegramOwner) {
  const name = app.store.get<{ name: string | null }>(
    "SELECT name FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
    owner.chat,
    owner.user,
    owner.messageThreadId ?? null,
  )?.name;
  if (!name) return;
  const ids = app.store.all<{ conversationId: string }>(
    "SELECT d.conversationId FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=? AND d.user=? AND p.messageThreadId=?",
    owner.chat,
    owner.user,
    owner.messageThreadId!,
  );
  for (const { conversationId } of ids) {
    app.store.run(
      "UPDATE conversations SET title=? WHERE id=?",
      name,
      conversationId,
    );
    app.store.run(
      "INSERT OR IGNORE INTO conversation_titles VALUES (?)",
      conversationId,
    );
  }
}
/** Controls and menu snapshots are application-owned; deletion never retains their titles/routes. */
export function discardTelegramControls(
  store: Store,
  id: string,
  permanent = false,
) {
  const route = store.get<TelegramOwner>(
    "SELECT d.chat,d.user,p.messageThreadId FROM telegram_conversations d LEFT JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.conversationId=?",
    id,
  );
  const routeKey = route
    ? topicRouteKey({
        ...route,
        messageThreadId: route.messageThreadId ?? undefined,
      })
    : "";
  const rows = store.all<{ deliveryId: string }>(
    "SELECT deliveryId FROM telegram_control_parts WHERE conversationId IN (?,?) UNION SELECT deliveryId FROM delivery_conversations WHERE conversationId=?",
    id,
    routeKey,
    id,
  );

  for (const row of rows) {
    store.run(
      "UPDATE deliveries SET state='cancelled',result='Conversa excluída antes do envio.' WHERE id=? AND state='pending'",
      row.deliveryId,
    );
    if (!permanent) continue;
    const cron = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:cron-delivery:${row.deliveryId}`,
    );
    if (cron) {
      const menuId = (JSON.parse(cron.value) as { menuId: string }).menuId;
      store.run(
        "DELETE FROM meta WHERE key=? OR (key GLOB 'telegram:button:*' AND json_extract(value,'$.cronMenu.id')=?) OR (key GLOB 'telegram:cron-prompt:*' AND json_extract(value,'$.menuId')=?)",
        `telegram:cron-menu:${menuId}`,
        menuId,
        menuId,
      );
    }
    for (const prefix of [
      "telegram:cron-delivery:",
      "telegram:cron-prompt:",
      "telegram:force-reply:",
    ])
      store.run("DELETE FROM meta WHERE key=?", `${prefix}${row.deliveryId}`);
    const markup = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:markup:${row.deliveryId}`,
    );
    if (markup)
      for (const control of (
        JSON.parse(markup.value) as TelegramReplyMarkup
      ).inline_keyboard.flat())
        if (control.callback_data)
          store.run(
            "DELETE FROM meta WHERE key=?",
            `telegram:button:${control.callback_data}`,
          );
    store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:markup:${row.deliveryId}`,
    );
    const update = /^telegram:topics:(\d+):/.exec(row.deliveryId);
    if (update) {
      store.run(
        "INSERT OR IGNORE INTO telegram_purged_updates VALUES (?)",
        Number(update[1]),
      );
      store.run("DELETE FROM meta WHERE key=?", `telegram:update:${update[1]}`);
    }
    store.run("DELETE FROM deliveries WHERE id=?", row.deliveryId);
    store.run(
      "DELETE FROM telegram_delivery_scopes WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM telegram_delivery_resolutions WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:control-route:${row.deliveryId}`,
    );
    store.run(
      "DELETE FROM delivery_conversations WHERE deliveryId=?",
      row.deliveryId,
    );
    store.run(
      "DELETE FROM telegram_control_parts WHERE deliveryId=?",
      row.deliveryId,
    );
  }
  if (permanent) {
    store.run(
      "DELETE FROM meta WHERE (key GLOB 'telegram:model-menu:*' OR key GLOB 'telegram:cron-menu:*' OR key GLOB 'telegram:cron-prompt:*') AND CASE WHEN json_valid(value) THEN json_extract(value,'$.conversationId')=? ELSE 0 END",
      id,
    );
    store.run(
      "DELETE FROM meta WHERE key GLOB 'telegram:button:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.conversationId')=? ELSE 0 END",
      id,
    );
    if (route)
      store.run(
        "DELETE FROM meta WHERE key GLOB 'telegram:button:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.owner.chat')=? AND json_extract(value,'$.owner.user')=? AND json_extract(value,'$.owner.messageThreadId') IS ? ELSE 0 END",
        route.chat,
        route.user,
        route.messageThreadId ?? null,
      );
    store.run(
      `DELETE FROM telegram_known_topics WHERE (chat,user,messageThreadId) IN (SELECT d.chat,d.user,p.messageThreadId FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.conversationId=?) AND NOT EXISTS (SELECT 1 FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=telegram_known_topics.chat AND d.user=telegram_known_topics.user AND p.messageThreadId=telegram_known_topics.messageThreadId AND d.conversationId!=?)`,
      id,
      id,
    );
    if (
      route?.messageThreadId != null &&
      !store.get(
        `SELECT 1 FROM telegram_conversations d JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.chat=? AND d.user=? AND p.messageThreadId=? AND d.conversationId!=?`,
        route.chat,
        route.user,
        route.messageThreadId,
        id,
      )
    )
      // Retain only a terminal marker: old creation events cannot reapply an
      // edit, but the last purged history must leave no title or destination.
      store.run(
        `UPDATE meta SET value='{"state":"cancelled"}' WHERE key GLOB 'telegram:topic-title:*' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.route.chat')=? AND json_extract(value,'$.route.user')=? AND json_extract(value,'$.route.messageThreadId')=? ELSE 0 END`,
        route.chat,
        route.user,
        route.messageThreadId,
      );
  }
}
