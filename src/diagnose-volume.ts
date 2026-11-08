import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupKey, usableSetupRecord, type SetupRecord } from "./setup.js";
import {
  canonicalProviderId,
  compatEnvConfigured,
  isApiKeyProviderId,
} from "./native-providers.js";

type Env = Record<string, string | undefined>;

export interface VolumeProviderFacts {
  source: "env" | "volume" | "none";
  recordPresent: boolean;
  authMode?: "chatgpt" | "api_key";
  providerId?: string;
  modelId?: string;
  credentials: Record<"llm" | "openai" | "openai-codex", boolean>;
}

/** Compat reserve only. A complete official volume setup ignores these. */
function envOverrides(env: Env) {
  return compatEnvConfigured(env);
}

function emptyCredentials(): VolumeProviderFacts["credentials"] {
  return { llm: false, openai: false, "openai-codex": false };
}

/**
 * Read-only view of the volume the bot actually runs. Credential values, endpoints
 * and file paths stay out of the result.
 */
export function readVolumeSetupFacts(
  dir: string,
  env: Env = process.env,
  mode = "live",
): VolumeProviderFacts {
  const credentials = emptyCredentials();
  const presentIds = new Set<string>();
  let record: SetupRecord | undefined;
  const file = join(dir, "app.sqlite");
  if (existsSync(file)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get(setupKey(mode)) as { value?: string } | undefined;
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value) as SetupRecord;
          if (usableSetupRecord(parsed)) record = parsed;
        } catch {
          record = undefined;
        }
      }
      const present = db.prepare("SELECT provider FROM credentials").all() as {
        provider: string;
      }[];
      for (const row of present) {
        presentIds.add(row.provider);
        if (row.provider === "llm") credentials.llm = true;
        if (row.provider === "openai") credentials.openai = true;
        if (row.provider === "openai-codex") credentials["openai-codex"] = true;
      }
    } catch {
      /* Missing tables mean the volume has no setup yet. */
    } finally {
      db?.close();
    }
  }
  const hasCredential = (id: string) =>
    presentIds.has(id) || presentIds.has(canonicalProviderId(id));
  const recordPresent = record !== undefined;
  const authMode = !record
    ? undefined
    : record.authMode === "chatgpt" || record.providerId === "openai-codex"
      ? "chatgpt"
      : "api_key";
  const officialRecord =
    !!record &&
    (record.authMode === "chatgpt" ||
      record.providerId === "openai-codex" ||
      (isApiKeyProviderId(record.providerId) &&
        hasCredential(record.providerId)));
  const overrides = envOverrides(env);
  // Official CLI setup wins. Compat `llm` still lets LLM_* override the volume.
  const source = officialRecord
    ? "volume"
    : overrides
      ? "env"
      : recordPresent
        ? "volume"
        : "none";
  return {
    source,
    recordPresent,
    ...(authMode ? { authMode } : {}),
    ...(record?.providerId ? { providerId: record.providerId } : {}),
    ...(record?.modelId ? { modelId: record.modelId } : {}),
    credentials,
  };
}

export const SETUP_VERSUS_LOGIN =
  "npm run setup é o assistente completo (provedor oficial, chave ou ChatGPT, modelo, esforço, visão e áudio). npm run login é só OAuth, inclusive o device-code do Codex sem TTY. Os dois gravam no volume. Um setup oficial não é trocado por LLM_BASE_URL/LLM_API_KEY; essas variáveis só valem no caminho compatível llm (menu Outro). Não há terceiro comando.";

/** Lines for diagnose. Never includes secrets, endpoints, or credential values. */
export function describeVolumeProvider(facts: VolumeProviderFacts): string[] {
  const lines = [
    facts.recordPresent
      ? `volume: registro presente (authMode=${facts.authMode ?? "api_key"}, provider=${facts.providerId ?? "?"}, model=${facts.modelId ?? "?"})`
      : "volume: registro ausente",
    `credentials: llm=${facts.credentials.llm ? "presente" : "ausente"} openai=${facts.credentials.openai ? "presente" : "ausente"} openai-codex=${facts.credentials["openai-codex"] ? "presente" : "ausente"}`,
    facts.source === "env"
      ? "fonte em uso: ambiente (caminho compatível llm; não há setup oficial completo no volume)"
      : facts.source === "volume"
        ? "fonte em uso: volume (setup do CLI; LLM_BASE_URL/LLM_API_KEY não substituem um setup oficial)"
        : "fonte em uso: nenhuma (sem LLM_* e sem registro no volume)",
  ];
  if (facts.recordPresent)
    lines.push(
      `modelo no volume: ${facts.providerId ?? "?"}/${facts.modelId ?? "?"}. /model troca. npm run login grava o primeiro modelo do catálogo só quando o volume ainda não tinha modelo.`,
    );
  lines.push(SETUP_VERSUS_LOGIN);
  return lines;
}

/** health.json `waiting` from the idle process. Unknown values are omitted. */
export function formatWaiting(waiting: unknown): string | undefined {
  if (waiting === "setup")
    return "waiting=setup — processo no ar, sem provedor. Rode npm run setup.";
  if (waiting === "login")
    return "waiting=login — processo no ar, aguardando OAuth. Rode npm run login.";
  return undefined;
}
