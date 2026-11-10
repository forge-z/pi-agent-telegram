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
import { runNotified } from "../src/task-telegram.js";
import { Tasks } from "../src/tasks.js";
import { Telegram } from "../src/telegram.js";

const TOOL = "tools.example.jobs.start";
const MANIFEST = {
  tool: TOOL,
  server: "executor",
  dispatch: { mode: "immediate", idPath: "id" },
  observe: {
    mode: "poll",
    tool: "tools.example.jobs.get",
    args: {
      accountId: "acc-test",
      input: { path: { id: "${job_id}" } },
    },
    statePath: "status",
    resultPath: "result",
    errorPath: "error",
  },
  poll: { intervalSeconds: 1, backoff: [1], maxAttempts: 3 },
  graceMinutes: 5,
};
const epoch = Date.parse("2026-10-08T12:00:00Z");
const THREAD = 11;

function executorOk(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

async function open() {
  const dir = await mkdtemp(join(tmpdir(), "pi-job-notify-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = {
    catalog: async () => [],
    callDirect: async () =>
      executorOk({
        status: "COMPLETED",
        result: { summary: "terminou" },
      }),
  };
  const app = await Runtime.open({
    dir,
    models,
    env: { ASYNC_JOB_MANIFESTS: JSON.stringify([MANIFEST]) },
    gateway,
  });
  const id = await app.create("Tópico do job");
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ token: "123456:fake-local-only", botId: 123456 }),
  );
  app.store.run(
    "INSERT INTO telegram_topic_conversations VALUES (?,?)",
    id,
    THREAD,
  );
  app.store.run("INSERT INTO telegram VALUES (?,?,?)", "42", id, "42");
  app.store.run("INSERT INTO telegram_grants VALUES (?,?,?)", "42", "42", id);
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:connection",
    JSON.stringify({
      enabled: true,
      bot: { id: 123456 },
      userId: "42",
      chatId: "42",
      conversationId: id,
    }),
  );
  const sent: Array<{ chat: string; text: string; thread?: number }> = [];
  const transport = {
    send: async (
      chat: string,
      text: string,
      options?: { messageThreadId?: number },
    ) => {
      sent.push({ chat, text, thread: options?.messageThreadId });
      return { message_id: 700 + sent.length };
    },
  };
  const engine = () =>
    new Telegram(app, transport, ["42"], ["42"], "test_pi_bot", true, 123456);
  app.flushTelegramPending = async () => {
    await engine().flush();
  };
  let now = epoch;
  const tasks = new Tasks(app, () => now);
  return {
    app,
    faux,
    id,
    sent,
    tasks,
    engine,
    set time(value: number) {
      now = value;
    },
    async settle() {
      await (await app.conversation(id)).waitForIdle(context);
      for (let n = 0; n < 100; n++) {
        if (!app.store.get("SELECT 1 FROM requests WHERE status='pending'"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      await tasks.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function register(
  app: Runtime,
  conversationId: string,
  runId: string,
  goal: string,
) {
  const opened = app.pendingJobs.registerKnown(
    conversationId,
    TOOL,
    runId,
    goal,
    "acc-test",
  );
  if (!opened) throw new Error("job não registrado");
}

test("a user-dispatched job completion is delivered to the originating chat and thread", async () => {
  const f = await open();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  f.faux.setResponses([
    async () => {
      register(f.app, f.id, "cj-user-1", "implementar o ajuste");
      return fauxAssistantMessage("Disparei. Aviso quando terminar.");
    },
    async () =>
      fauxAssistantMessage(
        "Tarefa pronta. https://github.com/example/app/pull/12",
      ),
  ]);
  try {
    await f.app.admit(f.id, "telegram:dispara", "dispara a tarefa", {
      source: "telegram",
      chat: "42",
      user: "42",
    });
    await f.settle();
    assert.equal(
      f.app.store.get<{ origin_source: string }>(
        "SELECT origin_source FROM pending_jobs",
      )?.origin_source,
      "telegram",
    );
    await f.app.pendingJobs.tick();
    await f.settle();
    await f.engine().flush();
    const completion = f.sent.filter((row) => /Tarefa pronta/.test(row.text));
    assert.equal(completion.length, 1, JSON.stringify(f.sent));
    assert.equal(completion[0]!.chat, "42");
    assert.equal(completion[0]!.thread, THREAD);
    const requestId = f.app.store.get<{ requestId: string }>(
      "SELECT requestId FROM requests WHERE source='job'",
    )?.requestId;
    assert.ok(requestId);
    assert.equal(runNotified(f.app.store, f.id, requestId), true);
    const logged = lines.find(
      (line) => line.includes("run agendado") && line.includes(requestId),
    );
    assert.ok(logged, JSON.stringify(lines));
    assert.match(logged, /notify=sim/);
  } finally {
    console.log = log;
    await f.close();
  }
});

test("a scheduled routine with no news stays silent", async () => {
  const f = await open();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  f.faux.setResponses([
    async () => {
      register(f.app, f.id, "mail-1", "verificar email");
      return fauxAssistantMessage("Nada de novo nas caixas.");
    },
    async () => fauxAssistantMessage("Nenhum email novo."),
  ]);
  try {
    const task = await f.tasks.create({
      title: "Email",
      prompt: "Verifique o email. Se não houver nada novo, não avise.",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: f.id,
      delivery: "web_telegram",
    });
    f.time = epoch + 60_000;
    await f.tasks.tick();
    await f.settle();
    await f.engine().flush();
    assert.equal(f.sent.length, 0, JSON.stringify(f.sent));
    assert.equal(
      f.app.store.get<{ origin_source: string }>(
        "SELECT origin_source FROM pending_jobs",
      )?.origin_source,
      "task",
    );
    await f.app.pendingJobs.tick();
    await f.settle();
    await f.engine().flush();
    assert.equal(f.sent.length, 0, JSON.stringify(f.sent));
    assert.equal(f.app.store.all("SELECT 1 FROM deliveries").length, 0);
    const job = f.app.store.get<{ requestId: string; status: string }>(
      "SELECT requestId,status FROM requests WHERE source='job'",
    );
    assert.equal(job?.status, "done");
    const logged = lines.filter((line) => line.includes("run agendado"));
    assert.ok(logged.length >= 2, JSON.stringify(lines));
    for (const line of logged) assert.match(line, /notify=não/);
    assert.ok(logged.some((line) => line.includes(job!.requestId)));
    assert.equal(f.tasks.runs(task.id)[0]?.status, "silencioso");
  } finally {
    console.log = log;
    await f.close();
  }
});
