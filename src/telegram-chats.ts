import type { Runtime } from "./runtime.js";
import { CommandError } from "./commands.js";
import { telegramIdentity } from "./telegram-identity.js";
import { installTopicReceiptInvalidation } from "./telegram-topics.js";

export interface TelegramOwner {
  chat: string;
  user: string;
  messageThreadId?: number;
}
/** A dedicated selection is independent of the legacy web/cron binding. */
export class TelegramChats {
  private creating = new Map<string, Promise<string>>();
  constructor(private app: Runtime) {
    installTopicReceiptInvalidation(app.store);
  }
  binding(owner: TelegramOwner) {
    const row = this.app.store.get<{ conversationId: string }>(
      `SELECT t.conversationId FROM telegram t JOIN telegram_grants g
       ON g.chat=t.chat AND g.user=t.user AND g.conversationId=t.conversationId
       WHERE t.chat=? AND t.user=?`,
      owner.chat,
      owner.user,
    );
    if (!row)
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    if (
      this.dedicated(row.conversationId) &&
      !this.owns(row.conversationId, owner)
    )
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    this.app.assertConversationAvailable(row.conversationId);
    return row.conversationId;
  }
  /** The configured owner proves identity; a conversation grant proves history access. */
  configuredOwner(owner?: TelegramOwner) {
    return telegramIdentity(this.app.store, owner);
  }
  connection(owner: TelegramOwner) {
    const configured = this.app.store.get(
      "SELECT 1 FROM meta WHERE key='telegram:connection'",
    );
    if (!configured) {
      if (this.app.options.telegramOnly)
        throw new CommandError(
          "Configuração Telegram incompleta no volume (metadados ausentes). Reinicie o serviço; se persistir, confira TELEGRAM_ALLOWED_USERS e TELEGRAM_ALLOWED_CHATS.",
        );
      this.binding(owner);
      return;
    }
    const route = this.configuredOwner(owner);
    if (!route || route.chat !== owner.chat || route.user !== owner.user)
      throw new CommandError(
        this.app.options.telegramOnly
          ? "Conexão Telegram não autorizada. Confira TELEGRAM_ALLOWED_USERS e TELEGRAM_ALLOWED_CHATS (IDs do seu usuário e do chat) e reinicie o serviço."
          : "Conexão Telegram não autorizada. Vincule novamente pela web.",
      );
  }
  assertCreationAuthority(id: string, owner: TelegramOwner) {
    this.connection(owner);
    if (!id && this.app.options.telegramOnly) return;
    if (
      !this.app.store.get(
        "SELECT 1 FROM telegram_grants g JOIN conversations c ON c.id=g.conversationId WHERE g.chat=? AND g.user=? AND g.conversationId=?",
        owner.chat,
        owner.user,
        id,
      )
    )
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    this.app.assertConversationAvailable(id);
  }
  creationAuthority(owner: TelegramOwner) {
    this.connection(owner);
    if (this.app.options.telegramOnly) {
      const id = this.selection(owner);
      if (id) this.authorize(id, owner);
      return id ?? "";
    }
    if (
      !this.app.store.get("SELECT 1 FROM meta WHERE key='telegram:connection'")
    )
      return this.binding(owner);
    const selected = this.selection(owner);
    const rows = this.app.store.all<{ id: string }>(
      `SELECT c.id FROM conversations c JOIN telegram_grants g ON g.conversationId=c.id
       WHERE g.chat=? AND g.user=? AND c.id NOT IN
       (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL)
       ORDER BY CASE WHEN c.id=? THEN 0 WHEN c.id IN
       (SELECT conversationId FROM telegram_conversations WHERE chat=? AND user=?) THEN 1 ELSE 2 END, c.rowid DESC`,
      owner.chat,
      owner.user,
      selected ?? null,
      owner.chat,
      owner.user,
    );
    if (!rows.length)
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    this.assertCreationAuthority(rows[0].id, owner);
    return rows[0].id;
  }
  owns(id: string, owner: TelegramOwner) {
    return !!this.app.store.get(
      `SELECT 1 FROM telegram_conversations d JOIN telegram_grants g
       ON g.conversationId=d.conversationId AND g.chat=d.chat AND g.user=d.user
       LEFT JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId
       WHERE d.conversationId=? AND d.chat=? AND d.user=? AND p.messageThreadId IS ?`,
      id,
      owner.chat,
      owner.user,
      owner.messageThreadId ?? null,
    );
  }
  dedicated(id: string) {
    return !!this.app.store.get(
      "SELECT 1 FROM telegram_conversations WHERE conversationId=?",
      id,
    );
  }
  authorize(id: string, owner: TelegramOwner) {
    this.connection(owner);
    if (!this.owns(id, owner))
      throw new CommandError(
        "Conversa Telegram indisponível para este usuário. Use /topics para listar suas conversas.",
      );
    this.app.assertConversationAvailable(id);
  }
  list(owner: TelegramOwner) {
    this.connection(owner);
    return this.app.store
      .all<{ id: string; title: string }>(
        `SELECT c.id,c.title FROM conversations c JOIN telegram_conversations d ON d.conversationId=c.id
       JOIN telegram_grants g ON g.conversationId=c.id AND g.chat=d.chat AND g.user=d.user
       LEFT JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId
       WHERE d.chat=? AND d.user=? AND p.messageThreadId IS ? AND c.id NOT IN
       (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC`,
        owner.chat,
        owner.user,
        owner.messageThreadId ?? null,
      )
      .map((row) => ({ id: row.id, title: row.title }));
  }
  selected(owner: TelegramOwner) {
    this.connection(owner);
    const id = this.selection(owner);
    if (!id) return;
    // Revocation cannot silently send the next input back to the shared web history.
    if (!this.owns(id, owner))
      throw new CommandError(
        "Conversa não autorizada. Use /topics new TÍTULO para criar outra conversa Telegram.",
      );
    this.app.assertConversationAvailable(id);
    return id;
  }
  selection(owner: TelegramOwner) {
    return this.app.store.get<{ conversationId: string }>(
      owner.messageThreadId === undefined
        ? "SELECT conversationId FROM telegram_chat_selection WHERE chat=? AND user=?"
        : "SELECT conversationId FROM telegram_topic_selection WHERE chat=? AND user=? AND messageThreadId=?",
      owner.chat,
      owner.user,
      ...(owner.messageThreadId === undefined ? [] : [owner.messageThreadId]),
    )?.conversationId;
  }
  /**
   * Forget which conversation this chat/topic uses, so the next message starts a new one.
   * The old conversation keeps its history; it is simply no longer the selected one.
   */
  /** Reloading keeps the conversation: clear what blocks it instead of abandoning the
   * history. `uncertain` MCP results are the flag that stops every later action. */
  reload(owner: TelegramOwner) {
    this.connection(owner);
    const id = this.selected(owner);
    return id ? this.app.mcpCalls.clearUncertain(id) : 0;
  }

