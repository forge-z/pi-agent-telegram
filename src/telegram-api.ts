type Method =
  | "getMe"
  | "getWebhookInfo"
  | "getUpdates"
  | "sendMessage"
  | "sendChatAction"
  | "getMyCommands"
  | "setMyCommands"
  | "answerCallbackQuery"
  | "editMessageText";
export interface TelegramApi {
  call(
    method: Method,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  constructor(private token: string) {}
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
      const data = (await response.json()) as {
        ok?: boolean;
        result?: unknown;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      const code = data.error_code ?? response.status;
      if (!response.ok || data.ok !== true) {
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
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Raw fetch failures and Telegram descriptions may contain the credential URL.
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError("unavailable");
    }
  }
}
