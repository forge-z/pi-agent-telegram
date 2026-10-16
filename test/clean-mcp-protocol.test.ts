import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { McpGateway } from "../src/mcp.js";
import { McpCalls } from "../src/mcp-calls.js";
import { Store } from "../src/store.js";

async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check());
}
async function fixture() {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const calls: { tool: string; args: unknown }[] = [];
  let writes = 0;
  const pause = (id: string) => ({
    content: [],
    structuredContent: {
      status: "approval-required",
      requestId: id,
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "mock",
        tool: "write",
        input: { to: "mock@example.test", body: "review" },
      },
      elicitation: {
        mode: "form",
        message: "Approve mock?",
        requestedSchema: { type: "object", properties: {} },
      },
    },
  });
  const http = createServer((req, res) => {
    void (async () => {
      let transport = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
      if (!transport) {
        const server = new McpServer({ name: "mock-executor", version: "1" });
        server.registerTool(
          "execute",
          { inputSchema: { code: z.string() } },
          async ({ code }) => {
            calls.push({ tool: "execute", args: { code } });
            if (code === "form") {
              const result = await server.server.elicitInput(
                {
                  message: "Confirm native mock",
                  requestedSchema: {
                    type: "object",
                    properties: { confirmed: { type: "boolean" } },
                    required: ["confirmed"],
                  },
                },
                { timeout: 10000 },
              );
              if (result.action === "accept" && result.content?.confirmed)
                writes++;
              return { content: [{ type: "text", text: result.action }] };
            }
            if (code === "browser")
              return {
                content: [],
                structuredContent: {
                  ...pause("browser").structuredContent,
                  approvalUrl:
                    "https://example.test/private-ticket/opaque-value",
                },
              };
            if (code === "legacy")
              return {
                content: [],
                structuredContent: { paused: true, executionId: "old" },
              };
            if (code === "failure")
              return {
                content: [],
                structuredContent: {
                  status: "completed",
                  execution: { ok: false, error: { message: "mock failure" } },
                },
              };
            if (["busy", "unavailable", "capacity-exceeded"].includes(code))
              return {
                content: [],
                structuredContent: {
                  status: code,
                  requestId: "x",
                  reason: "expired",
                },
              };
            return pause(code);
          },
        );
        server.registerTool(
          "resume",
          {
            inputSchema: {
              requestId: z.string(),
              response: z.object({
                action: z.enum(["accept", "decline", "cancel"]),
                content: z.record(z.string(), z.unknown()).optional(),
              }),
            },
          },
          async (args) => {
            calls.push({ tool: "resume", args });
            if (
              args.requestId === "chain-first" &&
              args.response.action === "accept"
            )
              return pause("chain-second");
            if (args.requestId === "inflight")
              await new Promise((r) => setTimeout(r, 200));
            if (args.response.action === "accept") writes++;
            return {
              content: [],
              structuredContent: {
                status: "completed",
                execution: { ok: true, value: "mock done" },
              },
            };
          },
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        servers.push(server);
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-protocol-"));
  let store = new Store(dir);
  const gateway = new McpGateway([
    {
      name: "executor",
      url: `http://127.0.0.1:${address.port}/mcp`,
      mode: "direct",
      readTools: [],
      actionTools: [],
    },
  ]);
  let ledger = new McpCalls(store, gateway);
  return {
    calls,
    get writes() {
      return writes;
    },
    get ledger() {
      return ledger;
    },
    get store() {
      return store;
    },
    restart: async () => {
      await ledger.close();
      store.close();
      store = new Store(dir);
      ledger = new McpCalls(store, gateway);
    },
    close: async () => {
      await ledger.close();
      store.close();
      await gateway.close();
      await Promise.all(servers.map((s) => s.close()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("a scheduled occurrence skips an approval pause instead of waiting for a click", async () => {
  const f = await fixture();
  try {
    const result = await f.ledger.execute(
      "1",
      1,
      "executor",
      "execute",
      { code: "sched" },
      undefined,
      true,
    );
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Passo pulado/);
    // No card, no pending waiter: nothing to click, nothing to resume.
    assert.equal(f.ledger.interactions("1").length, 0);
    assert.equal(
      f.store.get<{ state: string }>("SELECT state FROM mcp_calls")?.state,
      "skipped",
    );
    assert.equal(f.writes, 0);
  } finally {
    await f.close();
  }
});

test("actual SDK elicitation waits, validates exact form and accepts once under concurrent decisions", async () => {
  const f = await fixture();
  try {
    const pending = f.ledger.execute("1", 1, "executor", "execute", {
      code: "form",
    });
    await until(() => f.ledger.interactions("1").length === 1);
    const row = f.ledger.interactions("1")[0];
    assert.equal(f.writes, 0);
    await assert.rejects(() =>
      f.ledger.decide("1", row.id, "accept", { confirmed: "yes" }),
    );
    await assert.rejects(() =>
      f.ledger.decide("2", row.id, "accept", { confirmed: true }),
    );
    await Promise.all([
      f.ledger.decide("1", row.id, "accept", { confirmed: true }),
      f.ledger.decide("1", row.id, "decline"),
    ]);
    await pending;
    assert.equal(f.writes, 1);
    assert.equal(f.calls.length, 1);
    const another = f.ledger.execute("2", 2, "executor", "execute", {
      code: "form",
    });
    await until(() => f.ledger.interactions("2").length === 1);
    f.ledger.cancelConversation("2");
    await another.catch(() => {});
    assert.equal(f.writes, 1);
  } finally {
    await f.close();
  }
});
test("actual Executor schema advances each request once, survives restart and never reruns program", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute("1", 1, "executor", "execute", {
      code: "chain-first",
    });
    let row = f.ledger.interactions("1")[0];
    await f.restart();
    await Promise.all([
      f.ledger.decide("1", row.id, "accept", {}),
      f.ledger.decide("1", row.id, "accept", {}),
    ]);
    assert.equal(f.writes, 0);
    assert.equal(f.calls.length, 2);
    const second = f.ledger
      .interactions("1")
      .find((i) => i.state === "pending")!;
    assert.notEqual(second.id, row.id);
    await f.ledger.decide("1", row.id, "accept", {});
    assert.equal(f.calls.length, 2);
    await f.ledger.decide("1", second.id, "accept", {});
    assert.equal(f.writes, 1);
    assert.equal(f.calls.filter((c) => c.tool === "execute").length, 1);
    assert.deepEqual(f.calls[1].args, {
      requestId: "chain-first",
      response: { action: "accept", content: {} },
    });
    row = second;
    await f.restart();
    await f.ledger.decide("1", row.id, "accept", {});
    assert.equal(f.writes, 1);
  } finally {
    await f.close();
  }
});
test("legacy pause, Executor failure/busy/unavailable/capacity states fail closed; no automated repeats", async () => {
  const f = await fixture();
  try {
    for (const [n, code] of [
      "legacy",
      "failure",
      "busy",
      "unavailable",
      "capacity-exceeded",
      "browser",
    ].entries()) {
      const result = await f.ledger.execute(
        String(n + 1),
        n + 1,
        "executor",
        "execute",
        { code },
      );
      assert.equal(result.isError, true);
      if (code === "browser")
        assert.doesNotMatch(JSON.stringify(result), /opaque-value|approvalUrl/);
      assert.notEqual(f.ledger.list(String(n + 1))[0].state, "done");
    }
    assert.equal(f.calls.length, 6);
    assert.equal(f.writes, 0);
  } finally {
    await f.close();
  }
});
test("restart after durable resume claim cannot send a second decision even if outcome was lost", async () => {
  const f = await fixture();
  try {
    await f.ledger.execute("1", 1, "executor", "execute", { code: "inflight" });
    const row = f.ledger.interactions("1")[0];
    // Simulate the precise crash boundary after atomic claim and before result persistence.
    f.store.run(
      "UPDATE mcp_interactions SET state='responded',response=? WHERE id=?",
      JSON.stringify({ action: "accept", content: {} }),
      row.id,
    );
    f.store.run("UPDATE mcp_calls SET state='running' WHERE id=?", row.callId);
    await f.restart();
    assert.equal(f.ledger.list("1")[0].state, "uncertain");
    await f.ledger.decide("1", row.id, "accept", {});
    await assert.rejects(() =>
      f.ledger.execute("1", 1, "executor", "execute", { code: "inflight" }),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes, 0);
  } finally {
    await f.close();
  }
});
