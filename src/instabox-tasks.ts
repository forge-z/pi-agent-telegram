import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { INSTABOX_CODE_TASK_TOOL } from "./job-manifest.js";
import { McpNotSentError, PolicyError } from "./mcp.js";
import {
  classifyExecutorCall,
  commandExitCode,
  deterministicFailure,
  sandboxCall,
} from "./pending-jobs.js";

const JOB_ID_REGEX = /^[a-z0-9-]{8,40}$/;
const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_AGENTS = ["agy", "pi", "claude"] as const;
type AgentName = (typeof ALLOWED_AGENTS)[number];

const MAX_PROMPT_BYTES = 32 * 1024; // 32 KiB

export const JOB_INDETERMINATE =
  "A chamada foi iniciada, mas o provedor perdeu o retorno dela (erro interno do Executor). O job continua em andamento e o resultado chegará automaticamente neste tópico. Não repita o pedido nem dispare outro job.";

/** Checks if a repo matches the allowlist (default "example/*", supports comma-separated patterns). */
export function isRepoAllowed(repo: string, allowlistStr?: string): boolean {
  const allowed = (allowlistStr ?? "example/*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const [owner] = repo.split("/");
  if (!owner) return false;
  return allowed.some((pattern) => {
    if (pattern === "*" || pattern === "*/*") return true;
    if (pattern.endsWith("/*")) {
      const allowedOwner = pattern.slice(0, -2);
      return owner.toLowerCase() === allowedOwner.toLowerCase();
    }
    return repo.toLowerCase() === pattern.toLowerCase();
  });
}

/** Generates a validated jobId conforming to ^[a-z0-9-]{8,40}$. */
function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  const id = `cj-${ts}-${rand}`.toLowerCase();
  if (!JOB_ID_REGEX.test(id)) {
    throw new Error(`Job ID gerado inválido: ${id}`);
  }
  return id;
}

/** Account the Instabox tool was configured with. Empty means the row must carry one. */
function resolveInstaboxAccountId(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.INSTABOX_ACCOUNT_ID ?? "").trim();
}

/**
 * Creates the `instabox_code_task` tool if INSTABOX_MACHINE_ID is configured.
 * Returns undefined when not configured so the tool is not registered.
 */
