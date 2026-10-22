import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
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
  "cinco cortes estacionam a tarefa, avisam o tópico e /retomar a executa de novo",
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
      const parked = (await app.harness.inspect(context)).tasks.filter(
        (task) =>
          task.state.kind === "blocked" &&
          task.state.reason === "restart_limit",
      );
      assert.equal(parked.length, 1);
      assert.equal(parked[0]?.record.kind, "pi.generation");
      const notice = app.store.get<{
        chat: string;
        text: string;
        messageThreadId: number;
      }>(
        "SELECT chat,text,messageThreadId FROM deliveries WHERE id LIKE 'parked:%'",
      );
      assert.ok(notice);
      assert.equal(notice.chat, "-100123");
      assert.equal(notice.messageThreadId, 11);
      assert.match(notice.text, /pi\.generation/);
      assert.match(notice.text, new RegExp(`#${parked[0]?.record.id}`));
      assert.match(notice.text, /5 vezes seguidas sem avançar/);
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
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.thread, 11);
      assert.match(sent[0]?.text ?? "", /5 vezes seguidas/);

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
      assert.match(
        sent.at(-1)?.text ?? "",
        new RegExp(`pi\\.generation #${parked[0]?.record.id}`),
      );
      const again = (await app.harness.inspect(context)).tasks.find(
        (task) => task.record.id === parked[0]?.record.id,
      );
      assert.ok(again);
      assert.notEqual(
        again.state.kind === "blocked" &&
          again.state.reason === "restart_limit",
        true,
      );
      assert.equal(again.record.state.status, "running");
    } finally {
      if (app) await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