  select(id: string, owner: TelegramOwner) {
    this.authorize(id, owner);
    this.app.store.run(
      owner.messageThreadId === undefined
        ? `INSERT INTO telegram_chat_selection VALUES (?,?,?) ON CONFLICT(chat,user) DO UPDATE SET conversationId=excluded.conversationId`
        : `INSERT INTO telegram_topic_selection VALUES (?,?,?,?) ON CONFLICT(chat,user,messageThreadId) DO UPDATE SET conversationId=excluded.conversationId`,
      owner.chat,
      owner.user,
      ...(owner.messageThreadId === undefined ? [] : [owner.messageThreadId]),
      id,
    );
  }
  async ensure(
    owner: TelegramOwner,
    authorize?: () => void,
    createdName?: string,
  ) {
    authorize?.();
    const selected = this.selected(owner);
    if (selected) return selected;
    const key = JSON.stringify([owner.chat, owner.user, owner.messageThreadId]);
    const running = this.creating.get(key);
    if (running) return running;
    const binding = this.creationAuthority(owner);
    const identity = this.configuredOwner(owner);
    const provenName =
      typeof createdName === "string" &&
      createdName.length <= 128 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(createdName)
        ? createdName
        : null;
    if (
      identity &&
      owner.messageThreadId !== undefined &&
      this.app.store.get(
        `SELECT 1 FROM meta WHERE key GLOB 'telegram:topic-create:*'
       AND CASE WHEN json_valid(value) THEN
         json_extract(value,'$.route.botId')=? AND json_extract(value,'$.route.chat')=? AND json_extract(value,'$.route.user')=?
         AND ((json_extract(value,'$.state') IN ('uncertain','cancelled','failed') AND json_extract(value,'$.messageThreadId') IS NULL
             AND (? IS NULL OR json_extract(value,'$.requestedName') IS NULL OR json_extract(value,'$.requestedName')=?))
           OR json_extract(value,'$.messageThreadId')=?) ELSE 0 END`,
        identity.botId,
        owner.chat,
        owner.user,
        provenName,
        provenName,
        owner.messageThreadId,
      )
    )
      throw new CommandError(
        "Este tópico tem uma criação pendente ou um vínculo revogado. Verifique na web; use /new para criar outra conversa explicitamente.",
      );
    const known =
      owner.messageThreadId === undefined
        ? undefined
        : this.app.store.get<{ name: string | null }>(
            "SELECT name FROM telegram_known_topics WHERE chat=? AND user=? AND messageThreadId=?",
            owner.chat,
            owner.user,
            owner.messageThreadId,
          );
    const title =
      known?.name ||
      (owner.messageThreadId === undefined
        ? "Conversa Telegram"
        : `Tópico Telegram ${owner.messageThreadId}`);
    const route = this.configuredOwner(owner);
    const receiptKey =
      route && owner.messageThreadId !== undefined
        ? `telegram:native-topic-create:${route.botId}:${owner.chat}:${owner.user}:${owner.messageThreadId}`
        : undefined;
    const nativeReceipt = JSON.stringify({
      state: "uncertain",
      route,
      authorityId: binding,
    });
    if (receiptKey) {
      const saved = this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        receiptKey,
      );
      if (saved) {
        const receipt = JSON.parse(saved.value) as {
          state: string;
          conversationId?: string;
        };
        if (receipt.state === "done" && receipt.conversationId) {
          this.select(receipt.conversationId, owner);
          return receipt.conversationId;
        }
        throw new CommandError(
          "A criação deste tópico teve resultado incerto. Verifique na web; use /new para criar outra conversa explicitamente.",
        );
      }
      this.app.store.run(
        "INSERT INTO meta VALUES (?,?)",
        receiptKey,
        nativeReceipt,
      );
    }
    const work = this.app.create(title, owner, authorize).then((id) => {
      authorize?.();
      if (
        receiptKey &&
        this.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key=?",
          receiptKey,
        )?.value !== nativeReceipt
      )
        throw new CommandError(
          "Autorização Telegram mudou durante a criação. Use /new explicitamente para continuar.",
        );
      // An explicit /topics selection made during creation takes precedence.
      const current = this.selected(owner);
      if (current) {
        if (receiptKey)
          this.app.store.run(
            "UPDATE meta SET value=? WHERE key=?",
            JSON.stringify({
              state: "done",
              route,
              authorityId: binding,
              conversationId: current,
            }),
            receiptKey,
          );
        return current;
      }
      this.assertCreationAuthority(binding, owner);
      this.app.store.savepoint("telegram_native_topic_result", () => {
        this.select(id, owner);
        if (receiptKey)
          this.app.store.run(
            "UPDATE meta SET value=? WHERE key=?",
            JSON.stringify({
              state: "done",
              route,
              authorityId: binding,
              conversationId: id,
            }),
            receiptKey,
          );
      });
      return id;
    });
    this.creating.set(key, work);
    void work.finally(() => this.creating.delete(key)).catch(() => {});
    return work;
  }
}
