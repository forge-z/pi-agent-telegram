import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import {
  Telegram,
  TelegramSendRefused,
  type TelegramUpdate,
} from "../src/telegram.js";
import { configureTelegram } from "../src/telegram-polling.js";
import {
  button as savedButton,
  queueControl,
  type TelegramButton,
  type TelegramReplyMarkup,
} from "../src/telegram-controls.js";
import { decideMcp, queueMcpApprovals } from "../src/telegram-approvals.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { deflateSync } from "node:zlib";

/** A real 64x64 PNG: providers refuse tiny images, and so does our guard. */
function samplePng() {
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = 200;
      raw[row + 2 + x * 3] = 60;
      raw[row + 3 + x * 3] = 60;
    }
  }
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
import { hash } from "../src/store.js";
import { telegramConversationRoute } from "../src/task-telegram.js";
import {
  discoverLlmModels,
  environmentModels,
  parseLlmModels,
  providerNameFromEndpoint,
  readConfig,
  resolveMcpServersJson,
  telegramAllowlistMisconfiguration,
} from "../src/config.js";

async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check());
}
async function fixture(bootstrap: { modelId?: string; effort?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-"));
  const models = createModels();
  models.setProvider(
    fauxProvider({
      models: [
        { id: "faux-1", reasoning: true },
        { id: "faux-2", reasoning: true },
      ],
    }).provider,
  );
  models.setProvider(
    fauxProvider({
      provider: "other",
      models: [{ id: "other-1", reasoning: true }],
    }).provider,
  );
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:1/mcp",
      mode: "direct",
      readTools: [],
      actionTools: [],
    },
  ]);
  gateway.catalog = async () => [];
  gateway.connectionBinding = async () => gateway.credentialBinding("executor");
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let nextResult: Record<string, unknown> | undefined;
  gateway.callDirect = async (_server, tool, args) => {
    calls.push({ tool, args });
    return {
      content: [],
      structuredContent:
        nextResult ??
        (tool === "execute"
          ? {
              status: "approval-required",
              requestId: `request-${calls.length}`,
              expiresAt: Date.now() + 60000,
              invocation: {
                app: "mail",
                tool: "send",
                input: {
                  to: "recipient@example.test",
                  subject: "Review",
                  body: "Full mock content",
                },
              },
              elicitation: {
                mode: "form",
                message: "Send this mock message?",
                requestedSchema: { type: "object", properties: {} },
              },
            }
          : {
              status: "completed",
              execution: { ok: true, value: "mock sent" },
            }),
    };
  };
  const config = {
    token: "123:synthetic-test-token",
    users: ["42", "43"],
    chats: ["-100123", "-100456"],
  };
  const options = {
    dir,
    gateway,
    models,
    telegramOnly: true,
    initialize: (store: Runtime["store"]) =>
      configureTelegram(store, config, { id: 123, username: "test_bot" }),
  };
  let app = await Runtime.open({ ...options, ...bootstrap });
  type View = {
    id: number;
    text: string;
    markup?: TelegramReplyMarkup;
    chat: string;
    thread?: number;
    force?: boolean;
  };
  const views: View[] = [];
  let nextId = 1,
    messageId = 500,
    fail = false;
  const downloads: string[] = [];
  const media: {
    chat: string;
    kind: string;
    url?: string;
    hasBytes: boolean;
    thread?: number;
  }[] = [];
  let mediaFails = false;
  const engine = () =>
    new Telegram(
      app,
      {
        downloadFile: async (fileId: string) => {
          downloads.push(fileId);
          return { data: new Uint8Array(samplePng()) };
        },
        sendMedia: async (chat, item, opts) => {
          if (mediaFails) throw new Error("upload refused");
          media.push({
            chat,
            kind: item.kind,
            url: item.url,
            hasBytes: !!item.data,
            thread: opts?.messageThreadId,
          });
          return { message_id: messageId++ };
        },
        send: async (chat, text, opts) => {
          if (fail) throw new TelegramSendRefused(400);
          const id = messageId++;
          views.push({
            id,
            text,
            markup: opts?.replyMarkup,
            chat,
            thread: opts?.messageThreadId,
            force: opts?.forceReply,
          });
          return { message_id: id };
        },
        editMessage: async (chat, id, text, markup) => {
          views.push({ id, text, markup, chat, thread: 11 });
          return true;
        },
        answerCallback: async () => true,
      },
      config.users,
      config.chats,
      "test_bot",
      false,
      123,
    );
  let bot = engine();
  app.flushTelegramPending = () => {
    void bot.flush();
  };
  const owner = { chat: "-100123", user: "42", messageThreadId: 11 };
  const send = async (
    text: string,
    thread = 11,
    chat = -100123,
    user = 42,
    reply?: number,
  ) => {
    const id = nextId++;
    const update: TelegramUpdate = {
      update_id: id,
      message: {
        message_id: id,
        text,
        from: { id: user },
        chat: { id: chat, type: "supergroup" },
        message_thread_id: thread,
        ...(reply
          ? { reply_to_message: { message_id: reply, from: { id: 123 } } }
          : {}),
      },
    };
    await bot.receive(update);
    await bot.flush();
    return update;
  };
  const click = async (
    token: string,
    view = views.at(-1)!,
    user = 42,
    thread = view.thread ?? 11,
    chat = Number(view.chat),
  ) => {
    const id = nextId++;
    await bot.receive({
      update_id: id,
      callback_query: {
        id: `q${id}`,
        data: token,
        from: { id: user },
        message: {
          message_id: view.id,
          date: 1,
          from: { id: 123 },
          chat: { id: chat, type: "supergroup" },
          message_thread_id: thread,
        },
      },
    });
    await bot.flush();
  };
  const button = (text: string, view = views.at(-1)!) => {
    const b = view.markup?.inline_keyboard
      .flat()
      .find((b) => b.text.includes(text));
    assert.ok(b?.callback_data, `${text}: ${view.text}`);
    return b.callback_data;
  };
  return {
    downloads,
    media,
    set mediaFails(value: boolean) {
      mediaFails = value;
    },
    get app() {
      return app;
    },
    get bot() {
      return bot;
    },
    owner,
    gateway,
    views,
    calls,
    send,
    click,
    button,
    setResult: (r: Record<string, unknown> | undefined) => {
      nextResult = r;
    },
    fail: (v: boolean) => {
      fail = v;
    },
    restart: async () => {
      await bot.drain();
      await app.close();
      app = await Runtime.open(options);
      bot = engine();
      app.flushTelegramPending = () => {
        void bot.flush();
      };
    },
    close: async () => {
      await app.mcpCalls.close();
      await bot.drain();
      await app.close();
      await gateway.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("clean starts empty, supports negative group IDs, creates only on use and isolates native topics/chats/users", async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.store.all("SELECT * FROM conversations").length, 0);
    await f.send("/status");
    const first = f.app.telegramChats.selection(f.owner)!;
    assert.ok(first);
    // A running deployment reloads from `/status`: the menu belongs to the polling
    // layer, so the engine asks it through this hook.
    const reloaded: string[] = [];
    f.bot.onReload = async (chat) => {
      reloaded.push(chat);
    };
    await f.send("/status");
    assert.deepEqual(reloaded, ["-100123"]);
    await f.send("/status", 22);
    await f.send("/status", 11, -100456);
    await f.send("/status", 11, -100123, 43);
    assert.equal(
      new Set(
        f.app.store
          .all<{ id: string }>("SELECT id FROM conversations")
          .map((r) => r.id),
      ).size,
      4,
    );
    assert.equal(
      telegramConversationRoute(f.app.store, first)?.chat,
      "-100123",
    );
    const count = f.views.length;
    await f.send("/status", 11, -100123, 999);
    assert.equal(f.views.length, count);
    await f.send("/new");
    assert.match(f.views.at(-1)!.text, /desconhecido/);
    assert.equal(f.app.store.all("SELECT * FROM conversations").length, 4);
    await f.restart();
    assert.equal(f.app.telegramChats.selection(f.owner), first);
  } finally {
    await f.close();
  }
});
test("model provider and effort menus persist in the native conversation after restart", async () => {
  const f = await fixture();
  try {
    await f.send("/model");
    await f.click(f.button("other"));
    await f.click(f.button("other-1"));
    await f.send("/thinking");
    await f.click(f.button("low"));
    const id = f.app.telegramChats.selection(f.owner)!;
    assert.deepEqual(await f.app.settings.conversation(id), {
      provider: "other",
      modelId: "other-1",
      effort: "low",
    });
    await f.restart();
    assert.deepEqual(await f.app.settings.conversation(id), {
      provider: "other",
      modelId: "other-1",
      effort: "low",
    });
  } finally {
    await f.close();
  }
});
test("MCP approval card is queued immediately when a pending interaction is created", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    await f.app.mcpCalls.execute(id, 50, "executor", "execute", {
      code: "mock source",
    });
    await until(() => f.views.length > before);
    assert.match(f.views.at(-1)!.text, /Aprovação MCP pendente/);
    assert.ok(
      f.views
        .at(-1)!
        .markup?.inline_keyboard.flat()
        .some((b) => b.text.includes("Aprovar")),
    );
  } finally {
    await f.close();
  }
});

