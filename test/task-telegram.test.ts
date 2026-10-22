import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import {
  isNullAcknowledgement,
  taskOccurrenceDelivered,
} from "../src/task-telegram.js";
import { Tasks } from "../src/tasks.js";
import { Telegram } from "../src/telegram.js";
import { Store, type Delivery } from "../src/store.js";

const epoch = Date.parse("2026-10-08T12:00:00Z");
const connection = {
  enabled: true,
  bot: { id: 123456 },
  userId: "42",
  chatId: "42",
  conversationId: "",
};
async function fixture(answer = "**Resultado do cron**", linked = true) {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-telegram-"));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(answer)]);
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
  };
  let app = await Runtime.open(options);
  let now = epoch;
  let tasks = new Tasks(app, () => now);
  const id = await app.create("Conversa do cron");
  const config = { ...connection, conversationId: id };
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ token: "123456:fake-local-only", botId: 123456 }),
  );
  if (linked) {
    app.store.run("INSERT INTO telegram VALUES (?,?,?)", "42", id, "42");
    app.store.run("INSERT INTO telegram_grants VALUES (?,?,?)", "42", "42", id);
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify(config),
    );
  }
  const createdTask = await tasks.create({
    title: "Resumo",
    prompt: "Resuma esta conversa",
    kind: "cron",
    schedule: "* * * * *",
    timezone: "UTC",
    conversationId: id,
    delivery: linked ? "web_telegram" : "web",
  });
  const task = tasks.get(createdTask.id)!;
  const sent: Array<{ chat: string; text: string }> = [];
  let uncertain = false;
  const transport = {
    send: async (chat: string, text: string) => {
      sent.push({ chat, text });
      if (uncertain) throw new Error("mock result unknown");
      return { message_id: sent.length };
    },
  };
  const engine = (
    overrides: {
      users?: string[];
      chats?: string[];
      botId?: number | null;
    } = {},
  ) =>
    new Telegram(
      app,
      transport,
      overrides.users ?? ["42"],
      overrides.chats ?? ["42"],
      "test_pi_bot",
      true,
      overrides.botId === null ? undefined : (overrides.botId ?? 123456),
    );
  let flushOnTaskSettlement = true;
  const wireFlush = () => {
    app.flushTelegramPending = async () => {
      if (!flushOnTaskSettlement) return;
      await engine().flush();
    };
  };
  wireFlush();
  return {
    get app() {
      return app;
    },
    get tasks() {
      return tasks;
    },
    faux,
    models,
    id,
    task,
    sent,
    config,
    engine,
    /** Keep deliveries queued until an explicit `engine().flush()` (pending/revoke tests). */
    set deferTaskFlush(value: boolean) {
      flushOnTaskSettlement = !value;
    },
    set uncertain(value: boolean) {
      uncertain = value;
    },
    set time(value: number) {
      now = value;
    },
    async run() {
      now = epoch + 60000;
      await tasks.tick();
      await (await app.conversation(id)).waitForIdle(context);
      for (let n = 0; n < 100; n++) {
        if (!app.store.get("SELECT 1 FROM requests WHERE status='pending'"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        app.store.all("SELECT 1 FROM requests WHERE status='pending'").length,
        0,
      );
      await tasks.tick();
      return tasks.runs(task.id)[0]!;
    },
    async reopen(beforeOpen?: () => void) {
      await tasks.close();
      await app.close();
      beforeOpen?.();
      app = await Runtime.open(options);
      tasks = new Tasks(app, () => now);
      wireFlush();
    },
    async close() {
      await tasks.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("completed cron queues one Telegram result and retry/restart never duplicates input, cron or delivery", async () => {
  const f = await fixture();
  try {
    const run = await f.run();
    assert.equal(run.state, "done");
    const rows = f.app.store.all<Delivery>("SELECT * FROM deliveries");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.chat, "42");
    assert.match(rows[0]?.text ?? "", /<b>Resultado do cron<\/b>/);
    const telegram = f.engine();
    await Promise.all([telegram.flush(), telegram.flush()]);
    assert.equal(f.sent.length, 1);
    await telegram.drain();
    await f.app.submit(
      f.id,
      run.requestId,
      "Resuma esta conversa",
      "task",
      null,
    );
    await (await f.app.conversation(f.id)).waitForIdle(context);
    await f.reopen();
    await f.tasks.tick();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.tasks.runs(f.task.id).length, 1);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
  } finally {
    await f.close();
  }
});

test("web-only tasks keep a durable web decision and never queue Telegram deliveries", async () => {
  const f = await fixture();
  try {
    f.tasks.setDelivery(f.task.id, "web");
    const run = await f.run();
    assert.equal(run.state, "done");
    assert.equal(
      f.app.store.get<{ state: string }>("SELECT state FROM task_notifications")
        ?.state,
      "web_only",
    );
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
    await f.app.submit(
      f.id,
      run.requestId,
      "Resuma esta conversa",
      "task",
      null,
    );
    await (await f.app.conversation(f.id)).waitForIdle(context);
    await f.engine().flush();
    assert.equal(f.app.store.all("SELECT * FROM task_notifications").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
    assert.equal(f.sent.length, 0);
  } finally {
    await f.close();
  }
});

test("web plus Telegram sends one copy only after the explicit task selection", async () => {
  const f = await fixture();
  try {
    f.tasks.setDelivery(f.task.id, "web_telegram");
    const run = await f.run();
    assert.equal(run.state, "done");
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
    assert.equal(
      f.app.store.get<{ state: string }>("SELECT state FROM task_notifications")
        ?.state,
      "queued",
    );
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    // The result is the message; a task title is never content.
    assert.match(f.sent[0]!.text, /Resultado do cron/);
    assert.doesNotMatch(f.sent[0]!.text, /Tarefa:/);
  } finally {
    await f.close();
  }
});

test("a terminal task answer beyond the first thousand history entries is delivered intact", async () => {
  const f = await fixture("Resposta final depois do histórico extenso");
  try {
    const conversation = await f.app.conversation(f.id);
    await conversation.commit(async (tx) => {
      for (let n = 0; n < 1100; n++)
        await tx.appendEntry(conversation.id, {
          kind: "synthetic-history",
          data: { n },
        });
    }, context);
    await f.run();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /Resposta final depois do histórico extenso/);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await f.close();
  }
});

test("legacy grant migration occurs once and a removed grant stays removed after every restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-grant-migration-"));
  let store = new Store(dir);
  try {
    store.run("INSERT INTO telegram VALUES ('42','2','42')");
    store.db.exec("DROP TABLE telegram_grants");
    store.close();
    store = new Store(dir);
    assert.equal(store.all("SELECT * FROM telegram_grants").length, 1);
    store.run("DELETE FROM telegram_grants");
    store.close();
    store = new Store(dir);
    assert.equal(store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(store.all("SELECT * FROM telegram").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only persisted scheduler occurrences can create a task notification", async () => {
  const f = await fixture();
  try {
    await f.app.submit(
      f.id,
      "not-a-scheduler-occurrence",
      "Pedido sintético",
      "task",
      null,
    );
    await (await f.app.conversation(f.id)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.app.store.all("SELECT * FROM task_notifications").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
  } finally {
    await f.close();
  }
});

test("a task in the conversation selected through Telegram uses its current mapping instead of the original setup conversation", async () => {
  const f = await fixture();
  try {
    const current = await f.app.create("Conversa selecionada");
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      current,
    );
    f.app.store.run("UPDATE telegram SET conversationId=?", current);
    const task = await f.tasks.create({
      title: "Tarefa atual",
      prompt: "Resuma",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: current,
      delivery: "web_telegram",
    });
    await f.tasks.runNow(task.id, "synthetic-manual-occurrence");
    await (await f.app.conversation(current)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /Resultado do cron/);
    assert.doesNotMatch(f.sent[0]!.text, /Tarefa atual/);
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM task_notifications",
      )?.conversationId,
      current,
    );
  } finally {
    await f.close();
  }
});

