import { join, resolve } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { Runtime } from "./runtime.js";
import { McpGateway } from "./mcp.js";
import {
  readConfig,
  environmentModels,
  LLM_PROVIDER_ID,
  secretRedactor,
  SetupRequiredError,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "./config.js";
import { readStoredSetup, type StoredSetup } from "./setup.js";

/**
 * A bot with no provider cannot answer, and killing the container would take away the
 * terminal needed to run the wizard. Wait instead, re-reading the volume: `npm run
 * setup` finishes and the bot starts on its own a few seconds later.
 */
async function modelsOrWait(dir: string) {
  for (let attempt = 0; ; attempt += 1) {
    const stored = readStoredSetup(dir);
    try {
      return {
        models: await environmentModels(process.env, { stored }),
        stored,
      };
    } catch (error) {
      if (!(error instanceof SetupRequiredError)) throw error;
      if (attempt === 0)
        console.error(
          "Sem provedor configurado. Rode `npm run setup` no terminal do container; " +
            "o bot começa a responder sozinho quando o assistente terminar.",
        );
      // Waiting is the expected state, not a fault: keep the healthcheck green so the
      // platform does not restart the container that holds the terminal you need.
      writeFileSync(
        join(dir, "health.json"),
        JSON.stringify({ at: Date.now(), waiting: "setup" }),
      );
      await new Promise((done) => setTimeout(done, 10_000));
    }
  }
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
  }: {
    models: Awaited<ReturnType<typeof environmentModels>>;
    stored: StoredSetup;
  } = await modelsOrWait(dir);
  // Safe deploy hint: endpoint and catalog only, never credentials.
  const catalog = models.getModels(LLM_PROVIDER_ID);
  console.info(
    `Pi-Agent: provedor ${LLM_PROVIDER_ID} (${models.getProvider(LLM_PROVIDER_ID)?.baseUrl ?? "sem endpoint"}) — ${catalog.length} modelo(s), reasoning habilitado em ${catalog.filter((model) => model.reasoning).length}.`,
  );
  const api = new TelegramBotApi(config.token);
  const bot = (await api.call("getMe")) as { id: number; username?: string };
  const allowlistMisconfig = telegramAllowlistMisconfiguration(bot.id, config);
  if (allowlistMisconfig) throw new Error(allowlistMisconfig);
  rmSync(`${dir}/health.json`, { force: true });
  const gateway = new McpGateway(config.mcp);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    mode: "live",
    telegramOnly: true,
    // Bootstrap only: the choice from `npm run setup` seeds the default once;
    // /model and /thinking own it afterwards.
    ...(stored.record
      ? { modelId: stored.record.modelId, effort: stored.record.effort }
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