test("executor waiting_for_interaction with executionId and form elicitation creates a Telegram card", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    f.setResult({
      status: "waiting_for_interaction",
      executionId: "exec_3f2adea9",
      elicitation: {
        mode: "form",
        message: "Refresh Zoho tool catalog?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 52, "executor", "execute", {
      code: "mock waiting pause",
    });
    await until(() => f.views.length > before);
    assert.match(f.views.at(-1)!.text, /Aprovação MCP pendente/);
    assert.match(f.views.at(-1)!.text, /Refresh Zoho tool catalog/);
    assert.doesNotMatch(f.views.at(-1)!.text, /"server": "executor"/);
    const card = f.views.at(-1)!;
    assert.ok(
      card.markup?.inline_keyboard
        .flat()
        .some((b) => b.text.includes("Recusar")),
    );
    assert.ok(
      card.markup?.inline_keyboard
        .flat()
        .some((b) => b.text.includes("Aprovar")),
    );
    const callsBefore = f.calls.length;
    await f.click(f.button("Recusar", card), card);
    await until(() => f.calls.length === callsBefore + 1);
    assert.deepEqual(f.calls.at(-1), {
      tool: "resume",
      args: { executionId: "exec_3f2adea9", action: "decline" },
    });
    f.app.mcpCalls.cancelConversation(id);
    f.setResult({
      status: "waiting_for_interaction",
      executionId: "exec_accept_content",
      elicitation: {
        mode: "form",
        message: "Confirm?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 53, "executor", "execute", {
      code: "mock accept content",
    });
    await f.bot.flush();
    const approveCard = f.views.at(-1)!;
    const callsBeforeApprove = f.calls.length;
    await f.click(f.button("Aprovar", approveCard), approveCard);
    await until(() => f.calls.length === callsBeforeApprove + 1);
    assert.deepEqual(f.calls.at(-1), {
      tool: "resume",
      args: {
        executionId: "exec_accept_content",
        action: "accept",
        content: "",
      },
    });
  } finally {
    await f.close();
  }
});

test("executor approval-required with executionId creates a Telegram card and resume uses requestId", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    f.setResult({
      status: "approval-required",
      executionId: "exec_1cc92b17-test",
      invocation: {
        app: "executor",
        tool: "coreTools.connections.refresh",
        input: { address: "tools.zoho_mcp.user.example" },
      },
    });
    await f.app.mcpCalls.execute(id, 51, "executor", "execute", {
      code: "mock executionId pause",
    });
    await until(() => f.views.length > before);
    assert.match(f.views.at(-1)!.text, /Aprovação MCP pendente/);
    const pending = f.app.store.all(
      "SELECT payload FROM mcp_interactions WHERE state='pending'",
    );
    assert.match(JSON.stringify(pending), /exec_1cc92b17-test/);
    assert.match(JSON.stringify(pending), /requestId/);
  } finally {
    await f.close();
  }
});

test("an approval the user gave in chat resumes past the pending call", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    f.setResult({
      status: "approval-required",
      requestId: "apr_e80c716c",
      invocation: {
        app: "app_6156b6c0",
        tool: "agent.automation.runAsync",
        kind: "mutation",
        input: { goal: "ETAPA6" },
      },
      elicitation: {
        mode: "form",
        message: "Approve agent.automation.runAsync?",
        requestedSchema: { type: "object", properties: {} },
      },
      expiresAt: Date.now() + 60000,
    });
    await f.app.mcpCalls.execute(id, 81, "executor", "execute", {
      code: "mock v2 pause",
    });
    await until(() => f.views.length > before);
    f.setResult({ status: "completed", execution: { ok: true, value: {} } });
    // The user said "aprova" in the chat: the resume is the way out of the queue.
    await f.app.mcpCalls.execute(id, 82, "executor", "resume", {
      requestId: "apr_e80c716c",
      response: { action: "accept" },
    });
    assert.ok(f.calls.some((call) => call.tool === "resume"));
  } finally {
    await f.close();
  }
});

test("the real v2 pause (app_ id, kind and accounts) renders a short card", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    // Exactly what the provider sends: invocation has no `app`, only tool/kind/input.
    f.setResult({
      status: "approval-required",
      requestId: "apr_99975402",
      invocation: {
        app: "app_6156b6c0-2303-4577-8615-c3266edb1c7f",
        tool: "agent.automation.runAsync",
        kind: "mutation",
        input: { goal: "ETAPA4-2026-10-19" },
        accounts: { tinyfish: "user@example.test" },
      },
      elicitation: {
        mode: "form",
        message:
          'Approve agent.automation.runAsync?\n\nArguments:\n{\n  "accountId": "acc_test",\n  "input": { "body": { "output_schema": { "type": "object" } } }\n}',
        requestedSchema: { type: "object", properties: {} },
      },
      expiresAt: Date.now() + 60000,
    });
    await f.app.mcpCalls.execute(id, 63, "executor", "execute", {
      code: "mock real v2 pause",
    });
    await until(() => f.views.length > before);
    const card = f.views.at(-1)!;
    assert.match(card.text, /Aprovação MCP pendente/);
    assert.match(card.text, /Approve agent\.automation\.runAsync\?/);
    // The card asks the question; it does not dump the arguments as JSON.
    assert.doesNotMatch(card.text, /Arguments|output_schema|accountId/);
    // An empty form must still offer both decisions: a v2 mutation could only be
    // denied, which made every mutation impossible to approve.
    const labels = card.markup!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("Aprovar"), labels.join(","));
    assert.ok(labels.includes("Recusar"), labels.join(","));
  } finally {
    await f.close();
  }
});

