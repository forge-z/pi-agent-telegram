import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
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

import {
  Telegram,
  type TelegramUpdate,
  type TelegramTransport,
} from "../src/telegram.js";
import { discardTelegramControls } from "../src/telegram-controls.js";
import type { TelegramReplyMarkup } from "../src/telegram-controls.js";

async function fixture(envelope = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cron-menu-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
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
    JSON.stringify({ botId: 123, token: "123:synthetic-token" }),
  );
  const owner = { chat: "100", user: "42", messageThreadId: 11 };
  const first = await app.telegramChats.ensure(owner);
  const second = await app.telegramChats.ensure({
    ...owner,
    messageThreadId: 22,
  });
  const makeTask = async (id: string, title: string) => {
    const task = await app.tasks.create({
      title,
      prompt: "Instrução original",
      conversationId: id,
      kind: "cron",
      schedule: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
    });
    app.store.run(
      "UPDATE tasks SET originSource='telegram',originConversationId=?,destinationChat='100',destinationUser='42',destinationBotId='123',destinationMessageThreadId=? WHERE id=?",
      id,
      app.store.telegramThread(id) ?? null,
      task.id,
    );
    return app.tasks.get(task.id)!;
  };
  const task = await makeTask(second, "Relatório no outro tópico");
  await app.tasks.create({
    title: "Web private schedule",
    prompt: "Web private prompt",
    conversationId: anchor,
    kind: "cron",
    schedule: "0 9 * * *",
    enabled: false,
  });
  type View = {
    text: string;
    markup?: TelegramReplyMarkup;
    forceReply?: boolean;
    messageId: number;
  };
  const views: View[] = [],
    answers: string[] = [];
  let nextId = 1,
    nextMessage = 500,
    editFails = false;
  const transport: TelegramTransport = {
    send: async (_chat, text, opts) => {
      const messageId = nextMessage++;
      views.push({
        text,
        markup: opts?.replyMarkup,
        forceReply: opts?.forceReply,
        messageId,
      });
      return envelope
        ? { ok: true, result: { message_id: messageId } }
        : { message_id: messageId };
    },
    editMessage: async (_chat, messageId, text, markup) => {
      if (editFails) throw new Error("Edit failed");
      views.push({ text, markup, messageId });
      return true;
    },
    answerCallback: async (_id, text) => {
      answers.push(text);
    },
  };
  const engine = () =>
    new Telegram(app, transport, ["42"], ["100"], "test_bot", true, 123);
  let bot = engine();
  const send = async (
    text: string,
    replyId?: number,
    alter?: (u: TelegramUpdate) => void,
    flush = true,
  ) => {
    const id = nextId++;
    const update: TelegramUpdate = {
      update_id: id,
      message: {
        message_id: id,
        text,
        from: { id: 42 },
        chat: { id: 100, type: "private" },
        message_thread_id: 11,
        ...(replyId
          ? { reply_to_message: { message_id: replyId, from: { id: 123 } } }
          : {}),
      },
    };
    alter?.(update);
    const result = await bot.receive(update);
    if (flush) await bot.flush();
    return result;
  };
  const click = async (data: string, alter?: (u: TelegramUpdate) => void) => {
    const update: TelegramUpdate = {
      update_id: nextId++,
      callback_query: {
        id: `query-${nextId}`,
        data,
        from: { id: 42 },
        message: {
          message_id: views.at(-1)?.messageId ?? 500,
          date: 1,
          from: { id: 123 },
          chat: { id: 100, type: "private" },
          message_thread_id: 11,
        },
      },
    };
    alter?.(update);
    const result = await bot.receive(update);
    await bot.flush();
    return result;
  };
  const token = (pattern: RegExp) => {
    const button = views
      .at(-1)
      ?.markup?.inline_keyboard.flat()
      .find((b) => pattern.test(b.text));
    assert.ok(
      button?.callback_data,
      `Missing ${pattern}: ${JSON.stringify(views.at(-1))}`,
    );
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    return button.callback_data;
  };
  return {
    get app() {
      return app;
    },
    flush: () => bot.flush(),
    owner,
    anchor,
    first,
    second,
    task,
    views,
    answers,
    send,
    click,
    token,
    makeTask,
    failEdits() {
      editFails = true;
    },
    async restart() {
      await bot.drain();
      await app.close();
      app = await Runtime.open(options);
      bot = engine();
    },
    async close() {
      await bot.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("/crons lists only authorized Telegram schedules across topics and controls preserve fixed destinations", async () => {
  const f = await fixture();
  try {
    const before = f.app.tasks.get(f.task.id)!;
    await f.send("/crons");
    assert.doesNotMatch(JSON.stringify(f.views), /Web private/);
    await f.click(f.token(/Relatório/));
    assert.match(f.views.at(-1)!.text, /Instrução original/);
    assert.match(f.views.at(-1)!.text, /22/);
    await f.click(f.token(/Retomar/));
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, true);
    const stale = f.token(/Pausar/);
    await f.click(stale);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    await f.click(stale);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    const after = f.app.tasks.get(f.task.id)!;
    for (const key of [
      "conversationId",
      "destinationChat",
      "destinationUser",
      "destinationBotId",
      "destinationMessageThreadId",
      "originSource",
      "originConversationId",
      "delivery",
    ] as const)
      assert.equal(after[key], before[key]);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("cron deletion requires confirmation, supports cancel, and preserves conversation history", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Excluir/));
    assert.ok(f.app.tasks.get(f.task.id));
    const stale = f.token(/Confirmar exclusão/);
    await f.click(f.token(/Cancelar/));
    await f.click(stale);
    assert.ok(f.app.tasks.get(f.task.id));
    await f.click(f.token(/Excluir/));
    await f.click(f.token(/Confirmar exclusão/));
    assert.equal(f.app.tasks.get(f.task.id), undefined);
    assert.ok(
      f.app.store.get("SELECT 1 FROM conversations WHERE id=?", f.second),
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM tasks WHERE id=? AND deleted=1",
        f.task.id,
      ),
    );
  } finally {
    await f.close();
  }
});

