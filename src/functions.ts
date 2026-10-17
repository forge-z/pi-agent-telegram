import { operatorSecret } from "./config.js";
import type { SetupRecord } from "./setup.js";
import type { AudioConfig } from "./transcribe.js";
import type { VisionConfig } from "./vision.js";

type ImageMode = "auto" | "native" | "text";

interface Functions {
  vision?: VisionConfig;
  audio?: AudioConfig;
  imageMode: ImageMode;
}

const OPENAI_AUDIO = "https://api.openai.com/v1";
const GEMINI_AUDIO = "https://generativelanguage.googleapis.com/v1beta";

function url(raw: string | undefined, label: string) {
  if (!raw) return undefined;
  const value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value))
    throw new Error(`${label} precisa começar com https://`);
  return value;
}

/** Host of an endpoint, for the "same provider" test that decides key inheritance. */
function host(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function mode(raw: string | undefined): ImageMode {
  const value = raw?.trim().toLowerCase();
  return value === "native" || value === "text" ? value : "auto";
}

/**
 * Resolves the optional per-function backends. Env wins over the stored selection, and
 * anything left empty inherits the chat backend - one provider covers chat and vision.
 * Audio never inherits the chat endpoint: a chat endpoint does not transcribe.
 */
export function resolveFunctions(
  env: Record<string, string | undefined>,
  setup: SetupRecord | undefined = undefined,
  keys: { vision?: string; audio?: string } = {},
): Functions {
  const stored = setup ?? ({} as Partial<SetupRecord>);
  const chatUrl = url(env.LLM_BASE_URL, "LLM_BASE_URL");
  const chatKey = operatorSecret(env, "LLM_API_KEY");

  const visionModel = env.VISION_MODEL?.trim() || stored.vision?.modelId;
  const visionUrl =
    url(env.VISION_BASE_URL, "VISION_BASE_URL") ??
    url(stored.vision?.baseUrl, "VISION_BASE_URL");
  // The chat key belongs to the chat endpoint: inheriting it for another host would
  // only produce a 401 that looks like a bad model name.
  const visionKey =
    operatorSecret(env, "VISION_API_KEY") ??
    keys.vision ??
    (!visionUrl || visionUrl === chatUrl ? chatKey : undefined);
  const vision: VisionConfig | undefined =
    visionModel && visionKey
      ? {
          modelId: visionModel,
          baseUrl: visionUrl ?? chatUrl ?? "https://api.openai.com/v1",
          apiKey: visionKey,
        }
      : undefined;

  const audioModel = env.AUDIO_MODEL?.trim() || stored.audio?.modelId;
  const declared = (env.AUDIO_API?.trim().toLowerCase() ||
    stored.audio?.api) as string | undefined;
  const audioUrl =
    url(env.AUDIO_BASE_URL, "AUDIO_BASE_URL") ??
    url(stored.audio?.baseUrl, "AUDIO_BASE_URL");
  const audioApi: "openai" | "gemini" =
    declared === "gemini" ||
    (!declared && audioUrl?.includes("generativelanguage"))
      ? "gemini"
      : "openai";
  // Audio rarely shares the chat endpoint, so the chat key is inherited only when it
  // explicitly points at the same host (Groq, for instance, serves chat and audio).
  const audioKey =
    operatorSecret(env, "AUDIO_API_KEY") ??
    keys.audio ??
    (audioUrl && host(audioUrl) === host(chatUrl) ? chatKey : undefined);
  const audio: AudioConfig | undefined =
    audioModel && audioKey
      ? {
          modelId: audioModel,
          baseUrl:
            audioUrl ?? (audioApi === "gemini" ? GEMINI_AUDIO : OPENAI_AUDIO),
          apiKey: audioKey,
          api: audioApi,
          language: env.AUDIO_LANGUAGE?.trim() || stored.audio?.language || "",
        }
      : undefined;

  return {
    ...(vision ? { vision } : {}),
    ...(audio ? { audio } : {}),
    imageMode: mode(env.VISION_MODE),
  };
}
