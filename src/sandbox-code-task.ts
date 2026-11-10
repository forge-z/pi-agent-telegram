import { randomBytes } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import {
  clearDiscovery,
  envWithDiscovery,
  resolveTemplates,
} from "./discover.js";
import { loadHarnessConfig } from "./harness-config.js";
import { renderTemplate } from "./job-manifest.js";
import { McpNotSentError, PolicyError } from "./mcp.js";
import {
  classifyExecutorCall,
  commandExitCode,
  deterministicFailure,
  sandboxCall,
} from "./pending-jobs.js";
import { SCHEDULED_APPROVAL_REFUSAL } from "./guards.js";

export const JOB_INDETERMINATE =
  "A chamada foi iniciada, mas o provedor perdeu o retorno dela (erro interno do Executor). O job continua em andamento e o resultado chegará automaticamente neste tópico. Não repita o pedido nem dispare outro job.";

type Env = Record<string, string | undefined>;
type Call = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/** Everything provider-specific comes from `sandbox_code_task` in config.yaml. */
interface Task {
  tool: string;
  job: string;
  description?: string;
  server?: string;
  requires?: string[];
  idPrefix?: string;
  goal?: string;
  parameters: TSchema;
  exec: { tool: string; args?: Record<string, unknown> };
  allow?: { field: string; patterns?: string; default?: string };
  readonly?: { env?: string; command?: string; prompt?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The config block, or undefined when it is incomplete. */
function readTask(env: Env): Task | undefined {
  const raw = loadHarnessConfig(env).sandboxTask;
  if (!isRecord(raw) || !isRecord(raw.exec)) return undefined;
  const task = raw as unknown as Task;
  if (
    typeof task.tool !== "string" ||
    typeof task.job !== "string" ||
    typeof task.exec.tool !== "string"
  )
    return undefined;
  if (task.requires?.some((name) => !(env[name] ?? "").trim()))
    return undefined;
  return {
    ...task,
    parameters: isRecord(task.parameters)
      ? (task.parameters as TSchema)
      : Type.Object({}),
    exec: {
      ...task.exec,
      args: isRecord(task.exec.args) ? task.exec.args : {},
    },
  };
}

/**
 * System-prompt line while the long-task tool is actually registered.
 * The name comes from config. An incomplete block hides both the tool and this line.
 */
export function sandboxTaskSteer(env: Env = process.env): string | undefined {
  const task = readTask(env);
  if (!task) return;
  return `For anything long-running, or when the user asks to be told when it finishes ("avise quando terminar"), call ${task.tool} once. Never poll that work in a loop.`;
}

/** `owner/*` matches an owner, `*` matches anything, otherwise an exact value. */
export function isAllowed(value: string, patterns = ""): boolean {
  const [owner] = value.split("/");
  return (
    !!owner &&
    patterns.split(",").some((raw) => {
      const pattern = raw.trim().toLowerCase();
      if (pattern === "*" || pattern === "*/*") return true;
      return pattern.endsWith("/*")
        ? owner.toLowerCase() === pattern.slice(0, -2)
        : value.toLowerCase() === pattern;
    })
  );
}

function allowPatterns(allow: Task["allow"], env: Env): string {
  if (!allow) return "";
  const override = env.INSTABOX_REPO_ALLOWLIST?.trim();
  if (override) return override;
  const rendered = String(
    renderTemplate(allow.patterns ?? "", env) ?? "",
  ).trim();
  return rendered && !rendered.includes("${")
    ? rendered
    : (allow.default ?? "");
}

function createJobId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`.toLowerCase();
}

const READONLY_PROMPT =
  "Somente leitura: não faça push, não abra pull requests e não comente.";

function readOnly(task: Task) {
  const mode = task.readonly;
  if (!mode || typeof mode !== "object") return;
  const configured = typeof mode.prompt === "string" ? mode.prompt.trim() : "";
  return {
    env: typeof mode.env === "string" ? mode.env.trim() : "",
    command: typeof mode.command === "string" ? mode.command.trim() : "",
    prompt: configured || READONLY_PROMPT,
  };
}

function commandSlot(args: Record<string, unknown>, path: string) {
  const parts = path.split(".").filter(Boolean);
  let node: unknown = args;
  for (const key of parts.slice(0, -1)) {
    if (!isRecord(node)) return;
    node = node[key];
  }
  const key = parts.at(-1);
  if (!key || !isRecord(node) || typeof node[key] !== "string") return;
  return { parent: node, key };
}

function clip(value: string) {
  return value
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function writePreview(task: Task, input: Record<string, unknown>) {
  const goal = task.goal ?? "";
  const lines = ["Escrita em tarefa de código"];
  for (const [key, value] of Object.entries(input)) {
    if (key === goal || key === "writes") continue;
    if (typeof value !== "string" || !value.trim()) continue;
    lines.push(`${key}: ${clip(value)}`);
  }
  if (!lines.some((line) => line.startsWith("branch:")))
    lines.push("branch: (padrão do job)");
  const prompt = goal ? input[goal] : undefined;
  if (typeof prompt === "string" && prompt.trim())
    lines.push(`${goal}: ${clip(prompt)}`);
  return lines.join("\n");
}

function renderExec(
  task: Task,
  env: Env,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
) {
  const rendered = renderTemplate(task.exec.args ?? {}, {
    ...envWithDiscovery(env),
    id: jobId,
    job_id: jobId,
    goal,
    payload: JSON.stringify(input),
  });
  return isRecord(rendered) ? rendered : {};
}

function prepareExec(
  task: Task,
  env: Env,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
  writes: boolean,
) {
  const mode = writes ? undefined : readOnly(task);
  const field = task.goal;
  const text = field ? input[field] : undefined;
  const noted =
    mode?.command &&
    field &&
    typeof text === "string" &&
    !text.includes(mode.prompt)
      ? { ...input, [field]: `${text}\n\n${mode.prompt}` }
      : input;
  const args = renderExec(task, env, jobId, goal, noted);
  if (!mode?.command) return args;
  const slot = commandSlot(args, mode.command);
  if (!slot) return renderExec(task, env, jobId, goal, input);
  if (!mode.env) return args;
  const current = String(slot.parent[slot.key]);
  if (current !== mode.env && !current.startsWith(`${mode.env} `))
    slot.parent[slot.key] = `${mode.env} ${current}`;
  return args;
}

function missingMachine(error: unknown) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b404\b/.test(text) || /not[\s_-]*found/i.test(text);
}

/** Clears the cache and looks up again. Same args means the id did not change. */
async function retarget(
  env: Env,
  call: Call,
  task: Task,
  jobId: string,
  goal: string | undefined,
  input: Record<string, unknown>,
  previous: Record<string, unknown>,
  writes: boolean,
): Promise<{ error?: string; args?: Record<string, unknown> }> {
  clearDiscovery(env);
  const resolved = await resolveTemplates(env, call, [task.exec.args ?? {}]);
  if (!resolved.ok) return { error: resolved.error };
  const args = prepareExec(task, env, jobId, goal, input, writes);
  if (JSON.stringify(args) === JSON.stringify(previous)) return {};
  return { args };
}

type DispatchText = { text: string; isError?: true; rejected?: true };

async function dispatchJob(
  app: Runtime,
  env: Env,
  task: Task,
  executor: string,
  usesSandbox: boolean,
  conversationId: string,
  input: Record<string, unknown>,
  call: Call,
  writes: boolean,
  signal?: AbortSignal,
): Promise<DispatchText> {
  const json = (body: unknown, rejected?: true): DispatchText => ({
    text: JSON.stringify(body),
    ...(rejected ? { rejected } : {}),
  });
  const resolved = await resolveTemplates(env, call, [task.exec.args ?? {}]);
  if (!resolved.ok) return json({ error: resolved.error }, true);

  const jobId = createJobId(task.idPrefix ?? "job-");
  const goal = task.goal
    ? String(input[task.goal] ?? "")
        .trim()
        .slice(0, 120)
    : undefined;
  let execArgs = prepareExec(task, env, jobId, goal, input, writes);
  const account =
    typeof execArgs.accountId === "string" && execArgs.accountId.trim()
      ? execArgs.accountId.trim()
      : undefined;

  // Register before dispatching, so a lost response is still covered.
  if (
    !app.pendingJobs.registerKnown(
      conversationId,
      task.job,
      jobId,
      goal,
      account,
    )
  )
    return json(
      {
        error:
          "Leitura do job inválida ou desabilitada. Tarefa não registrada.",
      },
      true,
    );

  const server = usesSandbox ? executor : task.server!;
  const failed = (detail: string): DispatchText => {
    app.pendingJobs.closeKnownUnstarted(jobId, conversationId);
    return json(
      { error: `Erro ao disparar tarefa: ${detail}`.slice(0, 800) },
      true,
    );
  };
  let rediscovered = false;
  for (;;) {
    const attempt = signal
      ? AbortSignal.any([AbortSignal.timeout(20_000), signal])
      : AbortSignal.timeout(20_000);

    try {
      const tool = usesSandbox ? "execute" : task.exec.tool;
      const callArgs = usesSandbox
        ? { code: sandboxCall(task.exec.tool, execArgs) }
        : execArgs;
      const rawResult = await call(server, tool, callArgs, { signal: attempt });
      const outcome = classifyExecutorCall(rawResult);
      if (outcome.kind === "failure" && outcome.notFound && !rediscovered) {
        rediscovered = true;
        const again = await retarget(
          env,
          call,
          task,
          jobId,
          goal,
          input,
          execArgs,
          writes,
        );
        if (again.error) return failed(again.error);
        if (again.args) {
          execArgs = again.args;
          continue;
        }
      }
      if (outcome.kind === "approval") {
        // A scheduled run cannot wait for a card. The command has not run, so
        // refusing here neither repeats it nor needs a resume.
        if (app.scheduledTurn(conversationId))
          return { text: SCHEDULED_APPROVAL_REFUSAL, isError: true };
        // Nothing ran yet: leave the row open so a later approval delivers.
        try {
          app.mcpCalls?.noteExecutorPause(
            conversationId,
            server,
            tool,
            callArgs,
            rawResult,
          );
        } catch {
          /* the tool result still reports the pending approval */
        }
        return json({
          jobId,
          status: "approval_pending",
          ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
          message:
            "A chamada pausou aguardando aprovação. A tarefa ainda não foi iniciada. Aprove o cartão nesta conversa. Não repita o pedido nem diga que o job foi disparado.",
        });
      }
      if (outcome.kind === "failure")
        return outcome.deterministic
          ? failed(outcome.message)
          : { text: JOB_INDETERMINATE };
      const exitCode = commandExitCode(outcome.value);
      if (exitCode !== undefined && exitCode !== 0) {
        const record = isRecord(outcome.value) ? outcome.value : {};
        const detail = [record.stderr, record.stdout]
          .filter((part) => typeof part === "string" && part.trim())
          .join("\n")
          .slice(0, 500);
        return failed(detail || `o launcher terminou com exitCode ${exitCode}`);
      }
      return json({
        jobId,
        status: "dispatched",
        message:
          "Tarefa disparada na sandbox com sucesso. O resultado chegará neste tópico assim que terminar; não é preciso acompanhar.",
      });
    } catch (error) {
      if (!rediscovered && missingMachine(error)) {
        rediscovered = true;
        const again = await retarget(
          env,
          call,
          task,
          jobId,
          goal,
          input,
          execArgs,
          writes,
        );
        if (again.error) return failed(again.error);
        if (again.args) {
          execArgs = again.args;
          continue;
        }
      }
      // Nothing was sent, or the server rejected the call before it ran.
      if (
        error instanceof PolicyError ||
        error instanceof McpNotSentError ||
        deterministicFailure(error)
      )
        return failed(error instanceof Error ? error.message : String(error));
      // Indeterminate timeout or transient error: keep the row open and
      // let the poller confirm via the manifest's observe tool.
      return { text: JOB_INDETERMINATE };
    }
  }
}

function asToolResult(outcome: DispatchText) {
  return outcome.isError
    ? {
        output: [{ type: "text" as const, text: outcome.text }],
        isError: true as const,
      }
    : { output: [{ type: "text" as const, text: outcome.text }] };
}

export function createSandboxCodeTaskTool(
  app: Runtime,
  env: Env = process.env,
) {
  const task = readTask(env);
  if (!task) return undefined;
  const patterns = allowPatterns(task.allow, env);
  const executor = (env.ASYNC_JOB_EXECUTOR ?? "").trim() || "executor";
  const usesSandbox =
    !task.server || task.server === "executor" || task.server === executor;
  app.mcpCalls?.setDeferredDispatch(async (spec) => {
    const conversationId =
      typeof spec.conversationId === "string" ? spec.conversationId : "";
    const input = isRecord(spec.input) ? spec.input : undefined;
    const call = (app.options.gateway as { callDirect?: Call }).callDirect;
    if (!conversationId || !input || !call)
      return {
        state: "failed",
        text: "A tarefa de escrita não foi disparada.",
      };
    const outcome = await dispatchJob(
      app,
      env,
      task,
      executor,
      usesSandbox,
      conversationId,
      input,
      call,
      true,
    );
    return {
      state: outcome.isError || outcome.rejected ? "failed" : "done",
      text: outcome.text,
    };
  });

  return defineTool({
    name: task.tool,
    description:
      task.description ??
      'Para qualquer tarefa que possa passar de ~60s ou quando pedirem "avise quando terminar": chame esta ferramenta uma vez. Nunca fique em loop de leitura esperando o fim. O disparo não bloqueia a conversa; o resultado chega automaticamente quando a tarefa termina. writes=true só para push, pull request ou comentário (pede aprovação antes de disparar); sem writes a tarefa é somente leitura.',
    parameters: task.parameters,
    replay: "safe",
    execute: async (
      args: Record<string, unknown>,
      api: ToolExecutionApi,
      callContext?: { abortSignal?: AbortSignal },
    ) => {
      const reply = (body: unknown) => ({
        output: [{ type: "text" as const, text: JSON.stringify(body) }],
      });
      const input = isRecord(args) ? args : {};
      let valid = false;
      try {
        valid = Value.Check(task.parameters, input);
      } catch {
        /* an invalid schema in config never becomes a caller error */
      }
      if (!valid)
        return reply({ error: "Parâmetros inválidos para a tarefa." });
      const allowedValue = task.allow
        ? String(input[task.allow.field] ?? "").trim()
        : "";
      if (task.allow && !isAllowed(allowedValue, patterns))
        return reply({
          error: `Valor "${allowedValue}" não permitido pela política (${patterns}).`,
        });

      const gateway = app.options.gateway as { callDirect?: Call };
      if (!gateway?.callDirect)
        return reply({
          error: "Gateway MCP direto indisponível para disparar o job.",
        });
      const conversationId = String(api.conversationId);
      if (input.writes === true) {
        // A scheduled run cannot wait for a card, and nothing has been sent.
        if (app.scheduledTurn(conversationId))
          return {
            output: [
              { type: "text" as const, text: SCHEDULED_APPROVAL_REFUSAL },
            ],
            isError: true,
          };
        const server = usesSandbox ? executor : task.server!;
        const requestId = app.mcpCalls?.noteDeferredApproval(
          conversationId,
          server,
          task.tool,
          writePreview(task, input),
          { conversationId, input },
        );
        if (!requestId)
          return reply({
            error:
              "Aprovação indisponível; a tarefa de escrita não foi disparada.",
          });
        return reply({
          status: "approval_pending",
          requestId,
          message:
            "A escrita precisa de aprovação. A tarefa ainda não foi iniciada. Aprove o cartão nesta conversa. Não repita o pedido nem diga que o job foi disparado.",
        });
      }
      return asToolResult(
        await dispatchJob(
          app,
          env,
          task,
          executor,
          usesSandbox,
          conversationId,
          input,
          gateway.callDirect,
          false,
          callContext?.abortSignal,
        ),
      );
    },
  });
}