test("a conversation without active Telegram keeps the cron result only on the web, including after a later link", async () => {
  for (const mode of ["unlinked", "disabled", "wrong-user", "no-grant"]) {
    const f = await fixture("Resultado privado", mode !== "unlinked");
    try {
      if (mode === "disabled")
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify({ ...f.config, enabled: false }),
        );
      if (mode === "wrong-user")
        f.app.store.run("UPDATE telegram SET user='99'");
      if (mode === "no-grant") f.app.store.run("DELETE FROM telegram_grants");
      const run = await f.run();
      assert.equal(run.state, "done");
      assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0, mode);
      assert.ok(
        (await f.app.snapshot(f.id)).view.entries.some(
          (entry) => entry.kind === "pi.assistant",
        ),
      );
      f.app.store.run(
        "INSERT OR REPLACE INTO telegram VALUES (?,?,?)",
        "42",
        f.id,
        "42",
      );
      f.app.store.run(
        "INSERT OR REPLACE INTO telegram_grants VALUES (?,?,?)",
        "42",
        "42",
        f.id,
      );
      f.app.store.run(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        "telegram:connection",
        JSON.stringify(f.config),
      );
      await f.app.submit(
        f.id,
        run.requestId,
        "Resuma esta conversa",
        "task",
        null,
      );
      await (await f.app.conversation(f.id)).waitForIdle(context);
      await f.reopen();
      await f.engine().flush();
      assert.equal(
        f.sent.length,
        0,
        "a later link cannot retarget a completed occurrence",
      );
    } finally {
      await f.close();
    }
  }
});

