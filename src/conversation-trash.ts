import { discardTelegramControls } from "./telegram-controls.js";
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import {
  conversationDeliveries,
  ownedDeliveries,
} from "./telegram-deliveries.js";
import type { Store } from "./store.js";

export const CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export class TrashBlockedError extends Error {}

/**
 * Physical layouts this purge can read. v1 is the original durable schema.
 * v2 rebuilds `tasks` only so a task may be `sleeping`; every column stays the
 * same. A later version is refused until these checks are audited against it.
 */
const DURABLE_PURGE_SCHEMA_VERSIONS = new Set([1, 2]);

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const optional = (
  record: Record<string, unknown>,
  key: string,
  valid: (value: unknown) => boolean,
) => !Object.hasOwn(record, key) || valid(record[key]);

/** Shape checks complement index comparisons: absent values differ from malformed null/arrays. */
function supportedRecord(record: unknown, type: string): boolean {
  if (!object(record) || !identity(record.id)) return false;
  switch (type) {
    case "conversation":
      return (
        optional(
          record,
          "owner",
          (value) =>
            object(value) &&
            identity(value.conversationId) &&
            identity(value.taskId),
        ) &&
        optional(
          record,
          "parent",
          (value) =>
            object(value) &&
            identity(value.conversationId) &&
            identity(value.at),
        )
      );
    case "entry":
      return (
        identity(record.conversationId) &&
        typeof record.kind === "string" &&
        optional(record, "head", identity) &&
        optional(record, "byTaskId", identity) &&
        optional(
          record,
          "edits",
          (value) =>
            Array.isArray(value) &&
            value.every(
              (edit) =>
                object(edit) &&
                identity(edit.target) &&
                (edit.action === "omit" ||
                  (edit.action === "replace" && Array.isArray(edit.messages))),
            ),
        )
      );
    case "task": {
      const state = record.state;
      if (
        !identity(record.conversationId) ||
        typeof record.kind !== "string" ||
        !identity(record.version) ||
        typeof record.background !== "boolean" ||
        typeof record.abortRequested !== "boolean" ||
        !optional(record, "owner", identity) ||
        !object(state)
      )
        return false;
      if (state.status === "waiting")
        return (
          Object.hasOwn(state, "checkpoint") &&
          Array.isArray(state.on) &&
          state.on.every(identity) &&
          (state.policy === "allSettled" || state.policy === "failFast")
        );
      if (state.status === "pending" || state.status === "running")
        return Object.hasOwn(state, "checkpoint");
      if (state.status === "sleeping")
        return (
          Object.hasOwn(state, "checkpoint") &&
          typeof state.until === "number" &&
          Number.isFinite(state.until)
        );
      return (
        (state.status === "terminal" || state.status === "completing") &&
        object(state.outcome) &&
        ["completed", "failed", "aborted", "orphaned", "faulted"].includes(
          String(state.outcome.status),
        )
      );
    }
    case "submission":
      return (
        identity(record.conversationId) &&
        (record.type === "input" || record.type === "write") &&
        ["queued", "placed", "done", "unanswered"].includes(
          String(record.status),
        ) &&
        optional(record, "entry", identity) &&
        optional(record, "answer", identity) &&
        (record.status !== "placed" ||
          (record.type === "input" && identity(record.entry))) &&
        (record.status !== "done" ||
          (identity(record.entry) &&
            (record.type === "write" || identity(record.answer))))
      );
    case "document": {
      const scope = record.scope;
      if (
        typeof record.kind !== "string" ||
        !identity(record.createdAt) ||
        !optional(record, "retiredAt", identity) ||
        !optional(record, "key", (value) => typeof value === "string") ||
        !object(scope)
      )
        return false;
      if (scope.kind === "session")
        return (
          !Object.hasOwn(scope, "conversationId") &&
          !Object.hasOwn(scope, "taskId")
        );
      if (scope.kind === "task")
        return (
          identity(scope.taskId) && !Object.hasOwn(scope, "conversationId")
        );
      return (
        scope.kind === "conversation" &&
        identity(scope.conversationId) &&
        !Object.hasOwn(scope, "taskId") &&
        (record.history === "latest" || record.history === "rewindable") &&
        (record.fork === "initial" ||
          record.fork === "current" ||
          (record.history === "rewindable" && record.fork === "asOf"))
      );
    }
    default:
      return false;
  }
}

