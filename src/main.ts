import { join, resolve } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { Runtime } from "./runtime.js";
import { McpGateway } from "./mcp.js";
import {
  readConfig,
  bootstrapModels,
  LLM_PROVIDER_ID,
  secretRedactor,
  SetupRequiredError,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "./config.js";
import { readStoredSetup, type StoredSetup } from "./setup.js";
import { Store, SqlCredentials } from "./store.js";

/**
 * A bot with no provider cannot answer, and killing the container would take away the
 * terminal needed to run the wizard. Wait instead, re-reading the volume: `npm run
 * setup` finishes and the bot starts on its own a few seconds later.
 */
async function modelsOrWait(dir: string) {
  for (let attempt = 0; ; attempt += 1) {
    const stored = readStoredSetup(dir);
    const store = new Store(dir);
    try {
      const credentials = new SqlCredentials(store);
      const models = await bootstrapModels(credentials, process.env, {
        stored,
      });
      return { models, stored, store };
    } catch (error) {
      store.close();
      if (!(error instanceof SetupRequiredError)) throw error;
      if (attempt === 0) {
        const needsLogin = setupNeedsLogin(error);
        console.error(
          needsLogin
            ? "Assinatura ChatGPT ainda não autenticada. Rode `npm run login` no terminal do container; " +
                "o bot começa a responder sozinho quando o login terminar."
            : "Sem provedor configurado. Rode `npm run setup` no terminal do container; " +
                "o bot começa a responder sozinho quando o assistente terminar.",
        );
      }
      // Waiting is the expected state, not a fault: keep the healthcheck green so the
      // platform does not restart the container that holds the terminal you need.
      writeFileSync(
        join(dir, "health.json"),
        JSON.stringify({
          at: Date.now(),
          waiting: setupNeedsLogin(error) ? "login" : "setup",
        }),
      );
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
}

function setupNeedsLogin(error: SetupRequiredError) {
  return /login/i.test(error.message);
}
import { TelegramBotApi } from "./telegram-api.js";
import { configureTelegram, TelegramPolling } from "./telegram-polling.js";

process.umask(0o077);
try {
  const config = readConfig();
  const dir = resolve(config.dir);
  const {
    models,
    stored,
    store: bootstrapStore,
  }: {
    models: Awaited<ReturnType<typeof bootstrapModels>>;
    stored: StoredSetup;
    store: Store;
  } = await modelsOrWait(dir);
  // Safe deploy hint: endpoint and catalog only, never credentials.
  const llm = models.getProvider(LLM_PROVIDER_ID);
  const llmCatalog = models.getModels(LLM_PROVIDER_ID);
  const oauthProviders = models
    .getProviders()
    .filter(
      (provider) => provider.id === "openai" || provider.id === "openai-codex",
    );
  console.info(
    llm
      ? `Pi-Agent: provedor ${LLM_PROVIDER_ID} (${llm.baseUrl ?? "sem endpoint"}) — ${llmCatalog.length} modelo(s), reasoning habilitado em ${llmCatalog.filter((model) => model.reasoning).length}.`
      : `Pi-Agent: sem provedor LLM_*; assinatura ChatGPT via ${oauthProviders.map((p) => p.id).join(", ") || "openai"}.`,
  );
  const api = new TelegramBotApi(config.token);
  const bot = (await api.call("getMe")) as { id: number; username?: string };
  const allowlistMisconfig = telegramAllowlistMisconfiguration(bot.id, config);
  if (allowlistMisconfig) throw new Error(allowlistMisconfig);
  rmSync(`${dir}/health.json`, { force: true });
  const gateway = new McpGateway(config.mcp);
  const app = await Runtime.open({
    dir,
    store: bootstrapStore,
    gateway,
    models,
    mode: "live",
    telegramOnly: true,
    // Bootstrap only: the choice from `npm run setup` seeds the default once;
    // /model and /thinking own it afterwards.
    ...(stored.record
      ? {
          provider: stored.record.providerId,
          modelId: stored.record.modelId,
          effort: stored.record.effort,
        }
      : {}),
    redact: secretRedactor(process.env, config.mcp),
    initialize: (store) => configureTelegram(store, config, bot),
  });
  const polling = new TelegramPolling(app, api, config, bot);
  // Jobs that outlive the turn: the poller wakes a turn when one finishes.
  app.pendingJobs.start();
  app.flushTelegramPending = () => {
    void polling.engine.flush();
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      rmSync(`${dir}/health.json`, { force: true });
      const draining = polling.close();
      app.pendingJobs.close();
      const tasks = app.tasks.close();
      await app.mcpCalls?.close();
      await draining;
      await tasks;
      await app.close();
      await gateway.close();
    })());
  for (const event of ["SIGTERM", "SIGINT"] as const)
    process.once(event, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
  polling.start(() => {
    void close().finally(() => {
      process.exitCode = 1;
    });
  });
  void polling.engine.flush();
  console.info("Pi-Agent: Telegram polling iniciado.");
} catch (error) {
  console.error(startupErrorMessage(error));
  process.exitCode = 1;
}