test("a revoked mapping, grant, user or connection cancels a pending cron delivery before sending, even after restart", async () => {
  for (const revoke of [
    "mapping",
    "grant",
    "user",
    "disconnect",
    "other-chat",
  ]) {
    const f = await fixture();
    try {
      f.deferTaskFlush = true;
      await f.run();
      assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
      const sentBeforeRevoke = f.sent.length;
      if (revoke === "mapping") f.app.store.run("DELETE FROM telegram");
      if (revoke === "grant") f.app.store.run("DELETE FROM telegram_grants");
      if (revoke === "user") f.app.store.run("UPDATE telegram SET user='99'");
      if (revoke === "disconnect")
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify({ ...f.config, enabled: false }),
        );
      if (revoke === "other-chat")
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify({ ...f.config, chatId: "99" }),
        );
      await f.reopen();
      await f.engine().flush();
      assert.equal(f.sent.length, sentBeforeRevoke, revoke);
      assert.equal(
        f.app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
        "cancelled",
      );
    } finally {
      await f.close();
    }
  }
});

test("an uncertain cron Telegram send is never retried or reformatted after restart", async () => {
  const f = await fixture();
  try {
    f.deferTaskFlush = true;
    await f.run();
    f.uncertain = true;
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(
      f.app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
      "uncertain",
    );
    await f.reopen();
    f.uncertain = false;
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await f.close();
  }
});

test("a completed cron with an unsent outbox survives restart and concurrent flush sends it once", async () => {
  const f = await fixture();
  try {
    const run = await f.run();
    await f.reopen();
    const telegram = f.engine();
    await Promise.all([telegram.flush(), telegram.flush(), f.tasks.tick()]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.tasks.runs(f.task.id)[0]?.requestId, run.requestId);
    assert.equal(
      f.app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
      "sent",
    );
    await telegram.drain();
  } finally {
    await f.close();
  }
});