export function assertAppPurgeSafe(store: Store, id: string) {
  if (
    store.get(
      `SELECT 1 FROM delivery_conversations d JOIN task_notification_parts p ON p.deliveryId=d.deliveryId JOIN task_notifications n ON n.id=p.notificationId WHERE (d.conversationId=? AND n.conversationId!=?) OR (n.conversationId=? AND d.conversationId!=?)`,
      id,
      id,
      id,
      id,
    )
  )
    throw new TrashBlockedError(
      "Metadados do histórico inconsistentes. A exclusão permanente foi bloqueada.",
    );
  const queries = [
    "SELECT 1 FROM requests WHERE conversationId=? AND COALESCE(status,'') NOT IN ('done','unanswered','failed','revoked')",
    "SELECT 1 FROM actions WHERE conversationId=? AND COALESCE(state,'') NOT IN ('done','failed','denied','reconciled')",
    "SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE t.conversationId=? AND COALESCE(r.state,'') NOT IN ('done','failed')",
  ];
  for (const query of queries)
    if (store.get(query, id))
      throw new TrashBlockedError(
        "Há operação pendente ou resultado externo sem resolução. Resolva antes de excluir.",
      );
  for (const [table, states] of [
    ["mcp_calls", "'done','failed','reconciled','abandoned'"],
    ["mcp_interactions", "'responded','expired'"],
  ])
    if (
      store.get(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        table,
      ) &&
      store.get(
        `SELECT 1 FROM ${table} WHERE conversationId=? AND COALESCE(state,'') NOT IN (${states})`,
        id,
      )
    )
      throw new TrashBlockedError(
        "Há operação pendente ou resultado externo sem resolução. Resolva antes de excluir.",
      );
  const deliveries = conversationDeliveries(store, id);
  if (
    store.get(
      `SELECT 1 FROM deliveries WHERE COALESCE(state,'') NOT IN ('pending','sent','cancelled','failed','reconciled') AND id IN (${deliveries.sql})`,
      ...deliveries.args,
    )
  )
    throw new TrashBlockedError(
      "Há entrega em execução ou sem resolução. Verifique antes de excluir.",
    );
}

