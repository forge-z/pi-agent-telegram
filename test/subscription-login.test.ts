import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Store } from "../src/store.js";
import {
  modelDefaultsConfirmedKey,
  modelDefaultsKey,
} from "../src/settings.js";
import { writeStoredSetup } from "../src/setup.js";
import {
  readChatgptAuthMode,
  runSubscriptionLogin,
  subscriptionChatCatalog,
  writeChatgptAuthMode,
} from "../src/subscription-login.js";

test("writeChatgptAuthMode persists volume equivalent of LLM_AUTH=chatgpt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sub-login-"));
  const store = new Store(dir);
  try {
    assert.equal(readChatgptAuthMode(store), false);
    writeChatgptAuthMode(store);
    assert.equal(readChatgptAuthMode(store), true);
  } finally {
    store.close();
  }
});

test("runSubscriptionLogin stores oauth tokens and auth mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sub-login-"));
  const store = new Store(dir);
  const loginCalls: string[] = [];
  const models = {
    login: async (providerId: string) => {
      loginCalls.push(providerId);
    },
    getModels: () => [
      {
        id: "gpt-5",
        provider: "openai",
        name: "GPT-5",
        input: ["text", "image"],
      },
    ],
  } as unknown as MutableModels;

  await runSubscriptionLogin(store, models, "openai", {
    prompt: async () => "device_code",
    notify: () => {},
  });

  assert.deepEqual(loginCalls, ["openai"]);
  assert.equal(readChatgptAuthMode(store), true);
  const catalog = subscriptionChatCatalog(models, "openai");
  assert.equal(catalog[0]?.id, "gpt-5");
  assert.ok(catalog[0]?.efforts.length);
  store.close();
});

test("setup with openai-codex default validates after bootstrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sub-default-"));
  const store = new Store(dir);
  store.run(
    "INSERT INTO credentials VALUES (?,?)",
    "openai-codex",
    JSON.stringify({
      type: "oauth",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct",
    }),
  );
  writeChatgptAuthMode(store);

  const { bootstrapModels } = await import("../src/config.js");
  const { SqlCredentials } = await import("../src/store.js");
  const { Runtime } = await import("../src/runtime.js");
  const models = await bootstrapModels(new SqlCredentials(store), {
    LLM_AUTH: "chatgpt",
  });
  const codexModels = models.getModels("openai-codex");
  assert.ok(codexModels.length > 0);
  const modelId = codexModels[0].id.replace(/^models\//, "");
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId: "openai-codex",
        baseUrl: models.getProvider("openai-codex")?.baseUrl ?? "",
        modelId,
        effort: "high",
        authMode: "chatgpt",
      },
      {},
    );
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      modelDefaultsKey("live"),
      JSON.stringify({
        provider: "openai-codex",
        modelId,
        effort: "high",
      }),
    );
    db.prepare(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(modelDefaultsConfirmedKey("live"), "true");
  } finally {
    db.close();
  }

  const stored = (await import("../src/setup.js")).readStoredSetup(dir);
  assert.equal(stored.record?.authMode, "chatgpt");
  assert.equal(stored.record?.providerId, "openai-codex");
  assert.equal(stored.apiKey, undefined);

  const app = await Runtime.open({
    dir,
    store,
    models,
    gateway: { call: async () => ({}) },
    mode: "live",
    telegramOnly: true,
  });
  try {
    const defaults = app.settings.defaults();
    assert.equal(defaults.provider, "openai-codex");
    assert.equal(defaults.modelId, modelId);
    assert.ok(
      app.settings
        .catalog("openai-codex")
        .some((entry) => entry.id === modelId),
    );
  } finally {
    await app.close();
  }
});
