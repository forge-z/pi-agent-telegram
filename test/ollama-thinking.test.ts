import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { environmentModels, isOllamaEndpoint } from "../src/config.js";

const key = "synthetic-key";

function show(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function thinking(values: unknown[] = [false, true]) {
  return {
    capabilities: ["completion", "thinking"],
    thinking: { values, default: values[0] },
  };
}

function levels(
  models: Awaited<ReturnType<typeof environmentModels>>,
  id: string,
) {
  const model = models.getModel("llm", id);
  assert.ok(model);
  return getSupportedThinkingLevels(model);
}

async function register(
  baseUrl: string,
  models: string,
  fetchImpl: typeof fetch,
) {
  return environmentModels(
    { LLM_BASE_URL: baseUrl, LLM_API_KEY: key, LLM_MODELS: models },
    { fetch: fetchImpl },
  );
}

function sse() {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(
    [
      chunk({
        id: "x",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      }),
      chunk({
        id: "x",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** What the OpenAI-compatible chat request carries for one effort. Off omits the option, as the harness does. */
async function sent(
  model: Model<"openai-completions">,
  effort: ModelThinkingLevel,
) {
  let url = "";
  let raw = "";
  const events = stream(
    model,
    {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as Parameters<typeof stream>[1],
    {
      apiKey: "test",
      ...(effort === "off" ? {} : { reasoningEffort: effort }),
      fetch: async (input, init) => {
        url = String(input);
        const body = init?.body;
        raw =
          typeof body === "string"
            ? body
            : body
              ? Buffer.from(body as ArrayBuffer).toString("utf8")
              : "";
        return sse();
      },
    },
  );
  for await (const event of events) void event;
  const parsed = JSON.parse(raw) as {
    reasoning_effort?: string;
    think?: unknown;
    thinking?: unknown;
  };
  return { url, ...parsed };
}

test("Ollama endpoints are the cloud host, port 11434, or an /api path", () => {
  assert.equal(isOllamaEndpoint("https://ollama.com/v1"), true);
  assert.equal(isOllamaEndpoint("https://api.ollama.com/v1"), true);
  assert.equal(isOllamaEndpoint("http://127.0.0.1:11434/v1"), true);
  assert.equal(isOllamaEndpoint("https://models.example/api/v1"), true);
  assert.equal(isOllamaEndpoint("https://llm.example/v1"), false);
  assert.equal(isOllamaEndpoint("http://127.0.0.1:11435/v1"), false);
  assert.equal(isOllamaEndpoint("https://notollama.com/v1"), false);
});

test("a thinking Ollama model offers off/low/medium/high and the chat request carries reasoning_effort", async () => {
  const seen: { url: string; body: string; authorization: string }[] = [];
  const models = await register(
    "https://ollama.com/v1",
    "deepseek-v4.1-flash:cloud",
    async (url, init) => {
      seen.push({
        url: String(url),
        body: String(init?.body ?? ""),
        authorization: String(
          new Headers(init?.headers).get("authorization") ?? "",
        ),
      });
      return show(thinking());
    },
  );
  assert.deepEqual(seen, [
    {
      url: "https://ollama.com/api/show",
      body: JSON.stringify({ model: "deepseek-v4.1-flash:cloud" }),
      authorization: `Bearer ${key}`,
    },
  ]);
  assert.deepEqual(levels(models, "deepseek-v4.1-flash:cloud"), [
    "off",
    "low",
    "medium",
    "high",
  ]);
  const model = models.getModel(
    "llm",
    "deepseek-v4.1-flash:cloud",
  ) as Model<"openai-completions">;
  const off = await sent(model, "off");
  const low = await sent(model, "low");
  const medium = await sent(model, "medium");
  const high = await sent(model, "high");
  for (const body of [off, low, medium, high]) {
    assert.match(body.url, /ollama\.com\/v1\/chat\/completions$/);
    assert.equal(body.think, undefined);
    assert.equal(body.thinking, undefined);
  }
  assert.equal(off.reasoning_effort, "none");
  assert.equal(low.reasoning_effort, "low");
  assert.equal(medium.reasoning_effort, "medium");
  assert.equal(high.reasoning_effort, "high");
});

test("named thinking.values are the levels shown, including on port 11434 and an /api base", async () => {
  const probe = async (url: string | URL | Request) => {
    assert.match(String(url), /\/api\/show$/);
    return show(thinking(["low", "high", "max"]));
  };
  const local = await register(
    "http://127.0.0.1:11434/v1",
    "qwen3:local",
    probe,
  );
  assert.deepEqual(levels(local, "qwen3:local"), ["off", "low", "high", "max"]);
  const rooted = await register(
    "https://models.example/api/v1",
    "qwen3:rooted",
    async (url) => {
      assert.equal(String(url), "https://models.example/api/show");
      return show(thinking(["low", "medium"]));
    },
  );
  assert.deepEqual(levels(rooted, "qwen3:rooted"), ["off", "low", "medium"]);
});

test("an Ollama model without thinking keeps only off", async () => {
  const calls: string[] = [];
  const models = await register(
    "https://ollama.com/v1",
    "embed-only,disabled-think",
    async (url, init) => {
      calls.push(String(url));
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "embed-only")
        return show({ capabilities: ["completion", "embedding"] });
      return show({
        capabilities: ["thinking"],
        thinking: { values: [false], default: false },
      });
    },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(levels(models, "embed-only"), ["off"]);
  assert.deepEqual(levels(models, "disabled-think"), ["off"]);
  assert.equal(models.getModel("llm", "embed-only")!.reasoning, false);
});

test("a failed Ollama probe leaves the catalog unchanged", async () => {
  const models = await register(
    "https://ollama.com/v1",
    "times-out,rejected,garbage",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === "times-out") throw new Error("offline");
      if (body.model === "rejected") return show({ error: "nope" }, 404);
      return new Response("not-json", { status: 200 });
    },
  );
  for (const id of ["times-out", "rejected", "garbage"])
    assert.deepEqual(levels(models, id), ["off"]);
});

test("an explicit LLM_MODELS level list wins over a thinking probe", async () => {
  const calls: string[] = [];
  const models = await register(
    "https://ollama.com/v1",
    "pinned|65536|8192|off+high,forced-off|65536|8192|false,standard|65536|8192|true",
    async (url) => {
      calls.push(String(url));
      return show(thinking(["low", "medium", "high"]));
    },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(levels(models, "pinned"), ["off", "high"]);
  assert.deepEqual(levels(models, "forced-off"), ["off"]);
  assert.deepEqual(levels(models, "standard"), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  const pinned = models.getModel(
    "llm",
    "pinned",
  ) as Model<"openai-completions">;
  const standard = models.getModel(
    "llm",
    "standard",
  ) as Model<"openai-completions">;
  assert.equal((await sent(pinned, "off")).reasoning_effort, "none");
  assert.equal((await sent(pinned, "high")).reasoning_effort, "high");
  assert.equal((await sent(standard, "off")).reasoning_effort, "none");
  assert.equal((await sent(standard, "minimal")).reasoning_effort, "minimal");
});

test("the same Ollama model is probed once", async () => {
  let shows = 0;
  const fetchImpl: typeof fetch = async () => {
    shows += 1;
    return show(thinking());
  };
  const first = await register(
    "https://ollama.com/v1",
    "cached-think",
    fetchImpl,
  );
  const second = await register(
    "https://ollama.com/v1",
    "cached-think",
    fetchImpl,
  );
  assert.equal(shows, 1);
  assert.deepEqual(
    levels(first, "cached-think"),
    levels(second, "cached-think"),
  );
});

test("discovery on Ollama still probes, and a non-Ollama host does not", async () => {
  const ollamaUrls: string[] = [];
  const discovered = await environmentModels(
    { LLM_BASE_URL: "https://ollama.com/v1", LLM_API_KEY: key },
    {
      fetch: async (url, init) => {
        ollamaUrls.push(String(url));
        if (String(url).endsWith("/models"))
          return show({
            data: [{ id: "discovered-think" }, { id: "discovered-plain" }],
          });
        const body = JSON.parse(String(init?.body)) as { model: string };
        return show(
          body.model === "discovered-think"
            ? thinking()
            : { capabilities: ["completion"] },
        );
      },
    },
  );
  assert.deepEqual(ollamaUrls.sort(), [
    "https://ollama.com/api/show",
    "https://ollama.com/api/show",
    "https://ollama.com/v1/models",
  ]);
  assert.deepEqual(levels(discovered, "discovered-think"), [
    "off",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(levels(discovered, "discovered-plain"), ["off"]);

  const foreignUrls: string[] = [];
  const foreign = await environmentModels(
    { LLM_BASE_URL: "https://llm.example/v1", LLM_API_KEY: key },
    {
      fetch: async (url) => {
        foreignUrls.push(String(url));
        return show({
          data: [{ id: "chat" }],
          capabilities: ["thinking"],
        });
      },
    },
  );
  assert.deepEqual(foreignUrls, ["https://llm.example/v1/models"]);
  assert.deepEqual(levels(foreign, "chat"), ["off"]);

  const listed = await environmentModels({
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: key,
    LLM_MODELS: "listed|65536|8192|off+high,plain-id",
  });
  assert.deepEqual(levels(listed, "listed"), ["off", "high"]);
  assert.deepEqual(levels(listed, "plain-id"), ["off"]);
  const listedModel = listed.getModel(
    "llm",
    "listed",
  ) as Model<"openai-completions">;
  const off = await sent(listedModel, "off");
  const high = await sent(listedModel, "high");
  assert.equal(off.reasoning_effort, "off");
  assert.equal(high.reasoning_effort, "high");
  assert.equal(off.think, undefined);
});
