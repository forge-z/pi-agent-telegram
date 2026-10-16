import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";

function linkChat(
  app: Runtime,
  chat: string,
  user: string,
  conversationId: string,
) {
  app.store.run(
    "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
    chat,
    conversationId,
    user,
  );
  app.store.run(
    "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
    chat,
    user,
    conversationId,
  );
}

import { Telegram, type TelegramUpdate } from "../src/telegram.js";
import type { TelegramReplyMarkup } from "../src/telegram-controls.js";
import { discardTelegramControls } from "../src/telegram-controls.js";

const message = (id: number, text: string): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    message_thread_id: 11,
  },
});
const callback = (id: number, data: string): TelegramUpdate => ({
  update_id: id,
  callback_query: {
    id: `query-${id}`,
    data,
    from: { id: 42 },
    message: {
      message_id: 500,
      date: 1,
      from: { id: 123 },
      chat: { id: 100, type: "private" },
      message_thread_id: 11,
    },
  },
});
interface View {
  text: string;
  markup: TelegramReplyMarkup;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-menu-"));
  const models = createModels();
  const first = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const second = fauxProvider({
    provider: "second",
    models: Array.from({ length: 19 }, (_, i) => ({
      id: `model-${i}`,
      name: `Modelo ${i}`,
      reasoning: i !== 0,
    })),
  });
  first.provider = { ...first.provider, name: "Primeiro" };
  second.provider = { ...second.provider, name: "Segundo" };
  models.setProvider(first.provider);
  models.setProvider(second.provider);
  models.setProvider({
    ...fauxProvider({ provider: "inactive" }).provider,
    name: "Desconectado",
    auth: {},
  });
  const options = { dir, models, gateway: { call: async () => ({}) } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Web anchor");
  linkChat(app, "100", "42", anchor);
  app.store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: "100",
      conversationId: anchor,
    }),
  );
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ botId: 123, token: "123:synthetic-private-token" }),
  );
  const views: View[] = [];
  const edits: { chat: string; messageId: number }[] = [];
  const answers: string[] = [];
  let editFails = false;
  const engine = () =>
    new Telegram(
      app,
      {
        send: async (_chat, text, options) => {
          if (options?.replyMarkup)
            views.push({ text, markup: options.replyMarkup });
          return { message_id: 500 };
        },
        ...{
          editMessage: async (
            chat: string,
            messageId: number,
            text: string,
            markup: TelegramReplyMarkup,
          ) => {
            edits.push({ chat, messageId });
            if (editFails) throw new Error("Synthetic edit unavailable");
            views.push({ text, markup });
            return true;
          },
        },
        answerCallback: async (_id, text) => {
          answers.push(text);
        },
      },
      ["42"],
      ["100"],
      "test_bot",
      true,
      123,
    );
  let bot = engine();
  let nextId = 1;
  const send = async (text: string) => {
    const result = await bot.receive(message(nextId++, text));
    await bot.flush();
    return result;
  };
  const click = async (
    data: string,
    alter?: (update: TelegramUpdate) => void,
  ) => {
    const update = callback(nextId++, data);
    alter?.(update);
    const result = await bot.receive(update);
    await bot.flush();
    return result;
  };
  const token = (label: RegExp) => {
    const button = views
      .at(-1)
      ?.markup.inline_keyboard.flat()
      .find((b) => label.test(b.text));
    assert.ok(
      button?.callback_data,
      `Missing button ${label}: ${JSON.stringify(views.at(-1))}`,
    );
    return button.callback_data;
  };
  return {
    get app() {
      return app;
    },
    get bot() {
      return bot;
    },
    models,
    first,
    second,
    anchor,
    views,
    edits,
    answers,
    send,
    click,
    token,
    failEdits() {
      editFails = true;
    },
    async restart(bootstrap: { provider?: string; modelId?: string } = {}) {
      await bot.drain();
      await app.close();
      app = await Runtime.open({ ...options, ...bootstrap });
      bot = engine();
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("/model opens configured providers with counts, current marker and cancel, without changing defaults", async () => {
  const f = await fixture();
  try {
    const before = f.app.settings.defaults();
    const result = (await f.send("/model")) as { conversationId: string };
    assert.notEqual(result.conversationId, f.anchor);
    assert.match(f.views.at(-1)!.text, /Configuração de modelo/);
    assert.match(f.views.at(-1)!.text, /faux-1/);
    f.token(/✓.*Primeiro.*\(1\)/);
    f.token(/Segundo.*\(19\)/);
    f.token(/Cancelar/);
    assert.doesNotMatch(
      JSON.stringify(f.views),
      /Desconectado|synthetic-private-token/,
    );
    assert.deepEqual(f.app.settings.defaults(), before);
    assert.deepEqual(await f.app.settings.conversation(f.anchor), before);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("provider and model pages edit the original menu, support back and invalidate older callbacks", async () => {
  const f = await fixture();
  try {
    await f.send("/model");
    const provider = f.token(/Segundo/);
    await f.click(provider);
    assert.match(f.views.at(-1)!.text, /Segundo/);
    const stale = f.token(/Modelo 0 · model-0$/);
    await f.click(f.token(/Próxima/));
    assert.doesNotMatch(JSON.stringify(f.views.at(-1)), /Modelo 0"/);
    const before = f.views.length;
    await f.click(stale);
    assert.equal(f.views.length, before);
    assert.match(f.answers.at(-1)!, /expir|mudou|desatualizado/i);
    await f.click(f.token(/Voltar aos provedores/));
    f.token(/✓.*Primeiro/);
    assert.ok(f.edits.length >= 3);
    assert.ok(f.edits.every((e) => e.chat === "100" && e.messageId === 500));
    await f.click(f.token(/Primeiro/));
    f.token(/✓.*faux-1/);
  } finally {
    await f.close();
  }
});

test("cross-provider choice clamps thinking, keeps topic, history, other conversations and global default across reboot", async () => {
  const f = await fixture();
  try {
    const result = (await f.send("/model")) as { conversationId: string };
    const id = result.conversationId;
    f.first.setResponses([fauxAssistantMessage("Histórico preservado")]);
    await f.send("Mensagem anterior à troca");
    await (await f.app.conversation(id)).waitForIdle(context);
    await f.bot.flush();
    // Reopen after the response so the menu refers to this idle conversation.
    await f.send("/model");
    const task = await f.app.tasks.create(
      {
        title: "Cron futuro",
        prompt: "Synthetic cron",
        conversationId: id,
        kind: "cron",
        schedule: "0 0 1 1 *",
        timezone: "Etc/UTC",
        delivery: "web_telegram",
      },
      "synthetic-test",
      {
        source: "telegram",
        conversationId: id,
        requestId: f.app.store.get<{ requestId: string }>(
          "SELECT requestId FROM request_telegram_routes WHERE conversationId=? LIMIT 1",
          id,
        )!.requestId,
      },
    );
    const taskBefore = f.app.tasks.get(task.id);
    const before = f.app.settings.defaults();
    const bindings = f.app.store.all("SELECT * FROM telegram_topic_selection");
    const grants = f.app.store.all("SELECT * FROM telegram_grants");
    const snapshot = await f.app.snapshot(id);
    assert.ok(snapshot.view.entries.length > 0);
    await f.click(f.token(/Segundo/));
    const choice = f.token(/Modelo 0 · model-0$/);
    await f.restart();
    await f.click(choice);
    const selected = { provider: "second", modelId: "model-0", effort: "off" };
    assert.deepEqual(await f.app.settings.conversation(id), selected);
    assert.match(f.views.at(-1)!.text, /apenas esta conversa/i);
    assert.match(f.views.at(-1)!.text, /persiste após reinício/);
    assert.deepEqual(
      f.app.store.all("SELECT * FROM telegram_topic_selection"),
      bindings,
    );
    assert.deepEqual(f.app.store.all("SELECT * FROM telegram_grants"), grants);
    assert.deepEqual(f.app.tasks.get(task.id), taskBefore);
    assert.deepEqual(
      (await f.app.snapshot(id)).view.entries,
      snapshot.view.entries,
    );
    await f.restart({ provider: "second", modelId: "model-18" });
    assert.deepEqual(await f.app.settings.conversation(id), selected);
    assert.deepEqual(f.app.settings.defaults(), before);
    assert.deepEqual(await f.app.settings.conversation(f.anchor), before);
    assert.deepEqual(
      await f.app.settings.conversation(await f.app.create()),
      before,
    );
    await f.click(choice);
    assert.deepEqual(await f.app.settings.conversation(id), selected);
    await f.send("/model");
    f.token(/✓.*Segundo/);
    await f.click(f.token(/Primeiro/));
    await f.click(f.token(/faux-1/));
    assert.equal((await f.app.settings.conversation(id)).provider, "faux");
  } finally {
    await f.close();
  }
});

test("cancel and changed conversation model make old controls inert", async () => {
  const f = await fixture();
  try {
    const result = (await f.send("/model")) as { conversationId: string };
    const original = await f.app.settings.conversation(result.conversationId);
    const provider = f.token(/Segundo/);
    await f.click(f.token(/Cancelar/));
    assert.equal(f.views.at(-1)!.markup.inline_keyboard.length, 0);
    await f.click(provider);
    assert.deepEqual(
      await f.app.settings.conversation(result.conversationId),
      original,
    );
    await f.send("/model");
    await f.click(f.token(/Segundo/));
    const old = f.token(/Modelo 0 · model-0$/);
    // Changed out of band: the command surface with arguments is gone, the
    // invariant still is that the old buttons become inert.
    await f.app.settings.saveConversation(result.conversationId, {
      provider: original.provider,
      modelId: original.modelId,
      effort: "low",
    });
    await f.click(old);
    assert.match(f.answers.at(-1)!, /mudou|desatualizado/i);
    assert.equal(
      (await f.app.settings.conversation(result.conversationId)).effort,
      "low",
    );
  } finally {
    await f.close();
  }
});

test("model callbacks reject wrong owner, chat, topic, bot, expired and nonexistent tokens", async () => {
  const f = await fixture();
  try {
    const result = (await f.send("/model")) as { conversationId: string };
    const before = await f.app.settings.conversation(result.conversationId);
    const provider = f.token(/Segundo/);
    for (const alter of [
      (u: TelegramUpdate) => {
        u.callback_query!.from.id = 99;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.chat.id = 200;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.message_thread_id = 22;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.from!.id = 124;
      },
    ])
      await f.click(provider, alter);
    await f.click(`pi:${"0".repeat(32)}`);
    assert.equal(f.views.length, 1);
    const key = `telegram:button:${provider}`;
    const value = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        key,
      )!.value,
    );
    value.expiresAt = 0;
    f.app.store.run(
      "UPDATE meta SET value=? WHERE key=?",
      JSON.stringify(value),
      key,
    );
    await f.click(provider);
    assert.equal(f.views.length, 1);
    assert.deepEqual(
      await f.app.settings.conversation(result.conversationId),
      before,
    );
  } finally {
    await f.close();
  }
});

test("catalog removal or disconnected provider never applies a stale model choice", async () => {
  const f = await fixture();
  try {
    const result = (await f.send("/model")) as { conversationId: string };
    await f.click(f.token(/Segundo/));
    const choice = f.token(/Modelo 0 · model-0$/);
    f.models.setProvider({ ...f.second.provider, getModels: () => [] });
    await f.click(choice);
    assert.equal(
      (await f.app.settings.conversation(result.conversationId)).provider,
      "faux",
    );
    assert.match(f.answers.at(-1)!, /catálogo|disponível/i);
    await f.send("/model");
    await f.click(f.token(/Segundo.*\(0\)/));
    assert.match(f.views.at(-1)!.text, /Nenhum modelo disponível/);
    f.token(/Voltar/);
    f.models.setProvider(f.second.provider);
    await f.send("/model");
    await f.click(f.token(/Segundo/));
    const revoked = f.token(/Modelo 0 · model-0$/);
    f.models.setProvider({ ...f.second.provider, auth: {} });
    await f.click(revoked);
    assert.equal(
      (await f.app.settings.conversation(result.conversationId)).provider,
      "faux",
    );
    assert.match(f.answers.at(-1)!, /configurado|disponível/i);
  } finally {
    await f.close();
  }
});

test("no configured providers offers only cancellation and a failed edit falls back to a new routed menu", async () => {
  const f = await fixture();
  try {
    f.models.setProvider({ ...f.first.provider, auth: {} });
    f.models.setProvider({ ...f.second.provider, auth: {} });
    await f.send("/model");
    assert.match(f.views.at(-1)!.text, /Nenhum provedor configurado/);
    assert.equal(f.views.at(-1)!.markup.inline_keyboard.flat().length, 1);
    f.models.setProvider(f.first.provider);
    f.models.setProvider(f.second.provider);
    await f.send("/model");
    f.failEdits();
    await f.click(f.token(/second|Segundo/));
    f.token(/Modelo 0 · model-0$/);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("provider pages are bounded and duplicate model callbacks configure only once", async (t) => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      const extra = fauxProvider({ provider: `extra-${i}` });
      f.models.setProvider({ ...extra.provider, name: `Extra ${i}` });
    }
    await f.send("/model");
    await f.click(f.token(/Próxima/));
    f.token(/Extra 9/);
    await f.click(f.token(/Anterior/));
    await f.click(f.token(/Segundo/));
    const choice = f.token(/Modelo 0 · model-0$/);
    const save = f.app.settings.saveConversation.bind(f.app.settings);
    let changes = 0;
    t.mock.method(
      f.app.settings,
      "saveConversation",
      (...args: Parameters<typeof save>) => {
        changes++;
        return save(...args);
      },
    );
    await Promise.all([f.click(choice), f.click(choice)]);
    assert.equal(changes, 1);
    assert.ok(
      f.views.every((v) =>
        v.markup.inline_keyboard
          .flat()
          .every((b) => Buffer.byteLength(b.callback_data ?? "") <= 64),
      ),
    );
  } finally {
    await f.close();
  }
});

test("revocation and regrant while configure inspects the conversation invalidates the old menu", async (t) => {
  const f = await fixture();
  let release = () => {};
  try {
    const original = (await f.send("/model")) as { conversationId: string };
    await f.click(f.token(/Segundo/));
    const choice = f.token(/Modelo 0 · model-0$/);
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = f.app.harness.inspect.bind(f.app.harness);
    t.mock.method(
      f.app.harness,
      "inspect",
      async (...args: Parameters<typeof inspect>) => {
        const result = await inspect(...args);
        entered();
        await gate;
        return result;
      },
    );
    const work = f.click(choice);
    await waiting;
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      original.conversationId,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES ('100','42',?)",
      original.conversationId,
    );
    release();
    await work;
    assert.equal(
      (await f.app.settings.conversation(original.conversationId)).provider,
      "faux",
    );
    assert.match(f.answers.at(-1)!, /autoriza|desatualizado/);
  } finally {
    release();
    await f.close();
  }
});

test("revocation followed by regrant never revives old menus and permanent cleanup removes menu metadata", async () => {
  const f = await fixture();
  try {
    const original = (await f.send("/model")) as { conversationId: string };
    await f.click(f.token(/Segundo/));
    const choice = f.token(/Modelo 0 · model-0$/);
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      original.conversationId,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES ('100','42',?)",
      original.conversationId,
    );
    await f.click(choice);
    assert.equal(
      (await f.app.settings.conversation(original.conversationId)).provider,
      "faux",
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM meta WHERE key GLOB 'telegram:model-menu:*'",
      ),
    );
    discardTelegramControls(f.app.store, original.conversationId, true);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM meta WHERE key GLOB 'telegram:model-menu:*'",
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});