test("v2 accept resumes by requestId, never by executionId", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.setResult({
      status: "approval-required",
      requestId: "apr_c4b477c6",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "executor",
        tool: "coreTools.connections.refresh",
        input: { address: "tools.zoho_mcp.user.example" },
      },
      elicitation: {
        mode: "form",
        message: "Approve agent.automation.runAsync?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 61, "executor", "execute", {
      code: "mock v2 pause",
    });
    await f.bot.flush();
    const cardView = f.views.at(-1)!;
    const callback = cardView
      .markup!.inline_keyboard.flat()
      .find((b) => b.text.includes("Aprovar"))!.callback_data!;
    const data = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:button:${callback}`,
      )!.value,
    ) as TelegramButton;
    // v2's success envelope: the payload lives in `execution.value`.
    f.setResult({
      status: "completed",
      execution: { ok: true, value: { runId: "run-1" } },
    });
    await decideMcp(f.app, data, cardView.id);
    const resume = f.calls.filter((call) => call.tool === "resume").at(-1)!;
    const args = resume.args as Record<string, unknown>;
    assert.equal(args.requestId, "apr_c4b477c6");
    assert.equal(args.executionId, undefined);
    assert.equal((args.response as { action: string }).action, "accept");
  } finally {
    await f.close();
  }
});

test("an expired request tells the topic once and leaves nothing open", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.setResult({
      status: "approval-required",
      requestId: "apr_expired",
      expiresAt: Date.now() - 1000,
      invocation: { tool: "agent.automation.runAsync", input: {} },
      elicitation: {
        mode: "form",
        message: "Approve agent.automation.runAsync?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 62, "executor", "execute", {
      code: "mock expired pause",
    });
    await f.bot.flush();
    await queueMcpApprovals(f.app);
    await f.bot.flush();
    const notice = f.views.find((view) =>
      view.text.includes("Aprovação MCP expirada"),
    )!;
    assert.ok(notice, "o tópico precisa saber que expirou");
    assert.match(notice.text, /agent\.automation\.runAsync/);
    assert.equal(
      f.app.store.all("SELECT 1 FROM mcp_interactions WHERE state='pending'")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a pause nested inside the execute envelope still becomes a card", async () => {
  // Executor v2 answers `execute` with its own envelope and puts the paused tool's payload
  // inside it; the card must not depend on the pause being at the top level.
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    const pause = {
      status: "approval-required",
      requestId: "apr_c4b477c6",
      expiresAt: Date.now() + 60000,
      invocation: {
        tool: "agent.automation.runAsync",
        kind: "mutation",
        input: {},
      },
      elicitation: {
        mode: "form",
        message: "Approve agent.automation.runAsync?",
        requestedSchema: { type: "object", properties: {} },
      },
    };
    f.setResult({
      ok: true,
      data: { content: [{ type: "text", text: JSON.stringify(pause) }] },
    });
    await f.app.mcpCalls.execute(id, 52, "executor", "execute", {
      code: "mock v2 pause",
    });
    await until(() => f.views.length > before);
    const card = f.views.at(-1)!;
    assert.match(card.text, /Aprovação MCP pendente/);
    assert.match(card.text, /agent\.automation\.runAsync/);
    assert.match(card.text, /Approve agent\.automation\.runAsync\?/);
  } finally {
    await f.close();
  }
});

test("executor connections.refresh approval card includes Approve when invocation is fully reviewable", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const before = f.views.length;
    f.setResult({
      status: "approval-required",
      requestId: "refresh-approval",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "executor",
        tool: "coreTools.connections.refresh",
        input: { address: "tools.zoho_mcp.user.example" },
      },
      elicitation: {
        mode: "form",
        message: "Refresh Zoho tool catalog?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 50, "executor", "execute", {
      code: "mock refresh",
    });
    await until(() => f.views.length > before);
    const card = f.views.at(-1)!;
    assert.match(card.text, /Aprovação MCP pendente/);
    assert.match(card.text, /coreTools\.connections\.refresh/);
    assert.ok(
      card.markup?.inline_keyboard
        .flat()
        .some((b) => b.text.includes("Aprovar")),
    );
  } finally {
    await f.close();
  }
});

test("Executor approval uses requestId/response once; wrong owner/topic, replay and restart are safe", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    await f.app.mcpCalls.execute(id, 100, "executor", "execute", {
      code: "mock source",
    });
    await f.bot.flush();
    const card = f.views.at(-1)!;
    const approve = f.button("Aprovar", card);
    assert.match(card.text, /recipient@example.test/);
    assert.match(card.text, /Full mock content/);
    await f.click(approve, card, 43);
    await f.click(approve, card, 42, 22);
    assert.equal(f.calls.length, 1);
    await f.restart();
    await f.click(approve, card);
    await until(
      () =>
        !!f.app.store.get(
          "SELECT 1 FROM deliveries WHERE id LIKE 'telegram:mcp-result:%'",
        ),
    );
    assert.deepEqual(f.calls[1], {
      tool: "resume",
      args: {
        requestId: "request-1",
        response: { action: "accept", content: {} },
      },
    });
    await f.click(approve, card);
    assert.equal(f.calls.filter((c) => c.tool === "execute").length, 1);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
test("denial, remote expiration and /stop never approve", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    await f.bot.flush();
    await f.click(f.button("Recusar"));
    await until(() => f.calls.length === 2);
    assert.equal(
      (f.calls[1].args.response as { action: string }).action,
      "decline",
    );
    await f.bot.drain();
    await f.restart();
    await f.app.mcpCalls.execute(id, 2, "executor", "execute", {});
    await f.bot.flush();
    const card = f.views.at(-1)!;
    const approve = f.button("Aprovar");
    await f.send("/stop");
    await f.click(approve, card);
    assert.equal(f.calls.length, 3);
    assert.equal(f.app.mcpCalls.interactions(id).at(-1)!.state, "responded");
    f.setResult({
      status: "approval-required",
      requestId: "expired",
      expiresAt: Date.now() - 1,
      invocation: { tool: "send", input: {} },
      elicitation: {
        mode: "form",
        message: "expired",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 3, "executor", "execute", {});
    await f.bot.flush();
    assert.equal(f.app.mcpCalls.interactions(id).at(-1)!.state, "expired");
  } finally {
    await f.close();
  }
});
test("partial review delivery and arbitrary resume cannot authorize execution", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.setResult({
      status: "approval-required",
      requestId: "large",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "mail",
        tool: "send",
        input: {
          to: "x@example.test",
          subject: "Complete review",
          body: "Full text. ".repeat(600),
        },
      },
      elicitation: {
        mode: "form",
        message: "Review",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    // While the card does not reach the chat, no resume can authorize it.
    f.fail(true);
    await f.bot.flush();
    await assert.rejects(() =>
      f.app.mcpCalls.execute(id, 3, "executor", "resume", {
        requestId: "large",
        response: { action: "accept" },
      }),
    );
    f.fail(false);
    await f.bot.flush();
    const delivered = f.views.length;
    assert.ok(delivered > 0);
    await f.bot.flush();
    assert.equal(f.views.length, delivered);
    await assert.rejects(() =>
      f.app.mcpCalls.execute(id, 2, "executor", "resume", {
        requestId: "not-open",
        response: { action: "accept" },
      }),
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
test("cron creation confirmation persists immutable origin through pause/edit/restart/delete and does not duplicate", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.button("Criar"));
    const prompt = f.views.at(-1)!;
    assert.ok(prompt.force);
    await f.send(
      "Agenda teste\n0 9 * * *\nUTC\nResumo simulado",
      11,
      -100123,
      42,
      prompt.id,
    );
    const confirm = f.views.at(-1)!;
    const token = f.button("Confirmar criação");
    await f.click(token, confirm);
    await f.click(token, confirm);
    assert.equal(f.app.tasks.list().length, 1);
    const task = f.app.tasks.list()[0];
    assert.equal(task.destinationChat, "-100123");
    assert.equal(task.destinationMessageThreadId, 11);
    await f.restart();
    assert.equal(f.app.tasks.get(task.id)!.destinationReason, null);
    await f.send("/crons");
    await f.click(f.button("Agenda teste"));
    await f.click(f.button("Pausar"));
    assert.equal(f.app.tasks.get(task.id)!.enabled, false);
    await f.click(f.button("Editar"));
    await f.click(f.button("Título"));
    const edit = f.views.at(-1)!;
    await f.send("Novo título", 11, -100123, 42, edit.id);
    await f.click(f.button("Confirmar alteração"));
    assert.equal(f.app.tasks.get(task.id)!.title, "Novo título");
    assert.equal(f.app.tasks.get(task.id)!.destinationMessageThreadId, 11);
    await f.click(f.button("Excluir"));
    await f.click(f.button("Confirmar exclusão"));
    assert.equal(f.app.tasks.list().length, 0);
  } finally {
    await f.close();
  }
});
test("configuration only registers API credentials and validates endpoint/model configuration offline", async () => {
  const models = await environmentModels({
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: "synthetic-key",
    LLM_MODELS: "chat-model,reasoning-model|65536|8192|true",
  });
  assert.deepEqual(
    models.getProviders().map((provider) => provider.id),
    ["llm"],
  );
  // The id stays `llm`; the name is what the menus show.
  assert.equal(
    providerNameFromEndpoint("https://api.deepseek.com"),
    "DeepSeek",
  );
  assert.equal(providerNameFromEndpoint("https://api.openai.com/v1"), "OpenAI");
  assert.equal(providerNameFromEndpoint("https://gateway.acme.dev/v1"), "Acme");
  assert.equal(providerNameFromEndpoint("http://127.0.0.1:8080/v1"), "Local");
  assert.equal(models.getProvider("llm")!.auth.oauth, undefined);
  assert.ok(await models.checkAuth("llm"));
  assert.deepEqual(
    models.getModels("llm").map((model) => [model.id, model.reasoning]),
    [
      ["chat-model", false],
      ["reasoning-model", true],
    ],
  );
  assert.deepEqual(
    getSupportedThinkingLevels(models.getModel("llm", "chat-model")!),
    ["off"],
  );
  assert.ok(
    getSupportedThinkingLevels(
      models.getModel("llm", "reasoning-model")!,
    ).includes("high"),
  );
  assert.deepEqual(parseLlmModels("one|32768|4096|true"), [
    { id: "one", contextWindow: 32768, maxTokens: 4096, reasoning: true },
  ]);
  assert.deepEqual(
    parseLlmModels("a,a")!.map((model) => model.id),
    ["a"],
  );
  assert.equal(parseLlmModels("  "), undefined);
  // DeepSeek rejects minimal/medium and supports max: the level list pins exactly that.
  const deepseek = await environmentModels({
    LLM_BASE_URL: "https://api.deepseek.com",
    LLM_API_KEY: "synthetic-key",
    LLM_MODELS: "deepseek-flash|1000000|384000|off+low+high+max",
  });
  const flash = deepseek.getModel("llm", "deepseek-flash")!;
  assert.equal(flash.contextWindow, 1000000);
  assert.equal(flash.maxTokens, 384000);
  assert.deepEqual(getSupportedThinkingLevels(flash), [
    "off",
    "low",
    "high",
    "max",
  ]);
  assert.deepEqual(
    parseLlmModels("x|32768|4096|off+high")![0].thinkingLevelMap,
    {
      off: "off",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  );
  for (const bad of [
    "x|1024|10|true",
    "x|32768|32768|true",
    "x|32768|4096|maybe",
    "x|32768|4096|off+nope",
    "x|32768|4096|true|extra",
  ])
    assert.throws(() => parseLlmModels(bad), /LLM_MODELS/);
  assert.deepEqual(
    readConfig({
      TELEGRAM_BOT_TOKEN: "123:mock",
      TELEGRAM_ALLOWED_USERS: "42",
      EXECUTOR_MCP_URL: "https://cloud.example/mcp",
      EXECUTOR_TOKEN: "key",
    }).chats,
    ["42"],
  );
  assert.match(
    telegramAllowlistMisconfiguration(999, {
      users: ["42"],
      chats: ["999"],
    }) ?? "",
    /id do bot/,
  );
  assert.equal(
    telegramAllowlistMisconfiguration(123, {
      users: ["42"],
      chats: ["42"],
    }),
    undefined,
  );
  assert.throws(() =>
    readConfig({
      TELEGRAM_BOT_TOKEN: "123:mock",
      TELEGRAM_ALLOWED_USERS: "42",
      TELEGRAM_ALLOWED_CHATS: "-100123",
      MCP_SERVERS_JSON:
        '[{"name":"m","url":"https://secret:pass@example.test"}]',
    }),
  );
  assert.equal(
    resolveMcpServersJson({
      EXECUTOR_MCP_URL: "https://self-hosted.example/mcp",
    }),
    "[]",
  );
  assert.equal(
    resolveMcpServersJson({
      EXECUTOR_MCP_URL: "https://self-hosted.example/mcp",
      EXECUTOR_TOKEN: "synthetic-executor-key",
    }),
    '[{"name":"executor","url":"https://self-hosted.example/mcp","tokenEnv":"EXECUTOR_TOKEN"}]',
  );
  await assert.rejects(
    () => environmentModels({ LLM_BASE_URL: "https://llm.example/v1" }),
    /chave de API/,
  );
  await assert.rejects(
    () => environmentModels({ LLM_API_KEY: "synthetic-key" }),
    /endpoint do provedor/,
  );
  await assert.rejects(
    () =>
      environmentModels(
        {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "synthetic-key",
        },
        {
          fetch: async () => {
            throw new Error("offline");
          },
        },
      ),
    /LLM_MODELS/,
  );
  const discovered = await environmentModels(
    { LLM_BASE_URL: "https://llm.example/v1", LLM_API_KEY: "synthetic-key" },
    {
      fetch: async (url) => {
        assert.equal(String(url), "https://llm.example/v1/models");
        return new Response(
          JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }),
          { status: 200 },
        );
      },
    },
  );
  assert.deepEqual(
    discovered.getModels("llm").map((model) => model.id),
    ["a", "b"],
  );
  assert.equal(discovered.getModels("llm")[0].reasoning, false);
  // Sem "image" o provider troca a imagem por um marcador de texto.
  assert.ok(discovered.getModels("llm")[0].input.includes("image"));
  // Deploy-diagnostic errors must name the cause without leaking the key.
  const keyEnv = {
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: "synthetic-key",
  };
  await assert.rejects(
    () =>
      environmentModels(keyEnv, {
        fetch: async () => new Response("{}", { status: 401 }),
      }),
    /HTTP 401/,
  );
  await assert.rejects(
    () =>
      environmentModels(keyEnv, {
        fetch: async () => new Response("{}", { status: 404 }),
      }),
    /HTTP 404/,
  );
  await assert.rejects(
    () =>
      environmentModels(keyEnv, {
        fetch: async () => {
          const error = new Error("timed out");
          error.name = "TimeoutError";
          throw error;
        },
      }),
    /não respondeu em 10s/,
  );
  await assert.rejects(
    () =>
      discoverLlmModels(
        "https://llm.example/v1",
        "synthetic-key",
        async () =>
          new Response(JSON.stringify({ nope: true }), { status: 200 }),
      ),
    /catálogo inválido/,
  );
  assert.equal(
    readConfig({
      TELEGRAM_BOT_TOKEN: "123:mock",
      TELEGRAM_ALLOWED_USERS: "42",
      TELEGRAM_ALLOWED_CHATS: "-100123",
      EXECUTOR_MCP_URL: "https://cloud.example/mcp",
      EXECUTOR_TOKEN: "synthetic-executor-key",
    }).mcp[0]?.url,
    "https://cloud.example/mcp",
  );
  assert.equal(
    readConfig({
      TELEGRAM_BOT_TOKEN: "123:mock",
      TELEGRAM_ALLOWED_USERS: "42",
      TELEGRAM_ALLOWED_CHATS: "-100123",
      EXECUTOR_MCP_URL: "https://ignored.example/mcp",
      MCP_SERVERS_JSON:
        '[{"name":"executor","url":"https://override.example/mcp","tokenEnv":"EXECUTOR_TOKEN"}]',
      EXECUTOR_TOKEN: "synthetic-executor-key",
    }).mcp[0]?.url,
    "https://override.example/mcp",
  );
});

test("copied callback message ID, sensitive and oversized reviews cannot authorize; stop isolates topics", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const first = f.app.telegramChats.selection(f.owner)!;
    await f.send("/status", 22);
    const second = f.app.telegramChats.selection({
      ...f.owner,
      messageThreadId: 22,
    })!;
    await f.app.mcpCalls.execute(first, 10, "executor", "execute", {});
    await f.bot.flush();
    const firstCard = f.views.at(-1)!;
    await f.click(f.button("Aprovar", firstCard), { ...firstCard, id: 999999 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 1);
    // A fresh independent request in another topic remains pending after /stop here.
    await f.app.mcpCalls.execute(second, 20, "executor", "execute", {});
    await f.bot.flush();
    const secondCard = f.views.at(-1)!;
    await f.send("/stop");
    assert.equal(f.app.mcpCalls.interactions(second).at(-1)!.state, "pending");
    await f.click(f.button("Aprovar", secondCard), secondCard);
    await until(() => f.calls.length === 3);
    assert.equal(
      (f.calls[2].args.response as { action: string }).action,
      "accept",
    );
    for (const [n, input] of [
      { apiKey: "private-value", body: "secret review" },
      { body: "x".repeat(30000) },
    ].entries()) {
      f.setResult({
        status: "approval-required",
        requestId: `sensitive-${n}`,
        expiresAt: Date.now() + 60000,
        invocation: { app: "mock", tool: "send", input },
        elicitation: {
          mode: "form",
          message: "Review",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await f.app.mcpCalls.execute(first, 30 + n, "executor", "execute", {});
      await f.bot.flush();
      const card = f.views.at(-1)!;
      assert.equal(
        card.markup?.inline_keyboard
          .flat()
          .some((b) => b.text.includes("Aprovar")),
        false,
      );
      assert.doesNotMatch(card.text, /private-value/);
      f.app.mcpCalls.cancelConversation(first);
    }
  } finally {
    await f.close();
  }
});

test("concurrent approve and deny callbacks send exactly one response while engine remains open", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    await f.bot.flush();
    const card = f.views.at(-1)!;
    const yes = f.button("Aprovar", card),
      no = f.button("Recusar", card);
    await Promise.all([f.click(yes, card), f.click(no, card)]);
    await until(
      () =>
        !!f.app.store.get(
          "SELECT 1 FROM deliveries WHERE id LIKE 'telegram:mcp-result:%'",
        ),
    );
    assert.equal(f.calls.filter((c) => c.tool === "resume").length, 1);
    await f.click(yes, card);
    await f.click(no, card);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("status reconciles an uncertain result only after explicit external verification without replay", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.setResult({
      status: "unavailable",
      requestId: "lost-result",
      reason: "answered",
    });
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    await f.send("/status");
    const card = f.views.at(-1)!;
    assert.match(card.text, /incerto/);
    await f.click(f.button("Registrar", card), card);
    const review = f.views.at(-1)!;
    await f.click(f.button("Verifiquei: ação concluída", review), review);
    assert.equal(f.app.mcpCalls.list(id)[0].state, "reconciled");
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("cron creation rejects a copied confirmation and an incomplete multi-part preview", async () => {
  const f = await fixture();
  try {
    await f.send("/crons");
    await f.click(f.button("Criar"));
    const prompt = f.views.at(-1)!;
    await f.send(
      "Preview test\n0 9 * * *\nUTC\nFull review",
      11,
      -100123,
      42,
      prompt.id,
    );
    const confirm = f.views.at(-1)!;
    await f.click(f.button("Confirmar criação"), { ...confirm, id: 999999 });
    assert.equal(f.app.tasks.list().length, 0);
    await f.send("/crons");
    await f.click(f.button("Criar"));
    const longPrompt = f.views.at(-1)!;
    f.fail(true);
    await f.send(
      "Long preview\n0 9 * * *\nUTC\n" + "x".repeat(6000),
      11,
      -100123,
      42,
      longPrompt.id,
    );
    f.fail(false);
    const count = f.views.length;
    await f.bot.flush();
    assert.equal(f.views.length, count);
    assert.equal(f.app.tasks.list().length, 0);
  } finally {
    await f.close();
  }
});

test("opaque sends keep only denial; an old persisted owner-bound approval fails the new guard after restart", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.setResult({
      status: "approval-required",
      requestId: "old-draft",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "gmail",
        tool: "send_email",
        input: { draftId: "draft-123" },
      },
      elicitation: {
        mode: "form",
        message:
          "Send a message to recipient@example.test with body: looks safe",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    const item = f.app.mcpCalls.interactions(id).at(-1)!;
    const token = savedButton(f.app, {
      kind: "mcp",
      owner: f.owner,
      originThreadId: 11,
      conversationId: id,
      interactionId: item.id,
      interactionHash: hash(item.payload),
      authorizationVersion: f.app.store.authorizationVersion(f.owner, id),
      decision: "accept",
    });
    queueControl(
      f.app,
      `telegram:mcp:${item.id}`,
      f.owner,
      id,
      "Legacy opaque review",
      { inline_keyboard: [[{ text: "Legacy approve", callback_data: token }]] },
    );
    await f.bot.flush();
    const old = f.views.find((view) =>
      view.text.includes("Legacy opaque review"),
    )!;
    assert.ok(old);
    const replacement = f.views.at(-1)!;
    assert.match(replacement.text, /fluxo seguro/);
    assert.equal(
      replacement.markup?.inline_keyboard
        .flat()
        .some((b) => b.text.includes("Aprovar")),
      false,
    );
    await f.restart();
    const data = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:button:${token}`,
      )!.value,
    ) as TelegramButton;
    assert.equal(
      data.interactionHash,
      hash(f.app.mcpCalls.interactions(id).at(-1)!.payload),
    );
    assert.equal(
      data.authorizationVersion,
      f.app.store.authorizationVersion(f.owner, id),
    );
    const receipt = f.app.store.get<{ state: string; result: string }>(
      "SELECT state,result FROM deliveries WHERE id=?",
      `telegram:mcp:${item.id}:0`,
    )!;
    assert.equal(receipt.state, "sent");
    assert.equal(JSON.parse(receipt.result).message_id, old.id);
    await assert.rejects(
      () => decideMcp(f.app, data, old.id),
      /não revisáveis/,
    );
    await f.click(token, old);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 1);
    await f.click(f.button("Recusar", replacement), replacement);
    await until(() => f.calls.length === 2);
    assert.equal(
      (f.calls[1].args.response as { action: string }).action,
      "decline",
    );
  } finally {
    await f.close();
  }
});

