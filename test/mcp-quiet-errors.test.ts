import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpCalls, mcpUncertainNeedsNotice } from "../src/mcp-calls.js";
import {
  McpError,
  McpGateway,
  type McpGateway as Gateway,
} from "../src/mcp.js";
import { Store } from "../src/store.js";

const lost = (text: string) =>
  JSON.stringify({
    isError: true,
    content: [{ type: "text", text }],
  });

test("only a write with no known result asks for a check", () => {
  const write = {
    state: "uncertain",
    tool: "execute",
    args: "{}",
  };
  assert.equal(mcpUncertainNeedsNotice({ ...write, result: null }), true);
  assert.equal(
    mcpUncertainNeedsNotice({
      ...write,
      result: lost("MCP connection or operation failed."),
    }),
    true,
  );
  assert.equal(
    mcpUncertainNeedsNotice({
      ...write,
      result: lost("A chamada execute estourou o prazo de 60s."),
    }),
    true,
  );
  assert.equal(
    mcpUncertainNeedsNotice({ ...write, result: lost("boom") }),
    false,
  );
  assert.equal(
    mcpUncertainNeedsNotice({
      ...write,
      result: lost("write: needs approval; not available in scheduled runs"),
    }),
    false,
  );
  assert.equal(
    mcpUncertainNeedsNotice({
      state: "uncertain",
      tool: "list",
      args: "{}",
      result: null,
    }),
    false,
  );
  assert.equal(
    mcpUncertainNeedsNotice({ ...write, state: "failed", result: null }),
    false,
  );
});

function fake(callDirect: Gateway["callDirect"]) {
  return {
    assertDirect() {},
    connectionBinding: async () => "binding",
    credentialBinding: () => "binding",
    releaseSession() {},
    callDirect,
  } as unknown as McpGateway;
}

test("a schema mismatch and a returned tool error stay failed and do not ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-quiet-"));
  const store = new Store(root);
  const calls = new McpCalls(
    store,
    fake(async (_server, tool) => {
      if (tool === "execute")
        throw new McpError(
          "MCP response does not match the tool output schema. The call result may be uncertain.",
        );
      return {
        isError: true,
        content: [{ type: "text", text: "boom" }],
      };
    }),
  );
  try {
    await assert.rejects(
      calls.execute("c", 1, "executor", "execute", { code: "send" }),
      /output schema/,
    );
    const listed = await calls.execute("c", 2, "executor", "list", {});
    assert.equal(listed.isError, true);
    const rows = store.all<{ tool: string; state: string }>(
      "SELECT tool, state FROM mcp_calls ORDER BY rowid",
    );
    assert.deepEqual(
      rows.map((row) => ({ tool: row.tool, state: row.state })),
      [
        { tool: "execute", state: "failed" },
        { tool: "list", state: "failed" },
      ],
    );
    assert.equal(
      store
        .all<{
          state: string;
          tool: string;
          args: string;
          result: string | null;
        }>("SELECT state, tool, args, result FROM mcp_calls")
        .some((row) => mcpUncertainNeedsNotice(row)),
      false,
    );
  } finally {
    await calls.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function transport() {
  let session = "";
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method?: string;
      params?: { name?: string; protocolVersion?: string };
    };
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (body.method !== "initialize" && sid !== session) {
      res.writeHead(404).end("expired");
      return;
    }
    if (body.method === "initialize") {
      session = "session-1";
      res.setHeader("Mcp-Session-Id", session);
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "mock", version: "1" },
          },
        }),
      );
      return;
    }
    if (body.method?.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "list", inputSchema: { type: "object" } },
              { name: "execute", inputSchema: { type: "object" } },
            ],
          },
        }),
      );
      return;
    }
    if (body.method === "tools/call") {
      const name = body.params?.name ?? "";
      calls.push(name);
      const drops =
        (name === "list" &&
          calls.filter((item) => item === "list").length === 1) ||
        name === "execute";
      if (drops) {
        res.writeHead(500).end("dropped");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("a dropped read is retried and a dropped write is not", async () => {
  const mock = await transport();
  const gateway = new McpGateway([
    { name: "mock", url: mock.url, mode: "direct" },
  ]);
  const root = await mkdtemp(join(tmpdir(), "mcp-retry-"));
  const store = new Store(root);
  const calls = new McpCalls(store, gateway);
  try {
    const read = await calls.execute("c", 1, "mock", "list", {});
    assert.equal(read.isError, undefined);
    assert.deepEqual(
      mock.calls.filter((name) => name === "list"),
      ["list", "list"],
    );
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE tool='list'",
      )?.state,
      "done",
    );
    await assert.rejects(calls.execute("c", 2, "mock", "execute", { n: 1 }));
    assert.deepEqual(
      mock.calls.filter((name) => name === "execute"),
      ["execute"],
    );
    const write = store.get<{
      state: string;
      tool: string;
      args: string;
      result: string | null;
    }>("SELECT state, tool, args, result FROM mcp_calls WHERE tool='execute'");
    assert.equal(write?.state, "uncertain");
    assert.equal(write ? mcpUncertainNeedsNotice(write) : false, true);
  } finally {
    await calls.close();
    await gateway.close();
    store.close();
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
