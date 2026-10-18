import {
  queueMcpApprovals,
  decideMcp,
  queueMcpChecks,
  verifyMcp,
} from "./telegram-approvals.js";
import { telegramIdentity } from "./telegram-identity.js";
import { readAppInfo } from "./app-info.js";
import {
  credentialBinding,
  observeTopic,
  syncTopicTitle,
  queueControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "./telegram-controls.js";
import {
  TelegramTyping,
  type TelegramTypingOptions,
} from "./telegram-typing.js";
import { logFailure } from "./log.js";
import {
  ConversationBusyError,
  ConversationError,
  type Runtime,
} from "./runtime.js";
import { resolveFunctions } from "./functions.js";
import { transcribeAudio } from "./transcribe.js";
import { describeImage } from "./vision.js";
import { hash, type Delivery } from "./store.js";
import { imageVerdict, type OutboundMedia } from "./outbound.js";
import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
import { TaskError } from "./tasks.js";
import {
  openCronMenu,
  handleCronMenu,
  acceptCronReply,
  cronReplyReceipt,
  assertCronDelivery,
} from "./telegram-crons.js";
import { openModelMenu, handleModelMenu } from "./telegram-models.js";
import { taskTelegramAuthorized } from "./task-telegram.js";
import { type TelegramOwner } from "./telegram-chats.js";
interface ControlRoute extends TelegramOwner {
  botId: number;
  credentialBinding: string;
}
type TopicTitleReceipt =
  | {
      route: ControlRoute;
      name: string;
      state: "pending" | "done" | "cancelled" | "uncertain";
    }
  | { state: "cancelled" };
function unavailableConversation(error: unknown) {
  // Settings/deletion inspections are temporary; storage failures must retry too.
  return (
    error instanceof CommandError ||
    (error instanceof ConversationError &&
      !(error instanceof ConversationBusyError))
  );
}
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    message_thread_id?: number;
    reply_to_message?: { message_id: number; from?: { id: number } };
    is_topic_message?: boolean;
    forum_topic_created?: { name: string; is_name_implicit?: boolean };
    forum_topic_edited?: { name?: string };
    forum_topic_closed?: object;
    forum_topic_reopened?: object;
    text?: string;
    caption?: string;
    voice?: {
      file_id: string;
      mime_type?: string;
      file_size?: number;
      duration?: number;
    };
    photo?: {
      file_id: string;
      width: number;
      height: number;
      file_size?: number;
    }[];
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    from?: { id: number; is_bot?: boolean; language_code?: string };
    chat: { id: number; type: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; is_bot?: boolean };
    data?: string;
    message?: {
      message_id: number;
      date?: number;
      from?: { id: number };
      chat: { id: number; type: string };
      message_thread_id?: number;
    };
  };
}
/** One image input part, in the shape pi-ai and pi-durable both accept. */
type TelegramImage = { type: "image"; data: string; mimeType: string };
type ImageRef = { fileId: string; mimeType: string; size?: number };

/**
 * Short marker plus the machine-readable origin. The text model reads this, so it can
 * tell a typed message from a transcription or an automated image description - a
 * transcription that arrived unlabelled was once answered with "no audio arrived".
 */
/** Short failure reason for the origin header; the raw provider text stays in the log. */
function describeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^vision \d{3}$/.test(message)
    ? `resposta ${message.slice(-3)}`
    : "falha ao descrever";
}
/** Same rule for transcription: a status code, never the provider body. */
function transcribeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const status = /(\d{3})$/.exec(message)?.[1];
  return status ? `resposta ${status}` : "falha na transcrição";
}
function originHeader(label: string, value: Record<string, unknown>) {
  return `[${label} · ${JSON.stringify(value)}]`;
}
type VoiceRef = { fileId: string; mimeType: string; size?: number };
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;
/** Telegram photos are JPEG up to 10 MB; the model does not need more than this. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Bytes one image may cost per turn. Telegram already re-encodes phone photos to a few
 * tens of KB, so this only matters for a dense screenshot sent as a 2 MB document. */
