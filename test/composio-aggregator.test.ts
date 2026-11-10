import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readConfig } from "../src/config.js";
import { authRedirects } from "../src/executor-result.js";
import { mcpCallIsReadOnly } from "../src/mcp-calls.js";
import {
  McpGateway,
  McpUrlElicitationRequiredError,
  type McpConfig,
} from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";
import {
  parseAggregatorChoice,
  readHiddenSecret,
  readStoredAggregators,
  writeStoredAggregators,
  type AggregatorRecord,
} from "../src/setup.js";

const telegram = {
  TELEGRAM_BOT_TOKEN: "123:mock",
  TELEGRAM_ALLOWED_USERS: "42",
};

function volume(
  record: AggregatorRecord,
  keys: { executor?: string; composio?: string } = {},
) {
  return mkdtemp(join(tmpdir(), "pi-aggregators-")).then((dir) => {
    const db = new DatabaseSync(join(dir, "app.sqlite"));
    try {
      writeStoredAggregators(db, record, keys);
    } finally {
      db.close();
    }
    return dir;
  });
}

test("setup stores the aggregator choice and keeps the key out of meta", async () => {
  const dir = await volume(
    {
      choice: "both",
      executor: { url: "https://executor.example/mcp" },
      composio: { url: "https://connect.composio.dev/mcp", userId: "user_1" },
    },
    { executor: "executor-secret", composio: "ck_composio_secret" },
  );
  const stored = readStoredAggregators(dir);
  assert.equal(stored.record?.choice, "both");
  assert.equal(stored.executorToken, "executor-secret");
  assert.equal(stored.composioKey, "ck_composio_secret");
  assert.equal(parseAggregatorChoice("3"), "both");
  assert.equal(parseAggregatorChoice("nenhum"), "none");
  const db = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key='aggregators:live'")
      .get() as { value: string };
    assert.equal(row.value.includes("ck_composio_secret"), false);
    assert.equal(row.value.includes("executor-secret"), false);
  } finally {
    db.close();
  }
});

test("volume Composio and env Executor can run together; env overrides a field", async () => {
  const dir = await volume(
    {
      choice: "composio",
      composio: {
        url: "https://mcp.composio.dev/srv",
        userId: "user_from_volume",
      },
    },
    { composio: "ak_volume" },
  );
  const stored = readStoredAggregators(dir);
  const both = readConfig(
    {
      ...telegram,
      EXECUTOR_MCP_URL: "https://executor.example/mcp",
      EXECUTOR_TOKEN: "executor-env",
      COMPOSIO_USER_ID: "user_from_env",
    },
    stored,
  ).mcp;
  assert.deepEqual(
    both.map((server) => server.name),
    ["executor", "composio"],
  );
  const composio = both.find((server) => server.name === "composio");
  assert.equal(composio?.url, "https://mcp.composio.dev/srv");
  assert.equal(composio?.token, "ak_volume");
  assert.equal(composio?.tokenHeader, "x-api-key");
  assert.equal(composio?.userId, "user_from_env");
  assert.equal(both[0]?.tokenHeader, undefined);

  const connect = readConfig(
    {
      ...telegram,
      COMPOSIO_MCP_URL: "https://connect.composio.dev/mcp",
    },
    stored,
  ).mcp.find((server) => server.name === "composio");
  assert.equal(connect?.tokenHeader, "x-consumer-api-key");
  assert.equal(connect?.userId, undefined);

  assert.throws(
    () =>
      readConfig(
        {
          ...telegram,
          COMPOSIO_MCP_URL: "https://mcp.composio.dev/other",
          COMPOSIO_USER_ID: "",
        },
        {
          record: {
            choice: "composio",
            composio: { url: "https://mcp.composio.dev/other", userId: "" },
          },
          composioKey: "ak_volume",
        },
      ),
    /COMPOSIO_USER_ID/,
  );
});

test("MCP_SERVERS_JSON still replaces the volume list", async () => {
  const stored = readStoredAggregators(
    await volume(
      {
        choice: "composio",
        composio: { url: "https://connect.composio.dev/mcp", userId: "user_1" },
      },
      { composio: "ck_volume" },
    ),
  );
  const mcp = readConfig(
    {
      ...telegram,
      MCP_SERVERS_JSON:
        '[{"name":"executor","url":"https://override.example/mcp","tokenEnv":"EXECUTOR_TOKEN"}]',
      EXECUTOR_TOKEN: "from-env",
    },
    stored,
  ).mcp;
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0]?.name, "executor");
  assert.equal(mcp[0]?.url, "https://override.example/mcp");
});

