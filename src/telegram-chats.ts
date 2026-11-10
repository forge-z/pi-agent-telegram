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
    if (!row) throw new CommandError("Conversation not authorized.");
    if (
      this.dedicated(row.conversationId) &&
      !this.owns(row.conversationId, owner)
    )
      throw new CommandError("Conversation not authorized.");
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
    if (!configured)
      throw new CommandError(
        "Telegram configuration on the volume is incomplete (metadata missing). Restart the service; if it persists, check TELEGRAM_ALLOWED_USERS and TELEGRAM_ALLOWED_CHATS.",
      );
    const route = this.configuredOwner(owner);
    if (!route || route.chat !== owner.chat || route.user !== owner.user)
      throw new CommandError(
        "Telegram connection is not authorized. Check TELEGRAM_ALLOWED_USERS and TELEGRAM_ALLOWED_CHATS (your user id and the chat id) and restart the service.",
      );
  }
  assertCreationAuthority(id: string, owner: TelegramOwner) {
    this.connection(owner);
    if (!id) return;
    if (
      !this.app.store.get(
        "SELECT 1 FROM telegram_grants g JOIN conversations c ON c.id=g.conversationId WHERE g.chat=? AND g.user=? AND g.conversationId=?",
        owner.chat,
        owner.user,
        id,
      )
    )
      throw new CommandError("Conversation not authorized.");
    this.app.assertConversationAvailable(id);
  }
  creationAuthority(owner: TelegramOwner) {
    this.connection(owner);
    const id = this.selection(owner);
    if (id) this.authorize(id, owner);
    return id ?? "";
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
        "Telegram conversation unavailable for this user.",
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
        "Conversation not authorized. Use /new to start another conversation in this topic.",
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
  /** Clear uncertain MCP results for the selected conversation. History stays. Used by /resume. */
  reload(owner: TelegramOwner) {
    this.connection(owner);
    const id = this.selected(owner);
    return id ? (this.app.mcpCalls?.clearUncertain(id) ?? 0) : 0;
  }
  /**
   * Another conversation in this same chat or topic. The previous one stays on disk.
   * Does not delete Telegram messages and does not clear uncertain MCP (`/resume`).
   * A stuck native-topic receipt is superseded, or the next `ensure` throws again.
   */
  async startFresh(owner: TelegramOwner) {
    this.connection(owner);
    const route = this.configuredOwner(owner);
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
        ? "Telegram conversation"
        : `Telegram topic ${owner.messageThreadId}`);
    const id = await this.app.create(title, owner);
    const receiptKey =
      route && owner.messageThreadId !== undefined
        ? `telegram:native-topic-create:${route.botId}:${owner.chat}:${owner.user}:${owner.messageThreadId}`
        : undefined;
    this.app.store.savepoint("telegram_new_conversation", () => {
      this.select(id, owner);
      if (receiptKey)
        this.app.store.run(
          "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          receiptKey,
          JSON.stringify({
            state: "done",
            route,
            authorityId: id,
            conversationId: id,
          }),
        );
      if (route && owner.messageThreadId !== undefined)
        this.app.store.run(
          `DELETE FROM meta WHERE key GLOB 'telegram:topic-create:*'
           AND json_valid(value)
           AND json_extract(value,'$.route.botId')=?
           AND json_extract(value,'$.route.chat')=?
           AND json_extract(value,'$.route.user')=?
           AND (
             json_extract(value,'$.messageThreadId')=?
             OR (
               json_extract(value,'$.state') IN ('uncertain','cancelled','failed')
               AND json_extract(value,'$.messageThreadId') IS NULL
             )
           )`,
          route.botId,
          owner.chat,
          owner.user,
          owner.messageThreadId,
        );
    });
    return id;
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
        "This topic has a pending create or a revoked link. Use /new to start another conversation in this topic.",
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
        ? "Telegram conversation"
        : `Telegram topic ${owner.messageThreadId}`);
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
          "Creating this topic had an uncertain result. Use /new to start another conversation in this topic.",
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
          "Telegram authorization changed during creation. Use /new to start another conversation in this topic.",
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
