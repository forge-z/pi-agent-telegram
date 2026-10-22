import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import {
  createInstaboxCodeTaskTool,
  isRepoAllowed,
  JOB_INDETERMINATE,
} from "../src/instabox-tasks.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

/** The shape `execute` returns on the real Executor MCP server. */
function executorCompleted(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

function executorFailed(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: false, error },
        }),
      },
    ],
  };
}

function getText(result: { output?: unknown[] }): string {
  const item = result?.output?.[0] as { text?: string } | undefined;
  return item?.text ?? "";
}

interface ExecInput {
  id: string;
  cmd: string;
  timeoutSeconds?: number;
  stdin?: string;
  envs?: Record<string, string>;
}

async function createFixture(
  envOverrides: Record<string, string | undefined> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-instabox-test-"));
  const models = createModels();
  models.setProvider(
    fauxProvider({
      provider: "faux",
      models: [{ id: "mock-model" }],
    }).provider,
  );

  const calls: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
  }[] = [];
  let onCallDirect:
    | ((
        server: string,
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>)
    | undefined;

  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
      readTools: [],
      actionTools: ["tools.instabox.machines.exec"],
    },
  ]);
  gateway.catalog = async () => [];
  gateway.connectionBinding = async () => "mock-binding";
  gateway.callDirect = (async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    calls.push({ server, tool, args });
    if (onCallDirect) return onCallDirect(server, tool, args);
    return executorCompleted({
      stdout: JSON.stringify({ state: "PENDING" }),
      stderr: "",
      exitCode: 0,
    });
  }) as unknown as typeof gateway.callDirect;

  const env = {
    INSTABOX_MACHINE_ID: "machine-test-1",
    INSTABOX_ACCOUNT_ID: "acc-test-1",
    INSTABOX_REPO_ALLOWLIST: "example/*, allowed-owner/specific-repo",
    ...envOverrides,
  };

  const app = await Runtime.open({
    dir,
    gateway,
    models,
    telegramOnly: false,
    env,
  });

  return {
    app,
    dir,
    env,
    calls,
    setCallDirectHandler: (
      fn: (
        server: string,
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => {
      onCallDirect = fn;
    },
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("recusa repo fora da allowlist e jobId inválido", async () => {
  assert.equal(isRepoAllowed("example/app", "example/*"), true);
  assert.equal(isRepoAllowed("example/other-repo", "example/*"), true);
  assert.equal(
    isRepoAllowed(
      "allowed-owner/specific-repo",
      "example/*, allowed-owner/specific-repo",
    ),
    true,
  );
  assert.equal(isRepoAllowed("evil-owner/malicious", "example/*"), false);
  assert.equal(isRepoAllowed("not-a-repo", "example/*"), false);

  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;

    // Disallowed repo
    const resDisallowed = await tool.execute(
      { repo: "evil/hacked", agent: "pi", prompt: "faça algo" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(resDisallowed), /não permitido pela política/i);

    // Invalid format repo
    const resBadFormat = await tool.execute(
      { repo: "just-a-name", agent: "pi", prompt: "faça algo" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(resBadFormat), /Formato de repositório inválido/i);

    // Invalid agent
    const resBadAgent = await tool.execute(
      {
        repo: "example/app",
        agent: "unknown-agent" as unknown as "pi",
        prompt: "faça algo",
      },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(getText(resBadAgent), /Agente.*inválido/i);

    // Empty prompt
    const resEmptyPrompt = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "   " },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.match(
      getText(resEmptyPrompt),
      /Prompt da tarefa não pode ser vazio/i,
    );

    // Nenhum job foi disparado
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("o prompt nunca aparece no cmd nem em envs; a ferramenta devolve o jobId sem esperar o job", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;

    const secretPrompt = "TAREFA_SUPER_SECRETA_NUNCA_NO_CMD_NEM_ENV";
    const res = await tool.execute(
      {
        repo: "example/app",
        agent: "agy",
        prompt: secretPrompt,
        branch: "feature/minha-branch",
      },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );

    // Devolve jobId e status dispatched sem esperar
    const output = JSON.parse(getText(res)) as {
      status: string;
      jobId: string;
      message: string;
    };
    assert.equal(output.status, "dispatched");
    assert.match(output.jobId, /^cj-[a-z0-9-]+$/);
    assert.match(output.message, /resultado chegará neste tópico/i);

    // Verifica chamada ao Executor: o path vive dentro de `execute`, não é o nome MCP.
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.tool, "execute");
    const code = String(call.args.code ?? "");
    assert.match(code, /await tools\.instabox\.machines\.exec\(/);
    assert.doesNotMatch(code, /==\s*null/);
    const input = JSON.parse(
      /machines\.exec\((\{.*\})\)/.exec(code)?.[1] ?? "null",
    ) as { accountId?: string; input: ExecInput };
    assert.equal(input.accountId, "acc-test-1");
    assert.equal(input.input.id, "machine-test-1");
    assert.match(
      input.input.cmd,
      new RegExp(`^bash ~/bin/start-job\\.sh ${output.jobId}$`),
    );
    assert.equal(input.input.timeoutSeconds, 15);

    // CRÍTICO: o prompt NUNCA aparece no cmd nem em envs!
    assert.doesNotMatch(input.input.cmd, new RegExp(secretPrompt));
    assert.equal(input.input.envs, undefined);

    // E o prompt está no stdin JSON
    const parsedStdin = JSON.parse(input.input.stdin!) as {
      repo: string;
      agent: string;
      prompt: string;
      branch: string;
    };
    assert.equal(parsedStdin.repo, "example/app");
    assert.equal(parsedStdin.agent, "agy");
    assert.equal(parsedStdin.prompt, secretPrompt);
    assert.equal(parsedStdin.branch, "feature/minha-branch");
  } finally {
    await f.close();
  }
});

test("registra pending_jobs com run_id=jobId", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;

    const res = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "construir teste" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    const output = JSON.parse(getText(res)) as { jobId: string };

    // Verifica a linha criada na tabela pending_jobs
    const row = f.app.store.get<{
      run_id: string;
      tool: string;
      conversation_id: string;
      delivered_at: number | null;
    }>("SELECT * FROM pending_jobs WHERE run_id=?", output.jobId);
    assert.ok(row, "linha foi criada em pending_jobs com run_id=jobId");
    assert.equal(row.run_id, output.jobId);
    assert.equal(row.tool, "internal.instabox.codeTask");
    assert.equal(row.conversation_id, convId);
    assert.equal(row.delivered_at, null);
  } finally {
    await f.close();
  }
});

test("timeout do exec vira indeterminado sem deixar bloqueio uncertain", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;

    // Simula timeout da máquina ao iniciar o launcher
    f.setCallDirectHandler(async () => {
      throw new Error("TimeoutError: The operation timed out after 15000ms");
    });

    const res = await tool.execute(
      {
        repo: "example/app",
        agent: "claude",
        prompt: "tarefa com timeout no exec",
      },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );

    // Devolve texto de job indeterminado
    assert.equal(getText(res), JOB_INDETERMINATE);

    // A linha em pending_jobs PERMANECE aberta para o poller confirmar via status.json
    const row = f.app.store.get<{
      delivered_at: number | null;
    }>("SELECT * FROM pending_jobs WHERE conversation_id=?", convId);
    assert.ok(row, "linha continua aberta");
    assert.equal(row.delivered_at, null);

    // CRÍTICO: nenhuma chamada em mcp_calls ficou em estado uncertain que travaria a conversa
    const uncertainCalls = f.app.store.all<{ id: string }>(
      "SELECT * FROM mcp_calls WHERE conversationId=? AND state='uncertain'",
      convId,
    );
    assert.equal(
      uncertainCalls.length,
      0,
      "não cria bloqueio uncertain na conversa",
    );
  } finally {
    await f.close();
  }
});

test("sem INSTABOX_MACHINE_ID a ferramenta não é registrada", async () => {
  const f = await createFixture({ INSTABOX_MACHINE_ID: "" });
  try {
    const tool = createInstaboxCodeTaskTool(f.app, f.env);
    assert.equal(
      tool,
      undefined,
      "ferramenta não é instanciada sem MACHINE_ID",
    );

    const convId = await f.app.create("Test Conv");
    const agent = await (await f.app.conversation(convId)).agent(context);
    const hasTool = agent.tools.some(
      (t: { name: string }) => t.name === "instabox_code_task",
    );
    assert.equal(hasTool, false);
  } finally {
    await f.close();
  }
});

test("chamada comum a tools.instabox.machines.exec NÃO cria linha em pending_jobs", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");

    // Simula uma chamada normal do modelo a machines.exec
    const opened = f.app.pendingJobs.register(
      "executor",
      "tools.instabox.machines.exec",
      convId,
      "chamada comum de exec",
    );
    assert.equal(
      opened,
      false,
      "não deve registrar job para machines.exec comum",
    );

    const rows = f.app.store.all<{ id: string }>(
      "SELECT * FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(rows.length, 0, "nenhuma linha aberta em pending_jobs");
  } finally {
    await f.close();
  }
});

