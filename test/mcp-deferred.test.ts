import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Registry } from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { readConfig } from "../src/config.js";
import {
  McpGateway,
  mcpToolName,
  projectDeferredCatalog,
  type McpCatalog,
  type McpConfig,
} from "../src/mcp.js";
import {
  ASSISTANT_POLICY,
  MCP_DEFERRED_USAGE,
  MCP_USAGE,
  Runtime,
  mcpUsageText,
} from "../src/runtime.js";

const telegram = {
  TELEGRAM_BOT_TOKEN: "123:mock",
  TELEGRAM_ALLOWED_USERS: "42",
};

function registryOf(app: Runtime) {
  return (app as unknown as { registry: Registry }).registry;
}

function sectionText(app: Runtime, extension: string, key: string) {
  const found = registryOf(app)
    .snapshot()
    .extension(extension)
    ?.sections?.find((item) => item.key === key);
  return found?.render(undefined as never, undefined as never);
}

test("config accepts deferred and alwaysLoad; omitted mode stays direct", () => {
  const base = {
    ...telegram,
    EXECUTOR_TOKEN: "synthetic-executor-key",
    GH_TOKEN: "synthetic-github-key",
  };
  const omitted = readConfig({
    ...base,
    EXECUTOR_MCP_URL: "https://executor.example/mcp",
  }).mcp[0];
  assert.equal(omitted?.name, "executor");
  assert.equal(omitted?.mode, "direct");
  assert.equal(omitted?.alwaysLoad, undefined);

  const explicit = readConfig({
    ...base,
    MCP_SERVERS_JSON:
      '[{"name":"executor","url":"https://executor.example/mcp","tokenEnv":"EXECUTOR_TOKEN","mode":"direct"}]',
  }).mcp[0];
  assert.equal(explicit?.mode, "direct");
  assert.equal(explicit?.alwaysLoad, undefined);

  const deferred = readConfig({
    ...base,
    MCP_SERVERS_JSON: JSON.stringify([
      {
        name: "executor",
        url: "https://executor.example/mcp",
        tokenEnv: "EXECUTOR_TOKEN",
      },
      {
        name: "github",
        url: "https://github.example/mcp",
        tokenEnv: "GH_TOKEN",
        mode: "deferred",
        alwaysLoad: ["search_code"],
      },
    ]),
  }).mcp;
  assert.equal(deferred[0]?.mode, "direct");
  assert.equal(deferred[0]?.alwaysLoad, undefined);
  assert.equal(deferred[1]?.mode, "deferred");
  assert.deepEqual(deferred[1]?.alwaysLoad, ["search_code"]);
  assert.doesNotThrow(() => new McpGateway(deferred));

  for (const mode of ["legacy", "codemode", "directt"]) {
    assert.throws(
      () =>
        readConfig({
          ...base,
          MCP_SERVERS_JSON: JSON.stringify([
            {
              name: "github",
              url: "https://github.example/mcp",
              tokenEnv: "GH_TOKEN",
              mode,
            },
          ]),
        }),
      /apenas modo direct ou deferred/,
    );
  }
  assert.throws(
    () =>
      readConfig({
        ...base,
        MCP_SERVERS_JSON:
          '[{"name":"github","url":"https://github.example/mcp","tokenEnv":"GH_TOKEN","mode":"deferred","alwaysLoad":""}]',
      }),
    /alwaysLoad inválido/,
  );
});

test("gateway rejects unknown modes and accepts deferred alwaysLoad", async () => {
  const base = {
    name: "github",
    url: "https://mcp.example/mcp",
    readTools: [],
    actionTools: [],
  };
  assert.doesNotThrow(
    () =>
      new McpGateway([
        { ...base, mode: "deferred", alwaysLoad: ["search_code"] },
      ]),
  );
  assert.doesNotThrow(
    () => new McpGateway([{ ...base, mode: "direct", alwaysLoad: [] }]),
  );
  for (const mode of ["legacy", "codemode"]) {
    assert.throws(
      () => new McpGateway([{ ...base, mode: mode as McpConfig["mode"] }]),
      /modo/,
    );
  }
  assert.throws(
    () => new McpGateway([{ ...base, alwaysLoad: [""] }]),
    /listas de ferramentas/,
  );

  const deferred = new McpGateway([
    {
      name: "github",
      url: "http://127.0.0.1:1/mcp",
      mode: "deferred",
      alwaysLoad: ["search_code"],
      readTools: [],
      actionTools: [],
      allowedTools: ["search_code", "get_file"],
      deniedTools: ["delete_file"],
    },
  ]);
  try {
    const [row] = await deferred.catalog();
    assert.equal(row?.mode, "deferred");
    assert.deepEqual(row?.tools, []);
    assert.equal(deferred.config[0]?.mode, "deferred");
    assert.doesNotThrow(() => deferred.assertDirect("github", "get_file"));
    assert.doesNotThrow(() => deferred.assertDirect("github", "search_code"));
    assert.throws(
      () => deferred.assertDirect("github", "delete_file"),
      /restrições configuradas/,
    );
    assert.throws(
      () => deferred.assertDirect("github", "create_issue"),
      /restrições configuradas/,
    );
  } finally {
    await deferred.close();
  }
});

