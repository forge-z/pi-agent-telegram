import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { ConversationBusyError, type Runtime } from "./runtime.js";
import {
  queueTaskTelegram,
  taskTelegramAvailable,
  telegramConversationRoute,
  telegramRouteAuthorized,
  type TelegramRoute,
} from "./task-telegram.js";
import { logFailure } from "./log.js";
import { MAX_TEXT, REQUEST_ID, truncateTaskSummary } from "./limits.js";

type TaskDelivery = "legacy" | "web" | "web_telegram" | "none";
/**
 * Runs as callers see them: `trigger` is derived from the stored `scheduled` flag, so a
 * manual run is named without a second column to keep in sync.
 */
const RUN_SELECT = `SELECT *, CASE scheduled WHEN 1 THEN 'scheduled' ELSE 'manual' END AS trigger FROM task_runs`;

/** The execution log keeps seven days, the window an operator actually reads. */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_SWEEP_MS = 60 * 60 * 1000;
/** How often stale in-flight runs are checked for timeout. */
const RUN_WATCH_MS = 30 * 1000;
const DEFAULT_RUN_TIMEOUT_MIN = 30;

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export interface TaskOrigin {
  source: "web" | "telegram";
  conversationId: string;
  requestId: string;
}
interface TaskDestination {
  destinationChat: string | null;
  destinationUser: string | null;
  destinationBotId: string | null;
  destinationMessageThreadId: number | null;
  destinationReason: string | null;
  originSource: "web" | "telegram" | null;
  originConversationId: string | null;
  originRequestId: string | null;
}
export interface Task extends TaskDestination {
  id: string;
  title: string;
  prompt: string;
  conversationId: string;
  kind: "once" | "cron";
  schedule: string;
  timezone: string;
  delivery: TaskDelivery;
  enabled: boolean;
  nextRun: number | null;
  lastError: string | null;
}
interface TaskRun extends TaskDestination {
  delivery: TaskDelivery;
  conversationId: string;
  id: string;
  /** `manual` when an operator triggered it: it has no planned time, only a trigger one. */
  trigger: "scheduled" | "manual";
  scheduledAt: number;
  state: "pending" | "done" | "failed";
  requestId: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** `ok`, `erro` or `silencioso`; null while the occurrence is still pending. */
  status: string | null;
  /** Short answer of the run, or the reason it failed. */
  summary: string | null;
  /** MCP tools that completed during the run, comma separated; the external-action indicator. */
  external: string | null;
}
type TaskRow = Omit<Task, "enabled"> & { enabled: number; deleted: number };
type PendingRun = TaskRun & {
  taskId: string;
  conversationId: string;
  prompt: string;
};
type TaskRuntime = Pick<
  Runtime,
  "store" | "create" | "conversation" | "submit"
> &
  Partial<Pick<Runtime, "options">>;

function text(value: unknown, field: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TaskError(`${field} inválido (máximo ${limit} caracteres)`);
  return value;
}
function nextCron(schedule: string, timezone: string, now: number) {
  if (schedule.split(/\s+/).length !== 5 || /\bH\b/i.test(schedule))
    throw new TaskError("Cron deve ter exatamente 5 campos, sem H/hash");
  try {
    return CronExpressionParser.parse(schedule, {
      tz: timezone,
      currentDate: now,
    })
      .next()
      .getTime();
  } catch {
    throw new TaskError("Expressão cron inválida");
  }
}
function onceDate(schedule: string, now: number) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      schedule,
    );
  const timestamp = Date.parse(schedule);
  if (!match || !Number.isFinite(timestamp) || timestamp <= now)
    throw new TaskError(
      "Data única deve ser ISO com Z/offset e estar no futuro",
    );
  const [, year, month, day, hour, minute, second, offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > days ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? 0) > 59 ||
    (offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
  )
    throw new TaskError("Data única inválida");
  return timestamp;
}
function publicTask(row: TaskRow): Task {
  const { deleted: _deleted, ...task } = row;
  void _deleted;
  return { ...task, enabled: Boolean(row.enabled) };
}

/** Calendar admission only. Pi's Harness owns model execution and durable input replay.
 * See pi-durable/dist/harness/scheduler.js and TaskRuntime.sleepUntil in dist/types.d.ts.
 * No OS cron, shell invocation, or independent model executor is used here.
 */
