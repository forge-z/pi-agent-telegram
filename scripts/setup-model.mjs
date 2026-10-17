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
import {
  LLM_PROVIDER_ID,
  environmentModels,
  operatorSecret,
} from "../dist/src/config.js";
import { PROVIDERS } from "../dist/src/providers.js";
import { probeImageSupport } from "../dist/src/vision.js";
import {
  readStoredSetup,
  setupKey,
  writeStoredSetup,
} from "../dist/src/setup.js";
import {
  modelDefaultsConfirmedKey,
  modelDefaultsKey,
} from "../dist/src/settings.js";

const MODE = "live";
const usage = `Uso: npm run setup -- [opções]

  Primeira execução (sem nada configurado): sem argumentos, num terminal, o menu
  pergunta provedor, chave, modelo, esforço, visão e áudio.

  --list                      mostra o estado atual
  --provider <id|url>         deepseek | gemini | openai | opencode-zen | opencode-go |
                              openrouter | custom | uma URL https://...
  --key-stdin                 lê a chave do stdin (evita histórico e \`ps\`)
  --model <id>                id do modelo
  --effort <level>            off|minimal|low|medium|high|xhigh|max
  --vision <id|none>          modelo de visão (none desativa; vazio = do chat)
  --audio <id|none>           modelo de transcrição (none desativa)
  --audio-api <openai|gemini> formato da requisição de áudio
  --audio-language <code>     idioma da transcrição (vazio = detectar)
  --dry-run                   mostra o que seria gravado, sem escrever

A chave vem de LLM_API_KEY, de --key-stdin, ou do menu (entrada oculta). Sem terminal
(pipe, CI, docker exec sem -it) use as flags e a variável.`;

function fail(message, code = 1) {
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
}

const options = {
  list: false,
  model: undefined,
  effort: undefined,
  audioLanguage: undefined,
  audioApi: undefined,
  audio: undefined,
  vision: undefined,
  keyStdin: false,
  provider: undefined,
  dryRun: false,
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--list") options.list = true;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--model") options.model = argv[(index += 1)];
  else if (arg === "--effort") options.effort = argv[(index += 1)];
  else if (arg === "--provider") options.provider = argv[(index += 1)];
  else if (arg === "--key-stdin") options.keyStdin = true;
  else if (arg === "--vision") options.vision = argv[(index += 1)];
  else if (arg === "--audio") options.audio = argv[(index += 1)];
  else if (arg === "--audio-api") options.audioApi = argv[(index += 1)];
  else if (arg === "--audio-language")
    options.audioLanguage = argv[(index += 1)] ?? "";
  else if (arg === "--help" || arg === "-h") {
    console.log(usage);
    process.exit(0);
  } else fail(`Argumento desconhecido: ${arg}\n\n${usage}`, 2);
}

