import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentTools, type Usage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  UsageDoc,
  type ConversationId,
  type Registry,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Runtime } from "../src/runtime.js";
import {
  CONVERSATION_USAGE_READ_ERROR,
  CONVERSATION_USAGE_TOOL_NAME,
  conversationUsageTool,
  summarizeConversationUsage,
  type ConversationUsageReport,
} from "../src/conversation-usage.js";

const gateway = { catalog: async () => [] };
const OTHER_MODEL = "vazamento/outra-conversa";
const OTHER_INPUT = 424242;
const THIS_MODEL = "marcado/esta-conversa";

function usage(partial: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: Partial<Usage["cost"]>;
}): Usage {
  const input = partial.input ?? 0;
  const output = partial.output ?? 0;
  const cacheRead = partial.cacheRead ?? 0;
  const cacheWrite = partial.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(partial.cacheWrite1h !== undefined
      ? { cacheWrite1h: partial.cacheWrite1h }
      : {}),
    ...(partial.reasoning !== undefined
      ? { reasoning: partial.reasoning }
      : {}),
    totalTokens: partial.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...partial.cost,
    },
  };
}

function registryOf(app: Runtime) {
  return (app as unknown as { registry: Registry }).registry;
}

function installedUsageTool(app: Runtime) {
  const tool = registryOf(app)
    .snapshot()
    .extension("personal-assistant")
    ?.tools?.find((item) => item.name === CONVERSATION_USAGE_TOOL_NAME);
  assert.ok(
    tool,
    "conversation_usage must be installed with the other internal tools",
  );
  return tool;
}

async function seed(
  app: Runtime,
  id: string,
  bucket: "models" | "tools",
  key: string,
  value: Usage,
) {
  await app.harness.commit(async (tx) => {
    const doc = await tx.doc(UsageDoc, Number(id) as ConversationId);
    doc[bucket][key] = value;
  }, context);
}

async function readUsage(
  app: Runtime,
  id: string,
): Promise<ConversationUsageReport> {
  const seen: { token: unknown; conversationId: ConversationId }[] = [];
  const api = {
    conversationId: Number(id) as ConversationId,
    snapshot: async (
      token: typeof UsageDoc,
      conversationId: ConversationId,
      ctx: typeof context,
    ) => {
      seen.push({ token, conversationId });
      return app.harness.snapshot(token, conversationId, ctx);
    },
  };
  const result = await installedUsageTool(app).execute(
    {},
    api as unknown as ToolExecutionApi,
    context,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.token, UsageDoc);
  assert.equal(String(seen[0]!.conversationId), id);
  assert.equal(result.isError, undefined);
  const text = result.output?.[0];
  assert.equal(text?.type, "text");
  assert.equal(typeof text.text, "string");
  return JSON.parse(text.text) as ConversationUsageReport;
}

test("zero catalog rates omit USD and still return tokens", () => {
  const report = summarizeConversationUsage({
    models: {
      "llm/legacy": usage({
        input: 1000,
        output: 40,
        cacheRead: 200,
        cacheWrite: 50,
        reasoning: 15,
        cacheWrite1h: 10,
        totalTokens: 1290,
      }),
    },
    tools: {},
  });
  assert.equal(report.scope, "conversa atual");
  assert.deepEqual(report.tokens, {
    input: 1000,
    output: 40,
    cacheRead: 200,
    cacheWrite: 50,
    prompt: 1250,
    totalTokens: 1290,
    reasoning: 15,
    cacheWrite1h: 10,
  });
  assert.equal(report.cacheHitRate, 0.16);
  assert.deepEqual(report.usd, { available: false, reason: "indisponível" });
  assert.equal("total" in report.usd, false);
  assert.equal(report.models[0]!.usd.available, false);
  assert.match(report.note, /indisponível/);
  assert.match(report.note, /não diga que a inferência foi gratuita/i);
  assert.doesNotMatch(JSON.stringify(report.usd), /0\.00|"total":0/);
});

