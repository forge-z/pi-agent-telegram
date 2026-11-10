import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxContentBlock,
} from "@earendil-works/pi-ai/providers/faux";
import { assistantClock, Runtime } from "../src/runtime.js";

/**
 * Before this fix, the same three turns measured on the deepseek-flash wire
 * messages (bytes of JSON-joined messages):
 *   18:04 → 18:05 user turn: common prefix 1980 of 2290, split in the system
 *     clock ("18:04 UTC" vs "18:05 UTC"). The previous request was not a prefix.
 *   same-minute tool follow-up: 2406 of 2406, append only.
 *   next calendar day: common prefix 1948 of 2642, split on the system date.
 * After the fix the same turns are append-only (previous length equals the
 * common prefix): 2246 of 2472, 2472 of 2708, 2708 of 2935. A later quiet task
 * and its tool follow-up stay append-only too (2935 of 3385, 3385 of 3627)
 * even when the clock and the seen-chat line change during the run. The quiet
 * request adds the notify tool; interactive requests do not. That tool-list
 * boundary is intentional.
 * Tools, thinking params, and replayed reasoning_content were already stable.
 * Cache hit is cacheRead / prompt from the provider usage, the same ratio pi
 * reports (DeepSeek prompt_cache_hit_tokens / prompt_tokens). The gap was the
 * prefix, not the formula.
 */

interface Wire {
  messages: { role: string; content?: unknown; reasoning_content?: string }[];
  tools?: { function?: { name?: string } }[];
  thinking?: unknown;
  reasoning_effort?: unknown;
}

function think(text: string): FauxContentBlock {
  return {
    type: "thinking",
    thinking: text,
    thinkingSignature: "reasoning_content",
  };
}

function answer(text: string, extra: FauxContentBlock[] = []) {
  return fauxAssistantMessage(
    [think(`thinking:${text}`), fauxText(text), ...extra],
    {
      stopReason: extra.some((block) => block.type === "toolCall")
        ? "toolUse"
        : "stop",
    },
  );
}