test("new literal review replaces an old formatted card without replaying its email invocation", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const body =
      "**Literal bold** [label](https://example.test/real-destination) & entity &lt;not-html&gt; ``` ticks ```` end";
    f.setResult({
      status: "approval-required",
      requestId: "literal-mail",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "outlook",
        tool: "sendMail",
        input: {
          to: "recipient@example.test",
          cc: ["copy@example.test"],
          bcc: "hidden@example.test",
          subject: "<header> & subject",
          body,
        },
      },
      elicitation: {
        mode: "form",
        message: "Review",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await f.app.mcpCalls.execute(id, 1, "executor", "execute", {});
    const item = f.app.mcpCalls.interactions(id).at(-1)!;
    const oldToken = savedButton(f.app, {
      kind: "mcp",
      owner: f.owner,
      originThreadId: 11,
      conversationId: id,
      interactionId: item.id,
      interactionHash: hash(item.payload),
      authorizationVersion: f.app.store.authorizationVersion(f.owner, id),
      decision: "accept",
    });
    queueControl(
      f.app,
      `telegram:mcp:${item.id}`,
      f.owner,
      id,
      "Legacy formatted review",
      { inline_keyboard: [[{ text: "Old approve", callback_data: oldToken }]] },
    );
    await f.bot.flush();
    const old = f.views.find((v) =>
      v.text.includes("Legacy formatted review"),
    )!;
    const card = f.views.at(-1)!;
    assert.match(card.text, /<pre><code>/);
    assert.doesNotMatch(card.text, /<a href|<b>Literal|<header>/);
    assert.match(
      card.text,
      /\[label\]\(https:\/\/example.test\/real-destination\)/,
    );
    assert.match(card.text, /&amp;lt;not-html&amp;gt;/);
    assert.match(card.text, /``` ticks ````/);
    assert.match(card.text, /hidden@example.test/);
    await f.restart();
    const oldData = JSON.parse(
      f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:button:${oldToken}`,
      )!.value,
    ) as TelegramButton;
    await assert.rejects(
      () => decideMcp(f.app, oldData, old.id),
      /Cartão de revisão antigo/,
    );
    await f.click(oldToken, old);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.length, 1);
    f.setResult(undefined);
    await f.click(f.button("Aprovar", card), card);
    await until(() => f.calls.length === 2);
    assert.deepEqual(f.calls[1], {
      tool: "resume",
      args: {
        requestId: "literal-mail",
        response: { action: "accept", content: {} },
      },
    });
  } finally {
    await f.close();
  }
});

