#!/usr/bin/env node
/**
 * Set the global default model and effort from the container terminal, so a new
 * operator can start chatting without hunting through the Telegram menus.
 *
 * Global only, on purpose: the default lives in app.sqlite (meta), which a running
 * process reads when it opens the next conversation, so a write here takes effect
 * immediately. Per-conversation choices live in durable.sqlite and stay in Telegram
 * (/model), because a second writer there is not supported.
 *
 * Usage: npm run setup-model -- [--list] [--model <id>] [--effort <level>] [--dry-run]
 * Reads DATA_DIR, LLM_BASE_URL, LLM_API_KEY, LLM_API_KEY_FILE and LLM_MODELS.
 * Needs the build output: run `npm run build` first outside the container (the
 * runtime image already ships dist/).
 */
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import { LLM_PROVIDER_ID, environmentModels } from "../dist/src/config.js";
import {
  modelDefaultsConfirmedKey,
  modelDefaultsKey,
} from "../dist/src/settings.js";

const MODE = "live";
const usage = `Uso: npm run setup-model -- [--list] [--model <id>] [--effort <level>] [--dry-run]

  --list             lista o catálogo e o padrão global atual
  --model <id>       id do modelo (aceita "llm/<id>"); grava o padrão global
  --effort <level>   esforço: off|minimal|low|medium|high|xhigh|max
  --dry-run          mostra o que seria gravado, sem escrever

Sem argumentos, num terminal interativo, abre um menu. Sem terminal (pipe, CI,
docker exec sem -it) use flags explicitamente.`;

function fail(message, code = 1) {
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
}

const options = {
  list: false,
  model: undefined,
  effort: undefined,
  dryRun: false,
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--list") options.list = true;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--model") options.model = argv[(index += 1)];
  else if (arg === "--effort") options.effort = argv[(index += 1)];
  else if (arg === "--help" || arg === "-h") {
    console.log(usage);
    process.exit(0);
  } else fail(`Argumento desconhecido: ${arg}\n\n${usage}`, 2);
}

const dir = process.env.DATA_DIR?.trim() || "data";
let models;
try {
  models = await environmentModels();
} catch (error) {
  fail(
    error instanceof Error ? error.message : "Falha no catálogo de modelos.",
  );
}
const catalog = models.getModels(LLM_PROVIDER_ID).map((model) => ({
  id: model.id,
  efforts: getSupportedThinkingLevels(model),
}));
if (!catalog.length)
  fail("Nenhum modelo no catálogo. Confira LLM_BASE_URL/LLM_MODELS.");

mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dir, "app.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
const defaultsKey = modelDefaultsKey(MODE);
const confirmedKey = modelDefaultsConfirmedKey(MODE);
const readMeta = (key) => {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return row ? row.value : undefined;
};
function current() {
  const raw = readMeta(defaultsKey);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.modelId === "string") return value;
  } catch {
    /* A corrupt row is treated as "nothing chosen yet". */
  }
  return undefined;
}
function save(settings) {
  const statement = db.prepare(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  statement.run(defaultsKey, JSON.stringify(settings));
  statement.run(confirmedKey, "true");
}
function label(settings) {
  return settings
    ? `${settings.provider}/${settings.modelId} · ${settings.effort}`
    : "nenhum escolhido (implícito: primeiro do catálogo)";
}
function printState() {
  console.log(`Provedor: ${LLM_PROVIDER_ID}`);
  console.log(
    `Endereço: ${process.env.LLM_BASE_URL?.trim() || "(não definido)"}`,
  );
  console.log(`Padrão global: ${label(current())}`);
  console.log(`Catálogo (${catalog.length}):`);
  for (const entry of catalog)
    console.log(
      `  ${LLM_PROVIDER_ID}/${entry.id}  —  esforços: ${entry.efforts.join(" ")}`,
    );
}
function entryFor(input) {
  const raw = String(input ?? "").trim();
  const id = raw.startsWith(`${LLM_PROVIDER_ID}/`)
    ? raw.slice(LLM_PROVIDER_ID.length + 1)
    : raw;
  const entry = catalog.find((candidate) => candidate.id === id);
  if (!entry)
    fail(
      `Modelo desconhecido: ${raw || "(vazio)"}. Use --list para ver as opções.`,
    );
  return entry;
}
function effortFor(entry, input) {
  const previous = current();
  const requested = String(input ?? "").trim();
  if (!requested)
    return previous && entry.efforts.includes(previous.effort)
      ? previous.effort
      : clampThinkingLevel(models.getModel(LLM_PROVIDER_ID, entry.id), "high");
  if (!entry.efforts.includes(requested))
    fail(`Esforço inválido para ${entry.id}: use ${entry.efforts.join("|")}.`);
  return requested;
}
function commit(entry, effort) {
  const settings = { provider: LLM_PROVIDER_ID, modelId: entry.id, effort };
  if (options.dryRun) {
    console.log(`(dry-run) gravaria ${label(settings)} como padrão global.`);
    return;
  }
  save(settings);
  console.log(`Padrão global: ${label(settings)}`);
  console.log(`Banco: ${join(dir, "app.sqlite")}`);
  console.log(
    "Conversas novas usam esse padrão; /model no Telegram continua sobrepondo por conversa.",
  );
}
async function interactive() {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(`Provedor ${LLM_PROVIDER_ID} — ${catalog.length} modelo(s)`);
    console.log(`Padrão global atual: ${label(current())}\n`);
    catalog.forEach((entry, index) =>
      console.log(
        `  [${index + 1}] ${LLM_PROVIDER_ID}/${entry.id}  (esforços: ${entry.efforts.join(" ")})`,
      ),
    );
    const answer = (
      await readline.question("\nModelo (número ou id, q cancela): ")
    ).trim();
    if (!answer || answer === "q") return fail("Cancelado.", 0);
    const index = Number(answer);
    const entry =
      Number.isSafeInteger(index) && index >= 1 && index <= catalog.length
        ? catalog[index - 1]
        : entryFor(answer);
    console.log(`\nEsforços de ${entry.id}: ${entry.efforts.join(" ")}`);
    const effort = effortFor(entry, await readline.question("Esforço: "));
    const confirm = (
      await readline.question(
        `\nGravar ${entry.id} · ${effort} como padrão global? [y/N] `,
      )
    ).trim();
    if (!/^y(es)?$/i.test(confirm)) return fail("Cancelado.", 0);
    commit(entry, effort);
  } catch (error) {
    // Ctrl+D / closed stdin must cancel, not print a stack trace.
    if (error instanceof Error && error.name === "AbortError")
      return fail("Cancelado.", 0);
    throw error;
  } finally {
    readline.close();
  }
}

const hasFlags =
  options.list ||
  options.dryRun ||
  options.model !== undefined ||
  options.effort !== undefined;
const writes = options.model !== undefined || options.effort !== undefined;
try {
  if (!hasFlags) {
    if (!process.stdin.isTTY)
      fail(`Sem terminal interativo. Use flags.\n\n${usage}`, 2);
    await interactive();
  } else if (!writes) {
    printState();
  } else {
    const entry = entryFor(
      options.model ?? current()?.modelId ?? catalog[0].id,
    );
    commit(entry, effortFor(entry, options.effort));
  }
} finally {
  db.close();
}
