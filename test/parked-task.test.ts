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

test(
  "cinco cortes avisam o tópico e /retomar continua a resposta pendente",
  { timeout: 90_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-parked-"));
    let app: Runtime | undefined;
    try {
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
      app = await Runtime.open({
        dir,
        models,
        gateway: { call: async () => ({}) },
        telegramOnly: true,
        initialize: (store) =>
          configureTelegram(store, config, { id: 123, username: "test_bot" }),
      });
      const noticeDeadline = Date.now() + 15_000;
      let notice:
        | {
            chat: string;
            text: string;
            messageThreadId: number;
          }
        | undefined;
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
      assert.match(notice.text, /5 vezes seguidas/);
      assert.match(notice.text, /\/retomar/);

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
        /5 vezes seguidas/.test(row.text),
      );
      assert.equal(restartNotices.length, 1);
      assert.equal(restartNotices[0]?.thread, 11);

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          text: "/retomar",
          from: { id: 42 },
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: 11,
        },
      };
      await bot.receive(update);
      await bot.flush();
      assert.match(sent.at(-1)?.text ?? "", /continue/);
    } finally {
      if (app) await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