test("deferred projection leaves a direct catalog untouched", () => {
  const catalog: McpCatalog[] = [
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
  assert.equal(
    projectDeferredCatalog(catalog, [{ name: "executor", mode: "direct" }]),
    catalog,
  );
  assert.equal(
    projectDeferredCatalog(catalog, [{ name: "executor" }]),
    catalog,
  );
  const projected = projectDeferredCatalog(catalog, [
    {
      name: "executor",
      mode: "deferred",
      alwaysLoad: ["search"],
    },
  ]);
  assert.equal(projected[0]?.mode, "deferred");
  assert.equal(projected[0]?.tools[0]?.deferred, undefined);
  assert.equal(projected[0]?.tools[0], catalog[0]?.tools[0]);

  const github: McpCatalog = {
    server: "github",
    mode: "direct",
    tools: [
      {
        name: "get_file",
        description: "",
        inputSchema: { type: "object" },
        operation: "direct",
      },
    ],
  };
  const mixed = projectDeferredCatalog(
    [catalog[0]!, github],
    [
      { name: "executor", mode: "direct" },
      { name: "github", mode: "deferred" },
    ],
  );
  assert.equal(mixed[0], catalog[0]);
  assert.equal(mixed[1]?.tools[0]?.deferred, true);
});

test("mcp usage keeps the direct hint and adds tool_search only for deferred tools", () => {
  assert.equal(mcpUsageText([{ tools: [{ name: "search" }] }]), MCP_USAGE);
  assert.equal(mcpUsageText([]), undefined);
  const deferredOnly = mcpUsageText([
    { tools: [{ name: "get_file", deferred: true }] },
  ]);
  assert.equal(deferredOnly, MCP_DEFERRED_USAGE);
  assert.match(deferredOnly!, /tool_search/);
  assert.doesNotMatch(deferredOnly!, /Direct MCP tools are connected/);
  const mixed = mcpUsageText([
    { tools: [{ name: "search" }] },
    { tools: [{ name: "get_file", deferred: true }] },
  ]);
  assert.match(
    mixed!,
    new RegExp(`^${MCP_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(mixed!, /tool_search/);
});

test("default Executor registration stays direct and does not install tool_search", async () => {
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      readTools: [],
      actionTools: [],
    },
  ]);
  const names = ["search", "describe", "call", "execute", "resume", "skills"];
  gateway.catalog = async () => [
    {
      server: "executor",
      mode: "direct" as const,
      tools: names.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
        operation: "direct" as const,
      })),
    },
  ];
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-direct-default-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const app = await Runtime.open({ dir, models, gateway });
  try {
    const tools =
      registryOf(app).snapshot().extension("mcp-direct")?.tools ?? [];
    assert.equal(tools.length, names.length);
    assert.ok(tools.every((tool) => tool.deferred !== true));
    assert.equal(
      registryOf(app).snapshot().extension("tool-search"),
      undefined,
    );
    assert.equal(await sectionText(app, "mcp-direct", "mcp-usage"), MCP_USAGE);
    assert.equal(
      await sectionText(app, "personal-assistant", "policy"),
      ASSISTANT_POLICY,
    );
    const id = await app.create();
    const agent = await (await app.conversation(id)).agent(context);
    for (const name of names)
      assert.equal(
        agent.tools.filter(
          (tool) => tool.name === mcpToolName("executor", name),
        ).length,
        1,
      );
    assert.equal(agent.deferred.length, 0);
    assert.ok(agent.tools.some((tool) => tool.name === "tasks_list"));
    assert.equal(
      agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME),
      false,
    );
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deferred tools hide until tool_search, alwaysLoad stays direct, and policy still gates the call", async () => {
  const seen: string[] = [];
  const mcp = new McpServer({ name: "github", version: "1.0.0" });
  mcp.registerTool("search_code", { description: "Search code" }, async () => {
    seen.push("search_code");
    return { content: [{ type: "text", text: "hits" }] };
  });
  mcp.registerTool("get_file", { description: "Get a file" }, async () => {
    seen.push("get_file");
    return { content: [{ type: "text", text: "file-body" }] };
  });
  mcp.registerTool(
    "create_issue",
    { description: "Create an issue" },
    async () => {
      seen.push("create_issue");
      return { content: [{ type: "text", text: "opened" }] };
    },
  );
  mcp.registerTool(
    "delete_file",
    { description: "Delete a file" },
    async () => {
      seen.push("delete_file");
      return { content: [{ type: "text", text: "gone" }] };
    },
  );
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
  const config: McpConfig = {
    name: "github",
    url: `http://127.0.0.1:${address.port}/mcp`,
    mode: "deferred",
    alwaysLoad: ["search_code"],
    readTools: [],
    actionTools: [],
    allowedTools: ["search_code", "get_file", "create_issue"],
    deniedTools: ["delete_file"],
  };
  const gateway = new McpGateway([config]);
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-deferred-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const searchName = mcpToolName("github", "search_code");
  const getName = mcpToolName("github", "get_file");
  const issueName = mcpToolName("github", "create_issue");
  const deleteName = mcpToolName("github", "delete_file");
  let app: Runtime | undefined;
  try {
    const catalog = await gateway.catalog();
    assert.equal(catalog[0]?.mode, "deferred");
    assert.deepEqual(catalog[0]?.tools.map((tool) => tool.name).sort(), [
      "create_issue",
      "get_file",
      "search_code",
    ]);
    assert.equal(
      catalog[0]?.tools.find((tool) => tool.name === "search_code")?.deferred,
      undefined,
    );
    assert.equal(
      catalog[0]?.tools.find((tool) => tool.name === "get_file")?.deferred,
      true,
    );
    assert.throws(
      () => gateway.assertDirect("github", "delete_file"),
      /restrições configuradas/,
    );
    await assert.rejects(
      gateway.callDirect("github", "delete_file", {}),
      /restrições configuradas/,
    );
    assert.deepEqual(seen, []);

    app = await Runtime.open({ dir, models, gateway });
    const registered =
      registryOf(app).snapshot().extension("mcp-direct")?.tools ?? [];
    const byName = (name: string) =>
      registered.find((tool) => tool.name === name);
    assert.equal(byName(searchName)?.deferred, undefined);
    assert.equal(byName(getName)?.deferred, true);
    assert.equal(byName(issueName)?.deferred, true);
    assert.equal(byName(deleteName), undefined);
    assert.equal(
      registryOf(app)
        .snapshot()
        .installed()
        .filter((extension) => extension.name === "tool-search").length,
      1,
    );
    assert.equal(
      registryOf(app)
        .snapshot()
        .extension("tool-search")
        ?.tools?.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME),
      true,
    );
    const usage = await sectionText(app, "mcp-direct", "mcp-usage");
    assert.match(String(usage), /Direct MCP tools are connected/);
    assert.match(String(usage), /tool_search/);
    const policy = String(
      await sectionText(app, "personal-assistant", "policy"),
    );
    assert.match(policy, /Aprovação MCP pendente/);
    assert.match(policy, /tool_search/);

    const id = await app.create();
    const before = await (await app.conversation(id)).agent(context);
    assert.ok(before.tools.some((tool) => tool.name === searchName));
    assert.ok(before.tools.some((tool) => tool.name === "tasks_list"));
    assert.ok(before.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME));
    assert.equal(
      before.tools.some((tool) => tool.name === getName),
      false,
    );
    assert.equal(
      before.deferred.some((tool) => tool.name === getName && tool.deferred),
      true,
    );
    assert.equal(
      before.deferred.some((tool) => tool.name === issueName),
      true,
    );
    assert.equal(
      before.tools.some((tool) => tool.name === deleteName) ||
        before.deferred.some((tool) => tool.name === deleteName),
      false,
    );

    await app.refreshMcpTools();
    assert.equal(
      registryOf(app)
        .snapshot()
        .installed()
        .filter((extension) => extension.name === "tool-search").length,
      1,
    );

    faux.setResponses([
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "load-get-file",
          name: TOOL_SEARCH_TOOL_NAME,
          arguments: { query: "get_file" },
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "read-get-file",
          name: getName,
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "denied-delete",
          name: deleteName,
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Finished the deferred read."),
    ]);
    await app.submit(id, "load-and-read", "Read the file, do not delete it.");
    await (await app.conversation(id)).waitForIdle(context);
    assert.deepEqual(seen, ["get_file"]);
    const loaded = await (await app.conversation(id)).agent(context);
    assert.ok(loaded.tools.some((tool) => tool.name === getName));
    assert.match(
      JSON.stringify(await gateway.callDirect("github", "get_file", {})),
      /file-body/,
    );
    assert.deepEqual(
      seen.filter((name) => name === "delete_file"),
      [],
    );
    assert.throws(
      () => gateway.assertDirect("github", "delete_file"),
      /restrições configuradas/,
    );

    config.mode = "direct";
    await app.refreshMcpTools();
    const directTools =
      registryOf(app).snapshot().extension("mcp-direct")?.tools ?? [];
    assert.ok(directTools.every((tool) => tool.deferred !== true));
    assert.equal(
      registryOf(app).snapshot().extension("tool-search"),
      undefined,
    );
    const after = await (await app.conversation(id)).agent(context);
    assert.ok(after.tools.some((tool) => tool.name === getName));
    assert.equal(
      after.deferred.some((tool) => tool.name === getName),
      false,
    );
    assert.equal(
      await sectionText(app, "personal-assistant", "policy"),
      ASSISTANT_POLICY,
    );
    assert.equal(await sectionText(app, "mcp-direct", "mcp-usage"), MCP_USAGE);
  } finally {
    await app?.close();
    await gateway.close();
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
