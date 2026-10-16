import { createHash } from "node:crypto";
import type { Store, Action } from "./store.js";
import { McpNotSentError, PolicyError, type ToolGateway } from "./mcp.js";

export class Actions {
  constructor(
    private store: Store,
    private gateway: ToolGateway,
  ) {}
  async read(
    conversationId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    scope = "manual",
  ) {
    const result = await this.gateway.call(server, tool, args, "read");
    if (
      typeof result === "object" &&
      result !== null &&
      "isError" in result &&
      result.isError
    )
      throw new Error("Leitura MCP falhou");
    this.store.run(
      "INSERT INTO reads VALUES (?,?) ON CONFLICT(conversationId) DO UPDATE SET result=excluded.result",
      `${conversationId}:${server}:${scope}`,
      JSON.stringify({ observedAt: Date.now(), result }),
    );
    return result;
  }
  propose(
    conversationId: string,
    taskId: number,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    scope = "manual",
  ) {
    const id = createHash("sha256")
      .update(`${conversationId}:${taskId}`)
      .digest("hex")
      .slice(0, 24);
    const existing = this.store.get<Action>(
      "SELECT * FROM actions WHERE id=?",
      id,
    );
    if (existing) {
      if (
        existing.server !== server ||
        existing.tool !== tool ||
        existing.args !== JSON.stringify(args)
      )
        throw new Error("Identidade de ação usada com outro conteúdo");
      return existing;
    }
    this.gateway.assertAllowed?.(server, tool, "action");
    const evidence = this.store.get<{ result: string }>(
      "SELECT result FROM reads WHERE conversationId=?",
      `${conversationId}:${server}:${scope}`,
    );
    if (
      !evidence ||
      Date.now() -
        (JSON.parse(evidence.result) as { observedAt: number }).observedAt >
        600000
    )
      throw new Error(
        "Leia o contexto externo atual com mcp_read antes de propor uma ação",
      );
    this.store.run(
      "INSERT OR IGNORE INTO actions(id,conversationId,server,tool,args,evidence) VALUES (?,?,?,?,?,?)",
      id,
      conversationId,
      server,
      tool,
      JSON.stringify(args),
      evidence.result,
    );
    return this.store.get<Action>("SELECT * FROM actions WHERE id=?", id)!;
  }
  async decide(
    conversationId: string,
    id: string,
    decision: "approve" | "deny",
    signal?: AbortSignal,
  ) {
    const action = this.store.get<Action>(
      "SELECT * FROM actions WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
    if (!action) throw new Error("Ação não encontrada");
    if (action.state !== "pending") return action;
    if (decision === "deny") {
      this.store.run(
        "UPDATE actions SET state='denied' WHERE id=? AND state='pending'",
        id,
      );
      return this.store.get<Action>("SELECT * FROM actions WHERE id=?", id)!;
    }
    // Claim is committed before any external I/O. Duplicate approvals cannot execute twice.
    const changed = this.store.run(
      "UPDATE actions SET state='running' WHERE id=? AND state='pending'",
      id,
    ).changes;
    if (changed === 0)
      return this.store.get<Action>("SELECT * FROM actions WHERE id=?", id)!;
    try {
      const result = await this.gateway.call(
        action.server,
        action.tool,
        JSON.parse(action.args) as Record<string, unknown>,
        "action",
        signal,
      );
      const failed =
        typeof result === "object" &&
        result !== null &&
        "isError" in result &&
        result.isError;
      this.store.run(
        "UPDATE actions SET state=?,result=? WHERE id=?",
        failed ? "failed" : "done",
        JSON.stringify(result),
        id,
      );
    } catch (error) {
      this.store.run(
        "UPDATE actions SET state=?,result=? WHERE id=?",
        error instanceof PolicyError || error instanceof McpNotSentError
          ? "failed"
          : "uncertain",
        JSON.stringify({
          message:
            error instanceof PolicyError
              ? "Ferramenta fora da política; não executada."
              : error instanceof McpNotSentError
                ? "A chamada MCP não foi enviada. Nenhum efeito externo foi executado."
                : "Resultado externo incerto. Verifique no serviço antes de reconciliar.",
        }),
        id,
      );
    }
    return this.store.get<Action>("SELECT * FROM actions WHERE id=?", id)!;
  }
  reconcile(conversationId: string, id: string, note: string) {
    if (!note.trim())
      throw new Error("Informe o resultado verificado no serviço externo");
    this.store.run(
      "UPDATE actions SET state='reconciled',result=? WHERE id=? AND conversationId=? AND state='uncertain'",
      JSON.stringify({ note }),
      id,
      conversationId,
    );
    const action = this.store.get<Action>(
      "SELECT * FROM actions WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
    if (!action) throw new Error("Ação não encontrada");
    return action;
  }
}