test("execution.ok false não é dispatched e fecha a linha", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () =>
      executorFailed({
        kind: "ToolCallFailed",
        message: "machine not running",
        response: { status: 400, code: "bad_request", retryable: false },
      }),
    );
    const res = await tool.execute(
      { repo: "example/app", agent: "agy", prompt: "rode os testes" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.doesNotMatch(getText(res), /"status"\s*:\s*"dispatched"/);
    assert.match(getText(res), /Erro ao disparar tarefa/i);
    const row = f.app.store.get<{
      delivered_at: number | null;
      outcome: string | null;
    }>(
      "SELECT delivered_at, outcome FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.ok(row?.delivered_at, "a linha fecha: o comando não chegou a rodar");
    assert.equal(row?.outcome, "dispatch_error");
  } finally {
    await f.close();
  }
});

test("isError do MCP não é dispatched", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Unknown tool: tools.instabox.machines.exec",
        },
      ],
    }));
    const res = await tool.execute(
      { repo: "example/app", agent: "pi", prompt: "corrija o teste" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.doesNotMatch(getText(res), /"status"\s*:\s*"dispatched"/);
    assert.match(getText(res), /Erro ao disparar tarefa/i);
    assert.equal(f.calls[0]?.tool, "execute");
    const row = f.app.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.ok(row?.delivered_at);
  } finally {
    await f.close();
  }
});

