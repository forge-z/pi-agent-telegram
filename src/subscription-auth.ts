import { randomUUID } from "node:crypto";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Store } from "./store.js";

/** pi-ai provider ids for ChatGPT / Codex subscription OAuth (not API-key billing). */
export const SUBSCRIPTION_PROVIDER_IDS = ["openai", "openai-codex"] as const;
export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export function isSubscriptionProvider(
  id: string,
): id is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(id);
}

/** When set, the bot may start without LLM_API_KEY after `npm run login`. */
export function chatgptAuthMode(env: Record<string, string | undefined>) {
  const raw = env.LLM_AUTH?.trim().toLowerCase();
  return raw === "chatgpt" || raw === "subscription" || raw === "oauth";
}

export function registerSubscriptionProviders(models: MutableModels) {
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
}

export async function anySubscriptionAuthenticated(models: MutableModels) {
  for (const id of SUBSCRIPTION_PROVIDER_IDS) {
    try {
      if (await models.checkAuth(id)) return true;
    } catch {
      /* Provider missing or store unreadable — treat as not logged in. */
    }
  }
  return false;
}

export function subscriptionSetupPending(record?: {
  providerId?: string;
  authMode?: string;
}) {
  return (
    record?.authMode === "chatgpt" ||
    (!!record?.providerId && isSubscriptionProvider(record.providerId))
  );
}

const DEVICE_ID_KEY = "openai:device-id";

/** Stable installation id required by Sign in with ChatGPT (pi-ai OAuth). */
export function openAiDeviceId(store: Store): string {
  const row = store.get<{ value: string }>(
    "SELECT value FROM meta WHERE key=?",
    DEVICE_ID_KEY,
  );
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { id?: string };
      if (parsed.id && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed.id;
    } catch {
      /* fall through and mint a new id */
    }
  }
  const id = randomUUID();
  store.run(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    DEVICE_ID_KEY,
    JSON.stringify({ id }),
  );
  return id;
}