test("subsets are not added again, and priced catalog or provider totals are reported", () => {
  const report = summarizeConversationUsage({
    models: {
      "openai/priced": usage({
        input: 10,
        output: 8,
        cacheRead: 4,
        cacheWrite: 6,
        reasoning: 3,
        cacheWrite1h: 2,
        totalTokens: 28,
        cost: {
          input: 0.5,
          output: 0.25,
          cacheRead: 0.125,
          cacheWrite: 0.125,
          total: 1,
        },
      }),
      "openrouter/billed": usage({
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: {
          input: 9,
          output: 9,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.25,
          totalFromProvider: true,
        },
      }),
    },
    tools: {
      search: usage({
        input: 2,
        output: 1,
        totalTokens: 3,
        cost: {
          input: 0.25,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.25,
        },
      }),
    },
  });
  const priced = report.models.find((model) => model.id === "openai/priced")!;
  assert.equal(priced.tokens.output, 8);
  assert.equal(priced.tokens.cacheWrite, 6);
  assert.equal(priced.tokens.prompt, 20);
  assert.equal(priced.tokens.reasoning, 3);
  assert.equal(priced.tokens.cacheWrite1h, 2);
  assert.deepEqual(priced.usd, {
    available: true,
    total: 1,
    source: "catalog",
  });
  const billed = report.models.find(
    (model) => model.id === "openrouter/billed",
  )!;
  assert.deepEqual(billed.usd, {
    available: true,
    total: 0.25,
    source: "provider",
  });
  assert.equal(report.tools[0]!.name, "search");
  assert.equal(report.tokens.input, 16);
  assert.equal(report.tokens.output, 11);
  assert.equal(report.tokens.prompt, 26);
  assert.equal(report.tokens.reasoning, undefined);
  assert.deepEqual(report.usd, {
    available: true,
    total: 1.5,
    source: "mixed",
  });
  assert.equal(report.cacheHitRate, Math.round((4 / 26) * 1e6) / 1e6);
});

test("a zero-rate bucket makes the conversation total unavailable without erasing priced models", () => {
  const report = summarizeConversationUsage({
    models: {
      "openai/priced": usage({
        input: 10,
        totalTokens: 10,
        cost: {
          input: 1.5,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 1.5,
        },
      }),
      "llm/legacy": usage({ input: 80, output: 5, totalTokens: 85 }),
    },
    tools: {},
  });
  assert.deepEqual(report.usd, { available: false, reason: "indisponível" });
  assert.equal(report.tokens.input, 90);
  assert.equal(report.tokens.output, 5);
  assert.deepEqual(
    report.models.find((model) => model.id === "openai/priced")!.usd,
    { available: true, total: 1.5, source: "catalog" },
  );
  assert.equal(
    report.models.find((model) => model.id === "llm/legacy")!.usd.available,
    false,
  );
  assert.match(report.note, /usd.available true/);
});

test("provider-reported zero is a real figure, and an empty ledger is zero consumption", () => {
  const reported = summarizeConversationUsage({
    models: {
      "openai/free-tier": usage({
        input: 12,
        output: 3,
        totalTokens: 15,
        cost: { total: 0, totalFromProvider: true },
      }),
    },
    tools: {},
  });
  assert.deepEqual(reported.usd, {
    available: true,
    total: 0,
    source: "provider",
  });
  assert.equal(reported.tokens.input, 12);
  const empty = summarizeConversationUsage(undefined);
  assert.deepEqual(empty.tokens, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    prompt: 0,
    totalTokens: 0,
  });
  assert.equal(empty.cacheHitRate, null);
  assert.deepEqual(empty.usd, { available: true, total: 0, source: "catalog" });
  assert.deepEqual(empty.models, []);
  assert.deepEqual(empty.tools, []);
  assert.match(empty.note, /Não há consumo/);
});

test("a failed read does not echo the cause", async () => {
  const result = await conversationUsageTool.execute(
    {},
    {
      conversationId: 2 as ConversationId,
      snapshot: async () => {
        throw new Error("conversation 2 secret ledger");
      },
    } as unknown as ToolExecutionApi,
    context,
  );
  assert.equal(result.isError, true);
  const text = result.output?.[0];
  assert.equal(text?.type, "text");
  assert.equal(text.text, CONVERSATION_USAGE_READ_ERROR);
  assert.doesNotMatch(text.text, /secret|conversation 2/);
});

