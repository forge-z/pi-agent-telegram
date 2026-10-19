import { createHash, randomUUID } from "node:crypto";
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
  validateMcpUrlElicitation,
  PolicyError,
} from "./mcp.js";
import type { Store } from "./store.js";

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
/** Executor tools that describe the executor instead of acting on anything. */
const READ_ONLY = new Set([
  "search",
  "describe",
  "skills",
  "list-artifacts",
  "show-artifact",
  "resume",
]);

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
  "Passo pulado: execução agendada não pode aguardar aprovação humana. Nenhuma ação externa foi executada nem retomada. Não resuma este passo; siga com o restante ou encerre.";
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
export class McpCalls {
  private tails = new Map<string, Promise<unknown>>();
  private waiters = new Map<string, (value: ElicitResult) => void>();
  private controllers = new Set<AbortController>();
  private callControllers = new Map<string, AbortController>();
  private inflight = new Set<Promise<CallToolResult>>();
  private closed = false;
  constructor(
    private store: Store,
    private gateway: McpGateway,
    private onPending?: () => void,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, binding TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_interactions(id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL, server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', response TEXT);
      CREATE INDEX IF NOT EXISTS mcp_calls_conversation ON mcp_calls(conversationId);
      CREATE INDEX IF NOT EXISTS mcp_interactions_conversation ON mcp_interactions(conversationId);
      UPDATE mcp_interactions SET state='expired' WHERE state='pending' AND kind!='resume'
        AND NOT (kind='url' AND json_valid(payload) AND json_extract(payload,'$.source')='url_required_error');
      UPDATE mcp_calls SET state='uncertain' WHERE state='running';`);
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
    this.gateway.assertDirect(server, tool);
    const id = createHash("sha256")
      .update(`mcp:${conversationId}:${taskId}`)
      .digest("hex")
      .slice(0, 24);
    const existing = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      id,
    );
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
    if (this.pending(conversationId) && !READ_ONLY.has(tool))
      throw new McpNotSentError(
        "Responda à solicitação pendente do servidor MCP antes de continuar",
      );
    if (
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND server=? AND state='uncertain'",
        conversationId,
        server,
      )
    )
      throw new McpNotSentError(
        "Verifique e registre o resultado MCP incerto antes de executar outra chamada neste servidor",
      );
    // A resume is what unlocks the queue, so it never waits behind it. It may only answer a
    // decision already open in this conversation: the agent cannot invent one.
    if (tool === "resume") {
      const requestId =
        typeof (args as { requestId?: unknown }).requestId === "string"
          ? (args as { requestId: string }).requestId
          : "";
      const open =
        !!requestId &&
        this.store.get<{ id: string }>(
          "SELECT id FROM mcp_interactions WHERE conversationId=? AND state='pending' AND kind='resume' AND json_valid(payload) AND json_extract(payload,'$.requestId')=?",
          conversationId,
          requestId,
        );
      // A card the user never saw cannot authorize anything.
      const shown =
        !!open &&
        !!this.store.get(
          "SELECT 1 FROM deliveries WHERE id LIKE ? AND state='sent'",
          `telegram:mcp:${open.id}%`,
        );
      if (!shown)
        throw new PolicyError(
          "Retomadas com decisão de permissão devem usar a solicitação do servidor exibida na conversa",
        );
    } else if (
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND state IN ('running','paused')",
        conversationId,
      )
    )
      throw new McpNotSentError(
        "Aguarde a chamada ou retomada MCP em andamento; nenhuma nova ferramenta foi enviada",
      );
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
    try {
      if (this.closed)
        throw new McpNotSentError(
          "Aplicação encerrando; nenhuma chamada MCP foi enviada",
        );
      try {
      } catch {
        throw new McpNotSentError(
          "CUA pausado para intervenção humana. Nenhuma chamada MCP foi enviada.",
        );
      }
      const result = await this.gateway.callDirect(call.server, tool, args, {
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
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          skippedApproval
            ? "skipped"
            : paused
              ? "paused"
              : unsupportedPause ||
                  (status &&
                    ["busy", "unavailable"].includes(String(status.status)))
                ? "uncertain"
                : result.isError
                  ? "failed"
                  : "done",
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
      const result: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text: scheduledSkip
              ? APPROVAL_SKIPPED
              : error instanceof PolicyError || error instanceof McpError
                ? error.message
                : "Resultado MCP incerto. Verifique o serviço antes de tentar outra execução.",
          },
        ],
      };
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
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          error instanceof PolicyError || error instanceof McpNotSentError
            ? "failed"
            : "uncertain",
          JSON.stringify(result),
          Date.now(),
          id,
        );
        this.store.db.exec("COMMIT");
      } catch (storageError) {
        this.store.db.exec("ROLLBACK");
        // A failed card publication must still block replay of the dispatched call.
        this.store.run(
          "UPDATE mcp_calls SET state='uncertain',result=?,updatedAt=? WHERE id=?",
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
      throw error;
    } finally {
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
  /**
   * Every object a result carries, outermost first. A pause is not always at the top:
   * `execute` answers inside its own envelope (`{ok, data:{content:[{text}]}}`) and a
   * paused tool's payload travels in there, so the search has to descend.
   */
  private pauseCandidates(result: CallToolResult): Record<string, unknown>[] {
    const candidates: Record<string, unknown>[] = [];
    const walk = (value: unknown, depth: number) => {
      if (depth > 6 || value === undefined || value === null) return;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed[0] !== "{" && trimmed[0] !== "[") return;
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          /* ordinary text */
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (!object(value)) return;
      candidates.push(value);
      for (const key of [
        "content",
        "data",
        "execution",
        "value",
        "result",
        "output",
        // The paused payload usually arrives as JSON text, not as a field.
        "text",
      ])
        walk(value[key], depth + 1);
    };
    walk(result.structuredContent, 0);
    for (const item of result.content) walk(item, 0);
    return candidates;
  }
  private executorPauseKind(value: Record<string, unknown>) {
    if (Object.hasOwn(value, "approvalUrl")) return undefined;
    const status = String(value.status ?? "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");
    if (status === "approval_required" || status === "paused")
      return "approval-required";
    if (status === "input_required") return "input-required";
    if (
      status === "waiting_for_interaction" ||
      status === "awaiting_approval" ||
      status === "awaiting_input"
    )
      return "approval-required";
    if (value.paused === true) return "approval-required";
    if (
      typeof value.executionId === "string" &&
      value.executionId.trim() &&
      (object(value.invocation) ||
        typeof value.tool === "string" ||
        object(value.execution) ||
        (object(value.elicitation) && value.elicitation.mode === "form"))
    )
      return "approval-required";
    return undefined;
  }
  private looksLikeExecutorPause(value: Record<string, unknown>) {
    return !!this.executorPauseKind(value);
  }
  /** Normalize MODEL-mode Executor pauses, including executionId aliases and partial payloads. */
  private normalizeExecutorPause(
    raw: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    let value = raw;
    if (object(value.execution)) value = { ...value.execution, ...value };
    const status = this.executorPauseKind(value);
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
