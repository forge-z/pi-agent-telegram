import type { Store } from "./store.js";
import { topicRouteKey } from "./telegram-controls.js";
import type { TelegramOwner } from "./telegram-chats.js";

/** Only proven owners/aliases: ambiguous old deliveries must survive. */
export function ownedDeliveries(id: string) {
  return {
    sql: `SELECT d.id FROM deliveries d WHERE (
      d.id IN (SELECT deliveryId FROM delivery_conversations WHERE conversationId=?)
      OR d.id IN (SELECT deliveryId FROM telegram_delivery_scopes WHERE conversationId=?)
      OR substr(d.id,1,?)=?
      OR d.id IN (SELECT p.deliveryId FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE n.conversationId=?)
      OR EXISTS (SELECT 1 FROM meta m WHERE m.key GLOB 'telegram:update:*'
        AND (d.id='decision:'||substr(m.key,17) OR d.id='link:'||m.key OR substr(d.id,1,length('command:telegram:'||substr(m.key,17)||':'))='command:telegram:'||substr(m.key,17)||':')
        AND CASE WHEN json_valid(m.value) THEN CAST(COALESCE(json_extract(m.value,'$.conversationId'),json_extract(m.value,'$.linked')) AS TEXT)=? ELSE 0 END))
      AND NOT EXISTS (SELECT 1 FROM delivery_conversations o WHERE o.deliveryId=d.id AND o.conversationId!=?)
      AND NOT EXISTS (SELECT 1 FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE p.deliveryId=d.id AND n.conversationId!=?)
      AND NOT EXISTS (SELECT 1 FROM telegram_delivery_scopes s WHERE s.deliveryId=d.id AND s.conversationId IS NOT NULL AND s.conversationId!=?)`,
    args: [id, id, id.length + 1, `${id}:`, id, id, id, id, id],
  };
}

/** Same association set for the pending panel, archive guard and reconciliation.
 * Explicit owners win over legacy route inference. Chat-only ambiguity is shown
 * only on the linked web anchor, never on every conversation in that chat.
 * This selects affected rows; it does not confer ownership for physical purge.
 */
export function conversationDeliveries(store: Store, id: string) {
  const owned = ownedDeliveries(id);
  const routes = store.all<TelegramOwner>(
    `SELECT d.chat,d.user,p.messageThreadId FROM telegram_conversations d LEFT JOIN telegram_topic_conversations p ON p.conversationId=d.conversationId WHERE d.conversationId=?
     UNION SELECT chat,user,NULL FROM telegram WHERE conversationId=?`,
    id,
    id,
  );
  const sql = [
    owned.sql,
    "SELECT deliveryId AS id FROM telegram_control_parts WHERE conversationId=?",
  ];
  const args: (string | number | null)[] = [...owned.args, id];
  // A scope with a captured conversation stays tied to that conversation even
  // after the main binding is changed. Null owners retain their exact topic route.
  sql.push(
    "SELECT deliveryId AS id FROM telegram_delivery_scopes WHERE conversationId=?",
  );
  args.push(id);
  for (const route of routes) {
    sql.push(
      "SELECT deliveryId AS id FROM telegram_control_parts WHERE conversationId=?",
    );
    args.push(
      topicRouteKey({
        ...route,
        messageThreadId: route.messageThreadId ?? undefined,
      }),
    );
    sql.push(`SELECT d.id FROM deliveries d WHERE d.chat=? AND d.messageThreadId IS ?
      AND NOT EXISTS (SELECT 1 FROM delivery_conversations o WHERE o.deliveryId=d.id)
      AND NOT EXISTS (SELECT 1 FROM task_notification_parts p WHERE p.deliveryId=d.id)
      AND NOT EXISTS (SELECT 1 FROM telegram_control_parts p WHERE p.deliveryId=d.id)
      AND d.id NOT GLOB '[0-9]*:*'
      AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key GLOB 'telegram:update:*' AND (d.id='decision:'||substr(m.key,17) OR d.id='link:'||m.key) AND CASE WHEN json_valid(m.value) THEN COALESCE(json_extract(m.value,'$.conversationId'),json_extract(m.value,'$.linked')) IS NOT NULL ELSE 0 END)
      AND (
        EXISTS (SELECT 1 FROM telegram_delivery_scopes s WHERE s.deliveryId=d.id AND s.conversationId IS NULL AND s.chat=? AND s.user=? AND s.messageThreadId IS ?)
        OR (NOT EXISTS (SELECT 1 FROM telegram_delivery_scopes s WHERE s.deliveryId=d.id)
          AND EXISTS (SELECT 1 FROM meta m WHERE m.key='telegram:control-route:'||d.id AND CASE WHEN json_valid(m.value) THEN json_extract(m.value,'$.chat')=? AND json_extract(m.value,'$.user')=? AND json_extract(m.value,'$.messageThreadId') IS ? ELSE 0 END))
        OR (?=1 AND NOT EXISTS (SELECT 1 FROM telegram_delivery_scopes s WHERE s.deliveryId=d.id)
          AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key='telegram:control-route:'||d.id
            AND CASE WHEN json_valid(m.value) THEN
              json_type(m.value,'$.chat')='text' AND length(json_extract(m.value,'$.chat'))>0
              AND json_type(m.value,'$.user')='text' AND length(json_extract(m.value,'$.user'))>0
              AND (json_type(m.value,'$.messageThreadId') IS NULL OR json_type(m.value,'$.messageThreadId')='null'
                OR (json_type(m.value,'$.messageThreadId')='integer' AND json_extract(m.value,'$.messageThreadId')>0))
              ELSE 0 END))
      )`);
    args.push(
      route.chat,
      route.messageThreadId ?? null,
      route.chat,
      route.user,
      route.messageThreadId ?? null,
      route.chat,
      route.user,
      route.messageThreadId ?? null,
      route.messageThreadId == null &&
        !!store.get(
          "SELECT 1 FROM telegram WHERE conversationId=? AND chat=? AND user=?",
          id,
          route.chat,
          route.user,
        )
        ? 1
        : 0,
    );
  }
  return { sql: sql.join(" UNION "), args };
}
