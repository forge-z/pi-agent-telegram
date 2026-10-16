import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { McpGateway, mcpToolName } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";

test("Durable registered MCP tools recover after idle expiry without manual refresh or duplicate effects", async () => {
  let session = "";
  let initializes = 0;
  let writes = 0;
  const requests: { method: string; session?: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const sid = req.headers["mcp-session-id"] as string | undefined;
    requests.push({ method: body.method, session: sid });
    if (body.method !== "initialize" && sid !== session) {
      res.writeHead(404).end("private expired-session response");
      return;
    }
    let result: unknown;
    if (body.method === "initialize") {
      session = `runtime-session-${++initializes}`;
      res.setHeader("mcp-session-id", session);
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "runtime-mock", version: "1" },
      };
    } else if (body.method.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    } else if (body.method === "tools/list") {
      result = {
        tools: [{ name: "execute", inputSchema: { type: "object" } }],
      };
    } else if (body.method === "tools/call") {
      writes++;
      result = { content: [{ type: "text", text: "saved once" }] };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    {
      name: "mock",
      url: `http://127.0.0.1:${address.port}/mcp`,
      mode: "direct",
      readTools: [],
      actionTools: [],
    },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-recovery-"));
  const faux = fauxProvider();
  const name = mcpToolName("mock", "execute");
  faux.setResponses([
    fauxAssistantMessage(
      { type: "toolCall", id: "before-expiry", name, arguments: {} },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("First operation complete."),
    fauxAssistantMessage(
      { type: "toolCall", id: "after-expiry", name, arguments: {} },
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Second operation complete."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Runtime | undefined;
  try {
    app = await Runtime.open({ dir, gateway, models });
    const conversationId = await app.create();
    const conversation = await app.conversation(conversationId);
    assert.equal(
      (await conversation.agent(context)).tools.filter(
        (tool) => tool.name === name,
      ).length,
      1,
    );
    await app.submit(
      conversationId,
      "before-expiry",
      "Save the first operation.",
    );
    await conversation.waitForIdle(context);
    assert.equal(writes, 1);
    session = "expired";
    await app.submit(
      conversationId,
      "after-expiry",
      "Save the second operation.",
    );
    await conversation.waitForIdle(context);
    assert.equal(writes, 2);
    assert.equal(initializes, 2);
    const calls = app.mcpCalls.list(conversationId);
    assert.deepEqual(
      calls.map((call) => call.state),
      ["done", "done"],
    );
    assert.equal(
      requests.filter((request) => request.method === "tools/call").length,
      2,
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "tools/call")
        .map((request) => request.session),
      ["runtime-session-1", "runtime-session-2"],
    );
    // Reusing the user request identity returns the saved submission without another effect.
    const beforeDuplicate = writes;
    await app.submit(
      conversationId,
      "after-expiry",
      "Save the second operation.",
    );
    await conversation.waitForIdle(context);
    assert.equal(writes, beforeDuplicate);
    // The settings path still refreshes the existing extension in place.
    await app.refreshMcpTools();
    assert.equal(
      (await conversation.agent(context)).tools.filter(
        (tool) => tool.name === name,
      ).length,
      1,
    );
    assert.equal(initializes, 2);
    assert.doesNotMatch(
      JSON.stringify(calls),
      /private expired-session|runtime-session-/,
    );
  } finally {
    await app?.close();
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
