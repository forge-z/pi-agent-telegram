import { telegramIdentity } from "./telegram-identity.js";
import { acceptedReplyTo } from "./telegram-reply.js";
import { childIds, type Store } from "./store.js";

export interface TelegramRoute {
  chat: string;
  user: string;
  botId: string;
  conversationId: string;
  messageThreadId: number | null;
}

export function telegramConversationRoute(
  store: Store,
  conversationId: string,
): TelegramRoute | undefined {
  if (store.conversationDeleted(conversationId)) return;
  const saved = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key='telegram:connection'",
  );
  if (!saved) return;
  try {
    const dedicated = store.get<{ chat: string; user: string }>(
      "SELECT chat,user FROM telegram_conversations WHERE conversationId=?",
      conversationId,
    );
    const identity = telegramIdentity(store, dedicated);
    if (!identity) return;
    const config = {
      enabled: true,
      bot: { id: identity.botId },
      userId: identity.user,
      chatId: identity.chat,
    };
    if (
      dedicated &&
      (dedicated.chat !== config.chatId || dedicated.user !== config.userId)
    )
      return;
    if (
      !store.get(
        "SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
        config.chatId,
        config.userId,
        conversationId,
      )
    )
      return;
    // Dedicated conversations carry their own authorization; the setup anchor
    // may be archived or navigation may select a different conversation.
    if (
      !dedicated &&
      !store.get(
        "SELECT 1 FROM telegram WHERE chat=? AND user=? AND conversationId=?",
        config.chatId,
        config.userId,
        conversationId,
      )
    )
      return;

    if (
      store.get(
        "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
        config.chatId,
        config.userId,
        store.telegramThread(conversationId) ?? null,
      )
    )
      return;
    return {
      chat: config.chatId,
      user: config.userId,
      botId: String(config.bot.id),
      conversationId,
      messageThreadId: store.telegramThread(conversationId) ?? null,
    };
  } catch {
    return;
  }
}

/** Revalidate a frozen route without consulting mutable chat selection. */
export function telegramRouteAuthorized(
  store: Store,
  route: TelegramRoute,
): boolean {
  if (store.conversationDeleted(route.conversationId)) return false;
  try {
    const config = telegramIdentity(store, route);
    if (!config || String(config.botId) !== route.botId) return false;
    if (
      !store.get(
        "SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
        route.chat,
        route.user,
        route.conversationId,
      )
    )
      return false;
    const dedicated = store.get<{ chat: string; user: string }>(
      "SELECT chat,user FROM telegram_conversations WHERE conversationId=?",
      route.conversationId,
    );
    if (
      dedicated
        ? dedicated.chat !== route.chat || dedicated.user !== route.user
        : !store.get(
            "SELECT 1 FROM telegram WHERE chat=? AND user=?",
            route.chat,
            route.user,
          )
    )
      return false;
    if (
      (store.telegramThread(route.conversationId) ?? null) !==
      route.messageThreadId
    )
      return false;
    return !store.get(
      "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
      route.chat,
      route.user,
      route.messageThreadId,
    );
  } catch {
    return false;
  }
}

/** Report whether the current configured user/chat/bot mapping authorizes a
 * conversation. The sender performs this check again immediately before send. */
export function taskTelegramAvailable(store: Store, conversationId: string) {
  return !!telegramConversationRoute(store, conversationId);
}