const dir = process.env.DATA_DIR?.trim() || "data";
/** Whole stdin, for `--key-stdin`: the key never appears in argv or shell history. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Same host, so the chat key can be reused (Groq serves chat and audio). */
function host(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Model id from a numbered catalog entry or a typed id. */
function pickFromCatalog(answer) {
  const index = Number(answer);
  return Number.isSafeInteger(index) && index >= 1 && index <= catalog.length
    ? catalog[index - 1].id
    : String(answer).trim();
}

/** Transcription backends a chat endpoint cannot provide. */
const AUDIO_PROVIDERS = [
  {
    name: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    hint: "whisper-1 aceita ogg",
  },
  {
    name: "Groq",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    hint: "barato e rápido",
  },
  {
    name: "Gemini",
    api: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    hint: "JSON com áudio inline",
  },
  {
    name: "Outro (endpoint próprio)",
    api: "openai",
    baseUrl: "",
    model: "",
    hint: "informe URL, formato e modelo",
  },
];

/** Number from the audio list, or "outro" asking for endpoint and model. */
function pickAudio(answer) {
  const index = Number(answer);
  if (
    Number.isSafeInteger(index) &&
    index >= 1 &&
    index <= AUDIO_PROVIDERS.length
  )
    return AUDIO_PROVIDERS[index - 1];
  return undefined;
}

/** Reads a secret without echoing it: raw mode, so a screencast does not leak the key. */
function hidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(1);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** URL root the app will use; a plain number picks from the curated list. */
function providerFromAnswer(answer) {
  const raw = String(answer ?? "").trim();
  if (/^https?:\/\//i.test(raw)) return { id: "custom", baseUrl: raw };
  const index = Number(raw);
  const entry =
    Number.isSafeInteger(index) && index >= 1 && index <= PROVIDERS.length
      ? PROVIDERS[index - 1]
      : PROVIDERS.find((candidate) => candidate.id === raw);
  return entry ? { id: entry.id, baseUrl: entry.baseUrl } : undefined;
}

/** Validates the key on the spot: a broken key is worth knowing before the model list. */
async function listModels(baseUrl, apiKey) {
  try {
    const response = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = await response.json();
    const ids = (body?.data ?? []).map((model) => model.id);
    return ids.length
      ? { ok: true, ids }
      : { ok: false, detail: "nenhum modelo listado" };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.name : "sem resposta",
    };
  }
}

/** Known provider for this endpoint, so the stored record names it. */
function providerIdFor(baseUrl) {
  const hit = PROVIDERS.find(
    (entry) => entry.baseUrl && entry.baseUrl === baseUrl,
  );
  return hit?.id ?? "custom";
}
let models;
let catalog = [];
/**
 * Provider and key in effect. Both the menu and the flags path fill this, and commit()
 * reads it - recomputing from the environment is how the typed key got lost.
 */
const resolved = {
  chatVision: undefined,
  baseUrl: "",
  apiKey: "",
  providerId: "custom",
  audioKey: "",
};
/** Endpoints that are not chat models, even when the provider lists them. */
const NOT_CHAT =
  /(tts|whisper|transcri|embedding|embed-|aqa|imagen|veo|dall-e|moderation|realtime)/i;
/**
 * Registered after the provider and key are known: on a fresh volume nothing is stored
 * yet, so the catalog cannot be built first.
 */
async function loadCatalog(baseUrl, apiKey) {
  try {
    models = await environmentModels(
      {
        ...process.env,
        ...(baseUrl ? { LLM_BASE_URL: baseUrl } : {}),
        ...(apiKey ? { LLM_API_KEY: apiKey } : {}),
      },
      { stored: readStoredSetup(dir) },
    );
  } catch (error) {
    fail(
      error instanceof Error && error.message
        ? `${error.message}\nSe for a primeira execução, informe o provedor e a chave.`
        : "Falha no catálogo de modelos.",
    );
  }
  catalog = models
    .getModels(LLM_PROVIDER_ID)
    .filter((model) => !NOT_CHAT.test(model.id))
    .map((model) => ({
      // Gemini lists them as `models/gemini-...`; both forms work, the bare one reads better
      id: model.id.replace(/^models\//, ""),
      efforts: getSupportedThinkingLevels(model),
    }));
  if (!catalog.length)
    fail("Nenhum modelo de chat no catálogo. Confira o provedor e a chave.");
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dir, "app.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
const defaultsKey = modelDefaultsKey(MODE);
const confirmedKey = modelDefaultsConfirmedKey(MODE);
const setupMetaKey = setupKey(MODE);
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
/** The stored record already holds the per-function models: one source, one key. */
function currentFunctions() {
  const raw = readMeta(setupMetaKey);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return {
      ...(value?.vision ? { vision: value.vision } : {}),
      ...(value?.audio ? { audio: value.audio } : {}),
    };
  } catch {
    return {};
  }
}
/** What the environment already declares. Env wins at runtime, so the menu shows it. */
function envSelection() {
  const env = process.env;
  const selection = {};
  const vision = env.VISION_MODEL?.trim();
  if (vision) selection.vision = { modelId: vision };
  const audio = env.AUDIO_MODEL?.trim();
  if (audio) selection.audio = { modelId: audio };
  const api = env.AUDIO_API?.trim().toLowerCase();
  const language = env.AUDIO_LANGUAGE?.trim();
  if (selection.audio) {
    if (api === "openai" || api === "gemini") selection.audio.api = api;
    if (language) selection.audio.language = language;
  }
  return selection;
}
/** Stored choice merged with the env, which is what the bot will actually use. */
function effectiveFunctions() {
  const stored = currentFunctions();
  const env = envSelection();
  const vision = env.vision ?? stored.vision;
  const base = env.audio ?? stored.audio;
  const audio = base
    ? {
        ...base,
        ...(env.audio?.api ? { api: env.audio.api } : {}),
        ...(env.audio?.language ? { language: env.audio.language } : {}),
      }
    : undefined;
  return { ...(vision ? { vision } : {}), ...(audio ? { audio } : {}) };
}
/** Saving a different model than the env declares is a silent no-op at runtime. */
function warnEnvPrecedence(selection) {
  const env = envSelection();
  for (const kind of ["vision", "audio"]) {
    const variable = kind === "vision" ? "VISION_MODEL" : "AUDIO_MODEL";
    const fromVars = env[kind]?.modelId;
    const saved = selection[kind]?.modelId;
    if (fromVars && saved && saved !== fromVars)
      console.log(
        `! ${variable} está no ambiente (${fromVars}) e tem precedência: remova a variável para valer ${saved}.`,
      );
  }
}

function functionLabel(selection, chatSees = resolved.chatVision) {
  const env = envSelection();
  const vision = selection.vision?.modelId
    ? `${selection.vision.modelId}${env.vision?.modelId === selection.vision.modelId ? " (env)" : ""}`
    : chatSees
      ? "o modelo do chat (nativo)"
      : "desativada";
  const audio = selection.audio?.modelId
    ? `${selection.audio.modelId}${selection.audio.language ? ` (${selection.audio.language})` : ""}${env.audio?.modelId === selection.audio.modelId ? " (env)" : ""}`
    : "não configurado";
  return `imagem: ${vision} · áudio: ${audio}`;
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
function printState(baseUrl) {
  console.log(`Provedor: ${LLM_PROVIDER_ID}`);
  console.log(
    `Endereço: ${baseUrl || process.env.LLM_BASE_URL?.trim() || "(não definido)"}`,
  );
  console.log(`Padrão global: ${label(current())}`);
  console.log(`Funções: ${functionLabel(effectiveFunctions())}`);
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
function commit(entry, effort, functions = currentFunctions()) {
  const settings = { provider: LLM_PROVIDER_ID, modelId: entry.id, effort };
  const baseUrl = resolved.baseUrl.replace(/\/+$/, "");
  const apiKey = resolved.apiKey || undefined;
  if (!baseUrl || !apiKey)
    fail("Provedor ou chave ausente: o registro não seria utilizável.");
  const record = {
    providerId: resolved.providerId,
    baseUrl,
    modelId: entry.id,
    effort,
    // Omitted when the probe did not run (flags path until it does): absent means
    // "unknown", and runtime then falls back to what the catalog declares.
    ...(resolved.chatVision === undefined
      ? {}
      : { chatVision: resolved.chatVision }),
    ...(functions.vision ? { vision: functions.vision } : {}),
    ...(functions.audio
      ? {
          audio: {
            modelId: functions.audio.modelId,
            api: functions.audio.api ?? "openai",
            baseUrl:
              process.env.AUDIO_BASE_URL?.trim() ||
              (functions.audio.api === "gemini"
                ? "https://generativelanguage.googleapis.com/v1beta"
                : "https://api.openai.com/v1"),
            ...(functions.audio.language
              ? { language: functions.audio.language }
              : {}),
          },
        }
      : {}),
  };
  if (options.dryRun) {
    console.log(`(dry-run) gravaria ${label(settings)} como padrão global.`);
    return;
  }
  save(settings);
  // From here on the app starts without LLM_* in the environment.
  writeStoredSetup(
    db,
    record,
    {
      ...(apiKey ? { chat: apiKey } : {}),
      // A backend on the chat host inherits the chat key; otherwise the operator must
      // have provided one (menu prompt, or VISION_API_KEY / AUDIO_API_KEY).
      ...(functions.vision
        ? {
            vision:
              resolved.visionKey ||
              operatorSecret(process.env, "VISION_API_KEY") ||
              apiKey,
          }
        : {}),
      ...(functions.audio
        ? {
            audio:
              resolved.audioKey ||
              operatorSecret(process.env, "AUDIO_API_KEY") ||
              (host(functions.audio.baseUrl) === host(baseUrl) ? apiKey : ""),
          }
        : {}),
    },
    MODE,
  );
  console.log(`Padrão global: ${label(settings)}`);
  console.log(
    `Configuração gravada no volume (${record.providerId}) — as variáveis LLM_* deixam de ser necessárias.`,
  );
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
    // 1/2 provider and key, so a fresh volume can build the catalog at all
    const before = readStoredSetup(dir);
    let baseUrl = process.env.LLM_BASE_URL?.trim() || before.record?.baseUrl;
    let apiKey = operatorSecret(process.env, "LLM_API_KEY") ?? before.apiKey;

    PROVIDERS.forEach((entry, index) =>
      console.log(
        `  [${index + 1}] ${entry.name}${entry.hint ? ` — ${entry.hint}` : ""}`,
      ),
    );
    const providerAnswer = (
      await readline.question(
        `\nProvedor [${baseUrl ? `atual: ${baseUrl}` : "1"}]: `,
      )
    ).trim();
    if (providerAnswer) {
      const picked = providerFromAnswer(providerAnswer);
      if (!picked)
        return fail("Provedor inválido: use o número, o id ou a URL raiz.");
      // "Outro" has no endpoint of its own: ask for the root URL.
      let pickedUrl = picked.baseUrl;
      if (!pickedUrl)
        pickedUrl = (
          await readline.question(
            "URL raiz do provedor (ex. https://meu-provedor/v1): ",
          )
        ).trim();
      if (!pickedUrl) return fail("Provedor inválido: sem URL.");
      if (pickedUrl !== baseUrl) {
        baseUrl = pickedUrl;
        // A different provider means a different key.
        apiKey = undefined;
      }
    }
    if (!baseUrl) return fail("Informe o provedor (número, id ou URL).");

    if (!apiKey) {
      readline.pause();
      apiKey = await hidden("Chave de API (não aparece): ");
      readline.resume();
    }
    for (let attempt = 0; ; attempt += 1) {
      const check = await listModels(baseUrl, apiKey);
      if (check.ok) {
        console.log(`  ✔ chave válida — ${check.ids.length} modelos listados`);
        break;
      }
      console.log(`  ! ${baseUrl} recusou a chave (${check.detail})`);
      if (attempt >= 2 || !process.stdin.isTTY) return fail("Chave inválida.");
      readline.pause();
      apiKey = await hidden("Chave de API: ");
      readline.resume();
    }
    resolved.baseUrl = baseUrl;
    resolved.apiKey = apiKey;
    resolved.providerId = providerIdFor(baseUrl);
    await loadCatalog(baseUrl, apiKey);

    // 2/2 model, effort and the optional backends
    if (!catalog.length) return fail("Nenhum modelo de chat neste provedor.");
    console.log(`\nPadrão global atual: ${label(current())}`);
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
    const prefill = effectiveFunctions();
    const stored = currentFunctions();
    // 3/4 image: the same catalog, minus the choice of keeping the chat model
    // Does the chat model itself read images? The probe decides what "Enter mantém"
    // means, so the operator does not have to guess.
    const chatProbe = await probeImageSupport({
      modelId: entry.id,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    });
    resolved.chatVision = chatProbe.verdict === "vision";
    console.log(
      `\nModelo do chat: ${
        resolved.chatVision
          ? "lê imagens"
          : chatProbe.verdict === "text"
            ? "NÃO lê imagens"
            : "não foi possível confirmar se lê imagens"
      }${chatProbe.detail ? ` (${chatProbe.detail})` : ""}`,
    );
    console.log(
      `\nIMAGEM — ${resolved.chatVision ? "Enter mantém o do chat, " : ""}"-" desativa. Modelos do mesmo provedor:`,
    );
    catalog.forEach((entry, index) =>
      console.log(`  [${index + 1}] ${entry.id}`),
    );
    const visionAnswer = (
      await readline.question(
        `Modelo de visão [${prefill.vision?.modelId ?? "usa o do chat"}] (ou "o" para outro provedor): `,
      )
    ).trim();
    let vision = stored.vision;
    let visionBase = resolved.baseUrl;
    let visionKey = resolved.apiKey;
    if (visionAnswer === "-") vision = undefined;
    else if (visionAnswer === "o") {
      // Another provider: pick from the curated list instead of typing a URL.
      PROVIDERS.forEach((entry, index) =>
        console.log(
          `  [${index + 1}] ${entry.name}${entry.hint ? ` — ${entry.hint}` : ""}`,
        ),
      );
      const providerAnswer = (
        await readline.question(
          `Provedor de visão [${PROVIDERS.length} = outro endpoint]: `,
        )
      ).trim();
      const picked = providerFromAnswer(providerAnswer);
      if (!picked) return fail("Provedor de visão inválido.");
      let base = picked.baseUrl;
      if (!base)
        base = (
          await readline.question("URL raiz do provedor de visão: ")
        ).trim();
      if (!base) return fail("Visão desativada: sem endpoint.");
      visionBase = base;
      if (host(base) === host(resolved.baseUrl) && resolved.apiKey)
        visionKey = resolved.apiKey;
      else {
        readline.pause();
        visionKey = await hidden(
          `Chave de ${PROVIDERS.find((entry) => entry.id === picked.id)?.name ?? "visão"} (não aparece): `,
        );
        readline.resume();
      }
      if (!visionKey) return fail("Visão desativada: sem chave.");
      // Its own model list, so the id is not typed from memory either.
      const listed = await listModels(base, visionKey);
      if (listed.ok) {
        const ids = listed.ids
          .filter((id) => !NOT_CHAT.test(id))
          .map((id) => id.replace(/^models\//, ""));
        ids
          .slice(0, 25)
          .forEach((id, index) => console.log(`  [${index + 1}] ${id}`));
        const modelAnswer = (
          await readline.question("Modelo de visão (número ou id): ")
        ).trim();
        const index = Number(modelAnswer);
        vision = {
          modelId:
            Number.isSafeInteger(index) && index >= 1 && index <= ids.length
              ? ids[index - 1]
              : modelAnswer,
          baseUrl: base,
        };
      } else {
        console.log(`  ! não consegui listar (${listed.detail})`);
        vision = { modelId: "", baseUrl: base };
      }
    } else if (visionAnswer)
      vision = { modelId: pickFromCatalog(visionAnswer) };
    if (vision) {
      if (!vision.modelId) {
        vision.modelId = (
          await readline.question("Modelo de visão (id): ")
        ).trim();
        if (!vision.modelId) return fail("Visão desativada: sem modelo.");
      }
      resolved.visionKey = visionKey;
      // Ask the chosen model itself, so the operator sees the truth before saving.
      const verdict = await probeImageSupport({
        modelId: vision.modelId,
        baseUrl: visionBase,
        apiKey: visionKey,
      });
      const label = {
        vision: "lê imagens",
        text: "só texto",
        unknown: "não confirmado",
      }[verdict.verdict];
      console.log(
        `  ${verdict.verdict === "vision" ? "✔" : verdict.verdict === "text" ? "✘" : "?"} ${vision.modelId}: ${label}${verdict.detail ? ` (${verdict.detail})` : ""}`,
      );
      if (verdict.verdict !== "vision") {
        const keep = (
          await readline.question("  Usar mesmo assim? [y/N] ")
        ).trim();
        if (!/^y(es)?$/i.test(keep)) vision = undefined;
      }
    }

    // 4/4 audio: its own provider, because a chat endpoint does not transcribe
    console.log('\nÁUDIO — Enter desativa, "-" desativa');
    AUDIO_PROVIDERS.forEach((entry, index) =>
      console.log(
        `  [${index + 1}] ${entry.name}${entry.model ? ` — ${entry.model}` : ""}${entry.hint ? ` (${entry.hint})` : ""}`,
      ),
    );
    const audioAnswer = (
      await readline.question(
        `Transcrição [${prefill.audio ? `${prefill.audio.modelId}` : "desativada"}]: `,
      )
    ).trim();
    let audio = stored.audio;
    if (audioAnswer === "-") audio = undefined;
    else if (audioAnswer) {
      const picked = pickAudio(audioAnswer);
      if (!picked) return fail("Opção de áudio inválida.");
      let base = picked.baseUrl;
      let api = picked.api;
      let model = picked.model;
      if (!base) {
        base = (
          await readline.question("Endpoint de transcrição (URL raiz): ")
        ).trim();
        const format = (
          await readline.question(
            "Formato [1] OpenAI multipart [2] Gemini JSON [1]: ",
          )
        ).trim();
        api = format === "2" ? "gemini" : "openai";
        model = (
          await readline.question("Modelo de transcrição (id): ")
        ).trim();
        if (!base || !model)
          return fail("Áudio desativado: faltou endpoint ou modelo.");
      }
      let audioKey =
        host(base) === host(resolved.baseUrl) ? resolved.apiKey : "";
      if (!audioKey) {
        readline.pause();
        audioKey = await hidden(`Chave da ${picked.name} (não aparece): `);
        readline.resume();
      }
      if (!audioKey) return fail("Áudio desativado: sem chave.");
      resolved.audioKey = audioKey;
      const language = (
        await readline.question(
          `Idioma [${prefill.audio?.language || "auto"}]: `,
        )
      ).trim();
      audio = {
        modelId: model,
        api,
        baseUrl: base,
        ...(language ? { language } : {}),
      };
      console.log(
        "  ⚠ o modelo precisa aceitar ogg (whisper-1, Gemini e Groq aceitam)",
      );
    }
    const selection = {
      ...(vision ? { vision } : {}),
      ...(audio ? { audio } : {}),
    };
    console.log(`\n${functionLabel(selection)}`);
    console.log(`\n${functionLabel(selection)}`);
    const confirm = (
      await readline.question(`Gravar chat ${entry.id} · ${effort}? [y/N] `)
    ).trim();
    if (!/^y(es)?$/i.test(confirm)) return fail("Cancelado.", 0);
    commit(entry, effort, selection);
    if (options.dryRun)
      console.log(`(dry-run) gravaria ${functionLabel(selection)}.`);
    else console.log(`Funções: ${functionLabel(selection)}`);
  } catch (error) {
    // Ctrl+D / closed stdin must cancel, not print a stack trace.
    if (error instanceof Error && error.name === "AbortError")
      return fail("Cancelado.", 0);
    throw error;
  } finally {
    readline.close();
  }
}

const functionFlags =
  options.vision !== undefined ||
  options.audio !== undefined ||
  options.audioApi !== undefined ||
  options.audioLanguage !== undefined;
const hasFlags =
  options.list ||
  options.dryRun ||
  options.model !== undefined ||
  options.effort !== undefined ||
  functionFlags;
const writes =
  options.model !== undefined || options.effort !== undefined || functionFlags;
/** Selection from flags; `none` clears a function, absent keeps what is stored. */
function selectionFromFlags() {
  // Absent keeps what is stored, never the env value: pressing Enter or omitting a
  // flag must not copy an env-declared model into the database, otherwise removing
  // the variable later would keep a model nobody chose.
  const stored = currentFunctions();
  const pick = (flag, stored) =>
    flag === undefined
      ? stored
      : flag === "none" || flag === ""
        ? undefined
        : { ...(stored ?? {}), modelId: flag };
  const vision = pick(options.vision, stored.vision);
  const audioPick = pick(options.audio, stored.audio);
  const audio = audioPick
    ? {
        ...audioPick,
        ...(options.audioApi ? { api: options.audioApi } : {}),
        ...(options.audioLanguage
          ? { language: options.audioLanguage }
          : options.audioLanguage === ""
            ? { language: "" }
            : {}),
      }
    : undefined;
  return { ...(vision ? { vision } : {}), ...(audio ? { audio } : {}) };
}
try {
  if (!hasFlags) {
    if (!process.stdin.isTTY)
      fail(
        `Sem terminal interativo. Use --provider, a chave em LLM_API_KEY (ou --key-stdin) e --model.\n\n${usage}`,
        2,
      );
    await interactive();
  } else {
    // Non-interactive path: flags, then the environment, then the stored setup.
    const stored = readStoredSetup(dir);
    const picked = options.provider
      ? providerFromAnswer(options.provider)
      : undefined;
    const baseUrl =
      picked?.baseUrl ??
      process.env.LLM_BASE_URL?.trim() ??
      stored.record?.baseUrl;
    const apiKey = options.keyStdin
      ? (await readStdin()).trim()
      : (operatorSecret(process.env, "LLM_API_KEY") ?? stored.apiKey);
    if (baseUrl && apiKey) {
      resolved.baseUrl = baseUrl;
      resolved.apiKey = apiKey;
      resolved.providerId = providerIdFor(baseUrl);
      await loadCatalog(baseUrl, apiKey);
    } else if (writes)
      fail(
        "Falta provedor ou chave: use --provider e LLM_API_KEY (ou --key-stdin).",
      );
    if (!writes) printState(baseUrl);
    else {
      const entry = entryFor(
        options.model ?? current()?.modelId ?? catalog[0]?.id,
      );
      const selection = functionFlags
        ? selectionFromFlags()
        : currentFunctions();
      if (resolved.chatVision === undefined) {
        const probe = await probeImageSupport({
          modelId: entry.id,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
        });
        resolved.chatVision = probe.verdict === "vision";
        console.log(
          `Modelo do chat: ${probe.verdict === "vision" ? "lê imagens" : probe.verdict === "text" ? "NÃO lê imagens" : "não confirmado"}${probe.detail ? ` (${probe.detail})` : ""}`,
        );
      }
      commit(entry, effortFor(entry, options.effort), selection);
      if (functionFlags) {
        if (options.dryRun)
          console.log(`(dry-run) gravaria ${functionLabel(selection)}.`);
        else console.log(`Funções: ${functionLabel(selection)}`);
        warnEnvPrecedence(selection);
      }
    }
  }
} finally {
  db.close();
}
