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

test("a background run refuses an approval-requiring MCP call before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-scheduled-approval-"));
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [
    {
      server: "executor",
      mode: "direct",
      tools: [
        {
          name: "execute",
          description: "",
          inputSchema: { type: "object" },
          operation: "direct",
        },
      ],
    },
  ];
  gateway.connectionBinding = async () => "binding";
  let calls = 0;
  gateway.callDirect = (async () => {
    calls += 1;
    return { content: [{ type: "text", text: "should not run" }] };
  }) as unknown as typeof gateway.callDirect;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "mcp-action",
        name: mcpToolName("executor", "execute"),
        arguments: { code: "external action" },
      },
      { stopReason: "toolUse" },
    ),
    (transcript) => {
      const result = transcript.messages
        .filter((message) => message.role === "toolResult")
        .at(-1);
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, true);
      assert.match(
        JSON.stringify(result),
        new RegExp(SCHEDULED_APPROVAL_REFUSAL),
      );
      return fauxAssistantMessage("sem ação externa");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const task = await app.tasks.create({
      title: "Agendado",
      prompt: "Faça a ação externa",
      kind: "cron",
      schedule: "0 8 * * *",
      timezone: "UTC",
      delivery: "none",
    });
    await app.tasks.runNow(task.id);
    await (await app.conversation(task.conversationId)).waitForIdle(context);
    assert.equal(calls, 0);
    assert.equal(
      app.store.all(
        "SELECT 1 FROM mcp_calls WHERE conversationId=?",
        task.conversationId,
      ).length,
      0,
    );
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});