async function wire(model: Model<"openai-completions">, messages: Message[]) {
  let body = "";
  const events = stream(model, { messages } as Parameters<typeof stream>[1], {
    apiKey: "test",
    reasoningEffort: "high",
    fetch: async (_url, init) => {
      const raw = init?.body;
      body =
        typeof raw === "string"
          ? raw
          : raw
            ? Buffer.from(raw as ArrayBuffer).toString("utf8")
            : "";
      const chunk = (payload: unknown) =>
        `data: ${JSON.stringify(payload)}\n\n`;
      const sse = [
        chunk({
          id: "x",
          choices: [
            {
              index: 0,
              delta: { content: "ok", reasoning_content: "r" },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          id: "x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            prompt_cache_hit_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  for await (const event of events) void event;
  assert.ok(body, "provider request was not built");
  return JSON.parse(body) as Wire;
}

function joined(messages: unknown[]) {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

function textOf(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

test("consecutive deepseek turns keep the previous request as a prefix", async () => {
  const captured: Message[][] = [];
  const record = (ctx: { messages: readonly Message[] }) => {
    captured.push(structuredClone(ctx.messages) as Message[]);
  };
  const faux = fauxProvider({
    provider: "deepseek",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 384_000,
      },
    ],
  });
  let clock = Date.parse("2026-11-09T18:04:00Z");
  const env = { TZ: "UTC" };
  const day = assistantClock(env, new Date(clock));
  const nextDay = assistantClock(env, new Date(clock + 24 * 60 * 60 * 1000));
  const models = createModels();
  models.setProvider(faux.provider);
  const official = createModels();
  official.setProvider(deepseekProvider());
  const deepseek = official.getModel("deepseek", "deepseek-flash");
  assert.ok(deepseek);
  const dir = await mkdtemp(join(tmpdir(), "pi-prefix-"));
  const app = await Runtime.open({
    dir,
    gateway: { catalog: async () => [] },
    models,
    provider: "deepseek",
    modelId: "deepseek-flash",
    effort: "high",
    env,
    now: () => clock,
  });
  faux.setResponses([
    async (ctx) => {
      record(ctx);
      return answer("one");
    },
    async (ctx) => {
      record(ctx);
      return answer("call", [
        fauxToolCall("tasks_list", {}, { id: "call_tasks" }),
      ]);
    },
    async (ctx) => {
      record(ctx);
      return answer("two");
    },
    async (ctx) => {
      record(ctx);
      return answer("three");
    },
    async (ctx) => {
      record(ctx);
      clock += 24 * 60 * 60 * 1000;
      app.store.run(
        "INSERT INTO telegram_seen(chat,messageId,author,excerpt) VALUES ('42',78,'usuário','linha nova')",
      );
      return answer("digest", [
        fauxToolCall("tasks_list", {}, { id: "call_digest" }),
      ]);
    },
    async (ctx) => {
      record(ctx);
      return answer("done");
    },
  ]);
  const idle = async (id: string) => {
    await (await app.conversation(id)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  try {
    const id = await app.create();
    await app.submit(id, "turn-1", "first question");
    await idle(id);
    clock += 60_000;
    await app.submit(id, "turn-2", "second question");
    await idle(id);
    clock += 24 * 60 * 60 * 1000;
    await app.submit(id, "turn-3", "third question");
    await idle(id);
    app.store.run(
      "INSERT INTO telegram_conversations(conversationId,chat,user) VALUES (?,?,?)",
      id,
      "42",
      "7",
    );
    app.store.run(
      "INSERT INTO telegram_seen(chat,messageId,author,excerpt) VALUES ('42',77,'usuário','pode olhar isso')",
    );
    await app.submit(id, "task:1", "digest the inbox", "task");
    await idle(id);
    assert.equal(captured.length, 6);
    const bodies: Wire[] = [];
    for (const messages of captured)
      bodies.push(
        await wire(deepseek as Model<"openai-completions">, messages),
      );
    const system = JSON.stringify(bodies[0]!.messages[0]);
    for (const body of bodies) {
      assert.equal(JSON.stringify(body.messages[0]), system);
      assert.doesNotMatch(textOf(body.messages[0]!), /Current date/);
      assert.doesNotMatch(textOf(body.messages[0]!), /pode olhar isso/);
      assert.doesNotMatch(textOf(body.messages[0]!), /O texto final/);
      assert.equal(body.reasoning_effort, "high");
      assert.deepEqual(body.thinking, { type: "enabled" });
    }
    const appendOnly = (from: number, to: number) => {
      const previous = joined(bodies[from]!.messages);
      const next = joined(bodies[to]!.messages);
      assert.equal(
        next.startsWith(previous),
        true,
        `${from}->${to} diverged at ${next.slice(previous.length, previous.length + 160)}`,
      );
      assert.ok(bodies[to]!.messages.length > bodies[from]!.messages.length);
      assert.equal(next.length > previous.length, true);
    };
    appendOnly(0, 1);
    appendOnly(1, 2);
    appendOnly(2, 3);
    appendOnly(3, 4);
    appendOnly(4, 5);
    for (const index of [0, 1, 2, 3]) {
      assert.equal(
        JSON.stringify(bodies[index]!.tools),
        JSON.stringify(bodies[0]!.tools),
      );
      assert.equal(
        bodies[index]!.tools?.some((tool) => tool.function?.name === "notify"),
        false,
      );
    }
    assert.equal(
      JSON.stringify(bodies[4]!.tools),
      JSON.stringify(bodies[5]!.tools),
    );
    assert.equal(
      bodies[4]!.tools?.some((tool) => tool.function?.name === "notify"),
      true,
    );
    const users = bodies.map((body) =>
      body.messages.filter((message) => message.role === "user").map(textOf),
    );
    assert.match(users[0]![0]!, /first question/);
    assert.ok(users[0]![0]!.endsWith(day));
    assert.match(users[1]![1]!, /second question/);
    assert.ok(users[1]![1]!.endsWith(day));
    assert.equal(users[3]![0], users[0]![0]);
    assert.match(users[3]![2]!, /third question/);
    assert.ok(users[3]![2]!.endsWith(nextDay));
    const task = users[4]!.at(-1)!;
    const promptAt = task.indexOf("digest the inbox");
    const deliveryAt = task.indexOf("O texto final deste run não é entregue");
    const seenAt = task.indexOf("#77 usuário: pode olhar isso");
    const dateAt = task.lastIndexOf(nextDay);
    assert.ok(promptAt >= 0 && promptAt < deliveryAt);
    assert.ok(deliveryAt < seenAt);
    assert.ok(seenAt < dateAt);
    assert.ok(task.endsWith(nextDay));
    assert.doesNotMatch(task, /linha nova/);
    assert.equal(users[5]!.at(-1), task);
    assert.equal(
      bodies[2]!.messages.some(
        (message) => message.reasoning_content === "thinking:call",
      ),
      true,
    );
    assert.equal(
      JSON.stringify(
        bodies[2]!.messages.find(
          (message) => message.reasoning_content === "thinking:call",
        ),
      ),
      JSON.stringify(
        bodies[5]!.messages.find(
          (message) => message.reasoning_content === "thinking:call",
        ),
      ),
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