test("native wrapper prose cannot authorize; a direct plaintext mail settles its existing waiter once", async () => {
  const f = await fixture();
  const decisions: unknown[] = [];
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    f.gateway.callDirect = async (_server, tool, args, options = {}) => {
      f.calls.push({ tool, args });
      const answer = await options.onElicitation!(
        {
          mode: "form",
          message:
            "Send email to recipient@example.test, subject Review, body Full message.",
          requestedSchema: { type: "object", properties: {} },
        },
        options.signal,
      );
      decisions.push(answer);
      return { content: [], structuredContent: { answer } };
    };
    const opaque = f.app.mcpCalls.execute(id, 1, "executor", "execute", {
      code: "opaque program",
    });
    await until(() =>
      f.app.mcpCalls.interactions(id).some((i) => i.state === "pending"),
    );
    await f.bot.flush();
    const refused = f.views.at(-1)!;
    assert.equal(
      refused.markup?.inline_keyboard
        .flat()
        .some((b) => b.text.includes("Aprovar")),
      false,
    );
    await f.click(f.button("Recusar", refused), refused);
    await opaque;
    assert.deepEqual(decisions, [{ action: "decline" }]);
    const direct = f.app.mcpCalls.execute(id, 2, "executor", "send_email", {
      to: "recipient@example.test",
      cc: ["copy@example.test"],
      bcc: ["hidden@example.test"],
      subject: "Review",
      body: "Full message.",
    });
    await until(() =>
      f.app.mcpCalls.interactions(id).some((i) => i.state === "pending"),
    );
    await f.bot.flush();
    const card = f.views.at(-1)!;
    const token = f.button("Aprovar", card);
    await f.click(token, card);
    await direct;
    await f.click(token, card);
    assert.deepEqual(decisions, [
      { action: "decline" },
      { action: "accept", content: {} },
    ]);
    assert.deepEqual(
      f.calls.map((c) => c.tool),
      ["execute", "send_email"],
    );
  } finally {
    await f.close();
  }
});

