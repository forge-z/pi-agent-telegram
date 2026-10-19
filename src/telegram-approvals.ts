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
} from "./telegram-controls.js";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const reviewVersion = 3;
const acceptGuidance =
  "Revise a ação, o destino e o conteúdo acima. A decisão retoma somente esta pendência.";
const executorAcceptGuidance =
  "Toque em **Aprovar esta chamada** para continuar no Executor, ou **Negar** para cancelar.";
const opaqueGuidance =
  "Aprovação indisponível: este envio não traz destinatários e conteúdo revisáveis no Telegram (apenas draftId ou outro identificador, formato opaco ou campos fora do contrato). Revise no serviço externo. O bot não busca o rascunho, não lê e-mail e não decodifica conteúdo. Use o fluxo seguro do serviço; não envie credenciais aqui. Você pode negar esta pendência.";
const closedGuidance =
  "Aprovação indisponível: a ação, o destino ou o conteúdo não atendem ao contrato de revisão, ou exigem entrada adicional. Identificadores, rascunhos, wrappers e formatos desconhecidos precisam de revisão fora do Telegram. Use o fluxo seguro do serviço; não envie credenciais aqui. Você pode negar esta pendência.";
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
  const lines = ["**Atualizar catálogo de ferramentas (Executor)**", ""];
  lines.push(`Ferramenta: \`${String(invocation.tool)}\``);
  if (address) lines.push(`Conexão: \`${address}\``);
  return lines.join("\n");
}
function formatMailInvocationHuman(invocation: Record<string, unknown>) {
  const input = object(invocation.input) ? invocation.input : {};
  const lines = ["**Envio de e-mail**", ""];
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  const to = pick("to", "recipients", "to_addresses", "toAddresses");
  if (to) lines.push(`Para: ${Array.isArray(to) ? to.join(", ") : to}`);
  for (const [label, ...keys] of [
    ["Cc", "cc", "cc_addresses", "ccAddresses"],
    ["Cco", "bcc", "bcc_addresses", "bccAddresses"],
  ] as const) {
    const value = pick(...keys);
    if (value)
      lines.push(
        `${label}: ${Array.isArray(value) ? value.join(", ") : value}`,
      );
  }
  const subject = pick("subject");
  if (typeof subject === "string") lines.push(`Assunto: ${subject}`);
  const body = pick("body", "text", "body_text", "bodyText");
  if (typeof body === "string") {
    lines.push("");
    lines.push("Mensagem:");
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
    return request || "Confirme esta ação no Executor.";
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
    if (request && hint) return `${request}\n\nReferência: \`${hint}\``;
    if (request) return request;
    if (hint) return `Referência: \`${hint}\``;
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
      : `Aprovar \`${invocation.tool}\`?`;
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
      if (inner?.ok === true) return "Executor concluiu com sucesso.";
      if (inner?.ok === false)
        return "Executor reportou falha na execução. Verifique no painel do Executor.";
    }
    return "Chamada MCP concluída.";
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
    return "A retomada falhou. Verifique no Executor ou nos logs.";
  }
  return "";
}
const sensitive =
  /^(?:.*(?:token|secret|password|credential|authorization|cookie)|api[_-]?key)$/i;
