import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import { telegramConversationRoute } from "./task-telegram.js";
import type { TelegramReplyMarkup } from "./telegram-controls.js";
import { sentMessageId } from "./telegram-reply.js";

/** Model-facing name. Always registered; scheduled runs get a refusal from execute. */
export const ASK_USER_TOOL = "ask_user";

/** Exact refusal a scheduled occurrence receives. Nothing is posted. */
export const ASK_USER_SCHEDULED_ERROR =
  "ask_user not available in scheduled runs";

/**
 * Inline-button payload. Distinct from `pi:<32 hex>` approval and menu buttons.
 * `ask:` + 32 lowercase hex (the question token) + `:` + the choice index (0–5).
 * 38 bytes, under Telegram's 64-byte callback_data limit.
 */
export const ASK_CALLBACK = /^ask:([a-f0-9]{32}):([0-5])$/;

const QUESTION_LIMIT = 1000;
const MAX_CHOICES = 6;
const LABEL_BYTES = 64;
const PENDING_MS = 24 * 60 * 60 * 1000;
const POSTED =
  "Question posted in this chat. This turn ends; the user's answer arrives as the next message.";
const NOTE_RECORDED = "Answer recorded.";
const NOTE_ANSWERED = "Already answered.";
const NOTE_STALE = "This question is no longer active.";
const NOTE_DENIED = "Not authorized.";

interface AskRow {
  conversationId: string;
  chat: string;
  user: string;
  messageThreadId: number | null;
  question: string;
  choices: string[];
  deliveryId: string;
  createdAt: number;
  expiresAt: number;
  state: "open" | "answered" | "superseded";
  choice?: number;
}

interface AskUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; is_bot?: boolean };
    data?: string;
    message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      message_thread_id?: number;
    };
  };
}

interface AskTransport {
  answerCallback?(id: string, text: string): Promise<unknown>;
  editMessage?(
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ): Promise<unknown>;
}

function fail(text: string) {
  return {
    isError: true as const,
    output: [{ type: "text" as const, text }],
  };
}

function done(text: string) {
  return {
    output: [{ type: "text" as const, text }],
    control: { terminate: true as const },
  };
}

function tokenFor(conversationId: string, callId: string) {
  return createHash("sha256")
    .update(`${conversationId}\n${callId}`)
    .digest("hex")
    .slice(0, 32);
}

function askKey(token: string) {
  return `telegram:ask:${token}`;
}

function parseRow(raw: string): AskRow | undefined {
  try {
    const value = JSON.parse(raw) as AskRow;
    if (
      !value ||
      typeof value.conversationId !== "string" ||
      typeof value.question !== "string" ||
      !Array.isArray(value.choices) ||
      (value.state !== "open" &&
        value.state !== "answered" &&
        value.state !== "superseded")
    )
      return;
    return value;
  } catch {
    return;
  }
}

function readAsk(store: Store, token: string) {
  const saved = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    askKey(token),
  );
  if (!saved) return;
  const row = parseRow(saved.value);
  return row ? { key: askKey(token), raw: saved.value, row } : undefined;
}

function listOpen(store: Store, conversationId: string, now: number) {
  return store
    .all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key GLOB 'telegram:ask:*'",
    )
    .flatMap((saved) => {
      if (!/^telegram:ask:[a-f0-9]{32}$/.test(saved.key)) return [];
      const row = parseRow(saved.value);
      if (
        !row ||
        row.conversationId !== conversationId ||
        row.state !== "open" ||
        row.expiresAt <= now
      )
        return [];
      return [{ key: saved.key, raw: saved.value, row }];
    });
}

/** A scheduled occurrence has nobody to tap a button. */
function scheduledAsk(app: Runtime, conversationId: string) {
  if (app.scheduledTurn(conversationId)) return true;
  return !!app.store.get(
    "SELECT 1 FROM requests WHERE conversationId=? AND status='pending' AND source='task'",
    conversationId,
  );
}

function normalizeChoices(choices: string[] | undefined) {
  if (!choices?.length) return [] as string[];
  if (choices.length > MAX_CHOICES)
    return "ask_user accepts at most 6 choices.";
  const labels: string[] = [];
  for (const raw of choices) {
    const label = raw.trim();
    if (
      !label ||
      /[\u0000-\u001f\u007f]/.test(label) ||
      Buffer.byteLength(label) > LABEL_BYTES
    )
      return "ask_user choices must be short non-empty labels.";
    labels.push(label);
  }
  return labels;
}