test("aprovação pendente (apr_) não é dispatched e registra o cartão", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "approval-required",
            requestId: "apr_abc123",
            elicitation: {
              mode: "form",
              message: "Approve machines.exec?",
              requestedSchema: { type: "object", properties: {} },
            },
          }),
        },
      ],
    }));
    const res = await tool.execute(
      { repo: "example/app", agent: "agy", prompt: "abra o PR" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    const output = JSON.parse(getText(res)) as {
      status: string;
      requestId?: string;
    };
    assert.equal(output.status, "approval_pending");
    assert.equal(output.requestId, "apr_abc123");
    assert.notEqual(output.status, "dispatched");
    const row = f.app.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(
      row?.delivered_at,
      null,
      "a linha segue aberta para depois da aprovação",
    );
    const pending = f.app.store.all<{ payload: string; state: string }>(
      "SELECT payload, state FROM mcp_interactions WHERE conversationId=?",
      convId,
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.state, "pending");
    assert.match(pending[0]?.payload ?? "", /apr_abc123/);
  } finally {
    await f.close();
  }
});

test("exitCode diferente de zero não é dispatched", async () => {
  const f = await createFixture();
  try {
    const convId = await f.app.create("Test Conv");
    const tool = createInstaboxCodeTaskTool(f.app, f.env)!;
    f.setCallDirectHandler(async () =>
      executorCompleted({
        stdout: "",
        stderr: "run-job.sh não encontrado",
        exitCode: 1,
      }),
    );
    const res = await tool.execute(
      { repo: "example/app", agent: "claude", prompt: "rode" },
      { conversationId: convId } as unknown as ToolExecutionApi,
      context,
    );
    assert.doesNotMatch(getText(res), /"status"\s*:\s*"dispatched"/);
    assert.match(getText(res), /run-job\.sh não encontrado/);
    const row = f.app.store.get<{ outcome: string | null }>(
      "SELECT outcome FROM pending_jobs WHERE conversation_id=?",
      convId,
    );
    assert.equal(row?.outcome, "dispatch_error");
  } finally {
    await f.close();
  }
});
