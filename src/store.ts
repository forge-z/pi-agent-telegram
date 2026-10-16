import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  formatTelegramMessage,
  type TelegramMessageRole,
} from "./telegram-format.js";
import type {
  Credential,
  CredentialStore,
  AuthOperationOptions,
} from "@earendil-works/pi-ai";

export interface Action {
  id: string;
  conversationId: string;
  server: string;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  evidence: string;
}
export interface RequestRow {
  conversationId: string;
  requestId: string;
  text: string;
  submissionId: number | null;
  source: string;
  chat: string | null;
  status: string;
}
export interface Delivery {
  id: string;
  chat: string;
  text: string;
  state: string;
  parseMode: "HTML" | null;
  messageThreadId: number | null;
}
export class Store {
  readonly db: DatabaseSync;
  credentialMutation = false;
  providerAdmissions = 0;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(`${dir}/app.sqlite`);
    const hadGrants = !!this.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_grants'",
    );
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_lifecycle(conversationId TEXT PRIMARY KEY,deletedAt INTEGER);
      CREATE TABLE IF NOT EXISTS conversation_archive_versions(conversationId TEXT PRIMARY KEY,lastDeletedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_retention(conversationId TEXT PRIMARY KEY,purgeAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_purges(conversationId TEXT PRIMARY KEY,deletedAt INTEGER NOT NULL,claimedAt INTEGER NOT NULL,completedAt INTEGER);
      CREATE TABLE IF NOT EXISTS conversation_titles(conversationId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS telegram_initial_revocations(conversationId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS delivery_conversations(deliveryId TEXT PRIMARY KEY,conversationId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_delivery_scopes(deliveryId TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL,messageThreadId INTEGER,conversationId TEXT);
      CREATE INDEX IF NOT EXISTS telegram_delivery_scope_conversation ON telegram_delivery_scopes(conversationId);
      CREATE TABLE IF NOT EXISTS telegram_delivery_resolutions(deliveryId TEXT PRIMARY KEY,conversationId TEXT NOT NULL,note TEXT NOT NULL,resolvedAt INTEGER NOT NULL,previousResult TEXT);
      CREATE TABLE IF NOT EXISTS telegram_control_parts(deliveryId TEXT,conversationId TEXT,PRIMARY KEY(deliveryId,conversationId));
      CREATE INDEX IF NOT EXISTS telegram_control_conversation ON telegram_control_parts(conversationId);
      CREATE TABLE IF NOT EXISTS requests(conversationId TEXT, requestId TEXT, text TEXT, submissionId INTEGER, source TEXT, chat TEXT, status TEXT DEFAULT 'pending', PRIMARY KEY(conversationId,requestId));
      CREATE TABLE IF NOT EXISTS request_telegram_routes(conversationId TEXT NOT NULL,requestId TEXT NOT NULL,chat TEXT NOT NULL,user TEXT NOT NULL,botId TEXT NOT NULL,messageThreadId INTEGER,state TEXT NOT NULL,reason TEXT,PRIMARY KEY(conversationId,requestId));
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, conversationId TEXT, server TEXT, tool TEXT, args TEXT, state TEXT DEFAULT 'pending', result TEXT, evidence TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS reads(conversationId TEXT PRIMARY KEY, result TEXT);
      CREATE TABLE IF NOT EXISTS telegram(chat TEXT PRIMARY KEY, conversationId TEXT, user TEXT);
      CREATE TABLE IF NOT EXISTS telegram_grant_versions(chat TEXT NOT NULL,user TEXT NOT NULL,conversationId TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(chat,user,conversationId));
      CREATE TABLE IF NOT EXISTS telegram_connection_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO telegram_connection_version VALUES (1,0);
      CREATE TABLE IF NOT EXISTS telegram_grants(chat TEXT, user TEXT, conversationId TEXT, PRIMARY KEY(chat,user,conversationId));
      CREATE TABLE IF NOT EXISTS telegram_conversations(conversationId TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_chat_selection(chat TEXT,user TEXT,conversationId TEXT NOT NULL,PRIMARY KEY(chat,user));
      CREATE TABLE IF NOT EXISTS telegram_topic_conversations(conversationId TEXT PRIMARY KEY,messageThreadId INTEGER NOT NULL CHECK(messageThreadId>0));
      CREATE TABLE IF NOT EXISTS telegram_known_topics(chat TEXT,user TEXT,messageThreadId INTEGER NOT NULL,name TEXT,closed INTEGER,nameUpdateId INTEGER NOT NULL DEFAULT -1,nameBotId TEXT,nameDate INTEGER NOT NULL DEFAULT 0,stateUpdateId INTEGER NOT NULL DEFAULT -1,stateBotId TEXT,stateDate INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat,user,messageThreadId));
      CREATE TABLE IF NOT EXISTS telegram_topic_selection(chat TEXT,user TEXT,messageThreadId INTEGER NOT NULL CHECK(messageThreadId>0),conversationId TEXT NOT NULL,PRIMARY KEY(chat,user,messageThreadId));
      CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_purged_updates(id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, chat TEXT, text TEXT, state TEXT DEFAULT 'pending', result TEXT, parseMode TEXT);
      CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS actions_conversation ON actions(conversationId);
      CREATE INDEX IF NOT EXISTS requests_request ON requests(requestId);
      CREATE INDEX IF NOT EXISTS requests_pending ON requests(status) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(state) WHERE state='pending';`);
    // Reinstall changed authorization triggers on existing volumes as well.
    for (const name of [
      "telegram_connection_version_update",
      "task_telegram_connection_update",
      "task_telegram_connection_insert",
      "request_telegram_config_update",
      "request_telegram_config_insert",
    ])
      this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    // Tombstone counters detect revoke/regrant during an awaited creation without
    // granting anything or restoring deleted mappings.
    const bumpGrant = `INSERT INTO telegram_grant_versions VALUES (OLD.chat,OLD.user,OLD.conversationId,1)
      ON CONFLICT(chat,user,conversationId) DO UPDATE SET version=version+1;`;
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS telegram_grant_version_delete AFTER DELETE ON telegram_grants BEGIN ${bumpGrant} END;
      CREATE TRIGGER IF NOT EXISTS telegram_grant_version_update AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId BEGIN ${bumpGrant} END;
      CREATE TRIGGER IF NOT EXISTS telegram_connection_version_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN UPDATE telegram_connection_version SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS telegram_connection_version_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection'
      AND CASE WHEN json_valid(OLD.value) AND json_valid(NEW.value) THEN
        json_extract(OLD.value,'$.enabled') IS NOT json_extract(NEW.value,'$.enabled')
        OR json_extract(OLD.value,'$.bot.id') IS NOT json_extract(NEW.value,'$.bot.id')
        OR json_extract(OLD.value,'$.chatId') IS NOT json_extract(NEW.value,'$.chatId')
        OR json_extract(OLD.value,'$.userId') IS NOT json_extract(NEW.value,'$.userId')
        OR json_extract(OLD.value,'$.allowedUsers') IS NOT json_extract(NEW.value,'$.allowedUsers')
        OR json_extract(OLD.value,'$.allowedChats') IS NOT json_extract(NEW.value,'$.allowedChats') ELSE 1 END
      BEGIN UPDATE telegram_connection_version SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS telegram_connection_version_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN UPDATE telegram_connection_version SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS telegram_credential_version_delete AFTER DELETE ON credentials WHEN OLD.provider='telegram:bot' BEGIN UPDATE telegram_connection_version SET version=version+1; END;
      CREATE TRIGGER IF NOT EXISTS telegram_credential_version_update AFTER UPDATE OF value ON credentials WHEN NEW.provider='telegram:bot' AND OLD.value IS NOT NEW.value BEGIN UPDATE telegram_connection_version SET version=version+1; END;
    `);
    // Capture only ledgers present before replay compatibility was installed.
    // A legacy hash cannot prove the original topic. The first authenticated
    // replay pins its full fingerprint; future updates never enter this table.
    this.db.exec("SAVEPOINT telegram_legacy_migration");
    try {
      if (
        !this.get(
          "SELECT 1 FROM sqlite_master WHERE name='telegram_legacy_updates'",
        )
      ) {
        this.db.exec(`
          CREATE TABLE telegram_legacy_updates(id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,replayFingerprint TEXT);
          INSERT INTO telegram_legacy_updates(id,fingerprint) SELECT id,fingerprint FROM telegram_updates;
        `);
      }
      this.db.exec("RELEASE SAVEPOINT telegram_legacy_migration");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT telegram_legacy_migration");
      this.db.exec("RELEASE SAVEPOINT telegram_legacy_migration");
      throw error;
    }
    this.db.exec(
      "INSERT OR IGNORE INTO conversation_archive_versions SELECT conversationId,deletedAt FROM conversation_lifecycle WHERE deletedAt IS NOT NULL",
    );
    // Migrate old mappings once. An explicitly removed grant must stay removed
    // after restart rather than being silently recreated from a stale mapping.
    if (!hadGrants)
      this.db.exec(
        "INSERT OR IGNORE INTO telegram_grants SELECT chat,user,conversationId FROM telegram",
      );
    // Classify legacy shared histories once without rewriting bindings, grants,
    // selections, messages or cron routes. New web pairing anchors stay web.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_channels(conversationId TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN ('web','telegram')));
      INSERT OR IGNORE INTO conversation_channels
      SELECT c.id,CASE WHEN c.id IN (
        SELECT conversationId FROM telegram_conversations UNION SELECT conversationId FROM telegram
        UNION SELECT conversationId FROM telegram_grants UNION SELECT conversationId FROM telegram_grant_versions
        UNION SELECT conversationId FROM requests WHERE source='telegram'
      ) THEN 'telegram' ELSE 'web' END FROM conversations c;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_notifications(
        id TEXT PRIMARY KEY,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,
        chat TEXT,user TEXT,botId TEXT,state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_notification_parts(deliveryId TEXT PRIMARY KEY,notificationId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_notification_route ON task_notifications(chat,user,conversationId);
      CREATE INDEX IF NOT EXISTS task_notification_part ON task_notification_parts(notificationId);
    `);
    for (const table of ["deliveries", "task_notifications"])
      if (
        !this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(
          (c) => c.name === "messageThreadId",
        )
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN messageThreadId INTEGER`);
    // Revocation is terminal for already queued task parts, even if the same
    // mapping/grant/connection is re-established before the sender next runs.
    const cancel = (
      condition: string,
    ) => `UPDATE deliveries SET state='cancelled',result='Vínculo Telegram revogado antes do envio.'
      WHERE state='pending' AND id IN (
        SELECT p.deliveryId FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE ${condition}
      );`;
    const routeChanged = `n.chat=NEW.chat AND n.user IS NOT NEW.user`;
    const mappingChanged = `n.chat=OLD.chat AND (n.chat IS NOT NEW.chat OR n.user IS NOT NEW.user)`;
    const configChanged = `CASE WHEN json_valid(NEW.value) THEN
      json_extract(NEW.value,'$.enabled') IS NOT 1
      OR CAST(json_extract(NEW.value,'$.bot.id') AS TEXT) IS NOT n.botId
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedUsers'),json_array(json_extract(NEW.value,'$.userId')))) WHERE value=n.user)
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedChats'),json_array(json_extract(NEW.value,'$.chatId')))) WHERE value=n.chat)
      ELSE 1 END`;
    const grantRevoked = `n.chat=OLD.chat AND n.user=OLD.user AND n.conversationId=OLD.conversationId`;
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS telegram_control_revoke AFTER DELETE ON telegram_grants BEGIN
        UPDATE deliveries SET state='cancelled',result='Vínculo Telegram revogado antes do envio.' WHERE state='pending' AND id IN (SELECT deliveryId FROM telegram_control_parts WHERE conversationId=OLD.conversationId);
      END;
      DROP TRIGGER IF EXISTS task_telegram_unlink;
      DROP TRIGGER IF EXISTS task_telegram_remap;
      DROP TRIGGER IF EXISTS task_telegram_replace;
      DROP TRIGGER IF EXISTS task_telegram_revoke;
      DROP TRIGGER IF EXISTS task_telegram_regrant;
      CREATE TRIGGER IF NOT EXISTS task_telegram_unlink AFTER DELETE ON telegram BEGIN ${cancel("n.chat=OLD.chat AND n.conversationId NOT IN (SELECT conversationId FROM telegram_conversations)")} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_remap AFTER UPDATE OF chat,user,conversationId ON telegram BEGIN ${cancel(mappingChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_replace AFTER INSERT ON telegram BEGIN ${cancel(routeChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_revoke AFTER DELETE ON telegram_grants BEGIN ${cancel(grantRevoked)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_regrant AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId
      BEGIN ${cancel(grantRevoked)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection' BEGIN ${cancel(configChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN ${cancel(configChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN ${cancel("1")} END;
    `);
    const revokeRequestRoutes = (condition: string) => `
      UPDATE deliveries SET state='cancelled',result='Rota Telegram revogada antes do envio.'
      WHERE state='pending' AND id IN (SELECT o.deliveryId FROM delivery_conversations o JOIN request_telegram_routes r ON r.conversationId=o.conversationId WHERE r.state='authorized' AND ${condition});
      UPDATE request_telegram_routes SET state='revoked',reason='Rota Telegram revogada antes do envio.' WHERE state='authorized' AND rowid IN (SELECT r.rowid FROM request_telegram_routes r WHERE ${condition});`;
    const requestConfigChanged = `CASE WHEN json_valid(NEW.value) THEN
      json_extract(NEW.value,'$.enabled') IS NOT 1
      OR CAST(json_extract(NEW.value,'$.bot.id') AS TEXT) IS NOT r.botId
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedUsers'),json_array(json_extract(NEW.value,'$.userId')))) WHERE value=r.user)
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedChats'),json_array(json_extract(NEW.value,'$.chatId')))) WHERE value=r.chat)
      ELSE 1 END`;
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS request_telegram_revoke AFTER DELETE ON telegram_grants BEGIN
        ${revokeRequestRoutes("r.chat=OLD.chat AND r.user=OLD.user AND r.conversationId=OLD.conversationId")}
      END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_grant_update AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId
      BEGIN ${revokeRequestRoutes("r.chat=OLD.chat AND r.user=OLD.user AND r.conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_dedicated_delete AFTER DELETE ON telegram_conversations BEGIN ${revokeRequestRoutes("r.conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_dedicated_update AFTER UPDATE ON telegram_conversations BEGIN ${revokeRequestRoutes("r.conversationId=OLD.conversationId AND (r.conversationId IS NOT NEW.conversationId OR r.chat IS NOT NEW.chat OR r.user IS NOT NEW.user)")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_topic_close AFTER UPDATE OF closed ON telegram_known_topics WHEN NEW.closed=1 BEGIN ${revokeRequestRoutes("r.chat=NEW.chat AND r.user=NEW.user AND r.messageThreadId=NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_topic_closed_insert AFTER INSERT ON telegram_known_topics WHEN NEW.closed=1 BEGIN ${revokeRequestRoutes("r.chat=NEW.chat AND r.user=NEW.user AND r.messageThreadId=NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_config_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection' BEGIN ${revokeRequestRoutes(requestConfigChanged)} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_config_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN ${revokeRequestRoutes(requestConfigChanged)} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_config_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN ${revokeRequestRoutes("1")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_thread_update AFTER UPDATE ON telegram_topic_conversations BEGIN ${revokeRequestRoutes("r.conversationId=OLD.conversationId AND (r.conversationId IS NOT NEW.conversationId OR r.messageThreadId IS NOT NEW.messageThreadId)")} END;
      CREATE TRIGGER IF NOT EXISTS request_telegram_thread_delete AFTER DELETE ON telegram_topic_conversations BEGIN ${revokeRequestRoutes("r.conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS conversation_telegram_revoke AFTER DELETE ON telegram_grants BEGIN
        UPDATE deliveries SET state='cancelled',result='Vínculo Telegram revogado antes do envio.'
        WHERE state='pending' AND chat=OLD.chat AND id IN (SELECT deliveryId FROM delivery_conversations WHERE conversationId=OLD.conversationId);
      END;
    `);
    if (
      !this.all<{ name: string }>("PRAGMA table_info(actions)").some(
        (c) => c.name === "evidence",
      )
    )
      this.db.exec("ALTER TABLE actions ADD COLUMN evidence TEXT DEFAULT '{}'");
    if (
      !this.all<{ name: string }>("PRAGMA table_info(deliveries)").some(
        (c) => c.name === "parseMode",
      )
    )
      this.db.exec("ALTER TABLE deliveries ADD COLUMN parseMode TEXT");
    // Only exact request parts are mirrors. Request ids may contain colons;
    // a prefix match can otherwise cancel a different Telegram request or cron.
    for (const part of this.all<{ id: string; conversationId: string }>(
      `SELECT d.id,o.conversationId FROM deliveries d JOIN delivery_conversations o ON o.deliveryId=d.id
       WHERE d.state='pending' AND NOT EXISTS (SELECT 1 FROM task_notification_parts p WHERE p.deliveryId=d.id)
       AND NOT EXISTS (SELECT 1 FROM telegram_control_parts p WHERE p.deliveryId=d.id)`,
    )) {
      const match = /^([1-9]\d*):(.+):([0-9]+)$/.exec(part.id);
      if (!match || match[1] !== part.conversationId) continue;
      const request = (requestId: string) =>
        this.get<{ source: string }>(
          "SELECT source FROM requests WHERE conversationId=? AND requestId=?",
          part.conversationId,
          requestId,
        );
      const owner =
        request(match[2]) ??
        (match[2].endsWith(":web-input")
          ? request(match[2].slice(0, -10))
          : undefined);
      if (owner?.source === "web")
        this.run(
          "UPDATE deliveries SET state='cancelled',result='Canais separados; cópia web não enviada.' WHERE id=? AND state='pending'",
          part.id,
        );
    }
    this.db.exec(
      "UPDATE actions SET state='uncertain' WHERE state='running'; UPDATE deliveries SET state='uncertain' WHERE state='sending';",
    );
  }
  /** Atomic both on its own and nested in a caller's transaction; `run` must stay synchronous. */
  savepoint<T>(name: string, run: () => T): T {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Nome de savepoint inválido");
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = run();
      if (result instanceof Promise)
        throw new Error("Savepoint não aceita operação assíncrona");
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  /**
   * Changes whenever a commit could have altered this database, from this or
   * another connection. Undefined inside a transaction, whose reads may roll back.
   */
  changeToken() {
    if (this.db.isTransaction) return undefined;
    const own = this.get<{ changes: number }>(
      "SELECT total_changes() AS changes",
    )!.changes;
    const other = this.get<{ data_version: number }>(
      "PRAGMA data_version",
    )!.data_version;
    return `${other}:${own}`;
  }
  queueTelegram(
    prefix: string,
    chat: string,
    text: string,
    legacyLimit = 3500,
    conversationId?: string,
    messageThreadId?: number | null,
    role?: TelegramMessageRole,
  ) {
    conversationId ??= /^([1-9]\d*):/.exec(prefix)?.[1];
    messageThreadId ??= conversationId
      ? this.telegramThread(conversationId)
      : undefined;
    if (conversationId && this.conversationDeleted(conversationId)) return;
    // A request partially queued by the previous version must retain its old
    // boundaries and plain-text payloads; changing them could repeat content.
    const prior = this.all<Delivery>(
      "SELECT * FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      ...childIds(prefix),
    ).filter((row) => /^\d+$/.test(row.id.slice(prefix.length + 1)));
    const legacy = prior.some((row) => row.parseMode === null);
    const chunks: string[] = [];
    if (legacy) {
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + legacyLimit, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        chunks.push(text.slice(offset, end));
        offset = end;
      }
    } else
      chunks.push(
        ...formatTelegramMessage(text, prior.length ? undefined : role),
      );
    // Commands already commit their receipt and acknowledgement together.
    // A savepoint keeps this batch atomic both inside and outside that transaction.
    this.db.exec("SAVEPOINT telegram_delivery_batch");
    try {
      chunks.forEach((chunk, index) => {
        this.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text,parseMode,messageThreadId) VALUES (?,?,?,?,?)",
          `${prefix}:${index}`,
          chat,
          chunk,
          legacy ? null : "HTML",
          messageThreadId ?? null,
        );
        if (conversationId)
          this.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `${prefix}:${index}`,
            conversationId,
          );
      });
      this.db.exec("RELEASE SAVEPOINT telegram_delivery_batch");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT telegram_delivery_batch");
      this.db.exec("RELEASE SAVEPOINT telegram_delivery_batch");
      throw error;
    }
  }
  authorizationVersion(
    owner: { chat: string; user: string },
    conversationId: string,
  ) {
    const grant =
      this.get<{ version: number }>(
        "SELECT version FROM telegram_grant_versions WHERE chat=? AND user=? AND conversationId=?",
        owner.chat,
        owner.user,
        conversationId,
      )?.version ?? 0;
    const connection = this.get<{ version: number }>(
      "SELECT version FROM telegram_connection_version WHERE id=1",
    )!.version;
    return `${grant}:${connection}`;
  }
  actions(conversationId: string) {
    return this.all<Action>(
      "SELECT * FROM actions WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  telegramThread(conversationId: string) {
    return this.get<{ messageThreadId: number }>(
      "SELECT messageThreadId FROM telegram_topic_conversations WHERE conversationId=?",
      conversationId,
    )?.messageThreadId;
  }
  conversationDeleted(id: string) {
    return !!this.get(
      "SELECT 1 FROM conversation_lifecycle WHERE conversationId=? AND deletedAt IS NOT NULL UNION ALL SELECT 1 FROM conversation_purges WHERE conversationId=?",
      id,
      id,
    );
  }
  close() {
    this.db.close();
  }
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Primary-key range for ids `${prefix}:…`; ';' is the character right after ':'. */
export const childIds = (prefix: string) =>
  [`${prefix}:`, `${prefix};`] as const;
/** Drop a queued Telegram prefix so a control card can be re-queued after failure. */
export function clearTelegramDeliveryPrefix(store: Store, prefix: string) {
  const parts = store.all<{ id: string }>(
    "SELECT id FROM deliveries WHERE id>=? AND id<?",
    ...childIds(prefix),
  );
  for (const { id } of parts) {
    store.run("DELETE FROM telegram_control_parts WHERE deliveryId=?", id);
    store.run("DELETE FROM delivery_conversations WHERE deliveryId=?", id);
    for (const key of [
      `telegram:markup:${id}`,
      `telegram:control-route:${id}`,
      `telegram:force-reply:${id}`,
    ])
      store.run("DELETE FROM meta WHERE key=?", key);
    store.run("DELETE FROM deliveries WHERE id=?", id);
  }
}

/** Pi owns OAuth/login/refresh. Its adapter excludes the private Telegram credential. */
export class SqlCredentials implements CredentialStore {
  private static queues = new WeakMap<Store, Map<string, Promise<unknown>>>();
  private tails: Map<string, Promise<unknown>>;
  constructor(private store: Store) {
    let tails = SqlCredentials.queues.get(store);
    if (!tails) {
      tails = new Map();
      SqlCredentials.queues.set(store, tails);
    }
    this.tails = tails;
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const row = this.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      providerId,
    );
    return row ? (JSON.parse(row.value) as Credential) : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return this.store
      .all<{ provider: string; value: string }>(
        "SELECT * FROM credentials WHERE provider <> 'telegram:bot'",
      )
      .map((row) => ({
        providerId: row.provider,
        type: (JSON.parse(row.value) as Credential).type,
      }));
  }
  async modify(
    providerId: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        options?.signal?.throwIfAborted();
        const current = await this.read(providerId);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next)
          this.store.run(
            "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
            providerId,
            JSON.stringify(next),
          );
        return next ?? current;
      });
    this.tails.set(providerId, operation);
    return operation;
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        options?.signal?.throwIfAborted();
        this.store.run("DELETE FROM credentials WHERE provider=?", providerId);
      });
    this.tails.set(providerId, operation);
    return operation;
  }
}
