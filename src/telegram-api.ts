import { mediaTarget, type OutboundMedia } from "./outbound.js";

type Method =
  | "getMe"
  | "getWebhookInfo"
  | "getUpdates"
  | "sendMessage"
  | "sendChatAction"
  | "getMyCommands"
  | "setMyCommands"
  | "answerCallbackQuery"
  | "editMessageText"
  | "getFile";
interface TelegramFile {
  data: Uint8Array;
}
export interface TelegramApi {
  /** Sends a file: by URL when it has one, by multipart upload otherwise. */
  sendMedia?(
    chat: string,
    media: OutboundMedia,
    options?: { messageThreadId?: number },
  ): Promise<unknown>;
  call(
    method: Method,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Downloads a file the bot received. Optional so test fakes stay small. */
  downloadFile?(fileId: string, signal?: AbortSignal): Promise<TelegramFile>;
}
export class TelegramApiError extends Error {
  constructor(
    readonly kind: "invalid_token" | "conflict" | "rate_limit" | "unavailable",
    readonly retryAfter = 0,
    /** Set only when Telegram itself answered with a 4xx refusal. */
    readonly refusedCode?: number,
  ) {
    super(
      {
        invalid_token: "Token Telegram inválido. Atualize a conexão.",
        conflict:
          "Outro processo ou webhook está recebendo atualizações deste bot. Desconecte-o antes de continuar.",
        rate_limit:
          "Limite do Telegram atingido. A conexão será retomada após a espera.",
        unavailable: "Telegram indisponível. A conexão será tentada novamente.",
      }[kind],
    );
  }
}
export class TelegramBotApi implements TelegramApi {
  constructor(
    private token: string,
    private maxDownload = 20 * 1024 * 1024,
  ) {}
  /**
   * Downloads a received file. The file URL carries the bot token, so every
   * failure is normalized to a generic error: no description ever escapes.
   */
  async downloadFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<TelegramFile> {
    const file = (await this.call("getFile", { file_id: fileId }, signal)) as {
      file_path?: string;
      file_size?: number;
    };
    if (!file?.file_path || (file.file_size ?? 0) > this.maxDownload)
      throw new TelegramApiError("unavailable");
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        {
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(30000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new TelegramApiError("unavailable");
    }
    if (!response.ok) throw new TelegramApiError("unavailable");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > this.maxDownload)
      throw new TelegramApiError("unavailable");
    return { data };
  }
  /**
   * Sends a file the turn produced. A URL is handed to Telegram, which fetches it; bytes
   * are uploaded as multipart. The method comes from the kind: audio, voice, photo or
   * document.
   */
  /** One place for Telegram's error codes, shared by JSON and multipart calls. */
  private unwrap(body: unknown, status: number) {
    const data = (body ?? {}) as {
      ok?: boolean;
      result?: unknown;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    const code = data.error_code ?? status;
    if (data.ok !== true) {
      const refused =
        data.ok === false && code >= 400 && code < 500 ? code : undefined;
      if (code === 401 || code === 404)
        throw new TelegramApiError("invalid_token", 0, refused);
      if (code === 409) throw new TelegramApiError("conflict", 0, refused);
      if (code === 429)
        throw new TelegramApiError(
          "rate_limit",
          Number(data.parameters?.retry_after) || 1,
          refused,
        );
      throw new TelegramApiError("unavailable", 0, refused);
    }
    return data.result;
  }

  async sendMedia(
    chat: string,
    media: OutboundMedia,
    options: { messageThreadId?: number } = {},
  ) {
    const { method, field } = mediaTarget(media);
    const payload: Record<string, unknown> = {
      chat_id: chat,
      ...(options.messageThreadId == null
        ? {}
        : { message_thread_id: options.messageThreadId }),
    };
    if (media.url)
      return this.call(method as Method, { ...payload, [field]: media.url });
    if (!media.data) throw new TelegramApiError("unavailable");
    const form = new FormData();
    for (const [name, value] of Object.entries(payload))
      form.set(name, String(value));
    form.set(
      field,
      new Blob([new Uint8Array(Buffer.from(media.data, "base64"))], {
        type: media.mimeType ?? "application/octet-stream",
      }),
      media.filename ?? `anexo.${mediaTarget(media).ext}`,
    );
    return this.callForm(method as Method, form);
  }
  /** Multipart variant of `call`: same error normalization, no credential in messages. */
  private async callForm(method: Method, form: FormData, signal?: AbortSignal) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          redirect: "error",
          body: form,
          signal: AbortSignal.any([
            AbortSignal.timeout(60000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      return this.unwrap(await response.json(), response.status);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError("unavailable");
    }
  }
  async call(
    method: Method,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([
            AbortSignal.timeout(method === "getUpdates" ? 35000 : 15000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      return this.unwrap(await response.json(), response.status);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Raw fetch failures and Telegram descriptions may contain the credential URL.
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError("unavailable");
    }
  }
}