test("revocation cannot revive an old pending notification by reconnecting or restoring the same grant", async () => {
  for (const revoke of [
    "grant",
    "mapping",
    "disconnect",
    "replace-disconnect",
    "bot",
    "malformed-config",
  ]) {
    const f = await fixture();
    try {
      f.deferTaskFlush = true;
      await f.run();
      if (revoke === "grant") {
        f.app.store.run("DELETE FROM telegram_grants");
        f.app.store.run(
          "INSERT INTO telegram_grants VALUES (?,?,?)",
          "42",
          "42",
          f.id,
        );
      } else if (revoke === "mapping") {
        f.app.store.run("DELETE FROM telegram");
        f.app.store.run(
          "INSERT INTO telegram VALUES (?,?,?)",
          "42",
          f.id,
          "42",
        );
      } else {
        const next =
          revoke === "malformed-config"
            ? "not JSON"
            : JSON.stringify({
                ...f.config,
                ...(revoke === "bot"
                  ? { bot: { id: 777 } }
                  : { enabled: false }),
              });
        if (revoke === "replace-disconnect")
          f.app.store.run(
            "INSERT OR REPLACE INTO meta VALUES (?,?)",
            "telegram:connection",
            next,
          );
        else
          f.app.store.run(
            "UPDATE meta SET value=? WHERE key='telegram:connection'",
            next,
          );
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify(f.config),
        );
      }
      await f.reopen();
      await f.engine().flush();
      assert.equal(f.sent.length, 0, revoke);
      assert.equal(
        f.app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
        "cancelled",
      );
    } finally {
      await f.close();
    }
  }
});

test("task sender requires both allowlists and the validated bot identity immediately before sending", async () => {
  for (const overrides of [
    { users: ["99"] },
    { chats: ["99"] },
    { botId: 777 },
    { botId: null },
  ]) {
    const f = await fixture();
    try {
      f.deferTaskFlush = true;
      await f.run();
      await f.engine(overrides).flush();
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
        "cancelled",
      );
    } finally {
      await f.close();
    }
  }
});

test("a task retains its explicitly saved destination when Telegram selects another conversation", async () => {
  const f = await fixture();
  try {
    const other = await f.app.create("Outra conversa");
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      other,
    );
    f.app.store.run("UPDATE telegram SET conversationId=?", other);
    await f.run();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(
      f.app.store.get<{ state: string }>("SELECT state FROM task_notifications")
        ?.state,
      "queued",
    );
  } finally {
    await f.close();
  }
});

test("each long-message part rechecks authorization and revocation cancels the remaining parts", async () => {
  const f = await fixture("Resultado longo. ".repeat(1000));
  try {
    f.deferTaskFlush = true;
    await f.run();
    assert.ok(f.app.store.all("SELECT 1 FROM deliveries").length > 1);
    let sends = 0;
    const telegram = new Telegram(
      f.app,
      {
        send: async () => {
          sends++;
          f.app.store.run("DELETE FROM telegram_grants");
          return { message_id: 1 };
        },
      },
      ["42"],
      ["42"],
      "test_pi_bot",
      true,
      123456,
    );
    await telegram.flush();
    assert.equal(sends, 1);
    const states = f.app.store.all<{ state: string }>(
      "SELECT state FROM deliveries",
    );
    assert.equal(states.filter((d) => d.state === "sent").length, 1);
    assert.ok(states.slice(1).every((d) => d.state === "cancelled"));
    await telegram.drain();
    await f.reopen();
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_grants").length,
      0,
      "restart must not silently restore a removed grant",
    );
    await f.engine().flush();
    assert.equal(f.sent.length, 0);
  } finally {
    await f.close();
  }
});

