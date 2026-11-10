import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_EXPIRE_MS,
  APPROVAL_REMIND_MS,
  LoopGuard,
  MAX_IDENTICAL_CALLS,
  approvalAction,
  scheduledApprovalRefusal,
  stableJson,
} from "../src/guards.js";

test("stable JSON ignores object key order but not array order", () => {
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(stableJson({ a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4}}');
  assert.equal(stableJson([1, 2]), "[1,2]");
  assert.notEqual(stableJson([1, 2]), stableJson([2, 1]));
  assert.equal(stableJson({ a: undefined, b: null }), '{"b":null}');
});

test("loop guard refuses the same call after five occurrences in one turn", () => {
  const guard = new LoopGuard();
  for (let index = 0; index < MAX_IDENTICAL_CALLS; index += 1)
    assert.equal(guard.check("tasks_list", { b: 1, a: 2 }), null);
  const refusal = guard.check("tasks_list", { a: 2, b: 1 });
  assert.match(refusal!, /already made this exact tasks_list call 5 times/);
  assert.match(refusal!, /Change approach/);
  // Another call is not the repeated one, and reset starts a fresh turn.
  assert.equal(guard.check("tasks_list", { a: 3 }), null);
  guard.reset();
  assert.equal(guard.check("tasks_list", { a: 2, b: 1 }), null);
});

test("approval sweep reminds once after four hours and expires after twenty-four", () => {
  assert.equal(approvalAction(APPROVAL_REMIND_MS - 1, false), null);
  assert.equal(approvalAction(APPROVAL_REMIND_MS, false), "remind");
  assert.equal(approvalAction(APPROVAL_REMIND_MS, true), null);
  assert.equal(approvalAction(APPROVAL_EXPIRE_MS, true), "expire");
});

test("a scheduled run blocks an approval-requiring call but still reads", () => {
  assert.match(scheduledApprovalRefusal(true, false)!, /needs approval/);
  assert.equal(scheduledApprovalRefusal(true, true), null);
  assert.equal(scheduledApprovalRefusal(false, false), null);
});

test("eight identical Executor calls stop after five", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxProvider, fauxAssistantMessage } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { Runtime } = await import("../src/runtime.js");
  const { McpGateway, mcpToolName } = await import("../src/mcp.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-loop-executor-"));
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [
    {
      server: "executor",
      mode: "direct",
      tools: [
        {
          name: "call",
          description: "",
          inputSchema: { type: "object" },
          operation: "direct",
        },
      ],
    },
  ];
  gateway.connectionBinding = async () => "binding";
  let dispatched = 0;
  gateway.callDirect = (async () => {
    dispatched += 1;
    return { content: [{ type: "text", text: "ok" }] };
  }) as unknown as typeof gateway.callDirect;
  const faux = fauxProvider();
  const target = "tools.tinyfish.search.root.search";
  faux.setResponses([
    ...Array.from({ length: 8 }, (_, index) =>
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: `search-${index}`,
          name: mcpToolName("executor", "call"),
          arguments: {
            nonce: index,
            calls: { path: target, input: { query: "agenda" } },
          },
        },
        { stopReason: "toolUse" },
      ),
    ),
    (transcript) => {
      const results = transcript.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 8);
      for (const result of results.slice(0, 5))
        assert.equal(result.isError, false);
      for (const result of results.slice(5)) {
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /Change approach/);
        assert.match(JSON.stringify(result), /search\.root\.search/);
      }
      return fauxAssistantMessage("fim");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "loop-exec", "busca de novo", "web");
    await (await app.conversation(id)).waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(dispatched, 5);
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime refuses the sixth identical tool call in one turn", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxProvider, fauxAssistantMessage } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { Runtime } = await import("../src/runtime.js");
  const dir = await mkdtemp(join(tmpdir(), "pi-loop-guard-"));
  const faux = fauxProvider();
  faux.setResponses([
    ...Array.from({ length: 6 }, (_, index) =>
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: `same-${index}`,
          name: "tasks_list",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
    ),
    (transcript) => {
      const results = transcript.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 6);
      assert.equal(results[4].isError, false);
      assert.equal(results[5].isError, true);
      assert.match(JSON.stringify(results[5]), /Change approach/);
      assert.match(
        JSON.stringify(results[5]),
        /Never poll that work in a loop/,
      );
      return fauxAssistantMessage("fim");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    gateway: { catalog: async () => [] },
    models,
    env: { INSTABOX_MACHINE_ID: "machine-1" },
  });
  try {
    const id = await app.create();
    await app.submit(id, "loop", "liste a agenda", "web");
    await (await app.conversation(id)).waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
