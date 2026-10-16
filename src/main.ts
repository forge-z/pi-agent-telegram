import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { Runtime } from "./runtime.js";
import { McpGateway } from "./mcp.js";
import {
  readConfig,
  environmentModels,
  LLM_PROVIDER_ID,
  secretRedactor,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "./config.js";
import { TelegramBotApi } from "./telegram-api.js";
import { configureTelegram, TelegramPolling } from "./telegram-polling.js";

process.umask(0o077);
try {
  const config = readConfig();
  const models = await environmentModels();
  // Safe deploy hint: endpoint and catalog only, never credentials.
  const catalog = models.getModels(LLM_PROVIDER_ID);
  console.info(
    `Pi Agent TG: provedor ${LLM_PROVIDER_ID} (${models.getProvider(LLM_PROVIDER_ID)?.baseUrl ?? "sem endpoint"}) — ${catalog.length} modelo(s), reasoning habilitado em ${catalog.filter((model) => model.reasoning).length}.`,
  );
  const api = new TelegramBotApi(config.token);
  const bot = (await api.call("getMe")) as { id: number; username?: string };
  const allowlistMisconfig = telegramAllowlistMisconfiguration(bot.id, config);
  if (allowlistMisconfig) throw new Error(allowlistMisconfig);
  const dir = resolve(config.dir);
  rmSync(`${dir}/health.json`, { force: true });
  const gateway = new McpGateway(config.mcp);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    mode: "live",
    telegramOnly: true,
    redact: secretRedactor(process.env, config.mcp),
    initialize: (store) => configureTelegram(store, config, bot),
  });
  const polling = new TelegramPolling(app, api, config, bot);
  app.flushTelegramPending = () => {
    void polling.engine.flush();
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      rmSync(`${dir}/health.json`, { force: true });
      const draining = polling.close();
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
  console.info("Pi Agent TG: Telegram polling iniciado.");
} catch (error) {
  console.error(startupErrorMessage(error));
  process.exitCode = 1;
}
