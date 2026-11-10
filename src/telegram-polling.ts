import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
import {
  ConversationError,
  ConversationBusyError,
  isRetryableError,
} from "./runtime.js";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Runtime } from "./runtime.js";
import {
  Telegram,
  TelegramInputError,
  TelegramSendRefused,
  type TelegramUpdate,
} from "./telegram.js";
import { TelegramApiError, type TelegramApi } from "./telegram-api.js";
import { hash } from "./store.js";

export const cleanCommands = [
  { command: "model", description: "Choose provider and model" },
  { command: "thinking", description: "Choose effort" },
  { command: "crons", description: "Create and manage schedules" },
  { command: "new", description: "Start another conversation in this topic" },
  { command: "resume", description: "Resume a stuck task" },
  { command: "stop", description: "Stop this topic" },
  { command: "status", description: "Model, MCPs, run, and version" },
  { command: "help", description: "Help" },
];
/**
 * Telegram keeps a separate command list per language. An earlier implementation
 * wrote the menu in the app's own language, so a client using it kept the old
 * commands after the list itself changed; that copy is rewritten along with the
 * base one. Adding a language here never removes the base list.
 */
const MENU_LANGUAGES = ["pt"];
export function configureTelegram(
  appStore: Runtime["store"],
  config: { token: string; users: string[]; chats: string[] },
  bot: { id: number; username?: string },
) {
  if (!Number.isSafeInteger(bot.id) || bot.id <= 0)
    throw new Error("Invalid bot identity.");
  const old = appStore.get<{ value: string }>(
    "SELECT value FROM meta WHERE key='telegram:connection'",
  );
  if (old && JSON.parse(old.value).bot?.id !== bot.id)
    throw new Error("Volume pertence a outro bot. Use um volume separado.");
  appStore.savepoint("clean_connection", () => {
    appStore.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
      JSON.stringify({ botId: bot.id, token: hash(config.token) }),
    );
    appStore.run(
      "INSERT INTO meta VALUES ('telegram:connection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({
        enabled: true,
        bot,
        userId: config.users[0],
        chatId: config.chats[0],
        allowedUsers: config.users,
        allowedChats: config.chats,
      }),
    );
  });
}
function updateLaneKey(update: TelegramUpdate): string {
  if (update.callback_query) {
    // Callbacks bypass chat/transcription lanes so approval buttons are never stuck behind audio
    return `cb:${update.update_id}`;
  }
  const message = update.message;
  if (!message?.chat) return `update:${update.update_id}`;
  const chat = String(message.chat.id);
  const thread = message.message_thread_id;
  return thread ? `${chat}:${thread}` : chat;
}