/** Never approve a review whose content had to be hidden or abbreviated. */
export function reviewText(value: unknown, redact?: (text: string) => string) {
  let hidden = false;
  let serialized =
    JSON.stringify(
      value,
      (key, item: unknown) => {
        if (sensitive.test(key)) {
          hidden = true;
          return "[REDACTED]";
        }
        if (typeof item === "string") {
          if (invisible.test(item)) {
            hidden = true;
            item = item.replace(
              new RegExp(invisible.source, "gu"),
              (character) =>
                `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
            );
          }
          return (item as string)
            .replace(/https?:\/\/[^\s"<>]+/g, (raw) => {
              try {
                const url = new URL(raw);
                if (url.username || url.password || url.search || url.hash) {
                  hidden = true;
                  return `${url.origin}${url.pathname}[private URL omitted]`;
                }
              } catch {
                hidden = true;
                return "[URL omitted]";
              }
              return raw;
            })
            .replace(
              /(?:sk-[\w-]{12,}|\d{6,}:[A-Za-z0-9_-]{20,}|Bearer\s+\S+)/g,
              () => {
                hidden = true;
                return "[REDACTED]";
              },
            );
        }
        return item;
      },
      2,
    ) ?? "";
  // Property names are also untrusted; JSON.stringify does not escape bidi controls in keys.
  if (invisible.test(serialized)) {
    hidden = true;
    serialized = serialized.replace(
      new RegExp(invisible.source, "gu"),
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  const safe = redact?.(serialized) ?? serialized;
  return {
    text:
      safe.length <= 24000
        ? safe
        : "[Conteúdo grande demais para revisão no Telegram.]",
    complete: !hidden && safe === serialized && safe.length <= 24000,
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
    });
    const invocation = payload.invocation as { tool?: unknown } | undefined;
    const tool =
      typeof invocation?.tool === "string" ? `\n\n${invocation.tool}` : "";
    queueControl(
      app,
      `telegram:mcp-expired:${item.id}`,
      owner,
      item.conversationId,
      `**Aprovação MCP expirada**${tool}\n\nNenhuma decisão foi tomada. Nada foi executado e a chamada não será repetida.`,
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
    Date.now() + 15 * 60_000,
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
    const controls = [{ text: "Recusar", callback_data: make("decline") }];
    if (canAccept)
      controls.unshift({
        text: "Aprovar",
        callback_data: make("accept"),
      });
    queueControl(
      app,
      prefix,
      owner,
      item.conversationId,
      `**Aprovação MCP pendente**\n\n${display}\n\n${guidance}\n\nVálido até: ${formatExpiresAt(expiresAt)} UTC`,
      { inline_keyboard: [controls] },
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
    throw new PolicyError("Pendência encerrada, alterada ou não autorizada.");
  const currentCall = app.store.get<McpCall>(
    "SELECT * FROM mcp_calls WHERE id=?",
    item.callId,
  );
  if (!currentCall) throw new PolicyError("Chamada pendente indisponível.");
  const review = approvalReview(app, item, currentCall);
  if (data.decision === "accept" && !review.canAccept)
    throw new PolicyError(
      review.opaque
        ? "Destinatários ou conteúdo não revisáveis. Revise no serviço externo; o bot não consulta rascunhos, não lê e-mail e não decodifica conteúdo opaco."
        : "Ação, destino ou conteúdo não revisáveis. Use o fluxo seguro do serviço externo; você pode negar esta pendência.",
    );
  if (
    data.reviewVersion !== reviewVersion ||
    data.reviewHash !== hash(review.view.text)
  )
    throw new PolicyError(
      "Cartão de revisão antigo ou alterado. Use o novo cartão literal desta pendência.",
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
      "Revisão incompleta ou botão fora da mensagem original.",
    );
  const result = await app.mcpCalls.decide(
    data.conversationId,
    item.id,
    data.decision,
    data.decision === "accept" ? {} : undefined,
  );
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
      `**Decisão registrada:** ${data.decision === "accept" ? "aprovar" : "negar"}\nEstado MCP: ${call.state}${call.state === "paused" ? "\nHá uma nova pendência; revise o próximo cartão." : ""}${(() => {
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
      `${call.server} / ${call.tool}: resultado incerto. Verifique no serviço externo antes de liberar novas chamadas neste servidor.`,
      {
        inline_keyboard: [
          [{ text: "Registrar verificação externa…", callback_data: token }],
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
      "Registro alterado ou não autorizado. Use /status novamente.",
    );
  const prefix = `telegram:mcp-check:${call.id}:${data.callHash}`;
  if (data.verification === "review") {
    const view = reviewText(
      {
        server: call.server,
        tool: call.tool,
        input: JSON.parse(call.args),
        state: call.state,
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
      `${literalReview(view.text)}\n\nConsulte o resultado no serviço externo. Confirme somente o que você verificou. O registro libera chamadas futuras; não executa nem repete esta ação. Se ainda houver dúvida, mantenha bloqueado.`,
      {
        inline_keyboard: view.complete
          ? [
              [
                {
                  text: "Verifiquei: ação concluída",
                  callback_data: make("done"),
                },
              ],
              [
                {
                  text: "Verifiquei: ação não executada",
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
    throw new PolicyError("Verificação inválida.");
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
    throw new PolicyError("Revisão não foi entregue integralmente.");
  const result = app.mcpCalls.reconcile(
    call.conversationId,
    call.id,
    `Usuário autorizado declarou ter verificado no serviço externo: ${data.verification === "done" ? "ação concluída" : "ação não executada"}. Nenhuma repetição foi autorizada.`,
  );
  if (result) await app.recordMcpOutcome(result);
  queueControl(
    app,
    `telegram:mcp-verified:${call.id}`,
    data.owner,
    data.conversationId,
    "Verificação declarada registrada. Nenhuma chamada foi reenviada.",
  );
}
