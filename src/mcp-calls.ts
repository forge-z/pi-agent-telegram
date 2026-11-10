import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ElicitRequest,
  ElicitResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  McpGateway,
  McpError,
  McpNotSentError,
  McpUrlElicitationRequiredError,
  mcpCallTimeoutMs,
  validateMcpUrlElicitation,
  PolicyError,
} from "./mcp.js";
import type { Store } from "./store.js";
import {
  authRedirects,
  executorBodies,
  executorPauseKind,
} from "./executor-result.js";
import {
  globMatch,
  loadHarnessConfig,
  mcpServerPolicy,
  type HarnessConfig,
} from "./harness-config.js";
import { APPROVAL_EXPIRE_MS } from "./guards.js";

export interface McpCall {
  id: string;
  conversationId: string;
  server: string;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  binding: string;
  updatedAt: number;
}
export interface McpInteraction {
  id: string;
  callId: string;
  conversationId: string;
  server: string;
  kind: "form" | "url" | "resume";
  payload: string;
  state: string;
  response: string | null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Executor meta tools. Protocol, not a provider name list. */
const READ_ONLY = new Set([
  "search",
  "describe",
  "skills",
  "list-artifacts",
  "show-artifact",
]);
const NOT_A_READ = new Set([
  "call",
  "execute",
  "resume",
  "tools.call",
  "tools.execute",
]);

function pathIsRead(
  path: string,
  context:
    | {
        server?: string;
        readOnlyHint?: boolean;
        config?: HarnessConfig;
      }
    | undefined,
  allowHint: boolean,
) {
  const normalized = path.trim();
  if (!normalized || NOT_A_READ.has(normalized)) return false;
  const leaf = normalized.split(".").pop() ?? normalized;
  if (READ_ONLY.has(normalized) || READ_ONLY.has(leaf)) return true;
  const policy = mcpServerPolicy(
    context?.config ?? loadHarnessConfig(),
    context?.server,
  );
  if (policy.write.some((pattern) => globMatch(pattern, normalized)))
    return false;
  if (policy.read.some((pattern) => globMatch(pattern, normalized)))
    return true;
  return allowHint && policy.trusted && context?.readOnlyHint === true;
}

interface InnerCall {
  target: string;
  args: unknown;
}

const DELEGATED = new Set(["call", "execute", "tools.call", "tools.execute"]);

function matchBrace(code: string, start: number) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** `tools.a.b({...})` and `pick("path")` inside an execute program. */
function pushCodeCalls(code: string, into: InnerCall[]) {
  const calls = /\b(tools(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  for (const match of code.matchAll(calls)) {
    const target = match[1];
    if (!target) continue;
    let index = match.index + match[0].length;
    while (code[index] === " " || code[index] === "\n" || code[index] === "\t")
      index += 1;
    let args: unknown;
    if (code[index] === "{") {
      const end = matchBrace(code, index);
      if (end > index) {
        const raw = code.slice(index, end);
        try {
          args = JSON.parse(raw);
        } catch {
          args = raw;
        }
      }
    }
    into.push({ target, args });
  }
  for (const match of code.matchAll(/pick\(\s*(["'`])([^"'`]+)\1\s*\)/g))
    into.push({ target: match[2] ?? "", args: undefined });
}

/** Targets of a delegated `call`/`execute`. A parameter named `path` is not a tool. */
function collectInner(value: unknown, into: InnerCall[], depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    if (/\bawait\b|\bpick\s*\(|\btools\./.test(value))
      pushCodeCalls(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInner(item, into, depth + 1);
    return;
  }
  if (!object(value)) return;
  const target =
    typeof value.path === "string"
      ? value.path
      : typeof value.address === "string"
        ? value.address
        : typeof value.tool === "string"
          ? value.tool
          : undefined;
  if (target) into.push({ target, args: "input" in value ? value.input : {} });
  else if (value.kind === "query")
    into.push({ target: "query", args: "input" in value ? value.input : {} });
  if ("calls" in value) collectInner(value.calls, into, depth + 1);
  if ("execution" in value) collectInner(value.execution, into, depth + 1);
  if ("code" in value) collectInner(value.code, into, depth + 1);
  if ("body" in value) collectInner(value.body, into, depth + 1);
  // `input` of a targeted call is the tool's parameters, not another tool.
  if (!target && "input" in value) collectInner(value.input, into, depth + 1);
}

function innerCalls(args: unknown): InnerCall[] {
  const into: InnerCall[] = [];
  collectInner(args, into);
  return into.filter((item) => item.target.trim());
}

/** What this invocation actually runs. Delegated calls expand to each inner target. */
export function effectiveToolCalls(
  server: string,
  tool: string,
  args: unknown,
): { server: string; target: string; args: unknown }[] {
  if (DELEGATED.has(tool)) {
    const inner = innerCalls(args);
    if (inner.length)
      return inner.map((item) => ({
        server,
        target: item.target,
        args: item.args,
      }));
  }
  return [{ server, target: tool, args }];
}

function configuredSandboxTool() {
  const raw = loadHarnessConfig().sandboxTask;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const name = (raw as { tool?: unknown }).tool;
  return typeof name === "string" ? name.trim() : "";
}

/** Points a timed-out call at the configured long-task tool, without naming a backend. */
function longJobHint() {
  const name = configuredSandboxTool();
  if (!name) return "";
  const seconds = Math.round(mcpCallTimeoutMs() / 1000);
  return ` Para algo que possa passar de ~${seconds}s ou que precise de aviso ao terminar, use ${name}.`;
}

function timeoutTail(read: boolean) {
  return read
    ? "A leitura falhou; a trava foi liberada."
    : "Resultado MCP incerto; verifique antes de outra ação neste servidor.";
}

function readTimeoutText(label: string, read: boolean) {
  const seconds = Math.round(mcpCallTimeoutMs() / 1000);
  return `A chamada ${label} estourou o prazo de ${seconds}s e foi encerrada. ${timeoutTail(read)}${longJobHint()}`;
}

/** A read never needs a decision and never changes state. Reads stay open while
 * another call on this server is uncertain, because checking that result means reading.
 * A later read does not clear the uncertainty. */
export function mcpCallIsReadOnly(
  tool: string,
  args?: Record<string, unknown>,
  context?: {
    server?: string;
    /** `annotations.readOnlyHint` from the latest tools/list for this tool. */
    readOnlyHint?: boolean;
    config?: HarnessConfig;
  },
) {
  if (tool === "resume") return false;
  const safeArgs = object(args) ? args : {};
  if (DELEGATED.has(tool)) {
    const inner = innerCalls(safeArgs);
    // Inner targets use config globs. The outer tool's readOnlyHint is not theirs.
    return (
      inner.length > 0 &&
      inner.every((item) => pathIsRead(item.target, context, false))
    );
  }
  return pathIsRead(tool, context, true);
}

/** Executor hosted resume often uses executionId + action instead of requestId + response. */
export function executorUsesExecutionIdResume(
  payload: Record<string, unknown>,
) {
  const executionId =
    typeof payload.executionId === "string" ? payload.executionId.trim() : "";
  const requestId =
    typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  return (
    (executionId.length > 0 && executionId.startsWith("exec_")) ||
    requestId.startsWith("exec_")
  );
}
function executorResumeContent(content: ElicitResult["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null)
    return Object.keys(content).length ? JSON.stringify(content) : "";
  return String(content);
}
function buildExecutorResumeArgs(
  payload: Record<string, unknown>,
  response: ElicitResult,
) {
  if (executorUsesExecutionIdResume(payload)) {
    const executionId =
      (typeof payload.executionId === "string" && payload.executionId.trim()) ||
      (typeof payload.requestId === "string" && payload.requestId.trim()) ||
      "";
    const args: Record<string, unknown> = {
      executionId,
      action: response.action,
    };
    if (response.action === "accept")
      args.content = executorResumeContent(response.content);
    return args;
  }
  return { requestId: payload.requestId, response };
}
// A scheduled run cannot wait for a human click: the step is skipped and the model
// is told so. It must never be combined with an approval request, and it tells the
// model not to summarize the step it skipped.
const APPROVAL_SKIPPED =
  "Passo pulado: execução agendada não pode aguardar aprovação humana. Nenhuma retomada automática foi enviada. Não resuma este passo como concluído.";
const REJECTION = new Set(["InputInvalid", "InvalidToolInput", "UnknownTool"]);

function walkPayload(
  value: unknown,
  visit: (body: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (depth > 8 || value == null) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return false;
    try {
      return walkPayload(JSON.parse(trimmed), visit, depth + 1);
    } catch {
      return false;
    }
  }
  if (value instanceof Error)
    return walkPayload(value.message, visit, depth + 1);
  if (Array.isArray(value))
    return value.some((item) => walkPayload(item, visit, depth + 1));
  if (!object(value)) return false;
  if (visit(value)) return true;
  return Object.values(value).some((item) =>
    walkPayload(item, visit, depth + 1),
  );
}

function hasSuccessfulToolCall(value: unknown) {
  return walkPayload(
    value,
    (body) =>
      Array.isArray(body.toolCalls) &&
      body.toolCalls.some(
        (call) =>
          object(call) &&
          (call.outcome === "success" ||
            (call.outcome !== "failure" && "result" in call)),
      ),
  );
}

/** InputInvalid / UnknownTool (including HTTP 422) and no successful toolCalls. */
export function refusedBeforeDispatch(value: unknown) {
  const rejected = walkPayload(value, (body) => {
    const response = object(body.response) ? body.response : undefined;
    const codes = [body.kind, body.code, body.status, response?.code];
    if (
      codes.some(
        (code) =>
          code === 422 || (typeof code === "string" && REJECTION.has(code)),
      )
    )
      return true;
    return [body.message, response?.message].some(
      (message) =>
        typeof message === "string" &&
        (/Input failed validation/i.test(message) ||
          /\bNo tool at\b/i.test(message)),
    );
  });
  return rejected && !hasSuccessfulToolCall(value);
}

function noDispatchNotice(value: unknown) {
  if (!refusedBeforeDispatch(value)) return undefined;
  const unknown = walkPayload(value, (body) => {
    const response = object(body.response) ? body.response : undefined;
    return (
      body.kind === "UnknownTool" ||
      body.code === "UnknownTool" ||
      response?.code === "UnknownTool" ||
      [body.message, response?.message].some(
        (message) =>
          typeof message === "string" && /\bNo tool at\b/i.test(message),
      )
    );
  });
  const generic =
    "A mensagem de recovery do servidor é genérica e não se aplica a este caso.";
  return unknown
    ? `Ferramenta inexistente, recusada antes de qualquer despacho: nada foi executado. Não repita esta chamada; corrija o caminho da ferramenta. ${generic}`
    : `Recusado na validação, antes de qualquer despacho: nada foi executado. Não repita esta chamada; corrija a entrada. ${generic}`;
}

function toCallToolResult(result: unknown): CallToolResult {
  const body =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  if (body && Array.isArray(body.content)) return result as CallToolResult;
  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : JSON.stringify(result ?? {}),
      },
    ],
    ...(body ? { structuredContent: body } : {}),
  };
}
export interface McpReleaseNotice {
  conversationId: string;
  callId: string;
  text: string;
}

export function deadlineFailure(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /estourou o prazo|Request timed out|timed out|aborted|Tempo de resposta MCP excedido/i.test(
    message,
  );
}

function notifyPending(onPending?: () => void) {
  if (!onPending) return;
  // Defer so Telegram flush does not run reentrantly inside MCP I/O or SQLite work.
  setImmediate(() => {
    try {
      onPending();
    } catch {
      /* delivery must not block MCP */
    }
  });
}

type DeferredDispatch = {
  state: "done" | "failed";
  text: string;
};

export class McpCalls {
  private tails = new Map<string, Promise<unknown>>();
  private deferredDispatch?: (
    spec: Record<string, unknown>,
  ) => Promise<DeferredDispatch>;
  private waiters = new Map<string, (value: ElicitResult) => void>();
  private controllers = new Set<AbortController>();
  private callControllers = new Map<string, AbortController>();
  private inflight = new Set<Promise<CallToolResult>>();
  private closed = false;
  constructor(
    private store: Store,
    private gateway: McpGateway,
    private onPending?: () => void,
    private onReleased?: (notice: McpReleaseNotice) => void,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, binding TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_interactions(id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL, server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', response TEXT);
      CREATE INDEX IF NOT EXISTS mcp_calls_conversation ON mcp_calls(conversationId);
      CREATE INDEX IF NOT EXISTS mcp_interactions_conversation ON mcp_interactions(conversationId);
      UPDATE mcp_interactions SET state='expired' WHERE state='pending' AND kind!='resume'
        AND NOT (kind='url' AND json_valid(payload) AND json_extract(payload,'$.source')='url_required_error');
      DELETE FROM mcp_calls WHERE id LIKE 'mcp-stage:%';`);
    for (const call of store.all<McpCall>(
      "SELECT * FROM mcp_calls WHERE state='running'",
    )) {
      let read = false;
      try {
        read = this.isRead(call.server, call.tool, JSON.parse(call.args));
      } catch {
        read = false;
      }
      store.run(
        "UPDATE mcp_calls SET state=? WHERE id=? AND state='running'",
        read ? "failed" : "uncertain",
        call.id,
      );
    }
  }
  /**
   * Records a pause that a direct `execute` already received, so the approval
   * card and `resume` can finish it. The command has not run yet.
   */
  noteExecutorPause(
    conversationId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
  ): string | undefined {
    const callResult = toCallToolResult(result);
    const paused = this.pause(callResult);
    const requestId =
      paused && typeof paused.requestId === "string"
        ? paused.requestId.trim()
        : "";
    if (!paused || !requestId) return undefined;
    let binding = "";
    try {
      binding = this.binding(server);
    } catch {
      return requestId;
    }
    const callId = createHash("sha256")
      .update(`executor-pause:${conversationId}:${requestId}`)
      .digest("hex")
      .slice(0, 24);
    if (this.store.get("SELECT 1 FROM mcp_calls WHERE id=?", callId))
      return requestId;
    this.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,'paused',?,?,?)",
      callId,
      conversationId,
      server,
      tool,
      JSON.stringify(args),
      JSON.stringify(callResult),
      binding,
      Date.now(),
    );
    this.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
      randomUUID(),
      callId,
      conversationId,
      server,
      "resume",
      JSON.stringify(paused),
    );
    notifyPending(this.onPending);
    return requestId;
  }
  setDeferredDispatch(
    handler: (spec: Record<string, unknown>) => Promise<DeferredDispatch>,
  ) {
    this.deferredDispatch = handler;
  }
  noteDeferredApproval(
    conversationId: string,
    server: string,
    tool: string,
    message: string,
    deferred: Record<string, unknown>,
  ): string | undefined {
    let binding = "";
    try {
      binding = this.binding(server);
    } catch {
      return undefined;
    }
    const requestId = `exec_local_${randomBytes(8).toString("hex")}`;
    const callId = createHash("sha256")
      .update(`deferred:${conversationId}:${requestId}`)
      .digest("hex")
      .slice(0, 24);
    const payload = {
      protocol: "executor",
      status: "approval-required",
      requestId,
      executionId: requestId,
      expiresAt: Date.now() + APPROVAL_EXPIRE_MS,
      elicitation: {
        mode: "form",
        message,
        requestedSchema: { type: "object", properties: {} },
      },
      invocation: {
        app: "executor",
        tool,
        input: { review: message },
      },
      deferred,
    };
    this.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,'paused',NULL,?,?)",
      callId,
      conversationId,
      server,
      tool,
      JSON.stringify({ review: message }),
      binding,
      Date.now(),
    );
    this.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
      randomUUID(),
      callId,
      conversationId,
      server,
      "resume",
      JSON.stringify(payload),
    );
    notifyPending(this.onPending);
    return requestId;
  }
  list(conversationId: string) {
    return this.store.all<McpCall>(
      "SELECT * FROM mcp_calls WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  interactions(conversationId: string) {
    return this.store.all<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  private binding(server: string) {
    return this.gateway.credentialBinding(server);
  }
  private pending(conversationId: string) {
    return this.store.get(
      "SELECT 1 FROM mcp_interactions WHERE conversationId=? AND state='pending'",
      conversationId,
    );
  }
  private pendingApprovalRequestId(conversationId: string) {
    const row = this.store.get<{ payload: string }>(
      "SELECT payload FROM mcp_interactions WHERE conversationId=? AND state='pending' ORDER BY rowid DESC LIMIT 1",
      conversationId,
    );
    if (!row) return undefined;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const direct =
        typeof payload.requestId === "string" ? payload.requestId.trim() : "";
      if (direct) return direct;
      const elicitation = payload.elicitation;
      if (elicitation && typeof elicitation === "object") {
        const nested = (elicitation as { requestId?: unknown }).requestId;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    } catch {
      /* malformed card payload */
    }
    return undefined;
  }
  private pendingApprovalMessage(conversationId: string) {
    const requestId = this.pendingApprovalRequestId(conversationId);
    return requestId
      ? `Responda à solicitação pendente do servidor MCP (${requestId}) antes de continuar`
      : "Responda à solicitação pendente do servidor MCP antes de continuar";
  }
  private serialize<T>(conversationId: string, operation: () => Promise<T>) {
    const pending = (this.tails.get(conversationId) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.tails.set(conversationId, pending);
    void pending
      .finally(() => {
        if (this.tails.get(conversationId) === pending)
          this.tails.delete(conversationId);
      })
      .catch(() => {});
    return pending;
  }
  execute(
    conversationId: string,
    taskId: number,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    /** True inside an admitted scheduled occurrence: approvals cannot be awaited there. */
    scheduled = false,
  ) {
    // Keep the ledger outcome and all elicitation cards committed before a
    // queued operation rechecks admission. The transport queue alone ends earlier.
    return this.serialize(conversationId, () =>
      this.executeOnce(
        conversationId,
        taskId,
        server,
        tool,
        args,
        signal,
        scheduled,
      ),
    );
  }
  /** The flag that blocks actions lives per conversation and needs no provider id. Clearing
   * it keeps the history: only the pending decision goes away. */
  clearUncertain(conversationId: string) {
    const rows = this.store.all<{ server: string; tool: string }>(
      "SELECT server,tool FROM mcp_calls WHERE conversationId=? AND state='uncertain'",
      conversationId,
    );
    if (!rows.length) return 0;
    this.store.run(
      "UPDATE mcp_calls SET state='skipped',updatedAt=? WHERE conversationId=? AND state='uncertain'",
      Date.now(),
      conversationId,
    );
    const now = new Date().toISOString();
    for (const row of rows)
      console.log(
        `Pi-Agent: resultado MCP incerto dispensado: ${row.server}/${row.tool} (${now}).`,
      );
    return rows.length;
  }

  private async executeOnce(
    conversationId: string,
    taskId: number,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    scheduled = false,
  ) {
    if (this.closed) throw new PolicyError("Aplicação encerrando");
    if (signal?.aborted)
      throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
    // Model-facing entry. A requestId is data, never permission to resume.
    if (tool === "resume")
      throw new PolicyError(
        "Retomada exige decisão humana pela solicitação exibida na conversa; use decide.",
      );
    const id = createHash("sha256")
      .update(`mcp:${conversationId}:${taskId}`)
      .digest("hex")
      .slice(0, 24);
    const existing = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      id,
    );
    // Overdue rows become uncertain before the next admission check.
    this.releaseOverdue(conversationId);
    if (existing) {
      if (
        existing.server !== server ||
        existing.tool !== tool ||
        existing.args !== JSON.stringify(args)
      )
        throw new PolicyError("Identidade MCP usada com outro conteúdo");
      if (
        ["done", "failed", "paused", "skipped"].includes(existing.state) &&
        existing.result
      )
        return JSON.parse(existing.result) as CallToolResult;
      throw new PolicyError(
        "Resultado MCP incerto ou em andamento; a chamada não será reenviada automaticamente",
      );
    }
    // A pending decision blocks actions, not diagnosis: the Executor's read tools
    // still answer, so a stuck approval can be looked at instead of guessed about.
    if (this.pending(conversationId) && !this.isRead(server, tool, args))
      throw new McpNotSentError(this.pendingApprovalMessage(conversationId));
    // Per server, and before the tool allow-list, so a blocked server says so.
    if (
      !this.isRead(server, tool, args) &&
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND server=? AND state='uncertain' AND id NOT LIKE 'mcp-stage:%'",
        conversationId,
        server,
      )
    )
      throw new McpNotSentError(
        "Verifique e registre o resultado MCP incerto antes de executar outra chamada neste servidor",
      );
    if (
      !this.isRead(server, tool, args) &&
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND state IN ('running','paused') AND id NOT LIKE 'mcp-stage:%'",
        conversationId,
      )
    )
      throw new McpNotSentError(
        "Aguarde a chamada ou retomada MCP em andamento; nenhuma nova ferramenta foi enviada",
      );
    this.gateway.assertDirect(server, tool);
    const binding = await this.gateway.connectionBinding(server);
    if (this.closed) throw new PolicyError("Aplicação encerrando");
    if (signal?.aborted)
      throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
    this.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,'running',NULL,?,?)",
      id,
      conversationId,
      server,
      tool,
      JSON.stringify(args),
      binding,
      Date.now(),
    );
    return this.run(id, tool, args, signal, scheduled);
  }
  /**
   * A call that outlived its deadline, or a pause whose resume expired, must
   * not keep the conversation locked. The in-flight promise may still be wedged.
   */
  private releaseOverdue(conversationId: string) {
    const deadline = mcpCallTimeoutMs();
    const now = Date.now();
    const stuck = this.store.all<McpCall>(
      "SELECT * FROM mcp_calls WHERE conversationId=? AND state='running' AND updatedAt<=?",
      conversationId,
      now - deadline,
    );
    for (const call of stuck) {
      this.callControllers.get(call.id)?.abort();
      this.forceRelease(
        call,
        `A chamada ${call.server}/${call.tool} passou de ${Math.round(deadline / 1000)}s sem retorno. ${timeoutTail(this.callIsReadOnly(call))}${longJobHint()}`,
      );
      void this.gateway.releaseSession(call.server);
    }
    const paused = this.store.all<McpCall>(
      "SELECT * FROM mcp_calls WHERE conversationId=? AND state='paused'",
      conversationId,
    );
    for (const call of paused) {
      const interaction = this.store.get<McpInteraction>(
        "SELECT * FROM mcp_interactions WHERE callId=? AND kind='resume' AND state='pending' ORDER BY rowid DESC LIMIT 1",
        call.id,
      );
      if (!interaction) {
        this.forceRelease(
          call,
          `A chamada ${call.server}/${call.tool} ficou pausada sem retomada pendente. A trava foi liberada.`,
          ["running", "paused"],
          "failed",
        );
        continue;
      }
      let expiresAt = 0;
      try {
        expiresAt = Number(
          (JSON.parse(interaction.payload) as { expiresAt?: unknown })
            .expiresAt,
        );
      } catch {
        expiresAt = 0;
      }
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
      this.store.run(
        "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
        interaction.id,
      );
      this.forceRelease(
        call,
        `A retomada de ${call.server}/${call.tool} expirou. A trava foi liberada; nenhuma chamada nova ficou presa.`,
        ["running", "paused"],
        "failed",
      );
    }
  }

  private isRead(server: string, tool: string, args?: Record<string, unknown>) {
    const gateway = this.gateway as {
      toolReadOnlyHint?: (server: string, tool: string) => boolean | undefined;
    };
    const readOnlyHint =
      typeof gateway.toolReadOnlyHint === "function" &&
      gateway.toolReadOnlyHint(server, tool) === true
        ? true
        : undefined;
    return mcpCallIsReadOnly(tool, args, { server, readOnlyHint });
  }

  private callIsReadOnly(call: McpCall) {
    try {
      return this.isRead(call.server, call.tool, JSON.parse(call.args));
    } catch {
      return false;
    }
  }

  /** Reads fail closed. A proven validation/unknown-tool rejection fails closed.
   * Any other write error stays uncertain on that server only. */
  private recordedState(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    result: CallToolResult,
    paused: boolean,
    skipped: boolean,
    unsupported: boolean,
  ) {
    const read = this.isRead(server, tool, args);
    if (paused) return "paused";
    if (skipped) return read ? "skipped" : "uncertain";
    if (read) return result.isError || unsupported ? "failed" : "done";
    if (refusedBeforeDispatch(result)) return "failed";
    if (result.isError || unsupported) return "uncertain";
    return "done";
  }

  private forceRelease(
    call: McpCall,
    text: string,
    from: Array<"running" | "paused"> = ["running", "paused"],
    state: "failed" | "uncertain" = this.callIsReadOnly(call)
      ? "failed"
      : "uncertain",
  ) {
    const states = from.map((item) => `'${item}'`).join(",");
    const changed = this.store.run(
      `UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=? AND state IN (${states})`,
      state,
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text }],
      }),
      Date.now(),
      call.id,
    ).changes;
    if (!changed) return;
    this.onReleased?.({
      conversationId: call.conversationId,
      callId: call.id,
      text,
    });
  }

  private run(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    scheduled = false,
  ) {
    const pending = this.performRun(id, tool, args, signal, scheduled);
    this.inflight.add(pending);
    void pending.finally(() => this.inflight.delete(pending)).catch(() => {});
    return pending;
  }
  private async performRun(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    scheduled = false,
  ) {
    const call = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      id,
    )!;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.callControllers.set(id, controller);
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    const deadlineMs = mcpCallTimeoutMs();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.closed)
        throw new McpNotSentError(
          "Aplicação encerrando; nenhuma chamada MCP foi enviada",
        );
      const attempt = this.gateway.callDirect(call.server, tool, args, {
        signal: combined,
        binding: call.binding,
        onElicitation: (params, elicitationSignal) =>
          this.elicit(
            call,
            params,
            elicitationSignal
              ? AbortSignal.any([combined, elicitationSignal])
              : combined,
          ),
      });
      void attempt.catch(() => {});
      const result = await Promise.race([
        attempt,
        new Promise<CallToolResult>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            controller.abort();
            void this.gateway.releaseSession(call.server);
            reject(
              new McpError(
                readTimeoutText(tool, this.isRead(call.server, tool, args)),
              ),
            );
          }, deadlineMs);
        }),
      ]);
      const links = authRedirects(result);
      if (links.length)
        throw new McpUrlElicitationRequiredError(
          links.map((link) => ({
            mode: "url" as const,
            url: link.url,
            message: link.message,
            elicitationId: link.elicitationId,
          })),
        );
      const status = this.outcomeStatus(result);
      const browserMode = !!status && Object.hasOwn(status, "approvalUrl");
      if (browserMode) {
        // Browser-mode tickets are credentials, not Telegram review links.
        delete result.structuredContent;
        result.content = [
          {
            type: "text",
            text: "Executor em modo Browser requer seu fluxo externo seguro. Configure modo MODEL ou NATIVE compatível. Nenhuma retomada ou repetição automática foi enviada.",
          },
        ];
      }
      // Executor terminal failures and contested/expired resumes are never success.
      if (
        status &&
        (["busy", "unavailable", "capacity-exceeded"].includes(
          String(status.status),
        ) ||
          (status.status === "completed" &&
            object(status.execution) &&
            status.execution.ok === false))
      ) {
        result.isError = true;
      }
      let paused = !result.isError ? this.pause(result) : undefined;
      let unsupportedPause =
        browserMode ||
        (!result.isError && !paused && this.hasPauseMarker(result));
      // A scheduled run cannot wait for a human click: skip the step, tell the model
      // and let the run continue. This is never an automatic approval or resume.
      const skippedApproval = scheduled && (!!paused || unsupportedPause);
      if (skippedApproval) {
        paused = undefined;
        unsupportedPause = false;
        result.isError = true;
        result.content.push({
          type: "text",
          text: APPROVAL_SKIPPED,
        });
      } else if (unsupportedPause) {
        result.isError = true;
        result.content.push({
          type: "text",
          text: "Servidor informou uma pausa em formato incompatível. A execução não foi considerada concluída e não será repetida automaticamente.",
        });
      }
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (paused) {
          this.store.run(
            "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
            randomUUID(),
            id,
            call.conversationId,
            call.server,
            "resume",
            JSON.stringify(paused),
          );
          notifyPending(this.onPending);
        }
        const state = this.recordedState(
          call.server,
          tool,
          args,
          result,
          !!paused,
          skippedApproval,
          unsupportedPause,
        );
        const notice =
          state === "failed" ? noDispatchNotice(result) : undefined;
        if (notice) result.content.push({ type: "text", text: notice });
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          state,
          JSON.stringify(result),
          Date.now(),
          id,
        );
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
      return result;
    } catch (error) {
      // A scheduled occurrence publishes no approval card and wakes no waiter, so the
      // turn ends by itself with the skip instruction instead of a pending request.
      const scheduledSkip =
        scheduled && error instanceof McpUrlElicitationRequiredError;
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const timedOut = deadlineFailure(error);
      const readOnly = this.isRead(call.server, tool, args);
      const notSent =
        error instanceof PolicyError || error instanceof McpNotSentError;
      const validation = refusedBeforeDispatch(error);
      const uncertain = !readOnly && !notSent && !validation;
      // A read that we stopped is a plain timeout. Only a write stays uncertain.
      const timeoutText = timedOut
        ? /estourou o prazo/.test(raw)
          ? raw
          : readTimeoutText(tool, readOnly)
        : undefined;
      const result: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: scheduledSkip
              ? APPROVAL_SKIPPED
              : (timeoutText ??
                (error instanceof PolicyError || error instanceof McpError
                  ? error.message
                  : uncertain
                    ? "Resultado MCP incerto. Verifique o serviço antes de tentar outra execução."
                    : "A chamada MCP falhou antes do envio. A trava foi liberada.")),
          },
        ],
      };
      const outgoing =
        timeoutText && timeoutText !== raw ? new McpError(timeoutText) : error;
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (error instanceof McpUrlElicitationRequiredError && !scheduledSkip) {
          for (const params of error.elicitations)
            this.store.run(
              "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
              randomUUID(),
              id,
              call.conversationId,
              call.server,
              "url",
              JSON.stringify({ ...params, source: "url_required_error" }),
            );
          notifyPending(this.onPending);
        }
        if (!uncertain) {
          const notice = noDispatchNotice(error);
          if (notice) {
            result.content.push({ type: "text", text: notice });
            if (error instanceof Error)
              error.message = `${error.message}\n${notice}`;
          }
        }
        // A lost resume stays uncertain, and the topic still hears why.
        const gaveUp = timedOut || !uncertain || tool === "resume";
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          uncertain ? "uncertain" : "failed",
          JSON.stringify(result),
          Date.now(),
          id,
        );
        this.store.db.exec("COMMIT");
        if (gaveUp) {
          const text =
            result.content.find((item) => item.type === "text")?.text ??
            "A chamada MCP falhou e a trava foi liberada.";
          this.onReleased?.({
            conversationId: call.conversationId,
            callId: id,
            text,
          });
        }
      } catch (storageError) {
        this.store.db.exec("ROLLBACK");
        // A failed card publication must still block replay of the dispatched call.
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          uncertain ? "uncertain" : "failed",
          JSON.stringify({
            isError: true,
            content: [
              {
                type: "text",
                text: "Não foi possível salvar as solicitações MCP. Verifique o resultado da chamada no serviço; ela não será repetida automaticamente.",
              },
            ],
          }),
          Date.now(),
          id,
        );
        throw storageError;
      }
      if (scheduledSkip) return result;
      throw outgoing;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // If the call never left `running` (the await wedged, or the ledger write
      // failed), the conversation must not stay locked.
      this.forceRelease(
        call,
        `A chamada ${call.server}/${call.tool} não terminou dentro do prazo. ${timeoutTail(this.callIsReadOnly(call))}${longJobHint()}`,
        ["running"],
      );
      // SDK may finish a tools/call while a withdrawn elicitation handler is still pending.
      // Settle every local waiter before closing SQLite or accepting another invocation.
      controller.abort();
      this.controllers.delete(controller);
      this.callControllers.delete(id);
      this.store.run(
        "UPDATE mcp_interactions SET state='expired' WHERE callId=? AND kind!='resume' AND state='pending' AND NOT (kind='url' AND json_valid(payload) AND json_extract(payload,'$.source')='url_required_error')",
        id,
      );
    }
  }
  /** Every object a result carries, outermost first. Shared with the job poller. */
  private pauseCandidates(result: CallToolResult): Record<string, unknown>[] {
    return [
      ...executorBodies(result.structuredContent),
      ...result.content.flatMap((item) => executorBodies(item)),
    ];
  }
  private looksLikeExecutorPause(value: Record<string, unknown>) {
    return !!executorPauseKind(value);
  }
  /** Normalize MODEL-mode Executor pauses, including executionId aliases and partial payloads. */
  private normalizeExecutorPause(
    raw: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    let value = raw;
    if (object(value.execution)) value = { ...value.execution, ...value };
    const status = executorPauseKind(value);
    if (!status || Object.hasOwn(value, "approvalUrl")) return;
    const requestId =
      typeof value.requestId === "string" && value.requestId.trim()
        ? value.requestId.trim()
        : typeof value.executionId === "string" && value.executionId.trim()
          ? value.executionId.trim()
          : undefined;
    if (!requestId || requestId.length > 512) return;
    const expiresAt =
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : Date.now() + 15 * 60_000;
    let elicitation = object(value.elicitation) ? value.elicitation : undefined;
    if (
      !elicitation ||
      elicitation.mode !== "form" ||
      typeof elicitation.message !== "string" ||
      !object(elicitation.requestedSchema)
    ) {
      elicitation = {
        mode: "form",
        message:
          typeof value.message === "string" && value.message.trim()
            ? value.message
            : "Confirme esta ação no Executor.",
        requestedSchema: { type: "object", properties: {} },
      };
    }
    let invocation = object(value.invocation) ? value.invocation : undefined;
    if (
      status === "approval-required" &&
      (!invocation ||
        typeof invocation.tool !== "string" ||
        !("input" in invocation)) &&
      typeof value.tool === "string" &&
      "input" in value
    )
      invocation = {
        app: typeof value.app === "string" ? value.app : "executor",
        tool: value.tool,
        input: value.input,
      };
    if (
      status === "approval-required" &&
      (!object(invocation) ||
        typeof invocation.tool !== "string" ||
        !("input" in invocation))
    ) {
      if (value.paused === true) return;
      invocation = {
        app: "executor",
        tool: "execute",
        input: { executionId: requestId },
      };
    }
    const executionId =
      typeof value.executionId === "string" && value.executionId.trim()
        ? value.executionId.trim()
        : requestId.startsWith("exec_")
          ? requestId
          : undefined;
    return {
      protocol: "executor",
      status,
      requestId,
      expiresAt,
      elicitation,
      ...(executionId ? { executionId } : {}),
      ...(status === "approval-required"
        ? { invocation }
        : { tool: value.tool }),
    };
  }
  private outcomeStatus(
    result: CallToolResult,
  ): Record<string, unknown> | undefined {
    return this.pauseCandidates(result).find(
      (value) => typeof value.status === "string" || value.paused === true,
    );
  }
  // Executor's actual wire contract: persist requestId; never replay execute/code.
  private pause(result: CallToolResult): Record<string, unknown> | undefined {
    for (const candidate of this.pauseCandidates(result)) {
      if (!this.looksLikeExecutorPause(candidate)) continue;
      const normalized = this.normalizeExecutorPause(candidate);
      if (normalized) return normalized;
    }
  }
  private hasPauseMarker(result: CallToolResult) {
    return this.pauseCandidates(result).some((candidate) =>
      this.looksLikeExecutorPause(candidate),
    );
  }
  private async elicit(
    call: McpCall,
    params: ElicitRequest["params"],
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    signal.throwIfAborted();
    const kind = params.mode === "url" ? "url" : "form";
    const payload =
      kind === "url"
        ? validateMcpUrlElicitation(params)
        : { ...params, source: undefined };
    const id = randomUUID();
    this.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
      id,
      call.id,
      call.conversationId,
      call.server,
      kind,
      JSON.stringify(payload),
    );
    notifyPending(this.onPending);
    return new Promise<ElicitResult>((resolve) => {
      const finish = (value: ElicitResult) => {
        signal.removeEventListener("abort", cancel);
        this.waiters.delete(id);
        resolve(value);
      };
      const cancel = () => {
        this.store.run(
          "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
          id,
        );
        finish({ action: "cancel" });
      };
      this.waiters.set(id, finish);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  async decide(
    conversationId: string,
    id: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) {
    if (this.closed) throw new PolicyError("Aplicação encerrando");
    if (!["accept", "decline", "cancel"].includes(action))
      throw new PolicyError("Decisão MCP inválida");
    const interaction = this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
    if (!interaction) throw new PolicyError("Solicitação MCP não encontrada");
    if (interaction.state !== "pending") return interaction;
    const payload = JSON.parse(interaction.payload) as Record<string, unknown>;
    const urlRequired =
      interaction.kind === "url" && payload.source === "url_required_error";
    if (
      interaction.kind === "resume" &&
      (payload.protocol !== "executor" ||
        typeof payload.requestId !== "string" ||
        typeof payload.expiresAt !== "number" ||
        payload.expiresAt <= Date.now())
    ) {
      this.store.savepoint("mcp_expire", () => {
        this.store.run(
          "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
          id,
        );
        this.store.run(
          "UPDATE mcp_calls SET state='abandoned',updatedAt=? WHERE id=? AND state='paused'",
          Date.now(),
          interaction.callId,
        );
      });
      throw new PolicyError(
        "Solicitação expirada ou protocolo incompatível; nenhuma chamada foi repetida.",
      );
    }
    if (
      (interaction.kind === "form" || interaction.kind === "resume") &&
      action === "accept"
    ) {
      const schema =
        interaction.kind === "resume" && object(payload.elicitation)
          ? payload.elicitation.requestedSchema
          : payload.requestedSchema;
      if (!object(schema)) throw new PolicyError("Formulário MCP inválido");
      const validation = new AjvJsonSchemaValidator().getValidator(schema)(
        content ?? {},
      );
      if (!validation.valid)
        throw new PolicyError("Preencha os campos exigidos pelo servidor MCP");
    }
    const waiter = this.waiters.get(id);
    if (interaction.kind !== "resume" && !urlRequired && !waiter)
      throw new PolicyError(
        "Esta solicitação MCP expirou; ela não pode ser aceita após reinício",
      );
    const call = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      interaction.callId,
    )!;
    let sameBinding = false;
    try {
      sameBinding = this.binding(call.server) === call.binding;
    } catch {
      /* unavailable credential is a changed binding */
    }
    if (!sameBinding && action === "accept")
      throw new PolicyError(
        "Endpoint ou credenciais MCP mudaram; a chamada não será retomada",
      );
    if (!sameBinding && interaction.kind === "resume")
      return this.abandon(interaction, call, action);
    if (object(payload.deferred))
      return this.finishDeferred(
        conversationId,
        interaction,
        call,
        action,
        payload.deferred,
      );
    if (interaction.kind === "resume") {
      try {
        this.gateway.assertDirect(call.server, "resume");
      } catch {
        if (action === "accept")
          throw new PolicyError(
            "Retomada bloqueada pelas restrições MCP. Recuse ou cancele esta espera para ajustar a conexão.",
          );
        return this.abandon(interaction, call, action);
      }
    }
    // Only an accepted form or resume carries user input to the service.
    const sent =
      action === "accept" && interaction.kind !== "url" ? content : undefined;
    const response: ElicitResult = {
      action,
      ...(sent ? { content: sent as ElicitResult["content"] } : {}),
    };
    this.store.db.exec("BEGIN IMMEDIATE");
    let claimed: number | bigint;
    try {
      claimed = this.store.run(
        "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
        JSON.stringify(response),
        id,
      ).changes;
      if (claimed && interaction.kind === "resume")
        this.store.run(
          "UPDATE mcp_calls SET state='running',updatedAt=? WHERE id=?",
          Date.now(),
          call.id,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    if (!claimed)
      return this.store.get<McpInteraction>(
        "SELECT * FROM mcp_interactions WHERE id=?",
        id,
      )!;
    if (waiter) waiter(response);
    else if (!urlRequired) {
      // Store the claim before I/O. A crash after resume is uncertain, never another accept.
      await this.serialize(conversationId, () =>
        this.run(call.id, "resume", buildExecutorResumeArgs(payload, response)),
      );
    }
    return this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=?",
      id,
    )!;
  }
  private async finishDeferred(
    conversationId: string,
    interaction: McpInteraction,
    call: McpCall,
    action: "accept" | "decline" | "cancel",
    spec: Record<string, unknown>,
  ) {
    const response = { action };
    this.store.db.exec("BEGIN IMMEDIATE");
    let claimed: number | bigint;
    try {
      claimed = this.store.run(
        "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
        JSON.stringify(response),
        interaction.id,
      ).changes;
      if (claimed && action === "accept")
        this.store.run(
          "UPDATE mcp_calls SET state='running',updatedAt=? WHERE id=?",
          Date.now(),
          call.id,
        );
      if (claimed && action !== "accept")
        this.store.run(
          "UPDATE mcp_calls SET state='abandoned',result=?,updatedAt=? WHERE id=?",
          JSON.stringify({
            isError: true,
            content: [
              {
                type: "text",
                text: "A tarefa de escrita não foi aprovada. Nada foi disparado.",
              },
            ],
          }),
          Date.now(),
          call.id,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    if (!claimed)
      return this.store.get<McpInteraction>(
        "SELECT * FROM mcp_interactions WHERE id=?",
        interaction.id,
      )!;
    if (action === "accept") {
      await this.serialize(conversationId, async () => {
        let state: "done" | "failed" = "failed";
        let text = "A tarefa de escrita não foi disparada.";
        try {
          const result = this.deferredDispatch
            ? await this.deferredDispatch(spec)
            : undefined;
          if (result) {
            state = result.state;
            text = result.text;
          }
        } catch (error) {
          state = "failed";
          text = error instanceof Error ? error.message : String(error);
        }
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=? AND state='running'",
          state,
          JSON.stringify({
            isError: state === "failed",
            content: [{ type: "text", text: text.slice(0, 1500) }],
          }),
          Date.now(),
          call.id,
        );
      });
    }
    return this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=?",
      interaction.id,
    )!;
  }
  cancelConversation(conversationId: string) {
    for (const call of this.list(conversationId))
      this.callControllers.get(call.id)?.abort();
    this.store.savepoint("mcp_stop", () => {
      for (const item of this.interactions(conversationId).filter(
        (i) => i.state === "pending",
      )) {
        this.store.run(
          "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
          JSON.stringify({ action: "cancel" }),
          item.id,
        );
        this.waiters.get(item.id)?.({ action: "cancel" });
      }
      this.store.run(
        "UPDATE mcp_calls SET state='abandoned',updatedAt=? WHERE conversationId=? AND state='paused'",
        Date.now(),
        conversationId,
      );
      this.store.run(
        "UPDATE meta SET value=json_set(value,'$.used',json('true')) WHERE key GLOB 'telegram:button:*' AND json_extract(value,'$.kind')='mcp' AND json_extract(value,'$.conversationId')=?",
        conversationId,
      );
    });
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.inflight, ...this.tails.values()]);
  }
  private abandon(interaction: McpInteraction, call: McpCall, action: string) {
    // Local cancellation never bypasses a deny or changes the service's paused execution.
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.store.run(
        "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
        JSON.stringify({ action }),
        interaction.id,
      ).changes;
      if (claimed)
        this.store.run(
          "UPDATE mcp_calls SET state='abandoned',result=?,updatedAt=? WHERE id=?",
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "A espera local foi encerrada. A execução permanece pausada no serviço; nenhuma chamada resume foi enviada.",
              },
            ],
          }),
          Date.now(),
          call.id,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=?",
      interaction.id,
    )!;
  }
  reconcile(conversationId: string, id: string, note: string) {
    if (this.closed) throw new PolicyError("Aplicação encerrando");
    if (!note.trim())
      throw new PolicyError(
        "Informe o resultado verificado no serviço externo",
      );
    if (
      this.store.get(
        "SELECT 1 FROM mcp_interactions WHERE conversationId=? AND callId=? AND state='pending'",
        conversationId,
        id,
      )
    )
      throw new PolicyError(
        "Conclua, recuse ou cancele as solicitações MCP pendentes antes de registrar o resultado verificado",
      );
    this.store.run(
      "UPDATE mcp_calls SET state='reconciled',result=?,updatedAt=? WHERE id=? AND conversationId=? AND state='uncertain'",
      JSON.stringify({ note }),
      Date.now(),
      id,
      conversationId,
    );
    return this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
  }
}
