import type { Store } from "./store.js";

/** A replied message is context, not the whole turn. */
const REPLY_LIMIT = 500;
/** What the scheduled run sees next to a message_id. */
const LIST_LIMIT = 180;
const RECENT_LIMIT = 20;

type TelegramAuthor = "bot" | "usuário" | "aviso";

export function telegramAuthor(
  from: { id?: number; is_bot?: boolean } | undefined,
  botId?: number,
): TelegramAuthor {
  if (from?.is_bot || (botId !== undefined && from?.id === botId)) return "bot";
  return "usuário";
}

function excerpt(value: string, limit: number) {
  const flat = value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Remember that this message_id belongs to this chat, so notify can confirm a reply. */
export function rememberTelegramMessage(
  store: Store,
  chat: string,
  messageId: number,
  author: TelegramAuthor,
  text: string,
) {
  if (!chat || !Number.isSafeInteger(messageId) || messageId <= 0) return;
  const body = excerpt(text, REPLY_LIMIT);
  store.run(
    `INSERT INTO telegram_seen(chat,messageId,author,excerpt) VALUES (?,?,?,?)
     ON CONFLICT(chat,messageId) DO UPDATE SET
       author=excluded.author,
       excerpt=excluded.excerpt
     WHERE telegram_seen.excerpt='' AND excluded.excerpt!=''`,
    chat,
    messageId,
    author,
    body,
  );
}

/**
 * replyTo is kept only when this chat has already seen that message_id.
 * Anything else is ignored and logged; the send itself still happens.
 */
export function acceptedReplyTo(
  store: Store,
  chat: string,
  replyTo: number | undefined,
) {
  if (replyTo === undefined) return;
  if (!Number.isSafeInteger(replyTo) || replyTo <= 0) {
    console.log(
      `Pi-Agent: notify replyTo=${String(replyTo)} ignorado; id inválido.`,
    );
    return;
  }
  if (
    store.get(
      "SELECT 1 FROM telegram_seen WHERE chat=? AND messageId=?",
      chat,
      replyTo,
    )
  )
    return replyTo;
  const other = store.get<{ chat: string }>(
    "SELECT chat FROM telegram_seen WHERE messageId=? AND chat!=? LIMIT 1",
    replyTo,
    chat,
  );
  console.log(
    other
      ? `Pi-Agent: notify replyTo=${replyTo} ignorado; a mensagem é do chat ${other.chat}, não de ${chat}.`
      : `Pi-Agent: notify replyTo=${replyTo} ignorado; pertinência ao chat ${chat} não confirmada.`,
  );
}

/** message_id of a successful sendMessage, in either envelope the transports return. */
export function sentMessageId(result: unknown) {
  const value = result as {
    message_id?: number;
    result?: { message_id?: number };
    sent?: { message_id?: number; result?: { message_id?: number } };
  };
  const id =
    value?.message_id ??
    value?.result?.message_id ??
    value?.sent?.message_id ??
    value?.sent?.result?.message_id;
  return Number.isSafeInteger(id) && (id ?? 0) > 0 ? id : undefined;
}

/**
 * Who sent a delivery the bridge just posted. Job results, runner failures and
 * parked-task notices are system notices. An ordinary answer in a user turn is
 * the bot. None of these choose a reply target: chat and topic come from the
 * route, and a reply id is only set when notify was given one that belongs here.
 */
export function outboundAuthor(
  store: Store,
  deliveryId: string,
): "bot" | "aviso" {
  if (
    deliveryId.startsWith("parked:") ||
    deliveryId.includes(":task-failure:") ||
    deliveryId.includes(":task-notification:")
  )
    return "aviso";
  const conversationId = store.get<{ conversationId: string }>(
    "SELECT conversationId FROM delivery_conversations WHERE deliveryId=?",
    deliveryId,
  )?.conversationId;
  if (!conversationId || !deliveryId.startsWith(`${conversationId}:`))
    return "bot";
  const rest = deliveryId.slice(conversationId.length + 1);
  let source: string | undefined;
  let best = -1;
  for (const row of store.all<{ requestId: string; source: string }>(
    "SELECT requestId,source FROM requests WHERE conversationId=?",
    conversationId,
  )) {
    if (
      (rest === row.requestId || rest.startsWith(`${row.requestId}:`)) &&
      row.requestId.length > best
    ) {
      best = row.requestId.length;
      source = row.source;
    }
  }
  return source === "job" || source === "system" ? "aviso" : "bot";
}

export function recentChatLines(store: Store, chat: string) {
  const rows = store
    .all<{ messageId: number; author: string; excerpt: string }>(
      "SELECT messageId,author,excerpt FROM telegram_seen WHERE chat=? ORDER BY rowid DESC LIMIT ?",
      chat,
      RECENT_LIMIT,
    )
    .reverse();
  if (!rows.length) return "";
  return [
    "Mensagens neste chat (message_id para replyTo de notify):",
    ...rows.map((row) => {
      const who = row.author === "aviso" ? "aviso do sistema" : row.author;
      const text =
        row.excerpt.length > LIST_LIMIT
          ? `${row.excerpt.slice(0, LIST_LIMIT)}…`
          : row.excerpt;
      return `#${row.messageId} ${who}: ${text || "(sem texto)"}`;
    }),
  ].join("\n");
}

/** The schedule's chat, never a chat taken from replyTo. */
export function scheduledChat(
  store: Store,
  conversationId: string,
  requestId: string | undefined,
) {
  if (requestId) {
    const task = store.get<{
      delivery: string | null;
      destinationChat: string | null;
      destinationReason: string | null;
    }>(
      `SELECT r.delivery,r.destinationChat,r.destinationReason
       FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.requestId=? AND COALESCE(r.conversationId,t.conversationId)=?`,
      requestId,
      conversationId,
    );
    if (
      task?.delivery === "web_telegram" &&
      task.destinationChat &&
      !task.destinationReason
    )
      return task.destinationChat;
  }
  return (
    store.get<{ chat: string }>(
      "SELECT chat FROM telegram_conversations WHERE conversationId=?",
      conversationId,
    )?.chat ??
    store.get<{ chat: string }>(
      "SELECT chat FROM telegram WHERE conversationId=?",
      conversationId,
    )?.chat
  );
}

type ReplySource = {
  message_id?: number;
  text?: string;
  caption?: string;
  from?: { id?: number; is_bot?: boolean };
  reply_to_message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: { id?: number; is_bot?: boolean };
  };
  quote?: { text?: string };
};