test("cron field editing accepts only an exact prompt reply and confirms before saving, including after restart", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Título/));
    const prompt = f.views.at(-1)!;
    assert.equal(prompt.forceReply, true);
    await f.restart();
    await f.send("Título novo", prompt.messageId);
    assert.equal(f.app.tasks.get(f.task.id)!.title, f.task.title);
    await f.click(f.token(/Confirmar alteração/));
    assert.equal(f.app.tasks.get(f.task.id)!.title, "Título novo");
    assert.equal(f.app.tasks.get(f.task.id)!.destinationMessageThreadId, 22);
    await f.send("Não repetir", prompt.messageId);
    assert.equal(f.app.tasks.get(f.task.id)!.title, "Título novo");
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("cron callbacks reject foreign user/chat/topic/bot, stale task and revoked/regranted target", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    const detail = f.token(/Relatório/);
    for (const alter of [
      (u: TelegramUpdate) => {
        u.callback_query!.from.id = 99;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.chat.id = 101;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.message_thread_id = 22;
      },
      (u: TelegramUpdate) => {
        u.callback_query!.message!.from!.id = 999;
      },
    ])
      await f.click(detail, alter);
    await f.click(detail);
    const resume = f.token(/Retomar/);
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.second,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES ('100','42',?)",
      f.second,
    );
    await f.click(resume);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    assert.match(f.answers.at(-1)!, /autoriza|desatualizado|mudou/i);
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    const stale = f.token(/Retomar/);
    f.app.tasks.edit(f.task.id, { title: "Alterado fora do menu" });
    await f.click(stale);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});

test("reopening /crons cancels an old edit prompt; slash text edits remain data and never pair or run commands", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Instrução/));
    const promptId = f.views.at(-1)!.messageId;
    await f.send("/link abcdef", promptId);
    await f.click(f.token(/Confirmar alteração/));
    assert.equal(f.app.tasks.get(f.task.id)!.prompt, "/link abcdef");
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Título/));
    const old = f.views.at(-1)!.messageId;
    await f.send("/crons", old);
    f.token(/Relatório/);
    await f.send("Não alterar", old);
    assert.equal(f.app.tasks.get(f.task.id)!.title, f.task.title);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.match(f.views.at(-1)!.text, /expirado|desatualizado/);
  } finally {
    await f.close();
  }
});

test("menu pagination, edit failures and legacy Telegram schedule management never create a run or change target", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 9; i++) await f.makeTask(f.second, `Rotina ${i}`);
    f.app.store.run("UPDATE tasks SET originSource=NULL WHERE id=?", f.task.id);
    await f.send("/crons");
    f.failEdits();
    await f.click(f.token(/Próxima/));
    assert.ok(f.token(/Anterior/));
    await f.click(f.token(/Anterior/));
    // Existing legacy origins remain editable through their preserved Telegram conversation.
    await f.send("/crons");
    const allTokens = f.views.at(-1)!.markup!.inline_keyboard.flat();
    assert.ok(allTokens.length > 0);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
    assert.equal(f.app.tasks.get(f.task.id)!.destinationMessageThreadId, 22);
  } finally {
    await f.close();
  }
});

