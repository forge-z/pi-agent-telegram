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
import type { TelegramApi } from "../src/telegram-api.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramUpdate } from "../src/telegram.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};

test("a reply in a topic and in a chat tells the model id, author and text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-reply-"));
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("ok tópico"),
    fauxAssistantMessage("ok chat"),
    fauxAssistantMessage("ok solto"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
    telegramOnly: true,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  const polling = new TelegramPolling(
    app,
    { call: async () => ({}) } as unknown as TelegramApi,
    config,
    { id: 123 },
  );
  try {
    const topic = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    const chat = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
    });
    const long = "a".repeat(600);
    const topicUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        text: "e esse ponto?",
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        reply_to_message: {
          message_id: 7,
          text: long,
          from: { id: 123, is_bot: true },
        },
        quote: { text: "trecho citado" },
      },
    };
    await polling.engine.receive(topicUpdate);
    await (await app.conversation(topic)).waitForIdle(context);
    const topicText = app.store.get<{ text: string }>(
      "SELECT text FROM requests WHERE conversationId=?",
      topic,
    )!.text;
    assert.match(topicText, /\[respondendo a #7 · bot\]/);
    assert.match(topicText, /e esse ponto\?/);
    assert.match(topicText, /\[citação\] trecho citado/);
    assert.ok(topicText.includes("a".repeat(500)));
    assert.equal(topicText.includes("a".repeat(501)), false);

    await polling.engine.receive({
      update_id: 2,
      message: {
        message_id: 11,
        text: "concordo",
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        reply_to_message: {
          message_id: 3,
          caption: "legenda da foto",
          from: { id: 99, is_bot: false },
        },
      },
    });
    await (await app.conversation(chat)).waitForIdle(context);
    const chatText = app.store.get<{ text: string }>(
      "SELECT text FROM requests WHERE conversationId=?",
      chat,
    )!.text;
    assert.match(chatText, /\[respondendo a #3 · usuário\]/);
    assert.match(chatText, /legenda da foto/);
    assert.match(chatText, /concordo/);

    await polling.engine.receive({
      update_id: 3,
      message: {
        message_id: 12,
        text: "mensagem solta",
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
      },
    });
    await (await app.conversation(topic)).waitForIdle(context);
    const plain = app.store
      .all<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=? ORDER BY rowid",
        topic,
      )
      .at(-1)!.text;
    assert.equal(plain, "mensagem solta");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("system notices are not replies, and answering one names the notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-notice-"));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const payloads: Record<string, unknown>[] = [];
  let nextMessage = 50;
  const api = {
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      if (method === "sendMessage") {
        payloads.push(payload);
        return { message_id: nextMessage++ };
      }
      return {};
    },
  };
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
    telegramOnly: true,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  const polling = new TelegramPolling(
    app,
    api as unknown as TelegramApi,
    config,
    { id: 123 },
  );
  try {
    const topic = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    const notice =
      "Um job assíncrono disparado neste tópico terminou. O preço foi extraído.";
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,?,?)",
      topic,
      "job:1:run",
      notice,
      "job",
      null,
    );
    app.store.queueTelegram(
      `${topic}:job:1:run`,
      "-100123",
      notice,
      3500,
      topic,
      11,
    );
    app.store.queueTelegram(
      "parked:9",
      "-100123",
      "Tarefa estacionada: pi.generation #9 nesta conversa.",
      3500,
      topic,
      11,
    );
    await polling.engine.flush();
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.equal(payload.reply_parameters, undefined);
      assert.equal(payload.message_thread_id, 11);
      assert.equal(String(payload.chat_id), "-100123");
    }
    assert.match(String(payloads[0]?.text), /job assíncrono/);

    await polling.engine.receive({
      update_id: 8,
      message: {
        message_id: 80,
        text: "e o link?",
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        reply_to_message: {
          message_id: 50,
          from: { id: 123, is_bot: true },
        },
        quote: { text: "preço foi extraído" },
      },
    });
    await (await app.conversation(topic)).waitForIdle(context);
    const text = app.store
      .all<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=? AND source='telegram' ORDER BY rowid",
        topic,
      )
      .at(-1)!.text;
    assert.match(text, /\[respondendo a #50 · aviso do sistema\]/);
    assert.match(text, /A mensagem respondida é um aviso do sistema/);
    assert.match(text, /Um job assíncrono disparado neste tópico terminou/);
    assert.match(text, /\[citação\] preço foi extraído/);
    assert.match(text, /e o link\?/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
