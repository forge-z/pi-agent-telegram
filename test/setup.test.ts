import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  environmentModels,
  LLM_PROVIDER_ID,
  SetupRequiredError,
} from "../src/config.js";
import { readStoredSetup, writeStoredSetup } from "../src/setup.js";

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

test("env wins over the stored setup", async () => {
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
