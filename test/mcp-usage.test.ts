import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MCP_USAGE, Runtime, mcpUsageText } from "../src/runtime.js";
import { McpGateway, formatMcpStatus, type McpCatalog } from "../src/mcp.js";
import { configureTelegram } from "../src/telegram-polling.js";
import type { Registry } from "@earendil-works/pi-durable";

test("formatMcpStatus mostra erro, contagem e nomes originais", () => {
  const servers: McpCatalog[] = [
    {
      server: "executor",
      mode: "direct",
      tools: [],
      error:
        "MCP refused authentication (HTTP 401). Verifique o token ou o método de login exigido pelo servidor.",
    },
    {
      server: "other",
      mode: "direct",
      tools: [
        {
          name: "search",
          description: "http://secret.example/token",
          inputSchema: { type: "object" },
          operation: "direct",
        },
        {
          name: "call",
          description: "",
          inputSchema: { type: "object" },
          operation: "direct",
        },
      ],
    },
  ];
  const text = formatMcpStatus(servers);
  assert.match(text, /executor: unavailable — MCP refused authentication/);
  assert.match(text, /other: connected — 2 tool/);
  assert.match(text, /search, call/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /secret\.example/);
});

test("mcp-usage fica de fora sem ferramentas e não autoriza resume", () => {
  assert.equal(mcpUsageText([]), undefined);
  assert.equal(
    mcpUsageText([{ error: "falhou", tools: [{ name: "search" }] }]),
    undefined,
  );
  const text = mcpUsageText([{ tools: [{ name: "search" }] }]);
  assert.equal(text, MCP_USAGE);
  assert.match(text!, /search and describe/);
  assert.match(text!, /call or execute/);
  assert.match(text!, /Never call resume yourself/);
  assert.match(text!, /never accept an approval on the user's behalf/);
  assert.match(text!, /scheduled run cannot wait for a card/);
});

test("a seção mcp-usage acompanha o catálogo descoberto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-usage-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [];
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "123:synthetic-only", users: ["42"], chats: ["-100123"] },
        { id: 123 },
      ),
  });
  const registry = (
    app as unknown as {
      registry: Registry;
    }
  ).registry;
  const usage = () =>
    registry
      .snapshot()
      .extension("mcp-direct")
      ?.sections?.find((section) => section.key === "mcp-usage");
  try {
    assert.equal(
      await usage()?.render(undefined as never, undefined as never),
      undefined,
    );
    gateway.catalog = async () => [
      {
        server: "executor",
        mode: "direct",
        tools: [
          {
            name: "search",
            description: "",
            inputSchema: { type: "object" },
            operation: "direct",
          },
        ],
      },
    ];
    await app.refreshMcpTools();
    assert.equal(
      await usage()?.render(undefined as never, undefined as never),
      MCP_USAGE,
    );
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP tools keep name order and schema key order across a rediscovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-order-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const gateway = new McpGateway([
    { name: "executor", url: "http://127.0.0.1:1/mcp", mode: "direct" },
  ]);
  const schema = (zFirst: boolean) =>
    (zFirst
      ? {
          type: "object",
          properties: { z: { type: "string" }, a: { type: "number" } },
        }
      : {
          properties: { a: { type: "number" }, z: { type: "string" } },
          type: "object",
        }) as McpCatalog["tools"][number]["inputSchema"];
  const tool = (
    name: string,
    zFirst: boolean,
  ): McpCatalog["tools"][number] => ({
    name,
    description: `${name} tool`,
    inputSchema: schema(zFirst),
    operation: "direct",
  });
  gateway.catalog = async () => [
    {
      server: "executor",
      mode: "direct",
      tools: [tool("search", true), tool("call", true)],
    },
  ];
  const app = await Runtime.open({ dir, models, gateway });
  const listed = () =>
    (app as unknown as { registry: Registry }).registry
      .snapshot()
      .extension("mcp-direct")
      ?.tools?.map((item) => ({
        name: item.name,
        description: item.description,
        parameters: JSON.parse(JSON.stringify(item.parameters)) as unknown,
      })) ?? [];
  try {
    await app.refreshMcpTools();
    const first = listed();
    assert.deepEqual(
      first.map((item) => item.description),
      ["MCP executor / call. call tool", "MCP executor / search. search tool"],
    );
    gateway.catalog = async () => [
      {
        server: "executor",
        mode: "direct",
        tools: [tool("call", false), tool("search", false)],
      },
    ];
    await app.refreshMcpTools();
    assert.deepEqual(listed(), first);
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});