test("a choice of none stays empty unless an env pair is complete", async () => {
  const dir = await volume(
    {
      choice: "both",
      executor: { url: "https://executor.example/mcp" },
      composio: { url: "https://connect.composio.dev/mcp", userId: "user_1" },
    },
    { executor: "old-executor", composio: "old-composio" },
  );
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredAggregators(db, { choice: "none" });
  } finally {
    db.close();
  }
  const stored = readStoredAggregators(dir);
  assert.equal(stored.record?.choice, "none");
  assert.equal(stored.record?.executor?.url, "https://executor.example/mcp");
  assert.equal(stored.executorToken, "old-executor");
  assert.equal(stored.composioKey, "old-composio");
  assert.equal(readConfig(telegram, stored).mcp.length, 0);
  assert.equal(
    readConfig(
      {
        ...telegram,
        EXECUTOR_MCP_URL: "https://executor.example/mcp",
        EXECUTOR_TOKEN: "still-env",
      },
      stored,
    ).mcp[0]?.name,
    "executor",
  );
});

test("empty input keeps an existing aggregator secret", async () => {
  const url = "https://executor.example/mcp";
  const dir = await volume(
    { choice: "executor", executor: { url } },
    { executor: "executor-secret" },
  );
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredAggregators(db, { choice: "executor", executor: { url } }, {});
  } finally {
    db.close();
  }
  assert.equal(readStoredAggregators(dir).executorToken, "executor-secret");
  const db2 = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredAggregators(
      db2,
      { choice: "executor", executor: { url } },
      { executor: "replaced-secret" },
    );
  } finally {
    db2.close();
  }
  assert.equal(readStoredAggregators(dir).executorToken, "replaced-secret");
});

test("switching aggregators keeps the other credential", async () => {
  const dir = await volume(
    {
      choice: "both",
      executor: { url: "https://executor.example/mcp" },
      composio: { url: "https://connect.composio.dev/mcp", userId: "user_1" },
    },
    { executor: "executor-secret", composio: "ck_composio_secret" },
  );
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredAggregators(
      db,
      {
        choice: "composio",
        composio: {
          url: "https://connect.composio.dev/mcp",
          userId: "user_1",
        },
      },
      { composio: "ck_composio_secret" },
    );
  } finally {
    db.close();
  }
  const stored = readStoredAggregators(dir);
  assert.equal(stored.record?.choice, "composio");
  assert.equal(stored.record?.executor?.url, "https://executor.example/mcp");
  assert.equal(stored.executorToken, "executor-secret");
  assert.equal(stored.composioKey, "ck_composio_secret");
  assert.deepEqual(
    readConfig(telegram, stored).mcp.map((server) => server.name),
    ["composio"],
  );
});

class SecretInput extends EventEmitter {
  isTTY: boolean;
  raw: boolean[] = [];
  constructor(tty: boolean) {
    super();
    this.isTTY = tty;
  }
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  setEncoding() {}
  resume() {}
  pause() {}
}

test("secret reader doesn't echo", async () => {
  const input = new SecretInput(true);
  const output = new PassThrough();
  let echoed = "";
  output.on("data", (chunk) => {
    echoed += chunk.toString();
  });
  const rl = createInterface({
    input: input as unknown as NodeJS.ReadStream,
    output,
    terminal: true,
  });
  rl.pause();
  const pending = readHiddenSecret("Token: ", input as never, output);
  input.emit("data", "executor-token-secret\r\n");
  assert.equal(await pending, "executor-token-secret");
  const next = rl.question("next? ");
  input.emit("data", "visible\n");
  assert.equal(await next, "visible");
  rl.close();
  assert.equal(echoed.includes("executor-token-secret"), false);
  assert.match(echoed, /Token: /);
  assert.equal(input.raw.includes(true), true);

  const piped = new SecretInput(false);
  const sink = new PassThrough();
  let pipedOut = "";
  sink.on("data", (chunk) => {
    pipedOut += chunk.toString();
  });
  const pipedRead = readHiddenSecret("Key: ", piped as never, sink);
  piped.emit("data", "piped-");
  piped.emit("data", "secret-value\n");
  assert.equal(await pipedRead, "piped-secret-value");
  assert.equal(pipedOut.includes("piped-secret-value"), false);
  assert.equal(pipedOut.includes("piped-"), false);
  assert.deepEqual(piped.raw, []);
});

