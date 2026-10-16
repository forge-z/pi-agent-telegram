import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpGateway, McpNotSentError, type McpConfig } from "../src/mcp.js";
test("real MCP SDK connects to local HTTP mock, exposes explicit allowlists, calls read/action tools", async () => {
  const mcp = new McpServer({ name: "mock", version: "1.0.0" });
  let reads = 0;
  let writes = 0;
  mcp.registerTool("lookup", { description: "Read mock" }, async () => {
    reads++;
    return { content: [{ type: "text", text: "preview" }] };
  });
  mcp.registerTool("create", { description: "Write mock" }, async () => {
    writes++;
    return { content: [{ type: "text", text: "saved" }] };
  });
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
  const gateway = new McpGateway([
    {
      name: "mock",
      url: `http://127.0.0.1:${address.port}/mcp`,
      readTools: ["lookup"],
      actionTools: ["create"],
    },
  ]);
  try {
    const discovered = await gateway.discover("mock");
    assert.ok(discovered.some((tool) => tool.name === "create"));
    assert.equal(writes, 0);
    assert.equal(reads, 0);
    const catalog = JSON.stringify(await gateway.catalog());
    assert.match(catalog, /lookup/);
    assert.match(catalog, /inputSchema/);
    assert.doesNotMatch(catalog, /http:/);
    assert.throws(
      () =>
        new McpGateway([
          {
            name: "unsafe",
            url: "http://remote.invalid/mcp",
            readTools: [],
            actionTools: [],
          },
        ]),
      /HTTPS/,
    );
    assert.match(
      JSON.stringify(await gateway.call("mock", "lookup", {}, "read")),
      /preview/,
    );
    await assert.rejects(
      gateway.call("mock", "create", {}, "read"),
      /não autorizada/,
    );
    await assert.rejects(
      gateway.call("unknown", "lookup", {}, "read"),
      /não autorizada/,
    );
    await gateway.call("mock", "create", {}, "action");
    assert.equal(reads, 1);
    assert.equal(writes, 1);
  } finally {
    await gateway.close();
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an MCP endpoint redirecting to another origin never receives the bearer token there", async () => {
  const seen: string[] = [];
  const other = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ""));
    res.writeHead(500).end();
  });
  await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
  const otherAddress = other.address();
  assert.ok(otherAddress && typeof otherAddress === "object");
  const redirecting = createServer((_req, res) => {
    res
      .writeHead(307, {
        location: `http://localhost:${otherAddress.port}/mcp`,
      })
      .end();
  });
  await new Promise<void>((done) => redirecting.listen(0, "127.0.0.1", done));
  const address = redirecting.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    {
      name: "moved",
      url: `http://127.0.0.1:${address.port}/mcp`,
      readTools: ["lookup"],
      actionTools: [],
      token: "redirect-bearer-secret",
    },
  ]);
  try {
    await assert.rejects(gateway.discover("moved"));
    assert.deepEqual(seen, []);
  } finally {
    await gateway.close();
    await new Promise<void>((done) => redirecting.close(() => done()));
    await new Promise<void>((done) => other.close(() => done()));
  }
});

test("MCP configuration rejects unknown fields and malformed entries, naming the entry", () => {
  const base = {
    name: "alpha",
    url: "https://mcp.example/mcp",
    readTools: [],
    actionTools: [],
  };
  const invalid = (value: unknown) => () =>
    new McpGateway(value as McpConfig[]);
  assert.throws(invalid({ servers: [base] }), /lista de servidores/);
  assert.throws(invalid([base, null]), /deve ser um objeto \(servidor MCP 2\)/);
  assert.throws(
    invalid([base, { ...base, name: "beta", denyTools: ["delete"] }]),
    /campo desconhecido: "denyTools" \(servidor MCP 2 "beta"\)/,
  );
  assert.throws(
    invalid([{ ...base, token: "first\nAuthorization: other" }]),
    /token e tokenFile/,
  );
  assert.throws(invalid([{ ...base, tokenFile: 42 }]), /token e tokenFile/);
  assert.throws(invalid([{ ...base, url: 7 }]), /nome e URL/);
  assert.throws(
    invalid([{ ...base, name: "bad name" }]),
    /confira nome, modo e listas de ferramentas \(servidor MCP 1\)$/,
  );
  assert.doesNotThrow(invalid([{ ...base, token: undefined }]));
});

test("an unreadable or multi-line MCP token file fails before sending, without exposing its path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-token-file-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(String(req.url));
    res.writeHead(500).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config = (tokenFile: string): McpConfig => ({
    name: "files",
    url: `http://127.0.0.1:${address.port}/mcp`,
    readTools: ["lookup"],
    actionTools: [],
    tokenFile,
  });
  const missing = join(dir, "missing-token-secret-path");
  const multiline = join(dir, "multiline");
  await writeFile(multiline, "first\nsecond\n");
  try {
    for (const [file, message] of [
      [missing, /Arquivo de token MCP indisponível/],
      [multiline, /Arquivo de token MCP inválido/],
    ] as const) {
      const gateway = new McpGateway([config(file)]);
      try {
        const error = await gateway.call("files", "lookup", {}, "read").then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(error instanceof McpNotSentError);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /missing-token-secret-path|second/);
        await assert.rejects(gateway.discover("files"), message);
      } finally {
        await gateway.close();
      }
    }
    assert.deepEqual(requests, []);
    assert.throws(
      () => new McpGateway([config(missing)]).credentialBinding("files"),
      /Arquivo de token MCP indisponível/,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("main reports an invalid MCP configuration file without echoing its contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-main-config-"));
  const file = join(dir, "mcp.json");
  await writeFile(file, '[{"name":"x","token":"inline-secret-value" oops}]');
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATA_DIR: dir,
        TELEGRAM_BOT_TOKEN: "123:synthetic-token",
        TELEGRAM_ALLOWED_USERS: "42",
        TELEGRAM_ALLOWED_CHATS: "42",
        MCP_CONFIG_FILE: file,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => (logs += data));
    child.stderr.on("data", (data) => (logs += data));
    const code = await new Promise((done) => child.on("exit", done));
    assert.notEqual(code, 0);
    assert.match(logs, /MCP: JSON inválido|Falha ao iniciar/);
    assert.doesNotMatch(logs, /inline-secret-value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