export class TelegramPolling {
  private controller = new AbortController();
  private work?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private flushWork?: Promise<void>;
  private lastPoll = 0;
  private failed = false;
  private lanes = new Map<string, Promise<void>>();
  private inFlightUpdates = new Set<number>();
  private completedUpdates = new Set<number>();
  private unacknowledged = new Set<number>();
  private persistedOffset?: number;
  /** Transient failures stay unacked and retry with backoff. Keyed by update id. */
  private retries = new Map<
    number,
    { lane: string; attempts: number; after: number }
  >();
  readonly engine: Telegram;
  constructor(
    private app: Runtime,
    private api: TelegramApi,
    private config: { users: string[]; chats: string[] },
    private bot: { id: number; username?: string },
  ) {
    const signal = this.controller.signal;
    this.engine = new Telegram(
      app,
      {
        downloadFile: (fileId: string) => {
          if (!api.downloadFile) throw new TelegramApiError("unavailable");
          return api.downloadFile(fileId, signal);
        },
        sendMedia: (chat, media, options) => {
          if (!api.sendMedia) throw new TelegramApiError("unavailable");
          return api.sendMedia(chat, media, options);
        },
        answerCallback: (id, text) =>
          api.call(
            "answerCallbackQuery",
            { callback_query_id: id, text },
            signal,
          ),
        editMessage: (chat, id, text, markup) =>
          api.call(
            "editMessageText",
            {
              chat_id: chat,
              message_id: id,
              text: app.options.redact?.(text) ?? text,
              reply_markup: markup,
            },
            signal,
          ),
        typing: (chat, options) =>
          api.call(
            "sendChatAction",
            {
              chat_id: chat,
              action: "typing",
              ...(options?.messageThreadId
                ? { message_thread_id: options.messageThreadId }
                : {}),
            },
            signal,
          ),
        send: async (chat, text, options) => {
          try {
            return await api.call(
              "sendMessage",
              {
                chat_id: chat,
                text,
                ...(options?.parseMode
                  ? { parse_mode: options.parseMode }
                  : {}),
                ...(options?.messageThreadId
                  ? { message_thread_id: options.messageThreadId }
                  : {}),
                ...(options?.replyTo
                  ? {
                      reply_parameters: {
                        message_id: options.replyTo,
                        allow_sending_without_reply: true,
                      },
                    }
                  : {}),
                ...(options?.replyMarkup
                  ? { reply_markup: options.replyMarkup }
                  : options?.forceReply
                    ? { reply_markup: { force_reply: true, selective: true } }
                    : {}),
              },
              signal,
            );
          } catch (error) {
            if (error instanceof TelegramApiError && error.refusedCode)
              throw new TelegramSendRefused(
                error.refusedCode,
                error.retryAfter,
              );
            throw error;
          }
        },
      },
      config.users,
      config.chats,
      bot.username,
      false,
      bot.id,
    );
  }
  start(onFailure: () => void = () => {}) {
    this.work = this.run().catch(() => {
      if (this.controller.signal.aborted) return;
      this.failed = true;
      console.error("Polling stopped; check configuration and connection.");
      setTimeout(onFailure, 0);
    });
    this.timer = setInterval(() => {
      if (this.flushWork) return;
      this.flushWork = this.engine
        .flush()
        .then(() => {
          if (
            !this.controller.signal.aborted &&
            !this.failed &&
            Date.now() - this.lastPoll < 90_000
          ) {
            const path = join(this.app.options.dir, "health.json");
            writeFileSync(
              `${path}.tmp`,
              JSON.stringify({
                at: Date.now(),
                jobs_poller: this.app.pendingJobs.health(),
              }),
              {
                mode: 0o600,
              },
            );
            renameSync(`${path}.tmp`, path);
          }
        })
        .catch(() => {
          console.error("Falha na fila Telegram.");
        })
        .finally(() => {
          this.flushWork = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  /** Registers one chat's menu. A bad token is fatal at startup, never on reload. */
  private async registerCommands(
    chat: string,
    fatal = false,
    signal?: AbortSignal,
  ) {
    for (const language_code of [undefined, ...MENU_LANGUAGES]) {
      try {
        await this.api.call(
          "setMyCommands",
          {
            scope: { type: "chat", chat_id: Number(chat) },
            commands: cleanCommands,
            ...(language_code ? { language_code } : {}),
          },
          signal,
        );
      } catch (error) {
        if (
          fatal &&
          error instanceof TelegramApiError &&
          ["invalid_token", "conflict"].includes(error.kind)
        )
          throw error;
        console.error(
          `setMyCommands failed for chat ${chat}${language_code ? ` (${language_code})` : ""} (bot is not in the chat, or TELEGRAM_ALLOWED_CHATS has the wrong id). Polling continues.`,
        );
      }
    }
  }
  private advanceOffset(key: string) {
    if (this.unacknowledged.size === 0) return;
    const sorted = Array.from(this.unacknowledged).sort((a, b) => a - b);
    for (const id of sorted) {
      if (!this.completedUpdates.has(id)) {
        // Lowest unacknowledged update is still in flight; cannot advance past it
        break;
      }
      this.completedUpdates.delete(id);
      this.unacknowledged.delete(id);
      const nextOffset = id + 1;
      this.persistedOffset = nextOffset;
      this.app.store.run(
        "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        String(nextOffset),
      );
    }
  }

  /** Best-effort reply. A lost answer does not retry the update's effects. */
  private async replyToUpdate(
    value: TelegramUpdate,
    text: string,
    signal: AbortSignal,
  ) {
    const message = value.message;
    if (!message?.from || !message.chat || !text) return;
    const user = String(message.from.id);
    const chat = String(message.chat.id);
    if (!this.config.users.includes(user) || !this.config.chats.includes(chat))
      return;
    try {
      await this.api.call(
        "sendMessage",
        {
          chat_id: chat,
          text,
          ...(Number.isSafeInteger(message.message_thread_id) &&
          message.message_thread_id! > 0
            ? { message_thread_id: message.message_thread_id }
            : {}),
        },
        signal,
      );
    } catch {
      /* The update is still terminal for a non-transient failure. */
    }
  }

  private async run() {
    const signal = this.controller.signal;
    const webhook = (await this.api.call("getWebhookInfo", {}, signal)) as {
      url?: string;
    };
    if (webhook.url)
      throw new Error(
        "A webhook is set; remove it explicitly before starting polling.",
      );
    for (const chat of this.config.chats)
      await this.registerCommands(chat, true, signal);
    // A running deployment picks up a changed menu from `/status`, not only at boot.
    this.engine.onReload = (chat) => this.registerCommands(chat);
    if (signal.aborted) return;
    // Drop the removed per-message journal. Leave the completion offset alone:
    // Telegram redelivers anything it still has, and we do not replay a stored copy.
    this.app.store.run(
      `DELETE FROM meta WHERE key GLOB 'telegram:polling:*'
        OR key GLOB 'telegram:journal-offset:*'
        OR key GLOB 'telegram:update-identity:*'`,
    );
    this.app.tasks.start();
    let failures = 0;
    while (!signal.aborted) {
      try {
        const key = `telegram:offset:${this.bot.id}`;
        const saved = this.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          key,
        );
        const currentSaved = saved ? Number(saved.value) : undefined;
        if (this.persistedOffset === undefined && currentSaved !== undefined) {
          this.persistedOffset = currentSaved;
        }
        const updates = await this.api.call(
          "getUpdates",
          {
            offset: this.persistedOffset ?? currentSaved,
            timeout: 25,
            limit: 100,
            allowed_updates: ["message", "callback_query"],
          },
          signal,
        );
        if (!Array.isArray(updates)) throw new Error("Invalid updates");
        this.lastPoll = Date.now();
        let newUpdatesCount = 0;
        for (const value of updates as TelegramUpdate[]) {
          if (!Number.isSafeInteger(value.update_id) || value.update_id < 0)
            throw new Error("Invalid update");
          const lane = updateLaneKey(value);
          const waiting = this.retries.get(value.update_id);
          if (waiting && Date.now() < waiting.after) continue;
          if (
            [...this.retries.values()].some(
              (item) => item.lane === lane && Date.now() < item.after,
            )
          )
            continue;
          if (
            this.inFlightUpdates.has(value.update_id) ||
            this.completedUpdates.has(value.update_id) ||
            (this.persistedOffset !== undefined &&
              value.update_id < this.persistedOffset)
          ) {
            continue;
          }
          newUpdatesCount++;
          this.unacknowledged.add(value.update_id);
          this.inFlightUpdates.add(value.update_id);
          const prev = this.lanes.get(lane) ?? Promise.resolve();
          const task = prev
            .catch(() => {})
            .then(async () => {
              let settle = true;
              try {
                await this.engine.receive(value, signal);
              } catch (error) {
                if (isRetryableError(error)) {
                  const attempts =
                    (this.retries.get(value.update_id)?.attempts ?? 0) + 1;
                  this.retries.set(value.update_id, {
                    lane,
                    attempts,
                    after:
                      Date.now() +
                      Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)),
                  });
                  settle = false;
                  console.error(
                    `Telegram update ${value.update_id} deferred because of a transient state; retrying without completing the message.`,
                  );
                } else {
                  const known =
                    error instanceof TelegramInputError ||
                    error instanceof CommandError ||
                    error instanceof SettingsError ||
                    (error instanceof ConversationError &&
                      !(error instanceof ConversationBusyError));
                  console.error(
                    known
                      ? "Telegram update rejected because of an identity conflict."
                      : `Telegram update ${value.update_id} failed; the topic continues.`,
                    known ? undefined : error,
                  );
                  const text =
                    error instanceof Error && error.message
                      ? error.message
                      : "I could not process this message. The topic continues.";
                  await this.replyToUpdate(value, text, signal);
                }
              } finally {
                this.inFlightUpdates.delete(value.update_id);
                if (!settle) return;
                this.retries.delete(value.update_id);
                this.completedUpdates.add(value.update_id);
                this.advanceOffset(key);
              }
            });
          this.lanes.set(lane, task);
          task.finally(() => {
            if (this.lanes.get(lane) === task) {
              this.lanes.delete(lane);
            }
          });
        }
        failures = 0;
        if (newUpdatesCount === 0) await delay(100, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (
          error instanceof TelegramApiError &&
          ["invalid_token", "conflict"].includes(error.kind)
        )
          throw error;
        console.error("Polling temporarily unavailable; offset kept.");
        await delay(
          Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
          undefined,
          { signal },
        );
      }
    }
  }
  async close() {
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    const draining = this.engine.drain();
    await this.work;
    await Promise.allSettled(Array.from(this.lanes.values()));
    await this.flushWork;
    await draining;
  }
}