/** Version-bound ownership checks run in the same transaction as physical removal. */
export async function assertDurablePurgeSafe(tx: SqliteExecutor, id: number) {
  if (id === 1)
    throw new TrashBlockedError(
      "A conversa raiz não pode ser excluída permanentemente.",
    );
  const schema = await tx.get<{ version: number }>(
    "SELECT version FROM durable_schema WHERE singleton=1",
  );
  if (!DURABLE_PURGE_SCHEMA_VERSIONS.has(schema?.version ?? -1))
    throw new TrashBlockedError(
      "Versão do histórico incompatível com exclusão permanente.",
    );
  // SQL indexes are denormalized copies of record identities. Never trust them
  // for destructive scope selection when stored JSON disagrees (even at v1).
  const metadata = [
    {
      table: "conversations",
      type: "conversation",
      invalid: `owner_conversation_id IS NOT json_extract(record,'$.owner.conversationId') OR owner_task_id IS NOT json_extract(record,'$.owner.taskId') OR (json_type(record,'$.parent') IS NOT NULL AND (json_type(record,'$.parent')!='object' OR json_type(record,'$.parent.conversationId') IS NOT 'integer' OR json_type(record,'$.parent.at') IS NOT 'integer'))`,
    },
    {
      table: "entries",
      type: "entry",
      invalid: `conversation_id IS NOT json_extract(record,'$.conversationId') OR json_type(record,'$.conversationId') IS NOT 'integer' OR head IS NOT json_extract(record,'$.head')`,
    },
    {
      table: "tasks",
      type: "task",
      invalid: `conversation_id IS NOT json_extract(record,'$.conversationId') OR json_type(record,'$.conversationId') IS NOT 'integer' OR status IS NOT json_extract(record,'$.state.status') OR kind IS NOT json_quote(json_extract(record,'$.kind')) OR abort_requested IS NOT CASE json_extract(record,'$.abortRequested') WHEN 1 THEN 1 WHEN 0 THEN 0 END OR background IS NOT CASE json_extract(record,'$.background') WHEN 1 THEN 1 WHEN 0 THEN 0 END`,
    },
    {
      table: "submissions",
      type: "submission",
      invalid: `conversation_id IS NOT json_extract(record,'$.conversationId') OR json_type(record,'$.conversationId') IS NOT 'integer' OR status IS NOT json_extract(record,'$.status') OR json_extract(record,'$.type') NOT IN ('input','write')`,
    },
    {
      table: "documents",
      type: "document",
      invalid: `scope_kind IS NOT json_extract(record,'$.scope.kind') OR owner_id IS NOT CASE scope_kind WHEN 'session' THEN 0 WHEN 'conversation' THEN json_extract(record,'$.scope.conversationId') WHEN 'task' THEN json_extract(record,'$.scope.taskId') END OR kind IS NOT json_quote(json_extract(record,'$.kind')) OR family IS NOT CASE WHEN json_type(record,'$.key') IS NULL THEN 0 ELSE 1 END OR key_value IS NOT json_quote(COALESCE(json_extract(record,'$.key'),'')) OR created_at IS NOT json_extract(record,'$.createdAt') OR retired_at IS NOT json_extract(record,'$.retiredAt')`,
    },
  ];
  for (const candidate of metadata) {
    if (
      await tx.get(
        `SELECT 1 FROM ${candidate.table} r WHERE json_type(record) IS NOT 'object' OR json_type(record,'$.id') IS NOT 'integer' OR id IS NOT json_extract(record,'$.id') OR id<1 OR id>9007199254740991 OR (${candidate.invalid}) OR NOT EXISTS (SELECT 1 FROM record_ids ri WHERE ri.id=r.id AND ri.record_type=?)`,
        candidate.type,
      )
    )
      throw new TrashBlockedError(
        "Metadados do histórico inconsistentes. A exclusão permanente foi bloqueada.",
      );
    for (const row of await tx.all<{ record: string }>(
      `SELECT record FROM ${candidate.table}`,
    ))
      if (!supportedRecord(JSON.parse(row.record), candidate.type))
        throw new TrashBlockedError(
          "Metadados do histórico inconsistentes. A exclusão permanente foi bloqueada.",
        );
  }
  if (
    (await tx.get(
      "SELECT 1 FROM tasks WHERE conversation_id=? AND status!='terminal'",
      id,
    )) ||
    (await tx.get(
      "SELECT 1 FROM submissions WHERE conversation_id=? AND status IN ('queued','placed')",
      id,
    ))
  )
    throw new TrashBlockedError(
      "Há execução pendente. Aguarde sua conclusão antes de excluir.",
    );
  const ownTasks = "SELECT id FROM tasks WHERE conversation_id=?";
  const ownEntries = "SELECT id FROM entries WHERE conversation_id=?";
  const references = [
    {
      sql: `SELECT 1 FROM conversations WHERE id!=? AND (owner_conversation_id=? OR owner_task_id IN (${ownTasks}) OR json_extract(record,'$.parent.conversationId')=? OR json_extract(record,'$.owner.conversationId')=? OR json_extract(record,'$.owner.taskId') IN (${ownTasks}))`,
      args: [id, id, id, id, id, id],
    },
    {
      sql: `SELECT 1 FROM tasks WHERE conversation_id!=? AND (json_extract(record,'$.owner') IN (${ownTasks}) OR EXISTS (SELECT 1 FROM json_each(record,'$.state.on') dependency WHERE dependency.value IN (${ownTasks})))`,
      args: [id, id, id],
    },
    {
      sql: `SELECT 1 FROM entries WHERE conversation_id!=? AND (head IN (${ownEntries}) OR json_extract(record,'$.byTaskId') IN (${ownTasks}) OR EXISTS (SELECT 1 FROM json_each(record,'$.edits') e WHERE json_extract(e.value,'$.target') IN (${ownEntries})))`,
      args: [id, id, id, id],
    },
    {
      sql: `SELECT 1 FROM submissions WHERE conversation_id!=? AND (json_extract(record,'$.entry') IN (${ownEntries}) OR json_extract(record,'$.answer') IN (${ownEntries}))`,
      args: [id, id, id],
    },
  ];
  for (const reference of references)
    if (await tx.get(reference.sql, ...reference.args))
      throw new TrashBlockedError(
        "Outra conversa depende deste histórico. A exclusão permanente foi bloqueada.",
      );
}

export async function removeDurableHistory(tx: SqliteExecutor, id: number) {
  const docs =
    "SELECT id FROM documents WHERE (scope_kind='conversation' AND owner_id=?) OR (scope_kind='task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id=?))";
  await tx.run(
    `DELETE FROM document_revisions WHERE document_id IN (${docs})`,
    id,
    id,
  );
  await tx.run(
    `DELETE FROM record_ids WHERE (record_type='document' AND id IN (${docs})) OR (record_type='conversation' AND id=?) OR (record_type='entry' AND id IN (SELECT id FROM entries WHERE conversation_id=?)) OR (record_type='task' AND id IN (SELECT id FROM tasks WHERE conversation_id=?)) OR (record_type='submission' AND id IN (SELECT id FROM submissions WHERE conversation_id=?))`,
    id,
    id,
    id,
    id,
    id,
    id,
  );
  await tx.run(`DELETE FROM documents WHERE id IN (${docs})`, id, id);
  for (const table of ["submissions", "entries", "tasks"])
    await tx.run(`DELETE FROM ${table} WHERE conversation_id=?`, id);
  await tx.run("DELETE FROM conversations WHERE id=?", id);
  // durable_metadata is deliberately untouched; identities are never reused.
}

