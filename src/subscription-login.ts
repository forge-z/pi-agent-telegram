import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { Store } from "./store.js";
import {
  openAiDeviceId,
  type SubscriptionProviderId,
} from "./subscription-auth.js";

/** Endpoints that are not chat models, even when the provider lists them. */
export const NOT_CHAT_MODEL =
  /(tts|whisper|transcri|embedding|embed-|aqa|imagen|veo|dall-e|moderation|realtime)/i;

export const CHATGPT_AUTH_META_KEY = (mode = "live") => `chatgpt-auth:${mode}`;

/** Volume equivalent of `LLM_AUTH=chatgpt` (env still wins at runtime). */
export function writeChatgptAuthMode(store: Store, mode = "live") {
  store.run(
    "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    CHATGPT_AUTH_META_KEY(mode),
    "chatgpt",
  );
}

export function readChatgptAuthMode(store: Store, mode = "live") {
  return (
    store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      CHATGPT_AUTH_META_KEY(mode),
    )?.value === "chatgpt"
  );
}

export function subscriptionChatCatalog(
  models: MutableModels,
  providerId: string,
) {
  return models
    .getModels(providerId)
    .filter((model) => !NOT_CHAT_MODEL.test(model.id))
    .map((model) => ({
      id: model.id.replace(/^models\//, ""),
      efforts: getSupportedThinkingLevels(model),
    }));
}

export function oauthInteractionFromReadline(
  readline: ReadlineInterface,
  options: { deviceCodeOnly?: boolean } = {},
): AuthInteraction {
  return {
    prompt: async (p) => {
      if (
        p.type === "select" &&
        p.message.includes("Codex login method") &&
        (options.deviceCodeOnly || !process.stdin.isTTY)
      ) {
        return "device_code";
      }
      if (p.type === "select") {
        console.log(p.message);
        p.options.forEach((opt, index) => {
          console.log(`  [${index + 1}] ${opt.label ?? opt.id}`);
        });
        const answer = (await readline.question("Choice [1]: ")).trim() || "1";
        const index = Number(answer);
        if (
          Number.isSafeInteger(index) &&
          index >= 1 &&
          index <= p.options.length
        ) {
          return p.options[index - 1].id;
        }
        return p.options[0]?.id;
      }
      if (p.type === "manual_code" || p.type === "text") {
        console.log(p.message);
        if (p.placeholder) console.log(`(e.g. ${p.placeholder})`);
        return (await readline.question("> ")).trim();
      }
      if (p.type === "secret") {
        return (await readline.question(`${p.message}: `)).trim();
      }
      const unknown = p as { message?: string };
      const fallback =
        typeof unknown.message === "string" ? unknown.message : "Answer";
      return (await readline.question(`${fallback}: `)).trim();
    },
    notify: (event) => {
      if (event.type === "info") {
        console.log(event.message);
        for (const link of event.links ?? []) {
          console.log(`${link.label ?? "Link"}: ${link.url}`);
        }
      } else if (event.type === "auth_url") {
        console.log(event.instructions ?? "Open this link in a browser:");
        console.log(event.url);
      } else if (event.type === "device_code") {
        console.log(
          `Code: ${event.userCode}\nOpen: ${event.verificationUri}\nWaiting for confirmation (up to ${Math.round((event.expiresInSeconds ?? 900) / 60)} min)...`,
        );
      } else if (event.type === "progress") {
        console.log(event.message);
      }
    },
  };
}

export async function runSubscriptionLogin(
  store: Store,
  models: MutableModels,
  providerId: SubscriptionProviderId,
  interaction: AuthInteraction,
  options: { deviceCodeOnly?: boolean } = {},
) {
  const prompt = async (
    ...args: Parameters<NonNullable<AuthInteraction["prompt"]>>
  ) => {
    const [p] = args;
    if (
      p.type === "select" &&
      p.message.includes("Codex login method") &&
      options.deviceCodeOnly
    ) {
      return "device_code";
    }
    return interaction.prompt(...args);
  };
  await models.login(
    providerId,
    "oauth",
    { prompt, notify: interaction.notify.bind(interaction) },
    { getDeviceId: () => openAiDeviceId(store) },
  );
  writeChatgptAuthMode(store);
}
