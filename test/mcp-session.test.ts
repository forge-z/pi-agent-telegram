import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGateway, McpNotSentError } from "../src/mcp.js";
import { McpCalls, mcpCallIsReadOnly } from "../src/mcp-calls.js";
import { Store } from "../src/store.js";
import { Actions } from "../src/actions.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

async function fixture(legacySse = false) {
  let session = "";
  let initializes = 0;
  let writes = 0;
  let reads = 0;
  let initial404 = false;
  let loseWrite = false;
  let loseRead = false;
  let rejectLists = false;
  let missingLists = false;
  let missingListPage = false;
  let loseInitialization = false;
  let gets = 0;
  let paginate = false;
  let losePage = false;
  let metadata: "output" | "required" | undefined;
  let recoveredMetadataOnly = false;
  let waitWrite: Promise<void> | undefined;
  let releaseWrite: (() => void) | undefined;
  let startedWrite: (() => void) | undefined;
  let waitList: Promise<void> | undefined;
  let releaseList: (() => void) | undefined;
  let startedList: (() => void) | undefined;
  const requests: { method: string; session: string | undefined }[] = [];
  const streams = new Map<string, ServerResponse>();
  const server = createServer(async (req, res) => {
    if (legacySse && req.method === "GET" && !initial404) {
      gets++;
      session = `session-${initializes + 1}`;
      streams.set(session, res);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: endpoint\ndata: /messages?session=${session}\n\n`);
      return;
    }
    if (legacySse && req.url === "/mcp" && req.method === "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.method !== "POST") {
      gets++;
      res.writeHead(initial404 ? 404 : 405).end("private upstream message");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const sid = legacySse
      ? (new URL(req.url!, "http://localhost").searchParams.get("session") ??
        undefined)
      : (req.headers["mcp-session-id"] as string | undefined);
    requests.push({ method: body.method, session: sid });
    if (initial404 || (body.method !== "initialize" && sid !== session)) {
      res.writeHead(404).end("secret endpoint and token must never leak");
      return;
    }
    let result: unknown;
    if (body.method === "initialize") {
      if (!legacySse) assert.equal(sid, undefined);
      session = `session-${++initializes}`;
      if (!legacySse) res.setHeader("Mcp-Session-Id", session);
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      };
    } else if (body.method.startsWith("notifications/")) {
      if (loseInitialization) {
        session = "expired";
        res.writeHead(404).end("expired initialized notification");
        return;
      }
      res.writeHead(202).end();
      return;
    } else if (body.method === "tools/list") {
      startedList?.();
      await waitList;
      if (missingLists || (missingListPage && body.params?.cursor)) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      if (rejectLists) {
        session = "expired";
        res.writeHead(404).end("expired catalog");
        return;
      }
      if (paginate && body.params?.cursor && losePage) {
        losePage = false;
        session = "expired";
        res.writeHead(404).end("page session expired");
        return;
      }
      const enabledMetadata =
        !recoveredMetadataOnly || initializes > 1 ? metadata : undefined;
      result = paginate
        ? {
            tools: [
              {
                name: metadata
                  ? body.params?.cursor
                    ? "execute"
                    : "lookup"
                  : `${body.params?.cursor ? "second" : "first"}-${initializes}`,
                inputSchema: { type: "object" },
                ...(enabledMetadata === "output"
                  ? {
                      outputSchema: {
                        type: "object",
                        properties: { valid: { type: "boolean" } },
                        required: ["valid"],
                      },
                    }
                  : {}),
                ...(enabledMetadata === "required"
                  ? { execution: { taskSupport: "required" } }
                  : {}),
              },
            ],
            ...(body.params?.cursor ? {} : { nextCursor: "next" }),
          }
        : {
            tools: ["lookup", "execute"].map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          };
    } else if (body.method === "tools/call") {
      if (body.params.name === "execute") {
        writes++;
        startedWrite?.();
        await waitWrite;
        if (loseWrite) {
          loseWrite = false;
          session = "expired";
          res.writeHead(404).end("effect completed but response was lost");
          return;
        }
      } else {
        if (loseRead) {
          loseRead = false;
          session = "expired";
          res.writeHead(404).end("expired");
          return;
        }
        reads++;
      }
      result = { content: [{ type: "text", text: "done" }] };
      if (metadata === "output")
        result = {
          content: [{ type: "text", text: "done" }],
          structuredContent: { valid: "invalid" },
        };
    }
    if (legacySse) {
      streams
        .get(sid!)!
        .write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
        );
      res.writeHead(202).end();
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    get initializes() {
      return initializes;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    expire() {
      session = "expired";
    },
    failEndpoint() {
      initial404 = true;
    },
    restoreEndpoint() {
      initial404 = false;
    },
    loseWrite() {
      loseWrite = true;
    },
    loseRead() {
      loseRead = true;
    },
    rejectLists() {
      rejectLists = true;
    },
    omitListMethod() {
      missingLists = true;
    },
    omitSecondListPage() {
      missingListPage = true;
    },
    loseInitialization() {
      loseInitialization = true;
    },
    get gets() {
      return gets;
    },
    loseSecondPage() {
      paginate = true;
      losePage = true;
    },
    paginateMetadata(kind: "output" | "required") {
      paginate = true;
      metadata = kind;
    },
    metadataAfterRecovery(kind: "output" | "required") {
      paginate = true;
      metadata = kind;
      recoveredMetadataOnly = true;
    },
    holdWrite() {
      waitWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return new Promise<void>((resolve) => {
        startedWrite = resolve;
      });
    },
    releaseWrite() {
      releaseWrite?.();
    },
    holdList() {
      waitList = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      return new Promise<void>((resolve) => {
        startedList = resolve;
      });
    },
    releaseList() {
      releaseList?.();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams.values()) stream.end();
        server.close(() => resolve());
      }),
  };
}
function gateway(url: string, direct = false) {
  return new McpGateway([
    {
      name: "mock",
      url,
      mode: direct ? "direct" : "legacy",
      readTools: ["lookup"],
      actionTools: ["execute"],
    },
  ]);
}

test("expired MCP sessions recover once during concurrent discovery and keep the new session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.expire();
    const catalogs = await Promise.all(
      Array.from({ length: 6 }, () => mcp.discover("mock")),
    );
    assert.ok(catalogs.every((tools) => tools.length === 2));
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "initialize").length,
      2,
    );
    await mcp.call("mock", "lookup", {}, "read");
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("only explicitly classified reads retry after a lost session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.loseRead();
    assert.match(
      JSON.stringify(await mcp.call("mock", "lookup", {}, "read")),
      /done/,
    );
    assert.equal(mock.reads, 1);
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a legacy read retry refreshes required-task metadata before dispatching into the replacement session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.metadataAfterRecovery("required");
    await mcp.discover("mock");
    mock.loseRead();
    await assert.rejects(
      mcp.call("mock", "lookup", {}, "read"),
      McpNotSentError,
    );
    assert.equal(mock.initializes, 2);
    assert.equal(mock.reads, 0);
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      1,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a legacy read retry validates output against the replacement session's schema", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.metadataAfterRecovery("output");
    await mcp.discover("mock");
    mock.loseRead();
    await assert.rejects(
      mcp.call("mock", "lookup", {}, "read"),
      /schema de saída/,
    );
    assert.equal(mock.initializes, 2);
    assert.equal(mock.reads, 1);
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      2,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("legacy SSE discovery replaces an expired POST endpoint even without a session header", async () => {
  const mock = await fixture(true);
  const mcp = gateway(mock.url);
  try {
    assert.equal((await mcp.discover("mock")).length, 2);
    mock.expire();
    assert.equal((await mcp.discover("mock")).length, 2);
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

for (const legacySse of [false, true]) {
  test(`an idle ${legacySse ? "SSE" : "Streamable HTTP"} session recovers before a legacy action is sent`, async () => {
    const mock = await fixture(legacySse);
    const mcp = gateway(mock.url);
    try {
      await mcp.discover("mock");
      await mcp.call("mock", "execute", {}, "action");
      mock.expire();
      await mcp.call("mock", "execute", {}, "action");
      assert.equal(mock.initializes, 2);
      assert.equal(mock.writes, 2);
      assert.equal(
        mock.requests.filter((request) => request.method === "tools/call")
          .length,
        2,
      );
    } finally {
      await mcp.close();
      await mock.close();
    }
  });
}

test("legacy tools/call compatibility only bypasses an explicit missing discovery method", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.omitListMethod();
    await mcp.call("mock", "execute", {}, "action");
    assert.equal(mock.writes, 1);
    assert.equal(mock.initializes, 1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("legacy compatibility cannot bypass a missing discovery method on a later catalog page", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.paginateMetadata("required");
    mock.omitSecondListPage();
    await assert.rejects(
      mcp.call("mock", "execute", {}, "action"),
      McpNotSentError,
    );
    assert.equal(mock.initializes, 1);
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      0,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("direct tools require a successful discovery probe before dispatch", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    mock.omitListMethod();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
    assert.equal(mock.initializes, 1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("repeated session expiry during the probe is bounded and definitely unsent", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    mock.rejectLists();
    await assert.rejects(mcp.callDirect("mock", "execute", {}), (error) => {
      assert.ok(error instanceof McpNotSentError);
      assert.match(error.message, /expirou novamente antes do envio/);
      return true;
    });
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a removed endpoint after session admission fails before any tool is sent", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    mock.failEndpoint();
    await assert.rejects(mcp.callDirect("mock", "execute", {}), (error) => {
      assert.ok(error instanceof McpNotSentError);
      assert.match(error.message, /Endpoint MCP.*404.*Nenhuma chamada/);
      return true;
    });
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((request) => request.method === "initialize").length,
      2,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("concurrent direct calls and discovery share one recovered session without replaying effects", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    mock.expire();
    await Promise.all([
      ...Array.from({ length: 6 }, () => mcp.callDirect("mock", "execute", {})),
      mcp.discover("mock"),
    ]);
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 6);
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      6,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("cancelling a discovery probe leaves the tool definitely unsent", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    const controller = new AbortController();
    const started = mock.holdList();
    const call = mcp.callDirect(
      "mock",
      "execute",
      {},
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    await assert.rejects(call, McpNotSentError);
    assert.equal(mock.writes, 0);
    mock.releaseList();
    await mcp.discover("mock");
    assert.equal(mock.writes, 0);
  } finally {
    mock.releaseList();
    await mcp.close();
    await mock.close();
  }
});

test("a dispatched SSE tool returning 404 is not replayed and the next operation reconnects", async () => {
  const mock = await fixture(true);
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    mock.loseWrite();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}),
      /não foi reenviada/,
    );
    assert.equal(mock.writes, 1);
    await mcp.discover("mock");
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a tools/call response can take longer than the discovery timeout without being aborted or replayed", async (context) => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  let call: Promise<unknown> | undefined;
  try {
    await mcp.discover("mock");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const started = mock.holdWrite();
    call = mcp.callDirect("mock", "execute", {});
    // Install a rejection handler before advancing the clock past 30 seconds.
    void call.catch(() => {});
    await started;
    context.mock.timers.tick(30001);
    mock.releaseWrite();
    assert.match(JSON.stringify(await call), /done/);
    assert.equal(mock.writes, 1);
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      1,
    );
  } finally {
    context.mock.timers.reset();
    mock.releaseWrite();
    await call?.catch(() => {});
    await mcp.close();
    await mock.close();
  }
});

test("a direct call checks an idle session before dispatch and recovers without creating an uncertain effect", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-idle-session-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    await mcp.discover("mock");
    await calls.execute("conversation", 1, "mock", "execute", {});
    assert.equal(mock.writes, 1);
    mock.expire();
    await calls.execute("conversation", 2, "mock", "execute", {});
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 2);
    assert.deepEqual(
      calls.list("conversation").map((call) => call.state),
      ["done", "done"],
    );
    const recovery = mock.requests
      .slice(
        mock.requests.findIndex((request) => request.method === "tools/call") +
          1,
      )
      .filter((request) => !request.method.startsWith("notifications/"));
    assert.deepEqual(recovery[0], {
      method: "tools/list",
      session: "session-1",
    });
    assert.equal(recovery[1].method, "initialize");
    assert.equal(
      mock.requests.filter((request) => request.method === "tools/call").length,
      2,
    );
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const recovery of ["automatic", "manual"] as const) {
  for (const tool of ["lookup", "execute"]) {
    test(`${recovery} session recovery preserves the output schema from the ${tool === "lookup" ? "first" : "second"} catalog page`, async () => {
      const mock = await fixture();
      const mcp = gateway(mock.url, true);
      const dir = await mkdtemp(join(tmpdir(), "mcp-output-metadata-"));
      const store = new Store(dir);
      const calls = new McpCalls(store, mcp);
      try {
        mock.paginateMetadata("output");
        await mcp.discover("mock");
        mock.expire();
        if (recovery === "manual") await mcp.discover("mock");
        await assert.rejects(
          calls.execute("conversation", 1, "mock", tool, {}),
        );
        assert.equal(mock.initializes, 2);
        assert.equal(calls.list("conversation")[0].state, "uncertain");
        assert.equal(
          mock.requests.filter((request) => request.method === "tools/call")
            .length,
          1,
        );
      } finally {
        await calls.close();
        await mcp.close();
        store.close();
        await mock.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test(`${recovery} session recovery preserves required task execution from the ${tool === "lookup" ? "first" : "second"} catalog page`, async () => {
      const mock = await fixture();
      const mcp = gateway(mock.url, true);
      try {
        mock.paginateMetadata("required");
        await mcp.discover("mock");
        mock.expire();
        if (recovery === "manual") await mcp.discover("mock");
        await assert.rejects(mcp.callDirect("mock", tool, {}), McpNotSentError);
        assert.equal(mock.initializes, 2);
        assert.equal(
          mock.requests.filter((request) => request.method === "tools/call")
            .length,
          0,
        );
      } finally {
        await mcp.close();
        await mock.close();
      }
    });
  }
}

test("initial endpoint 404 is distinct from session expiry and does not loop initialization", async () => {
  const mock = await fixture();
  mock.failEndpoint();
  const mcp = gateway(mock.url);
  try {
    await assert.rejects(mcp.discover("mock"), /Endpoint MCP.*404/);
    assert.equal(
      mock.requests.filter((r) => r.method === "initialize").length,
      1,
    );
    assert.equal(mock.initializes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("direct tools are not resent after 404 and the durable call remains uncertain", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-session-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    await mcp.discover("mock");
    mock.loseWrite();
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /sessão MCP.*não.*reenviada/i,
    );
    assert.equal(mock.writes, 1);
    assert.equal(calls.list("conversation")[0].state, "uncertain");
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /não será reenviada/,
    );
    await mcp.discover("mock");
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
    assert.doesNotMatch(
      JSON.stringify(calls.list("conversation")),
      /secret endpoint|session-/,
    );
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session recovery is bounded when the server expires every catalog request", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.rejectLists();
    await assert.rejects(mcp.discover("mock"), /sessão MCP expirou novamente/);
    assert.equal(mock.initializes, 2);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/list").length,
      2,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("discovery does not replace a client while a direct write is still running", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    const started = mock.holdWrite();
    const write = mcp.callDirect("mock", "execute", {});
    await started;
    mock.expire();
    const catalog = mcp.discover("mock");
    // The old operation must complete before discovery notices the expired ID.
    mock.releaseWrite();
    assert.match(JSON.stringify(await write), /done/);
    assert.equal((await catalog).length, 2);
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("a legacy action rejected with a session 404 is not automatically replayed", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.loseWrite();
    await assert.rejects(
      mcp.call("mock", "execute", {}, "action"),
      /sessão MCP.*não foi reenviada/,
    );
    assert.equal(mock.writes, 1);
    await mcp.discover("mock");
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("404 after initialize is a lost session, not a reason to fall back to legacy SSE", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.loseInitialization();
    await assert.rejects(
      mcp.discover("mock"),
      /sessão MCP expirou durante a inicialização/,
    );
    assert.equal(mock.initializes, 1);
    assert.equal(mock.gets, 0);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("discovery restarts pagination without keeping tools from the expired session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.loseSecondPage();
    const tools = await mcp.discover("mock");
    assert.deepEqual(
      tools.map((t) => t.name),
      ["first-2", "second-2"],
    );
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a reconnect failure before tools/call is failed, not uncertain, and an explicit retry can succeed", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-unsent-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  const binding = mcp.connectionBinding.bind(mcp);
  let interrupt = true;
  mcp.connectionBinding = async (server) => {
    const value = await binding(server);
    if (interrupt) {
      interrupt = false;
      // Reproduce a client going away after admission but before dispatch.
      await mcp.replace([...mcp.config]);
      mock.failEndpoint();
    }
    return value;
  };
  try {
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      0,
    );
    assert.equal(calls.list("conversation")[0].state, "failed");
    assert.match(
      calls.list("conversation")[0].result!,
      /Nenhuma chamada de ferramenta foi enviada/,
    );
    // Distinct task identity is an explicit retry, never an automatic replay.
    mock.restoreEndpoint();
    const result = await calls.execute(
      "conversation",
      2,
      "mock",
      "execute",
      {},
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.writes, 1);
    assert.equal(calls.list("conversation")[1].state, "done");
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an initial initialize 404 creates no uncertain call or reconciliation requirement", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-init-failed-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    mock.failEndpoint();
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /Endpoint MCP/,
    );
    assert.equal(mock.writes, 0);
    assert.equal(calls.list("conversation").length, 0);
    mock.restoreEndpoint();
    await calls.execute("conversation", 1, "mock", "execute", {});
    assert.equal(calls.list("conversation")[0].state, "done");
    assert.equal(mock.writes, 1);
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a direct call cancelled before dispatch sends no tool and is definitely unsent", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}, { signal: controller.signal }),
      McpNotSentError,
    );
    assert.equal(mock.initializes, 0);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("legacy action cancellation releases the caller without replaying an already dispatched effect", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    const controller = new AbortController();
    const started = mock.holdWrite();
    const action = mcp.call("mock", "execute", {}, "action", controller.signal);
    await started;
    controller.abort();
    await assert.rejects(action, (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof McpNotSentError));
      return true;
    });
    assert.equal(mock.writes, 1);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    );
    mock.releaseWrite();
    await mcp.discover("mock");
    assert.equal(mock.writes, 1);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("legacy action cancelled before dispatch performs no initialization or effect", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.call("mock", "execute", {}, "action", controller.signal),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
    assert.equal(mock.initializes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a cancelled queued call settles promptly without interrupting the active MCP operation", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  let running: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mcp.discover("mock");
    const started = mock.holdWrite();
    running = mcp.call("mock", "execute", {}, "action");
    await started;
    const controller = new AbortController();
    const queued = mcp.call("mock", "execute", {}, "action", controller.signal);
    controller.abort();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Queued cancellation did not settle promptly")),
        250,
      );
    });
    await assert.rejects(Promise.race([queued, deadline]), McpNotSentError);
    assert.equal(mock.writes, 1);
    assert.equal(mock.initializes, 1);
    // A following catalog is still queued behind the live operation.
    const catalog = mcp.discover("mock");
    assert.throws(() => mcp.checkReplacement([...mcp.config]), /Aguarde/);
    mock.releaseWrite();
    assert.match(JSON.stringify(await running), /done/);
    await catalog;
    assert.equal(mock.writes, 1);
    assert.equal(mock.initializes, 1);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    );
  } finally {
    clearTimeout(timer);
    mock.releaseWrite();
    await running?.catch(() => {});
    await mcp.close();
    await mock.close();
  }
});

test("legacy approval with predispatch initialize 404 is failed and a duplicate approval never resends", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-action-unsent-"));
  const store = new Store(dir);
  const actions = new Actions(store, mcp);
  try {
    await actions.read("conversation", "mock", "lookup", {});
    const proposed = actions.propose("conversation", 1, "mock", "execute", {});
    await mcp.replace([...mcp.config]);
    mock.failEndpoint();
    const result = await actions.decide("conversation", proposed.id, "approve");
    assert.equal(result.state, "failed");
    assert.match(result.result!, /não foi enviada/);
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    ); // evidence read only
    mock.restoreEndpoint();
    const duplicate = await actions.decide(
      "conversation",
      proposed.id,
      "approve",
    );
    assert.equal(duplicate.state, "failed");
    assert.equal(mock.writes, 0);
    const retry = actions.propose("conversation", 2, "mock", "execute", {});
    assert.equal(
      (await actions.decide("conversation", retry.id, "approve")).state,
      "done",
    );
    assert.equal(mock.writes, 1);
  } finally {
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("output validators are compiled once per schema and still enforced on later calls", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const compile = AjvJsonSchemaValidator.prototype.getValidator;
  let compiled = 0;
  AjvJsonSchemaValidator.prototype.getValidator = function (
    this: AjvJsonSchemaValidator,
    ...args: Parameters<typeof compile>
  ) {
    compiled++;
    return compile.apply(this, args);
  } as typeof compile;
  try {
    mock.paginateMetadata("output");
    await mcp.discover("mock");
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(
        mcp.call("mock", "lookup", {}, "read"),
        /schema de saída/,
      );
    assert.equal(compiled, 1);
  } finally {
    AjvJsonSchemaValidator.prototype.getValidator = compile;
    await mcp.close();
    await mock.close();
  }
});

test("mcpCallIsReadOnly treats Executor call and execute sandbox reads as read-only", () => {
  assert.equal(mcpCallIsReadOnly("search"), true);
  assert.equal(
    mcpCallIsReadOnly("call", {
      body: {
        tool: "tools.github.repos.listForUser",
        kind: "query",
        input: {},
      },
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("call", {
      body: { tool: "tools.github.issues.create", input: {} },
    }),
    false,
  );
  assert.equal(
    mcpCallIsReadOnly("execute", {
      code: 'await tools.search({ query: "x" })',
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("execute", { code: "await tools.call({})" }),
    false,
  );
  assert.equal(
    mcpCallIsReadOnly("execute", {
      code: "return JSON.stringify(await tools.instabox.machines.readFiles({}));",
    }),
    true,
  );
  assert.equal(
    mcpCallIsReadOnly("execute", {
      code: "return JSON.stringify(await tools.instabox.machines.exec({}));",
    }),
    false,
  );
  assert.equal(mcpCallIsReadOnly("execute", undefined), false);
});

test("an uncertain result blocks actions but never reads", async () => {
  const mock = await fixture(true);
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-uncertain-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  const text = (result: unknown) => JSON.stringify(result ?? "").slice(0, 400);
  try {
    await mcp.discover("mock");
    // A lost return leaves the row uncertain, exactly like a crashed dispatch.
    store.run(
      `INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt)
       VALUES ('lost','conversation','mock','execute','{}','uncertain','{"isError":true}','mock',0)`,
    );
    await assert.rejects(
      calls.execute("conversation", 2, "mock", "execute", {}),
      /resultado MCP incerto/i,
    );
    // Executor verification often uses execute + sandbox pick(); that stays a read.
    const sandboxRead = await calls
      .execute("conversation", 31, "mock", "execute", {
        code: [
          'const pick = (p) => p.split(".").reduce((o, k) => o[k], tools);',
          'return JSON.stringify(await pick("tools.mock.agent.runs.listRuns")({}));',
        ].join("\n"),
      })
      .then(
        (result) => text(result),
        (error: Error) => error.message,
      );
    assert.doesNotMatch(text(sandboxRead), /resultado MCP incerto/i);
    assert.equal(calls.clearUncertain("conversation"), 0);
    store.run(
      `INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt)
       VALUES ('lost3','conversation','mock','execute','{}','uncertain','{"isError":true}','mock',0)`,
    );
    // A read never waits behind it: the message asks the agent to look.
    const read = await calls
      .execute("conversation", 3, "mock", "listRuns", {})
      .then(
        (result) => text(result),
        (error: Error) => error.message,
      );
    assert.doesNotMatch(text(read), /resultado MCP incerto/i);
    // That read was the verification: the flag is already gone.
    assert.equal(calls.clearUncertain("conversation"), 0);
    // A second lost return is cleared by the operator, who keeps the history.
    store.run(
      `INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt)
       VALUES ('lost2','conversation','mock','execute','{}','uncertain','{"isError":true}','mock',0)`,
    );
    assert.equal(calls.clearUncertain("conversation"), 1);
    assert.equal(
      store.get("SELECT 1 FROM mcp_calls WHERE state='uncertain'"),
      undefined,
    );
    assert.equal(
      store.all("SELECT 1 FROM mcp_calls WHERE state='uncertain'").length,
      0,
    );
    // And the action may run again.
    const again = await calls
      .execute("conversation", 4, "mock", "execute", {})
      .then(
        (result) => text(result),
        (error: Error) => error.message,
      );
    assert.doesNotMatch(text(again), /resultado MCP incerto/i);
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pending approval block names the requestId and still allows reads", async () => {
  const mock = await fixture(true);
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-pending-apr-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    await mcp.discover("mock");
    store.run(
      `INSERT INTO mcp_interactions(id,callId,conversationId,server,kind,payload,state,response)
       VALUES ('i1','c1','conversation','executor','resume',?,'pending',NULL)`,
      JSON.stringify({ requestId: "apr_deadbeef" }),
    );
    const blocked = await calls
      .execute("conversation", 1, "mock", "execute", {
        code: "await tools.mutate()",
      })
      .then(
        () => "",
        (error: Error) => error.message,
      );
    assert.match(blocked, /apr_deadbeef/);
    const read = await calls
      .execute("conversation", 2, "mock", "search", { query: "x" })
      .then(
        () => "ok",
        (error: Error) => error.message,
      );
    assert.equal(read, "ok");
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