export function removeAppHistory(store: Store, id: string, now: number) {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    // Capture proven update aliases before erasing their ownership evidence.
    // Only the terminal update identity survives: no text, route or result.
    store.run(
      `INSERT OR IGNORE INTO telegram_purged_updates(id)
       SELECT u.id FROM telegram_updates u WHERE
         EXISTS (SELECT 1 FROM meta m WHERE m.key='telegram:update:'||u.id
           AND CASE WHEN json_valid(m.value) THEN CAST(COALESCE(json_extract(m.value,'$.conversationId'),json_extract(m.value,'$.linked')) AS TEXT)=? ELSE 0 END)
         OR EXISTS (SELECT 1 FROM requests r WHERE r.conversationId=? AND r.source='telegram' AND r.requestId='telegram:'||u.id)
         OR EXISTS (SELECT 1 FROM delivery_conversations d WHERE d.conversationId=? AND d.deliveryId='decision:'||u.id)`,
      id,
      id,
      id,
    );
    store.run(
      "DELETE FROM telegram_legacy_updates WHERE id IN (SELECT id FROM telegram_purged_updates)",
    );
    discardTelegramControls(store, id, true);
    const deliveries = ownedDeliveries(id);
    const owned = store.all<{ id: string }>(deliveries.sql, ...deliveries.args);
    for (const row of owned) {
      store.run("DELETE FROM deliveries WHERE id=?", row.id);
      store.run(
        "DELETE FROM telegram_delivery_scopes WHERE deliveryId=?",
        row.id,
      );
      store.run(
        "DELETE FROM telegram_delivery_resolutions WHERE deliveryId=?",
        row.id,
      );
      store.run(
        "DELETE FROM meta WHERE key=?",
        `telegram:control-route:${row.id}`,
      );
      store.run(
        "DELETE FROM delivery_conversations WHERE deliveryId=?",
        row.id,
      );
      store.run(
        "DELETE FROM task_notification_parts WHERE deliveryId=?",
        row.id,
      );
    }
    store.run(
      "DELETE FROM task_notification_parts WHERE notificationId IN (SELECT id FROM task_notifications WHERE conversationId=?)",
      id,
    );
    store.run("DELETE FROM task_notifications WHERE conversationId=?", id);
    store.run(
      "DELETE FROM task_run_keys WHERE runId IN (SELECT r.id FROM task_runs r JOIN tasks t ON t.id=r.taskId WHERE t.conversationId=?)",
      id,
    );
    for (const table of [
      "task_creations",
      "task_delivery_changes",
      "task_runs",
    ])
      store.run(
        `DELETE FROM ${table} WHERE taskId IN (SELECT id FROM tasks WHERE conversationId=?)`,
        id,
      );
    store.run(
      "DELETE FROM meta WHERE key GLOB 'telegram:update:*' AND CASE WHEN json_valid(value) THEN CAST(COALESCE(json_extract(value,'$.conversationId'),json_extract(value,'$.linked')) AS TEXT)=? ELSE 0 END",
      id,
    );
    store.run(
      "UPDATE meta SET value=? WHERE key=?",
      JSON.stringify({ state: "cancelled" }),
      `telegram:topic-create:${id}`,
    );
    store.run(
      "UPDATE meta SET value=? WHERE key GLOB 'telegram:native-topic-create:*' AND json_valid(value) AND CAST(json_extract(value,'$.conversationId') AS TEXT)=?",
      JSON.stringify({ state: "cancelled" }),
      id,
    );
    // reads.conversationId holds the composite key `${conversationId}:${server}:${scope}`.
    store.run(
      "DELETE FROM reads WHERE conversationId>=? AND conversationId<?",
      `${id}:`,
      `${id};`,
    );
    for (const table of [
      "requests",
      "request_telegram_routes",
      "actions",
      "telegram",
      "telegram_grants",
      "telegram_grant_versions",
      "telegram_conversations",
      "telegram_chat_selection",
      "telegram_topic_conversations",
      "telegram_topic_selection",
      "tasks",
      "conversation_titles",
      "conversation_archive_versions",
      "conversation_retention",
      "conversation_lifecycle",
      "telegram_initial_revocations",
      "delivery_conversations",
      "mcp_interactions",
      "mcp_calls",
    ])
      if (
        store.get(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
          table,
        )
      )
        store.run(`DELETE FROM ${table} WHERE conversationId=?`, id);
    store.run("DELETE FROM conversations WHERE id=?", id);
    store.run(
      "UPDATE conversation_purges SET completedAt=? WHERE conversationId=?",
      now,
      id,
    );
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
