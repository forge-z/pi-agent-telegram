import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  bootstrapModels,
  environmentModels,
  LLM_PROVIDER_ID,
  SetupRequiredError,
} from "../src/config.js";
import {
  migrateLegacyOfficialSetup,
  readStoredSetup,
  writeStoredSetup,
} from "../src/setup.js";
import { Store, SqlCredentials } from "../src/store.js";
import { resolveSetupChoice, setupChoices } from "../src/native-providers.js";

const catalog = "fake-1|131072|8192|low+high";

test("the setup record and the key round-trip through the volume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-"));
  assert.deepEqual(readStoredSetup(dir), {});

  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId: "deepseek",
        baseUrl: "https://api.deepseek.com",
        modelId: "fake-1",
        effort: "high",
        vision: { modelId: "gemini-3.5-flash-lite" },
        audio: {
          modelId: "whisper-1",
          api: "openai",
          baseUrl: "https://api.openai.com/v1",
          language: "pt",
        },
      },
      { chat: "sk-stored" },
    );
  } finally {
    db.close();
  }

  const stored = readStoredSetup(dir);
  assert.equal(stored.apiKey, "sk-stored");
  assert.equal(stored.record?.providerId, "deepseek");
  assert.equal(stored.record?.modelId, "fake-1");
  assert.equal(stored.record?.vision?.modelId, "gemini-3.5-flash-lite");
  assert.equal(stored.record?.audio?.language, "pt");
});

test("the stored setup is enough to register the provider, without LLM env", async () => {
  const models = await environmentModels(
    { LLM_MODELS: catalog },
    {
      stored: {
        record: {
          providerId: "custom",
          baseUrl: "https://api.stored.com/v1",
          modelId: "fake-1",
        },
        apiKey: "sk-stored",
      },
    },
  );
  assert.equal(
    models.getProvider(LLM_PROVIDER_ID)?.baseUrl,
    "https://api.stored.com/v1",
  );
  assert.equal(models.getModels(LLM_PROVIDER_ID).length, 1);
});

test("the wizard menu is the pi-ai catalog, with compat last", () => {
  const ids = setupChoices().map((choice) => choice.id);
  for (const id of [
    "anthropic",
    "openai",
    "google",
    "groq",
    "openrouter",
    "xai",
    "deepseek",
    "opencode",
    "opencode-go",
    "mistral",
    "custom",
  ])
    assert.ok(ids.includes(id), id);
  for (const id of [
    "amazon-bedrock",
    "azure",
    "google-vertex",
    "openai-codex",
    "cloudflare-ai-gateway",
    "cloudflare-workers-ai",
  ])
    assert.equal(ids.includes(id), false, id);
  assert.equal(ids.at(-1), "custom");
  assert.equal(resolveSetupChoice("gemini")?.id, "google");
  assert.equal(resolveSetupChoice("opencode-zen")?.id, "opencode");
  assert.equal(resolveSetupChoice("anthropic")?.kind, "native");
  assert.equal(resolveSetupChoice("https://proxy.example/v1")?.kind, "compat");
});

test("an official setup stores the key under the native provider id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-native-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-haiku-4-5",
        effort: "high",
      },
      { chat: "sk-ant-official" },
    );
  } finally {
    db.close();
  }
  const stored = readStoredSetup(dir);
  assert.equal(stored.apiKey, "sk-ant-official");
  assert.equal(stored.record?.providerId, "anthropic");
  const db2 = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
  try {
    const row = db2
      .prepare("SELECT provider, value FROM credentials WHERE provider=?")
      .get("anthropic") as { provider: string; value: string };
    assert.equal(row.provider, "anthropic");
    assert.equal(JSON.parse(row.value).key, "sk-ant-official");
    const legacy = db2
      .prepare("SELECT provider FROM credentials WHERE provider='llm'")
      .get();
    assert.equal(legacy, undefined);
  } finally {
    db2.close();
  }
});

test("official credentials on the volume start the bot without LLM_*", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-boot-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  writeStoredSetup(
    db,
    {
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-haiku-4-5",
      effort: "high",
    },
    { chat: "sk-ant-official" },
  );
  db.close();
  const store = new Store(dir);
  try {
    const stored = readStoredSetup(dir);
    const models = await bootstrapModels(
      new SqlCredentials(store),
      {},
      {
        stored,
      },
    );
    assert.equal(models.getProvider(LLM_PROVIDER_ID), undefined);
    assert.equal(models.getProvider("anthropic")?.auth.oauth, undefined);
    assert.ok(models.getProvider("openai")?.auth.oauth);
    assert.ok(await models.checkAuth("anthropic"));
    const model = models.getModel("anthropic", "claude-haiku-4-5");
    assert.ok(model);
    assert.ok(model.contextWindow >= 32768);
    assert.ok(model.cost.input > 0);
    assert.ok(model.input.includes("text"));
  } finally {
    store.close();
  }
});