/**
 * Spaces and invisible characters are not a message. Categories, not a fixed list:
 * separators (Z, including NBSP), controls (Cc), format characters (Cf: ZWSP through
 * the bidi marks, word joiner, BOM) and marks that do not take space on their own.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}\p{Mn}\p{Me}]/gu;

export function isBlankMessage(value: string | null | undefined) {
  return !(value ?? "").replace(INVISIBLE, "");
}

/** True when a terminal occurrence's user-visible result reached Telegram (or was intentionally skipped). */
export function taskOccurrenceDelivered(
  store: Store,
  conversationId: string,
  requestId: string,
): boolean {
  const notification = store.get<{ state: string }>(
    "SELECT state FROM task_notifications WHERE conversationId=? AND requestId=?",
    conversationId,
    requestId,
  );
  if (
    notification?.state === "silent" ||
    notification?.state === "web_only" ||
    notification?.state === "skipped"
  )
    return true;
  for (const base of [
    `${conversationId}:${requestId}:task-notification`,
    `${conversationId}:${requestId}`,
  ]) {
    const row = store.get<{ state: string }>(
      "SELECT state FROM deliveries WHERE id>=? AND id<? ORDER BY rowid DESC LIMIT 1",
      `${base}:`,
      `${base};`,
    );
    if (row?.state === "sent") return true;
  }
  return false;
}

type TaskDelivery = {
  delivery: string | null;
  destinationChat: string | null;
  destinationUser: string | null;
  destinationBotId: string | null;
  destinationMessageThreadId: number | null;
  destinationReason: string | null;
};

function taskDelivery(store: Store, conversationId: string, requestId: string) {
  return store.get<TaskDelivery>(
    `SELECT r.delivery,r.destinationChat,r.destinationUser,r.destinationBotId,r.destinationMessageThreadId,r.destinationReason
     FROM task_runs r JOIN tasks t ON t.id=r.taskId
     WHERE r.requestId=? AND COALESCE(r.conversationId,t.conversationId)=?`,
    requestId,
    conversationId,
  );
}

/** The occurrence's frozen chat and topic, or why it cannot be used. */
function taskRoute(store: Store, conversationId: string, task: TaskDelivery) {
  const frozen: TelegramRoute | undefined =
    task.delivery === "web_telegram" &&
    !task.destinationReason &&
    task.destinationChat &&
    task.destinationUser &&
    task.destinationBotId
      ? {
          chat: task.destinationChat,
          user: task.destinationUser,
          botId: task.destinationBotId,
          conversationId,
          messageThreadId: task.destinationMessageThreadId,
        }
      : undefined;
  const route =
    frozen && telegramRouteAuthorized(store, frozen) ? frozen : undefined;
  const reason = route
    ? null
    : (task.destinationReason ??
      (frozen
        ? "Vínculo Telegram revogado antes do envio."
        : "Destino legado não comprovado. Selecione o destino para execuções futuras."));
  return { route, reason };
}

function rememberRouteError(store: Store, requestId: string, reason: string) {
  store.run(
    "UPDATE tasks SET lastError=? WHERE id=(SELECT taskId FROM task_runs WHERE requestId=?)",
    reason,
    requestId,
  );
}

/** True when this occurrence already queued a `notify` message. */
export function runNotified(
  store: Store,
  conversationId: string,
  requestId: string,
) {
  const prefix = `${conversationId}:${requestId}:notify`;
  return !!store.get(
    "SELECT 1 FROM deliveries WHERE id>=? AND id<?",
    ...childIds(prefix),
  );
}

/**
 * Post one `notify` message to the occurrence's chat and topic.
 * Returns an error for the model when nothing was sent.
 */