test("terminal notification and request receipt roll back together; restart queues the persisted answer without a new model call", async () => {
  const f = await fixture();
  try {
    f.deferTaskFlush = true;
    f.app.store.db.exec(
      "CREATE TRIGGER fail_task_status BEFORE UPDATE OF status ON requests WHEN NEW.source='task' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END",
    );
    f.time = epoch + 60000;
    await f.tasks.tick();
    await (await f.app.conversation(f.id)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      f.app.store.get<{ status: string }>("SELECT status FROM requests")
        ?.status,
      "pending",
    );
    assert.equal(f.app.store.all("SELECT * FROM task_notifications").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
    const submission = f.app.store.get<{ submissionId: number }>(
      "SELECT submissionId FROM requests",
    )!.submissionId;
    f.app.store.db.exec("DROP TRIGGER fail_task_status");
    await f.reopen();
    f.deferTaskFlush = true;
    f.time = epoch + 60000;
    await f.tasks.tick();
    await (await f.app.conversation(f.id)).waitForIdle(context);
    for (let n = 0; n < 100; n++) {
      if (!f.app.store.get("SELECT 1 FROM requests WHERE status='pending'"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      f.app.store.all("SELECT 1 FROM requests WHERE status='pending'").length,
      0,
    );
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(
      f.app.store.get<{ submissionId: number }>(
        "SELECT submissionId FROM requests",
      )?.submissionId,
      submission,
    );
    assert.equal(f.app.store.all("SELECT * FROM task_notifications").length, 1);
  } finally {
    await f.close();
  }
});

test(
  "an interrupted model-pending cron resumes its admitted input and queues one terminal result",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.faux.setResponses([
      async (_transcript, options) => {
        started();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("Interrompido durante fechamento");
      },
    ]);
    try {
      f.time = epoch + 60000;
      await f.tasks.tick();
      await pending;
      const submission = f.app.store.get<{ submissionId: number }>(
        "SELECT submissionId FROM requests",
      )!.submissionId;
      assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
      const resumed = fauxProvider();
      resumed.setResponses([fauxAssistantMessage("Resultado retomado")]);
      await f.reopen(() => f.models.setProvider(resumed.provider));
      await f.run();
      await f.engine().flush();
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0]!.text, /Resultado retomado/);
      assert.equal(resumed.state.callCount, 1);
      assert.equal(f.app.store.all("SELECT * FROM requests").length, 1);
      assert.equal(
        f.app.store.get<{ submissionId: number }>(
          "SELECT submissionId FROM requests",
        )?.submissionId,
        submission,
      );
    } finally {
      await f.close();
    }
  },
);

test("admission failure sends a generic deduplicated notification without leaking the error", async () => {
  const f = await fixture();
  try {
    f.app.submit = async () => {
      throw new Error("private-secret-sentinel");
    };
    const run = await f.run();
    assert.equal(run.state, "failed");
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /não pôde iniciar/);
    assert.doesNotMatch(f.sent[0]!.text, /private-secret-sentinel/);
    await f.reopen();
    await f.tasks.tick();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test(
  "faulted execution sends only a generic terminal notification",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    f.faux.setResponses(
      Array.from({ length: 4 }, () => async () => {
        throw new Error("private-provider-secret-sentinel");
      }),
    );
    try {
      const run = await f.run();
      assert.equal(run.state, "failed");
      await f.engine().flush();
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0]!.text, /não foi concluída/);
      assert.doesNotMatch(f.sent[0]!.text, /private-provider-secret-sentinel/);
      await f.reopen();
      await f.tasks.tick();
      await f.engine().flush();
      assert.equal(f.sent.length, 1);
    } finally {
      await f.close();
    }
  },
);