test("leftover LLM_* does not force the compat provider over an official setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-leftover-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  writeStoredSetup(
    db,
    {
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelId: "gemini-2.5-flash",
      effort: "high",
    },
    { chat: "gemini-official" },
  );
  db.close();
  const store = new Store(dir);
  try {
    const models = await bootstrapModels(
      new SqlCredentials(store),
      {
        LLM_BASE_URL: "https://api.env.com/v1",
        LLM_API_KEY: "sk-leftover",
        LLM_MODELS: catalog,
      },
      { stored: readStoredSetup(dir) },
    );
    assert.equal(models.getProvider(LLM_PROVIDER_ID), undefined);
    assert.equal(
      models.getProvider("google")?.baseUrl,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    assert.ok(await models.checkAuth("google"));
    const flash = models.getModel("google", "gemini-2.5-flash");
    assert.ok(flash);
    assert.ok(flash.cost.output > 0);
  } finally {
    store.close();
  }
});

test("a legacy llm key migrates when the model is in the native catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-migrate-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "setup:live",
    JSON.stringify({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      effort: "high",
    }),
  );
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "model-defaults-selection:live",
    JSON.stringify({
      provider: "llm",
      modelId: "deepseek-flash",
      effort: "high",
    }),
  );
  db.prepare("INSERT INTO credentials VALUES (?,?)").run(
    "llm",
    JSON.stringify({ type: "api_key", key: "sk-legacy" }),
  );
  const migrated = migrateLegacyOfficialSetup(db, {});
  assert.deepEqual(migrated, {
    providerId: "deepseek",
    modelId: "deepseek-flash",
  });
  db.close();
  const stored = readStoredSetup(dir);
  assert.equal(stored.apiKey, "sk-legacy");
  assert.equal(stored.record?.providerId, "deepseek");
  const store = new Store(dir);
  try {
    const models = await bootstrapModels(
      new SqlCredentials(store),
      {},
      {
        stored,
      },
    );
    assert.equal(models.getProvider(LLM_PROVIDER_ID), undefined);
    assert.ok(await models.checkAuth("deepseek"));
  } finally {
    store.close();
  }
});

test("a legacy gemini row migrates onto the google provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-gemini-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "setup:live",
    JSON.stringify({
      providerId: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      modelId: "models/gemini-2.5-flash",
      effort: "low",
    }),
  );
  db.prepare("INSERT INTO credentials VALUES (?,?)").run(
    "llm",
    JSON.stringify({ type: "api_key", key: "gemini-legacy" }),
  );
  assert.deepEqual(migrateLegacyOfficialSetup(db, {}), {
    providerId: "google",
    modelId: "gemini-2.5-flash",
  });
  db.close();
  const stored = readStoredSetup(dir);
  assert.equal(stored.record?.providerId, "google");
  assert.equal(stored.record?.modelId, "gemini-2.5-flash");
  assert.equal(stored.apiKey, "gemini-legacy");
  const again = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    assert.equal(migrateLegacyOfficialSetup(again, {}), undefined);
  } finally {
    again.close();
  }
});

test("a legacy model missing from the native catalog stays on llm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-keep-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE credentials(provider TEXT PRIMARY KEY, value TEXT)",
  );
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "setup:live",
    JSON.stringify({
      providerId: "custom",
      baseUrl: "https://proxy.example/v1",
      modelId: "not-in-catalog",
      effort: "high",
    }),
  );
  db.prepare("INSERT INTO credentials VALUES (?,?)").run(
    "llm",
    JSON.stringify({ type: "api_key", key: "sk-proxy" }),
  );
  assert.equal(migrateLegacyOfficialSetup(db, {}), undefined);
  db.close();
  const stored = readStoredSetup(dir);
  const models = await environmentModels(
    { LLM_MODELS: "not-in-catalog|32768|4096|false" },
    { stored },
  );
  assert.equal(
    models.getProvider(LLM_PROVIDER_ID)?.baseUrl,
    "https://proxy.example/v1",
  );
});