test("draft, opaque and escaped sends have no Approve; explicit mail still resumes once", async () => {
  const f = await fixture();
  try {
    await f.send("/status");
    const id = f.app.telegramChats.selection(f.owner)!;
    const explicit = {
      to: "recipient@example.test",
      subject: "Review",
      body: "Plain text that stays visible.",
    };
    const form = {
      mode: "form",
      message: "Send a message to recipient@example.test with body: looks safe",
      requestedSchema: { type: "object", properties: {} },
    };
    let task = 10;
    const denied: {
      requestId: string;
      invocation: Record<string, unknown>;
      visible?: string;
      specific: boolean;
    }[] = [
      {
        requestId: "draft",
        invocation: {
          app: "gmail",
          tool: "send_email",
          input: { draftId: "draft-123" },
        },
        visible: "draft-123",
        specific: true,
      },
      {
        requestId: "message",
        invocation: {
          app: "outlook",
          tool: "sendMail",
          input: { messageId: "m-1" },
        },
        visible: "m-1",
        specific: true,
      },
      {
        requestId: "bare-id",
        invocation: { app: "mail", tool: "send", input: { id: "opaque-id" } },
        visible: "opaque-id",
        specific: true,
      },
      {
        requestId: "drafts-send",
        invocation: {
          app: "gmail",
          tool: "users.drafts.send",
          input: { id: "d-9" },
        },
        visible: "d-9",
        specific: true,
      },
      {
        requestId: "other-name",
        invocation: {
          app: "custom",
          tool: "dispatch",
          input: { draftId: "draft-other" },
        },
        visible: "draft-other",
        specific: true,
      },
      {
        requestId: "raw",
        invocation: {
          app: "gmail",
          tool: "messages.send",
          input: { raw: "VG86IHg=" },
        },
        visible: "VG86IHg=",
        specific: true,
      },
      {
        requestId: "nested",
        invocation: {
          app: "gmail",
          tool: "send",
          input: { message: explicit },
        },
        visible: "Plain text that stays visible.",
        specific: true,
      },
      {
        requestId: "bidi",
        invocation: { app: "gmail", tool: "send\u202eEmail", input: explicit },
        specific: true,
      },
      {
        requestId: "escaped-key",
        invocation: {
          app: "gmail",
          tool: "send_email",
          input: JSON.parse(
            '{"to":"recipient@example.test","subject":"s","body":"Body","\\u0064raftId":"escaped-draft"}',
          ) as Record<string, unknown>,
        },
        visible: "escaped-draft",
        specific: true,
      },
      {
        requestId: "short-b64",
        invocation: {
          app: "gmail",
          tool: "send",
          input: { ...explicit, body: "SGVsbG8=" },
        },
        visible: "SGVsbG8=",
        specific: true,
      },
      {
        requestId: "sibling",
        invocation: {
          app: "mail",
          tool: "send",
          input: explicit,
          draftId: "hidden-draft",
        },
        visible: "hidden-draft",
        specific: true,
      },
      {
        requestId: "extra-field",
        invocation: {
          app: "mail",
          tool: "send",
          input: explicit,
          note: "sibling-note",
        },
        visible: "sibling-note",
        specific: true,
      },
      {
        requestId: "not-mail",
        invocation: {
          app: "calendar",
          tool: "send",
          input: { id: "event-1", title: "Standup" },
        },
        visible: "event-1",
        specific: false,
      },
    ];
    for (const row of denied) {
      f.setResult({
        status: "approval-required",
        requestId: row.requestId,
        expiresAt: Date.now() + 60000,
        invocation: row.invocation,
        elicitation: form,
      });
      await f.app.mcpCalls.execute(id, task++, "executor", "execute", {});
      await f.bot.flush();
      const card = f.views.at(-1)!;
      assert.equal(
        card.markup?.inline_keyboard
          .flat()
          .some((button) => button.text.includes("Aprovar")),
        false,
        row.requestId,
      );
      assert.match(card.text, /fluxo seguro/, row.requestId);
      assert.match(
        card.text,
        row.specific ? /não busca o rascunho/ : /Identificadores, rascunhos/,
        row.requestId,
      );
      if (row.visible) assert.match(card.text, new RegExp(row.visible));
      if (row.requestId === "sibling") {
        const item = f.app.mcpCalls.interactions(id).at(-1)!;
        const token = savedButton(f.app, {
          kind: "mcp",
          owner: f.owner,
          originThreadId: 11,
          conversationId: id,
          interactionId: item.id,
          interactionHash: hash(item.payload),
          authorizationVersion: f.app.store.authorizationVersion(f.owner, id),
          decision: "accept",
        });
        const data = JSON.parse(
          f.app.store.get<{ value: string }>(
            "SELECT value FROM meta WHERE key=?",
            `telegram:button:${token}`,
          )!.value,
        ) as TelegramButton;
        await assert.rejects(
          () => decideMcp(f.app, data, card.id),
          /não revisáveis/,
        );
      }
      f.app.mcpCalls.cancelConversation(id);
    }
    for (const [app, tool] of [
      ["mail", "send"],
      ["gmail", "messages.send"],
      ["gmail", "messages/send"],
      ["outlook", "sendMail"],
      ["custom", "send_email"],
      ["custom", "SEND_EMAIL"],
      ["microsoft", "outlook.send"],
    ]) {
      f.setResult({
        status: "approval-required",
        requestId: `explicit-${app}-${tool}`,
        expiresAt: Date.now() + 60000,
        invocation: { app, tool, input: explicit },
        elicitation: form,
      });
      await f.app.mcpCalls.execute(id, task++, "executor", "execute", {});
      await f.bot.flush();
      const card = f.views.at(-1)!;
      assert.equal(
        card.markup?.inline_keyboard
          .flat()
          .some((button) => button.text.includes("Aprovar")),
        true,
        `${app}/${tool}`,
      );
      assert.match(card.text, /Plain text that stays visible/);
      f.app.mcpCalls.cancelConversation(id);
    }
    f.setResult({
      status: "approval-required",
      requestId: "explicit-resume",
      expiresAt: Date.now() + 60000,
      invocation: {
        app: "microsoft",
        tool: "outlook.send",
        input: explicit,
      },
      elicitation: form,
    });
    await f.app.mcpCalls.execute(id, task++, "executor", "execute", {});
    await f.bot.flush();
    const card = f.views.at(-1)!;
    f.setResult(undefined);
    const before = f.calls.length;
    await f.click(f.button("Aprovar", card), card);
    await until(() => f.calls.length === before + 1);
    assert.deepEqual(f.calls.at(-1), {
      tool: "resume",
      args: {
        requestId: "explicit-resume",
        response: { action: "accept", content: {} },
      },
    });
    const decisions: unknown[] = [];
    f.gateway.callDirect = async (_server, tool, args, options = {}) => {
      f.calls.push({ tool, args });
      const answer = await options.onElicitation!(
        {
          mode: "form",
          message: "Send draft draft-native",
          requestedSchema: { type: "object", properties: {} },
        },
        options.signal,
      );
      decisions.push(answer);
      return { content: [], structuredContent: { answer } };
    };
    const native = f.app.mcpCalls.execute(
      id,
      task++,
      "executor",
      "send_email",
      {
        draftId: "draft-native",
      },
    );
    await until(() =>
      f.app.mcpCalls.interactions(id).some((item) => item.state === "pending"),
    );
    await f.bot.flush();
    const nativeCard = f.views.at(-1)!;
    assert.equal(
      nativeCard.markup?.inline_keyboard
        .flat()
        .some((button) => button.text.includes("Aprovar")),
      false,
    );
    assert.match(nativeCard.text, /draft-native/);
    assert.match(nativeCard.text, /não busca o rascunho/);
    await f.click(f.button("Recusar", nativeCard), nativeCard);
    await native;
    assert.deepEqual(decisions, [{ action: "decline" }]);
  } finally {
    await f.close();
  }
});

