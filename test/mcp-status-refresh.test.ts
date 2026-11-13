import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";
import { Telegram, type TelegramUpdate } from "../src/telegram.js";
import {
  McpError,
  McpGateway,
  MCP_DISCOVERY_UNANSWERED,
  MCP_TIMEOUT_ERROR,
  mergeMcpDiscovery,
  mcpDiscoveryTimedOut,
  type McpCatalog,
} from "../src/mcp.js";

const AUTH_ERROR =
  "MCP refused authentication (HTTP 401). Verifique o token ou o método de login exigido pelo servidor.";

function serverCatalog(
  server: string,
  names: string[],
  extra: Partial<McpCatalog> = {},
): McpCatalog {
  return {
    server,
    mode: "direct",
    tools: names.map((name) => ({
      name,
      description: "http://secret.example/token",
      inputSchema: { type: "object" },
      operation: "direct" as const,
    })),
    ...extra,
  };
}

async function within(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work.then(() => "done" as const),
    new Promise<"slow">((resolve) => {
      timer = setTimeout(() => resolve("slow"), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  assert.equal(result, "done");
}

async function openStatus(deadline?: number) {
  const dir = await mkdtemp(join(tmpdir(), "pi-status-mcp-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  let now = 1_700_000_000_000;
  let calls = 0;
  let current: () => Promise<McpCatalog[]> = async () => [
    serverCatalog("executor", ["search", "call"]),
  ];
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = () => {
    calls += 1;
    return current();
  };
  const config = {
    token: "123:synthetic-test-token",
    users: ["42"],
    chats: ["-100123"],
  };
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    now: () => now,
    ...(deadline === undefined ? {} : { mcpDiscoveryDeadlineMs: deadline }),
    initialize: (store) =>
      configureTelegram(store, config, { id: 123, username: "test_bot" }),
  });
  const views: { text: string }[] = [];
  const bot = new Telegram(
    app,
    {
      send: async (_chat, text) => {
        views.push({ text });
        return { message_id: views.length };
      },
      editMessage: async () => true,
      answerCallback: async () => true,
    },
    config.users,
    config.chats,
    "test_bot",
    false,
    123,
  );
  let updateId = 1;
  const send = async (text: string) => {
    const id = updateId++;
    const update: TelegramUpdate = {
      update_id: id,
      message: {
        message_id: id,
        date: 1,
        text,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
      },
    };
    await bot.receive(update);
    await bot.flush();
  };
  return {
    app,
    views,
    send,
    calls: () => calls,
    setCatalog: (fn: () => Promise<McpCatalog[]>) => {
      current = fn;
    },
    age: () => {
      now += Runtime.MCP_STATUS_TTL_MS;
    },
    close: async () => {
      await bot.drain();
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("mcp discovery timeout is the sanitized sentence, not the upstream text", async () => {
  assert.equal(
    mcpDiscoveryTimedOut(
      Object.assign(new Error("http://secret.example/token"), {
        name: "TimeoutError",
      }),
    ),
    true,
  );
  assert.equal(mcpDiscoveryTimedOut({ code: -32001 }), true);
  assert.equal(mcpDiscoveryTimedOut(new McpError(AUTH_ERROR)), false);
  assert.equal(mcpDiscoveryTimedOut(new Error("conexão recusada")), false);
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  try {
    gateway.discover = async () => {
      throw Object.assign(
        new Error("timed out at http://secret.example/token"),
        {
          name: "TimeoutError",
        },
      );
    };
    const [timedOut] = await gateway.catalog();
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.error, MCP_TIMEOUT_ERROR);
    assert.doesNotMatch(timedOut.error ?? "", /secret\.example/);
    gateway.discover = async () => {
      throw new Error("http://secret.example/token");
    };
    const [failed] = await gateway.catalog();
    assert.equal(failed.timedOut, undefined);
    assert.equal(failed.error, "Could not discover MCP tools");
    assert.doesNotMatch(failed.error ?? "", /secret/);
  } finally {
    await gateway.close();
  }
});

test("mergeMcpDiscovery keeps a timed-out server and applies one that answered", () => {
  const kept = serverCatalog("executor", ["search", "call"]);
  const previousOther = serverCatalog("other", ["read"]);
  const answered = serverCatalog("other", ["write"]);
  const merged = mergeMcpDiscovery(
    [kept, previousOther],
    [
      serverCatalog("executor", [], {
        error: MCP_TIMEOUT_ERROR,
        timedOut: true,
      }),
      answered,
    ],
  );
  assert.equal(merged.unanswered, true);
  assert.equal(merged.changed, true);
  assert.equal(merged.catalog[0], kept);
  assert.equal(merged.catalog[1], answered);

  const failed = serverCatalog("executor", [], {
    error: MCP_TIMEOUT_ERROR,
    timedOut: true,
  });
  const fresh = mergeMcpDiscovery([], [failed]);
  assert.equal(fresh.unanswered, false);
  assert.equal(fresh.catalog[0], failed);
});

test("/status returns the cached MCP snapshot without waiting for rediscovery", async () => {
  const f = await openStatus();
  let release: (value: McpCatalog[]) => void = () => {};
  const hung = new Promise<McpCatalog[]>((resolve) => {
    release = resolve;
  });
  try {
    const before = f.calls();
    f.setCatalog(() => hung);
    f.age();
    await within(f.send("/status"), 3000);
    const text = f.views.at(-1)!.text;
    assert.match(text, /executor: connected — 2 tool\(s\) \(search, call\)/);
    assert.doesNotMatch(text, /secret\.example/);
    assert.doesNotMatch(text, /não respondeu/);
    assert.equal(f.calls(), before + 1);
    const inflight = f.calls();
    await within(f.send("/status"), 3000);
    assert.equal(f.calls(), inflight);
    assert.match(f.views.at(-1)!.text, /search, call/);
    await f.send("olá");
    assert.equal(f.calls(), inflight);
  } finally {
    release([serverCatalog("executor", ["search", "call"])]);
    await f.close();
  }
});

test("/status does not rediscover a fresh healthy snapshot", async () => {
  const f = await openStatus();
  try {
    const before = f.calls();
    f.setCatalog(() => {
      throw new Error("rediscovery should not start");
    });
    await f.send("/status");
    assert.equal(f.calls(), before);
    assert.match(f.views.at(-1)!.text, /search, call/);
    assert.doesNotMatch(f.views.at(-1)!.text, /não respondeu/);
  } finally {
    await f.close();
  }
});

test("/status shows a stored MCP error without waiting to rediscover", async () => {
  const f = await openStatus();
  let release: (value: McpCatalog[]) => void = () => {};
  const hung = new Promise<McpCatalog[]>((resolve) => {
    release = resolve;
  });
  try {
    f.app.mcpStatus = [serverCatalog("executor", [], { error: AUTH_ERROR })];
    f.setCatalog(() => hung);
    const before = f.calls();
    await within(f.send("/status"), 3000);
    const text = f.views.at(-1)!.text;
    assert.match(
      text,
      /executor: unavailable — MCP refused authentication \(HTTP 401\)/,
    );
    assert.doesNotMatch(text, /search, call/);
    assert.doesNotMatch(text, /secret\.example/);
    assert.equal(f.calls(), before + 1);
  } finally {
    release([serverCatalog("executor", ["search"])]);
    await f.close();
  }
});

test("a timed-out rediscovery keeps the previous snapshot for the next /status", async () => {
  const f = await openStatus();
  try {
    f.age();
    f.setCatalog(async () => [
      serverCatalog("executor", [], {
        error: MCP_TIMEOUT_ERROR,
        timedOut: true,
      }),
    ]);
    const before = f.calls();
    await f.send("/status");
    assert.match(f.views.at(-1)!.text, /search, call/);
    assert.doesNotMatch(f.views.at(-1)!.text, /não respondeu/);
    assert.equal(f.calls(), before + 1);
    assert.deepEqual(
      f.app.mcpStatus[0]?.tools.map((tool) => tool.name),
      ["search", "call"],
    );
    const settled = f.calls();
    await f.send("/status");
    const text = f.views.at(-1)!.text;
    assert.match(text, /search, call/);
    assert.doesNotMatch(text, /Discovery did not answer/);
    assert.equal(f.calls(), settled);
  } finally {
    await f.close();
  }
});

test("a rediscovery that throws keeps the previous snapshot and hides the cause", async () => {
  const f = await openStatus();
  try {
    f.age();
    f.setCatalog(async () => {
      throw new Error("http://secret.example/token");
    });
    await f.send("/status");
    assert.match(f.views.at(-1)!.text, /search, call/);
    assert.doesNotMatch(f.views.at(-1)!.text, /não respondeu/);
    const settled = f.calls();
    await f.send("/status");
    const text = f.views.at(-1)!.text;
    assert.match(text, /search, call/);
    assert.doesNotMatch(text, /Discovery did not answer/);
    assert.doesNotMatch(text, /secret\.example/);
    assert.equal(f.calls(), settled);
  } finally {
    await f.close();
  }
});

test("a rediscovery that answers with an error replaces the MCP snapshot", async () => {
  const f = await openStatus();
  try {
    f.age();
    f.setCatalog(async () => [
      serverCatalog("executor", [], { error: AUTH_ERROR }),
    ]);
    await f.send("/status");
    assert.match(f.views.at(-1)!.text, /search, call/);
    await f.send("/status");
    const text = f.views.at(-1)!.text;
    assert.match(text, /unavailable — MCP refused authentication \(HTTP 401\)/);
    assert.doesNotMatch(text, /search, call/);
    assert.doesNotMatch(text, /não respondeu/);
  } finally {
    await f.close();
  }
});

test("a slow rediscovery is reported on the next /status and a later success converges quietly", async () => {
  const f = await openStatus(40);
  let release: (value: McpCatalog[]) => void = () => {};
  const hung = new Promise<McpCatalog[]>((resolve) => {
    release = resolve;
  });
  try {
    f.age();
    f.setCatalog(() => hung);
    await f.send("/status");
    assert.doesNotMatch(f.views.at(-1)!.text, /não respondeu/);
    assert.match(f.views.at(-1)!.text, /search, call/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const before = f.views.length;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await f.send("/status");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(f.views.length, before + 1);
    assert.match(f.views.at(-1)!.text, /search, call/);
    assert.doesNotMatch(f.views.at(-1)!.text, /Discovery did not answer/);
    assert.ok(warnings.some((line) => line.includes(MCP_DISCOVERY_UNANSWERED)));
    release([serverCatalog("executor", ["describe", "execute"])]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      f.app.mcpStatus[0]?.tools.map((tool) => tool.name),
      ["describe", "execute"],
    );
    const views = f.views.length;
    await f.send("/status");
    assert.equal(f.views.length, views + 1);
    assert.match(f.views.at(-1)!.text, /describe, execute/);
    assert.doesNotMatch(f.views.at(-1)!.text, /não respondeu/);
  } finally {
    release([serverCatalog("executor", ["search", "call"])]);
    await f.close();
  }
});
