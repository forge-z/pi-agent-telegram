import type { Runtime } from "./runtime.js";
import {
  executorUsesExecutionIdResume,
  type McpCall,
  type McpInteraction,
} from "./mcp-calls.js";
import { PolicyError } from "./mcp.js";
import { clearTelegramDeliveryPrefix, hash } from "./store.js";
import { telegramIdentity } from "./telegram-identity.js";
import { telegramConversationRoute } from "./task-telegram.js";
import {
  button,
  queueControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "./telegram-controls.js";
import { APPROVAL_EXPIRE_MS, approvalAction } from "./guards.js";
import { logFailure } from "./log.js";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const reviewVersion = 3;
const acceptGuidance =
  "Review the action, destination, and content above. The decision resumes only this pending item.";
const executorAcceptGuidance =
  "Tap **Approve this call** to continue in Executor, or **Decline** to cancel.";
const opaqueGuidance =
  "Approval unavailable: this send has no recipients or content that can be reviewed in Telegram (only a draftId or another identifier, an opaque format, or fields outside the contract). Review it in the external service. The bot does not fetch the draft, read mail, or decode content. Use the service's secure flow; do not send credentials here. You can decline this pending item.";
const closedGuidance =
  "Approval unavailable: the action, destination, or content does not meet the review contract, or it needs extra input. Identifiers, drafts, wrappers, and unknown formats need review outside Telegram. Use the service's secure flow; do not send credentials here. You can decline this pending item.";
const reviewPrefix = (id: string) => `telegram:mcp:${id}-v${reviewVersion}`;
const invisible =
  /[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u;
const mailApps = ["mail", "email", "gmail", "outlook", "microsoftoutlook"];
const mailFields: Record<string, "to" | "cc" | "bcc" | "subject" | "body"> = {
  to: "to",
  recipients: "to",
  to_addresses: "to",
  toAddresses: "to",
  cc: "cc",
  cc_addresses: "cc",
  ccAddresses: "cc",
  bcc: "bcc",
  bcc_addresses: "bcc",
  bccAddresses: "bcc",
  subject: "subject",
  body: "body",
  text: "body",
  body_text: "body",
  bodyText: "body",
};
/** An explicit, deliberately narrow contract; unknown operations/fields need external review. */
export function reviewableEmail(
  app: unknown,
  tool: unknown,
  input: unknown,
): boolean {
  if (
    typeof app !== "string" ||
    !/^[A-Za-z0-9_.:/-]+$/.test(app) ||
    typeof tool !== "string" ||
    !/^[A-Za-z0-9_.:/-]+$/.test(tool) ||
    !object(input)
  )
    return false;
  const normalize = (name: string) =>
    name.replace(/[_.:/-]/g, "").toLowerCase();
  let action = normalize(tool);
  let mailContext = mailApps.includes(normalize(app));
  const namespace = mailApps.find((name) => action.startsWith(name));
  if (namespace) {
    action = action.slice(namespace.length);
    mailContext = true;
  }
  if (
    !["sendemail", "sendmail"].includes(action) &&
    !(mailContext && ["send", "sendmessage", "messagessend"].includes(action))
  )
    return false;
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) {
    const name = Object.hasOwn(mailFields, key) ? mailFields[key] : undefined;
    if (!name || fields.has(name)) return false;
    fields.set(name, value);
  }
  const addresses = (value: unknown) => {
    const items =
      typeof value === "string" ? value.split(",").map((v) => v.trim()) : value;
    return (
      Array.isArray(items) &&
      items.length > 0 &&
      items.length <= 100 &&
      // Holes are skipped by every() and are not representable in JSON.
      Object.keys(items).length === items.length &&
      items.every(
        (v) =>
          typeof v === "string" &&
          /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
            v,
          ),
      )
    );
  };
  if (!addresses(fields.get("to"))) return false;
  for (const field of ["cc", "bcc"])
    if (fields.has(field) && !addresses(fields.get(field))) return false;
  const subject = fields.get("subject"),
    body = fields.get("body");
  if (
    typeof subject !== "string" ||
    typeof body !== "string" ||
    !body.trim() ||
    invisible.test(subject) ||
    invisible.test(body) ||
    /[\r\n]/.test(subject)
  )
    return false;
  // No implicit MIME, HTML, template expansion or encoded message blobs.
  if (
    /<!--|<!doctype|<\/?[A-Za-z][^>]*>|\{\{|\$\{|<%|data:[^\s]*;base64,/i.test(
      body,
    )
  )
    return false;
  const trimmed = body.trim();
  if (
    trimmed
      .split(/\r?\n/)
      .every((line) => /^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(line)) ||
    /^[A-Za-z0-9+/_-]+={1,2}$/.test(trimmed)
  )
    return false;
  return true;
}
const referenceKeys = [
  "draftid",
  "messageid",
  "templateid",
  "threadid",
  "raw",
  "mime",
  "rfc822",
];
function foldName(name: string) {
  return name
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Cc}]/gu, "")
    .replace(/[_.:/-]/g, "")
    .toLowerCase();
}
/**
 * Several independent signals, not one tool name. A match only selects the
 * external-review message; it never authorizes approval or reads a mailbox.
 */
