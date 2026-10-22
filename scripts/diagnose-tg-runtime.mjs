#!/usr/bin/env node
/**
 * In-container diagnostic (Coolify terminal, docker exec). Never prints secret values.
 * Run from /app after build: node scripts/diagnose-tg-runtime.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  discoverLlmModels,
  environmentModels,
  LLM_PROVIDER_ID,
  operatorSecret,
  readConfig,
  resolveMcpServersJson,
  startupErrorMessage,
  telegramAllowlistMisconfiguration,
} from "../dist/src/config.js";
import { readAppInfo } from "../dist/src/app-info.js";
import { spawnSync } from "node:child_process";

const mandatory = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"];
const optional = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "EXECUTOR_MCP_URL",
  "EXECUTOR_TOKEN",
  "DATA_DIR",
];

/** Global default lives in app.sqlite; read-only peek, never a second writer. */
const globalDefault = () => {
  const dataDir = process.env.DATA_DIR?.trim() || "/app/data";
  try {
    const db = new DatabaseSync(join(dataDir, "app.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("model-defaults-selection:live");
      if (!row) return undefined;
      const value = JSON.parse(row.value);
      return value?.modelId
        ? `${value.provider}/${value.modelId} · ${value.effort}`
        : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
};

const section = (title) => console.log(`\n=== ${title} ===`);

const envStatus = (name) => {
  const file = process.env[`${name}_FILE`]?.trim();
  const raw = file
    ? existsSync(file)
      ? readFileSync(file, "utf8").trim()
      : ""
    : (process.env[name]?.trim() ?? "");
  if (!raw) return "VAZIO";
  if (/^replace_with/i.test(raw)) return "PLACEHOLDER";
  return "definido";
};

section("Identidade");
const id = readAppInfo();
console.log(
  `commit=${id.commit ?? "desconhecido"} version=${id.version ?? "desconhecido"}`,
);
if (!id.commit && envStatus("SOURCE_COMMIT") === "definido")
  console.log(
    "SOURCE_COMMIT está no ambiente mas não passou na validação (valor curto/ inválido?)",
  );
if (!id.commit)
  console.log(
    "SOURCE_COMMIT ausente: o deploy ainda não injetou o SHA. Fora do Coolify, exporte SOURCE_COMMIT=$(git rev-parse HEAD).",
  );

section("Variáveis de ambiente (presença)");
for (const name of mandatory)
  console.log(`${name}=${envStatus(name)} (obrigatória)`);
for (const name of optional)
  console.log(`${name}=${envStatus(name)} (opcional)`);
console.log(
  `TELEGRAM_ALLOWED_CHATS=${envStatus("TELEGRAM_ALLOWED_CHATS")} (opcional; padrão = ALLOWED_USERS)`,
);
console.log(
  `SOURCE_COMMIT=${envStatus("SOURCE_COMMIT")} (runtime; Coolify preenche no deploy)`,
);

section("Configuração Telegram + MCP (validação local)");
try {
  const config = readConfig();
  console.log("readConfig: OK");
  console.log(
    `allowlist users=${config.users.length} chats=${config.chats.length}`,
  );
  console.log(`allowlist user IDs: ${config.users.join(", ")}`);
  const chatsDefault =
    !process.env.TELEGRAM_ALLOWED_CHATS?.trim() &&
    config.chats.join(",") === config.users.join(",");
  console.log(
    `allowlist chat IDs: ${config.chats.join(", ")}${chatsDefault ? " (padrão = users)" : ""}`,
  );
  console.log(`mcp servers=${config.mcp.length}`);
  for (const server of config.mcp)
    console.log(`  - ${server.name}: endpoint configurado (URL omitida)`);
} catch (error) {
  console.log(`readConfig: FALHOU — ${startupErrorMessage(error)}`);
}

section("Provedor de modelo (LLM_*)");
try {
  const models = await environmentModels();
  const catalog = models.getModels(LLM_PROVIDER_ID);
  console.log(
    `environmentModels: OK (${models
      .getProviders()
      .map((p) => p.id)
      .join(", ")}) — ${catalog.length} modelo(s)`,
  );
  const reasoning = catalog.filter((m) => m.reasoning).map((m) => m.id);
  console.log(
    `reasoning habilitado (${reasoning.length}): ${reasoning.join(", ") || "nenhum — /thinking fica em off; declare LLM_MODELS com reasoning=true"}`,
  );
  for (const model of catalog.slice(0, 20))
    console.log(`  ${LLM_PROVIDER_ID}/${model.id}`);
  if (catalog.length > 20) console.log(`  … +${catalog.length - 20}`);
  console.log(
    `padrão global: ${globalDefault() ?? "nenhum escolhido (implícito: primeiro do catálogo)"}`,
  );
  console.log(
    "Defina o padrão com: npm run setup-model -- --list | --model <id> [--effort <level>]",
  );
} catch (error) {
  console.log(`environmentModels: FALHOU — ${startupErrorMessage(error)}`);
}

if (process.argv.includes("--probe")) {
  section("Probe ao vivo do endpoint LLM (--probe; nada de chave na saída)");
  try {
    const raw = process.env.LLM_BASE_URL?.trim();
    if (!raw)
      throw new Error("Configure LLM_BASE_URL (endpoint OpenAI-compatible).");
    let baseUrl;
    try {
      baseUrl = new URL(raw).href.replace(/\/$/, "");
    } catch {
      throw new Error("Endpoint LLM_BASE_URL inválido");
    }
    const key = operatorSecret(process.env, "LLM_API_KEY");
    if (!key) throw new Error("Configure LLM_API_KEY ou LLM_API_KEY_FILE.");
    const discovered = await discoverLlmModels(baseUrl, key);
    console.log(`GET ${baseUrl}/models: OK — ${discovered.length} modelo(s)`);
    for (const model of discovered.slice(0, 20)) console.log(`  ${model.id}`);
    if (discovered.length > 20) console.log(`  … +${discovered.length - 20}`);
    console.log(
      "Descoberta não informa reasoning: declare LLM_MODELS com reasoning=true para habilitar /thinking.",
    );
  } catch (error) {
    console.log(`probe: FALHOU — ${startupErrorMessage(error)}`);
    console.log(
      "Confira LLM_BASE_URL (inclua o segmento de versão, ex. /v1, quando o provedor exigir) e a chave.",
    );
  }
}

section("MCP JSON resolvido (sem URL)");
try {
  const raw = resolveMcpServersJson();
  const list = JSON.parse(raw);
  console.log(
    Array.isArray(list)
      ? `entrada(s) MCP=${list.length}${list.length ? " (URLs omitidas)" : ""}`
      : "formato MCP inesperado",
  );
} catch (error) {
  console.log(`resolveMcpServersJson: FALHOU — ${startupErrorMessage(error)}`);
}

section("Heartbeat / DATA_DIR");
const dataDir = process.env.DATA_DIR?.trim() || "/app/data";
console.log(`DATA_DIR=${dataDir}`);
const healthPath = join(dataDir, "health.json");
if (!existsSync(healthPath)) {
  console.log(
    "health.json: ausente (polling ainda não saudável ou processo parado)",
  );
} else {
  try {
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    const ageMs = Date.now() - Number(health.at ?? 0);
    console.log(
      `health.json: presente (idade ~${Math.round(ageMs / 1000)}s${ageMs > 90_000 ? ", possivelmente stale" : ""})`,
    );
  } catch {
    console.log("health.json: ilegível");
  }
}

section("Telegram API (token ok, sem segredos)");
try {
  const { token } = readConfig();
  const call = async (method, body = {}) => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    if (!data.ok)
      throw new Error(`${method}: ${data.description ?? response.status}`);
    return data.result;
  };
  const config = readConfig();
  const me = await call("getMe");
  console.log(
    `getMe: @${me.username ?? "?"} id=${me.id} (use /status@${me.username ?? "Bot"} em grupos)`,
  );
  const misconfig = telegramAllowlistMisconfiguration(me.id, config);
  if (misconfig) console.log(`ERRO CONFIG: ${misconfig}`);
  const hook = await call("getWebhookInfo");
  console.log(
    hook.url
      ? `getWebhookInfo: WEBHOOK ATIVO (${hook.url}) — polling não recebe updates; deleteWebhook`
      : "getWebhookInfo: sem webhook (ok para polling)",
  );
  for (const chatId of config.chats) {
    try {
      const chat = await call("getChat", { chat_id: Number(chatId) });
      console.log(
        `getChat ${chatId}: type=${chat.type} title=${chat.title ?? chat.username ?? "?"}`,
      );
    } catch (error) {
      console.log(
        `getChat ${chatId}: FALHOU — ${error.message}. ID errado ou bot não está neste chat.`,
      );
    }
  }
} catch (error) {
  console.log(`Telegram API: FALHOU — ${startupErrorMessage(error)}`);
}

section("Banco SQLite (app.sqlite, sem CLI sqlite3)");
{
  const dbPath = join(dataDir, "app.sqlite");
  console.log(`caminho=${dbPath}`);
  if (!existsSync(dbPath)) {
    console.log("app.sqlite: ausente (primeiro boot ou volume não montado)");
  } else {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const deliveries = db
        .prepare(
          "SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state ORDER BY state",
        )
        .all();
      console.log(
        deliveries.length
          ? `deliveries: ${deliveries.map((r) => `${r.state}=${r.n}`).join(", ")}`
          : "deliveries: nenhuma (bot ainda não enfileirou resposta)",
      );
      const recent = db
        .prepare(
          "SELECT id, state, substr(text,1,72) AS preview FROM deliveries ORDER BY rowid DESC LIMIT 5",
        )
        .all();
      for (const row of recent)
        console.log(`  ${row.state} ${row.id}: ${row.preview}`);
      const mcpPending = db
        .prepare(
          "SELECT COUNT(*) AS n FROM mcp_interactions WHERE state='pending'",
        )
        .get();
      console.log(`mcp_interactions pending=${mcpPending?.n ?? 0}`);
      const mcpCards = db
        .prepare(
          "SELECT id, state, substr(result,1,120) AS detail FROM deliveries WHERE id GLOB 'telegram:mcp:*' ORDER BY rowid DESC LIMIT 8",
        )
        .all();
      for (const row of mcpCards)
        console.log(
          `  mcp delivery ${row.state} ${row.id}${row.detail ? ` — ${row.detail}` : ""}`,
        );
      const mcpMarkup = db
        .prepare(
          "SELECT key FROM meta WHERE key GLOB 'telegram:markup:telegram:mcp:*' ORDER BY rowid DESC LIMIT 3",
        )
        .all();
      console.log(
        mcpMarkup.length
          ? `mcp inline markup keys=${mcpMarkup.map((r) => r.key).join(", ")}`
          : "mcp inline markup: nenhum (cartão não enfileirado ou já enviado)",
      );
      const updates = db
        .prepare("SELECT COUNT(*) AS n FROM telegram_updates")
        .get();
      console.log(
        `telegram_updates: ${updates.n} (0 = nenhum comando/mensagem aceito ainda)`,
      );
      const offset = db
        .prepare(
          "SELECT key, value FROM meta WHERE key GLOB 'telegram:offset:*'",
        )
        .all();
      for (const row of offset) console.log(`offset ${row.key}=${row.value}`);
      const conn = db
        .prepare(
          "SELECT value FROM meta WHERE key='telegram:connection' LIMIT 1",
        )
        .get();
      if (conn?.value) {
        try {
          const j = JSON.parse(conn.value);
          console.log(
            `telegram:connection: enabled=${j.enabled} botId=${j.bot?.id ?? "?"} storedUsers=${(j.allowedUsers ?? []).length} storedChats=${(j.allowedChats ?? []).length}`,
          );
        } catch {
          console.log("telegram:connection: JSON ilegível");
        }
      } else console.log("telegram:connection: ausente (reinicie o container)");
      db.close();
    } catch (error) {
      console.log(`app.sqlite: erro ao ler — ${error.message}`);
    }
  }
}

section("Healthcheck do processo");
{
  const hc = spawnSync(process.execPath, ["dist/src/healthcheck.js"], {
    encoding: "utf8",
  });
  console.log(
    hc.status === 0
      ? "healthcheck.js: OK"
      : "healthcheck.js: FALHOU (heartbeat ausente ou stale)",
  );
}

section("Lembretes");
console.log(`\
- TELEGRAM_ALLOWED_CHATS é opcional: omita em DM (usa ALLOWED_USERS). Grupos: ID negativo do chat.
- TELEGRAM_ALLOWED_USERS deve incluir seu user ID do Telegram.
- Grupos comuns (type group) são aceitos; canais não. Em grupos, use /status@SeuBot ou desative privacy mode.
- EXECUTOR_MCP_URL e EXECUTOR_TOKEN vêm só do ambiente do deploy (nunca do git).
- EXECUTOR_TOKEN é chave crua, sem prefixo Bearer.
- Coolify: defina variáveis na UI; não commite .env.
- Banco: ${join(dataDir, "app.sqlite")} (não store.db). A imagem não inclui o binário sqlite3; use npm run diagnose.`);