test("Composio slug globs are reads and other slugs stay writes", () => {
  const server = { server: "composio" };
  for (const name of [
    "GMAIL_GET_MESSAGE",
    "GMAIL_LIST_THREADS",
    "COMPOSIO_SEARCH_TOOLS",
    "GMAIL_FETCH_EMAILS",
    "GITHUB_FIND_ISSUE",
  ])
    assert.equal(mcpCallIsReadOnly(name, undefined, server), true, name);
  assert.equal(
    mcpCallIsReadOnly("COMPOSIO_MULTI_EXECUTE_TOOL", undefined, server),
    false,
  );
  assert.equal(
    mcpCallIsReadOnly("COMPOSIO_MANAGE_CONNECTIONS", undefined, server),
    false,
  );
  assert.equal(
    mcpCallIsReadOnly("GMAIL_SEND_EMAIL", undefined, {
      ...server,
      readOnlyHint: true,
    }),
    false,
  );
  assert.equal(mcpCallIsReadOnly("tools.search"), true);
});

test("auth-required redirects are the URL card payload", () => {
  const links = authRedirects({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          data: {
            results: {
              gmail: {
                status: "needs_auth",
                redirect_url: "https://connect.example/link",
                message: "Connect Gmail",
              },
            },
          },
        }),
      },
    ],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, "https://connect.example/link");
  assert.equal(links[0]?.message, "Connect Gmail");
  assert.equal(
    authRedirects({ status: "approval-required", requestId: "apr_1" }).length,
    0,
  );
  assert.equal(
    authRedirects({
      status: "needs_auth",
      redirect_url: "http://insecure.example",
    }).length,
    0,
  );
});

test("a configured header and user id are what the MCP client sends", async () => {
  const seen: { url?: string; apiKey?: string; authorization?: string } = {};
  const server = createServer((req, res) => {
    seen.url = req.url;
    seen.apiKey = req.headers["x-api-key"] as string | undefined;
    seen.authorization = req.headers.authorization;
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    {
      name: "composio",
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: "ak_test_secret",
      tokenHeader: "x-api-key",
      userId: "user_123",
    },
  ]);
  try {
    await assert.rejects(gateway.discover("composio"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("ak_test_secret"), false);
      return true;
    });
    assert.equal(seen.apiKey, "ak_test_secret");
    assert.equal(seen.authorization, undefined);
    assert.match(seen.url ?? "", /[?&]user_id=user_123/);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a needs_auth tool result opens one URL card and does not replay the call", async () => {
  let calls = 0;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      let transport = transports.get(
        String(req.headers["mcp-session-id"] ?? ""),
      );
      if (!transport) {
        const mcp = new McpServer({ name: "composio-mock", version: "1" });
        mcp.registerTool("connect_app", { inputSchema: {} }, async () => {
          calls += 1;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  data: {
                    results: {
                      gmail: {
                        status: "needs-auth",
                        redirect_url: "https://connect.example/link",
                        message: "Connect Gmail",
                      },
                    },
                  },
                }),
              },
            ],
          };
        });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        servers.push(mcp);
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const config: McpConfig = {
    name: "composio",
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
  const dir = await mkdtemp(join(tmpdir(), "pi-composio-auth-"));
  const gateway = new McpGateway([config]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await assert.rejects(
      app.mcpCalls.execute(id, 7, "composio", "connect_app", {}),
      McpUrlElicitationRequiredError,
    );
    assert.equal(calls, 1);
    const [card] = app.mcpCalls.interactions(id);
    assert.equal(card?.kind, "url");
    assert.equal(card?.state, "pending");
    assert.equal(
      JSON.parse(card?.payload ?? "{}").url,
      "https://connect.example/link",
    );
    await assert.rejects(
      app.mcpCalls.execute(id, 7, "composio", "connect_app", {}),
      /não será reenviada/,
    );
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await gateway.close();
    await Promise.all(servers.map((mcp) => mcp.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