export function createInstaboxCodeTaskTool(
  app: Runtime,
  env: Record<string, string | undefined> = process.env,
) {
  const machineId = (env.INSTABOX_MACHINE_ID ?? "").trim();
  if (!machineId) return undefined;

  const allowlist = env.INSTABOX_REPO_ALLOWLIST?.trim() || "example/*";
  const executorServer = env.ASYNC_JOB_EXECUTOR?.trim() || "executor";
  const accountId = resolveInstaboxAccountId(env);

  return defineTool({
    name: "instabox_code_task",
    description:
      "Dispara uma tarefa de código assíncrona na sandbox Instabox. O disparo é imediato e não bloqueia a conversa; o resultado chegará automaticamente neste tópico quando o agente concluir.",
    parameters: Type.Object({
      repo: Type.String({
        description: "Repositório no formato owner/name permitido na allowlist",
      }),
      agent: Type.Union(
        [Type.Literal("agy"), Type.Literal("pi"), Type.Literal("claude")],
        {
          description: "Agente executor na sandbox (agy, pi ou claude)",
        },
      ),
      prompt: Type.String({
        description: "Instruções completas da tarefa de código",
        minLength: 1,
      }),
      branch: Type.Optional(
        Type.String({
          description: "Branch base/alvo opcional (padrão agent/<jobId>)",
        }),
      ),
    }),
    replay: "safe",
    execute: async (
      args: { repo: string; agent: string; prompt: string; branch?: string },
      api: ToolExecutionApi,
      callContext?: { abortSignal?: AbortSignal },
    ) => {
      const conversationId = String(api.conversationId);
      const repo = String(args.repo ?? "").trim();
      const agent = String(args.agent ?? "").trim() as AgentName;
      const prompt = String(args.prompt ?? "");
      const branch = args.branch ? String(args.branch).trim() : undefined;

      // 1. Validations
      if (!REPO_REGEX.test(repo)) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Formato de repositório inválido: "${repo}". Use "owner/name".`,
              }),
            },
          ],
        };
      }
      if (!isRepoAllowed(repo, allowlist)) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Repositório "${repo}" não permitido pela política de repositórios (${allowlist}).`,
              }),
            },
          ],
        };
      }
      if (!ALLOWED_AGENTS.includes(agent)) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Agente "${agent}" inválido. Escolha entre: ${ALLOWED_AGENTS.join(", ")}.`,
              }),
            },
          ],
        };
      }
      if (!prompt.trim()) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Prompt da tarefa não pode ser vazio.",
              }),
            },
          ],
        };
      }
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Prompt excede o tamanho máximo de ${MAX_PROMPT_BYTES} bytes.`,
              }),
            },
          ],
        };
      }

      // 2. Generate jobId
      const jobId = generateJobId();

      // 3. Register in pending_jobs before dispatch
      const goal = prompt.trim().slice(0, 120);
      const opened = app.pendingJobs.registerKnown(
        conversationId,
        INSTABOX_CODE_TASK_TOOL,
        jobId,
        goal,
        accountId || undefined,
      );
      if (!opened) {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "Leitura do job inválida (esperado {accountId, input}). Tarefa não registrada.",
              }),
            },
          ],
        };
      }

      // 4. Dispatch via Executor tools.instabox.machines.exec
      const gateway = app.options.gateway as {
        callDirect?: (
          server: string,
          tool: string,
          args: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => Promise<unknown>;
      };

      if (!gateway?.callDirect) {
        app.pendingJobs.closeKnownUnstarted(jobId, conversationId);
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Gateway MCP direto indisponível para disparar o job.",
              }),
            },
          ],
        };
      }

      const execInput: Record<string, unknown> = {
        id: machineId,
        cmd: `bash ~/bin/start-job.sh ${jobId}`,
        timeoutSeconds: 15,
        stdin: JSON.stringify({
          repo,
          agent,
          prompt,
          ...(branch ? { branch } : {}),
        }),
      };

      // `tools.instabox.machines.exec` is not an MCP tool. The server only
      // exposes execute/call/…; the path runs inside an execute program.
      const execArgs: Record<string, unknown> = { input: execInput };
      if (accountId) execArgs.accountId = accountId;
      const code = sandboxCall("tools.instabox.machines.exec", execArgs);

      // 15s execution timeout + margin for network
      const dispatchSignal = callContext?.abortSignal
        ? AbortSignal.any([
            AbortSignal.timeout(20_000),
            callContext.abortSignal,
          ])
        : AbortSignal.timeout(20_000);

      const failed = (detail: string) => {
        app.pendingJobs.closeKnownUnstarted(jobId, conversationId);
        return {
          output: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Erro ao disparar tarefa: ${detail}`.slice(0, 800),
              }),
            },
          ],
        };
      };

      try {
        const rawResult = await gateway.callDirect(
          executorServer,
          "execute",
          { code },
          { signal: dispatchSignal },
        );
        const outcome = classifyExecutorCall(rawResult);

        if (outcome.kind === "approval") {
          // The command has not run. Leave the row open so a later approval
          // still delivers, and surface the card instead of saying dispatched.
          try {
            app.mcpCalls?.noteExecutorPause(
              conversationId,
              executorServer,
              "execute",
              { code },
              rawResult,
            );
          } catch {
            /* the tool result still reports the pending approval */
          }
          const requestId = outcome.requestId || "apr_";
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId,
                  status: "approval_pending",
                  ...(outcome.requestId
                    ? { requestId: outcome.requestId }
                    : {}),
                  message: `O Executor pausou o disparo aguardando aprovação (${requestId}). A tarefa ainda não foi iniciada. Aprove o cartão nesta conversa. Não repita o pedido nem diga que o job foi disparado.`,
                }),
              },
            ],
          };
        }

        if (outcome.kind === "failure") {
          if (!outcome.deterministic) {
            return {
              output: [{ type: "text", text: JOB_INDETERMINATE }],
            };
          }
          return failed(outcome.message);
        }

        const exitCode = commandExitCode(outcome.value);
        if (exitCode !== undefined && exitCode !== 0) {
          const record =
            outcome.value && typeof outcome.value === "object"
              ? (outcome.value as Record<string, unknown>)
              : {};
          const detail = [record.stderr, record.stdout]
            .filter((part) => typeof part === "string" && part.trim())
            .join("\n")
            .slice(0, 500);
          return failed(
            detail || `o launcher terminou com exitCode ${exitCode}`,
          );
        }

        return {
          output: [
            {
              type: "text",
              text: JSON.stringify({
                jobId,
                status: "dispatched",
                message:
                  "Tarefa disparada na sandbox com sucesso. O resultado chegará neste tópico assim que terminar; não é preciso acompanhar.",
              }),
            },
          ],
        };
      } catch (error) {
        // Nothing was sent, or the server rejected the call before it ran.
        if (
          error instanceof PolicyError ||
          error instanceof McpNotSentError ||
          deterministicFailure(error)
        )
          return failed(error instanceof Error ? error.message : String(error));

        // Indeterminate timeout or transient error:
        // Do not block conversation with uncertain, and do not close row:
        // Poller will confirm by checking status.json
        return {
          output: [
            {
              type: "text",
              text: JOB_INDETERMINATE,
            },
          ],
        };
      }
    },
  });
}
