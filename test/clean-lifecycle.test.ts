import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../src/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  configureTelegram,
  TelegramPolling,
  cleanCommands,
} from "../src/telegram-polling.js";
import type { TelegramApi } from "../src/telegram-api.js";
import { TelegramBotApi } from "../src/telegram-api.js";
import { secretRedactor } from "../src/config.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-lifecycle-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const options = {
    dir,
    models,
    gateway: { call: async () => ({}) },
    telegramOnly: true,
    initialize: (store: Runtime["store"]) =>
      configureTelegram(store, config, { id: 123 }),
  };
  const app = await Runtime.open(options);
  return {
    dir,
    app,
    options,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check());
}
test("polling readiness, health and graceful stop stay offline and create no topics", async () => {
  const f = await fixture();
  const methods: string[] = [];
  const menuLanguages: (string | undefined)[] = [];
  let starts = 0;
  f.app.tasks.start = () => {
    starts++;
  };
  const api: TelegramApi = {
    call: async (method, payload, signal) => {
      methods.push(method);
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "setMyCommands") {
        menuLanguages.push(
          (payload as { language_code?: string }).language_code,
        );
        return true;
      }
      if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 10));
        if (signal?.aborted) throw new Error("closed");
        return [];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const polling = new TelegramPolling(f.app, api, config, { id: 123 });
  try {
    polling.start();
    await until(() => starts === 1);
    await new Promise((r) => setTimeout(r, 1100));
    const health = JSON.parse(
      await readFile(join(f.dir, "health.json"), "utf8"),
    );
    assert.ok(Date.now() - health.at < 2000);
    await polling.close();
    const count = methods.length;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(methods.length, count);
    assert.equal(f.app.store.all("SELECT * FROM conversations").length, 0);
    assert.deepEqual(
      cleanCommands.map((c) => c.command),
      ["model", "thinking", "crons", "stop", "status", "help"],
    );
    // The base list and the Portuguese copy an earlier implementation wrote: a
    // client in that language must not keep the old commands.
    assert.deepEqual([...menuLanguages].sort(), [undefined, "pt"].sort());
    assert.equal(
      methods.some((m) => /createForumTopic|deleteWebhook/.test(m)),
      false,
    );
  } finally {
    await polling.close();
    await f.close();
  }
});
test("existing webhook is a fatal setup result before scheduler starts", async () => {
  const f = await fixture();
  let starts = 0,
    failed = false;
  f.app.tasks.start = () => {
    starts++;
  };
  const polling = new TelegramPolling(
    f.app,
    { call: async () => ({ url: "https://example.test/private-webhook" }) },
    config,
    { id: 123 },
  );
  try {
    polling.start(() => {
      failed = true;
    });
    await until(() => failed);
    assert.equal(starts, 0);
    await polling.close();
  } finally {
    await polling.close();
    await f.close();
  }
});
test("persisted model selection/default survives changed initial environment settings", async () => {
  const f = await fixture();
  let app = f.app;
  try {
    const owner = { chat: "-100123", user: "42", messageThreadId: 11 };
    const id = await app.telegramChats.ensure(owner);
    await app.settings.saveConversation(id, {
      provider: "faux",
      modelId: "faux-1",
      effort: "off",
    });
    await app.close();
    app = await Runtime.open({
      ...f.options,
      modelId: "removed-bootstrap-model",
      provider: "removed-bootstrap-provider",
    });
    assert.deepEqual(await app.settings.conversation(id), {
      provider: "faux",
      modelId: "faux-1",
      effort: "off",
    });
    assert.equal(app.settings.defaults().modelId, "faux-1");
    assert.equal(app.telegramChats.selection(owner), id);
  } finally {
    await app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("live mode warns once about an implicit model until a default is chosen", async () => {
  const f = await fixture();
  await f.app.close();
  const app = await Runtime.open({ ...f.options, mode: "live" });
  try {
    const initial = app.settings.defaults();
    assert.ok(initial.modelId);
    assert.equal(app.settings.hasExplicitDefaults(), false);
    assert.match(
      app.settings.pendingModelNotice("conversation-a") ?? "",
      /nenhum modelo padrão/,
    );
    app.settings.markModelNoticeShown("conversation-a");
    assert.equal(app.settings.pendingModelNotice("conversation-a"), undefined);
    assert.match(
      app.settings.pendingModelNotice("conversation-b") ?? "",
      /nenhum modelo padrão/,
    );
    app.settings.saveDefaults({
      provider: initial.provider,
      modelId: initial.modelId,
      effort: initial.effort,
    });
    assert.equal(app.settings.hasExplicitDefaults(), true);
    assert.equal(app.settings.pendingModelNotice("conversation-b"), undefined);
  } finally {
    await app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("transport errors and configured secret values are redacted without any external request", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("https://api.telegram.org/bot123:synthetic-only/getMe");
    };
    await assert.rejects(
      () => new TelegramBotApi("123:synthetic-only").call("getMe"),
      (e) => e instanceof Error && !e.message.includes("synthetic-only"),
    );
    const redact = secretRedactor({
      TELEGRAM_BOT_TOKEN: "123:synthetic-only",
      OPENAI_API_KEY: "plain-configured-secret",
    });
    assert.equal(
      redact("123:synthetic-only plain-configured-secret"),
      "[REDACTED] [REDACTED]",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("shutdown during Telegram setup does not report a polling failure or start cron admission", async () => {
  const f = await fixture();
  let started = false,
    failed = false,
    called = false;
  f.app.tasks.start = () => {
    started = true;
  };
  const api: TelegramApi = {
    call: async (_method, _payload, signal) => {
      called = true;
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
      return {};
    },
  };
  const polling = new TelegramPolling(f.app, api, config, { id: 123 });
  try {
    polling.start(() => {
      failed = true;
    });
    await until(() => called);
    await polling.close();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(failed, false);
    assert.equal(started, false);
  } finally {
    await polling.close();
    await f.close();
  }
});
test("redaction covers API-key environment names and MCP token files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-secrets-"));
  try {
    const tokenFile = join(dir, "mcp-token");
    await writeFile(tokenFile, "synthetic-file-secret");
    // Names ending in TOKEN/SECRET/PASSWORD/API_KEY stay configurable, and every
    // resolved MCP token (tokenEnv or tokenFile) is redacted with its escaping variants.
    const redact = secretRedactor(
      { CUSTOM_API_KEY: "synthetic-custom&secret" },
      [
        {
          name: "executor",
          url: "https://example.test/mcp",
          readTools: [],
          actionTools: [],
          tokenFile,
        },
      ],
    );
    assert.equal(
      redact(
        "synthetic-custom&secret synthetic-custom&amp;secret synthetic-custom%26secret synthetic-file-secret",
      ),
      "[REDACTED] [REDACTED] [REDACTED] [REDACTED]",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
