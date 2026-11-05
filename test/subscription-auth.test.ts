import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapModels,
  SetupRequiredError,
  LLM_PROVIDER_ID,
} from "../src/config.js";
import { Store, SqlCredentials } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import {
  chatgptAuthMode,
  isSubscriptionProvider,
  openAiDeviceId,
} from "../src/subscription-auth.js";

test("subscription helpers recognize chatgpt auth mode", () => {
  assert.equal(chatgptAuthMode({ LLM_AUTH: "chatgpt" }), true);
  assert.equal(chatgptAuthMode({ LLM_AUTH: "subscription" }), true);
  assert.equal(chatgptAuthMode({}), false);
  assert.equal(isSubscriptionProvider("openai"), true);
  assert.equal(isSubscriptionProvider("llm"), false);
});

test("bootstrap registers oauth providers alongside api-key llm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-oauth-"));
  const store = new Store(dir);
  try {
    const models = await bootstrapModels(new SqlCredentials(store), {
      LLM_BASE_URL: "https://llm.example/v1",
      LLM_API_KEY: "synthetic-key",
      LLM_MODELS: "chat-model",
    });
    const ids = models.getProviders().map((provider) => provider.id);
    assert.ok(ids.includes(LLM_PROVIDER_ID));
    assert.ok(ids.includes("openai"));
    assert.ok(ids.includes("openai-codex"));
    assert.ok(models.getProvider("openai")?.auth.oauth);
  } finally {
    store.close();
  }
});

test("chatgpt auth mode waits for login without api key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-oauth-wait-"));
  const store = new Store(dir);
  try {
    await assert.rejects(
      () => bootstrapModels(new SqlCredentials(store), { LLM_AUTH: "chatgpt" }),
      (error: unknown) =>
        error instanceof SetupRequiredError && /login/i.test(error.message),
    );
  } finally {
    store.close();
  }
});

test("openai device id is stable on the volume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-device-"));
  const store = new Store(dir);
  try {
    const first = openAiDeviceId(store);
    const second = openAiDeviceId(store);
    assert.match(first, /^[0-9a-f-]{36}$/i);
    assert.equal(first, second);
  } finally {
    store.close();
  }
});

test("closing the bootstrap store breaks OAuth checkAuth until Runtime shares the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-oauth-store-"));
  const store = new Store(dir);
  store.run(
    "INSERT INTO credentials VALUES (?,?)",
    "openai",
    JSON.stringify({
      type: "oauth",
      access: "token",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct",
    }),
  );
  const models = await bootstrapModels(new SqlCredentials(store), {
    LLM_AUTH: "chatgpt",
  });
  store.close();
  await assert.rejects(
    () => models.checkAuth("openai"),
    (error: unknown) =>
      error instanceof Error &&
      /not open|Credential store read failed/i.test(error.message),
  );

  const live = new Store(dir);
  const rebound = await bootstrapModels(new SqlCredentials(live), {
    LLM_AUTH: "chatgpt",
  });
  const app = await Runtime.open({
    dir,
    store: live,
    models: rebound,
    gateway: { call: async () => ({}) },
    mode: "live",
    telegramOnly: true,
  });
  try {
    assert.ok(await app.models.checkAuth("openai"));
    assert.ok(app.settings.catalog("openai").length > 0);
  } finally {
    await app.close();
  }
});
