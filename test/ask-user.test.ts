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
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Runtime } from "../src/runtime.js";
import { ASK_CALLBACK, ASK_USER_SCHEDULED_ERROR } from "../src/ask-user.js";
import { configureTelegram } from "../src/telegram-polling.js";
import {
  Telegram,
  type TelegramTransport,
  type TelegramUpdate,
} from "../src/telegram.js";
import { button, type TelegramReplyMarkup } from "../src/telegram-controls.js";
import { Tasks } from "../src/tasks.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};
const owner = { chat: "-100123", user: "42", messageThreadId: 11 };
const question = "Ship the draft?";
const choices = ["Approve", "Revise"];

interface View {
  id: number;
  text: string;
  markup?: TelegramReplyMarkup;
  thread?: number;
}

async function askFixture(responses: FauxResponseStep[]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-user-"));
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = { catalog: async () => [] };
  const options = {
    dir,
    models,
    gateway,
    initialize: (store: Runtime["store"]) =>
      configureTelegram(store, config, { id: 123 }),
  };
  let app = await Runtime.open(options);
  const views: View[] = [];
  const answers: string[] = [];
  let nextMessage = 700;
  const transport: TelegramTransport = {
    send: async (_chat, text, opts) => {
      const id = nextMessage++;
      views.push({
        id,
        text,
        markup: opts?.replyMarkup,
        thread: opts?.messageThreadId,
      });
      return { message_id: id };
    },
    editMessage: async (_chat, id, text, markup) => {
      views.push({ id, text, markup, thread: owner.messageThreadId });
      return true;
    },
    answerCallback: async (_id, text) => {
      answers.push(text);
    },
  };
  const engine = () =>
    new Telegram(
      app,
      transport,
      config.users,
      config.chats,
      "test_bot",
      false,
      123,
    );
  let bot = engine();
  const wire = () => {
    app.flushTelegramPending = () => {
      void bot.flush();
    };
  };
  wire();
  const id = await app.telegramChats.ensure(owner);
  let updateId = 1;
  const send = async (text: string) => {
    const update: TelegramUpdate = {
      update_id: updateId++,
      message: {
        message_id: updateId,
        text,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
      },
    };
    await bot.receive(update);
    return update;
  };
  const click = async (data: string, messageId = views.at(-1)?.id ?? 700) => {
    const update: TelegramUpdate = {
      update_id: updateId++,
      callback_query: {
        id: `cb-${updateId}`,
        data,
        from: { id: 42 },
        message: {
          message_id: messageId,
          date: 1,
          from: { id: 123 },
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: 11,
        },
      },
    };
    const result = await bot.receive(update);
    await bot.flush();
    return result;
  };
  const settle = async () => {
    await (await app.conversation(id)).waitForIdle(context);
    await bot.flush();
    for (let n = 0; n < 50; n++) {
      if (
        !app.store.get(
          "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
          id,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("turn still pending");
  };
  const requests = () =>
    app.store.all<{ text: string; requestId: string; status: string }>(
      "SELECT text, requestId, status FROM requests WHERE conversationId=? ORDER BY rowid",
      id,
    );
  return {
    dir,
    faux,
    models,
    get app() {
      return app;
    },
    get bot() {
      return bot;
    },
    views,
    answers,
    id,
    send,
    click,
    settle,
    requests,
    async reopen(steps: FauxResponseStep[]) {
      await bot.drain();
      await app.close();
      const resumed = fauxProvider();
      resumed.setResponses(steps);
      models.setProvider(resumed.provider);
      app = await Runtime.open(options);
      bot = engine();
      wire();
      return resumed;
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function askTurn() {
  return fauxAssistantMessage(
    [
      fauxToolCall("ask_user", {
        question,
        choices,
      }),
    ],
    { stopReason: "toolUse" },
  );
}

test("a question with choices posts a keyboard and ends the turn", async () => {
  const f = await askFixture([askTurn()]);
  try {
    await f.send("need a decision");
    await f.settle();
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.requests().length, 1);
    assert.equal(f.requests()[0].status, "done");
    const card = f.views.find((view) => view.text.includes(question));
    assert.ok(card, JSON.stringify(f.views));
    assert.equal(card.thread, 11);
    const buttons = card.markup?.inline_keyboard.flat() ?? [];
    assert.deepEqual(
      buttons.map((item) => item.text),
      choices,
    );
    assert.equal(buttons.length, 2);
    for (const [index, item] of buttons.entries()) {
      assert.match(item.callback_data ?? "", ASK_CALLBACK);
      assert.equal(item.callback_data?.endsWith(`:${index}`), true);
      assert.equal(item.callback_data?.startsWith("pi:"), false);
    }
    assert.equal(
      buttons[0].callback_data?.slice(0, -2),
      buttons[1].callback_data?.slice(0, -2),
    );
    assert.equal(
      f.app.store.all("SELECT key FROM meta WHERE key GLOB 'telegram:button:*'")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a tap is admitted once and a duplicate or stale tap is ignored", async () => {
  const f = await askFixture([askTurn(), fauxAssistantMessage("noted")]);
  try {
    await f.send("need a decision");
    await f.settle();
    const card = f.views.find((view) => view.text.includes(question))!;
    const data = card.markup!.inline_keyboard[0][0].callback_data!;
    await f.click(data, card.id);
    await f.settle();
    const texts = f.requests().map((row) => row.text);
    assert.deepEqual(texts, [
      "need a decision",
      `Answer to: ${question} -> Approve`,
    ]);
    assert.equal(f.answers.at(-1), "Answer recorded.");
    const edited = f.views.find(
      (view) => view.id === card.id && view.text.includes("Answer: Approve"),
    );
    assert.ok(edited);
    assert.deepEqual(edited.markup?.inline_keyboard, []);
    const before = f.faux.state.callCount;
    await f.click(data, card.id);
    await f.settle();
    assert.equal(f.requests().length, 2);
    assert.equal(f.faux.state.callCount, before);
    assert.equal(f.answers.at(-1), "Already answered.");
    await f.click(`ask:${"ab".repeat(16)}:0`, card.id);
    await f.settle();
    assert.equal(f.requests().length, 2);
    assert.equal(f.faux.state.callCount, before);
    assert.equal(f.answers.at(-1), "This question is no longer active.");
  } finally {
    await f.close();
  }
});

test("a typed reply is a normal message and a later tap does not start a turn", async () => {
  const f = await askFixture([askTurn(), fauxAssistantMessage("ok")]);
  try {
    await f.send("need a decision");
    await f.settle();
    const card = f.views.find((view) => view.text.includes(question))!;
    const data = card.markup!.inline_keyboard[1][0].callback_data!;
    await f.send("rewrite the opening");
    await f.settle();
    assert.deepEqual(
      f.requests().map((row) => row.text),
      ["need a decision", "rewrite the opening"],
    );
    const cleared = f.views.find(
      (view) =>
        view.id === card.id && view.markup?.inline_keyboard.length === 0,
    );
    assert.ok(cleared);
    const calls = f.faux.state.callCount;
    await f.click(data, card.id);
    await f.settle();
    assert.equal(f.requests().length, 2);
    assert.equal(f.faux.state.callCount, calls);
    assert.equal(f.answers.at(-1), "This question is no longer active.");
  } finally {
    await f.close();
  }
});

test("a pending question survives restart and a second tap does not", async () => {
  const f = await askFixture([askTurn()]);
  try {
    await f.send("need a decision");
    await f.settle();
    const card = f.views.find((view) => view.text.includes(question))!;
    const data = card.markup!.inline_keyboard[0][0].callback_data!;
    assert.match(data, ASK_CALLBACK);
    const resumed = await f.reopen([fauxAssistantMessage("noted")]);
    await f.click(data, card.id);
    await f.settle();
    assert.equal(
      f.requests().at(-1)?.text,
      `Answer to: ${question} -> Approve`,
    );
    assert.equal(resumed.state.callCount, 1);
    await f.click(data, card.id);
    await f.settle();
    assert.equal(
      f.requests().filter((row) => row.text.startsWith("Answer to:")).length,
      1,
    );
    assert.equal(resumed.state.callCount, 1);
    assert.equal(f.answers.at(-1), "Already answered.");
  } finally {
    await f.close();
  }
});

test("ask_user is refused in a scheduled run and does not post or notify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-scheduled-"));
  const faux = fauxProvider();
  let sawError = false;
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("ask_user", {
          question,
          choices,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (transcript) => {
      const results = transcript.messages.filter(
        (message) => message.role === "toolResult",
      );
      const last = results.at(-1);
      assert.equal(last?.isError, true);
      assert.match(
        JSON.stringify(last),
        /ask_user not available in scheduled runs/,
      );
      sawError = true;
      return fauxAssistantMessage("sem pergunta");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
  });
  const tasks = new Tasks(app, () => Date.parse("2026-10-07T12:00:00Z"));
  try {
    const conversationId = await app.create();
    app.store.run(
      "INSERT OR REPLACE INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ botId: 123, token: "123:synthetic-test" }),
    );
    app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "42",
      conversationId,
      "42",
    );
    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversationId,
    );
    app.store.run(
      "INSERT INTO telegram_conversations VALUES (?,?,?)",
      conversationId,
      "42",
      "42",
    );
    app.store.run(
      "INSERT INTO telegram_topic_conversations VALUES (?,?)",
      conversationId,
      11,
    );
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify({
        enabled: true,
        bot: { id: 123 },
        chatId: "42",
        userId: "42",
        conversationId,
      }),
    );
    const task = await tasks.create({
      title: "Lembrete",
      prompt: "Pergunte se o rascunho sai",
      kind: "cron",
      schedule: "* * * * *",
      conversationId,
      delivery: "web_telegram",
    });
    await tasks.runNow(task.id);
    await (await app.conversation(conversationId)).waitForIdle(context);
    for (let n = 0; n < 50; n++) {
      if (
        !app.store.get(
          "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
          conversationId,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await tasks.tick();
    assert.equal(sawError, true);
    assert.equal(
      ASK_USER_SCHEDULED_ERROR,
      "ask_user not available in scheduled runs",
    );
    assert.equal(app.store.all("SELECT id FROM deliveries").length, 0);
    assert.equal(
      app.store.all("SELECT key FROM meta WHERE key GLOB 'telegram:ask:*'")
        .length,
      0,
    );
    const run = tasks.runs(task.id)[0];
    assert.equal(run.state, "done");
    assert.equal(run.status, "silencioso");
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an approval-card callback stays on the pi: path", async () => {
  const f = await askFixture([fauxAssistantMessage("idle")]);
  try {
    const data = button(f.app, {
      kind: "mcp",
      owner,
      originThreadId: owner.messageThreadId,
      conversationId: f.id,
      interactionId: "missing-interaction",
      interactionHash: "0".repeat(64),
      decision: "decline",
    });
    assert.match(data, /^pi:[a-f0-9]{32}$/);
    assert.equal(ASK_CALLBACK.test(data), false);
    await f.click(data, 900);
    const saved = f.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:button:${data}`,
    );
    assert.equal(JSON.parse(saved!.value).used, true);
    assert.equal(
      f.answers.at(-1),
      "Decision received; follow the result in this topic.",
    );
    assert.equal(f.requests().length, 0);
    assert.equal(
      f.app.store.all("SELECT key FROM meta WHERE key GLOB 'telegram:ask:*'")
        .length,
      0,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});