export function looksLikeMailSend(
  app: unknown,
  tool: unknown,
  input: unknown,
): boolean {
  const toolName = typeof tool === "string" ? foldName(tool) : "";
  const appName = typeof app === "string" ? foldName(app) : "";
  const mailContext =
    mailApps.includes(appName) ||
    mailApps.some((name) => toolName.startsWith(name));
  let action = toolName;
  const namespace = mailApps.find((name) => action.startsWith(name));
  if (namespace) action = action.slice(namespace.length);
  const sendVerb =
    ["sendemail", "sendmail", "sendmessage", "messagessend"].includes(action) ||
    (mailContext && action === "send");
  const otherMailVerb =
    [
      "senddraft",
      "draftssend",
      "reply",
      "replyemail",
      "forward",
      "forwardemail",
      "resend",
      "resendemail",
    ].includes(action) ||
    (mailContext && /draft|reply|forward|resend|send/.test(action));
  const keys = object(input) ? Object.keys(input).map(foldName) : [];
  return (
    sendVerb ||
    otherMailVerb ||
    keys.some((key) => referenceKeys.includes(key)) ||
    (keys.includes("id") && (mailContext || sendVerb || otherMailVerb))
  );
}
function closedInvocation(value: Record<string, unknown>) {
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    keys.includes("app") &&
    keys.includes("input") &&
    typeof value.tool === "string"
  );
}
/** Harmless Executor catalog/connection refresh; full invocation is shown on the card. */
function reviewableExecutorInvocation(invocation: Record<string, unknown>) {
  if (!closedInvocation(invocation)) return false;
  if (foldName(String(invocation.app)) !== "executor") return false;
  const tool = foldName(String(invocation.tool));
  return [
    "coretoolsconnectionsrefresh",
    "connectionsrefresh",
    "coretoolstoolsrefresh",
    "toolsrefresh",
  ].some((name) => tool === name || tool.endsWith(name));
}
function mailReference(invocation: Record<string, unknown> | undefined) {
  if (!invocation) return false;
  const hiddenReference = Object.keys(invocation).some(
    (key) =>
      !["app", "tool", "input"].includes(key) &&
      (referenceKeys.includes(foldName(key)) || foldName(key) === "id"),
  );
  return (
    hiddenReference ||
    looksLikeMailSend(invocation.app, invocation.tool, invocation.input)
  );
}
/** Fence length exceeds any embedded run, so Markdown/HTML cannot hide reviewed bytes. */
function literalReview(text: string) {
  const fence = "`".repeat(
    Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1,
  );
  return `${fence}\n${text}\n${fence}`;
}
function formatExpiresAt(ms: number) {
  return new Date(ms).toLocaleString("pt-BR", {
    timeZone: "UTC",
    dateStyle: "short",
    timeStyle: "short",
  });
}
const approvalAtKey = (id: string) => `telegram:approval-at:${id}`;
const approvalRemindedKey = (id: string) => `telegram:approval-reminded:${id}`;
function approvalMeta(app: Runtime, key: string) {
  const row = app.store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    key,
  );
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : undefined;
}
function rememberApproval(app: Runtime, key: string, at = Date.now()) {
  app.store.run("INSERT OR REPLACE INTO meta VALUES (?,?)", key, String(at));
}
function clearApprovalMeta(app: Runtime, id: string) {
  app.store.run(
    "DELETE FROM meta WHERE key IN (?,?)",
    approvalAtKey(id),
    approvalRemindedKey(id),
  );
}
/** The sent card's chat and message_id, or undefined until every part is out. */
function sentApprovalCard(app: Runtime, item: McpInteraction) {
  const prefix = reviewPrefix(item.id);
  const parts = app.store.all<{
    state: string;
    result: string | null;
    chat: string;
  }>(
    "SELECT state,result,chat FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
    `${prefix}:`,
    `${prefix};`,
  );
  if (!parts.length || parts.some((part) => part.state !== "sent"))
    return undefined;
  const last = parts.at(-1)!;
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = last.result
      ? (JSON.parse(last.result) as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
  const nested =
    receipt && object(receipt.result)
      ? (receipt.result as Record<string, unknown>)
      : undefined;
  const messageId = receipt?.message_id ?? nested?.message_id;
  return typeof messageId === "number" && messageId > 0
    ? { chat: last.chat, messageId }
    : undefined;
}
function remindApproval(
  app: Runtime,
  item: McpInteraction,
  card: { chat: string; messageId: number },
) {
  const route = telegramOwnerForConversation(app, item.conversationId);
  if (!route) return false;
  let tool = "";
  try {
    const invocation = (
      JSON.parse(item.payload) as { invocation?: { tool?: unknown } }
    ).invocation;
    if (typeof invocation?.tool === "string") tool = ` (${invocation.tool})`;
  } catch {
    /* malformed payload still gets the reminder */
  }
  queueControl(
    app,
    `telegram:mcp-reminder:${item.id}`,
    route.owner,
    item.conversationId,
    `**MCP approval still pending${tool}**\n\nThe original card is still waiting for your decision. Use its buttons to approve or decline; with no answer, the pending item expires in 24 hours.`,
    undefined,
    card.messageId,
  );
  return true;
}
async function expireApproval(
  app: Runtime,
  item: McpInteraction,
  card: { chat: string; messageId: number } | undefined,
  edit?: (
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ) => Promise<unknown>,
) {
  app.store.savepoint("mcp_expire_unanswered", () => {
    app.store.run(
      "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
      item.id,
    );
    app.store.run(
      "UPDATE mcp_calls SET state='abandoned',updatedAt=? WHERE id=? AND state='paused'",
      Date.now(),
      item.callId,
    );
  });
  clearApprovalMeta(app, item.id);
  const text =
    "MCP approval expired — nobody answered within 24 hours. The pending item was declined and no resume was sent.";
  if (card && edit) {
    try {
      await edit(card.chat, card.messageId, text, { inline_keyboard: [] });
      return;
    } catch (error) {
      logFailure("Failed to edit expired MCP card", error);
    }
  }
  if (!card) return;
  const route = telegramOwnerForConversation(app, item.conversationId);
  if (route)
    queueControl(
      app,
      `telegram:mcp-expired:${item.id}`,
      route.owner,
      item.conversationId,
      `**${text}**`,
    );
}
/** One poller tick: remind once after 4h, then expire and deny after 24h. */
export async function sweepMcpApprovals(
  app: Runtime,
  edit?: (
    chat: string,
    messageId: number,
    text: string,
    markup: TelegramReplyMarkup,
  ) => Promise<unknown>,
) {
  if (!app.mcpCalls) return;
  const now = Date.now();
  for (const item of app.store.all<McpInteraction>(
    "SELECT * FROM mcp_interactions WHERE state='pending'",
  )) {
    const at = approvalMeta(app, approvalAtKey(item.id));
    if (at === undefined) {
      rememberApproval(app, approvalAtKey(item.id), now);
      continue;
    }
    const action = approvalAction(
      now - at,
      approvalMeta(app, approvalRemindedKey(item.id)) !== undefined,
    );
    if (!action) continue;
    const card = sentApprovalCard(app, item);
    if (action === "expire") {
      await expireApproval(app, item, card, edit);
      continue;
    }
    if (card && remindApproval(app, item, card))
      rememberApproval(app, approvalRemindedKey(item.id), now);
  }
}
function isSyntheticExecutorExecutionInvocation(
  invocation: Record<string, unknown> | undefined,
) {
  if (!invocation || !closedInvocation(invocation)) return false;
  if (foldName(String(invocation.app)) !== "executor") return false;
  if (foldName(String(invocation.tool)) !== "execute") return false;
  const input = object(invocation.input) ? invocation.input : {};
  const keys = Object.keys(input);
  return keys.length === 1 && keys[0] === "executionId";
}
function formatExecutorRefreshInvocation(invocation: Record<string, unknown>) {
  const input = object(invocation.input) ? invocation.input : {};
  const address =
    typeof input.address === "string"
      ? input.address
      : typeof input.connection === "string"
        ? input.connection
        : undefined;
  const lines = ["**Refresh tool catalog (Executor)**", ""];
  lines.push(`Tool: \`${String(invocation.tool)}\``);
  if (address) lines.push(`Connection: \`${address}\``);
  return lines.join("\n");
}
function formatMailInvocationHuman(invocation: Record<string, unknown>) {
  const input = object(invocation.input) ? invocation.input : {};
  const lines = ["**Send email**", ""];
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  const to = pick("to", "recipients", "to_addresses", "toAddresses");
  if (to) lines.push(`To: ${Array.isArray(to) ? to.join(", ") : to}`);
  for (const [label, ...keys] of [
    ["Cc", "cc", "cc_addresses", "ccAddresses"],
    ["Bcc", "bcc", "bcc_addresses", "bccAddresses"],
  ] as const) {
    const value = pick(...keys);
    if (value)
      lines.push(
        `${label}: ${Array.isArray(value) ? value.join(", ") : value}`,
      );
  }
  const subject = pick("subject");
  if (typeof subject === "string") lines.push(`Subject: ${subject}`);
  const body = pick("body", "text", "body_text", "bodyText");
  if (typeof body === "string") {
    lines.push("");
    lines.push("Message:");
    lines.push(literalReview(body));
  }
  return lines.join("\n");
}
/** Human-facing Telegram copy; security hashing still uses reviewText JSON separately. */
export function formatMcpApprovalDisplay(
  item: McpInteraction,
  call: McpCall,
  review: {
    view: { text: string };
    canAccept: boolean;
    opaque: boolean;
    executorExecutionPause: boolean;
  },
) {
  const payload = JSON.parse(item.payload) as Record<string, unknown>;
  const elicitation = item.kind === "resume" ? payload.elicitation : payload;
  const request =
    object(elicitation) && typeof elicitation.message === "string"
      ? elicitation.message.trim()
      : "";
  const invocation =
    item.kind === "resume" && object(payload.invocation)
      ? payload.invocation
      : undefined;
  if (
    review.executorExecutionPause ||
    isSyntheticExecutorExecutionInvocation(invocation)
  )
    return request || "Confirm this action in Executor.";
  if (invocation && reviewableExecutorInvocation(invocation))
    return formatExecutorRefreshInvocation(invocation);
  if (
    !review.opaque &&
    invocation &&
    reviewableEmail(invocation.app, invocation.tool, invocation.input)
  )
    return formatMailInvocationHuman(invocation);
  if (
    !review.opaque &&
    item.kind !== "resume" &&
    reviewableEmail(call.server, call.tool, JSON.parse(call.args))
  )
    return formatMailInvocationHuman({
      app: call.server,
      tool: call.tool,
      input: JSON.parse(call.args),
    });
  if (review.opaque) {
    const hint = opaqueReferenceHint(item, call, invocation);
    if (request && hint) return `${request}\n\nReference: \`${hint}\``;
    if (request) return request;
    if (hint) return `Reference: \`${hint}\``;
  }
  // A v2 pause asks one question and then dumps the whole argument object; the
  // question is what a person needs to decide, so the dump never reaches the card.
  if (
    item.kind === "resume" &&
    payload.protocol === "executor" &&
    invocation &&
    typeof invocation.tool === "string" &&
    // The v2 pause names the app by its Executor id (`app_…`), not by a product name; a
    // named app was already formatted above.
    (invocation.app === undefined || /^app_/i.test(String(invocation.app)))
  ) {
    const question = request.split(/\n\s*\n/)[0].trim();
    return question && question.length <= 200
      ? question
      : `Approve \`${invocation.tool}\`?`;
  }

  return literalReview(review.view.text);
}
function opaqueReferenceHint(
  item: McpInteraction,
  call: McpCall,
  invocation: Record<string, unknown> | undefined,
) {
  if (invocation) {
    for (const [key, value] of Object.entries(invocation)) {
      if (["app", "tool", "input"].includes(key)) continue;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  const input =
    invocation && object(invocation.input)
      ? invocation.input
      : item.kind === "resume"
        ? undefined
        : (JSON.parse(call.args) as Record<string, unknown>);
  if (!input) return undefined;
  for (const key of [
    "draftId",
    "draft_id",
    "messageId",
    "message_id",
    "id",
    "raw",
    "note",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = input.message;
  if (object(nested) && typeof nested.body === "string" && nested.body.trim())
    return nested.body.trim();
  if (typeof input.body === "string" && input.body.trim())
    return input.body.trim();
  return undefined;
}
export function formatMcpOutcomeMessage(call: McpCall) {
  if (!call.result) return "";
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(call.result) as Record<string, unknown>;
  } catch {
    return "";
  }
  if (call.state === "done" && !result.isError) {
    const structured = object(result.structuredContent)
      ? result.structuredContent
      : undefined;
    if (structured?.status === "completed") {
      const inner = object(structured.result) ? structured.result : undefined;
      if (inner?.ok === true) return "Executor finished successfully.";
      if (inner?.ok === false)
        return "Executor reported an execution failure. Check the Executor panel.";
    }
    return "MCP call finished.";
  }
  if (result.isError) {
    const text = (Array.isArray(result.content) ? result.content : []).find(
      (part): part is { type: string; text?: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text",
    )?.text;
    if (typeof text === "string") {
      const line = text
        .split("\n")
        .find((row) => row.trim())
        ?.trim();
      if (line && line.length <= 280) return line;
      if (line) return `${line.slice(0, 277)}…`;
    }
    return "Resume failed. Check Executor or the logs.";
  }
  return "";
}
const sensitive =
  /^(?:.*(?:token|secret|password|credential|authorization|cookie)|api[_-]?key)$/i;
const tooLarge = "[Content too large to review in Telegram.]";
const escapeInvisible = (text: string) =>
  text.replace(
    new RegExp(invisible.source, "gu"),
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
/** One hiding rule for every review rendering: display may not drift from it. */
function reviewScrubber() {
  const state = {
    hidden: false,
    text(value: string) {
      let result = value;
      if (invisible.test(result)) {
        state.hidden = true;
        result = escapeInvisible(result);
      }
      return result
        .replace(/https?:\/\/[^\s"<>]+/g, (raw) => {
          try {
            const url = new URL(raw);
            if (url.username || url.password || url.search || url.hash) {
              state.hidden = true;
              return `${url.origin}${url.pathname}[private URL omitted]`;
            }
          } catch {
            state.hidden = true;
            return "[URL omitted]";
          }
          return raw;
        })
        .replace(
          /(?:sk-[\w-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,}|Bearer\s+\S+)/g,
          () => {
            state.hidden = true;
            return "[REDACTED]";
          },
        );
    },
  };
  return state;
}
/** Never approve a review whose content had to be hidden or abbreviated.
 * Approval cards keep the literal JSON: `reviewHash` signs those exact bytes. */
export function reviewText(value: unknown, redact?: (text: string) => string) {
  const scrub = reviewScrubber();
  let serialized =
    JSON.stringify(
      value,
      (key, item: unknown) => {
        if (sensitive.test(key)) {
          scrub.hidden = true;
          return "[REDACTED]";
        }
        return typeof item === "string" ? scrub.text(item) : item;
      },
      2,
    ) ?? "";
  // Property names are also untrusted; JSON.stringify does not escape bidi controls in keys.
  if (invisible.test(serialized)) {
    scrub.hidden = true;
    serialized = escapeInvisible(serialized);
  }
  const safe = redact?.(serialized) ?? serialized;
  return {
    text: safe.length <= 24000 ? safe : tooLarge,
    complete: !scrub.hidden && safe === serialized && safe.length <= 24000,
  };
}
type ReviewScrubber = ReturnType<typeof reviewScrubber>;
const isStructure = (value: unknown) => Array.isArray(value) || object(value);
/** Whitespace would break the layout; quoting keeps the value on its own line. */
const oneLine = (text: string) =>
  /\s/.test(text) ? JSON.stringify(text) : text;
const reviewLeaf = (value: unknown, scrub: ReviewScrubber) =>
  typeof value === "string"
    ? JSON.stringify(scrub.text(value))
    : (JSON.stringify(value) ?? String(value));
/** Fields render as `chave: valor`; arrays as numbered items; nothing is abbreviated. */
function reviewLines(
  value: unknown,
  indent: number,
  scrub: ReviewScrubber,
): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap((item, index) =>
      isStructure(item)
        ? [`${pad}${index + 1}.`, ...reviewLines(item, indent + 2, scrub)]
        : [`${pad}${index + 1}. ${reviewLeaf(item, scrub)}`],
    );
  }
  if (object(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, item]) =>
      reviewField(key, item, indent, scrub),
    );
  }
  return [`${pad}${reviewLeaf(value, scrub)}`];
}
function reviewField(
  key: string,
  value: unknown,
  indent: number,
  scrub: ReviewScrubber,
) {
  const pad = " ".repeat(indent);
  const name = scrub.text(key);
  const label = `${pad}${oneLine(name)}:`;
  if (sensitive.test(key)) {
    scrub.hidden = true;
    return [`${label} [REDACTED]`];
  }
  if (!isStructure(value)) return [`${label} ${reviewLeaf(value, scrub)}`];
  if (Array.isArray(value) && !value.length) return [`${label} []`];
  if (object(value) && !Object.keys(value).length) return [`${label} {}`];
  return [label, ...reviewLines(value, indent + 2, scrub)];
}
/** Batch shape of a `call` argument: `{calls: {path, input}}`, one or many. */
function reviewCalls(input: unknown) {
  if (!object(input) || Object.keys(input).some((key) => key !== "calls"))
    return undefined;
  const list = Array.isArray(input.calls) ? input.calls : [input.calls];
  const calls = list.map((entry) => {
    if (!object(entry) || typeof entry.path !== "string") return undefined;
    const params = Object.entries(entry).filter(([key]) => key !== "path");
    // `{path, input}` is the call contract: the fields under `input` are the parameters.
    return {
      path: entry.path,
      params:
        object(entry.input) && params.length === 1
          ? Object.entries(entry.input)
          : params,
    };
  });
  return calls.every((entry) => entry)
    ? (calls as { path: string; params: [string, unknown][] }[])
    : undefined;
}
/** Readable body for an uncertain call card. It must show exactly what was
 * called, so a shape it does not recognize is rendered field by field, never
 * abbreviated and never as a JSON blob. Hiding keeps the `reviewText` rule. */
export function formatUncertainCallReview(
  value: { server: string; tool: string; state: string; input: unknown },
  redact?: (text: string) => string,
) {
  const scrub = reviewScrubber();
  const lines = [
    "MCP call with an uncertain result",
    `Server: ${scrub.text(value.server)}`,
    `Tool: ${scrub.text(value.tool)}`,
    `State: ${scrub.text(value.state)}`,
  ];
  const calls = reviewCalls(value.input);
  const input = object(value.input) ? value.input : undefined;
  const address = [input?.path, input?.address].find(
    (item): item is string => typeof item === "string",
  );
  if (calls) {
    const paths = calls.map((entry) => oneLine(scrub.text(entry.path)));
    if (paths.length === 1) lines.push(`Target: ${paths[0]}`);
    else {
      lines.push("Target:");
      for (const [index, path] of paths.entries())
        lines.push(`  ${index + 1}. ${path}`);
    }
    lines.push("Parameters:");
    if (calls.length === 1) {
      if (!calls[0].params.length) lines.push("  (none)");
      else
        lines.push(
          ...reviewLines(Object.fromEntries(calls[0].params), 2, scrub),
        );
    } else
      for (const [index, entry] of calls.entries()) {
        lines.push(`  Call ${index + 1}:`);
        if (!entry.params.length) lines.push("    (nenhum)");
        else
          lines.push(
            ...reviewLines(Object.fromEntries(entry.params), 4, scrub),
          );
      }
  } else {
    if (address) lines.push(`Target: ${oneLine(scrub.text(address))}`);
    lines.push("Parameters:");
    lines.push(
      ...(input
        ? reviewLines(
            Object.fromEntries(
              Object.entries(input).filter(
                ([key]) => !address || (key !== "path" && key !== "address"),
              ),
            ),
            2,
            scrub,
          )
        : reviewLines(value.input, 2, scrub)),
    );
  }
  const readable = lines.join("\n");
  const safe = redact?.(readable) ?? readable;
  const oversized = safe.length > 24000 || readable.length > 24000;
  return {
    text: oversized ? tooLarge : safe,
    complete: !scrub.hidden && safe === readable && !oversized,
  };
}
function approvalReview(app: Runtime, item: McpInteraction, call: McpCall) {
  const payload = JSON.parse(item.payload) as Record<string, unknown>;
  const elicitation = item.kind === "resume" ? payload.elicitation : payload;
  const schema =
    object(elicitation) && object(elicitation.requestedSchema)
      ? elicitation.requestedSchema
      : undefined;
  const emptyForm =
    schema?.type === "object" &&
    object(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (!Array.isArray(schema.required) || schema.required.length === 0);
  const invocation =
    item.kind === "resume" && object(payload.invocation)
      ? payload.invocation
      : undefined;
  const nativeInput =
    item.kind === "resume" ? undefined : JSON.parse(call.args);
  const request = object(elicitation) ? elicitation.message : undefined;
  // The whole invocation is shown. Sibling fields must not stay off the card.
  const view = reviewText(
    item.kind === "resume"
      ? { server: item.server, invocation, request }
      : { server: item.server, action: call.tool, input: nativeInput, request },
    app.options.redact,
  );
  // URL tickets and fields that require typed/private input stay in the provider's secure flow.
  const explicit =
    item.kind === "resume"
      ? !!invocation &&
        closedInvocation(invocation) &&
        (reviewableEmail(invocation.app, invocation.tool, invocation.input) ||
          reviewableExecutorInvocation(invocation))
      : reviewableEmail(call.server, call.tool, nativeInput);
  const executorExecutionPause =
    item.kind === "resume" &&
    payload.protocol === "executor" &&
    executorUsesExecutionIdResume(payload);
  // A v2 pause is an Executor-hosted action with an empty form: there is no destination or
  // body to review, and without this it could only be declined.
  const executorHostedPause =
    item.kind === "resume" &&
    payload.protocol === "executor" &&
    // The v2 pause names its app by Executor id; a product name has a review of its own.
    (invocation?.app === undefined || /^app_/i.test(String(invocation.app)));
  const opaque =
    !explicit &&
    (item.kind === "resume"
      ? mailReference(invocation)
      : looksLikeMailSend(call.server, call.tool, nativeInput));
  const canAccept =
    item.kind !== "url" &&
    emptyForm &&
    view.complete &&
    (explicit || executorExecutionPause || (executorHostedPause && !opaque));
  return { view, canAccept, opaque, executorExecutionPause };
}

function card(app: Runtime, item: McpInteraction) {
  const payload = JSON.parse(item.payload) as Record<string, unknown>;
  const call = app.store.get<McpCall>(
    "SELECT * FROM mcp_calls WHERE id=?",
    item.callId,
  );
  let route = telegramConversationRoute(app.store, item.conversationId);
  if (!call) return;
  if (!route) {
    const dedicated = app.store.get<{ chat: string; user: string }>(
      "SELECT chat,user FROM telegram_conversations WHERE conversationId=?",
      item.conversationId,
    );
    const identity = dedicated && telegramIdentity(app.store, dedicated);
    if (
      dedicated &&
      identity &&
      app.store.get(
        "SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
        dedicated.chat,
        dedicated.user,
        item.conversationId,
      )
    ) {
      route = {
        chat: dedicated.chat,
        user: dedicated.user,
        botId: String(identity.botId),
        conversationId: item.conversationId,
        messageThreadId: app.store.telegramThread(item.conversationId) ?? null,
      };
    } else return;
  }
  const owner = {
    chat: route.chat,
    user: route.user,
    ...(route.messageThreadId == null
      ? {}
      : { messageThreadId: route.messageThreadId }),
  };
  if (
    typeof payload.expiresAt === "number" &&
    payload.expiresAt <= Date.now()
  ) {
    // Expired without a decision: the topic hears about it once, and nothing is left
    // half-open for the model to trust later.
    app.store.savepoint("mcp_expire_card", () => {
      app.store.run(
        "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
        item.id,
      );
      app.store.run(
        "UPDATE mcp_calls SET state='abandoned',updatedAt=? WHERE id=? AND state='paused'",
        Date.now(),
        item.callId,
      );
      clearApprovalMeta(app, item.id);
    });
    const invocation = payload.invocation as { tool?: unknown } | undefined;
    const tool =
      typeof invocation?.tool === "string" ? `\n\n${invocation.tool}` : "";
    queueControl(
      app,
      `telegram:mcp-expired:${item.id}`,
      owner,
      item.conversationId,
      `**MCP approval expired**${tool}\n\nNo resume was sent and the call will not be repeated. Earlier steps may have had effects; uncertain results still need verification.`,
    );
    return;
  }
  const review = approvalReview(app, item, call);
  const { view, canAccept, opaque, executorExecutionPause } = review;
  const display = formatMcpApprovalDisplay(item, call, review);
  const guidance = canAccept
    ? executorExecutionPause
      ? executorAcceptGuidance
      : acceptGuidance
    : opaque
      ? opaqueGuidance
      : closedGuidance;
  const expiresAt = Math.min(
    Date.now() + APPROVAL_EXPIRE_MS,
    typeof payload.expiresAt === "number" ? payload.expiresAt : Infinity,
  );
  const prefix = reviewPrefix(item.id);
  const existing = app.store.get<{ state: string }>(
    "SELECT state FROM deliveries WHERE id=?",
    `${prefix}:0`,
  );
  if (existing) {
    if (existing.state === "sent") return;
    if (existing.state === "pending" || existing.state === "sending") return;
    clearTelegramDeliveryPrefix(app.store, prefix);
  }
  app.store.savepoint("telegram_mcp_card", () => {
    const make = (action: "accept" | "decline") => {
      const token = button(app, {
        kind: "mcp",
        owner,
        originThreadId: route.messageThreadId,
        conversationId: item.conversationId,
        interactionId: item.id,
        interactionHash: hash(item.payload),
        authorizationVersion: app.store.authorizationVersion(
          owner,
          item.conversationId,
        ),
        decision: action,
        reviewVersion,
        reviewHash: hash(view.text),
      });
      app.store.run(
        "UPDATE meta SET value=json_set(value,'$.expiresAt',?) WHERE key=?",
        expiresAt,
        `telegram:button:${token}`,
      );
      return token;
    };
    const controls = [{ text: "Decline", callback_data: make("decline") }];
    if (canAccept)
      controls.unshift({
        text: "Approve",
        callback_data: make("accept"),
      });
    queueControl(
      app,
      prefix,
      owner,
      item.conversationId,
      `**MCP approval pending**\n\n${display}\n\n${guidance}\n\nValid until: ${formatExpiresAt(expiresAt)} UTC`,
      { inline_keyboard: [controls] },
    );
    app.store.run(
      "INSERT OR IGNORE INTO meta VALUES (?,?)",
      approvalAtKey(item.id),
      String(Date.now()),
    );
  });
}
export function queueMcpApprovals(app: Runtime) {
  if (!app.mcpCalls) return;
  for (const row of app.store.all<McpInteraction>(
    "SELECT * FROM mcp_interactions WHERE state='pending'",
  )) {
    // An expired request still needs its topic told, so the card decides.
    card(app, row);
  }
}

function telegramOwnerForConversation(app: Runtime, conversationId: string) {
  let route = telegramConversationRoute(app.store, conversationId);
  if (!route) {
    const dedicated = app.store.get<{ chat: string; user: string }>(
      "SELECT chat,user FROM telegram_conversations WHERE conversationId=?",
      conversationId,
    );
    const identity = dedicated && telegramIdentity(app.store, dedicated);
    if (
      !dedicated ||
      !identity ||
      !app.store.get(
        "SELECT 1 FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
        dedicated.chat,
        dedicated.user,
        conversationId,
      )
    )
      return undefined;
    route = {
      chat: dedicated.chat,
      user: dedicated.user,
      botId: String(identity.botId),
      conversationId,
      messageThreadId: app.store.telegramThread(conversationId) ?? null,
    };
  }
  return {
    owner: {
      chat: route.chat,
      user: route.user,
      ...(route.messageThreadId == null
        ? {}
        : { messageThreadId: route.messageThreadId }),
    },
    originThreadId: route.messageThreadId,
  };
}

/** Tell the topic once when a call lands uncertain, so /status is not the only path. */
export function queueMcpUncertainNotices(app: Runtime) {
  if (!app.mcpCalls) return;
  for (const call of app.store.all<McpCall>(
    "SELECT * FROM mcp_calls WHERE state='uncertain'",
  )) {
    if (
      app.mcpCalls
        .interactions(call.conversationId)
        .some((i) => i.callId === call.id && i.state === "pending")
    )
      continue;
    const deliveryId = `telegram:mcp-check-menu:auto:${call.id}`;
    if (
      app.store.get(
        "SELECT 1 FROM deliveries WHERE id=? OR id GLOB ?",
        deliveryId,
        `${deliveryId}:*`,
      )
    )
      continue;
    const resolved = telegramOwnerForConversation(app, call.conversationId);
    if (!resolved) continue;
    const { owner, originThreadId } = resolved;
    const token = button(app, {
      kind: "mcp-check",
      owner,
      originThreadId,
      conversationId: call.conversationId,
      callId: call.id,
      callHash: hash(JSON.stringify(call)),
      verification: "review",
      authorizationVersion: app.store.authorizationVersion(
        owner,
        call.conversationId,
      ),
    });
    queueControl(
      app,
      deliveryId,
      owner,
      call.conversationId,
      `${call.server} / ${call.tool}: uncertain MCP result. Check this occurrence in the external service. Tap Record external verification below.`,
      {
        inline_keyboard: [
          [{ text: "Record external verification…", callback_data: token }],
        ],
      },
    );
  }
}
export async function decideMcp(
  app: Runtime,
  data: TelegramButton,
  messageId: number,
) {
  const item = app.store.get<McpInteraction>(
    "SELECT * FROM mcp_interactions WHERE id=? AND conversationId=?",
    data.interactionId ?? "",
    data.conversationId,
  );
  if (
    !item ||
    item.state !== "pending" ||
    hash(item.payload) !== data.interactionHash ||
    data.authorizationVersion !==
      app.store.authorizationVersion(data.owner, data.conversationId) ||
    (data.decision !== "accept" && data.decision !== "decline")
  )
    throw new PolicyError("Pending item closed, changed, or not authorized.");
  const currentCall = app.store.get<McpCall>(
    "SELECT * FROM mcp_calls WHERE id=?",
    item.callId,
  );
  if (!currentCall) throw new PolicyError("Pending call unavailable.");
  const review = approvalReview(app, item, currentCall);
  if (data.decision === "accept" && !review.canAccept)
    throw new PolicyError(
      review.opaque
        ? "Recipients or content cannot be reviewed. Review it in the external service; the bot does not look up drafts, read mail, or decode opaque content."
        : "Action, destination, or content cannot be reviewed. Use the external service's secure flow; you can decline this pending item.",
    );
  if (
    data.reviewVersion !== reviewVersion ||
    data.reviewHash !== hash(review.view.text)
  )
    throw new PolicyError(
      "Review card is old or changed. Use the new literal card for this pending item.",
    );
  const prefix = reviewPrefix(item.id);
  const parts = app.store.all<{ state: string; result: string | null }>(
    "SELECT state,result FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
    `${prefix}:`,
    `${prefix};`,
  );
  const sent = parts.at(-1)?.result;
  const receipt = sent ? JSON.parse(sent) : undefined;
  if (
    !parts.length ||
    parts.some((part) => part.state !== "sent") ||
    (receipt?.message_id ?? receipt?.result?.message_id) !== messageId
  )
    throw new PolicyError(
      "Review is incomplete or the button is outside the original message.",
    );
  const result = await app.mcpCalls.decide(
    data.conversationId,
    item.id,
    data.decision,
    data.decision === "accept" ? {} : undefined,
  );
  clearApprovalMeta(app, item.id);
  const call = app.mcpCalls
    .list(data.conversationId)
    .find((row) => row.id === result.callId);
  if (call && item.kind === "resume") {
    await app.recordMcpOutcome(call);
    queueControl(
      app,
      `telegram:mcp-result:${item.id}`,
      data.owner,
      data.conversationId,
      `**Decision recorded:** ${data.decision === "accept" ? "approve" : "decline"}\nMCP state: ${call.state}${call.state === "paused" ? "\nThere is a new pending item; review the next card." : ""}${(() => {
        const detail = formatMcpOutcomeMessage(call);
        return detail ? `\n\n${detail}` : "";
      })()}`,
    );
  }
}

export function queueMcpChecks(
  app: Runtime,
  owner: import("./telegram-chats.js").TelegramOwner,
  id: string,
  updateId: number,
) {
  for (const call of app.mcpCalls
    ?.list(id)
    .filter((c) => c.state === "uncertain") ?? []) {
    if (
      app.mcpCalls
        .interactions(id)
        .some((i) => i.callId === call.id && i.state === "pending")
    )
      continue;
    const token = button(app, {
      kind: "mcp-check",
      owner,
      originThreadId: owner.messageThreadId ?? null,
      conversationId: id,
      callId: call.id,
      callHash: hash(JSON.stringify(call)),
      verification: "review",
      authorizationVersion: app.store.authorizationVersion(owner, id),
    });
    queueControl(
      app,
      `telegram:mcp-check-menu:${updateId}:${call.id}`,
      owner,
      id,
      `${call.server} / ${call.tool}: uncertain result. Check the external service before allowing new calls on this server.`,
      {
        inline_keyboard: [
          [{ text: "Record external verification…", callback_data: token }],
        ],
      },
    );
  }
}
export async function verifyMcp(
  app: Runtime,
  data: TelegramButton,
  messageId: number,
) {
  const call = app.mcpCalls
    .list(data.conversationId)
    .find((c) => c.id === data.callId);
  if (
    !call ||
    call.state !== "uncertain" ||
    hash(JSON.stringify(call)) !== data.callHash ||
    data.authorizationVersion !==
      app.store.authorizationVersion(data.owner, data.conversationId)
  )
    throw new PolicyError(
      "Record changed or not authorized. Use /status again.",
    );
  const prefix = `telegram:mcp-check:${call.id}:${data.callHash}`;
  if (data.verification === "review") {
    const view = formatUncertainCallReview(
      {
        server: call.server,
        tool: call.tool,
        state: call.state,
        input: JSON.parse(call.args),
      },
      app.options.redact,
    );
    const make = (verification: "done" | "not-executed") =>
      button(app, {
        kind: "mcp-check",
        owner: data.owner,
        originThreadId: data.originThreadId,
        conversationId: data.conversationId,
        callId: call.id,
        callHash: data.callHash,
        verification,
        authorizationVersion: data.authorizationVersion,
      });
    queueControl(
      app,
      prefix,
      data.owner,
      data.conversationId,
      `${literalReview(view.text)}\n\n${
        view.complete
          ? "Check the result in the external service. Confirm only what you verified. The record allows future calls; it does not run or repeat this action. If you are still unsure, keep it blocked."
          : "Verification options are unavailable because part of the content was hidden or shortened. The block stays until it is dismissed; use /resume to dismiss this conversation's uncertain result without repeating the action."
      }`,
      {
        inline_keyboard: view.complete
          ? [
              [
                {
                  text: "I checked: action completed",
                  callback_data: make("done"),
                },
              ],
              [
                {
                  text: "I checked: action did not run",
                  callback_data: make("not-executed"),
                },
              ],
            ]
          : [],
      },
    );
    return;
  }
  if (!["done", "not-executed"].includes(data.verification ?? ""))
    throw new PolicyError("Invalid verification.");
  const parts = app.store.all<{ state: string; result: string | null }>(
    "SELECT state,result FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
    `${prefix}:`,
    `${prefix};`,
  );
  const receipt = parts.at(-1)?.result
    ? JSON.parse(parts.at(-1)!.result!)
    : undefined;
  if (
    !parts.length ||
    parts.some((p) => p.state !== "sent") ||
    (receipt?.message_id ?? receipt?.result?.message_id) !== messageId
  )
    throw new PolicyError("The review was not fully delivered.");
  const result = app.mcpCalls.reconcile(
    call.conversationId,
    call.id,
    `An authorized user said they checked the external service: ${data.verification === "done" ? "action completed" : "action did not run"}. No repeat was authorized.`,
  );
  if (result) await app.recordMcpOutcome(result);
  queueControl(
    app,
    `telegram:mcp-verified:${call.id}`,
    data.owner,
    data.conversationId,
    "Declared verification recorded. No call was resent.",
  );
}