export function queueNotify(
  store: Store,
  conversationId: string,
  requestId: string,
  callId: string,
  text: string,
  replyTo?: number,
) {
  if (isBlankMessage(text))
    return "notify recusou o texto: depois de remover espaços e caracteres invisíveis ele ficou vazio. Nada foi enviado.";
  const task = taskDelivery(store, conversationId, requestId);
  const source = store.get<{ source: string }>(
    "SELECT source FROM requests WHERE conversationId=? AND requestId=?",
    conversationId,
    requestId,
  )?.source;
  if (source === "task" && !task)
    return "Não há ocorrência de agendamento para esta chamada. Nada foi enviado.";
  if (task?.delivery === "none")
    return "Este agendamento não envia mensagens. Nada foi enviado.";
  if (task?.delivery === "web")
    return "Este agendamento não tem destino no Telegram. Nada foi enviado.";
  const resolved = task ? taskRoute(store, conversationId, task) : undefined;
  const route =
    resolved?.route ??
    (!task ? telegramConversationRoute(store, conversationId) : undefined);
  if (!route) {
    const reason =
      resolved?.reason ??
      "Esta conversa não está vinculada a um chat do Telegram.";
    if (task) rememberRouteError(store, requestId, reason);
    return `${reason} Nada foi enviado.`;
  }
  const notificationId = `${conversationId}:${requestId}:task-notification`;
  const safeCall = callId.replace(/[^\w.-]/g, "_").slice(0, 80) || "call";
  const prefix = `${conversationId}:${requestId}:notify:${safeCall}`;
  store.db.exec("SAVEPOINT notify_delivery");
  try {
    const existing = store.get<{ state: string }>(
      "SELECT state FROM task_notifications WHERE id=?",
      notificationId,
    );
    if (!existing && task) {
      store.run(
        `INSERT INTO task_notifications(id,conversationId,requestId,chat,user,botId,state,messageThreadId)
         VALUES (?,?,?,?,?,?,'queued',?)`,
        notificationId,
        conversationId,
        requestId,
        route.chat,
        route.user,
        route.botId,
        route.messageThreadId,
      );
    } else if (
      existing &&
      existing.state !== "queued" &&
      existing.state !== "sent"
    ) {
      store.db.exec("RELEASE SAVEPOINT notify_delivery");
      return "O destino deste agendamento não aceita mensagens. Nada foi enviado.";
    }
    const reply = acceptedReplyTo(store, route.chat, replyTo);
    store.queueTelegram(
      prefix,
      route.chat,
      text,
      3500,
      conversationId,
      route.messageThreadId,
      undefined,
      undefined,
      reply,
    );
    if (task)
      store.run(
        `INSERT OR IGNORE INTO task_notification_parts(deliveryId,notificationId)
         SELECT id,? FROM deliveries WHERE id>=? AND id<?`,
        notificationId,
        ...childIds(prefix),
      );
    store.db.exec("RELEASE SAVEPOINT notify_delivery");
  } catch (error) {
    store.db.exec("ROLLBACK TO SAVEPOINT notify_delivery");
    store.db.exec("RELEASE SAVEPOINT notify_delivery");
    throw error;
  }
  if (!runNotified(store, conversationId, requestId))
    return "notify não enviou: o texto não produziu mensagem. Nada foi enviado.";
  return;
}

/** Freeze a terminal occurrence's destination, including a skipped notification.
 * Replays must never send an old result to a newly linked conversation/chat.
 * `kind` keeps a system failure distinct from messages `notify` already queued. */