test("queued cron menus cannot reveal a revoked target before flush, including after revoke/regrant", async () => {
  const f = await fixture();
  try {
    await f.send("/crons", undefined, undefined, false);
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.second,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES ('100','42',?)",
      f.second,
    );
    await f.flush();
    assert.equal(f.views.length, 0);
    assert.equal(
      f.app.store.all("SELECT * FROM deliveries WHERE state='cancelled'")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a reply to an older field prompt cannot populate a later field in the same menu", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Título/));
    const old = f.views.at(-1)!.messageId;
    await f.send("Título salvo", old);
    await f.click(f.token(/Confirmar alteração/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Instrução/));
    const current = f.views.at(-1)!.messageId;
    await f.send("Valor de resposta antiga", old);
    assert.match(f.views.at(-1)!.text, /expirado|desatualizado/);
    assert.equal(f.app.tasks.get(f.task.id)!.prompt, "Instrução original");
    await f.send("Nova instrução correta", current);
    await f.click(f.token(/Confirmar alteração/));
    assert.equal(f.app.tasks.get(f.task.id)!.prompt, "Nova instrução correta");
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("native edit replies recognize the legacy TelegramHttp Bot API envelope", async () => {
  const f = await fixture(true);
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Título/));
    await f.send("Título pelo HTTP", f.views.at(-1)!.messageId);
    await f.click(f.token(/Confirmar alteração/));
    assert.equal(f.app.tasks.get(f.task.id)!.title, "Título pelo HTTP");
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("existing permanent cleanup removes staged cross-topic cron values and delivery metadata", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Instrução/));
    await f.send(
      "sensitive staged cron instruction",
      f.views.at(-1)!.messageId,
    );
    discardTelegramControls(f.app.store, f.second, true);
    assert.doesNotMatch(
      JSON.stringify(f.app.store.all("SELECT * FROM meta")),
      /sensitive staged cron instruction/,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM meta WHERE key GLOB 'telegram:force-reply:*'",
      ).length,
      0,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM meta WHERE key GLOB 'telegram:cron-delivery:*'",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("TelegramHttp serializes ForceReply in the original topic and retains its Bot API receipt", async () => {
  const { TelegramHttp } = await import("../src/telegram.js");
  const original = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 77 } }),
      { status: 200 },
    );
  };
  try {
    const receipt = await new TelegramHttp("123:synthetic").send(
      "100",
      "Editar",
      { messageThreadId: 11, forceReply: true },
    );
    assert.deepEqual(receipt, { ok: true, result: { message_id: 77 } });
    assert.deepEqual(payload, {
      chat_id: "100",
      text: "Editar",
      message_thread_id: 11,
      reply_markup: { force_reply: true, selective: true },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("Telegram edits validate schedule and timezone, allow instruction changes, and show saved delivery", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    assert.match(f.views.at(-1)!.text, /Entrega salva: web/);
    for (const [label, value, field] of [
      [/Agenda/, "30 10 * * *", "schedule"],
      [/Fuso/, "America/Sao_Paulo", "timezone"],
      [/Instrução/, "Nova instrução cron", "prompt"],
    ] as const) {
      await f.click(f.token(/Editar/));
      await f.click(f.token(label));
      await f.send(value, f.views.at(-1)!.messageId);
      await f.click(f.token(/Confirmar alteração/));
      assert.equal(f.app.tasks.get(f.task.id)![field], value);
    }
    await f.click(f.token(/Editar/));
    await f.click(f.token(/Agenda/));
    await f.send("invalid cron", f.views.at(-1)!.messageId);
    await f.click(f.token(/Confirmar alteração/));
    assert.equal(f.app.tasks.get(f.task.id)!.schedule, "30 10 * * *");
    assert.match(f.answers.at(-1)!, /Cron|cron/);
    assert.equal(f.app.tasks.get(f.task.id)!.destinationMessageThreadId, 22);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});

test("expired menus and changed source selections refuse cron mutations", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    const expired = f.token(/Retomar/);
    f.app.store.run(
      "UPDATE meta SET value=json_set(value,'$.expiresAt',0) WHERE key GLOB 'telegram:cron-menu:*'",
    );
    await f.click(expired);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    await f.send("/crons");
    await f.click(f.token(/Relatório/));
    const changed = f.token(/Retomar/);
    const replacement = await f.app.create("Outra seleção", f.owner);
    f.app.telegramChats.select(replacement, f.owner);
    assert.notEqual(replacement, f.first);
    await f.click(changed);
    assert.equal(f.app.tasks.get(f.task.id)!.enabled, false);
    assert.equal(f.app.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});