export class Tasks {
  private tail: Promise<unknown> = Promise.resolve();
  private admitted = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private ticking?: Promise<void>;
  constructor(
    private runtime: TaskRuntime,
    private clock = () => Date.now(),
  ) {
    runtime.store.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
        timezone TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'legacy',
        enabled INTEGER NOT NULL, nextRun INTEGER,
        lastError TEXT, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, scheduledAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', requestId TEXT NOT NULL UNIQUE, error TEXT,
        scheduled INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_pending ON task_runs(taskId) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversationId);
      CREATE TABLE IF NOT EXISTS task_run_keys(requestId TEXT PRIMARY KEY, runId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_creations(creationKey TEXT PRIMARY KEY, taskId TEXT NOT NULL, input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_delivery_changes(changeKey TEXT PRIMARY KEY,taskId TEXT NOT NULL,delivery TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS archived_task_insert BEFORE INSERT ON tasks
      WHEN EXISTS (SELECT 1 FROM conversation_lifecycle WHERE conversationId=NEW.conversationId AND deletedAt IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'Conversa excluída'); END;
      CREATE TRIGGER IF NOT EXISTS archived_task_enable BEFORE UPDATE OF enabled ON tasks
      WHEN NEW.enabled=1 AND EXISTS (SELECT 1 FROM conversation_lifecycle WHERE conversationId=NEW.conversationId AND deletedAt IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'Conversa excluída'); END;
    `);
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(tasks)")
        .some((column) => column.name === "delivery")
    )
      runtime.store.db.exec(
        "ALTER TABLE tasks ADD COLUMN delivery TEXT NOT NULL DEFAULT 'legacy'",
      );
    const hadOrigins = runtime.store
      .all<{ name: string }>("PRAGMA table_info(tasks)")
      .some((c) => c.name === "originSource");
    const destinationColumns: Record<string, string> = {
      destinationChat: "TEXT",
      destinationUser: "TEXT",
      destinationBotId: "TEXT",
      destinationMessageThreadId: "INTEGER",
      destinationReason: "TEXT",
      originSource: "TEXT",
      originConversationId: "TEXT",
      originRequestId: "TEXT",
    };
    for (const table of ["tasks", "task_runs"]) {
      const columns = new Set(
        runtime.store
          .all<{ name: string }>(`PRAGMA table_info(${table})`)
          .map((c) => c.name),
      );
      const additions =
        table === "task_runs"
          ? {
              ...destinationColumns,
              delivery: "TEXT",
              conversationId: "TEXT",
              startedAt: "INTEGER",
              finishedAt: "INTEGER",
              status: "TEXT",
              summary: "TEXT",
              external: "TEXT",
              timeoutNotified: "INTEGER NOT NULL DEFAULT 0",
            }
          : destinationColumns;
      for (const [name, type] of Object.entries(additions))
        if (!columns.has(name))
          runtime.store.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${name} ${type}`,
          );
    }
    if (
      !runtime.store
        .all<{ name: string }>("PRAGMA table_info(task_notifications)")
        .some((c) => c.name === "reason")
    )
      runtime.store.db.exec(
        "ALTER TABLE task_notifications ADD COLUMN reason TEXT",
      );
    // Never derive an admitted legacy occurrence's destination from today's route.
    runtime.store.db.exec(`
      UPDATE task_runs SET conversationId=(SELECT conversationId FROM tasks WHERE id=task_runs.taskId)
        WHERE conversationId IS NULL;
      UPDATE task_runs SET delivery='legacy',destinationReason='Destino legado não comprovado. Selecione o destino para execuções futuras.'
        WHERE delivery IS NULL;
      UPDATE tasks SET destinationReason='Destino legado não comprovado. Selecione o destino para execuções futuras.'
        WHERE delivery IN ('legacy','web_telegram') AND destinationChat IS NULL AND destinationReason IS NULL;
    `);
    if (!hadOrigins)
      runtime.store.db.exec(`
      UPDATE tasks SET enabled=0,nextRun=NULL,destinationReason='Destino legado não comprovado. Selecione explicitamente o destino para execuções futuras.',
        lastError='Destino legado não comprovado. Selecione explicitamente o destino para execuções futuras.'
      WHERE delivery='web' AND originSource IS NULL AND destinationReason IS NULL AND NOT EXISTS (
        SELECT 1 FROM task_creations c WHERE c.taskId=tasks.id
        AND CASE WHEN json_valid(c.input) THEN json_extract(c.input,'$.delivery')='web' ELSE 0 END
      );
    `);
    this.installDestinationRevocations();
  }
  private installDestinationRevocations() {
    const invalidate = (condition: string) =>
      ["tasks", "task_runs"]
        .map(
          (table) => `
      UPDATE ${table} SET destinationReason='Vínculo Telegram revogado. Selecione o destino para execuções futuras.'
      ${table === "tasks" ? ",lastError='Vínculo Telegram revogado. Selecione o destino para execuções futuras.'" : ""}
      WHERE destinationChat IS NOT NULL AND destinationReason IS NULL AND (${condition});`,
        )
        .join("\n");
    const grant =
      "destinationChat=OLD.chat AND destinationUser=OLD.user AND conversationId=OLD.conversationId";
    const mapping =
      "destinationChat=OLD.chat AND destinationUser=OLD.user AND conversationId NOT IN (SELECT conversationId FROM telegram_conversations)";
    const config = `CASE WHEN json_valid(NEW.value) THEN
      json_extract(NEW.value,'$.enabled') IS NOT 1
      OR CAST(json_extract(NEW.value,'$.bot.id') AS TEXT) IS NOT destinationBotId
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedUsers'),json_array(json_extract(NEW.value,'$.userId')))) WHERE value=destinationUser)
      OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedChats'),json_array(json_extract(NEW.value,'$.chatId')))) WHERE value=destinationChat) ELSE 1 END`;
    this.runtime.store.db.exec(`
      DROP TRIGGER IF EXISTS task_destination_config_update;
      DROP TRIGGER IF EXISTS task_destination_config_insert;
      CREATE TRIGGER IF NOT EXISTS task_destination_grant_delete AFTER DELETE ON telegram_grants BEGIN ${invalidate(grant)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_grant_update AFTER UPDATE ON telegram_grants
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId
        BEGIN ${invalidate(grant)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_delete AFTER DELETE ON telegram BEGIN ${invalidate(mapping)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_update AFTER UPDATE ON telegram
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user BEGIN ${invalidate(mapping)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_mapping_insert AFTER INSERT ON telegram BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser IS NOT NEW.user AND conversationId NOT IN (SELECT conversationId FROM telegram_conversations)")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN ${invalidate("1")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection' BEGIN ${invalidate(config)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_config_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN ${invalidate(config)} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_update AFTER UPDATE ON telegram_topic_conversations
        WHEN OLD.messageThreadId IS NOT NEW.messageThreadId BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_delete AFTER DELETE ON telegram_topic_conversations BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_dedicated_delete AFTER DELETE ON telegram_conversations BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_dedicated_update AFTER UPDATE ON telegram_conversations
        WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user BEGIN ${invalidate("conversationId=OLD.conversationId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_insert AFTER INSERT ON telegram_topic_conversations BEGIN
        ${invalidate("conversationId=NEW.conversationId AND destinationMessageThreadId IS NOT NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_closed_insert AFTER INSERT ON telegram_known_topics WHEN NEW.closed=1 BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser=NEW.user AND destinationMessageThreadId=NEW.messageThreadId")} END;
      CREATE TRIGGER IF NOT EXISTS task_destination_topic_closed AFTER UPDATE OF closed ON telegram_known_topics WHEN NEW.closed=1 BEGIN
        ${invalidate("destinationChat=NEW.chat AND destinationUser=NEW.user AND destinationMessageThreadId=NEW.messageThreadId")} END;
    `);
  }
  list(): Task[] {
    return this.runtime.store
      .all<TaskRow>("SELECT * FROM tasks WHERE deleted=0 ORDER BY rowid")
      .map(publicTask);
  }
  get(id: string): Task | undefined {
    const row = this.runtime.store.get<TaskRow>(
      "SELECT * FROM tasks WHERE id=? AND deleted=0",
      id,
    );
    return row ? publicTask(row) : undefined;
  }
  private require(id: string) {
    const task = this.get(id);
    if (!task) throw new TaskError("Tarefa não encontrada");
    return task;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new TaskError("Agendador encerrando"));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  create(
    input: unknown,
    creationKey?: string,
    origin?: TaskOrigin,
  ): Promise<Task> {
    return this.serialize(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TaskError("Tarefa inválida");
      const data = input as Record<string, unknown>;
      const title = text(data.title, "Título", 120).trim();
      const prompt = text(data.prompt, "Prompt", MAX_TEXT);
      const schedule = text(data.schedule, "Agenda", 200).trim();
      if (
        origin &&
        ((origin.source !== "web" && origin.source !== "telegram") ||
          !REQUEST_ID.test(origin.requestId) ||
          !origin.conversationId ||
          data.conversationId !== origin.conversationId)
      )
        throw new TaskError("Origem da tarefa não corresponde à conversa");
      const requestedDelivery =
        data.delivery === undefined
          ? undefined
          : this.newDelivery(data.delivery);
      const delivery = this.creationDelivery(requestedDelivery, origin);
      const timezone = text(
        data.timezone === undefined ? "America/Sao_Paulo" : data.timezone,
        "Fuso",
        100,
      );
      try {
        // Intl also accepts fixed offsets; require an IANA name (UTC is valid).
        if (/^[+-]/.test(timezone)) throw new TaskError("Fuso IANA inválido");
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
      } catch {
        throw new TaskError("Fuso IANA inválido");
      }
      if (data.kind !== "once" && data.kind !== "cron")
        throw new TaskError("Tipo de tarefa inválido");
      if (data.enabled !== undefined && typeof data.enabled !== "boolean")
        throw new TaskError("enabled deve ser booleano");
      // The receipt and schedule commit together, before a replay-safe tool returns.
      // Resolve a receipt before checking the current time or quota: a once schedule
      // may already be in the past when its interrupted tool is resumed.
      const signatureInput: Record<string, unknown> = {
        title,
        prompt,
        kind: data.kind,
        schedule,
        timezone,
        enabled: data.enabled !== false,
        conversationId: data.conversationId ?? null,
      };
      // Keep the prior signature for interrupted tool replays that omit the
      // newly optional field.
      if (requestedDelivery !== undefined)
        signatureInput.delivery = requestedDelivery;
      if (origin) signatureInput.origin = origin;
      const signature = JSON.stringify(signatureInput);
      if (creationKey !== undefined) {
        if (!REQUEST_ID.test(creationKey))
          throw new TaskError("Chave de criação inválida");
        const receipt = this.runtime.store.get<{
          taskId: string;
          input: string;
        }>(
          "SELECT taskId,input FROM task_creations WHERE creationKey=?",
          creationKey,
        );
        if (receipt) {
          const priorSignatureInput = { ...signatureInput };
          delete priorSignatureInput.origin;
          const priorSignature = origin
            ? JSON.stringify(priorSignatureInput)
            : undefined;
          // An interrupted pre-origin tool replay returns its existing ambiguous
          // destination. It never repairs provenance or reroutes old work.
          if (receipt.input !== signature && receipt.input !== priorSignature)
            throw new TaskError(
              "Chave de criação já utilizada com conteúdo diferente",
            );
          return this.require(receipt.taskId);
        }
      }
      const nextRun =
        data.kind === "once"
          ? onceDate(schedule, this.clock())
          : nextCron(schedule, timezone, this.clock());
      if (this.list().length >= 100)
        throw new TaskError("Limite de 100 tarefas atingido");
      let conversationId: string;
      if (data.conversationId !== undefined) {
        conversationId = text(data.conversationId, "Conversa", 100);
        await this.runtime.conversation(conversationId);
      } else {
        if (delivery === "web_telegram")
          throw new TaskError(
            "Telegram não está conectado e autorizado para esta conversa. Escolha uma conversa vinculada ao bot.",
          );
        conversationId = await this.runtime.create(title);
      }
      const destination = this.destination(delivery, conversationId, origin);
      const id = randomUUID();
      if (this.runtime.store.conversationDeleted(conversationId))
        throw new TaskError(
          "Conversa excluída. Recupere-a antes de criar uma tarefa.",
        );
      this.runtime.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.runtime.store.run(
          "INSERT INTO tasks(id,title,prompt,conversationId,kind,schedule,timezone,delivery,enabled,nextRun,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          title,
          prompt,
          conversationId,
          data.kind,
          schedule,
          timezone,
          delivery,
          data.enabled === false ? 0 : 1,
          data.enabled === false ? null : nextRun,
          destination.destinationChat,
          destination.destinationUser,
          destination.destinationBotId,
          destination.destinationMessageThreadId,
          destination.destinationReason,
          origin?.source ?? null,
          origin?.conversationId ?? null,
          origin?.requestId ?? null,
        );
        if (creationKey !== undefined)
          this.runtime.store.run(
            "INSERT INTO task_creations VALUES (?,?,?)",
            creationKey,
            id,
            signature,
          );
        this.runtime.store.db.exec("COMMIT");
      } catch (error) {
        this.runtime.store.db.exec("ROLLBACK");
        throw error;
      }
      return this.require(id);
    });
  }
  setEnabled(id: string, enabled: boolean): Task {
    return this.update(id, { enabled });
  }
  setDelivery(
    id: string,
    delivery: unknown,
    changeKey?: string,
    origin?: TaskOrigin,
  ): Task {
    if (this.runtime.options?.telegramOnly)
      throw new TaskError("O destino do agendamento é imutável.");
    if (origin) {
      if (this.creationDelivery(undefined, origin, true) !== delivery)
        throw new TaskError(
          "A alteração deve respeitar a escolha explícita de destino do usuário.",
        );
    }
    if (changeKey === undefined) return this.update(id, { delivery });
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (!REQUEST_ID.test(changeKey))
      throw new TaskError("Chave de alteração inválida");
    const store = this.runtime.store;
    const receipt = store.get<{
      taskId: string;
      delivery: string;
      result: string;
    }>("SELECT * FROM task_delivery_changes WHERE changeKey=?", changeKey);
    if (receipt) {
      if (receipt.taskId !== id || receipt.delivery !== delivery)
        throw new TaskError(
          "Chave de alteração já utilizada com conteúdo diferente",
        );
      return JSON.parse(receipt.result) as Task;
    }
    return store.savepoint("task_delivery_change", () => {
      const result = this.update(id, { delivery });
      store.run(
        "INSERT INTO task_delivery_changes VALUES (?,?,?,?)",
        changeKey,
        id,
        result.delivery,
        JSON.stringify(result),
      );
      return result;
    });
  }
  telegramAvailability(conversationId: string) {
    return taskTelegramAvailable(this.runtime.store, conversationId);
  }
  /** Edit schedule content only; channel, origin and captured destination are immutable here. */
  edit(id: string, input: unknown): Task {
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TaskError("Atualização de tarefa inválida");
    const data = input as Record<string, unknown>;
    if (
      !Object.keys(data).length ||
      Object.keys(data).some(
        (key) => !["title", "prompt", "schedule", "timezone"].includes(key),
      )
    )
      throw new TaskError("Campo de atualização inválido");
    const task = this.require(id);
    if (this.runtime.store.conversationDeleted(task.conversationId))
      throw new TaskError(
        "Conversa excluída. Recupere-a antes de alterar a tarefa.",
      );
    const title = text(data.title ?? task.title, "Título", 120).trim();
    const prompt = text(data.prompt ?? task.prompt, "Prompt", MAX_TEXT);
    if (
      prompt !== task.prompt &&
      this.runtime.store.get(
        "SELECT 1 FROM task_runs WHERE taskId=? AND state='pending'",
        id,
      )
    )
      throw new TaskError(
        "Há uma ocorrência pendente. Aguarde sua conclusão antes de editar a instrução.",
      );
    const schedule = text(data.schedule ?? task.schedule, "Agenda", 200).trim();
    const timezone = text(data.timezone ?? task.timezone, "Fuso", 100).trim();
    try {
      if (/^[+-]/.test(timezone)) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    } catch {
      throw new TaskError("Fuso IANA inválido");
    }
    const reschedule = schedule !== task.schedule || timezone !== task.timezone;
    let nextRun = task.nextRun;
    if (reschedule) {
      if (
        task.kind === "once" &&
        this.runtime.store.get(
          "SELECT 1 FROM task_runs WHERE taskId=? AND scheduled=1",
          id,
        )
      )
        throw new TaskError("Tarefa única já executada");
      const next =
        task.kind === "once"
          ? onceDate(schedule, this.clock())
          : nextCron(schedule, timezone, this.clock());
      nextRun = task.enabled ? next : null;
    }
    this.runtime.store.run(
      "UPDATE tasks SET title=?,prompt=?,schedule=?,timezone=?,nextRun=? WHERE id=?",
      title,
      prompt,
      schedule,
      timezone,
      nextRun,
      id,
    );
    return this.require(id);
  }
  update(id: string, input: unknown): Task {
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TaskError("Atualização de tarefa inválida");
    const data = input as Record<string, unknown>;
    if (data.enabled === undefined && data.delivery === undefined)
      throw new TaskError("Informe uma alteração da tarefa");
    if (Object.keys(data).some((key) => !["enabled", "delivery"].includes(key)))
      throw new TaskError("Campo de atualização inválido");
    const task = this.require(id);
    if (this.runtime.store.conversationDeleted(task.conversationId))
      throw new TaskError(
        "Conversa excluída. Recupere-a antes de alterar a tarefa.",
      );
    const enabled = data.enabled ?? task.enabled;
    if (typeof enabled !== "boolean")
      throw new TaskError("enabled deve ser booleano");
    const delivery =
      data.delivery === undefined
        ? task.delivery
        : this.newDelivery(data.delivery, task.delivery === "legacy");
    if (
      data.delivery !== undefined &&
      delivery === "web_telegram" &&
      !taskTelegramAvailable(this.runtime.store, task.conversationId)
    )
      throw new TaskError(
        "Telegram não está conectado e autorizado para esta conversa. Conecte o bot e vincule a conversa escolhida.",
      );
    const destination =
      data.delivery === undefined
        ? task
        : this.destination(delivery, task.conversationId);
    if (task.enabled === enabled && data.delivery === undefined) return task;
    let nextRun = task.nextRun;
    if (enabled !== task.enabled) {
      nextRun = null;
      if (enabled) {
        if (task.kind === "once") {
          const consumed = this.runtime.store.get(
            "SELECT id FROM task_runs WHERE taskId=? AND scheduled=1",
            id,
          );
          if (consumed) throw new TaskError("Tarefa única já executada");
          nextRun = Date.parse(task.schedule);
        } else nextRun = nextCron(task.schedule, task.timezone, this.clock());
      }
    }
    this.runtime.store.run(
      "UPDATE tasks SET enabled=?,nextRun=?,delivery=?,destinationChat=?,destinationUser=?,destinationBotId=?,destinationMessageThreadId=?,destinationReason=?,lastError=? WHERE id=?",
      enabled ? 1 : 0,
      nextRun,
      delivery,
      destination.destinationChat,
      destination.destinationUser,
      destination.destinationBotId,
      destination.destinationMessageThreadId,
      destination.destinationReason,
      destination.destinationReason ??
        (data.delivery === undefined ? task.lastError : null),
      id,
    );
    return this.require(id);
  }
  private creationDelivery(
    requested: TaskDelivery | undefined,
    origin?: TaskOrigin,
    requireExplicit = false,
  ): TaskDelivery {
    if (this.runtime.options?.telegramOnly) {
      if (requested && requested !== "web_telegram")
        throw new TaskError("O destino é fixo no chat/tópico de origem.");
      if (!origin || origin.source !== "telegram")
        throw new TaskError(
          "Agendamentos exigem uma solicitação humana neste tópico.",
        );
      return "web_telegram";
    }
    if (!origin) return requested ?? "web"; // Authenticated task UI selection.
    const request = this.runtime.store.get<{ text: string; source: string }>(
      "SELECT text,source FROM requests WHERE conversationId=? AND requestId=?",
      origin.conversationId,
      origin.requestId,
    );
    if (request && request.source !== origin.source)
      throw new TaskError("Origem da tarefa não corresponde à solicitação");
    // Only these explicit PT-BR/EN choices in the persisted human input can
    // suppress the canonical Telegram copy. A model's delivery argument is not proof.
    const choice =
      /\b(?:somente na web|so na web|apenas (?:na )?web|web[ -]only|only on the web|only (?:stays|remains) in (?:the )?web conversation)\b/i;
    const noTelegram =
      /\b(?:(?:do not|don['’]t|never)\s+(?:send|deliver|post|copy|publish)(?:\s+(?:it|results|the results))?\s+(?:to|on|in|via)\s+telegram|(?:nao|nunca)\s+(?:envie|mande|entregue|publique|copie)(?:\s+(?:isso|resultados|os resultados))?\s+(?:para|no|pelo|via)(?:\s+o)?\s+telegram|(?:without|sem)\s+telegram)\b/i;
    const negativeTelegram =
      /\b(?:not|never|don['’]t|nao|nunca|without|sem)\b[^.!?;\n]{0,100}\btelegram\b/i;
    const humanText =
      request?.text.normalize("NFD").replace(/\p{M}/gu, "") ?? "";
    // Only direct destination directives authorize a tool-driven change. A task's
    // origin ("created on Telegram") is context, never a delivery instruction.
    const changeDestination = String.raw`\b(?:mude|altere|troque|mudar|alterar|trocar|change|switch|update|set)\s+(?:(?:a|o|the|this|that)\s+)?(?:entrega|destino|canal|delivery|destination|channel|task|tarefa|agenda)\s+`;
    const sendResults = String.raw`\b(?:envie|mande|entregue|send|deliver)\s+(?:(?:(?:the|os|o|a|this|that|essa|esta)\s+)?(?:resultados|resultado|results|result|resumo|summary|task|tarefa|it|isso)\s+)?`;
    const directiveStart = String.raw`^\s*(?:(?:please|por favor)[,\s]+)?`;
    const noTelegramDirective = new RegExp(
      `${directiveStart}${noTelegram.source}\\s*$`,
      "i",
    );
    const telegramDirective = new RegExp(
      `${directiveStart}(?:${changeDestination}(?:para|to)|${sendResults}(?:para|no|pelo|via|to|on|in))\\s+(?:(?:o|the)\\s+)?telegram\\s*$`,
      "i",
    );
    const webDirective = new RegExp(
      `${directiveStart}(?:${changeDestination}(?:(?:para|to|so it)\\s+)?|${sendResults})(?:${choice.source}|${noTelegram.source})\\s*$`,
      "i",
    );
    const ambiguity =
      "Destino ambíguo. Selecione explicitamente web ou Telegram na interface, ou envie uma nova solicitação sem alternativas contraditórias.";
    if (
      (choice.test(humanText) ||
        negativeTelegram.test(humanText) ||
        (requireExplicit && /\btelegram\b/i.test(humanText))) &&
      (/["“”]/.test(humanText) ||
        /(?:^|\n)[ \t]*['‘’][ \t]*(?:\n|$)/.test(humanText))
    )
      throw new TaskError(ambiguity);
    // Preserve Markdown quotation context across lines; reminder content is
    // never evidence of a human destination selection.
    let fence: string | undefined;
    let blockquote = false;
    for (const line of humanText.split(/\r?\n/)) {
      const marker = /^\s*(?:>\s*)?(```|~~~)/.exec(line)?.[1];
      if (marker) {
        fence = fence === marker ? undefined : marker;
        continue;
      }
      if (/^\s*>/.test(line)) blockquote = true;
      else if (!line.trim()) blockquote = false;
      if (
        (fence || blockquote || /^(?: {4}|\t)/.test(line)) &&
        (choice.test(line) ||
          negativeTelegram.test(line) ||
          (requireExplicit && /\btelegram\b/i.test(line)))
      )
        throw new TaskError(ambiguity);
    }
    if (choice.test(humanText) || noTelegram.test(humanText)) {
      const withoutDirective = (value: string) =>
        value.replace(new RegExp(noTelegram.source, "gi"), "");
      const clauses = humanText
        .split(/[.!?;\n]/)
        .filter((clause) => choice.test(clause) || noTelegram.test(clause));
      const conflicting = withoutDirective(humanText).replace(
        /\b(?:not|never|without|nao|sem)\s+(?:(?:on|in|no|pelo|via)\s+)?telegram\b/gi,
        "",
      );
      if (
        clauses.some((clause) =>
          /["'`“”]|\b(?:not|never|nao|nunca|maybe|perhaps|talvez|prompt|title|titulo)\b/i.test(
            withoutDirective(clause),
          ),
        ) ||
        /\btelegram\b/i.test(conflicting)
      )
        throw new TaskError(ambiguity);
      if (
        requireExplicit &&
        !clauses.some(
          (clause) =>
            webDirective.test(clause) ||
            (/^\s*(?:(?:please|por favor)[,\s]+)?(?:do not|don['’]t|never|nao|nunca)\s+(?:send|deliver|post|copy|publish|envie|mande|entregue|publique|copie)\b/i.test(
              clause,
            ) &&
              noTelegramDirective.test(clause)),
        )
      )
        throw new TaskError(
          "Alterar destino requer um pedido explícito de alteração e escolha do canal.",
        );
      return "web";
    }
    // Unrecognized negative channel wording requires clarification rather than
    // silently applying the Telegram default.
    if (negativeTelegram.test(humanText)) throw new TaskError(ambiguity);
    if (
      requireExplicit &&
      (!humanText
        .split(/[.!?;\n]/)
        .some((clause) => telegramDirective.test(clause)) ||
        /[\x60]|\b(?:maybe|perhaps|talvez|should|could|would|devo|poderia|prompt|title|titulo)\b/i.test(
          humanText,
        ))
    )
      throw new TaskError(
        "Alterar destino requer uma escolha explícita de canal no pedido humano.",
      );
    const captured = this.runtime.store.get(
      "SELECT 1 FROM request_telegram_routes WHERE conversationId=? AND requestId=?",
      origin.conversationId,
      origin.requestId,
    );
    const hasTopic =
      this.runtime.store.telegramThread(origin.conversationId) !== undefined;
    return captured || hasTopic || origin.source === "telegram"
      ? "web_telegram"
      : (requested ?? "web");
  }
  private destination(
    delivery: TaskDelivery,
    conversationId: string,
    origin?: TaskOrigin,
  ) {
    let route: TelegramRoute | undefined;
    if (delivery === "web_telegram") {
      const captured =
        origin &&
        this.runtime.store.get<
          TelegramRoute & { state: string; reason: string | null }
        >(
          "SELECT * FROM request_telegram_routes WHERE conversationId=? AND requestId=?",
          origin.conversationId,
          origin.requestId,
        );
      if (
        captured ||
        origin?.source === "telegram" ||
        (origin &&
          this.runtime.store.telegramThread(origin.conversationId) !==
            undefined)
      ) {
        if (
          !captured ||
          captured.state !== "authorized" ||
          !telegramRouteAuthorized(this.runtime.store, captured)
        )
          throw new TaskError(
            "Rota Telegram da origem ausente ou revogada. A tarefa não foi criada; selecione explicitamente um destino para uma nova solicitação.",
          );
        route = captured;
      } else
        route = telegramConversationRoute(this.runtime.store, conversationId);
    }
    if (delivery === "web_telegram" && !route)
      throw new TaskError(
        "Telegram não está conectado e autorizado para esta conversa. Selecione um destino autorizado.",
      );
    return {
      destinationChat: route?.chat ?? null,
      destinationUser: route?.user ?? null,
      destinationBotId: route?.botId ?? null,
      destinationMessageThreadId: route?.messageThreadId ?? null,
      destinationReason:
        delivery === "legacy"
          ? "Destino legado não comprovado. Selecione o destino para execuções futuras."
          : null,
    };
  }
  private newDelivery(value: unknown, allowLegacy = false): TaskDelivery {
    if (
      value === "none" ||
      value === "web" ||
      value === "web_telegram" ||
      (allowLegacy && value === "legacy")
    )
      return value;
    throw new TaskError(
      "Destino inválido: use origin (tópico de origem) ou none (sem entrega)",
    );
  }
  remove(id: string) {
    if (this.closing) throw new TaskError("Agendador encerrando");
    this.require(id);
    // Preserve admitted occurrences and their conversations, even across a restart.
    this.runtime.store.run(
      "UPDATE tasks SET deleted=1,enabled=0,nextRun=NULL WHERE id=?",
      id,
    );
  }
  runs(
    id: string,
    filter: { since?: number; until?: number; limit?: number } = {},
  ): TaskRun[] {
    const conditions = ["taskId=?"];
    const values: number[] = [];
    if (filter.since !== undefined) {
      conditions.push("scheduledAt>=?");
      values.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("scheduledAt<=?");
      values.push(filter.until);
    }
    return this.runtime.store.all<TaskRun>(
      `${RUN_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
      id,
      ...values,
      Math.min(Math.max(Math.trunc(filter.limit ?? 20), 1), 50),
    );
  }
  /** Settle one admitted occurrence with its outcome. Called when the request settles. */
  finishRun(
    conversationId: string,
    requestId: string,
    outcome: {
      status: "ok" | "erro" | "silencioso";
      summary: string;
      /** Why it failed, as pi-durable reported it; null keeps any existing value. */
      error?: string | null;
      external: string | null;
    },
  ) {
    const state = outcome.status === "erro" ? "failed" : "done";
    this.runtime.store.run(
      "UPDATE task_runs SET finishedAt=?,state=?,status=?,summary=?,error=COALESCE(?,error),external=? WHERE requestId=? AND COALESCE(conversationId,(SELECT conversationId FROM tasks WHERE id=task_runs.taskId))=?",
      this.clock(),
      state,
      outcome.status,
      truncateTaskSummary(outcome.summary, 1000),
      outcome.error ?? null,
      outcome.external,
      requestId,
      conversationId,
    );
    for (const row of this.runtime.store.all<{ id: string }>(
      "SELECT id FROM task_runs WHERE requestId=? AND COALESCE(conversationId,(SELECT conversationId FROM tasks WHERE id=task_runs.taskId))=?",
      requestId,
      conversationId,
    ))
      this.admitted.delete(row.id);
  }
  private sweptAt = 0;
  private watchedAt = 0;
  private runTimeoutMs() {
    const minutes = Number(process.env.TASK_RUN_TIMEOUT_MIN);
    return (
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_RUN_TIMEOUT_MIN) * 60_000
    );
  }
  private sweepRuns() {
    const now = this.clock();
    if (now - this.sweptAt < RUN_SWEEP_MS) return;
    this.sweptAt = now;
    const store = this.runtime.store;
    store.run(
      "DELETE FROM task_runs WHERE state!='pending' AND scheduledAt<?",
      now - RUN_RETENTION_MS,
    );
    store.run(
      "DELETE FROM task_run_keys WHERE runId NOT IN (SELECT id FROM task_runs)",
    );
  }
  /** Closes runs that started but never settled; alerts the destination once. */
  private watchStaleRuns() {
    const now = this.clock();
    if (now - this.watchedAt < RUN_WATCH_MS) return;
    this.watchedAt = now;
    const store = this.runtime.store;
    const timeout = this.runTimeoutMs();
    for (const run of store.all<PendingRun & { timeoutNotified: number }>(
      `SELECT r.*,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId
       WHERE r.state='pending' AND r.startedAt IS NOT NULL AND r.finishedAt IS NULL
         AND r.startedAt<?`,
      now - timeout,
    )) {
      const summary = `Execução expirou após ${Math.round(timeout / 60_000)} minutos sem conclusão.`;
      store.run(
        "UPDATE task_runs SET state='failed',finishedAt=?,status='erro',summary=?,error=COALESCE(error,?) WHERE id=?",
        now,
        summary.slice(0, 400),
        summary,
        run.id,
      );
      store.run(
        "UPDATE requests SET status='stale' WHERE conversationId=? AND requestId=? AND status='pending'",
        run.conversationId,
        run.requestId,
      );
      store.run("UPDATE tasks SET lastError=? WHERE id=?", summary, run.taskId);
      this.admitted.delete(run.id);
      if (!run.timeoutNotified) {
        store.run("UPDATE task_runs SET timeoutNotified=1 WHERE id=?", run.id);
        queueTaskTelegram(
          store,
          run.conversationId,
          run.requestId,
          `A tarefa agendada não terminou a tempo (${summary}). Consulte /crons ou o painel web.`,
        );
      }
    }
  }
  /** True while a run of this conversation is executing: a run must not start another. */
  inFlight(conversationId: string) {
    return !!this.runtime.store.get(
      "SELECT 1 FROM task_runs WHERE conversationId=? AND state='pending' AND startedAt IS NOT NULL",
      conversationId,
    );
  }
  runNow(id: string, requestId?: string): Promise<TaskRun> {
    return this.serialize(async () => {
      const task = this.require(id);
      await this.runtime.conversation(task.conversationId);
      if (
        requestId !== undefined &&
        (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
      )
        throw new TaskError("requestId de execução inválido");
      // Bound the final Pi input key to 160 characters even for long client keys.
      const manualRequestId =
        requestId === undefined
          ? undefined
          : `task-manual:${id}:${createHash("sha256").update(requestId).digest("hex")}`;
      this.refresh();
      const run = this.claim(id, this.clock(), false, manualRequestId)!;
      await this.dispatch();
      return this.runtime.store.get<TaskRun>(
        `${RUN_SELECT} WHERE id=?`,
        run.id,
      )!;
    });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.serialize(async () => {
      this.refresh();
      // Authentication changes delay admission; do not consume an occurrence.
      if (this.runtime.store.credentialMutation) return;
      const now = this.clock();
      for (const task of this.runtime.store.all<TaskRow>(
        "SELECT * FROM tasks WHERE deleted=0 AND enabled=1 AND nextRun<=? AND conversationId NOT IN (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY nextRun",
        now,
      ))
        this.claim(task.id, now, true);
      await this.dispatch();
      this.watchStaleRuns();
      this.sweepRuns();
      this.refresh();
    }).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private claim(
    id: string,
    now: number,
    scheduled: boolean,
    manualRequestId?: string,
  ): TaskRun | undefined {
    const store = this.runtime.store;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const task = store.get<TaskRow>(
        "SELECT * FROM tasks WHERE id=? AND deleted=0",
        id,
      );
      if (task && store.conversationDeleted(task.conversationId))
        throw new TaskError("Conversa excluída");
      const pending = store.get<TaskRun>(
        "SELECT * FROM task_runs WHERE taskId=? AND state='pending'",
        id,
      );
      const existing = manualRequestId
        ? store.get<TaskRun>(
            "SELECT r.* FROM task_runs r JOIN task_run_keys k ON k.runId=r.id WHERE k.requestId=?",
            manualRequestId,
          )
        : undefined;
      if (existing) {
        store.db.exec("COMMIT");
        return existing;
      }
      if (
        !task ||
        (scheduled &&
          (!task.enabled || task.nextRun === null || task.nextRun > now))
      ) {
        store.db.exec("COMMIT");
        return undefined;
      }
      if (pending) {
        // A manual trigger never joins someone else's execution: if this schedule is
        // already running, refuse. The catch below rolls back, so no ROLLBACK here.
        if (!scheduled)
          throw new TaskError(
            "Já existe uma execução em andamento deste agendamento.",
          );
        store.db.exec("COMMIT");
        return pending;
      }
      const run: TaskRun = {
        id: randomUUID(),
        trigger: scheduled ? "scheduled" : "manual",
        scheduledAt: scheduled ? task.nextRun! : now,
        state: "pending",
        requestId: "",
        error: null,
        startedAt: null,
        finishedAt: null,
        status: null,
        summary: null,
        external: null,
        conversationId: task.conversationId,
        delivery: task.delivery,
        originSource: task.originSource,
        originConversationId: task.originConversationId,
        originRequestId: task.originRequestId,
        destinationChat: task.destinationChat,
        destinationUser: task.destinationUser,
        destinationBotId: task.destinationBotId,
        destinationMessageThreadId: task.destinationMessageThreadId,
        destinationReason: task.destinationReason,
      };
      run.requestId = manualRequestId ?? `task:${run.id}`;
      store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,requestId,scheduled,conversationId,delivery,destinationChat,destinationUser,destinationBotId,destinationMessageThreadId,destinationReason,originSource,originConversationId,originRequestId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        run.id,
        id,
        run.scheduledAt,
        run.requestId,
        scheduled ? 1 : 0,
        task.conversationId,
        task.delivery,
        task.destinationChat,
        task.destinationUser,
        task.destinationBotId,
        task.destinationMessageThreadId,
        task.destinationReason,
        task.originSource,
        task.originConversationId,
        task.originRequestId,
      );
      if (manualRequestId)
        store.run(
          "INSERT INTO task_run_keys VALUES (?,?)",
          manualRequestId,
          run.id,
        );
      if (scheduled) {
        // After downtime execute ONE overdue occurrence; skip the backlog by advancing from now.
        const nextRun =
          task.kind === "cron"
            ? nextCron(task.schedule, task.timezone, now)
            : null;
        store.run(
          "UPDATE tasks SET nextRun=?,enabled=?,lastError=destinationReason WHERE id=?",
          nextRun,
          task.kind === "cron" ? 1 : 0,
          id,
        );
      }
      store.db.exec("COMMIT");
      return run;
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private refresh() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      "SELECT r.*,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending'",
    )) {
      const request = store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
        run.conversationId,
        run.requestId,
      );
      if (!request || request.status === "pending") continue;
      if (run.finishedAt !== null) {
        this.admitted.delete(run.id);
        continue;
      }
      // A successful turn is settled by monitorSubmission (summary, delivery, status).
      if (request.status === "done") {
        store.run(
          "UPDATE task_runs SET state='done',finishedAt=?,status=COALESCE(status,'silencioso'),summary=COALESCE(summary,'') WHERE id=?",
          Date.now(),
          run.id,
        );
        this.admitted.delete(run.id);
        continue;
      }
      const error = `Solicitação terminou com status: ${request.status}`;
      store.run(
        "UPDATE task_runs SET state='failed',error=COALESCE(error,?),finishedAt=?,status=COALESCE(status,'erro'),summary=COALESCE(summary,?) WHERE id=?",
        error,
        Date.now(),
        `A tarefa não foi concluída: ${error}`,
        run.id,
      );
      store.run(
        "UPDATE tasks SET lastError=COALESCE(?,destinationReason) WHERE id=?",
        error,
        run.taskId,
      );
      this.admitted.delete(run.id);
    }
  }
  private async dispatch() {
    const store = this.runtime.store;
    for (const run of store.all<PendingRun>(
      "SELECT r.*,t.prompt FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE r.state='pending' ORDER BY r.rowid",
    )) {
      if (this.admitted.has(run.id)) continue;
      if (
        this.inFlight(run.conversationId) &&
        !store.get(
          "SELECT 1 FROM task_runs WHERE id=? AND startedAt IS NOT NULL",
          run.id,
        )
      )
        continue;
      // A login may start between two awaited admissions. Keep unsent runs
      // pending with the same requestId so a later tick can admit them once.
      if (store.credentialMutation) return;
      try {
        // Replayed after a crash with the SAME requestId; Runtime/Pi deduplicate admission.
        await this.runtime.submit(
          run.conversationId,
          run.requestId,
          run.prompt,
          "task",
          null,
        );
        this.admitted.add(run.id);
        store.run(
          "UPDATE task_runs SET startedAt=? WHERE id=? AND startedAt IS NULL",
          this.clock(),
          run.id,
        );
      } catch (cause) {
        // Model settings and archive reservations can temporarily block the
        // conversation before admission. Retry this unsent run on the next tick.
        if (cause instanceof ConversationBusyError) continue;
        const error = cause instanceof Error ? cause.message : String(cause);
        store.run(
          "UPDATE tasks SET lastError=COALESCE(?,destinationReason) WHERE id=?",
          error,
          run.taskId,
        );
        const request = store.get(
          "SELECT requestId FROM requests WHERE conversationId=? AND requestId=?",
          run.conversationId,
          run.requestId,
        );
        // A committed input may still execute. Preserve it for idempotent recovery.
        if (!request) {
          store.savepoint("task_admission_failure", () => {
            queueTaskTelegram(
              store,
              run.conversationId,
              run.requestId,
              "A tarefa não pôde iniciar. Confira sua conexão e o estado da tarefa em /crons no Telegram ou no painel web do canal de origem.",
            );
            store.run(
              "UPDATE task_runs SET state='failed',error=? WHERE id=?",
              error,
              run.id,
            );
          });
        }
      }
    }
  }
  start() {
    if (this.closing) throw new TaskError("Agendador encerrando");
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch((error: unknown) => {
        if (!this.closing) logFailure("Falha no agendador de tarefas", error);
      });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.tail;
    this.refresh();
  }
}