/** Prefix for an interactive turn that answers another Telegram message. */
export function formatReplyInput(
  store: Store,
  chat: string,
  message: ReplySource,
  botId?: number,
) {
  const reply = message.reply_to_message;
  const messageId = reply?.message_id;
  if (!reply || !Number.isSafeInteger(messageId) || messageId! <= 0) return "";
  const seen = store.get<{ author: string; excerpt: string }>(
    "SELECT author,excerpt FROM telegram_seen WHERE chat=? AND messageId=?",
    chat,
    messageId!,
  );
  const system = seen?.author === "aviso";
  const author = system
    ? "aviso do sistema"
    : telegramAuthor(reply.from, botId);
  const fromUpdate = excerpt(reply.text ?? reply.caption ?? "", REPLY_LIMIT);
  const fromSeen = excerpt(seen?.excerpt ?? "", REPLY_LIMIT);
  const body = fromUpdate || fromSeen;
  const lines = [`[respondendo a #${messageId} · ${author}]`];
  if (system) lines.push("A mensagem respondida é um aviso do sistema.");
  if (body) lines.push(body);
  const quote = excerpt(message.quote?.text ?? "", REPLY_LIMIT);
  if (quote) lines.push(`[citação] ${quote}`);
  return `${lines.join("\n")}\n\n`;
}