test("a manual run respects delivery=none and posts nothing", async () => {
  const f = await fixture();
  try {
    const conversation = await f.app.create("Conversa manual silenciosa");
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversation,
    );
    f.app.store.run("UPDATE telegram SET conversationId=?", conversation);
    const task = await f.tasks.create({
      title: "Só efeitos colaterais",
      prompt: "Faça sem avisar",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: conversation,
      delivery: "none",
    });
    const run = await f.tasks.runNow(task.id);
    assert.equal(run.trigger, "manual");
    await (await f.app.conversation(conversation)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.engine().flush();
    // Same pipeline, same delivery rule: "none" means nothing is posted, not even a skip.
    assert.equal(f.sent.length, 0);
    assert.equal(
      f.app.store.get("SELECT 1 FROM task_notifications") ?? undefined,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("a scheduled run that produced nothing sends nothing", async () => {
  for (const answer of ["", "   \n\t ", "\u200b", "\ufeff\u200c\u200d\u200b"]) {
    const f = await fixture(answer);
    try {
      f.tasks.setDelivery(f.task.id, "web_telegram");
      const run = await f.run();
      await f.engine().flush();
      assert.equal(f.sent.length, 0, `nada enviado: ${JSON.stringify(answer)}`);
      assert.equal(
        f.app.store.all("SELECT 1 FROM deliveries").length,
        0,
        "nenhuma entrega registrada",
      );
      assert.equal(run.status, "silencioso", JSON.stringify(answer));
    } finally {
      await f.close();
    }
  }
});

test("an invisible mark beside real text still delivers the text", async () => {
  const f = await fixture("\u200b Resumo corporativo: 3 caixas sem novidade.");
  try {
    f.tasks.setDelivery(f.task.id, "web_telegram");
    await f.run();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /Resumo corporativo/);
    assert.match(f.sent[0]!.text, /3 caixas sem novidade/);
  } finally {
    await f.close();
  }
});

test("a scheduled run that only says there is nothing sends nothing", async () => {
  const f = await fixture("Nada relevante nas duas caixas.");
  try {
    f.tasks.setDelivery(f.task.id, "web_telegram");
    const run = await f.run();
    await f.engine().flush();
    assert.equal(f.sent.length, 0);
    assert.equal(run.status, "silencioso");
  } finally {
    await f.close();
  }
});

test("a real summary that mentions the phrase still reaches the chat", async () => {
  const f = await fixture(
    "Resumo das caixas:\n- 3 e-mails de clientes\n- nada relevante no corpo\n- release v1.2 saiu",
  );
  try {
    f.tasks.setDelivery(f.task.id, "web_telegram");
    await f.run();
    await f.engine().flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /release v1\.2/);
  } finally {
    await f.close();
  }
});

test("only a bare acknowledgement counts as nothing to report", () => {
  const silent = [
    "Nada relevante nas duas caixas.",
    "Nada relevante.",
    "nada relevante",
    "  Nada   relevante   nas   caixas  ",
    "Nenhuma release nas últimas 24h.",
    "Sem novidades.",
    "Nada a relatar.",
    "Caixas limpas.",
    "Nada exige ação.",
    "Nenhuma mensagem nova.",
    "Agenda livre.",
  ];
  for (const answer of silent)
    assert.equal(isNullAcknowledgement(answer), true, answer);
  const delivered = [
    "Resumo:\\n- 3 e-mails\\n- nada relevante no corpo\\n- release v1.2",
    "Nada relevante nas caixas. Mas o release v1.2 saiu e precisa de atenção.",
    `${"palavra ".repeat(40)}nada relevante`,
    "",
    "   ",
    "Falha ao consultar o provedor: HTTP 500",
    "Nada relevante nas caixas. Ação: revisar o release v1.2 antes de 18h.",
  ];
  for (const answer of delivered)
    assert.equal(isNullAcknowledgement(answer), false, answer);
});

test("task ok requires a durable delivery row, not a previous chat message id", async () => {
  const f = await fixture();
  try {
    const run = await f.run();
    assert.equal(run.status, "ok");
    assert.match(run.summary ?? "", /Resultado do cron/);
    assert.equal(
      taskOccurrenceDelivered(f.app.store, f.id, run.requestId),
      true,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM deliveries").length,
      1,
      "resumo veio da entrega desta execução, não de outro turno",
    );
  } finally {
    await f.close();
  }
});