test("the tool is offered like the other internal tools and reads only the current conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversation-usage-"));
  const faux = fauxProvider();
  faux.setResponses([
    async (transcript) => {
      const names = getCurrentTools(transcript.messages).map(
        (tool) => tool.name,
      );
      assert.ok(names.includes(CONVERSATION_USAGE_TOOL_NAME));
      assert.ok(names.includes("tasks_list"));
      const usageTool = getCurrentTools(transcript.messages).find(
        (tool) => tool.name === CONVERSATION_USAGE_TOOL_NAME,
      );
      assert.match(usageTool?.description ?? "", /consumo/);
      assert.match(usageTool?.description ?? "", /tokens/);
      assert.match(usageTool?.description ?? "", /custo/);
      assert.match(usageTool?.description ?? "", /desta conversa/);
      assert.doesNotMatch(JSON.stringify(usageTool), /conversationId/);
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "usage",
          name: CONVERSATION_USAGE_TOOL_NAME,
          arguments: {},
        },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("O consumo desta conversa está acima."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({ dir, gateway, models });
  try {
    const current = await app.create();
    const other = await app.create();
    await seed(
      app,
      current,
      "models",
      THIS_MODEL,
      usage({
        input: 111,
        output: 7,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 168,
        cost: {
          input: 1.5,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 1.5,
        },
      }),
    );
    await seed(
      app,
      current,
      "tools",
      "search",
      usage({
        input: 4,
        output: 1,
        totalTokens: 5,
        cost: {
          input: 0.25,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.25,
        },
      }),
    );
    await seed(
      app,
      other,
      "models",
      OTHER_MODEL,
      usage({
        input: OTHER_INPUT,
        output: 9,
        totalTokens: OTHER_INPUT + 9,
        cost: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
      }),
    );
    const session = await app.harness.usage(context);
    assert.equal(session.models[OTHER_MODEL]?.input, OTHER_INPUT);
    assert.equal(session.models[THIS_MODEL]?.input, 111);

    const direct = await readUsage(app, current);
    assert.equal(
      direct.models.find((model) => model.id === THIS_MODEL)?.tokens.input,
      111,
    );
    assert.equal(direct.tools[0]?.name, "search");
    assert.deepEqual(direct.usd, {
      available: true,
      total: 1.75,
      source: "catalog",
    });
    assert.equal(JSON.stringify(direct).includes(OTHER_MODEL), false);
    assert.equal(JSON.stringify(direct).includes(String(OTHER_INPUT)), false);

    const otherDirect = await readUsage(app, other);
    assert.equal(otherDirect.models[0]?.id, OTHER_MODEL);
    assert.equal(otherDirect.tokens.input, OTHER_INPUT);
    assert.equal(JSON.stringify(otherDirect).includes(THIS_MODEL), false);

    const installed = installedUsageTool(app);
    assert.equal(installed.replay, "safe");
    assert.equal(installed.deferred, undefined);
    assert.equal(
      JSON.stringify(installed.parameters).includes("conversationId"),
      false,
    );
    const names = (
      await (await app.conversation(current)).agent(context)
    ).tools.map((tool) => tool.name);
    assert.ok(names.includes(CONVERSATION_USAGE_TOOL_NAME));
    assert.ok(names.includes("tasks_list"));

    await app.submit(
      current,
      "usage",
      "consegue ver o consumo de tokens dessa conversa?",
      "telegram",
      "42",
    );
    await (await app.conversation(current)).waitForIdle(context);
    const entries = await (
      await app.conversation(current)
    ).entries({}, 100, undefined, context);
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") {
        texts.push(value);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const item of Object.values(value)) walk(item);
    };
    walk(entries);
    const rendered = texts.join("\n");
    assert.match(rendered, new RegExp(THIS_MODEL));
    assert.doesNotMatch(rendered, new RegExp(OTHER_MODEL));
    assert.doesNotMatch(rendered, new RegExp(String(OTHER_INPUT)));
    const report = JSON.parse(
      texts.find((text) => text.includes('"scope":"conversa atual"')) ?? "{}",
    ) as ConversationUsageReport;
    assert.equal(report.scope, "conversa atual");
    assert.ok(report.tokens.input > 111);
    assert.equal(
      report.models.find((model) => model.id === THIS_MODEL)?.tokens.input,
      111,
    );
    assert.equal(
      report.models.find((model) => model.id === "faux/faux-1")?.usd.available,
      false,
    );
    assert.deepEqual(report.usd, { available: false, reason: "indisponível" });
    assert.equal(report.tools[0]?.name, "search");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
