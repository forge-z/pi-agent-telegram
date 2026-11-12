import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { McpGateway, mcpToolName } from "../src/mcp.js";
import { SCHEDULED_APPROVAL_REFUSAL } from "../src/guards.js";

const APPROVAL = {
  status: "approval-required",
  requestId: "apr_test",
  expiresAt: Date.now() + 60_000,
  invocation: {
    app: "notes",
    tool: "create",
    input: { text: "hello" },
  },
};

type DirectResult =
  | { kind: "text"; text: string }
  | { kind: "structured"; body: Record<string, unknown> };

async function runTurn(options: {
  server: string;
  tool: string;
  args: { [key: string]: string };
  scheduled: boolean;
  result: DirectResult;
  checkResult: (result: { isError?: boolean }) => void;
}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-approval-mode-"));
  const gateway = new McpGateway([
    {
      name: options.server,
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [
    {
      server: options.server,
      mode: "direct",
      tools: [
        {
          name: options.tool,
          description: "",
          inputSchema: { type: "object" },
          operation: "direct",
        },
      ],
    },
  ];
  gateway.connectionBinding = async () => "binding";
  let calls = 0;
  const tools: string[] = [];
  gateway.callDirect = (async (_server: string, tool: string) => {
    calls += 1;
    tools.push(tool);
    if (options.result.kind === "text")
      return { content: [{ type: "text", text: options.result.text }] };
    return { content: [], structuredContent: options.result.body };
  }) as unknown as typeof gateway.callDirect;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "mcp-action",
        name: mcpToolName(options.server, options.tool),
        arguments: options.args,
      },
      { stopReason: "toolUse" },
    ),
    (transcript) => {
      const result = transcript.messages
        .filter((message) => message.role === "toolResult")
        .at(-1);
      assert.ok(result && result.role === "toolResult");
      options.checkResult(result);
      return fauxAssistantMessage("done");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Runtime | undefined;
  try {
    app = await Runtime.open({ dir, gateway, models });
    let conversationId: string;
    if (options.scheduled) {
      const task = await app.tasks.create({
        title: "Agendado",
        prompt: "Faça a ação externa",
        kind: "cron",
        schedule: "0 8 * * *",
        timezone: "UTC",
        delivery: "none",
      });
      conversationId = task.conversationId;
      await app.tasks.runNow(task.id);
    } else {
      conversationId = await app.create();
      await app.submit(conversationId, "turn", "Faça a ação", "web");
    }
    await (await app.conversation(conversationId)).waitForIdle(context);
    return { app, gateway, dir, calls, tools, conversationId };
  } catch (error) {
    await app?.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function close(opened: Awaited<ReturnType<typeof runTurn>>) {
  await opened.app.close();
  await opened.gateway.close();
  await rm(opened.dir, { recursive: true, force: true });
}

test("an executor non-read tool runs interactively without a local card", async () => {
  const opened = await runTurn({
    server: "executor",
    tool: "execute",
    args: { code: "send note" },
    scheduled: false,
    result: { kind: "text", text: "sent" },
    checkResult: (result) => {
      assert.equal(result.isError, false);
      assert.doesNotMatch(JSON.stringify(result), /needs approval/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /approval required by Executor/,
      );
      assert.match(JSON.stringify(result), /sent/);
    },
  });
  try {
    assert.equal(opened.calls, 1);
    assert.equal(
      opened.app.mcpCalls.interactions(opened.conversationId).length,
      0,
    );
    assert.equal(
      opened.app.mcpCalls.list(opened.conversationId)[0]?.state,
      "done",
    );
  } finally {
    await close(opened);
  }
});

test("an executor non-read tool runs in a scheduled run", async () => {
  const opened = await runTurn({
    server: "executor",
    tool: "execute",
    args: { code: "send note" },
    scheduled: true,
    result: { kind: "text", text: "sent" },
    checkResult: (result) => {
      assert.equal(result.isError, false);
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
      assert.match(JSON.stringify(result), /sent/);
    },
  });
  try {
    assert.equal(opened.calls, 1);
    assert.equal(
      opened.app.mcpCalls.interactions(opened.conversationId).length,
      0,
    );
    assert.equal(
      opened.app.mcpCalls.list(opened.conversationId)[0]?.state,
      "done",
    );
  } finally {
    await close(opened);
  }
});

test("an executor approval-required pause shows the card interactively", async () => {
  const opened = await runTurn({
    server: "executor",
    tool: "execute",
    args: { code: "send note" },
    scheduled: false,
    result: { kind: "structured", body: APPROVAL },
    checkResult: (result) => {
      assert.equal(result.isError, false);
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
    },
  });
  try {
    assert.equal(opened.calls, 1);
    const [card] = opened.app.mcpCalls.interactions(opened.conversationId);
    assert.equal(card?.kind, "resume");
    assert.equal(card?.state, "pending");
    assert.match(card?.payload ?? "", /apr_test/);
    assert.match(card?.payload ?? "", /approval-required/);
    assert.equal(
      opened.app.mcpCalls.list(opened.conversationId)[0]?.state,
      "paused",
    );
  } finally {
    await close(opened);
  }
});

test("a scheduled executor approval-required pause is refused without a card", async () => {
  const opened = await runTurn({
    server: "executor",
    tool: "execute",
    args: { code: "send note" },
    scheduled: true,
    result: { kind: "structured", body: APPROVAL },
    checkResult: (result) => {
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /create:/);
      assert.match(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
      assert.doesNotMatch(JSON.stringify(result), /apr_test/);
    },
  });
  try {
    assert.equal(opened.calls, 1);
    assert.deepEqual(opened.tools, ["execute"]);
    assert.equal(
      opened.app.mcpCalls.interactions(opened.conversationId).length,
      0,
    );
    assert.equal(
      opened.app.mcpCalls.list(opened.conversationId)[0]?.state,
      "uncertain",
    );
  } finally {
    await close(opened);
  }
});

test("a local composio write keeps the scheduled refusal and sends interactively", async () => {
  const scheduled = await runTurn({
    server: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args: { text: "hello" },
    scheduled: true,
    result: { kind: "text", text: "should not run" },
    checkResult: (result) => {
      assert.equal(result.isError, true);
      assert.match(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
    },
  });
  try {
    assert.equal(scheduled.calls, 0);
    assert.equal(
      scheduled.app.mcpCalls.list(scheduled.conversationId).length,
      0,
    );
    assert.equal(
      scheduled.app.mcpCalls.interactions(scheduled.conversationId).length,
      0,
    );
  } finally {
    await close(scheduled);
  }

  const interactive = await runTurn({
    server: "composio",
    tool: "GMAIL_SEND_EMAIL",
    args: { text: "hello" },
    scheduled: false,
    result: { kind: "text", text: "sent" },
    checkResult: (result) => {
      assert.equal(result.isError, false);
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
      assert.match(JSON.stringify(result), /sent/);
    },
  });
  try {
    assert.equal(interactive.calls, 1);
    assert.equal(
      interactive.app.mcpCalls.interactions(interactive.conversationId).length,
      0,
    );
    assert.equal(
      interactive.app.mcpCalls.list(interactive.conversationId)[0]?.state,
      "done",
    );
  } finally {
    await close(interactive);
  }
});
