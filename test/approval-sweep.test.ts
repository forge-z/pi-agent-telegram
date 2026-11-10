import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import { configureTelegram } from "../src/telegram-polling.js";
import { sweepMcpApprovals } from "../src/telegram-approvals.js";
import { APPROVAL_EXPIRE_MS, APPROVAL_REMIND_MS } from "../src/guards.js";
import type { TelegramReplyMarkup } from "../src/telegram-controls.js";

test("an unanswered approval card is reminded once and then expired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-approval-sweep-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const gateway = new McpGateway([]);
  gateway.catalog = async () => [];
  const owner = { chat: "100", user: "42" };
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "123:test", users: ["42"], chats: ["100"] },
        { id: 123, username: "test_bot" },
      ),
  });
  try {
    const conversationId = await app.telegramChats.ensure(owner);
    const now = Date.now();
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,'paused',?,?,?)",
      "call-sweep",
      conversationId,
      "executor",
      "execute",
      "{}",
      "{}",
      "binding",
      now,
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
      "interaction-sweep",
      "call-sweep",
      conversationId,
      "executor",
      "resume",
      JSON.stringify({ invocation: { tool: "agent.automation.runAsync" } }),
    );
    const prefix = "telegram:mcp:interaction-sweep-v3";
    app.store.run(
      "INSERT INTO deliveries(id,chat,text,state,parseMode) VALUES (?,?,?,'sent','HTML')",
      `${prefix}:0`,
      "100",
      "card",
    );
    app.store.run(
      "UPDATE deliveries SET result=? WHERE id=?",
      JSON.stringify({ message_id: 777 }),
      `${prefix}:0`,
    );
    const at = (value: number) =>
      app.store.run(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        "telegram:approval-at:interaction-sweep",
        String(value),
      );

    at(now - APPROVAL_REMIND_MS - 1_000);
    await sweepMcpApprovals(app);
    const reminder = app.store.get<{ replyTo: number; text: string }>(
      "SELECT replyTo,text FROM deliveries WHERE id='telegram:mcp-reminder:interaction-sweep:0'",
    );
    assert.ok(reminder, "o lembrete precisa ser enfileirado uma vez");
    assert.equal(reminder!.replyTo, 777);
    assert.match(reminder!.text, /still pending/);
    await sweepMcpApprovals(app);
    assert.equal(
      app.store.all(
        "SELECT 1 FROM deliveries WHERE id GLOB 'telegram:mcp-reminder:interaction-sweep:*'",
      ).length,
      1,
    );

    at(now - APPROVAL_EXPIRE_MS - 1_000);
    const edits: {
      chat: string;
      messageId: number;
      text: string;
      markup: TelegramReplyMarkup;
    }[] = [];
    await sweepMcpApprovals(app, async (chat, messageId, text, markup) => {
      edits.push({ chat, messageId, text, markup });
    });
    assert.equal(edits.length, 1);
    assert.equal(edits[0].messageId, 777);
    assert.match(edits[0].text, /expired/i);
    assert.deepEqual(edits[0].markup, { inline_keyboard: [] });
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM mcp_interactions WHERE id='interaction-sweep'",
      )?.state,
      "expired",
    );
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id='call-sweep'",
      )?.state,
      "abandoned",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