test("env still wins over a stored compat setup", async () => {
  const models = await environmentModels(
    {
      LLM_MODELS: catalog,
      LLM_BASE_URL: "https://api.env.com/v1",
      LLM_API_KEY: "sk-env",
    },
    {
      stored: {
        record: {
          providerId: "custom",
          baseUrl: "https://api.stored.com/v1",
          modelId: "fake-1",
        },
        apiKey: "sk-stored",
      },
    },
  );
  assert.equal(
    models.getProvider(LLM_PROVIDER_ID)?.baseUrl,
    "https://api.env.com/v1",
  );
});

test("no provider anywhere asks for the wizard instead of failing", async () => {
  await assert.rejects(
    () => environmentModels({ LLM_MODELS: catalog }),
    (error: unknown) => error instanceof SetupRequiredError,
  );
});

test("a half-configured setup waits, naming the missing piece", async () => {
  // Half a configuration is still "not configured": waiting is recoverable, while
  // exiting would leave the platform restarting the container forever.
  await assert.rejects(
    () =>
      environmentModels({ LLM_MODELS: catalog }, { stored: { apiKey: "sk" } }),
    (error: unknown) =>
      error instanceof SetupRequiredError && /endpoint/.test(error.message),
  );
  await assert.rejects(
    () =>
      environmentModels(
        { LLM_MODELS: catalog },
        {
          stored: {
            record: {
              providerId: "custom",
              baseUrl: "https://api.example/v1",
              modelId: "fake-1",
            },
          },
        },
      ),
    (error: unknown) =>
      error instanceof SetupRequiredError && /chave/.test(error.message),
  );
});

test("a half-written record is treated as not configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)",
    );
    db.prepare("INSERT INTO meta VALUES (?,?)").run(
      "setup:live",
      JSON.stringify({ providerId: "custom", baseUrl: "", modelId: "m-1" }),
    );
  } finally {
    db.close();
  }
  // the old wizard could store a record with no endpoint; it must not block startup
  assert.deepEqual(readStoredSetup(dir), {});
});

test("chatgpt auth mode clears the llm api key on write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId: "custom",
        baseUrl: "https://api.example/v1",
        modelId: "m-0",
      },
      { chat: "sk-old" },
    );
    writeStoredSetup(
      db,
      {
        providerId: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        modelId: "gpt-5",
        effort: "high",
        authMode: "chatgpt",
      },
      {},
    );
  } finally {
    db.close();
  }
  const stored = readStoredSetup(dir);
  assert.equal(stored.record?.authMode, "chatgpt");
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.record?.modelId, "gpt-5");
});

test("chatgpt subscription still starts without LLM_*", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-chatgpt-"));
  const store = new Store(dir);
  try {
    store.run(
      "INSERT INTO meta VALUES (?,?)",
      "setup:live",
      JSON.stringify({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-5",
        effort: "high",
        authMode: "chatgpt",
      }),
    );
    store.run(
      "INSERT INTO credentials VALUES (?,?)",
      "openai",
      JSON.stringify({
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 3_600_000,
      }),
    );
    const stored = readStoredSetup(dir);
    const models = await bootstrapModels(
      new SqlCredentials(store),
      {
        LLM_BASE_URL: "https://leftover.example/v1",
        LLM_API_KEY: "sk-leftover",
        LLM_MODELS: catalog,
      },
      { stored },
    );
    assert.equal(models.getProvider(LLM_PROVIDER_ID), undefined);
    assert.ok(await models.checkAuth("openai"));
    assert.ok(models.getProvider("openai")?.auth.oauth);
    assert.ok(models.getProvider("openai-codex")?.auth.oauth);
    assert.ok(models.getModels("openai").some((model) => model.id === "gpt-5"));
  } finally {
    store.close();
  }
});

test("the backend keys are stored next to the chat key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-setup-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    writeStoredSetup(
      db,
      {
        providerId: "custom",
        baseUrl: "https://api.example/v1",
        modelId: "m-1",
      },
      { chat: "sk-chat", vision: "sk-vision", audio: "sk-audio" },
    );
    // writing again without a backend key clears the stale one
    db.prepare("DELETE FROM meta WHERE key='setup:live'").run();
    writeStoredSetup(
      db,
      {
        providerId: "custom",
        baseUrl: "https://api.example/v1",
        modelId: "m-1",
      },
      { chat: "sk-chat" },
    );
  } finally {
    db.close();
  }
  const db2 = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    const ids = db2
      .prepare("SELECT provider FROM credentials ORDER BY provider")
      .all()
      .map((row) => (row as { provider: string }).provider);
    assert.deepEqual(ids, ["llm"]);
  } finally {
    db2.close();
  }
});
