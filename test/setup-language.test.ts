import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTickClock } from "../src/pending-jobs.js";

const SETUP_FILES = [
  "scripts/setup-model.mjs",
  "src/setup.ts",
  "src/native-providers.ts",
  "src/providers.ts",
  "src/subscription-login.ts",
];

/**
 * User-facing Telegram copy. Model prompts stay out of this list: scheduled-run
 * instructions and tool text the assistant paraphrases are not bot messages.
 * "usuário" is the stored author token, not a label sent as its own message.
 */
const TELEGRAM_FILES = [
  "src/telegram.ts",
  "src/telegram-approvals.ts",
  "src/telegram-crons.ts",
  "src/telegram-models.ts",
  "src/telegram-chats.ts",
  "src/telegram-polling.ts",
  "src/telegram-format.ts",
  "src/telegram-controls.ts",
  "src/heartbeat.ts",
  "src/settings.ts",
  "src/commands.ts",
  "src/mcp.ts",
  "src/tasks.ts",
  "src/task-telegram.ts",
];

const SETUP_PT =
  /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|\b(não|inválid\w*|vírgula|catálogo|usuário|provedor|mantém|escolha|mesmo assim|código|aguardando|resposta|oficial|senha|visão)\b/i;

const TELEGRAM_PT =
  /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]|\b(não|inválid\w*|vírgula|catálogo|usuário|provedor|mantém|escolha|mesmo assim|código|aguardando|resposta|oficial|senha|visão|modelos|texto|nenhuma|conectado|ferramenta|rodar agora|último tick|versão|compactação)\b/i;

const ALLOW = new Set(['"usuário"', "'usuário'", "`usuário`"]);

/** Phrases that used to be sent to Telegram. They must not come back in src. */
const BANNED = [
  "Modelos:",
  "Esforço:",
  "Execuções neste tópico",
  "Aprovações pendentes",
  "Nenhuma chamada pendente ou incerta",
  "Jobs assíncronos",
  "último tick",
  "Compactação automática",
  "Rodar agora",
  "Aprovação MCP pendente",
  "áudio transcrito",
  "descrição automática",
  "conectado —",
  "ferramenta(s)",
];

function literals(source: string, keepBoundary: boolean) {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, keepBoundary ? "$1" : "");
  return text.match(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g) ?? [];
}

test("setup output strings are English", () => {
  const hits: string[] = [];
  for (const file of SETUP_FILES) {
    for (const value of literals(readFileSync(file, "utf8"), false))
      if (SETUP_PT.test(value)) hits.push(`${file}: ${value.slice(0, 140)}`);
  }
  assert.deepEqual(hits, []);
});

test("Telegram runtime strings are English", () => {
  const hits: string[] = [];
  for (const file of TELEGRAM_FILES) {
    for (const value of literals(readFileSync(file, "utf8"), true)) {
      if (ALLOW.has(value)) continue;
      if (TELEGRAM_PT.test(value)) hits.push(`${file}: ${value.slice(0, 160)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("retired Portuguese Telegram phrases stay out of src", () => {
  const hits: string[] = [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".ts")) files.push(path);
      else if (!name.includes(".")) walk(path);
    }
  };
  walk("src");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const phrase of BANNED)
      if (source.includes(phrase)) hits.push(`${file}: ${phrase}`);
  }
  assert.deepEqual(hits, []);
});

test("async job tick clock uses the configured timezone", () => {
  const at = Date.parse("2026-11-09T23:07:05.000Z");
  assert.equal(formatTickClock(at, { TZ: "UTC" }), "23:07:05");
  assert.equal(formatTickClock(at, { TZ: "America/Sao_Paulo" }), "20:07:05");
  assert.equal(formatTickClock(at, {}), "20:07:05");
  assert.equal(
    formatTickClock(at, { TZ: "Not/AZone" }),
    formatTickClock(at, {}),
  );
});