test("clean /status replies when connection metadata is missing instead of staying silent", async () => {
  const f = await fixture();
  try {
    f.app.store.run("DELETE FROM meta WHERE key='telegram:connection'");
    await f.send("/status");
    assert.match(
      f.views.at(-1)!.text,
      /TELEGRAM_ALLOWED_USERS|TELEGRAM_ALLOWED_CHATS|metadados ausentes/,
    );
  } finally {
    await f.close();
  }
});

test("clean accepts legacy group chat type in allowlist", async () => {
  const f = await fixture();
  try {
    const update: TelegramUpdate = {
      update_id: 9001,
      message: {
        message_id: 9001,
        text: "/status",
        from: { id: 42 },
        chat: { id: -100123, type: "group" },
      },
    };
    await f.bot.receive(update);
    await f.bot.flush();
    assert.match(f.views.at(-1)!.text, /Modelos:/);
  } finally {
    await f.close();
  }
});

test("an image message reaches the model as an image part, with the caption as text", async () => {
  const f = await fixture();
  try {
    await f.bot.receive({
      update_id: 900001,
      message: {
        message_id: 900001,
        caption: "o que é isso?",
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        photo: [
          { file_id: "photo-1", width: 1280, height: 960, file_size: 2048 },
        ],
      },
    });
    await f.bot.flush();
    const conversationId = f.app.telegramChats.selection(f.owner)!;
    const conversation = await f.app.conversation(conversationId);
    const page = await conversation.entries({}, 50, undefined, context);
    const user = page.items.filter((entry) => entry.kind === "pi.user");
    assert.equal(user.length, 1);
    const content = JSON.stringify(user[0].model);
    assert.match(content, /"type":"image"/);
    assert.match(content, /"mimeType":"image\/jpeg"/);
    // a legenda vira o texto do turno
    assert.match(content, /o que é isso\?/);
  } finally {
    await f.close();
  }
});

test("an unsupported attachment answers with what is accepted instead of staying silent", async () => {
  const f = await fixture();
  try {
    await f.bot.receive({
      update_id: 900002,
      message: {
        message_id: 900002,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        document: {
          file_id: "doc-1",
          file_name: "contrato.pdf",
          mime_type: "application/pdf",
          file_size: 2048,
        },
      },
    });
    await f.bot.flush();
    assert.match(f.views.at(-1)!.text, /só leio imagens/);
    // nada foi admitido: nem conversa foi criada para este chat
    assert.equal(f.app.telegramChats.selection(f.owner), undefined);
  } finally {
    await f.close();
  }
});

test("a voice note is transcribed and the transcription becomes the turn text", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const before = {
    model: process.env.AUDIO_MODEL,
    key: process.env.AUDIO_API_KEY,
    base: process.env.AUDIO_BASE_URL,
  };
  try {
    process.env.AUDIO_MODEL = "whisper-1";
    process.env.AUDIO_API_KEY = "sk-audio";
    process.env.AUDIO_BASE_URL = "https://audio.example/v1";
    const requests: { url: string; form?: FormData }[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        ...(init?.body instanceof FormData ? { form: init.body } : {}),
      });
      return new Response(JSON.stringify({ text: "reunião sexta às dez" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await f.bot.receive({
      update_id: 900003,
      message: {
        message_id: 900003,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        voice: {
          file_id: "voice-1",
          mime_type: "audio/ogg",
          file_size: 2048,
          duration: 3,
        },
      },
    });
    await f.bot.flush();
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/audio\/transcriptions$/);
    assert.equal(requests[0].form?.get("model"), "whisper-1");
    // Telegram sends OGG/Opus, so the upload must carry that name
    assert.equal((requests[0].form?.get("file") as File).name, "voice.ogg");
    const conversationId = f.app.telegramChats.selection(f.owner)!;
    const conversation = await f.app.conversation(conversationId);
    const page = await conversation.entries({}, 50, undefined, context);
    const user = page.items.filter((entry) => entry.kind === "pi.user");
    assert.equal(user.length, 1);
    assert.match(JSON.stringify(user[0].model), /reunião sexta às dez/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["AUDIO_MODEL", before.model],
      ["AUDIO_API_KEY", before.key],
      ["AUDIO_BASE_URL", before.base],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await f.close();
  }
});

test("a photo pick stays legible and inside the byte budget", async () => {
  const f = await fixture();
  try {
    await f.bot.receive({
      update_id: 900004,
      message: {
        message_id: 900004,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        photo: [
          { file_id: "tiny", width: 320, height: 240, file_size: 12_000 },
          { file_id: "legible", width: 1280, height: 960, file_size: 100_000 },
          { file_id: "huge", width: 2560, height: 1920, file_size: 900_000 },
        ],
      },
    });
    await f.bot.flush();
    // the download request carries the chosen file id, never the over-budget size
    assert.deepEqual(f.downloads, ["legible"]);
  } finally {
    await f.close();
  }
});

test("a text-only chat model receives the image as a vision description", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const before = {
    model: process.env.VISION_MODEL,
    key: process.env.VISION_API_KEY,
  };
  try {
    // same model id, now declaring text only: the routing must notice
    f.app.models.setProvider(
      fauxProvider({
        models: [
          { id: "faux-1", reasoning: true, input: ["text"] },
          { id: "faux-2", reasoning: true },
        ],
      }).provider,
    );
    process.env.VISION_MODEL = "vision-1";
    process.env.VISION_API_KEY = "sk-vision";
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "TEXTO DA IMAGEM" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await f.bot.receive({
      update_id: 900005,
      message: {
        message_id: 900005,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        photo: [
          { file_id: "photo-9", width: 1280, height: 960, file_size: 90_000 },
        ],
      },
    });
    await f.bot.flush();
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/chat\/completions$/);
    const conversationId = f.app.telegramChats.selection(f.owner)!;
    const conversation = await f.app.conversation(conversationId);
    const page = await conversation.entries({}, 50, undefined, context);
    const user = page.items.filter((entry) => entry.kind === "pi.user");
    assert.equal(user.length, 1);
    // the description replaced the image part: the history stays text
    assert.match(JSON.stringify(user[0].model), /TEXTO DA IMAGEM/);
    assert.doesNotMatch(JSON.stringify(user[0].model), /"type":"image"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (before.model === undefined) delete process.env.VISION_MODEL;
    else process.env.VISION_MODEL = before.model;
    if (before.key === undefined) delete process.env.VISION_API_KEY;
    else process.env.VISION_API_KEY = before.key;
    await f.close();
  }
});

test("the setup record persists vision and audio under one key", async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.settings.setup(), undefined);
    f.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `setup:${f.app.options.mode ?? "demo"}`,
      JSON.stringify({
        providerId: "custom",
        baseUrl: "https://api.example/v1",
        modelId: "m-1",
        vision: { modelId: "vision-1" },
        audio: {
          modelId: "whisper-1",
          api: "openai",
          baseUrl: "https://api.openai.com/v1",
          language: "pt",
        },
      }),
    );
    const setup = f.app.settings.setup();
    assert.equal(setup?.vision?.modelId, "vision-1");
    assert.equal(setup?.audio?.language, "pt");
  } finally {
    await f.close();
  }
});
/** Temporary env values, restored afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
) {
  const before: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Raw text of the newest user turn: the string the chat model actually reads. */
async function lastUserText(f: Awaited<ReturnType<typeof fixture>>) {
  const id = f.app.telegramChats.selection(f.owner)!;
  const conversation = await f.app.conversation(id);
  const page = await conversation.entries({}, 50, undefined, context);
  const user = page.items.filter((entry) => entry.kind === "pi.user");
  const messages = user.at(-1)!.model as readonly {
    role: string;
    content: unknown;
  }[];
  const content = messages.find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const voiceUpdate = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    from: { id: 42 },
    chat: { id: -100123, type: "supergroup" },
    message_thread_id: 11,
    voice: {
      file_id: "voice-1",
      mime_type: "audio/ogg",
      file_size: 2048,
      duration: 3,
    },
  },
});

test("origin: a transcript reaches the model marked as audio, verbatim", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    await withEnv(
      {
        AUDIO_MODEL: "whisper-1",
        AUDIO_API_KEY: "sk-audio",
        AUDIO_BASE_URL: "https://audio.example/v1",
      },
      async () => {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ text: "reunião sexta às dez" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch;
        await f.bot.receive(voiceUpdate(901001));
        await f.bot.flush();
      },
    );
    const text = await lastUserText(f);
    assert.match(
      text,
      /^\[áudio transcrito · \{"origin":"audio","model":"whisper-1"\}\]/,
    );
    // verbatim: the transcription is not corrected, summarized or wrapped
    assert.match(text, /reunião sexta às dez$/);
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});

