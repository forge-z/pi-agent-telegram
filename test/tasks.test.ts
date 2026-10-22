import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import {
  Runtime,
  settleFailureCategory,
  settleFailureReason,
} from "../src/runtime.js";
import { Store } from "../src/store.js";
import { TaskError, Tasks } from "../src/tasks.js";
import { Telegram } from "../src/telegram.js";
import {
  queueTaskTelegram,
  taskTelegramAuthorized,
  telegramConversationRoute,
} from "../src/task-telegram.js";

const gateway = { call: async () => ({ content: [] }) };
const epoch = Date.parse("2026-10-07T12:00:00Z");
const once = {
  title: "Lembrete",
  prompt: "Resuma o contexto",
  kind: "once",
  schedule: "2026-10-07T12:00:01Z",
};
const cron = { ...once, kind: "cron", schedule: "* * * * *" };
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-tasks-test-"));
}
async function fixture() {
  const dir = await temp();
  const store = new Store(dir);
  let now = epoch;
  let submits = 0;
  let fail = false;
  let creates = 0;
  const runtime = {
    store,
    create: async () => {
      const id = String(++creates);
      store.run("INSERT INTO conversations VALUES (?,?)", id, "Task");
      return id;
    },
    conversation: async (id: string) => {
      if (!store.get("SELECT id FROM conversations WHERE id=?", id))
        throw new Error("Conversa não encontrada");
      return {};
    },
    submit: async (
      conversationId: string,
      requestId: string,
      text: string,
      source: string,
      chat: string | null,
    ) => {
      submits++;
      if (fail) throw new Error("Falha de admissão");
      store.run(
        "INSERT OR IGNORE INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,?,?)",
        conversationId,
        requestId,
        text,
        source,
        chat,
      );
      return { requestId, conversationId, submissionId: 1 };
    },
  };
  const tasks = new Tasks(runtime as unknown as Runtime, () => now);
  return {
    store,
    tasks,
    runtime,
    get submits() {
      return submits;
    },
    get creates() {
      return creates;
    },
    set time(value: number) {
      now = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
    finish(status = "done") {
      store.run("UPDATE requests SET status=?", status);
    },
    async close() {
      await tasks.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settle(app: Runtime, conversationId: string) {
  await (await app.conversation(conversationId)).waitForIdle(context);
  for (let n = 0; n < 50; n++) {
    if (!app.store.get("SELECT requestId FROM requests WHERE status='pending'"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Runtime monitor did not settle the input");
}

test("creation receipts deduplicate concurrent calls and survive restart even after a once date expires", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const input = { ...once, conversationId: await f.runtime.create() };
    const [a, b] = await Promise.all([
      f.tasks.create(input, "chat:create:1"),
      f.tasks.create(input, "chat:create:1"),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.tasks.list().length, 1);
    await f.tasks.close();
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch + 60000);
    assert.equal((await reopened.create(input, "chat:create:1")).id, a.id);
    await assert.rejects(
      reopened.create({ ...input, prompt: "Different" }, "chat:create:1"),
      /conteúdo diferente/,
    );
    reopened.remove(a.id);
    await assert.rejects(
      reopened.create(input, "chat:create:1"),
      /não encontrada/,
    );
    assert.equal(
      reopened.list().length,
      0,
      "a replay must not resurrect a deleted schedule",
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("delivery tool receipts survive restart and cannot reapply an old destination or reuse a key", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const task = await f.tasks.create(cron);
    f.store.run("UPDATE tasks SET delivery='legacy' WHERE id=?", task.id);
    const first = f.tasks.setDelivery(task.id, "web", "chat:1:delivery");
    f.store.run("UPDATE tasks SET delivery='legacy' WHERE id=?", task.id);
    await f.tasks.close();
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.deepEqual(
      reopened.setDelivery(task.id, "web", "chat:1:delivery"),
      first,
    );
    assert.equal(reopened.get(task.id)?.delivery, "legacy");
    assert.throws(
      () => reopened!.setDelivery(task.id, "legacy", "chat:1:delivery"),
      /conteúdo diferente/,
    );
    assert.throws(
      () => reopened!.setDelivery(task.id, "web", "bad key"),
      /Chave/,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_delivery_receipt BEFORE INSERT ON task_delivery_changes BEGIN SELECT RAISE(ABORT,'mock disk failure'); END",
    );
    assert.throws(
      () => reopened!.setDelivery(task.id, "web", "chat:1:failure"),
      /mock disk failure/,
    );
    assert.equal(reopened.get(task.id)?.delivery, "legacy");
    assert.equal(f.store.all("SELECT * FROM task_delivery_changes").length, 1);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("old task rows migrate to legacy delivery and new tasks default to web", async () => {
  const f = await fixture();
  let migrated: Tasks | undefined;
  try {
    await f.tasks.close();
    const conversationId = await f.runtime.create();
    f.store.db.exec("DROP TABLE tasks");
    f.store.db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
      conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
      timezone TEXT NOT NULL, enabled INTEGER NOT NULL, nextRun INTEGER,
      lastError TEXT, deleted INTEGER NOT NULL DEFAULT 0
    )`);
    f.store.run(
      "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      "legacy-task",
      "Old reminder",
      "Read the conversation",
      conversationId,
      "cron",
      "* * * * *",
      "UTC",
      1,
      epoch + 60000,
      null,
      0,
    );
    migrated = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.equal(migrated.get("legacy-task")?.delivery, "legacy");
    const created = await migrated.create({
      ...cron,
      conversationId,
    });
    assert.equal(created.delivery, "web");
    assert.throws(() => migrated!.setDelivery(created.id, "legacy"), /Destino/);
    assert.equal(
      migrated.setDelivery("legacy-task", "legacy").delivery,
      "legacy",
    );
  } finally {
    await migrated?.close();
    await f.close();
  }
});

test("Telegram delivery creation and updates require the current authorized binding", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    const task = await f.tasks.create({ ...cron, conversationId });
    assert.equal(task.delivery, "web");
    assert.equal(f.tasks.telegramAvailability(conversationId), false);
    await assert.rejects(
      f.tasks.create({ ...cron, conversationId, delivery: "web_telegram" }),
      /conectado e autorizado/,
    );
    assert.throws(
      () => f.tasks.setDelivery(task.id, "web_telegram"),
      /conectado e autorizado/,
    );
    const binding = {
      enabled: true,
      bot: { id: 123456 },
      userId: "42",
      chatId: "42",
      conversationId,
    };
    f.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "42",
      conversationId,
      "42",
    );
    f.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversationId,
    );
    f.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify(binding),
    );
    f.store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ botId: 123456, token: "123456:synthetic-test" }),
    );
    assert.equal(f.tasks.telegramAvailability(conversationId), true);
    const originalNextRun = task.nextRun;
    const telegramTask = f.tasks.setDelivery(task.id, "web_telegram");
    assert.equal(telegramTask.delivery, "web_telegram");
    assert.equal(telegramTask.nextRun, originalNextRun);
    assert.equal(f.tasks.setDelivery(task.id, "web").delivery, "web");
    f.store.run("DELETE FROM telegram_grants");
    assert.equal(f.tasks.telegramAvailability(conversationId), false);
    assert.throws(
      () => f.tasks.setDelivery(task.id, "web_telegram"),
      /conectado e autorizado/,
    );
  } finally {
    await f.close();
  }
});

test("schedule and creation receipt roll back together on a receipt storage failure", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    f.store.db.exec(
      "CREATE TRIGGER receipt_failure BEFORE INSERT ON task_creations BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;",
    );
    await assert.rejects(
      f.tasks.create({ ...once, conversationId }, "chat:create:failed"),
      /receipt failure/,
    );
    assert.equal(f.tasks.list().length, 0);
    assert.equal(f.store.all("SELECT * FROM task_creations").length, 0);
    f.store.db.exec("DROP TRIGGER receipt_failure");
    const task = await f.tasks.create(
      { ...once, conversationId },
      "chat:create:failed",
    );
    assert.equal(f.tasks.list()[0].id, task.id);
  } finally {
    await f.close();
  }
});

test("once admission is atomic, concurrent ticks deduplicate and done follows request completion", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    assert.equal(task.timezone, "America/Sao_Paulo");
    assert.equal(task.nextRun, epoch + 1000);
    f.time = epoch + 1000;
    await Promise.all(Array.from({ length: 15 }, () => f.tasks.tick()));
    assert.equal(f.submits, 1);
    assert.equal(f.tasks.runs(task.id).length, 1);
    const run = f.tasks.runs(task.id)[0];
    assert.equal(run.scheduledAt, epoch + 1000);
    assert.equal(run.state, "pending");
    assert.equal(run.requestId, `task:${run.id}`);
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    assert.equal(f.tasks.get(task.id)?.nextRun, null);
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "pending");
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "done");
    assert.equal(f.submits, 1);
  } finally {
    await f.close();
  }
});

test("cron skips downtime backlog and overlapping pending occurrences", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    f.time = epoch + 10 * 60000 + 30000;
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].scheduledAt, epoch + 60000);
    assert.equal(f.tasks.get(task.id)?.nextRun, epoch + 11 * 60000);
    // While that occurrence runs, neither another tick nor a manual trigger adds a
    // second one: the manual trigger is refused instead of joining it.
    f.time = epoch + 12 * 60000;
    await f.tasks.tick();
    await assert.rejects(f.tasks.runNow(task.id), /execução em andamento/);
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id).length, 1);
    assert.equal(f.submits, 1);
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id).length, 2);
    assert.equal(f.tasks.get(task.id)?.nextRun, epoch + 13 * 60000);
  } finally {
    await f.close();
  }
});

test("pause/resume recomputes cron; manual execution of a paused task preserves pause", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    f.tasks.setEnabled(task.id, false);
    f.time = epoch + 7 * 60000;
    await f.tasks.tick();
    assert.equal(f.submits, 0);
    const run = await f.tasks.runNow(task.id);
    assert.equal(run.state, "pending");
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    assert.equal(f.tasks.get(task.id)?.nextRun, null);
    f.finish();
    await f.tasks.tick();
    const resumed = f.tasks.setEnabled(task.id, true);
    assert.equal(resumed.nextRun, epoch + 8 * 60000);
    await f.tasks.tick();
    assert.equal(f.submits, 1);
    assert.throws(
      () => f.tasks.setEnabled(task.id, "yes" as unknown as boolean),
      /booleano/,
    );
  } finally {
    await f.close();
  }
});

test("cron uses IANA zones across DST and accepts named weekdays without hash syntax", async () => {
  const f = await fixture();
  try {
    f.time = Date.parse("2026-03-07T12:00:00Z");
    const task = await f.tasks.create({
      ...cron,
      schedule: "0 9 * * *",
      timezone: "America/New_York",
    });
    assert.equal(task.nextRun, Date.parse("2026-03-07T14:00:00Z"));
    f.time = task.nextRun!;
    await f.tasks.tick();
    assert.equal(
      f.tasks.get(task.id)?.nextRun,
      Date.parse("2026-03-08T13:00:00Z"),
    );
    const thu = await f.tasks.create({
      ...cron,
      schedule: "0 9 * * THU",
      timezone: "UTC",
    });
    assert.equal(thu.nextRun, Date.parse("2026-03-12T09:00:00Z"));
  } finally {
    await f.close();
  }
});

test("unknown inputs, schedule syntax, zones, limits and missing conversations are rejected before creating conversations", async () => {
  const f = await fixture();
  try {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...once, title: " " },
      { ...once, title: "a".repeat(121) },
      { ...once, prompt: "a".repeat(32001) },
      { ...once, schedule: "a".repeat(201) },
      { ...once, schedule: "2026-10-07T13:00:00" },
      { ...once, schedule: "2026-10-07T11:00:00Z" },
      { ...once, schedule: "2027-02-30T11:00:00Z" },
      { ...once, kind: "other" },
      { ...once, timezone: "+03:00" },
      { ...once, timezone: "America/Invalid" },
      { ...once, timezone: "a".repeat(101) },
      { ...once, enabled: "false" },
      { ...cron, schedule: "0 * * * * *" },
      { ...cron, schedule: "@hourly" },
      { ...cron, schedule: "H * * * *" },
      { ...cron, schedule: "H(1-3) * * * *" },
      { ...cron, schedule: "61 * * * *" },
      { ...cron, conversationId: "missing" },
    ];
    for (const value of invalid) await assert.rejects(f.tasks.create(value));
    assert.equal(f.creates, 0);
    assert.equal(f.tasks.list().length, 0);
    const offset = await f.tasks.create({
      ...once,
      schedule: "2026-10-07T09:00:01-03:00",
    });
    assert.equal(offset.nextRun, epoch + 1000);
    for (let i = 1; i < 100; i++)
      await f.tasks.create({ ...cron, enabled: false });
    await assert.rejects(f.tasks.create(cron), /100 tarefas/);
    assert.equal(f.creates, 100);
    f.tasks.remove(offset.id);
    await f.tasks.create(cron);
    assert.equal(f.tasks.list().length, 100);
  } finally {
    await f.close();
  }
});

test("admission failures and terminal input errors stay visible, pending work survives deletion", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    f.time = epoch + 1000;
    f.fail = true;
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "failed");
    assert.match(f.tasks.runs(task.id)[0].error!, /Falha de admissão/);
    assert.match(f.tasks.get(task.id)!.lastError!, /Falha de admissão/);
    f.fail = false;
    const manual = await f.tasks.runNow(task.id);
    assert.equal(manual.state, "pending");
    f.finish("timedout");
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "failed");
    assert.match(f.tasks.get(task.id)!.lastError!, /timedout/);
    await f.tasks.runNow(task.id);
    f.tasks.remove(task.id);
    assert.equal(f.tasks.get(task.id), undefined);
    assert.equal(f.tasks.list().length, 0);
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.runs(task.id)[0].state, "done");
    assert.equal(f.tasks.runs(task.id).length, 3);
    await assert.rejects(f.tasks.runNow(task.id), /não encontrada/);
  } finally {
    await f.close();
  }
});

test("a scheduled run posts only what notify sends", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Nada nas duas caixas."),
    fauxAssistantMessage([fauxToolCall("notify", { text: "Resumo pronto" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Resumo pronto"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, models, gateway });
  const tasks = new Tasks(app, () => epoch);
  try {
    const conversationId = await app.create();
    authorizeTaskConversation(app.store, conversationId, 11, app);
    const task = await tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });

    await tasks.runNow(task.id);
    await settle(app, conversationId);
    await tasks.tick();
    const silent = tasks.runs(task.id)[0];
    assert.equal(silent.state, "done");
    assert.equal(silent.status, "silencioso");
    assert.match(silent.summary!, /Nada nas duas caixas/);
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);

    await tasks.runNow(task.id);
    await settle(app, conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id)[0].status, "ok");
    const texts = app.store
      .all<{ text: string }>("SELECT text FROM deliveries")
      .map((row) => row.text);
    assert.equal(texts.length, 1);
    assert.ok(texts[0].includes("Resumo pronto"));
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivery none stops posting and the execution log stays queryable", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("Relatório enviado")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, models, gateway });
  const tasks = new Tasks(app, () => epoch);
  try {
    const conversationId = await app.create();
    authorizeTaskConversation(app.store, conversationId, 11, app);
    const task = await tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });
    const updated = tasks.update(task.id, { delivery: "none" });
    assert.equal(updated.delivery, "none");
    assert.equal(updated.destinationChat, null);
    assert.throws(
      () => tasks.update(task.id, { delivery: "email" }),
      /Destino/,
    );

    await tasks.runNow(task.id);
    // The external-action indicator is read from the MCP ledger at settle time.
    app.store.db.exec(
      "CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, binding TEXT NOT NULL, updatedAt INTEGER NOT NULL)",
    );
    for (const [id, tool, state] of [
      ["a", "send_email", "done"],
      ["b", "gmail_send", "skipped"],
    ] as const)
      app.store.run(
        "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,NULL,'x',?)",
        id,
        conversationId,
        "executor",
        tool,
        "{}",
        state,
        Date.now(),
      );
    await settle(app, conversationId);
    await tasks.tick();

    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);
    assert.equal(app.store.all("SELECT * FROM task_notifications").length, 0);
    const run = tasks.runs(task.id)[0];
    assert.equal(run.state, "done");
    assert.equal(run.status, "ok");
    assert.equal(run.delivery, "none");
    assert.match(run.summary!, /Relat[óo]rio enviado/);
    assert.match(run.external!, /executor\/send_email/);
    assert.match(run.external!, /executor\/gmail_send \(aprovação pulada\)/);

    assert.equal(tasks.runs(task.id, { since: epoch + 1 }).length, 0);
    assert.equal(tasks.runs(task.id, { until: epoch - 1 }).length, 0);
    assert.equal(
      tasks.runs(task.id, { since: epoch - 1, until: epoch + 1 }).length,
      1,
    );
    assert.equal(tasks.runs(task.id, { limit: 1 }).length, 1);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("three consecutive scheduled occurrences in one conversation all answer, with no reused requestId", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  const ping = (text: string) => [
    fauxAssistantMessage([fauxToolCall("notify", { text })], {
      stopReason: "toolUse" as const,
    }),
    fauxAssistantMessage(text),
  ];
  faux.setResponses([...ping("ping 1"), ...ping("ping 2"), ...ping("ping 3")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, models, gateway });
  let now = epoch;
  const tasks = new Tasks(app, () => now);
  try {
    const conversationId = await app.create();
    authorizeTaskConversation(app.store, conversationId, 11, app);
    const task = await tasks.create({
      ...cron,
      prompt: "Responda apenas: ping",
      conversationId,
      delivery: "web_telegram",
    });
    // Three occurrences in the same conversation, one after the other.
    for (let n = 1; n <= 3; n++) {
      now = epoch + n * 60000;
      await tasks.runNow(task.id);
      await settle(app, conversationId);
    }
    const runs = tasks.runs(task.id);
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((run) => run.status),
      ["ok", "ok", "ok"],
    );
    // Each occurrence owns its requestId: nothing is reused across runs.
    assert.equal(new Set(runs.map((run) => run.requestId)).size, 3);
    assert.deepEqual(
      app.store.all("SELECT status FROM requests WHERE status!='done'"),
      [],
    );
    const texts = app.store
      .all<{ text: string }>("SELECT text FROM deliveries")
      .map((row) => row.text);
    // Every occurrence reaches the chat: nothing is dropped or deduplicated away.
    assert.equal(texts.filter((text) => /ping [123]/.test(text)).length, 3);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settleFailureReason names the reason and bounds the provider detail", () => {
  assert.equal(
    settleFailureReason({
      status: "unanswered",
      reason: "model_error",
      detail: "Compaction failed",
    }),
    "model_error: Compaction failed",
  );
  assert.equal(
    settleFailureReason({ status: "unanswered", reason: "no_model" }),
    "no_model",
  );
  assert.equal(settleFailureReason({ status: "unanswered" }), "unanswered");
  assert.equal(
    settleFailureCategory({ status: "unanswered", reason: "model_error" }),
    "model_error",
  );
  assert.equal(
    settleFailureCategory({ status: "unanswered", reason: "  " }),
    "unanswered",
  );
  assert.equal(
    settleFailureReason({
      status: "unanswered",
      reason: "x",
      detail: { code: 7 },
    }),
    'x: {"code":7}',
  );
  const multiline = settleFailureReason({
    status: "unanswered",
    reason: "y",
    detail: "line one\nline two",
  });
  assert.equal(multiline, "y: line one line two");
  assert.equal(
    settleFailureReason({
      status: "unanswered",
      reason: "z",
      detail: "a".repeat(500),
    }).length,
    "z: ".length + 300,
  );
});

test("a turn that ends without an answer tells the chat why instead of staying silent", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider exploded",
    }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, models, gateway });
  try {
    const conversationId = await app.create();
    authorizeTaskConversation(app.store, conversationId, 11, app);
    await app.admit(conversationId, "telegram:1", "oi", {
      source: "telegram",
      chat: "42",
      user: "42",
      messageThreadId: 11,
    });
    const logged: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    try {
      await settle(app, conversationId);
    } finally {
      console.warn = warn;
    }
    // The operator log says what happened, never the provider body.
    assert.ok(
      logged.some((line) => /model_error/.test(line)),
      JSON.stringify(logged),
    );
    assert.ok(
      logged.every((line) => !line.includes("provider exploded")),
      JSON.stringify(logged),
    );
    const texts = app.store
      .all<{ text: string }>("SELECT text FROM deliveries")
      .map((row) => row.text);
    // The chat gets the category; the raw provider text stays out of it.
    assert.ok(
      texts.some(
        (text) =>
          text.includes("Não foi possível responder") &&
          text.includes("model_error"),
      ),
      JSON.stringify(texts),
    );
    assert.ok(
      texts.every((text) => !text.includes("provider exploded")),
      JSON.stringify(texts),
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed occurrence keeps the reported reason instead of the generic status", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create({
      ...cron,
      conversationId: await f.runtime.create(),
    });
    const run = await f.tasks.runNow(task.id);
    f.tasks.finishRun(task.conversationId, run.requestId, {
      status: "erro",
      summary: "A tarefa não foi concluída: model_error: boom",
      error:
        "model_error: Compaction failed: Summarization hit the token limit",
      external: null,
    });
    f.finish("unanswered");
    await f.tasks.tick();
    const row = f.tasks.runs(task.id)[0];
    assert.equal(row.status, "erro");
    assert.equal(row.state, "failed");
    assert.match(row.error!, /Summarization hit the token limit/);
    assert.match(row.summary!, /model_error/);
  } finally {
    await f.close();
  }
});

test("close drains admitted submissions and rejects new work", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(once);
    const run = f.tasks.runNow(task.id);
    const close = f.tasks.close();
    assert.equal((await run).state, "pending");
    await close;
    assert.equal(f.submits, 1);
    await assert.rejects(f.tasks.tick(), /encerrando/);
    await assert.rejects(f.tasks.create(cron), /encerrando/);
    assert.throws(() => f.tasks.start(), /encerrando/);
  } finally {
    await f.close();
  }
});

test("TaskError identifies safe module errors without reclassifying external failures", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.tasks.create({ ...cron, title: "" }), TaskError);
    await assert.rejects(
      f.tasks.create({ ...cron, schedule: "invalid cron" }),
      TaskError,
    );
    await assert.rejects(f.tasks.runNow("missing"), TaskError);
    assert.throws(() => f.tasks.setEnabled("missing", true), TaskError);
    await assert.rejects(
      f.tasks.create({ ...cron, conversationId: "missing" }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof TaskError) &&
        error.message === "Conversa não encontrada",
    );
  } finally {
    await f.close();
  }
});

test("a manual client key deduplicates its own occurrence and refuses a second trigger", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create({ ...cron, enabled: false });
    const first = await f.tasks.runNow(task.id, "client-key");
    // The same key is the same request: it replays, it does not run twice.
    assert.equal((await f.tasks.runNow(task.id, "client-key")).id, first.id);
    // A different key while the schedule runs is a second trigger: refused, never joined.
    await assert.rejects(
      f.tasks.runNow(task.id, "other-key"),
      /execução em andamento/,
    );
    f.finish();
    await f.tasks.tick();
    assert.equal((await f.tasks.runNow(task.id, "client-key")).id, first.id);
    // After it finished, a new key is a new manual run.
    const second = await f.tasks.runNow(task.id, "other-key");
    assert.notEqual(second.id, first.id);
    f.finish();
    await f.tasks.tick();
    const long = await f.tasks.runNow(task.id, "a".repeat(160));
    assert.ok(long.requestId.length <= 160);
    assert.notEqual(long.id, first.id);
    assert.equal(f.tasks.get(task.id)?.enabled, false);
    for (const key of ["", "has space", "a".repeat(161), null, 42])
      await assert.rejects(
        f.tasks.runNow(task.id, key as unknown as string),
        /requestId/,
      );
    const secondTask = await f.tasks.create({ ...cron, enabled: false });
    assert.notEqual(
      (await f.tasks.runNow(secondTask.id, "client-key")).id,
      first.id,
    );
  } finally {
    await f.close();
  }
});

test("actual Runtime keeps a task result on the web when only a legacy mapping exists without an active Telegram connection", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  let now = epoch;
  const tasks = new Tasks(app, () => now);
  try {
    const task = await tasks.create(once);
    app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "100",
      task.conversationId,
      "42",
    );
    now += 1000;
    await tasks.tick();
    const run = tasks.runs(task.id)[0];
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.deepEqual(
      {
        ...app.store.get<{
          source: string;
          chat: string | null;
          status: string;
        }>(
          "SELECT source,chat,status FROM requests WHERE requestId=?",
          run.requestId,
        ),
      },
      { source: "task", chat: null, status: "done" },
    );
    const view = (await app.snapshot(task.conversationId)).view;
    assert.equal(
      view.entries.filter((entry) => entry.kind === "pi.user").length,
      1,
    );
    assert.equal(
      view.entries.filter((entry) => entry.kind === "pi.assistant").length,
      1,
    );
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual Runtime recovers a deleted occurrence committed before admission, without an extra occurrence", async () => {
  const dir = await temp();
  let app = await Runtime.open({ dir, gateway });
  let now = epoch;
  let tasks = new Tasks(app, () => now);
  try {
    const task = await tasks.create(once);
    const runId = randomUUID();
    app.store.db.exec("BEGIN IMMEDIATE");
    app.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,requestId) VALUES (?,?,?,?)",
      runId,
      task.id,
      epoch + 1000,
      `task:${runId}`,
    );
    app.store.run(
      "UPDATE tasks SET nextRun=NULL,enabled=0 WHERE id=?",
      task.id,
    );
    app.store.db.exec("COMMIT");
    tasks.remove(task.id);
    assert.equal(app.store.all("SELECT * FROM requests").length, 0);
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, gateway });
    tasks = new Tasks(app, () => now);
    now += 60000;
    await Promise.all([tasks.tick(), tasks.tick()]);
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id).length, 1);
    assert.equal(tasks.runs(task.id)[0].id, runId);
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(tasks.list().length, 0);
    assert.equal(
      (await app.snapshot(task.conversationId)).view.entries.filter(
        (entry) => entry.kind === "pi.user",
      ).length,
      1,
    );
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual Runtime recovery deduplicates an admitted input whose request ledger remained pending", async () => {
  const dir = await temp();
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 4 }, () =>
      fauxAssistantMessage("Resposta persistida"),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  let app = await Runtime.open({ dir, gateway, models });
  let tasks = new Tasks(app, () => epoch);
  try {
    const task = await tasks.create(cron);
    const run = await tasks.runNow(task.id);
    await settle(app, task.conversationId);
    const submission = app.store.get<{ submissionId: number }>(
      "SELECT submissionId FROM requests WHERE requestId=?",
      run.requestId,
    )!;
    // Crash boundary: Pi committed the outcome, while the app's receipt was not committed.
    app.store.run(
      "UPDATE requests SET status='pending' WHERE requestId=?",
      run.requestId,
    );
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    tasks = new Tasks(app, () => epoch);
    await tasks.tick();
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id).length, 1);
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(faux.state.callCount, 1);
    assert.equal(
      app.store.get<{ submissionId: number }>(
        "SELECT submissionId FROM requests WHERE requestId=?",
        run.requestId,
      )!.submissionId,
      submission.submissionId,
    );
    assert.equal(
      (await app.snapshot(task.conversationId)).view.entries.filter(
        (entry) => entry.kind === "pi.user",
      ).length,
      1,
    );
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "actual Runtime resumes a model-pending occurrence using the same admitted input",
  { timeout: 5000 },
  async () => {
    const dir = await temp();
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const interrupted = fauxProvider();
    interrupted.setResponses([
      async (_transcript, options) => {
        started();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("Interrupted by close");
      },
    ]);
    const models = createModels();
    models.setProvider(interrupted.provider);
    let app = await Runtime.open({ dir, gateway, models });
    let tasks = new Tasks(app, () => epoch);
    try {
      const task = await tasks.create(cron);
      const run = await tasks.runNow(task.id);
      await modelStarted;
      assert.equal(tasks.runs(task.id)[0].state, "pending");
      const admitted = app.store.get<{ submissionId: number; status: string }>(
        "SELECT submissionId,status FROM requests WHERE requestId=?",
        run.requestId,
      )!;
      assert.equal(admitted.status, "pending");
      await tasks.close();
      await app.close();
      const resumed = fauxProvider();
      resumed.setResponses([fauxAssistantMessage("Resumed once")]);
      models.setProvider(resumed.provider);
      app = await Runtime.open({ dir, gateway, models });
      tasks = new Tasks(app, () => epoch);
      await tasks.tick();
      await settle(app, task.conversationId);
      await tasks.tick();
      assert.equal(tasks.runs(task.id).length, 1);
      assert.equal(tasks.runs(task.id)[0].state, "done");
      assert.equal(resumed.state.callCount, 1);
      assert.equal(
        app.store.get<{ submissionId: number }>(
          "SELECT submissionId FROM requests WHERE requestId=?",
          run.requestId,
        )!.submissionId,
        admitted.submissionId,
      );
      assert.equal(
        (await app.snapshot(task.conversationId)).view.entries.filter(
          (entry) => entry.kind === "pi.user",
        ).length,
        1,
      );
    } finally {
      await tasks.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("scheduled prompts can propose external actions but still require explicit approval", async () => {
  const dir = await temp();
  let writes = 0;
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "task-read",
        name: "mcp_read",
        arguments: { server: "mock", tool: "read", arguments: {} },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "task-propose",
        name: "propose_action",
        arguments: { server: "mock", tool: "write", arguments: {} },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Confirme a ação na conversa"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: {
      call: async (_s, _t, _args, kind) => {
        if (kind === "action") writes++;
        return { content: [{ type: "text", text: "Preview" }] };
      },
    },
  });
  const tasks = new Tasks(app, () => epoch);
  try {
    const task = await tasks.create({
      ...cron,
      prompt: "Prepare uma alteração externa",
    });
    await tasks.runNow(task.id);
    await settle(app, task.conversationId);
    await tasks.tick();
    assert.equal(tasks.runs(task.id)[0].state, "done");
    assert.equal(app.store.actions(task.conversationId)[0].state, "pending");
    assert.equal(writes, 0);
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function authorizeTaskConversation(
  store: Store,
  conversationId: string,
  thread = 11,
  app?: Runtime,
) {
  store.run(
    "INSERT OR REPLACE INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ botId: 123, token: "123:synthetic-test" }),
  );
  store.run("INSERT INTO telegram VALUES (?,?,?)", "42", conversationId, "42");
  store.run(
    "INSERT INTO telegram_grants VALUES (?,?,?)",
    "42",
    "42",
    conversationId,
  );
  store.run(
    "INSERT INTO telegram_conversations VALUES (?,?,?)",
    conversationId,
    "42",
    "42",
  );
  store.run(
    "INSERT INTO telegram_topic_conversations VALUES (?,?)",
    conversationId,
    thread,
  );
  store.run(
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
  if (app) {
    const transport = {
      send: async () => ({ message_id: 1 }),
    };
    const telegram = new Telegram(
      app,
      transport,
      ["42"],
      ["42"],
      "test_pi_bot",
      true,
      123,
    );
    app.flushTelegramPending = async () => {
      await telegram.flush();
    };
  }
}

test("trusted Telegram origin defaults to a frozen mirror route and rejects a different conversation", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const origin = {
      source: "telegram" as const,
      conversationId,
      requestId: "human-a",
    };
    f.store.run(
      "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
      conversationId,
      origin.requestId,
    );
    const task = await f.tasks.create(
      { ...cron, conversationId },
      "origin-create",
      origin,
    );
    assert.equal(task.delivery, "web_telegram");
    assert.equal(task.originSource, "telegram");
    assert.equal(task.originRequestId, "human-a");
    assert.equal(task.destinationMessageThreadId, 11);
    assert.equal(task.destinationBotId, "123");
    f.store.run(
      "INSERT OR REPLACE INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,?)",
      conversationId,
      origin.requestId,
      "Crie um resumo diário; somente na web.",
      origin.source,
    );
    const web = await f.tasks.create(
      { ...cron, conversationId, delivery: "web" },
      undefined,
      origin,
    );
    assert.equal(web.delivery, "web");
    assert.equal(web.destinationChat, null);
    await assert.rejects(
      f.tasks.create(
        { ...cron, conversationId: await f.runtime.create() },
        undefined,
        origin,
      ),
      /origem|Origem/,
    );
  } finally {
    await f.close();
  }
});

test("admitted occurrences keep their delivery snapshot when the task destination changes", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const task = await f.tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });
    const first = await f.tasks.runNow(task.id, "first-frozen-run");
    f.tasks.setDelivery(task.id, "web");
    const saved = f.tasks.runs(task.id)[0];
    assert.equal(saved.id, first.id);
    assert.equal(saved.delivery, "web_telegram");
    assert.equal(saved.destinationMessageThreadId, 11);
    f.finish();
    await f.tasks.tick();
    const second = await f.tasks.runNow(task.id, "second-frozen-run");
    assert.equal(second.delivery, "web");
    assert.equal(second.destinationChat, null);
  } finally {
    await f.close();
  }
});

test("unproven old occurrences stay blocked after a link and explicit future destination selection", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const conversationId = await f.runtime.create();
    const task = await f.tasks.create({ ...cron, conversationId });
    f.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,requestId) VALUES (?,?,?,?)",
      "old-run",
      task.id,
      epoch,
      "old-request",
    );
    await f.tasks.close();
    authorizeTaskConversation(f.store, conversationId);
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    reopened.setDelivery(task.id, "web_telegram");
    const old = reopened.runs(task.id)[0];
    assert.equal(old.destinationChat, null);
    assert.match(old.destinationReason ?? "", /legado|origem|destino/i);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("revoked frozen task destinations cannot revive after grant restoration", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const task = await f.tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });
    const run = await f.tasks.runNow(task.id);
    f.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      conversationId,
    );
    f.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversationId,
    );
    assert.match(f.tasks.get(task.id)?.destinationReason ?? "", /revogad/i);
    assert.match(
      f.tasks.runs(task.id).find((r) => r.id === run.id)?.destinationReason ??
        "",
      /revogad/i,
    );
    assert.equal(
      f.tasks.setDelivery(task.id, "web_telegram").destinationReason,
      null,
    );
    assert.match(f.tasks.runs(task.id)[0].destinationReason ?? "", /revogad/i);
  } finally {
    await f.close();
  }
});

test("terminal notifications use the admitted snapshot and independently authorized dedicated routes survive anchor archive", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const anchor = await f.runtime.create();
    f.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      anchor,
    );
    f.store.run("UPDATE telegram SET conversationId=?", anchor);
    const task = await f.tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });
    const run = await f.tasks.runNow(task.id);
    f.tasks.setDelivery(task.id, "web");
    f.store.run(
      "INSERT INTO conversation_lifecycle VALUES (?,?)",
      anchor,
      epoch,
    );
    f.store.run("DELETE FROM telegram_grants WHERE conversationId=?", anchor);
    f.store.run("DELETE FROM telegram");
    assert.equal(
      telegramConversationRoute(f.store, conversationId)?.messageThreadId,
      11,
    );
    queueTaskTelegram(f.store, conversationId, run.requestId, "saved answer");
    const deliveries = f.store.all<{ id: string; messageThreadId: number }>(
      "SELECT * FROM deliveries",
    );
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].messageThreadId, 11);
    assert.equal(
      taskTelegramAuthorized(f.store, deliveries[0].id, ["42"], ["42"], 123),
      true,
    );
  } finally {
    await f.close();
  }
});

test("an old admitted run never gets a Telegram copy from a newly selected future destination", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    const task = await f.tasks.create({ ...cron, conversationId });
    f.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,requestId) VALUES (?,?,?,?)",
      "old",
      task.id,
      epoch,
      "old-notification",
    );
    authorizeTaskConversation(f.store, conversationId);
    f.tasks.setDelivery(task.id, "web_telegram");
    queueTaskTelegram(
      f.store,
      conversationId,
      "old-notification",
      "old result",
    );
    assert.equal(f.store.all("SELECT * FROM deliveries").length, 0);
    assert.match(
      f.store.get<{ reason: string }>("SELECT reason FROM task_notifications")
        ?.reason ?? "",
      /destino|legado/i,
    );
  } finally {
    await f.close();
  }
});

test("blocked Telegram reasons remain visible after calendar admission and completion", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const task = await f.tasks.create({
      ...cron,
      conversationId,
      delivery: "web_telegram",
    });
    f.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      conversationId,
    );
    f.time = epoch + 60000;
    await f.tasks.tick();
    assert.match(f.tasks.get(task.id)?.lastError ?? "", /revogad/i);
    f.finish();
    await f.tasks.tick();
    assert.match(f.tasks.get(task.id)?.lastError ?? "", /revogad/i);
  } finally {
    await f.close();
  }
});

test("topic closure and dedicated route replacement permanently block a saved destination", async () => {
  for (const mutation of ["close", "replace", "delete"] as const) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId);
      const task = await f.tasks.create({
        ...cron,
        conversationId,
        delivery: "web_telegram",
      });
      if (mutation === "close") {
        f.store.run(
          "INSERT INTO telegram_known_topics(chat,user,messageThreadId,closed) VALUES ('42','42',11,1)",
        );
        f.store.run("UPDATE telegram_known_topics SET closed=0");
      } else if (mutation === "replace") {
        f.store.run(
          "UPDATE telegram_conversations SET user='99' WHERE conversationId=?",
          conversationId,
        );
        f.store.run(
          "UPDATE telegram_conversations SET user='42' WHERE conversationId=?",
          conversationId,
        );
      } else {
        f.store.run(
          "DELETE FROM telegram_conversations WHERE conversationId=?",
          conversationId,
        );
        f.store.run(
          "INSERT INTO telegram_conversations VALUES (?,'42','42')",
          conversationId,
        );
      }
      assert.match(
        f.tasks.get(task.id)?.destinationReason ?? "",
        /revogad/i,
        mutation,
      );
    } finally {
      await f.close();
    }
  }
});

test("trusted Telegram task creation rejects a missing or revoked captured origin route instead of resolving a new topic", async () => {
  for (const mutation of ["missing", "revoked", "changed-topic"] as const) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId, 101);
      const origin = {
        source: "telegram" as const,
        conversationId,
        requestId: "captured-human",
      };
      if (mutation !== "missing")
        f.store.run(
          "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',101,?)",
          conversationId,
          origin.requestId,
          mutation === "revoked" ? "revoked" : "authorized",
        );
      if (mutation === "changed-topic")
        f.store.run(
          "UPDATE telegram_topic_conversations SET messageThreadId=202 WHERE conversationId=?",
          conversationId,
        );
      await assert.rejects(
        f.tasks.create({ ...cron, conversationId }, "captured-create", origin),
        /origem|Origem|revogad|capturad/i,
        mutation,
      );
      assert.equal(f.tasks.list().length, 0);
      assert.equal(f.store.all("SELECT * FROM task_creations").length, 0);
      f.store.run(
        "INSERT OR REPLACE INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,?)",
        conversationId,
        origin.requestId,
        "Crie um resumo diário; somente na web.",
        origin.source,
      );
      const web = await f.tasks.create(
        { ...cron, conversationId, delivery: "web" },
        undefined,
        origin,
      );
      assert.equal(web.delivery, "web");
      assert.equal(web.destinationMessageThreadId, null);
    } finally {
      await f.close();
    }
  }
});

test("ordinary answer parts cannot send from a revoked captured request even after its grant is restored", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    const requestId = "request:with:colons";
    f.store.run(
      "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
      conversationId,
      requestId,
    );
    f.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      conversationId,
    );
    f.store.run(
      "INSERT INTO telegram_grants VALUES (?,'42',?)",
      "42",
      conversationId,
    );
    assert.equal(
      f.store.get<{ state: string }>(
        "SELECT state FROM request_telegram_routes",
      )?.state,
      "revoked",
    );
    // Simulate a monitor that held stale authorized state across an awaited history read.
    f.store.queueTelegram(
      `${conversationId}:${requestId}`,
      "42",
      "late old answer",
      3500,
      conversationId,
      11,
    );
    const delivery = f.store.get<{ id: string }>("SELECT id FROM deliveries")!;
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["42"], ["42"], 123),
      false,
    );
  } finally {
    await f.close();
  }
});

test("legacy ordinary replies require their own grant and allowlists while invalid configured routes remain blocked", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    f.store.run("DELETE FROM meta WHERE key='telegram:connection'");
    f.store.queueTelegram(
      `${conversationId}:legacy-request`,
      "42",
      "legacy answer",
      3500,
      conversationId,
      11,
    );
    const delivery = f.store.get<{ id: string }>("SELECT id FROM deliveries")!;
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["42"], ["42"], 123),
      true,
    );
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["99"], ["42"], 123),
      false,
    );
    f.store.run("UPDATE deliveries SET chat='99'");
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["42"], ["42"], 123),
      false,
    );
    f.store.run("UPDATE deliveries SET chat='42'");
    f.store.run("INSERT INTO meta VALUES ('telegram:connection','not JSON')");
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["42"], ["42"], 123),
      false,
    );
    f.store.run("DELETE FROM meta WHERE key='telegram:connection'");
    f.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      conversationId,
    );
    assert.equal(
      taskTelegramAuthorized(f.store, delivery.id, ["42"], ["42"], 123),
      false,
    );
  } finally {
    await f.close();
  }
});

test("one-time destination migration flags old implicit web intent and preserves explicit web receipts", async () => {
  const f = await fixture();
  let reopened: Tasks | undefined;
  try {
    const conversationId = await f.runtime.create();
    const implicit = await f.tasks.create(
      { ...cron, conversationId },
      "chat:old:implicit",
    );
    const explicit = await f.tasks.create(
      { ...cron, conversationId, delivery: "web" },
      "chat:old:explicit",
    );
    const admitted = await f.tasks.runNow(
      implicit.id,
      "admitted-before-migration",
    );
    await f.tasks.close();
    f.store.db.exec("ALTER TABLE tasks DROP COLUMN originSource");
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.match(
      reopened.get(implicit.id)?.destinationReason ?? "",
      /destino|origem|legado/i,
    );
    assert.equal(reopened.get(implicit.id)?.enabled, false);
    assert.equal(reopened.get(implicit.id)?.nextRun, null);
    assert.equal(reopened.get(explicit.id)?.enabled, true);
    assert.equal(reopened.get(explicit.id)?.nextRun, explicit.nextRun);
    assert.equal(reopened.get(explicit.id)?.destinationReason, null);
    assert.deepEqual(reopened.runs(implicit.id)[0], admitted);
    const selected = reopened.setDelivery(implicit.id, "web");
    assert.equal(selected.destinationReason, null);
    assert.equal(selected.enabled, false);
    assert.equal(selected.nextRun, null);
    assert.deepEqual(reopened.runs(implicit.id)[0], admitted);
    const fresh = await reopened.create({ ...cron, conversationId });
    assert.equal(fresh.destinationReason, null);
    await reopened.close();
    reopened = new Tasks(f.runtime as unknown as Runtime, () => epoch);
    assert.equal(reopened.get(fresh.id)?.destinationReason, null);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("a trusted-origin replay accepts a pre-origin receipt without migrating its destination or creating a duplicate", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    const input = { ...cron, conversationId };
    const task = await f.tasks.create(input, "chat:pre-origin:tool");
    f.store.run(
      "UPDATE tasks SET destinationReason='Destino legado exige seleção explícita' WHERE id=?",
      task.id,
    );
    const replayed = await f.tasks.create(input, "chat:pre-origin:tool", {
      source: "telegram",
      conversationId,
      requestId: "old-human-request",
    });
    assert.equal(replayed.id, task.id);
    assert.equal(replayed.delivery, "web");
    assert.match(replayed.destinationReason ?? "", /legado/);
    assert.equal(f.tasks.list().length, 1);
    assert.equal(f.store.all("SELECT * FROM task_creations").length, 1);
  } finally {
    await f.close();
  }
});

test("trusted web explicit Telegram task creation rejects a revoked captured route instead of resolving the replacement topic", async () => {
  for (const mutation of ["revoked", "changed-topic"] as const) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId, 101);
      const origin = {
        source: "web" as const,
        conversationId,
        requestId: "captured-web-human",
      };
      f.store.run(
        "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',101,?)",
        conversationId,
        origin.requestId,
        mutation === "revoked" ? "revoked" : "authorized",
      );
      if (mutation === "changed-topic")
        f.store.run(
          "UPDATE telegram_topic_conversations SET messageThreadId=202 WHERE conversationId=?",
          conversationId,
        );
      await assert.rejects(
        f.tasks.create(
          { ...cron, conversationId, delivery: "web_telegram" },
          "captured-web-create",
          origin,
        ),
        /origem|Origem|revogad|capturad/i,
        mutation,
      );
      assert.equal(f.tasks.list().length, 0);
      f.store.run(
        "INSERT OR REPLACE INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,?)",
        conversationId,
        origin.requestId,
        "Crie um resumo diário; somente na web.",
        origin.source,
      );
      const web = await f.tasks.create(
        { ...cron, conversationId, delivery: "web" },
        undefined,
        origin,
      );
      assert.equal(web.delivery, "web");
    } finally {
      await f.close();
    }
  }
});

test("trusted web explicit Telegram task creation can select an authorized plain binding without a captured canonical route", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    authorizeTaskConversation(f.store, conversationId);
    f.store.run(
      "DELETE FROM telegram_conversations WHERE conversationId=?",
      conversationId,
    );
    f.store.run(
      "DELETE FROM telegram_topic_conversations WHERE conversationId=?",
      conversationId,
    );
    const origin = {
      source: "web" as const,
      conversationId,
      requestId: "plain-web-human",
    };
    const task = await f.tasks.create(
      { ...cron, conversationId, delivery: "web_telegram" },
      undefined,
      origin,
    );
    assert.equal(task.destinationMessageThreadId, null);
    assert.equal(task.originSource, "web");
  } finally {
    await f.close();
  }
});

test("canonical task defaults use the captured topic for either human transport despite a model web argument", async () => {
  for (const source of ["web", "telegram"] as const) {
    for (const delivery of [undefined, "web"] as const) {
      const f = await fixture();
      try {
        const conversationId = await f.runtime.create();
        authorizeTaskConversation(f.store, conversationId, 101);
        const origin = { source, conversationId, requestId: "human-canonical" };
        f.store.run(
          "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,?)",
          conversationId,
          origin.requestId,
          "Crie um resumo diário",
          source,
        );
        f.store.run(
          "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',101,'authorized')",
          conversationId,
          origin.requestId,
        );
        const task = await f.tasks.create(
          { ...cron, conversationId, ...(delivery ? { delivery } : {}) },
          "canonical-default",
          origin,
        );
        assert.equal(task.delivery, "web_telegram");
        assert.equal(task.originSource, source);
        assert.equal(task.destinationMessageThreadId, 101);
        f.store.run(
          "UPDATE telegram_topic_conversations SET messageThreadId=202 WHERE conversationId=?",
          conversationId,
        );
        const replay = await f.tasks.create(
          { ...cron, conversationId, ...(delivery ? { delivery } : {}) },
          "canonical-default",
          origin,
        );
        assert.equal(replay.id, task.id);
        assert.equal(replay.destinationMessageThreadId, 101);
        assert.equal(f.tasks.list().length, 1);
      } finally {
        await f.close();
      }
    }
  }
});

test("only persisted human web-only choices can suppress a canonical task Telegram destination", async () => {
  for (const choice of [
    "somente na web",
    "só na web",
    "apenas web",
    "web only",
    "only on the web",
  ]) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId);
      const origin = {
        source: "web" as const,
        conversationId,
        requestId: "human-only-web",
      };
      f.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,'web')",
        conversationId,
        origin.requestId,
        `Crie um resumo diário; ${choice}.`,
      );
      f.store.run(
        "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
        conversationId,
        origin.requestId,
      );
      const task = await f.tasks.create(
        { ...cron, conversationId, delivery: "web_telegram" },
        undefined,
        origin,
      );
      assert.equal(task.delivery, "web");
      assert.equal(task.destinationChat, null);
      const direct = await f.tasks.create({
        ...cron,
        conversationId,
        delivery: "web",
      });
      assert.equal(direct.delivery, "web");
    } finally {
      await f.close();
    }
  }
});

test("ambiguous human web-only clauses require explicit clarification", async () => {
  for (const choice of [
    "not only on the web",
    "não somente na web",
    "web only and also Telegram",
    "somente na web e também Telegram",
    "maybe web only",
    "talvez só na web",
    'Use the prompt "web only"',
    "Do not allow Telegram delivery; keep results on the web",
    "Não mande mensagens para Telegram; mantenha os resultados na web",
  ]) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId);
      const origin = {
        source: "telegram" as const,
        conversationId,
        requestId: "human-ambiguous",
      };
      f.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,'telegram')",
        conversationId,
        origin.requestId,
        `Create a daily task; ${choice}.`,
      );
      f.store.run(
        "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
        conversationId,
        origin.requestId,
      );
      await assert.rejects(
        f.tasks.create(
          { ...cron, conversationId, delivery: "web" },
          undefined,
          origin,
        ),
        /amb[ií]gu|explicit|escolha|selecione/i,
      );
      assert.equal(f.tasks.list().length, 0);
    } finally {
      await f.close();
    }
  }
});

test("a model web argument cannot bypass a missing or revoked canonical origin route", async () => {
  for (const source of ["web", "telegram"] as const) {
    for (const state of ["missing", "revoked"] as const) {
      const f = await fixture();
      try {
        const conversationId = await f.runtime.create();
        authorizeTaskConversation(f.store, conversationId);
        const origin = {
          source,
          conversationId,
          requestId: "human-route-unavailable",
        };
        f.store.run(
          "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,?)",
          conversationId,
          origin.requestId,
          "Crie um resumo diário",
          source,
        );
        if (state === "revoked")
          f.store.run(
            "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'revoked')",
            conversationId,
            origin.requestId,
          );
        await assert.rejects(
          f.tasks.create(
            { ...cron, conversationId, delivery: "web" },
            undefined,
            origin,
          ),
          /origem|capturad|revogad/i,
        );
        assert.equal(f.tasks.list().length, 0);
      } finally {
        await f.close();
      }
    }
  }
});

test("explicit PT-BR and English no-Telegram delivery instructions never default to a topic", async () => {
  for (const text of [
    "Schedule a daily summary. Do not send to Telegram; keep results on the web.",
    "Crie um resumo diário. Não envie para o Telegram; mantenha os resultados na web.",
    "Schedule a daily summary. Don't send to Telegram; keep results on the web.",
    "Schedule a daily summary. Don’t send to Telegram; keep results on the web.",
    "Crie um resumo diário, sem Telegram.",
  ]) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId);
      const origin = {
        source: "web" as const,
        conversationId,
        requestId: "human-no-telegram",
      };
      f.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,'web')",
        conversationId,
        origin.requestId,
        text,
      );
      f.store.run(
        "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
        conversationId,
        origin.requestId,
      );
      const task = await f.tasks.create(
        { ...cron, conversationId, delivery: "web_telegram" },
        undefined,
        origin,
      );
      assert.equal(task.delivery, "web");
      assert.equal(task.destinationChat, null);
    } finally {
      await f.close();
    }
  }
});

test("multiline fenced and blockquoted reminder content cannot prove a delivery choice", async () => {
  for (const text of [
    "Schedule this reminder text daily:\n```\nweb only\n```",
    "Schedule this reminder text daily:\n~~~\nweb only\n~~~",
    "Schedule this reminder text daily:\n> web only",
    "Schedule this reminder text daily:\n> Quoted content\nweb only",
    "Schedule this reminder text daily:\n```\nDo not send to Telegram\n```",
    "Schedule this reminder text daily:\n\n    web only",
    "Schedule this reminder text daily:\n\n\tweb only",
    'Schedule this reminder text daily:\n"\nweb only\n"',
    "Schedule this reminder text daily:\n'\nweb only\n'",
  ]) {
    const f = await fixture();
    try {
      const conversationId = await f.runtime.create();
      authorizeTaskConversation(f.store, conversationId);
      const origin = {
        source: "web" as const,
        conversationId,
        requestId: "human-quoted-reminder",
      };
      f.store.run(
        "INSERT INTO requests(conversationId,requestId,text,source) VALUES (?,?,?,'web')",
        conversationId,
        origin.requestId,
        text,
      );
      f.store.run(
        "INSERT INTO request_telegram_routes(conversationId,requestId,chat,user,botId,messageThreadId,state) VALUES (?,?,'42','42','123',11,'authorized')",
        conversationId,
        origin.requestId,
      );
      await assert.rejects(
        f.tasks.create({ ...cron, conversationId }, undefined, origin),
        /amb[ií]gu|explicit|escolha|selecione/i,
        text,
      );
      assert.equal(f.tasks.list().length, 0);
    } finally {
      await f.close();
    }
  }
});

test("editing a schedule preserves its conversation, origin, fixed destination and admitted history", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create({
      ...cron,
      conversationId: await f.runtime.create(),
    });
    f.store.run(
      "UPDATE tasks SET destinationChat='100',destinationUser='42',destinationBotId='123',destinationMessageThreadId=11,originSource='telegram',originConversationId=? WHERE id=?",
      task.conversationId,
      task.id,
    );
    const before = f.tasks.get(task.id)!;
    const edited = f.tasks.edit(task.id, {
      title: "Novo título",
      prompt: "Nova instrução",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    assert.equal(edited.title, "Novo título");
    assert.equal(edited.prompt, "Nova instrução");
    assert.equal(edited.nextRun, Date.parse("2026-10-08T09:00:00Z"));
    for (const key of [
      "conversationId",
      "originSource",
      "originConversationId",
      "originRequestId",
      "destinationChat",
      "destinationUser",
      "destinationBotId",
      "destinationMessageThreadId",
      "delivery",
    ] as const)
      assert.equal(edited[key], before[key]);
    assert.throws(
      () => f.tasks.edit(task.id, { timezone: "+03:00" }),
      TaskError,
    );
    assert.throws(() => f.tasks.edit(task.id, { schedule: "bad" }), TaskError);
    assert.throws(
      () => f.tasks.edit(task.id, { conversationId: "other" }),
      TaskError,
    );
    f.tasks.setEnabled(task.id, false);
    assert.equal(f.tasks.edit(task.id, { title: "Pausada" }).nextRun, null);
    assert.equal(f.submits, 0);
    assert.equal(f.store.all("SELECT * FROM task_runs").length, 0);
  } finally {
    await f.close();
  }
});

test("prompt edits cannot rewrite an occurrence that is already pending", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create({
      ...cron,
      conversationId: await f.runtime.create(),
    });
    f.store.run(
      "INSERT INTO task_runs(id,taskId,scheduledAt,requestId) VALUES ('pending-edit',?,?,'pending-edit')",
      task.id,
      epoch,
    );
    assert.throws(
      () => f.tasks.edit(task.id, { prompt: "Changed after claim" }),
      /ocorrência pendente/,
    );
    assert.equal(f.tasks.get(task.id)!.prompt, task.prompt);
    assert.equal(
      f.tasks.edit(task.id, { title: "New label" }).title,
      "New label",
    );
    assert.equal(f.tasks.runs(task.id)[0].state, "pending");
    assert.equal(f.submits, 0);
  } finally {
    await f.close();
  }
});

test("a manual run is marked in the log and does not reschedule", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    const before = f.tasks.get(task.id)!;
    const run = await f.tasks.runNow(task.id);
    assert.equal(run.trigger, "manual");
    assert.equal(run.scheduledAt, epoch);
    const after = f.tasks.get(task.id)!;
    // Same prompt, same conversation, same delivery; nothing scheduled moved.
    assert.equal(after.nextRun, before.nextRun);
    assert.equal(after.enabled, true);
    assert.equal(run.conversationId, task.conversationId);
    assert.equal(run.delivery, task.delivery);
    f.finish();
    await f.tasks.tick();

    f.time = epoch + 3 * 60000;
    await f.tasks.tick();
    const [scheduled] = f.tasks.runs(task.id);
    assert.equal(scheduled.trigger, "scheduled");
    assert.equal(f.tasks.runs(task.id).length, 2);
  } finally {
    await f.close();
  }
});

test("a manual run of a running schedule is refused", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    await f.tasks.runNow(task.id);
    await assert.rejects(f.tasks.runNow(task.id), /execução em andamento/);
    // The refusal leaves exactly one occurrence and one submitted turn.
    assert.equal(f.tasks.runs(task.id).length, 1);
    assert.equal(f.submits, 1);
  } finally {
    await f.close();
  }
});

test("inFlight tells a run apart from an idle conversation", async () => {
  const f = await fixture();
  try {
    const task = await f.tasks.create(cron);
    assert.equal(f.tasks.inFlight(task.conversationId), false);
    await f.tasks.runNow(task.id);
    assert.equal(f.tasks.inFlight(task.conversationId), true);
    f.finish();
    await f.tasks.tick();
    assert.equal(f.tasks.inFlight(task.conversationId), false);
  } finally {
    await f.close();
  }
});

test("a stale in-flight run times out once and alerts the destination", async () => {
  const f = await fixture();
  const prev = process.env.TASK_RUN_TIMEOUT_MIN;
  process.env.TASK_RUN_TIMEOUT_MIN = "0.001";
  try {
    const task = await f.tasks.create(cron);
    await f.tasks.runNow(task.id);
    f.time = epoch + 120_000;
    await f.tasks.tick();
    const run = f.tasks.runs(task.id)[0];
    assert.equal(run.state, "failed");
    assert.equal(run.status, "erro");
    assert.match(run.summary!, /expirou/i);
    assert.equal(
      f.store.all("SELECT * FROM task_notifications").length,
      1,
      "alerta único",
    );
    f.time = epoch + 240_000;
    await f.tasks.tick();
    assert.equal(
      f.store.all("SELECT * FROM task_notifications").length,
      1,
      "sem alerta duplicado",
    );
  } finally {
    if (prev === undefined) delete process.env.TASK_RUN_TIMEOUT_MIN;
    else process.env.TASK_RUN_TIMEOUT_MIN = prev;
    await f.close();
  }
});

test("only one scheduled run dispatches per conversation at a time", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.runtime.create();
    const a = await f.tasks.create({ ...cron, conversationId, title: "A" });
    const b = await f.tasks.create({ ...cron, conversationId, title: "B" });
    await f.tasks.runNow(a.id);
    assert.equal(f.submits, 1);
    await f.tasks.runNow(b.id);
    assert.equal(f.submits, 1, "não empilha dois dispatches na mesma conversa");
    f.finish();
    await f.tasks.tick();
    assert.equal(f.submits, 2, "o segundo agenda após o primeiro terminar");
  } finally {
    await f.close();
  }
});
