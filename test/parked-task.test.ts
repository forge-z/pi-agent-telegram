import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { McpGateway } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";
import { Telegram, type TelegramUpdate } from "../src/telegram.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};

function cut(dir: string, submit: boolean) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "test/park-child.ts", dir, submit ? "submit" : "wait"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`corte não terminou: ${output} ${errors}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`corte saiu ${code}: ${errors}\n${output}`));
    });
  });
}

async function parkedTopic(withMcp = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-parked-"));
  for (let cutIndex = 0; cutIndex < 5; cutIndex += 1)
    await cut(dir, cutIndex === 0);
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([
    async () => {
      await new Promise(() => {});
      return fauxAssistantMessage("nunca");
    },
    async () => fauxAssistantMessage("retomado"),
  ]);
  models.setProvider(faux.provider);
  const gateway = new McpGateway([
    {
      name: "executor",
      url: "http://127.0.0.1:9/mcp",
      mode: "direct",
    },
  ]);
  gateway.catalog = async () => [];
  const app = await Runtime.open({
    dir,
    models,
    gateway: withMcp ? gateway : { catalog: async () => [] },
    initialize: (store) =>
      configureTelegram(store, config, { id: 123, username: "test_bot" }),
  });
  const noticeDeadline = Date.now() + 15_000;
  let notice:
    { chat: string; text: string; messageThreadId: number } | undefined;
  while (Date.now() < noticeDeadline) {
    notice = app.store.get<{
      chat: string;
      text: string;
      messageThreadId: number;
    }>(
      "SELECT chat,text,messageThreadId FROM deliveries WHERE id LIKE 'parked:%'",
    );
    if (notice) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(notice);
  assert.equal(notice.chat, "-100123");
  assert.equal(notice.messageThreadId, 11);
  assert.match(notice.text, /pi\.generation/);
  assert.match(notice.text, /5 times in a row/);
  assert.match(notice.text, /\/resume/);
  assert.doesNotMatch(notice.text, /\/retomar/);
  const sent: { chat: string; text: string; thread?: number }[] = [];
  const bot = new Telegram(
    app,
    {
      send: async (chat, text, opts) => {
        sent.push({ chat, text, thread: opts?.messageThreadId });
        return { message_id: sent.length };
      },
    },
    config.users,
    config.chats,
    "test_bot",
    false,
    123,
  );
  await bot.flush();
  const restartNotices = sent.filter((row) =>
    /5 times in a row/.test(row.text),
  );
  assert.equal(restartNotices.length, 1);
  assert.equal(restartNotices[0]?.thread, 11);
  return { dir, app, sent, bot };
}

async function sendResume(bot: Telegram) {
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      text: "/resume",
      from: { id: 42 },
      chat: { id: -100123, type: "supergroup" },
      message_thread_id: 11,
    },
  };
  await bot.receive(update);
  await bot.flush();
}

test(
  "cinco cortes avisam o tópico e /resume continua só a tarefa estacionada",
  { timeout: 90_000 },
  async () => {
    let opened: Awaited<ReturnType<typeof parkedTopic>> | undefined;
    try {
      opened = await parkedTopic();
      const before = opened.sent.length;
      await sendResume(opened.bot);
      const added = opened.sent.slice(before);
      assert.equal(added.length, 1);
      assert.match(added[0]!.text, /continue/);
      assert.doesNotMatch(added[0]!.text, /email may have gone out/);
      assert.doesNotMatch(added[0]!.text, /uncertain MCP/);
    } finally {
      if (opened) await opened.app.close();
      if (opened) await rm(opened.dir, { recursive: true, force: true });
    }
  },
);

test(
  "/resume clears a crash-parked task and an uncertain MCP result in one reply",
  { timeout: 90_000 },
  async () => {
    let opened: Awaited<ReturnType<typeof parkedTopic>> | undefined;
    try {
      opened = await parkedTopic(true);
      const conversationId = opened.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram_topic_selection WHERE chat=? AND user=? AND messageThreadId=?",
        "-100123",
        "42",
        11,
      )!.conversationId;
      opened.app.store.run(
        `INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt)
         VALUES ('lost',?,'executor','write','{}','uncertain','{"isError":true}','executor',0)`,
        conversationId,
      );
      const before = opened.sent.length;
      await sendResume(opened.bot);
      const added = opened.sent.slice(before);
      assert.equal(added.length, 1);
      assert.match(added[0]!.text, /continue/);
      assert.match(added[0]!.text, /uncertain MCP result/);
      assert.match(added[0]!.text, /History was not changed/);
      assert.match(added[0]!.text, /email may have gone out/);
      assert.match(added[0]!.text, /before the agent continues/);
      assert.equal(
        opened.app.store.get<{ state: string }>(
          "SELECT state FROM mcp_calls WHERE id='lost'",
        )?.state,
        "skipped",
      );
    } finally {
      if (opened) await opened.app.close();
      if (opened) await rm(opened.dir, { recursive: true, force: true });
    }
  },
);
