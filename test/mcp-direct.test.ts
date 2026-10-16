import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { McpGateway, type McpConfig } from "../src/mcp.js";
import { mcpToolName } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";

type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

async function serve(mcp: McpServer): Promise<RunningServer> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await mcp.connect(transport);
  const server = createServer(
    (req, res) => void transport.handleRequest(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

type LegacySseFixture = RunningServer & {
  streamablePosts: number;
  sseGets: number;
  ssePostSessions: string[];
};

async function serveLegacySse(
  mcp: McpServer,
  streamableStatus: number,
): Promise<LegacySseFixture> {
  const transports = new Map<string, SSEServerTransport>();
  let streamablePosts = 0;
  let sseGets = 0;
  const ssePostSessions: string[] = [];
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "POST" && requestUrl.pathname === "/sse") {
      streamablePosts++;
      res.writeHead(streamableStatus).end("Streamable HTTP unsupported");
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/sse") {
      sseGets++;
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      void mcp.connect(transport);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/message") {
      const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
      ssePostSessions.push(sessionId);
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end("Unknown SSE session");
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/sse`,
    get streamablePosts() {
      return streamablePosts;
    },
    get sseGets() {
      return sseGets;
    },
    ssePostSessions,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function config(url: string, extra: Partial<McpConfig> = {}): McpConfig {
  return {
    name: "mock",
    url,
    readTools: [],
    actionTools: [],
    mode: "direct",
    ...extra,
  };
}

function makeServer(counters: { reads: number; writes: number }) {
  const mcp = new McpServer({ name: "mock", version: "1.0.0" });
  mcp.registerTool(
    "lookup",
    { description: "Read the current context" },
    async () => {
      counters.reads++;
      return { content: [{ type: "text", text: "current context" }] };
    },
  );
  mcp.registerTool(
    "execute",
    {
      description: "Run the requested operation",
      inputSchema: { code: z.string() },
    },
    async ({ code }) => {
      counters.writes++;
      return { content: [{ type: "text", text: `executed ${code}` }] };
    },
  );
  return mcp;
}

test("direct discovery follows MCP tool-list pagination through every page", async () => {
  const mcp = new McpServer({ name: "paged", version: "1.0.0" });
  mcp.registerTool("seed", {}, async () => ({ content: [] }));
  const requestedCursors: string[] = [];
  mcp.server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
    const cursor = params?.cursor;
    requestedCursors.push(cursor ?? "first");
    if (cursor === "next")
      return {
        tools: [
          {
            name: "third",
            description: "Third page tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    return {
      tools: [
        {
          name: "first",
          description: "First page tool",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "second",
          description: "Second page tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      nextCursor: "next",
    };
  });
  const running = await serve(mcp);
  const gateway = new McpGateway([config(running.url, { name: "paged" })]);
  try {
    const tools = await gateway.discover("paged");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["first", "second", "third"],
    );
    assert.deepEqual(requestedCursors, ["first", "next"]);
  } finally {
    await gateway.close();
    await running.close();
  }
});

test("direct allow and deny policy supports omitted allowlists, deny-all, and deny precedence", async () => {
  const counters = { reads: 0, writes: 0 };
  const allRunning = await serve(makeServer(counters));
  const noneRunning = await serve(makeServer(counters));
  const deniedRunning = await serve(makeServer(counters));
  const allTools = new McpGateway([config(allRunning.url)]);
  const none = new McpGateway([config(noneRunning.url, { allowedTools: [] })]);
  const deniedWrite = new McpGateway([
    config(deniedRunning.url, {
      allowedTools: ["lookup", "execute"],
      deniedTools: ["execute"],
    }),
  ]);
  try {
    assert.match(
      JSON.stringify(await allTools.callDirect("mock", "lookup", {})),
      /current context/,
    );
    assert.match(
      JSON.stringify(
        await allTools.callDirect("mock", "execute", { code: "save" }),
      ),
      /executed save/,
    );
    await assert.rejects(
      none.callDirect("mock", "lookup", {}),
      /restrições configuradas|não autorizada/i,
    );
    await assert.rejects(
      none.callDirect("mock", "execute", { code: "save" }),
      /restrições configuradas|não autorizada/i,
    );
    assert.match(
      JSON.stringify(await deniedWrite.callDirect("mock", "lookup", {})),
      /current context/,
    );
    await assert.rejects(
      deniedWrite.callDirect("mock", "execute", { code: "save" }),
      /restrições configuradas|não autorizada/i,
    );
    assert.deepEqual(counters, { reads: 2, writes: 1 });
  } finally {
    await Promise.all([allTools.close(), none.close(), deniedWrite.close()]);
    await Promise.all([
      allRunning.close(),
      noneRunning.close(),
      deniedRunning.close(),
    ]);
  }
});

test("legacy read/action lists remain available only through the legacy call API", async () => {
  const counters = { reads: 0, writes: 0 };
  const running = await serve(makeServer(counters));
  const gateway = new McpGateway([
    {
      name: "mock",
      url: running.url,
      readTools: ["lookup"],
      actionTools: ["execute"],
    },
  ]);
  try {
    assert.match(
      JSON.stringify(await gateway.call("mock", "lookup", {}, "read")),
      /current context/,
    );
    await assert.rejects(
      gateway.call("mock", "execute", {}, "read"),
      /não autorizada/,
    );
    await gateway.call("mock", "execute", { code: "legacy" }, "action");
    await assert.rejects(gateway.callDirect("mock", "lookup", {}));
    assert.deepEqual(counters, { reads: 1, writes: 1 });
  } finally {
    await gateway.close();
    await running.close();
  }
});

test("catalog keeps healthy MCP servers available when another server fails", async () => {
  const running = await serve(makeServer({ reads: 0, writes: 0 }));
  const failingServer = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) =>
    failingServer.listen(0, "127.0.0.1", resolve),
  );
  const address = failingServer.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    config(running.url),
    config(`http://127.0.0.1:${address.port}/mcp`, { name: "unavailable" }),
  ]);
  try {
    const catalog = await gateway.catalog();
    assert.ok(catalog.find((entry) => entry.server === "mock")?.tools.length);
    assert.match(
      catalog.find((entry) => entry.server === "unavailable")?.error ?? "",
      /falha|autenticação/i,
    );
  } finally {
    await gateway.close();
    await running.close();
    await new Promise<void>((resolve, reject) =>
      failingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("MCP HTTP authorization failures never expose the bearer token", async () => {
  const token = "mcp-test-secret-must-not-leak";
  let receivedAuthorization: string | undefined;
  const server: Server = createServer((req, res) => {
    receivedAuthorization = req.headers.authorization;
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    config(`http://127.0.0.1:${address.port}/mcp`, { token }),
  ]);
  try {
    await assert.rejects(gateway.discover("mock"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /mcp-test-secret-must-not-leak/);
      return true;
    });
    assert.equal(receivedAuthorization, `Bearer ${token}`);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const status of [404, 405]) {
  test(`direct MCP falls back from Streamable HTTP to legacy SSE on POST ${status}`, async () => {
    let calls = 0;
    const mcp = new McpServer({ name: "legacy-sse", version: "1.0.0" });
    mcp.registerTool("lookup", {}, async () => {
      calls++;
      return { content: [{ type: "text", text: "legacy SSE result" }] };
    });
    const running = await serveLegacySse(mcp, status);
    const gateway = new McpGateway([
      config(running.url, { allowedTools: ["lookup"] }),
    ]);
    try {
      const tools = await gateway.discover("mock");
      assert.ok(tools.some((tool) => tool.name === "lookup"));
      const result = await gateway.callDirect("mock", "lookup", {});
      assert.match(JSON.stringify(result), /legacy SSE result/);
      assert.equal(calls, 1);
      assert.equal(running.streamablePosts, 1);
      assert.equal(running.sseGets, 1);
      assert.ok(running.ssePostSessions.length >= 3);
      assert.ok(
        running.ssePostSessions.every((sessionId) => sessionId.length > 0),
      );
      assert.equal(new Set(running.ssePostSessions).size, 1);
    } finally {
      await gateway.close();
      await running.close();
    }
  });
}

test("direct MCP does not fall back to legacy SSE for unrelated Streamable HTTP errors", async () => {
  const mcp = new McpServer({ name: "legacy-sse", version: "1.0.0" });
  mcp.registerTool("lookup", {}, async () => ({ content: [] }));
  const running = await serveLegacySse(mcp, 500);
  const gateway = new McpGateway([config(running.url)]);
  try {
    await assert.rejects(gateway.discover("mock"));
    assert.equal(running.streamablePosts, 1);
    assert.equal(running.sseGets, 0);
    assert.deepEqual(running.ssePostSessions, []);
  } finally {
    await gateway.close();
    await running.close();
  }
});

test("Durable registers direct MCP tools so a lookup and write run as direct calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-mcp-direct-"));
  const counters = { reads: 0, writes: 0 };
  const running = await serve(makeServer(counters));
  const gateway = new McpGateway([
    config(running.url, { allowedTools: ["lookup", "execute"] }),
  ]);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "direct-lookup-1",
        name: mcpToolName("mock", "lookup"),
        arguments: {},
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "direct-execute-1",
        name: mcpToolName("mock", "execute"),
        arguments: { code: "publish" },
      },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Lookup and write completed."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Runtime | undefined;
  try {
    app = await Runtime.open({ dir, gateway, models });
    const conversationId = await app.create();
    await app.submit(
      conversationId,
      "direct-tools",
      "Look up state, then publish.",
    );
    await (
      await app.conversation(conversationId)
    ).waitForIdle(
      (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
    );

    assert.deepEqual(counters, { reads: 1, writes: 1 });
    assert.deepEqual(app.store.actions(conversationId), []);
    const calls = app.mcpCalls.list(conversationId);
    assert.deepEqual(
      calls.map((call) => [call.server, call.tool, call.state]),
      [
        ["mock", "lookup", "done"],
        ["mock", "execute", "done"],
      ],
    );
  } finally {
    await app?.close();
    await gateway.close();
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
});
