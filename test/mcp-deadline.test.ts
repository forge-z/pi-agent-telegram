import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpCalls, type McpReleaseNotice } from "../src/mcp-calls.js";
import { McpGateway } from "../src/mcp.js";
import { Store } from "../src/store.js";

async function fixture() {
  let session = "";
  let initializes = 0;
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
      session = `session-${++initializes}`;
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
              { name: "execute", inputSchema: { type: "object" } },
              { name: "fast", inputSchema: { type: "object" } },
              { name: "resume", inputSchema: { type: "object" } },
            ],
          },
        }),
      );
      return;
    }
    if (body.method === "tools/call" && body.params?.name === "execute") {
      startedWrite?.();
      await waitWrite;
    }
    if (body.method === "tools/call" && body.params?.name === "resume") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "Executor morreu no resume" },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: `done:${body.params?.name}` }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
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
      releaseWrite = undefined;
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
      actionTools: ["execute", "fast", "resume"],
    },
  ]);
}

test("uma chamada pendurada libera a trava no prazo e a seguinte passa", async () => {
  const previous = process.env.MCP_CALL_TIMEOUT_MS;
  process.env.MCP_CALL_TIMEOUT_MS = "2000";
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-deadline-"));
  const store = new Store(dir);
  const notices: McpReleaseNotice[] = [];
  const calls = new McpCalls(store, mcp, undefined, (notice) => {
    notices.push(notice);
  });
  const started = mock.holdWrite();
  try {
    await mcp.discover("mock");
    const hung = calls.execute("conversation", 1, "mock", "execute", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    void hung.catch(() => {});
    await started;
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE tool='execute'",
      )?.state,
      "running",
    );
    const failure = await hung.then(
      () => "passou",
      (error: Error) => error.message,
    );
    assert.match(failure, /estourou o prazo/);
    assert.match(failure, /trava foi liberada/);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE tool='execute'",
      )?.state,
      "failed",
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /estourou o prazo/);
    const next = await calls.execute("conversation", 3, "mock", "fast", {});
    assert.match(JSON.stringify(next), /done:fast/);
  } finally {
    mock.releaseWrite();
    if (previous === undefined) delete process.env.MCP_CALL_TIMEOUT_MS;
    else process.env.MCP_CALL_TIMEOUT_MS = previous;
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("um resume que falha libera a trava e a chamada seguinte passa", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-resume-fail-"));
  const store = new Store(dir);
  const notices: McpReleaseNotice[] = [];
  const calls = new McpCalls(store, mcp, undefined, (notice) => {
    notices.push(notice);
  });
  try {
    await mcp.discover("mock");
    await calls.execute("conversation", 1, "mock", "fast", {});
    const call = store.get<{ id: string; binding: string }>(
      "SELECT id, binding FROM mcp_calls",
    )!;
    store.run(
      "UPDATE mcp_calls SET state='paused', tool='execute', updatedAt=? WHERE id=?",
      Date.now(),
      call.id,
    );
    const interaction = "resume-1";
    store.run(
      "INSERT INTO mcp_interactions(id,callId,conversationId,server,kind,payload,state) VALUES (?,?,?,?,?,?,?)",
      interaction,
      call.id,
      "conversation",
      "mock",
      "resume",
      JSON.stringify({
        protocol: "executor",
        status: "approval-required",
        requestId: "apr_test",
        expiresAt: Date.now() + 60_000,
        elicitation: {
          mode: "form",
          message: "Confirme",
          requestedSchema: { type: "object", properties: {} },
        },
        invocation: { app: "mock", tool: "execute", input: {} },
      }),
      "pending",
    );
    store.run(
      "INSERT INTO deliveries(id, chat, text, state) VALUES (?,?,?,?)",
      `telegram:mcp:${interaction}`,
      "1",
      "card",
      "sent",
    );
    const resumed = await calls
      .decide("conversation", interaction, "accept", {})
      .then(
        () => "passou",
        (error: Error) => error.message,
      );
    assert.notEqual(resumed, "passou");
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id=?",
        call.id,
      )?.state,
      "failed",
    );
    assert.match(
      notices.map((notice) => notice.text).join("\n"),
      /trava foi liberada|resume|Falha na conexão/,
    );
    const next = await calls.execute("conversation", 2, "mock", "fast", {});
    assert.match(JSON.stringify(next), /done:fast/);
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("running vencido ou pausa sem retomada não deixa a conversa presa", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-stale-"));
  const store = new Store(dir);
  const notices: McpReleaseNotice[] = [];
  const calls = new McpCalls(store, mcp, undefined, (notice) => {
    notices.push(notice);
  });
  try {
    await mcp.discover("mock");
    store.run(
      "INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      "stuck",
      "conversation",
      "mock",
      "execute",
      "{}",
      "running",
      null,
      "binding",
      0,
    );
    const blocked = await calls
      .execute("conversation", 1, "mock", "fast", {})
      .then(
        () => "passou",
        (error: Error) => error.message,
      );
    assert.equal(blocked, "passou");
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id='stuck'",
      )?.state,
      "failed",
    );
    assert.match(notices[0]!.text, /trava foi liberada/);
    store.run(
      "UPDATE mcp_calls SET state='paused', updatedAt=? WHERE id='stuck'",
      Date.now(),
    );
    const again = await calls.execute("conversation", 2, "mock", "fast", {});
    assert.match(JSON.stringify(again), /done:fast/);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id='stuck'",
      )?.state,
      "failed",
    );
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uma pausa vencida não segura a conversa; uma pausa viva ainda segura", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-pause-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    await mcp.discover("mock");
    await calls.execute("conversation", 1, "mock", "fast", {});
    const call = store.get<{ id: string }>("SELECT id FROM mcp_calls")!;
    store.run(
      "UPDATE mcp_calls SET state='paused', updatedAt=? WHERE id=?",
      Date.now(),
      call.id,
    );
    store.run(
      "INSERT INTO mcp_interactions(id,callId,conversationId,server,kind,payload,state) VALUES (?,?,?,?,?,?,?)",
      "live",
      call.id,
      "conversation",
      "mock",
      "resume",
      JSON.stringify({
        protocol: "executor",
        requestId: "apr_live",
        expiresAt: Date.now() + 60_000,
        elicitation: {
          mode: "form",
          message: "Confirme",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
      "pending",
    );
    const blocked = await calls
      .execute("conversation", 2, "mock", "fast", {})
      .then(
        () => "passou",
        (error: Error) => error.message,
      );
    assert.notEqual(blocked, "passou");
    assert.match(blocked, /em andamento|solicitação pendente/);
    store.run(
      "UPDATE mcp_interactions SET payload=? WHERE id='live'",
      JSON.stringify({
        protocol: "executor",
        requestId: "apr_live",
        expiresAt: Date.now() - 1000,
        elicitation: {
          mode: "form",
          message: "Confirme",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    );
    const next = await calls.execute("conversation", 3, "mock", "fast", {});
    assert.match(JSON.stringify(next), /done:fast/);
    assert.equal(
      store.get<{ state: string }>(
        "SELECT state FROM mcp_calls WHERE id=?",
        call.id,
      )?.state,
      "failed",
    );
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
