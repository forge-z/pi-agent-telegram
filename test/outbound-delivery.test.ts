import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";

const config = {
  token: "123:synthetic-test-token",
  users: ["42"],
  chats: ["-100123"],
};

test("a tool that asks for a file reaches the delivery row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbound-delivery-"));
  const faux = fauxProvider({
    models: [{ id: "faux-1", reasoning: true }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "attach",
        name: "send_attachment",
        arguments: {
          url: "https://platform.r2.fish.audio/x/a.mp3",
          kind: "audio",
        },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Mandei o áudio."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({}) },
    telegramOnly: true,
    initialize: (store) =>
      configureTelegram(store, config, { id: 123, username: "test_bot" }),
  });
  try {
    const conversationId = await app.create();
    app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "42",
      conversationId,
      "-100123",
    );
    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "-100123",
      "42",
      conversationId,
    );
    app.store.run(
      "INSERT INTO telegram_conversations VALUES (?,?,?)",
      conversationId,
      "-100123",
      "42",
    );
    app.store.run(
      "INSERT INTO telegram_topic_conversations VALUES (?,?)",
      conversationId,
      11,
    );
    app.store.run(
      "INSERT OR REPLACE INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ botId: 123, token: "123:synthetic-test" }),
    );
    // The chat selected this conversation, which is what authorizes the admission.
    app.store.run(
      "INSERT OR REPLACE INTO telegram_topic_selection VALUES (?,?,?,?)",
      "-100123",
      "42",
      11,
      conversationId,
    );
    app.store.run(
      "INSERT OR REPLACE INTO telegram_chat_selection VALUES (?,?,?)",
      "-100123",
      "42",
      conversationId,
    );
    await app.admit(conversationId, "telegram:1", "manda o audio", {
      source: "telegram",
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    await (await app.conversation(conversationId)).waitForIdle(context);
    const rows = app.store.all<{
      id: string;
      text: string;
      media: string | null;
    }>("SELECT id,text,media FROM deliveries ORDER BY rowid");
    assert.ok(rows.length > 0, "a resposta foi enfileirada");
    const withMedia = rows.filter((row) => row.media);
    assert.equal(
      withMedia.length,
      1,
      `uma entrega carrega o anexo: ${JSON.stringify(rows)}`,
    );
    assert.match(String(withMedia[0].media), /platform\.r2\.fish\.audio/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