function claim(store: Store, key: string, raw: string, next: AskRow) {
  return (
    store.run(
      "UPDATE meta SET value=? WHERE key=? AND value=?",
      JSON.stringify(next),
      key,
      raw,
    ).changes === 1
  );
}

function deliveryMessageId(store: Store, deliveryId: string) {
  const saved = store.get<{ state: string; result: string | null }>(
    "SELECT state, result FROM deliveries WHERE id=?",
    deliveryId,
  );
  if (saved?.state !== "sent" || !saved.result) return;
  try {
    return sentMessageId(JSON.parse(saved.result));
  } catch {
    return;
  }
}

/** Close every open question in this topic. A later tap does not start a turn. */
export async function retireOpenQuestions(
  app: Runtime,
  conversationId: string,
  transport: AskTransport,
) {
  const now = Date.now();
  for (const item of listOpen(app.store, conversationId, now)) {
    if (
      !claim(app.store, item.key, item.raw, {
        ...item.row,
        state: "superseded",
      })
    )
      continue;
    app.store.run(
      "DELETE FROM meta WHERE key=?",
      `telegram:markup:${item.row.deliveryId}`,
    );
    const messageId = deliveryMessageId(app.store, item.row.deliveryId);
    if (!messageId) continue;
    try {
      await transport.editMessage?.(
        item.row.chat,
        messageId,
        item.row.question,
        { inline_keyboard: [] },
      );
    } catch {
      /* the tap is already ignored; a failed edit leaves a dead button */
    }
  }
}

function answerText(question: string, choice: string) {
  return `Answer to: ${question} -> ${choice}`;
}

/**
 * Button tap for an ask_user question. Unknown, answered, superseded, or expired
 * taps only acknowledge the callback. A live tap is admitted once as user text.
 */
export async function handleAskCallback(
  app: Runtime,
  update: AskUpdate,
  transport: AskTransport,
  access: {
    users: readonly string[];
    chats: readonly string[];
    botId?: number;
  },
) {
  const query = update.callback_query;
  const answer = async (text: string) => {
    try {
      await transport.answerCallback?.(query?.id ?? "", text);
    } catch {
      /* an expired acknowledgement does not admit another turn */
    }
  };
  const ignored = { ignored: true as const };
  const data = query?.data ?? "";
  const parsed = ASK_CALLBACK.exec(data);
  if (
    !query ||
    !parsed ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    !query.id ||
    query.from.is_bot ||
    !Number.isSafeInteger(query.from.id) ||
    query.from.id <= 0
  ) {
    if (query?.id && data.startsWith("ask:")) await answer(NOTE_STALE);
    return ignored;
  }
  const message = query.message;
  if (
    !message?.chat ||
    !Number.isSafeInteger(message.message_id) ||
    message.message_id <= 0 ||
    (message.message_thread_id !== undefined &&
      (!Number.isSafeInteger(message.message_thread_id) ||
        message.message_thread_id <= 0))
  ) {
    await answer(NOTE_STALE);
    return ignored;
  }
  const token = parsed[1];
  const index = Number(parsed[2]);
  const saved = readAsk(app.store, token);
  if (!saved || saved.row.expiresAt <= Date.now()) {
    await answer(NOTE_STALE);
    return ignored;
  }
  const row = saved.row;
  const user = String(query.from.id);
  const chat = String(message.chat.id);
  const thread = message.message_thread_id ?? null;
  if (
    !access.users.includes(user) ||
    !access.chats.includes(chat) ||
    user !== row.user ||
    chat !== row.chat ||
    thread !== row.messageThreadId ||
    (access.botId !== undefined &&
      message.from?.id !== undefined &&
      message.from.id !== access.botId)
  ) {
    await answer(NOTE_DENIED);
    return ignored;
  }
  if (row.state === "answered") {
    await answer(NOTE_ANSWERED);
    return ignored;
  }
  if (row.state !== "open") {
    await answer(NOTE_STALE);
    return ignored;
  }
  const choice = row.choices[index];
  if (choice === undefined) {
    await answer(NOTE_STALE);
    return ignored;
  }
  const next: AskRow = { ...row, state: "answered", choice: index };
  if (!claim(app.store, saved.key, saved.raw, next)) {
    await answer(NOTE_ANSWERED);
    return ignored;
  }
  try {
    await transport.editMessage?.(
      chat,
      message.message_id,
      `${row.question}\n\nAnswer: ${choice}`,
      { inline_keyboard: [] },
    );
  } catch {
    /* the admission below is the answer; a failed edit does not repeat it */
  }
  const text = answerText(row.question, choice);
  try {
    await app.admit(row.conversationId, `ask:${token}`, text, {
      source: "telegram",
      chat: row.chat,
      user: row.user,
      ...(row.messageThreadId === null
        ? {}
        : { messageThreadId: row.messageThreadId }),
    });
  } catch {
    const admitted = app.store.get(
      "SELECT 1 FROM requests WHERE conversationId=? AND requestId=?",
      row.conversationId,
      `ask:${token}`,
    );
    if (!admitted)
      claim(app.store, saved.key, JSON.stringify(next), {
        ...row,
        state: "open",
      });
    await answer(NOTE_STALE);
    return ignored;
  }
  await answer(NOTE_RECORDED);
  return { conversationId: row.conversationId, control: true as const };
}