test("origin: an automated image description is marked as image", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    // the model cannot see, so the auxiliary backend describes the picture
    f.app.models.setProvider(
      fauxProvider({
        models: [
          { id: "faux-1", reasoning: true, input: ["text"] },
          { id: "faux-2", reasoning: true },
        ],
      }).provider,
    );
    await withEnv(
      { VISION_MODEL: "vision-1", VISION_API_KEY: "sk-vision" },
      async () => {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "um gráfico de vendas" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch;
        await f.bot.receive({
          update_id: 901002,
          message: {
            message_id: 901002,
            from: { id: 42 },
            chat: { id: -100123, type: "supergroup" },
            message_thread_id: 11,
            photo: [
              {
                file_id: "photo-1",
                width: 1280,
                height: 960,
                file_size: 90_000,
              },
            ],
          },
        });
        await f.bot.flush();
      },
    );
    const text = await lastUserText(f);
    assert.match(
      text,
      /^\[imagem: descrição automática · \{"origin":"image","model":"vision-1"\}\]/,
    );
    assert.match(text, /um gráfico de vendas/);
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});

test("origin: typed text carries no prefix and no metadata", async () => {
  const f = await fixture();
  try {
    // user 42 is in the allowlist; anything else is dropped before the turn
    await f.send("bom dia, tudo certo?", 11, -100123, 42);
    const text = await lastUserText(f);
    assert.equal(text, "bom dia, tudo certo?");
  } finally {
    await f.close();
  }
});

test("origin: a failed transcription is admitted with the error, never dropped", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    await withEnv(
      {
        AUDIO_MODEL: "whisper-1",
        AUDIO_API_KEY: "sk-audio",
        AUDIO_BASE_URL: "https://audio.example/v1",
      },
      async () => {
        globalThis.fetch = (async () =>
          new Response("nope", { status: 500 })) as typeof fetch;
        await f.bot.receive(voiceUpdate(901004));
        await f.bot.flush();
      },
    );
    const text = await lastUserText(f);
    assert.match(
      text,
      /^\[áudio · \{"origin":"audio","error":"resposta 500"\}\]/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await f.close();
  }
});

test("the stored setup bootstraps the default until a choice is stored", async () => {
  // the setup is a bootstrap, not a policy: it seeds the first default
  const boot = await fixture({ modelId: "faux-2", effort: "low" });
  try {
    assert.deepEqual(boot.app.settings.defaults(), {
      provider: "faux",
      modelId: "faux-2",
      effort: "low",
    });
  } finally {
    await boot.close();
  }
  // a typo must fail at startup instead of silently running another model
  await assert.rejects(() => fixture({ modelId: "does-not-exist" }));
});

test("/status shows the chat, vision and transcription models", async () => {
  const f = await fixture();
  try {
    // exactly what the wizard writes: one record, one key per function
    f.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `setup:${f.app.options.mode ?? "demo"}`,
      JSON.stringify({
        providerId: "custom",
        baseUrl: "https://api.chat.example/v1",
        modelId: "faux-1",
        effort: "high",
        vision: {
          modelId: "gemini-3.5-flash-lite",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        },
        audio: {
          modelId: "whisper-1",
          api: "openai",
          baseUrl: "https://api.openai.com/v1",
          language: "pt",
        },
      }),
    );
    for (const [provider, key] of [
      ["llm", "sk-chat"],
      ["llm-vision", "g-key"],
      ["llm-audio", "o-key"],
    ])
      f.app.store.run(
        "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
        provider,
        JSON.stringify({ type: "api_key", key }),
      );
    await f.send("/status", 11, -100123, 42);
    const text = f.views.at(-1)!.text;
    assert.match(
      text,
      /^Modelos:\nTexto: faux-1\nVisão: gemini-3\.5-flash-lite\nÁudio: whisper-1 \(pt\)\nEsforço: /,
    );
  } finally {
    await f.close();
  }
});

test("the probed chatVision decides whether an image is native", async () => {
  const f = await fixture();
  try {
    // the catalog says text only, but the probe said the model reads images
    f.app.models.setProvider(
      fauxProvider({
        models: [
          { id: "faux-1", reasoning: true, input: ["text"] },
          { id: "faux-2", reasoning: true },
        ],
      }).provider,
    );
    f.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      `setup:${f.app.options.mode ?? "demo"}`,
      JSON.stringify({
        providerId: "custom",
        baseUrl: "https://api.example/v1",
        modelId: "faux-1",
        chatVision: true,
      }),
    );
    await f.bot.receive({
      update_id: 902001,
      message: {
        message_id: 902001,
        from: { id: 42 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 11,
        photo: [
          { file_id: "photo-1", width: 1280, height: 960, file_size: 50_000 },
        ],
      },
    });
    await f.bot.flush();
    const text = await lastUserText(f);
    // native: the image itself reached the model, no description, no refusal
    assert.match(text, /"type":"image"|\[imagem/);
    assert.doesNotMatch(text, /descrição automática/);
  } finally {
    await f.close();
  }
});

test("a reply that carries a file delivers it after the text", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.app.create("anexo de saída");
    f.app.store.queueTelegram(
      `${conversationId}:outbound-1`,
      "-100123",
      "",
      3500,
      conversationId,
      11,
      undefined,
      [
        {
          kind: "audio",
          url: "https://example.test/a.mp3",
          mimeType: "audio/mpeg",
        },
        {
          kind: "document",
          data: "QUJD",
          mimeType: "application/pdf",
          filename: "a.pdf",
        },
      ],
    );
    await f.bot.flush();
    // Nothing to say, so no text message: only the files.
    assert.equal(f.views.length, 0);
    assert.deepEqual(
      f.media.map((m) => [m.kind, m.url ?? m.hasBytes, m.thread]),
      [
        ["audio", "https://example.test/a.mp3", 11],
        ["document", true, 11],
      ],
    );
  } finally {
    await f.close();
  }
});

test("a failed upload is recorded and does not swallow the text", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.app.create("anexo que falha");
    f.mediaFails = true;
    f.app.store.queueTelegram(
      `${conversationId}:outbound-2`,
      "-100123",
      "segue o relatório",
      3500,
      conversationId,
      11,
      undefined,
      [
        {
          kind: "audio",
          url: "https://example.test/a.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    );
    await f.bot.flush();
    // The text arrived; the upload error is in the delivery row, not in the chat.
    assert.equal(f.views.length, 1);
    assert.match(f.views[0]!.text, /segue o relatório/);
    const row = f.app.store.get<{ state: string; result: string }>(
      "SELECT state,result FROM deliveries WHERE id=?",
      `${conversationId}:outbound-2:0`,
    );
    assert.equal(row?.state, "sent");
    assert.match(String(row?.result), /upload refused/);
  } finally {
    await f.close();
  }
});

test("an empty answer with no file still sends nothing", async () => {
  const f = await fixture();
  try {
    const conversationId = await f.app.create("resposta silenciosa");
    f.app.store.queueTelegram(
      `${conversationId}:outbound-3`,
      "-100123",
      "",
      3500,
      conversationId,
      11,
    );
    await f.bot.flush();
    assert.equal(f.views.length, 0);
    assert.equal(f.media.length, 0);
  } finally {
    await f.close();
  }
});

test("/reload starts a new conversation in the same chat and keeps the old one", async () => {
  const f = await fixture();
  try {
    await f.send("primeira mensagem", 11, -100123, 42);
    const first = f.app.telegramChats.selection(f.owner)!;
    assert.ok(first);
    await f.send("/reload", 11, -100123, 42);
    assert.match(f.views.at(-1)!.text, /Conversa reiniciada/);
    // Nothing is selected until the next message, which opens a fresh conversation.
    assert.equal(f.app.telegramChats.selection(f.owner), undefined);
    await f.send("depois do reload", 11, -100123, 42);
    const second = f.app.telegramChats.selection(f.owner)!;
    assert.notEqual(second, first);
    // The old conversation is still there: its history is not sent to the model, but
    // it is not deleted either.
    const old = await f.app.conversation(first);
    const page = await old.entries({}, 50, undefined, context);
    assert.equal(page.items.length > 0, true);
  } finally {
    await f.close();
  }
});
