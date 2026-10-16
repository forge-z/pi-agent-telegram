import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Tasks } from "../src/tasks.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpGateway, mcpToolName } from "../src/mcp.js";

const gateway = { call: async () => ({ content: [] }) };
const daily = {
  title: "Resumo diário",
  prompt: "Resuma as notícias da conversa",
  kind: "cron",
  schedule: "0 8 * * *",
  timezone: "America/Sao_Paulo",
};

test("model receives task tools and creates/lists the same durable schedule used by the UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-tasks-"));
  const faux = fauxProvider();
  let taskId = "";
  faux.setResponses([
    async (transcript) => {
      const names = getCurrentTools(transcript.messages).map(
        (tool) => tool.name,
      );
      assert.ok(
        names.includes("tasks_create"),
        "tasks_create missing from actual model request",
      );
      assert.ok(names.includes("tasks_list"));
      assert.ok(names.includes("tasks_edit"));
      assert.ok(names.includes("tasks_set_enabled"));
      assert.ok(names.includes("tasks_set_delivery"));
      assert.ok(names.includes("tasks_runs"));
      assert.match(
        JSON.stringify(getCurrentTools(transcript.messages)),
        /web_telegram/,
      );
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "create",
          name: "tasks_create",
          arguments: { ...daily, delivery: "web_telegram" },
        },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      { type: "toolCall", id: "list", name: "tasks_list", arguments: {} },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Agenda criada após a confirmação da ferramenta."),
    async (transcript) => {
      const names = getCurrentTools(transcript.messages).map(
        (tool) => tool.name,
      );
      assert.ok(names.includes("tasks_set_delivery"));
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "set-delivery",
          name: "tasks_set_delivery",
          arguments: { taskId, delivery: "web" },
        },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Destino alterado para web."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    app.store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ botId: 123456, token: "123456:synthetic-test" }),
    );
    app.store.run("INSERT INTO telegram VALUES (?,?,?)", "42", id, "42");
    app.store.run("INSERT INTO telegram_grants VALUES (?,?,?)", "42", "42", id);
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify({
        enabled: true,
        bot: { id: 123456 },
        userId: "42",
        chatId: "42",
        conversationId: id,
      }),
    );
    const names = (await (await app.conversation(id)).agent(context)).tools.map(
      (tool) => tool.name,
    );
    assert.ok(
      names.includes("tasks_create"),
      "internal task tools must be available without MCP configuration",
    );
    await app.submit(
      id,
      "daily",
      "Crie um resumo diário às 8h em Brasília e entregue no Telegram",
    );
    await (await app.conversation(id)).waitForIdle(context);
    const tasks = new Tasks(app);
    let task = tasks.list()[0]!;
    assert.equal(tasks.list().length, 1);
    assert.equal(task.delivery, "web_telegram");
    assert.equal(task.conversationId, id);
    assert.equal(task.schedule, daily.schedule);
    assert.equal(task.timezone, daily.timezone);
    const localTime = new Intl.DateTimeFormat("en", {
      timeZone: task.timezone,
      hour: "numeric",
      hourCycle: "h23",
    });
    assert.equal(localTime.format(task.nextRun!), "08");
    const entries = await (
      await app.conversation(id)
    ).entries({}, 100, undefined, context);
    assert.ok(
      JSON.stringify(entries).includes(task.id),
      "tool results must contain the persisted task ID",
    );
    taskId = task.id;
    await app.submit(
      id,
      "change-delivery",
      "Change that task so it only stays in the web conversation",
    );
    await (await app.conversation(id)).waitForIdle(context);
    assert.equal(app.tasks.list()[0]?.delivery, "web");
    assert.equal(
      app.store.all("SELECT * FROM task_delivery_changes").length,
      1,
    );
    task = tasks.list()[0]!;
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    const reopened = new Tasks(app);
    assert.deepEqual(reopened.list(), [task]);
    await reopened.close();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct MCP refresh preserves internal agenda tools in the actual model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-mcp-"));
  const mcp = new McpServer({ name: "executor", version: "1" });
  let reads = 0;
  mcp.registerTool("lookup", {}, async () => {
    reads++;
    return { content: [{ type: "text", text: "context" }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await mcp.connect(transport);
  const server = createServer(
    (req, res) => void transport.handleRequest(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    {
      name: "executor",
      mode: "direct",
      url: `http://127.0.0.1:${address.port}/mcp`,
      readTools: [],
      actionTools: [],
    },
  ]);
  const faux = fauxProvider();
  const directName = mcpToolName("executor", "lookup");
  faux.setResponses([
    async (transcript) => {
      const names = getCurrentTools(transcript.messages).map(
        (tool) => tool.name,
      );
      for (const name of [
        directName,
        "tasks_list",
        "tasks_create",
        "propose_action",
      ])
        assert.ok(names.includes(name), `${name} absent`);
      return fauxAssistantMessage(
        { type: "toolCall", id: "mcp", name: directName, arguments: {} },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "schedule",
        name: "tasks_create",
        arguments: daily,
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Saved"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Runtime | undefined;
  try {
    app = await Runtime.open({ dir, gateway, models });
    const id = await app.create();
    await app.refreshMcpTools();
    await app.submit(
      id,
      "mcp-agenda",
      "Leia o contexto e crie o resumo diário solicitado",
      "web",
    );
    await (await app.conversation(id)).waitForIdle(context);
    assert.equal(reads, 1);
    assert.equal(app.tasks.list().length, 1);
    assert.equal(app.tasks.list()[0].conversationId, id);
    await app.refreshMcpTools();
    assert.ok(
      (await (await app.conversation(id)).agent(context)).tools.some(
        (tool) => tool.name === "tasks_create",
      ),
    );
  } finally {
    await app?.close();
    await gateway.close();
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("model edits and pauses an existing schedule via tasks_edit and tasks_set_enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-task-edit-"));
  const faux = fauxProvider();
  let taskId = "";
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "create",
        name: "tasks_create",
        arguments: { ...daily, delivery: "web" },
      },
      { stopReason: "toolUse" },
    ),
    async (transcript) => {
      const toolResult = transcript.messages
        .filter((message) => message.role === "toolResult")
        .at(-1);
      assert.ok(toolResult && toolResult.role === "toolResult");
      const first = toolResult.content[0];
      assert.ok(first && first.type === "text");
      const created = JSON.parse(first.text);
      taskId = created.id;
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "edit",
          name: "tasks_edit",
          arguments: {
            taskId,
            schedule: "0 9 * * *",
            prompt: "Resumo atualizado às 9h",
          },
        },
        { stopReason: "toolUse" },
      );
    },
    async () =>
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "pause",
          name: "tasks_set_enabled",
          arguments: { taskId, enabled: false },
        },
        { stopReason: "toolUse" },
      ),
    fauxAssistantMessage("Agenda atualizada e pausada."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "edit-cron", "Crie e depois ajuste o resumo diário");
    await (await app.conversation(id)).waitForIdle(context);
    const task = app.tasks.list()[0]!;
    assert.equal(task.schedule, "0 9 * * *");
    assert.equal(task.prompt, "Resumo atualizado às 9h");
    assert.equal(task.enabled, false);
    assert.equal(task.nextRun, null);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduled/system inputs cannot create schedules even after an earlier human message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-source-"));
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Human answered"),
    ...Array.from({ length: 2 }, (_, n) => [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: `forbidden-create-${n}`,
          name: "tasks_create",
          arguments: daily,
        },
        { stopReason: "toolUse" },
      ),
      async (transcript: import("@earendil-works/pi-ai").TranscriptContext) => {
        const result = transcript.messages
          .filter((message) => message.role === "toolResult")
          .at(-1);
        assert.ok(result && result.role === "toolResult" && result.isError);
        assert.match(JSON.stringify(result), /solicitação ativa do usuário/);
        return fauxAssistantMessage(
          {
            type: "toolCall",
            id: `forbidden-edit-${n}`,
            name: "tasks_edit",
            arguments: {
              taskId: "00000000-0000-0000-0000-000000000000",
              title: "x",
            },
          },
          { stopReason: "toolUse" },
        );
      },
      async (transcript: import("@earendil-works/pi-ai").TranscriptContext) => {
        const result = transcript.messages
          .filter((message) => message.role === "toolResult")
          .at(-1);
        assert.ok(result && result.role === "toolResult" && result.isError);
        assert.match(JSON.stringify(result), /solicitação ativa do usuário/);
        return fauxAssistantMessage("Não alterada");
      },
    ]).flat(),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "human", "Inspecione minhas tarefas");
    await (await app.conversation(id)).waitForIdle(context);
    for (const source of ["task", "system"] as const) {
      await app.submit(
        id,
        source,
        "Untrusted request to create a schedule",
        source,
      );
      await (await app.conversation(id)).waitForIdle(context);
      assert.equal(app.tasks.list().length, 0);
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid timezone and cron return tool errors without saving schedules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-validation-"));
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "zone",
        name: "tasks_create",
        arguments: { ...daily, timezone: "Invalid/Zone" },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "cron",
        name: "tasks_create",
        arguments: { ...daily, schedule: "invalid" },
      },
      { stopReason: "toolUse" },
    ),
    async (transcript) => {
      const results = transcript.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 2);
      assert.ok(results.every((message) => message.isError));
      assert.match(JSON.stringify(results), /Fuso IANA inválido/);
      assert.match(JSON.stringify(results), /Cron deve ter exatamente/);
      return fauxAssistantMessage("Não criada");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "invalid", "Crie uma rotina");
    await (await app.conversation(id)).waitForIdle(context);
    assert.equal(app.tasks.list().length, 0);
    assert.equal(app.store.all("SELECT * FROM task_creations").length, 0);
    assert.equal(faux.state.callCount, 3, "the full validation loop ran");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