export function queueTaskTelegram(
  store: Store,
  conversationId: string,
  requestId: string,
  result: string,
  kind = "task-notification",
) {
  const task = taskDelivery(store, conversationId, requestId);
  if (!task) return;
  const id = `${conversationId}:${requestId}:${kind}`;
  store.db.exec("SAVEPOINT task_notification");
  try {
    if (!store.get("SELECT 1 FROM task_notifications WHERE id=?", id)) {
      // "none" is side effects only: nothing is recorded to send, not even a skip.
      if (task.delivery === "none") {
        store.db.exec("RELEASE SAVEPOINT task_notification");
        return;
      }
      if (task.delivery === "web") {
        store.run(
          `INSERT INTO task_notifications(id,conversationId,requestId,chat,user,botId,state)
           VALUES (?,?,?,NULL,NULL,NULL,'web_only')`,
          id,
          conversationId,
          requestId,
        );
        store.db.exec("RELEASE SAVEPOINT task_notification");
        return;
      }
      const { route, reason } = taskRoute(store, conversationId, task);
      store.run(
        `INSERT INTO task_notifications(id,conversationId,requestId,chat,user,botId,state,messageThreadId,reason)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        conversationId,
        requestId,
        route?.chat ?? null,
        route?.user ?? null,
        route?.botId ?? null,
        route ? "queued" : "skipped",
        route?.messageThreadId ?? null,
        reason,
      );
      if (reason) rememberRouteError(store, requestId, reason);
      if (route && !isBlankMessage(result)) {
        store.queueTelegram(
          id,
          route.chat,
          result,
          3500,
          conversationId,
          route.messageThreadId,
        );
        store.run(
          `INSERT INTO task_notification_parts(deliveryId,notificationId)
           SELECT id,? FROM deliveries WHERE id>=? AND id<?`,
          id,
          ...childIds(id),
        );
      }
    }
    store.db.exec("RELEASE SAVEPOINT task_notification");
  } catch (error) {
    store.db.exec("ROLLBACK TO SAVEPOINT task_notification");
    store.db.exec("RELEASE SAVEPOINT task_notification");
    throw error;
  }
}

/** Called immediately before each send; ordinary command/reply deliveries retain
 * their existing behavior. No token or provider credential is read here. */
export function taskTelegramAuthorized(
  store: Store,
  deliveryId: string,
  users: string[],
  chats: string[],
  botId?: number,
) {
  const owner = store.get<{ conversationId: string }>(
    "SELECT conversationId FROM delivery_conversations WHERE deliveryId=?",
    deliveryId,
  );
  if (owner && store.conversationDeleted(owner.conversationId)) return false;
  const receipt = store.get<TelegramRoute>(
    `SELECT n.* FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId
     WHERE p.deliveryId=?`,
    deliveryId,
  );
  const delivery = store.get<{ chat: string; messageThreadId: number | null }>(
    "SELECT chat,messageThreadId FROM deliveries WHERE id=?",
    deliveryId,
  );
  if (!receipt) {
    const requestRoute =
      owner &&
      store.get<TelegramRoute & { state: string }>(
        `SELECT * FROM request_telegram_routes WHERE conversationId=?
       AND substr(?,1,length(conversationId||':'||requestId||':'))=conversationId||':'||requestId||':'
       ORDER BY length(requestId) DESC LIMIT 1`,
        owner.conversationId,
        deliveryId,
      );
    if (requestRoute)
      return (
        requestRoute.state === "authorized" &&
        telegramRouteAuthorized(store, requestRoute) &&
        delivery?.chat === requestRoute.chat &&
        (delivery.messageThreadId ?? null) === requestRoute.messageThreadId &&
        String(botId) === requestRoute.botId &&
        users.includes(requestRoute.user) &&
        chats.includes(requestRoute.chat)
      );
    const dedicated =
      owner &&
      store.get<{ chat: string; user: string }>(
        "SELECT chat,user FROM telegram_conversations WHERE conversationId=?",
        owner.conversationId,
      );
    if (!dedicated) return true;
    if (delivery?.chat !== dedicated.chat) return false;
    if (
      (delivery?.messageThreadId ?? null) !==
      (store.telegramThread(owner!.conversationId) ?? null)
    )
      return false;
    if (
      store.get(
        "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
        dedicated.chat,
        dedicated.user,
        delivery?.messageThreadId ?? null,
      )
    )
      return false;
    if (!users.includes(dedicated.user) || !chats.includes(dedicated.chat))
      return false;
    // Legacy transport-only installs have no configured route receipts. Their
    // established private binding and own grant still authorize ordinary replies.
    // Configured or captured requests always use the strict checks above.
    if (!store.get("SELECT 1 FROM meta WHERE key='telegram:connection'"))
      return !!store.get(
        `SELECT 1 FROM telegram_grants g JOIN telegram t ON t.chat=g.chat AND t.user=g.user
         WHERE g.conversationId=? AND g.chat=? AND g.user=?`,
        owner!.conversationId,
        dedicated.chat,
        dedicated.user,
      );
    const route = telegramConversationRoute(store, owner!.conversationId);
    return (
      !!route &&
      String(botId) === route.botId &&
      telegramRouteAuthorized(store, route)
    );
  }
  return (
    telegramRouteAuthorized(store, receipt) &&
    (delivery?.messageThreadId ?? null) === receipt.messageThreadId &&
    String(botId) === receipt.botId &&
    users.includes(receipt.user) &&
    chats.includes(receipt.chat)
  );
}