const MAX_IMAGE_TARGET_BYTES = 256 * 1024;
/** Voice notes are OGG/Opus and tiny; the cap keeps the base64 well under the 20 MB request limit. */
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
/** The voice note a message carries; Telegram sends OGG/Opus. */
function voiceOf(
  message: NonNullable<TelegramUpdate["message"]>,
): VoiceRef | undefined {
  const voice = message.voice;
  if (!voice?.file_id) return undefined;
  return {
    fileId: voice.file_id,
    mimeType: voice.mime_type ?? "audio/ogg",
    size: voice.file_size,
  };
}
function imageOf(
  message: NonNullable<TelegramUpdate["message"]>,
): ImageRef | undefined {
  // Telegram sends every size ascending and already re-encodes: the legible ones
  // (>=1024px wide) are the pool, and inside it the largest that stays within the byte
  // budget wins. Resolution beats bytes for text in screenshots, so a pool that is
  // entirely over budget keeps the biggest rather than the cheapest.
  const photos = message.photo ?? [];
  const legible = photos.filter((candidate) => candidate.width >= 1024);
  const pool = legible.length ? legible : photos;
  const photo =
    pool
      .filter(
        (candidate) =>
          (candidate.file_size ?? Number.POSITIVE_INFINITY) <=
          MAX_IMAGE_TARGET_BYTES,
      )
      .at(-1) ??
    pool.at(-1) ??
    photos.at(-1);
  if (photo?.file_id)
    return {
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      size: photo.file_size,
    };
  const document = message.document;
  if (
    document?.file_id &&
    document.mime_type &&
    IMAGE_MIME.test(document.mime_type)
  )
    return {
      fileId: document.file_id,
      mimeType: document.mime_type,
      size: document.file_size,
    };
  return undefined;
}
function hasAttachment(message: NonNullable<TelegramUpdate["message"]>) {
  const extra = message as Record<string, unknown>;
  return Boolean(
    message.photo ||
    message.document ||
    extra.voice ||
    extra.audio ||
    extra.video ||
    extra.animation ||
    extra.sticker,
  );
}
export interface TelegramTransport {
  /** Sends a file the turn produced: by URL when it has one, else by upload. */
  sendMedia?(
    chat: string,
    media: OutboundMedia,
    options?: { messageThreadId?: number },
  ): Promise<unknown>;
  /** Downloads a received file. A transport without it cannot take attachments. */
  downloadFile?(fileId: string): Promise<{ data: Uint8Array }>;
  settleTopicCreates?(): Promise<void>;
  editTopicName?(chat: string, thread: number, name: string): Promise<unknown>;
  answerCallback?(id: string, text: string): Promise<unknown>;
  editMessage?(
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ): Promise<unknown>;
  typing?(chat: string, options?: TelegramTypingOptions): Promise<unknown>;
  send(
    chat: string,
    text: string,
    options?: {
      parseMode?: "HTML";
      messageThreadId?: number;
      replyMarkup?: TelegramReplyMarkup;
      forceReply?: boolean;
    },
  ): Promise<unknown>;
}
export class TelegramInputError extends Error {}
export class TelegramHttp implements TelegramTransport {
  constructor(private token: string) {}
  async editMessage(
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/editMessageText`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          message_id: messageId,
          text,
          reply_markup: markup,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || result.ok !== true)
      throw new Error("Falha ao atualizar menu Telegram");
    return result;
  }
  async answerCallback(id: string, text: string) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: id, text }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || result.ok !== true)
      throw new Error("Falha ao responder controle Telegram");
    return result;
  }
  async typing(chat: string, options: TelegramTypingOptions = {}) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/sendChatAction`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            action: "typing",
            ...(options.messageThreadId === undefined
              ? {}
              : { message_thread_id: options.messageThreadId }),
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(2000),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error();
      return result;
    } catch {
      throw new Error("Falha no indicador Telegram");
    }
  }
  async send(
    chat: string,
    text: string,
    options?: {
      parseMode?: "HTML";
      messageThreadId?: number;
      replyMarkup?: TelegramReplyMarkup;
      forceReply?: boolean;
    },
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          ...(options?.forceReply
            ? { reply_markup: { force_reply: true, selective: true } }
            : {}),
          ...(options?.replyMarkup
            ? { reply_markup: options.replyMarkup }
            : {}),
          ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
          ...(options?.messageThreadId === undefined
            ? {}
            : { message_thread_id: options.messageThreadId }),
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || !result.ok)
      throw new Error("Falha na entrega Telegram");
    return result;
  }
}
/** Telegram answered and refused the message, so it was definitely not delivered. */
export class TelegramSendRefused extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    super(`Telegram recusou o envio (código ${code}).`);
  }
}
export class Telegram {
  private closing = false;
  private sendAfter = 0;
  private typing: TelegramTyping;
  private flushWork: Promise<void> | undefined;
  private receives = new Map<number, Promise<unknown>>();
  private approvalWork = new Set<Promise<unknown>>();
  /** Set by the polling layer: re-registers this chat's command menu. */
  onReload?: (chat: string) => Promise<void>;
  private credentialBinding: string;
  constructor(
    private app: Runtime,
    private transport: TelegramTransport,
    private users: string[],
    private chats: string[],
    readonly botUsername?: string,
    private privateDm = false,
    private botId?: number,
  ) {
    this.typing = new TelegramTyping(transport.typing?.bind(transport));
    const credential = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    );
    this.credentialBinding = hash(credential?.value ?? "");
    this.botUsername = botUsername?.trim().replace(/^@/, "") || undefined;
    if (this.botUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(this.botUsername))
      throw new Error("TELEGRAM_BOT_USERNAME deve ser o username do bot");
  }
  private commandText(raw: string) {
    const start = raw.trimStart();
    if (!start.startsWith("/") || start.startsWith("//")) return raw;
    const text = raw.trim();
    const addressed = /^\/[a-z]+@([a-z0-9_]+)(?=\s|$)/i.exec(text);
    if (!addressed) return this.newAlias(text);
    // Never execute a command intended for another bot or guess our identity.
    if (addressed[1].toLowerCase() !== this.botUsername?.toLowerCase())
      return undefined;
    return this.newAlias(text.replace(/^(\/[a-z]+)@[a-z0-9_]+/i, "$1"));
  }
  private newAlias(text: string) {
    if (this.app.options.telegramOnly) return text;
    const match = /^\/new(?:\s+([\s\S]*))?$/.exec(text);
    return match
      ? `/topics new${match[1]?.trim() ? ` ${match[1].trim()}` : ""}`
      : text;
  }
  private queueImplicitTopicTitle(
    update: TelegramUpdate,
    owner: TelegramOwner,
    eventBot: string,
  ) {
    if (this.app.options.telegramOnly) return;
    const created = update.message?.forum_topic_created;
    if (
      !this.transport.editTopicName ||
      owner.messageThreadId === undefined ||
      created?.is_name_implicit !== true ||
      typeof created.name !== "string" ||
      created.name.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(created.name) ||
      !/^\/new(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(created.name.trim())
    )
      return;
    const command = this.commandText(created.name);
    const match = /^\/topics new(?:\s+([\s\S]*))?$/.exec(command ?? "");
    if (!match) return;
    // Quotes and punctuation belong to the supplied name, not to this parser.
    const name = match[1]?.trim() || "Conversa Telegram";
    if (name.length > 100) return;
    const route = this.controlRoute(owner);
    if (!route) return;
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      `telegram:topic-title:${eventBot}:${update.update_id}`,
      JSON.stringify({
        route,
        name,
        state: "pending",
      } satisfies TopicTitleReceipt),
    );
  }
  private async editImplicitTopicTitle(updateId: number, eventBot: string) {
    const key = `telegram:topic-title:${eventBot}:${updateId}`;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (!saved || !this.transport.editTopicName) return;
    const receipt = JSON.parse(saved.value) as TopicTitleReceipt;
    if (receipt.state !== "pending") return;
    const save = (state: TopicTitleReceipt["state"]) =>
      this.app.store.run(
        "UPDATE meta SET value=? WHERE key=? AND value=?",
        JSON.stringify({ ...receipt, state }),
        key,
        state === "done"
          ? JSON.stringify({ ...receipt, state: "uncertain" })
          : saved.value,
      );
    const route = this.controlRoute(receipt.route);
    const topic = this.app.store.get<{
      closed: number | null;
      nameUpdateId: number;
      nameBotId: string;
    }>(
      "SELECT closed,nameUpdateId,nameBotId FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
      receipt.route.chat,
      receipt.route.user,
      receipt.route.messageThreadId!,
    );
    if (
      this.closing ||
      !route ||
      JSON.stringify(route) !== JSON.stringify(receipt.route) ||
      !topic ||
      topic.closed === 1 ||
      topic.nameUpdateId !== updateId ||
      topic.nameBotId !== eventBot
    ) {
      save("cancelled");
      return;
    }
    try {
      const selected = this.app.telegramChats.selection(receipt.route);
      if (selected) this.app.telegramChats.authorize(selected, receipt.route);
      else this.app.telegramChats.creationAuthority(receipt.route);
    } catch (error) {
      if (!unavailableConversation(error)) throw error;
      save("cancelled");
      return;
    }
    // Commit uncertainty before an external mutation. Replays never repeat a
    // possibly applied title edit over a later name chosen by the user.
    if (!save("uncertain").changes) return;
    let result: unknown;
    try {
      result = await this.transport.editTopicName(
        receipt.route.chat,
        receipt.route.messageThreadId!,
        receipt.name,
      );
    } catch {
      return;
    }
    if (result !== true) return;
    this.app.store.savepoint("telegram_topic_title_result", () => {
      // Permanent purge may scrub this receipt while the API call is in flight.
      if (!save("done").changes) return;
      this.app.store.run(
        "UPDATE telegram_known_topics SET name=? WHERE chat=? AND user=? AND messageThreadId=? AND nameUpdateId=? AND nameBotId=?",
        receipt.name,
        receipt.route.chat,
        receipt.route.user,
        receipt.route.messageThreadId!,
        updateId,
        eventBot,
      );
      syncTopicTitle(this.app, receipt.route);
    });
  }
  /** Control replies identify the configured private owner, never grant history access. */
  private controlRoute(owner: TelegramOwner): ControlRoute | undefined {
    if (
      (!this.privateDm && !this.app.options.telegramOnly) ||
      !this.botId ||
      !this.users.includes(owner.user) ||
      !this.chats.includes(owner.chat)
    )
      return;
    if (this.app.options.telegramOnly) {
      const identity = telegramIdentity(this.app.store, owner);
      if (
        !identity ||
        identity.botId !== this.botId ||
        identity.credentialBinding !== this.credentialBinding
      )
        return;
      return {
        ...owner,
        botId: identity.botId,
        credentialBinding: identity.credentialBinding,
      };
    }
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='telegram:connection'",
    );
    if (!saved) return;
    try {
      const config = JSON.parse(saved.value);
      if (
        config.enabled !== true ||
        config.bot?.id !== this.botId ||
        config.userId !== owner.user ||
        config.chatId !== owner.chat
      )
        return;
      const credential = this.app.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider='telegram:bot'",
      );
      if (!credential) return;
      const identity = JSON.parse(credential.value);
      if (
        identity.botId !== this.botId ||
        typeof identity.token !== "string" ||
        !identity.token.trim()
      )
        return;
      if (hash(credential?.value ?? "") !== this.credentialBinding) return;
      return {
        ...owner,
        botId: this.botId,
        credentialBinding: hash(credential?.value ?? ""),
      };
    } catch {
      return;
    }
  }
  private updateIdentity(update: TelegramUpdate) {
    const bot = String(
      this.botId ?? this.botUsername ?? this.credentialBinding,
    );
    const key = `telegram:update-identity:${bot}:${update.update_id}`;
    const fingerprint = hash(JSON.stringify(update));
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (saved && saved.value !== fingerprint)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    return { key, fingerprint, seen: !!saved };
  }
  private async receiveCallback(update: TelegramUpdate) {
    const query = update.callback_query!;
    const identity = this.updateIdentity(update);
    const updateKey = `telegram:callback-update:${update.update_id}`;
    const fingerprint = hash(JSON.stringify(update));
    const prior = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      updateKey,
    );
    if (prior && prior.value !== fingerprint)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    const message = query.message;
    const answer = async (text: string) => {
      try {
        await this.transport.answerCallback?.(query.id, text);
      } catch {
        /* expired callback acknowledgement does not repeat a control effect */
      }
    };
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      typeof query.id !== "string" ||
      !query.id ||
      !message ||
      !message.chat ||
      !Number.isSafeInteger(message.message_id) ||
      message.message_id <= 0 ||
      !query.from ||
      !Number.isSafeInteger(query.from.id) ||
      query.from.id <= 0 ||
      typeof query.data !== "string" ||
      message.date === 0 ||
      (message.message_thread_id !== undefined &&
        (!Number.isSafeInteger(message.message_thread_id) ||
          message.message_thread_id <= 0)) ||
      (!this.app.options.telegramOnly && message.chat.type !== "private") ||
      query.from.is_bot ||
      !/^pi:[a-f0-9]{32}$/.test(query.data ?? "")
    )
      return { ignored: true };
    const key = `telegram:button:${query.data}`;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      key,
    );
    if (!saved) {
      await answer(
        "Botão indisponível. Use /model, /thinking, /crons ou /status novamente.",
      );
      return { ignored: true };
    }
    const data = JSON.parse(saved.value) as TelegramButton;
    const origin = {
      chat: String(message.chat.id),
      user: String(query.from.id),
      ...(message.message_thread_id === undefined
        ? {}
        : { messageThreadId: message.message_thread_id }),
    };
    if (
      data.expiresAt <= Date.now() ||
      data.credentialBinding !== credentialBinding(this.app) ||
      origin.chat !== data.owner.chat ||
      origin.user !== data.owner.user ||
      (origin.messageThreadId ?? null) !== data.originThreadId ||
      !this.users.includes(origin.user) ||
      !this.chats.includes(origin.chat) ||
      (this.privateDm && !this.controlRoute(origin)) ||
      (this.botId && message.from?.id !== this.botId)
    ) {
      await answer("Botão expirado ou não autorizado.");
      return { ignored: true };
    }
    try {
      if (data.kind === "cron")
        this.app.telegramChats.creationAuthority(data.owner);
      else
        this.app.commands.authorize(data.conversationId, {
          source: "telegram",
          ...data.owner,
        });
      if (
        this.app.store.get(
          "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
          data.owner.chat,
          data.owner.user,
          data.owner.messageThreadId ?? null,
        )
      )
        throw new CommandError("Tópico fechado no estado observado.");
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        identity.key,
        identity.fingerprint,
      );
      if (data.used) {
        await answer(
          data.kind === "model"
            ? "Este controle já foi processado. Use /model novamente."
            : "Este controle já foi processado. Use /crons ou /status.",
        );
        return { processed: true };
      }
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        updateKey,
        fingerprint,
      );
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        identity.key,
        identity.fingerprint,
      );
      // Claim before awaiting creation; a lost response or restart never replays the mutation.
      this.app.store.run(
        "UPDATE meta SET value=? WHERE key=?",
        JSON.stringify({ ...data, used: true }),
        key,
      );
      if (data.kind === "mcp-check") {
        await verifyMcp(this.app, data, message.message_id);
        await answer("Verificação atualizada.");
      } else if (data.kind === "mcp") {
        const work = decideMcp(this.app, data, message.message_id);
        this.approvalWork.add(work);
        void work
          .catch(() =>
            queueControl(
              this.app,
              `telegram:mcp-error:${data.interactionId}`,
              data.owner,
              data.conversationId,
              "A decisão não foi concluída. Verifique /status e o serviço externo. A chamada não será repetida automaticamente.",
            ),
          )
          .finally(() => this.approvalWork.delete(work));
        await answer("Decisão recebida; acompanhe o resultado neste tópico.");
      } else if (data.kind === "cron") {
        await handleCronMenu(
          this.app,
          data,
          message.message_id,
          this.transport,
        );
        await answer("Menu de agendamentos atualizado.");
      } else if (data.kind === "model") {
        await handleModelMenu(
          this.app,
          data,
          message.message_id,
          this.transport,
          () => {
            if (
              this.closing ||
              data.credentialBinding !== credentialBinding(this.app) ||
              (this.privateDm && !this.controlRoute(origin))
            )
              throw new SettingsError(
                "Conexão Telegram mudou. Use /model novamente.",
              );
          },
        );
        await answer("Menu de modelo atualizado.");
      }
      return { control: true, conversationId: data.conversationId };
    } catch (error) {
      const text =
        error instanceof CommandError ||
        error instanceof SettingsError ||
        error instanceof TaskError ||
        error instanceof ConversationError
          ? error.message
          : data.kind === "cron"
            ? "Operação não concluída. Use /crons novamente; este controle não será repetido automaticamente."
            : data.kind === "model"
              ? "Seleção não concluída. Use /model novamente; este controle não será repetido automaticamente."
              : "Controle não concluído. Consulte /status; a chamada não será repetida automaticamente.";
      await answer(text);
      return { error: text, control: true };
    }
  }
  async receive(update: TelegramUpdate, signal?: AbortSignal) {
    if (this.closing || signal?.aborted) return { ignored: true };
    if (update.callback_query) return this.receiveCallback(update);
    const message = update.message;
    const eventBot = String(
      this.botId ?? this.botUsername ?? this.credentialBinding,
    );
    if (
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      !message?.from ||
      message.from.is_bot ||
      !message.chat
    )
      return { ignored: true };
    const user = String(message.from.id),
      chat = String(message.chat.id);
    const messageThreadId = message.message_thread_id;
    if (
      (messageThreadId !== undefined &&
        (!Number.isSafeInteger(messageThreadId) ||
          messageThreadId <= 0 ||
          (!this.app.options.telegramOnly &&
            message.chat.type !== "private"))) ||
      (message.is_topic_message && messageThreadId === undefined)
    )
      return { ignored: true };
    const owner: TelegramOwner = {
      chat,
      user,
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    };
    if (
      !this.users.includes(user) ||
      !this.chats.includes(chat) ||
      (this.privateDm && message.chat.type !== "private") ||
      (this.app.options.telegramOnly &&
        !["private", "group", "supergroup"].includes(message.chat.type))
    ) {
      if (
        this.app.options.telegramOnly &&
        typeof message.text === "string" &&
        message.text.trimStart().startsWith("/")
      )
        console.warn(
          `Comando Telegram ignorado (allowlist ou tipo de chat): user=${user} chat=${chat} type=${message.chat.type}. Ajuste TELEGRAM_ALLOWED_USERS/TELEGRAM_ALLOWED_CHATS ou use DM/supergrupo.`,
        );
      return { ignored: true };
    }
    if (this.privateDm && !this.controlRoute({ chat, user }))
      return { ignored: true };
    if (
      this.app.store.get(
        "SELECT 1 FROM telegram_purged_updates WHERE id=?",
        update.update_id,
      )
    )
      return { ignored: true };
    const identity = this.updateIdentity(update);
    const image = imageOf(message);
    const voice = voiceOf(message);
    if (
      !image &&
      !voice &&
      (typeof message.text !== "string" || !message.text)
    ) {
      if (message.forum_topic_created)
        await this.transport.settleTopicCreates?.();
      const service =
        message.forum_topic_created ||
        message.forum_topic_edited ||
        message.forum_topic_closed ||
        message.forum_topic_reopened;
      if (!service) {
        if (hasAttachment(message))
          this.app.store.queueTelegram(
            `telegram:clean:${update.update_id}`,
            chat,
            "Anexo recebido, mas por enquanto só leio imagens (foto ou JPEG/PNG/WebP/GIF) e recados de voz.",
            3500,
            undefined,
            messageThreadId,
          );
        return { ignored: true };
      }
      if (identity.seen) {
        if (
          !this.app.options.telegramOnly &&
          message.forum_topic_created &&
          messageThreadId !== undefined
        ) {
          try {
            await this.app.telegramChats.ensure(
              owner,
              undefined,
              message.forum_topic_created.name,
            );
          } catch (error) {
            if (!unavailableConversation(error)) throw error;
          }
        }
        await this.editImplicitTopicTitle(update.update_id, eventBot);
        return { observed: true };
      }
      if (
        this.app.store.get(
          "SELECT 1 FROM telegram_updates WHERE id=?",
          update.update_id,
        )
      )
        throw new TelegramInputError(
          "update_id já utilizado com conteúdo diferente",
        );
      try {
        this.app.telegramChats.creationAuthority(owner);
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        return { ignored: true };
      }
      this.app.store.savepoint("telegram_topic_observation", () => {
        observeTopic(
          this.app,
          owner,
          message,
          update.update_id,
          eventBot,
          message.date ?? 0,
        );
        this.queueImplicitTopicTitle(update, owner, eventBot);
        this.app.store.run(
          "INSERT INTO meta VALUES (?,?)",
          identity.key,
          identity.fingerprint,
        );
      });
      if (
        !this.app.options.telegramOnly &&
        message.forum_topic_created &&
        messageThreadId !== undefined
      ) {
        try {
          await this.app.telegramChats.ensure(
            owner,
            undefined,
            message.forum_topic_created.name,
          );
        } catch (error) {
          if (!unavailableConversation(error)) throw error;
        }
      }
      await this.editImplicitTopicTitle(update.update_id, eventBot);
      return { observed: true };
    }
    const command =
      image || voice ? undefined : this.commandText(message.text ?? "");
    const text = image
      ? message.caption?.trim() || "[imagem]"
      : voice
        ? "[áudio]"
        : command === "/crons"
          ? command
          : cronReplyReceipt(this.app, owner, message)
            ? message.text
            : command;
    if (text === undefined) return { ignored: true };
    const fingerprint = hash(
      JSON.stringify(
        messageThreadId === undefined
          ? [user, chat, message.text ?? text, image?.fileId]
          : [user, chat, message.text ?? text, image?.fileId, messageThreadId],
      ),
    );
    const previous = this.app.store.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM telegram_updates WHERE id=?",
      update.update_id,
    );
    const legacy =
      previous &&
      this.app.store.get<{
        fingerprint: string;
        replayFingerprint: string | null;
      }>(
        "SELECT fingerprint,replayFingerprint FROM telegram_legacy_updates WHERE id=?",
        update.update_id,
      );
    const legacyReplay =
      legacy &&
      legacy.fingerprint === hash(JSON.stringify([user, chat, message.text])) &&
      (legacy.replayFingerprint === null
        ? previous.fingerprint === legacy.fingerprint
        : legacy.replayFingerprint === fingerprint &&
          previous.fingerprint === fingerprint);
    if (previous && previous.fingerprint !== fingerprint && !legacyReplay)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    if (legacy && legacy.replayFingerprint !== null && !legacyReplay)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      identity.key,
      identity.fingerprint,
    );
    try {
      this.app.telegramChats.creationAuthority(owner);
      observeTopic(
        this.app,
        owner,
        message,
        update.update_id,
        eventBot,
        message.date ?? 0,
      );
    } catch (error) {
      if (!unavailableConversation(error)) throw error;
    }
    if (
      this.app.store.get(
        "SELECT 1 FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=? AND closed=1",
        chat,
        user,
        messageThreadId ?? null,
      )
    )
      return { ignored: true };
    if (legacyReplay) {
      const recovered =
        messageThreadId !== undefined &&
        this.recoverLegacy(update.update_id, text, { chat, user });
      this.app.store.savepoint("telegram_legacy_replay", () => {
        this.app.store.run(
          "UPDATE telegram_updates SET fingerprint=? WHERE id=?",
          fingerprint,
          update.update_id,
        );
        if (recovered)
          this.app.store.run(
            "UPDATE telegram_legacy_updates SET replayFingerprint=? WHERE id=?",
            fingerprint,
            update.update_id,
          );
        else
          this.app.store.run(
            "DELETE FROM telegram_legacy_updates WHERE id=?",
            update.update_id,
          );
      });
      // Acknowledge previous work without exposing the unthreaded result to a
      // topic, re-executing a command, or moving its history/outbox destination.
      if (recovered) return { recovered: true };
    }
    const linked = this.app.options.telegramOnly
      ? undefined
      : this.app.store.get<{ conversationId: string; user: string }>(
          "SELECT * FROM telegram WHERE chat=?",
          chat,
        );
    if (
      !this.app.options.telegramOnly &&
      !/^\/(link|start)(?:\s|$)/.test(text) &&
      (!linked || linked.user !== user) &&
      !this.controlRoute({ chat, user })
    )
      throw new TelegramInputError(
        "Conversa não vinculada a este usuário; use /link CODIGO pela web",
      );
    const inFlight = this.receives.get(update.update_id);
    if (inFlight) return inFlight;
    const tracked = {
      conversationId: undefined as string | undefined,
      accepting: true,
      normal: false,
    };
    const stopTyping = this.app.store.get(
      "SELECT 1 FROM meta WHERE key=?",
      `telegram:update:${update.update_id}`,
    )
      ? () => {}
      : this.typing.start(
          update.update_id,
          chat,
          () => {
            if (this.closing || signal?.aborted) return false;
            if (this.privateDm && !this.controlRoute({ chat, user }))
              return false;
            this.app.telegramChats.creationAuthority(owner);
            const selected = this.app.telegramChats.selected(owner);
            const id =
              tracked.conversationId ?? selected ?? linked?.conversationId;
            if (!id || (tracked.conversationId && selected && selected !== id))
              return false;
            if (
              messageThreadId !== undefined &&
              !tracked.conversationId &&
              !selected &&
              tracked.accepting
            ) {
              return true;
            }
            this.app.commands.authorize(id, { source: "telegram", ...owner });
            if (tracked.accepting) return true;
            return (
              tracked.normal &&
              this.app.store.get<{ status: string }>(
                "SELECT status FROM requests WHERE conversationId=? AND requestId=? AND source='telegram' AND chat=?",
                id,
                `telegram:${update.update_id}`,
                chat,
              )?.status === "pending"
            );
          },
          {
            signal,
            ...(Number.isSafeInteger(message.message_thread_id) &&
            message.message_thread_id! > 0
              ? { messageThreadId: message.message_thread_id }
              : {}),
          },
        );
    const operation = this.accept(
      update,
      user,
      chat,
      fingerprint,
      text,
      messageThreadId,
      image,
      voice,
    ).then(
      (response) => {
        tracked.accepting = false;
        tracked.normal =
          !!response &&
          typeof response === "object" &&
          "kind" in response &&
          response.kind === "message";
        if (!tracked.normal) stopTyping();
        else this.typing.check();
        return response;
      },
      (error) => {
        stopTyping();
        throw error;
      },
    );
    this.receives.set(update.update_id, operation);
    void operation
      .finally(() => this.receives.delete(update.update_id))
      .catch(() => {});
    return operation;
  }
  private recoverLegacy(updateId: number, text: string, owner: TelegramOwner) {
    const store = this.app.store;
    const authorize = (id: string) => {
      this.app.telegramChats.creationAuthority(owner);
      this.app.commands.authorize(id, { source: "telegram", ...owner });
    };
    const existing = store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:update:${updateId}`,
    );
    if (existing) {
      const value = JSON.parse(existing.value) as {
        conversationId?: string;
        linked?: string;
      };
      const id = value.conversationId ?? value.linked;
      if (id) authorize(id);
      return true;
    }
    const requestId = `telegram:${updateId}`;
    const request = store.get<{ conversationId: string; text: string }>(
      "SELECT conversationId,text FROM requests WHERE requestId=? AND source='telegram' AND chat=?",
      requestId,
      owner.chat,
    );
    if (request) {
      const escaped = text.trimStart().startsWith("//")
        ? text.replace("/", "")
        : text;
      if (request.text !== escaped)
        throw new TelegramInputError(
          "update_id já utilizado com conteúdo diferente",
        );
      authorize(request.conversationId);
      // Runtime.open reattaches/submits durable requests using their original
      // owner and native requestId; the update must not admit a topic copy.
      return true;
    }
    const decision = /^\/(approve|deny)\s+([a-f0-9]{24})$/.exec(text);
    const action =
      decision &&
      store.get<{ conversationId: string }>(
        "SELECT conversationId FROM actions WHERE id=? AND state!='pending'",
        decision[2],
      );
    if (action) {
      authorize(action.conversationId);
      return true;
    }
    return false;
  }
  private async accept(
    update: TelegramUpdate,
    user: string,
    chat: string,
    fingerprint: string,
    text: string,
    messageThreadId?: number,
    image?: ImageRef,
    voice?: VoiceRef,
  ) {
    const owner: TelegramOwner = {
      chat,
      user,
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    };
    // Re-delivered commands reuse the update key; never consume a link or approve twice.
    const commandKey = `telegram:update:${update.update_id}`;
    const existing = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      commandKey,
    );
    if (existing) {
      const value = JSON.parse(existing.value) as {
        conversationId?: string;
        linked?: string;
      };
      const conversationId = value.conversationId ?? value.linked;
      if (conversationId && text === "/crons")
        this.app.telegramChats.assertCreationAuthority(conversationId, owner);
      else if (conversationId)
        this.app.commands.authorize(conversationId, {
          source: "telegram",
          chat,
          user,
          messageThreadId,
        });
      this.app.store.run(
        "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
        update.update_id,
        fingerprint,
      );
      return value;
    }
    this.app.store.run(
      "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
      update.update_id,
      fingerprint,
    );
    if (
      text !== "/crons" &&
      acceptCronReply(this.app, owner, update.message!, update.update_id)
    ) {
      const result = { control: true, command: "crons" };
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        commandKey,
        JSON.stringify(result),
      );
      return result;
    }
    // Telegram-only build: every text goes straight to the clean command surface.
    const result = await this.acceptClean(
      owner,
      text,
      update.update_id,
      image,
      voice,
    );
    this.app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      commandKey,
      JSON.stringify(result),
    );
    return result;
  }
  private async acceptClean(
    owner: TelegramOwner,
    text: string,
    updateId: number,
    image?: ImageRef,
    voice?: VoiceRef,
  ) {
    let id: string;
    try {
      id = await this.app.telegramChats.ensure(owner);
    } catch (error) {
      if (error instanceof CommandError) {
        this.app.store.queueTelegram(
          `telegram:clean:${updateId}`,
          owner.chat,
          error.message,
          3500,
          undefined,
          owner.messageThreadId,
        );
        return { control: true, error: error.message };
      }
      throw error;
    }
    const reply = (message: string) =>
      queueControl(this.app, `telegram:clean:${updateId}`, owner, id, message);
    try {
      if (text === "/model" || text === "/thinking") {
        await openModelMenu(
          this.app,
          owner,
          id,
          updateId,
          text === "/thinking",
        );
      } else if (text === "/crons") openCronMenu(this.app, owner, id, updateId);
      else if (text === "/status") {
        // Both are set once per deployment, so this is the only way to pick up a
        // new MCP catalog or a changed command menu without a restart.
        await this.app.refreshMcpTools();
        await this.onReload?.(owner.chat);
        const settings = await this.app.settings.conversation(id);
        const active = await this.app.commands.active({
          source: "telegram",
          ...owner,
        });
        const info = readAppInfo();
        const mcps =
          this.app.mcpStatus
            .map(
              (s) => `${s.server}: ${s.error ? "indisponível" : "conectado"}`,
            )
            .join("\n") || "Nenhum";
        const calls =
          this.app.mcpCalls
            ?.list(id)
            .filter((c) =>
              ["paused", "running", "uncertain", "abandoned"].includes(c.state),
            ) ?? [];
        const pending =
          this.app.mcpCalls
            ?.interactions(id)
            .filter((i) => i.state === "pending").length ?? 0;
        const ledger =
          calls.map((c) => `${c.server} / ${c.tool}: ${c.state}`).join("\n") ||
          "Nenhuma chamada pendente/incerta";
        const functions = resolveFunctions(
          process.env,
          this.app.settings.setup(),
          this.app.settings.setupKeys(),
        );
        reply(
          `Modelos:\nTexto: ${settings.modelId}\nVisão: ${this.featureLabel(functions.vision, this.mainSeesImages() ? "mesmo do chat" : "desativado")}\nÁudio: ${this.featureLabel(functions.audio, "desativado")}\nEsforço: ${settings.effort}\nExecuções neste tópico: ${active.length}\nAprovações pendentes: ${pending}\nRegistro MCP:\n${ledger}\nSe houver resultado incerto, verifique o serviço externo; a chamada não será repetida. /stop encerra esperas locais; efeitos externos exigem verificação.\nMCPs:\n${mcps}\nVersão: ${info.version ?? "dev"} (${info.commit ?? "sem SHA"})\nCompactação automática: modelo e esforço ativos desta conversa.`,
        );
        queueMcpChecks(this.app, owner, id, updateId);
      } else if (text === "/reload") {
        // A conversation that cannot answer (a bad image in history, a broken
        // compaction) must be recoverable without a new topic.
        this.app.telegramChats.reload(owner);
        reply(
          "Conversa reiniciada. A próxima mensagem abre uma conversa nova; o histórico anterior continua salvo, mas não é mais enviado ao modelo.",
        );
      } else if (text === "/help" || text === "/start")
        reply(
          "/model — provedor e modelo\n/thinking — esforço\n/crons — criar e gerenciar agendamentos\n/stop — interromper este tópico\n/status — estado\n/reload — começar uma conversa nova\n/help — ajuda\nCada tópico nativo tem histórico próprio. Crie tópicos no Telegram. Escolhas de modelo persistem após reinício. Compactação automática usa o modelo e esforço ativos.",
        );
      else if (
        text.startsWith("/") &&
        !text.startsWith("//") &&
        !/^\/(stop|thinking|model)(?:\s|$)/.test(text)
      )
        reply("Comando desconhecido. Use /help.");
      else {
        if (text === "/stop") this.app.mcpCalls?.cancelConversation(id);
        const notice = this.app.settings.pendingModelNotice(id);
        if (notice) {
          this.app.settings.markModelNoticeShown(id);
          reply(notice);
        }
        const picture = image ? await this.pictureTurn(image, text) : undefined;
        const spoken = voice ? await this.transcribeVoice(voice) : undefined;
        // Typed text keeps no prefix; a specialist's output carries its origin.
        await this.app.admit(
          id,
          `telegram:${updateId}`,
          spoken?.text ?? picture?.text ?? text,
          { source: "telegram", ...owner },
          picture?.images,
        );
      }
    } catch (error) {
      if (error instanceof SettingsError || error instanceof CommandError)
        reply(error.message);
      else throw error;
    }
    return { conversationId: id, control: text.startsWith("/") };
  }
  /** One line for `/status`: the model, its host when it is not the chat one, or off. */
  /**
   * One line for `/status`. `whenMissing` is what absence means: the chat model can
   * stand in for vision, but never for audio - pi-ai has no audio content part.
   */
  private featureLabel(
    feature: { modelId: string; language?: string } | undefined,
    whenMissing: string,
  ) {
    if (!feature) return whenMissing;
    return feature.language
      ? `${feature.modelId} (${feature.language})`
      : feature.modelId;
  }
  /** Id of the chat model serving this turn, for the origin header. */
  private chatModelId() {
    const choice = this.app.settings.defaults();
    return `${choice.provider}/${choice.modelId}`;
  }
  /** Whether the chat model reads images; LLM_INPUT=text is how a text-only model says so. */
  private mainSeesImages() {
    // The wizard probed the model itself; that beats the declared catalog input, which
    // defaults to "text,image" for everyone.
    const probed = this.app.settings.setup()?.chatVision;
    if (probed !== undefined) return probed;
    const choice = this.app.settings.defaults();
    const model = this.app.models.getModel(choice.provider, choice.modelId);
    return Boolean(model?.input?.includes("image"));
  }
  /**
   * Routes one image: a native part when the chat model reads it, a separate vision
   * model's description when it does not, and a clear refusal when neither exists.
   */
  private async pictureTurn(
    image: ImageRef,
    caption: string,
  ): Promise<{ images?: TelegramImage[]; text: string }> {
    const { vision, imageMode } = resolveFunctions(
      process.env,
      this.app.settings.setup(),
      this.app.settings.setupKeys(),
    );
    const native =
      imageMode === "native" || (imageMode === "auto" && this.mainSeesImages());
    if (native) {
      const loaded = await this.loadImage(image);
      if (Array.isArray(loaded))
        return {
          images: loaded,
          text: `${originHeader("imagem", { origin: "image", model: this.chatModelId() })}\n${caption}`,
        };
      return {
        text: `${originHeader("imagem", { origin: "image", error: loaded.error })}\n${caption}`,
      };
    }
    if (vision) {
      const loaded = await this.loadImage(image);
      if (!Array.isArray(loaded))
        return {
          text: `${originHeader("imagem", { origin: "image", error: loaded.error })}\n${caption}`,
        };
      try {
        const description = await describeImage(vision, loaded[0]);
        return {
          text: `${originHeader("imagem: descrição automática", { origin: "image", model: vision.modelId })}\n${caption}\n${description}`,
        };
      } catch (error) {
        return {
          text: `${originHeader("imagem", { origin: "image", error: describeFailure(error) })}\n${caption}`,
        };
      }
    }
    return {
      text: `${originHeader("imagem", { origin: "image", error: "nenhum modelo lê imagens (defina VISION_MODEL)" })}\n${caption}`,
    };
  }

  /**
   * Transcribes a voice note. The transcription becomes the turn text, prefixed with the
   * origin so the chat model knows the message arrived as audio. A failure is admitted
   * too: the model tells the user instead of the message disappearing.
   */
  private async transcribeVoice(voice: VoiceRef): Promise<{ text: string }> {
    const { audio } = resolveFunctions(
      process.env,
      this.app.settings.setup(),
      this.app.settings.setupKeys(),
    );
    if (!audio)
      return {
        text: originHeader("áudio", {
          origin: "audio",
          error: "nenhum modelo transcreve (defina AUDIO_MODEL)",
        }),
      };
    if ((voice.size ?? 0) > MAX_VOICE_BYTES)
      return {
        text: originHeader("áudio", {
          origin: "audio",
          error: "áudio acima do limite de 10 MB",
        }),
      };
    if (!this.transport.downloadFile)
      return {
        text: originHeader("áudio", {
          origin: "audio",
          error: "este ambiente não consegue baixar anexos",
        }),
      };
    try {
      const { data } = await this.transport.downloadFile(voice.fileId);
      if (data.byteLength > MAX_VOICE_BYTES)
        return {
          text: originHeader("áudio", {
            origin: "audio",
            error: "áudio acima do limite de 10 MB",
          }),
        };
      const transcription = await transcribeAudio(audio, {
        data,
        mimeType: voice.mimeType,
      });
      // Verbatim: the specialist's words reach the model unchanged.
      return {
        text: `${originHeader("áudio transcrito", { origin: "audio", model: audio.modelId })}\n${transcription}`,
      };
    } catch (error) {
      return {
        text: originHeader("áudio", {
          origin: "audio",
          error: transcribeFailure(error),
        }),
      };
    }
  }
  /** Downloads one image into a model input part; on failure replies and returns undefined. */
  private async loadImage(
    image: ImageRef,
  ): Promise<TelegramImage[] | { error: string }> {
    if ((image.size ?? 0) > MAX_IMAGE_BYTES)
      return { error: "imagem acima do limite de 5 MB" };
    if (!this.transport.downloadFile)
      return { error: "este ambiente não consegue baixar anexos" };
    try {
      const { data } = await this.transport.downloadFile(image.fileId);
      if (data.byteLength > MAX_IMAGE_BYTES)
        return { error: "imagem acima do limite de 5 MB" };
      const base64 = Buffer.from(data).toString("base64");
      // A provider refuses an unusable image and the part then fails every later turn;
      // the chat hears why instead of the conversation getting poisoned.
      const verdict = imageVerdict(base64, image.mimeType);
      if (!verdict.ok)
        return { error: `imagem não utilizável: ${verdict.reason}` };
      return [{ type: "image", data: base64, mimeType: image.mimeType }];
    } catch {
      return { error: "falha ao baixar a imagem" };
    }
  }
  /** Sends the files a delivery carries; each failure is recorded, none is thrown. */
  private async sendMedia(delivery: Delivery) {
    const media = delivery.media
      ? (JSON.parse(delivery.media) as OutboundMedia[])
      : [];
    if (!media.length) return undefined;
    const results: unknown[] = [];
    for (const item of media) {
      if (!this.transport.sendMedia) {
        results.push({ error: "transporte sem envio de arquivo" });
        continue;
      }
      try {
        results.push(
          await this.transport.sendMedia(delivery.chat, item, {
            ...(delivery.messageThreadId == null
              ? {}
              : { messageThreadId: delivery.messageThreadId }),
          }),
        );
      } catch (error) {
        results.push({
          error: error instanceof Error ? error.message : "falha no envio",
        });
      }
    }
    return results;
  }
  flush() {
    if (this.closing) return Promise.resolve();
    if (this.flushWork) return this.flushWork;
    this.flushWork = this.sendPending().finally(() => {
      this.flushWork = undefined;
    });
    return this.flushWork;
  }
  async drain() {
    this.closing = true;
    this.typing.close();
    await Promise.allSettled([...this.receives.values(), ...this.approvalWork]);
    await this.flushWork;
  }
  setDmChat(chat: string) {
    if (this.privateDm) {
      if (!this.chats.includes(chat)) this.typing.close();
      this.chats = [chat];
    }
  }
  private async sendPending() {
    this.typing.check();
    queueMcpApprovals(this.app);
    if (Date.now() < this.sendAfter) return;
    for (const delivery of this.app.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE state='pending' ORDER BY rowid",
    )) {
      if (this.closing) break;
      const control = this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:control-route:${delivery.id}`,
      );
      let authorizedControl = false;
      if (control) {
        try {
          const route = JSON.parse(control.value) as ControlRoute;
          const current = this.controlRoute(route);
          authorizedControl =
            !!current &&
            current.chat === delivery.chat &&
            (current.messageThreadId ?? null) === delivery.messageThreadId &&
            JSON.stringify(current) === JSON.stringify(route);
        } catch {
          /* Malformed control receipts never authorize a send. */
        }
      }
      // Revoked owned receipts are terminal even when this engine now serves
      // another chat. Unowned legacy rows outside its allowlist stay untouched.
      if (
        control
          ? !authorizedControl
          : !taskTelegramAuthorized(
              this.app.store,
              delivery.id,
              this.users,
              this.chats,
              this.botId,
            )
      ) {
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Vínculo Telegram revogado antes do envio.",
          delivery.id,
        );
        continue;
      }
      if (this.privateDm && !this.chats.includes(delivery.chat)) continue;
      if (
        this.privateDm &&
        !this.users.some((user) =>
          this.controlRoute({ chat: delivery.chat, user }),
        )
      ) {
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Conexão Telegram revogada antes do envio.",
          delivery.id,
        );
        continue;
      }
      if (!control) {
        const owner = this.app.store.get<{ conversationId: string }>(
          `SELECT conversationId FROM delivery_conversations WHERE deliveryId=?
           UNION SELECT n.conversationId FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE p.deliveryId=? LIMIT 1`,
          delivery.id,
          delivery.id,
        );
        try {
          if (owner) this.app.assertConversationAvailable(owner.conversationId);
          else if (this.privateDm) {
            const user = this.users.find((user) =>
              this.controlRoute({ chat: delivery.chat, user }),
            );
            if (!user)
              throw new CommandError("Conexão Telegram não autorizada.");
            // Only an unowned legacy row still depends on the legacy binding.
            this.app.telegramChats.binding({ chat: delivery.chat, user });
          }
        } catch (error) {
          if (error instanceof ConversationBusyError) continue;
          if (!unavailableConversation(error)) throw error;
          this.app.store.run(
            "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
            "Conversa Telegram indisponível antes do envio.",
            delivery.id,
          );
          continue;
        }
      }
      try {
        assertCronDelivery(this.app, delivery.id);
      } catch (error) {
        if (!(error instanceof TaskError) && !unavailableConversation(error))
          throw error;
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result='Autorização ou menu de crons mudou antes do envio.' WHERE id=? AND state='pending'",
          delivery.id,
        );
        continue;
      }
      const approvalPrefix =
        /^(telegram:(?:mcp|cron-new-preview|cron-preview):[^:]+):[0-9]+$/.exec(
          delivery.id,
        )?.[1];
      if (
        approvalPrefix &&
        this.app.store.get(
          "SELECT 1 FROM deliveries WHERE id>=? AND id<? AND rowid<(SELECT rowid FROM deliveries WHERE id=?) AND state!='sent'",
          `${approvalPrefix}:`,
          `${approvalPrefix};`,
          delivery.id,
        )
      )
        continue;
      const changed = this.app.store.run(
        "UPDATE deliveries SET state='sending' WHERE id=? AND state='pending'",
        delivery.id,
      ).changes;
      if (!changed) continue;
      try {
        const savedMarkup = this.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          `telegram:markup:${delivery.id}`,
        );
        const replyMarkup = savedMarkup
          ? (JSON.parse(savedMarkup.value) as TelegramReplyMarkup)
          : undefined;
        const forceReply = !!this.app.store.get(
          "SELECT 1 FROM meta WHERE key=?",
          `telegram:force-reply:${delivery.id}`,
        );
        let result: unknown;
        // A reply may carry only a file; empty text is not sent at all.
        if (delivery.text)
          result = await this.transport.send(
            delivery.chat,
            this.app.options.redact?.(delivery.text) ?? delivery.text,
            delivery.messageThreadId == null &&
              delivery.parseMode !== "HTML" &&
              !replyMarkup &&
              !forceReply
              ? undefined
              : {
                  ...(replyMarkup ? { replyMarkup } : {}),
                  ...(forceReply ? { forceReply } : {}),
                  ...(delivery.parseMode === "HTML"
                    ? { parseMode: "HTML" as const }
                    : {}),
                  ...(delivery.messageThreadId == null
                    ? {}
                    : { messageThreadId: delivery.messageThreadId }),
                },
          );
        // The text is already delivered: a failed upload is recorded, never fatal.
        const media = await this.sendMedia(delivery);
        this.app.store.run(
          "UPDATE deliveries SET state='sent',result=? WHERE id=?",
          media
            ? JSON.stringify({ sent: result, media })
            : JSON.stringify(result),
          delivery.id,
        );
      } catch (error) {
        if (error instanceof TelegramSendRefused && error.code === 429) {
          // Later parts would hit the same limit; keep order and wait.
          this.app.store.run(
            "UPDATE deliveries SET state='pending' WHERE id=? AND state='sending'",
            delivery.id,
          );
          this.sendAfter = Date.now() + Math.max(1, error.retryAfter) * 1000;
          break;
        }
        const failed =
          error instanceof TelegramSendRefused ? "failed" : "uncertain";
        const detail =
          error instanceof TelegramSendRefused
            ? `${error.message} Não foi entregue nem será reenviada.`
            : "Verifique no Telegram. Não reenviado automaticamente.";
        this.app.store.run(
          "UPDATE deliveries SET state=?,result=? WHERE id=?",
          failed,
          detail,
          delivery.id,
        );
        if (delivery.id.startsWith("telegram:mcp:"))
          logFailure(`Falha ao enviar cartão MCP (${delivery.id})`, error);
      }
    }
  }
}
