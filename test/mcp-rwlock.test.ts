import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpGateway, McpNotSentError } from "../src/mcp.js";

async function fixture() {
  let session = "";
  let initializes = 0;
  let writes = 0;
  let waitWrite: Promise<void> | undefined;
  let releaseWrite: (() => void) | undefined;
  let startedWrite: (() => void) | undefined;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (body.method !== "initialize" && sid !== session) {
      res.writeHead(404).end("expired");
      return;
    }

    let result: unknown;
    if (body.method === "initialize") {
      session = `session-${++initializes}`;
      res.setHeader("Mcp-Session-Id", session);
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      };
    } else if (body.method.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    } else if (body.method === "tools/list") {
      result = {
        tools: [
          {
            name: "execute",
            description: "run",
            inputSchema: { type: "object" },
          },
          {
            name: "fast",
            description: "fast tool",
            inputSchema: { type: "object" },
          },
        ],
      };
    } else if (body.method === "tools/call") {
      writes++;
      if (body.params?.name === "execute") {
        startedWrite?.();
        await waitWrite;
      }
      result = {
        content: [{ type: "text", text: `done:${body.params?.name}` }],
      };
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
    get initializes() {
      return initializes;
    },
    get writes() {
      return writes;
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
    expire() {
      session = "expired";
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function gateway(url: string) {
  return new McpGateway([
    {
      name: "mock",
      url,
      mode: "direct",
      readTools: [],
      actionTools: ["execute", "fast"],
    },
  ]);
}

test("uma chamada pendurada no servidor não segura uma segunda chamada no mesmo servidor", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    // Initial discovery so client is established
    await mcp.discover("mock");

    // Hold the slow write
    const started = mock.holdWrite();
    const slowCall = mcp.callDirect("mock", "execute", {});
    await started;

    // While slowCall is held and running, call a fast tool on the same server
    let fastCompleted = false;
    const fastCall = mcp.callDirect("mock", "fast", {}).then((res) => {
      fastCompleted = true;
      return res;
    });

    // The fast call must complete even while slowCall is still waiting
    const fastResult = await fastCall;
    assert.equal(
      fastCompleted,
      true,
      "fast call completed while slow call was held",
    );
    assert.match(JSON.stringify(fastResult), /done:fast/);

    // Now release the slow call
    mock.releaseWrite();
    const slowResult = await slowCall;
    assert.match(JSON.stringify(slowResult), /done:execute/);
    assert.equal(mock.writes, 2);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("troca de sessão/descoberta espera chamadas em andamento", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    const started = mock.holdWrite();
    const write = mcp.callDirect("mock", "execute", {});
    await started;

    // Session expires remotely while write is active
    mock.expire();

    // Discover runs as exclusive; it must wait for write to finish
    let discoverDone = false;
    const catalog = mcp.discover("mock").then((tools) => {
      discoverDone = true;
      return tools;
    });

    // Verify discover is waiting behind write
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(discoverDone, false, "discover must wait for active call");

    mock.releaseWrite();
    const writeResult = await write;
    assert.match(JSON.stringify(writeResult), /done:execute/);

    const tools = await catalog;
    assert.equal(discoverDone, true);
    assert.equal(tools.length, 2);
    assert.equal(mock.initializes, 2);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("timeout de chamada de 60 s respeitado (via MCP_CALL_TIMEOUT_MS pequeno)", async () => {
  const prevEnv = process.env.MCP_CALL_TIMEOUT_MS;
  process.env.MCP_CALL_TIMEOUT_MS = "100"; // 100ms timeout
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    // Hold write and do not release it within 100ms
    mock.holdWrite();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}),
      /Tempo de resposta MCP excedido|timeout|abort/i,
    );
  } finally {
    mock.releaseWrite();
    if (prevEnv !== undefined) process.env.MCP_CALL_TIMEOUT_MS = prevEnv;
    else delete process.env.MCP_CALL_TIMEOUT_MS;
    await mcp.close();
    await mock.close();
  }
});

test("cancelamento antes do envio continua McpNotSentError", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}, { signal: controller.signal }),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});
