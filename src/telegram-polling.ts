import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
import { ConversationError, ConversationBusyError } from "./runtime.js";
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
  { command: "model", description: "Escolher provedor e modelo" },
  { command: "thinking", description: "Escolher esforço" },
  { command: "crons", description: "Criar e gerenciar agendamentos" },
  { command: "stop", description: "Interromper execução deste tópico" },
  { command: "status", description: "Modelo, MCPs, execução e versão" },
  { command: "reload", description: "Começar uma conversa nova" },
  { command: "retomar", description: "Retomar tarefa estacionada por quedas" },
  { command: "help", description: "Ajuda" },
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
    throw new Error("Identidade do bot inválida.");
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
      console.error("Polling interrompido; verifique configuração/conexão.");
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
          `setMyCommands falhou para chat ${chat}${language_code ? ` (${language_code})` : ""} (bot fora do chat ou ID errado em TELEGRAM_ALLOWED_CHATS). Polling continua.`,
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

  private async run() {
    const signal = this.controller.signal;
    const webhook = (await this.api.call("getWebhookInfo", {}, signal)) as {
      url?: string;
    };
    if (webhook.url)
      throw new Error(
        "Webhook existente; remova-o explicitamente antes de iniciar polling.",
      );
    for (const chat of this.config.chats)
      await this.registerCommands(chat, true, signal);
    // A running deployment picks up a changed menu from `/status`, not only at boot.
    this.engine.onReload = (chat) => this.registerCommands(chat);
    if (signal.aborted) return;
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
        if (!Array.isArray(updates)) throw new Error("Updates inválidos");
        this.lastPoll = Date.now();
        let newUpdatesCount = 0;
        for (const value of updates as TelegramUpdate[]) {
          if (!Number.isSafeInteger(value.update_id) || value.update_id < 0)
            throw new Error("Update inválido");
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
          const lane = updateLaneKey(value);
          const prev = this.lanes.get(lane) ?? Promise.resolve();
          const task = prev
            .catch(() => {})
            .then(async () => {
              try {
                await this.engine.receive(value, signal);
              } catch (error) {
                if (!(
                  error instanceof TelegramInputError ||
                  error instanceof CommandError ||
                  error instanceof SettingsError ||
                  (error instanceof ConversationError &&
                    !(error instanceof ConversationBusyError))
                ))
                  throw error;
                const message = value.message;
                if (
                  this.app.options.telegramOnly &&
                  message?.from &&
                  message.chat &&
                  typeof error.message === "string" &&
                  error.message
                ) {
                  const user = String(message.from.id);
                  const chat = String(message.chat.id);
                  if (
                    this.config.users.includes(user) &&
                    this.config.chats.includes(chat)
                  ) {
                    try {
                      await this.api.call(
                        "sendMessage",
                        {
                          chat_id: chat,
                          text: error.message,
                          ...(Number.isSafeInteger(message.message_thread_id) &&
                          message.message_thread_id! > 0
                            ? { message_thread_id: message.message_thread_id }
                            : {}),
                        },
                        signal,
                      );
                    } catch {
                      /* Best-effort; the update stays terminal. */
                    }
                  }
                }
                // Identity conflict is terminal for this update; never retry its effects.
                console.error(
                  "Update Telegram rejeitado por conflito de identidade.",
                );
              } finally {
                this.inFlightUpdates.delete(value.update_id);
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
        console.error(
          "Polling temporariamente indisponível; offset preservado.",
        );
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