export function createAskUserTool(app: Runtime) {
  return defineTool({
    name: ASK_USER_TOOL,
    description:
      "Ask the user one real decision in this chat (choose A or B, or approve a draft) and end the turn. Optional choices are short button labels, at most 6. Do not use it for an ordinary reply. The call returns immediately; the answer arrives as the next message. Refused in a scheduled run (ask_user not available in scheduled runs). Not an MCP or Executor approval card.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: QUESTION_LIMIT }),
      choices: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: LABEL_BYTES }), {
          maxItems: MAX_CHOICES,
          description: "Short button labels, at most 6",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      if (scheduledAsk(app, conversationId))
        return fail(ASK_USER_SCHEDULED_ERROR);
      const question = args.question.trim();
      if (!question)
        return fail("ask_user needs a question. Nothing was posted.");
      const choices = normalizeChoices(args.choices);
      if (typeof choices === "string") return fail(choices);
      const route = telegramConversationRoute(app.store, conversationId);
      if (!route)
        return fail(
          "ask_user needs this conversation's Telegram chat. Nothing was posted.",
        );
      const token = tokenFor(conversationId, api.callId);
      const key = askKey(token);
      try {
        app.store.savepoint("ask_user", () => {
          if (readAsk(app.store, token)) return;
          const now = Date.now();
          for (const item of listOpen(app.store, conversationId, now)) {
            if (item.key === key) continue;
            if (
              !claim(app.store, item.key, item.raw, {
                ...item.row,
                state: "superseded",
              })
            )
              continue;
            app.store.run(
              "DELETE FROM meta WHERE key=?",
              `telegram:markup:${item.row.deliveryId}`,
            );
          }
          const prefix = `telegram:ask-post:${token}`;
          app.store.queueTelegram(
            prefix,
            route.chat,
            question,
            3500,
            conversationId,
            route.messageThreadId,
          );
          const deliveryId = `${prefix}:0`;
          if (!app.store.get("SELECT 1 FROM deliveries WHERE id=?", deliveryId))
            throw new Error("ask_user could not queue the question.");
          if (choices.length) {
            const markup: TelegramReplyMarkup = {
              inline_keyboard: choices.map((text, index) => [
                { text, callback_data: `ask:${token}:${index}` },
              ]),
            };
            app.store.run(
              "INSERT OR REPLACE INTO meta VALUES (?,?)",
              `telegram:markup:${deliveryId}`,
              JSON.stringify(markup),
            );
          }
          const row: AskRow = {
            conversationId,
            chat: route.chat,
            user: route.user,
            messageThreadId: route.messageThreadId,
            question,
            choices,
            deliveryId,
            createdAt: now,
            expiresAt: now + PENDING_MS,
            state: "open",
          };
          app.store.run(
            "INSERT OR IGNORE INTO meta VALUES (?,?)",
            key,
            JSON.stringify(row),
          );
        });
      } catch {
        if (!readAsk(app.store, token))
          return fail(
            "ask_user could not post the question. Nothing was sent.",
          );
      }
      app.flushTelegramPending?.();
      return done(POSTED);
    },
  });
}
