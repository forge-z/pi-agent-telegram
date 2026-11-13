import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Store } from "../src/store.js";
import {
  McpCalls,
  mcpCallIsReadOnly,
  refusedBeforeDispatch,
} from "../src/mcp-calls.js";
import type { McpGateway } from "../src/mcp.js";
import { PolicyError } from "../src/mcp.js";
import { PendingJobs } from "../src/pending-jobs.js";
import { retryableError, Runtime } from "../src/runtime.js";
import { assertAppPurgeSafe } from "../src/conversation-trash.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramApi } from "../src/telegram-api.js";
import type { TelegramUpdate } from "../src/telegram.js";

const DAY = 24 * 60 * 60 * 1000;

function gateway(callDirect: McpGateway["callDirect"]): McpGateway {
  return {
    assertDirect() {},
    connectionBinding: async () => "binding",
    credentialBinding: () => "binding",
    releaseSession() {},
    callDirect,
  } as unknown as McpGateway;
}

async function dir() {
  return mkdtemp(join(tmpdir(), "pi-simplify-"));
}

test("name-based reads and known paths stay reads, including batches", () => {
  assert.equal(mcpCallIsReadOnly("tools.instabox.machines.list"), true);
  assert.equal(mcpCallIsReadOnly("tools.github.repos.get_or_create"), true);
  assert.equal(mcpCallIsReadOnly("tools.call"), false);
  assert.equal(mcpCallIsReadOnly("resume"), false);
  assert.equal(
    mcpCallIsReadOnly("call", {
      body: {
        calls: [
          { path: "tools.instabox.machines.list" },
          { path: "tools.tinyfish.fetch.root.fetchUrls" },
        ],
      },
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("execute", {
      code: "await tools.tinyfish.fetch.root.fetchUrls({}); await tools.instabox.machines.list({})",
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("call", {
      body: {
        calls: [
          { path: "tools.instabox.machines.list" },
          { path: "tools.instabox.machines.exec" },
        ],
      },
    }),
    false,
  );
  assert.equal(mcpCallIsReadOnly("execute", { code: "return 1" }), false);
  // The target is the tool path. A parameter named path is not another tool.
  assert.equal(
    mcpCallIsReadOnly("call", {
      nonce: 1,
      calls: {
        path: "tools.instabox.machines.readFiles",
        input: { input: { id: "m", path: "/data/status.json" } },
      },
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("call", {
      calls: {
        path: "tools.instabox.machines.exec",
        input: { input: { cmd: "cat status", timeoutSeconds: 400 } },
      },
    }),
    false,
  );
  assert.equal(
    mcpCallIsReadOnly("call", {
      calls: {
        path: "tools.agenda.criar_evento",
        input: { input: { titulo: "amanha" } },
      },
    }),
    false,
  );
  // The outer tool's readOnlyHint does not paint an inner write as a read.
  assert.equal(
    mcpCallIsReadOnly(
      "call",
      { calls: { path: "tools.agenda.criar_evento", input: {} } },
      { server: "executor", readOnlyHint: true },
    ),
    false,
  );
});

test("a read delegated through call times out without blocking the server", async () => {
  const previous = process.env.MCP_CALL_TIMEOUT_MS;
  process.env.MCP_CALL_TIMEOUT_MS = "800";
  const root = await dir();
  const store = new Store(root);
  let release = () => {};
  const hung = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = new McpCalls(
    store,
    gateway(async (_server, tool) => {
      if (tool === "call") {
        await hung;
        return { content: [{ type: "text", text: "late" }] };
      }
      return { content: [{ type: "text", text: "next" }] };
    }),
  );
  try {
    const failure = await calls
      .execute("c", 1, "executor", "call", {
        nonce: "outer",
        calls: {
          path: "tools.instabox.machines.readFiles",
          input: {
            accountId: "acc",
            input: { id: "m", path: "/data/home/jobs/x/status.json" },
          },
        },
      })
      .then(
        () => "passou",
        (error: Error) => error.message,
      );
    assert.match(failure, /estourou o prazo de 1s/);
    assert.match(failure, /sandbox_code_task/);
    assert.doesNotMatch(failure, /incerto/i);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE tool='call'",
      )?.state,
      "failed",
    );
    assert.equal(
      store.get<{ total: number }>(
        "SELECT count(*) AS total FROM mcp_calls WHERE state='uncertain'",
      )?.total,
      0,
    );
    const next = await calls.execute("c", 2, "executor", "execute", {
      code: "await tools.agenda.criar_evento({})",
    });
    assert.match(JSON.stringify(next), /next/);
  } finally {
    release();
    if (previous === undefined) delete process.env.MCP_CALL_TIMEOUT_MS;
    else process.env.MCP_CALL_TIMEOUT_MS = previous;
    await calls.close();
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("InputInvalid or UnknownTool without a successful toolCall is a plain failure", () => {
  const rejected = {
    isError: true,
    code: "InputInvalid",
    toolCalls: [{ outcome: "failure" }],
    mayHaveExecuted: true,
    mayHaveEffects: true,
  };
  assert.equal(refusedBeforeDispatch(rejected), true);
  assert.equal(
    refusedBeforeDispatch({
      status: 422,
      message: "Input failed validation",
      toolCalls: [],
    }),
    true,
  );
  assert.equal(
    refusedBeforeDispatch({
      response: { code: "UnknownTool", message: "No tool at tools.missing" },
      toolCalls: [{ outcome: "failure" }],
    }),
    true,
  );
  assert.equal(
    refusedBeforeDispatch({
      code: "InputInvalid",
      toolCalls: [{ outcome: "success", result: { ok: true } }],
    }),
    false,
  );
  assert.equal(
    refusedBeforeDispatch({ isError: true, message: "timeout" }),
    false,
  );
});

test("validation rejection and a returned write error both fail closed; only a lost result stays uncertain", async () => {
  const root = await dir();
  const store = new Store(root);
  const seen: string[] = [];
  const calls = new McpCalls(
    store,
    gateway(async (_server, tool, args) => {
      seen.push(tool);
      if (args.fail === "validation")
        return {
          content: [{ type: "text", text: "no" }],
          isError: true,
          code: "InputInvalid",
          toolCalls: [{ outcome: "failure" }],
        };
      if (args.fail === "boom")
        return {
          content: [{ type: "text", text: "boom" }],
          isError: true,
        };
      return { content: [{ type: "text", text: "ok" }] };
    }),
  );
  try {
    await assert.rejects(
      calls.execute("c", 1, "executor", "resume", { requestId: "x" }),
      (error: Error) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /decisão humana/);
        return true;
      },
    );
    assert.deepEqual(seen, []);

    const rejected = await calls.execute("c", 2, "executor", "execute", {
      fail: "validation",
      code: "await tools.call({})",
    });
    assert.equal(rejected.isError, true);
    assert.match(
      JSON.stringify(rejected.content),
      /antes de qualquer despacho/,
    );
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE tool='execute' AND id LIKE '%' AND conversationId='c' ORDER BY updatedAt DESC",
      )?.state,
      "failed",
    );

    const boom = await calls.execute("c", 3, "executor", "execute", {
      fail: "boom",
      code: "await tools.call({})",
    });
    assert.equal(boom.isError, true);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE conversationId=? AND server=? AND tool='execute' ORDER BY updatedAt DESC",
        "c",
        "executor",
      )?.state,
      "failed",
    );
    assert.equal(
      store.get<{ total: number }>(
        "SELECT count(*) AS total FROM mcp_calls WHERE conversationId='c' AND state='uncertain'",
      )?.total,
      0,
    );
    // A returned error does not block the next write. The model can continue.
    await calls.execute("c", 4, "executor", "execute", {
      code: "await tools.call({})",
    });

    const read = await calls.execute(
      "c",
      5,
      "executor",
      "tools.instabox.machines.list",
      {},
    );
    assert.equal(read.isError, undefined);

    store.run(
      "INSERT INTO mcp_calls VALUES ('lost','c','executor','execute','{}','uncertain',NULL,'binding',0)",
    );
    await calls.execute("c", 6, "other", "execute", {
      code: "await tools.call({})",
    });
    await assert.rejects(
      calls.execute("c", 7, "executor", "execute", {
        code: "await tools.call({})",
      }),
      /neste servidor/,
    );
    assert.equal(calls.clearUncertain("c"), 1);
    await calls.execute("c", 8, "executor", "execute", {
      code: "await tools.call({})",
    });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("boot drops mcp-stage rows and reclassifies a running read and a running write", async () => {
  const root = await dir();
  const store = new Store(root);
  store.db.exec(`CREATE TABLE mcp_calls(
    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL,
    tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
    binding TEXT NOT NULL, updatedAt INTEGER NOT NULL)`);
  const insert = store.db.prepare(
    "INSERT INTO mcp_calls VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "mcp-stage:1",
    "c",
    "executor",
    "execute",
    "{}",
    "paused",
    null,
    "b",
    1,
  );
  insert.run("read-1", "c", "executor", "list", "{}", "running", null, "b", 1);
  insert.run(
    "write-1",
    "c",
    "executor",
    "execute",
    JSON.stringify({ code: "await tools.call({})" }),
    "running",
    null,
    "b",
    1,
  );
  new McpCalls(
    store,
    gateway(async () => ({ content: [] })),
  );
  try {
    assert.equal(
      store.get("SELECT 1 FROM mcp_calls WHERE id LIKE 'mcp-stage:%'"),
      undefined,
    );
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id='read-1'",
      )?.state,
      "failed",
    );
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id='write-1'",
      )?.state,
      "uncertain",
    );
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function jobsOn(store: Store) {
  return new PendingJobs(
    {
      store,
      options: { gateway: { callDirect: async () => ({}) } },
      submit: async () => "sent",
    } as unknown as Runtime,
    {},
  );
}

test("fresh database grows the two counters and prunes only old finished rows", async () => {
  const root = await dir();
  const store = new Store(root);
  const jobs = jobsOn(store);
  try {
    jobs.health();
    const names = store
      .all<{ name: string }>("PRAGMA table_info(pending_jobs)")
      .map((column) => column.name);
    assert.ok(names.includes("poll_attempts"));
    assert.ok(names.includes("delivery_attempts"));
    assert.equal(jobs.health().open_rows, 0);
    assert.equal(jobs.health().last_tick_error, undefined);

    const now = Date.now();
    store.run(
      `INSERT INTO pending_jobs(integration,tool,conversation_id,created_at,delivered_at,poll_attempts,delivery_attempts)
       VALUES ('s','t','c',?,?,1,1)`,
      now,
      now - 31 * DAY,
    );
    store.run(
      `INSERT INTO pending_jobs(integration,tool,conversation_id,created_at,delivered_at)
       VALUES ('s','t','c',?,?)`,
      now,
      now - DAY,
    );
    store.run(
      `INSERT INTO pending_jobs(integration,tool,conversation_id,created_at,next_poll_at)
       VALUES ('s','t','c',?,?)`,
      now,
      now + DAY,
    );
    await jobs.tick();
    const left = store.all<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs ORDER BY id",
    );
    assert.deepEqual(
      left.map((row) => row.delivered_at == null),
      [false, true],
    );
    (
      jobs as unknown as { noteTickFailure(error: unknown): void }
    ).noteTickFailure(new Error("database is locked"));
    await jobs.tick();
    assert.match(
      jobs.health().last_tick_error?.message ?? "",
      /database is locked/,
    );
  } finally {
    jobs.close();
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a database already migrated with holds returns to normal polling", async () => {
  const root = await dir();
  const db = new DatabaseSync(join(root, "app.sqlite"));
  db.exec(`
    CREATE TABLE pending_jobs(
      id INTEGER PRIMARY KEY, integration TEXT NOT NULL, tool TEXT NOT NULL,
      run_id TEXT, goal TEXT, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      delivered_at INTEGER, notified_at INTEGER, outcome TEXT, result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0,
      job_state TEXT, last_error TEXT, poll_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_attempts INTEGER NOT NULL DEFAULT 0, delivery_blocked TEXT,
      submission_inflight TEXT, delivery_prompt TEXT);
  `);
  const insert = db.prepare(
    `INSERT INTO pending_jobs(id,integration,tool,conversation_id,created_at,delivered_at,attempts,poll_attempts,delivery_attempts,delivery_blocked)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(1, "s", "t", "conv", 1, null, 5, 1, 4, "legacy_attempts_unknown");
  insert.run(2, "s", "t", "conv", 1, null, 3, 3, 2, "submission_inflight");
  insert.run(3, "s", "t", "conv", 1, 50, 1, 1, 1, "delivery_unconfirmed");
  db.close();
  const store = new Store(root);
  const jobs = jobsOn(store);
  try {
    jobs.health();
    const rows = store.all<{
      id: number;
      poll_attempts: number;
      delivery_attempts: number;
      attempts: number;
      delivery_blocked: string | null;
    }>(
      "SELECT id,poll_attempts,delivery_attempts,attempts,delivery_blocked FROM pending_jobs ORDER BY id",
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          id: 1,
          poll_attempts: 5,
          delivery_attempts: 0,
          attempts: 5,
          delivery_blocked: null,
        },
        {
          id: 2,
          poll_attempts: 3,
          delivery_attempts: 0,
          attempts: 3,
          delivery_blocked: null,
        },
        {
          id: 3,
          poll_attempts: 1,
          delivery_attempts: 0,
          attempts: 1,
          delivery_blocked: null,
        },
      ],
    );
    store.run(
      "UPDATE pending_jobs SET delivery_attempts=2, poll_attempts=9 WHERE id=2",
    );
    jobs.health();
    const kept = store.get<{
      poll_attempts: number;
      delivery_attempts: number;
    }>("SELECT poll_attempts, delivery_attempts FROM pending_jobs WHERE id=2");
    assert.equal(kept?.poll_attempts, 9);
    assert.equal(kept?.delivery_attempts, 2);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        conversationId TEXT NOT NULL, kind TEXT NOT NULL, schedule TEXT NOT NULL,
        timezone TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, scheduledAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', requestId TEXT NOT NULL UNIQUE);
    `);
    assert.doesNotThrow(() => assertAppPurgeSafe(store, "conv"));
  } finally {
    jobs.close();
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

const telegramConfig = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};

test("polling drops stored journals without moving the offset or replaying them", async () => {
  const root = await dir();
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const app = await Runtime.open({
    dir: root,
    models,
    gateway: { catalog: async () => [] },
    initialize: (store) =>
      configureTelegram(store, telegramConfig, { id: 123 }),
  });
  app.tasks.start = () => {};
  app.store.run("INSERT INTO meta VALUES (?,?)", "telegram:offset:123", "10");
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:polling:123:10",
    JSON.stringify({ text: "secret message that must not stay" }),
  );
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:journal-offset:123",
    "99",
  );
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:update-identity:123:10",
    "hash",
  );
  const received: number[] = [];
  const sent: string[] = [];
  let polls = 0;
  const api: TelegramApi = {
    call: async (method, payload, signal) => {
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "setMyCommands") return true;
      if (method === "sendMessage") {
        sent.push(String((payload as { text?: string }).text));
        return { ok: true };
      }
      if (method === "getUpdates") {
        polls++;
        if (polls === 1) {
          assert.equal(
            app.store.get(
              "SELECT 1 FROM meta WHERE key GLOB 'telegram:polling:*'",
            ),
            undefined,
          );
          assert.equal(
            app.store.get<{ value: string }>(
              "SELECT value FROM meta WHERE key='telegram:offset:123'",
            )?.value,
            "10",
          );
          return [message(10, 1), message(11, 2), message(12, 2)];
        }
        // Offset did not advance, so Telegram redelivers the transient update.
        if (received.filter((id) => id === 10).length < 2)
          return [message(10, 1)];
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("closed")));
        });
        return [];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const polling = new TelegramPolling(app, api, telegramConfig, { id: 123 });
  polling.engine.receive = async (update) => {
    received.push(update.update_id);
    if (update.update_id === 10)
      throw retryableError(new Error("provider connecting"));
    if (update.update_id === 11) throw new Error("boom");
  };
  try {
    polling.start();
    for (let n = 0; n < 200 && received.length < 3; n++)
      await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(received, [10, 11, 12]);
    assert.ok(sent.some((text) => text.includes("boom")));
    assert.equal(
      app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key='telegram:offset:123'",
      )?.value,
      "10",
    );
    const stored = app.store
      .all<{ value: string }>("SELECT value FROM meta")
      .map((row) => row.value)
      .join("\n");
    assert.doesNotMatch(stored, /secret message/);
    for (
      let n = 0;
      n < 40 && received.filter((id) => id === 10).length < 2;
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.filter((id) => id === 10).length, 2);
    assert.equal(received.filter((id) => id === 11).length, 1);
  } finally {
    await polling.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

function message(updateId: number, thread: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      message_thread_id: thread,
      text: `hello ${updateId}`,
      from: { id: 42 },
      chat: { id: -100123, type: "supergroup" },
    },
  };
}
