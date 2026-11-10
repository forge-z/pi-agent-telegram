import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpGateway, MCP_TIMEOUT_ERROR } from "../src/mcp.js";

async function fixture() {
  let release: () => void = () => {};
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const mcp = new McpServer({ name: "mock", version: "1.0.0" });
  mcp.registerTool("slow", { description: "Sends progress" }, async (extra) => {
    const progressToken = extra?._meta?.progressToken;
    if (progressToken !== undefined)
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: 1, message: "baixando 50%" },
      });
    return { content: [{ type: "text", text: "pronto" }] };
  });
  mcp.registerTool("stall", { description: "Never answers" }, async () => {
    await stalled;
    return { content: [{ type: "text", text: "tarde" }] };
  });
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
  const gateway = new McpGateway([
    {
      name: "mock",
      url: `http://127.0.0.1:${address.port}/mcp`,
      mode: "direct",
    },
  ]);
  return {
    gateway,
    async close() {
      release();
      await gateway.close();
      await mcp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a progress notification is passed to the SDK and kept for the long-call status", async () => {
  const f = await fixture();
  try {
    assert.match(
      JSON.stringify(await f.gateway.callDirect("mock", "slow", {})),
      /pronto/,
    );
    assert.equal(f.gateway.lastProgressMessage("mock"), "baixando 50%");
  } finally {
    await f.close();
  }
});

test("MCP_CALL_TIMEOUT_MS is a hard limit even without progress notifications", async () => {
  const previous = process.env.MCP_CALL_TIMEOUT_MS;
  process.env.MCP_CALL_TIMEOUT_MS = "400";
  const f = await fixture();
  try {
    const started = Date.now();
    await assert.rejects(
      f.gateway.callDirect("mock", "stall", {}),
      new RegExp(MCP_TIMEOUT_ERROR.slice(0, 20)),
    );
    assert.ok(Date.now() - started < 10_000);
  } finally {
    if (previous === undefined) delete process.env.MCP_CALL_TIMEOUT_MS;
    else process.env.MCP_CALL_TIMEOUT_MS = previous;
    await f.close();
  }
});
