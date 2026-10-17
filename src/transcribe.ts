/** One auxiliary transcription backend, resolved from env plus the stored selection. */
export interface AudioConfig {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  /** Request shape: OpenAI's multipart upload or Gemini's inline base64 JSON. */
  api: "openai" | "gemini";
  /** Language hint; empty means detect. Gemini has no field for it, so it joins the prompt. */
  language: string;
}

const GEMINI_PROMPT = "Transcreva este áudio. Devolva só o texto transcrito.";

/** Transcribes Telegram's OGG/Opus voice note; the provider reads it as-is. */
export async function transcribeAudio(
  config: AudioConfig,
  audio: { data: Uint8Array; mimeType: string },
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const text =
    config.api === "gemini"
      ? await gemini(doFetch, config, audio, options.signal)
      : await openai(doFetch, config, audio, options.signal);
  const trimmed = text.trim();
  if (!trimmed) throw new Error("transcrição vazia");
  return trimmed;
}

function requestInit(
  headers: Record<string, string>,
  body: BodyInit,
  signal?: AbortSignal,
): RequestInit {
  return { method: "POST", headers, body, ...(signal ? { signal } : {}) };
}

/** `POST {base}/audio/transcriptions`: OpenAI, Groq, Mistral and xAI share this shape. */
async function openai(
  doFetch: typeof fetch,
  config: AudioConfig,
  audio: { data: Uint8Array; mimeType: string },
  signal?: AbortSignal,
) {
  const form = new FormData();
  // The filename carries the real extension: providers sniff it, and Telegram always
  // sends Opus voice notes inside an OGG container.
  form.set(
    "file",
    new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
    audio.mimeType === "audio/ogg" ? "voice.ogg" : "voice.bin",
  );
  form.set("model", config.modelId);
  form.set("response_format", "json");
  if (config.language) form.set("language", config.language);
  const response = await doFetch(
    `${config.baseUrl}/audio/transcriptions`,
    requestInit({ authorization: `Bearer ${config.apiKey}` }, form, signal),
  );
  if (!response.ok) throw new Error(`transcrição ${response.status}`);
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}

/** `POST {base}/models/{model}:generateContent` with the audio inline as base64. */
async function gemini(
  doFetch: typeof fetch,
  config: AudioConfig,
  audio: { data: Uint8Array; mimeType: string },
  signal?: AbortSignal,
) {
  const instruction = config.language
    ? `${GEMINI_PROMPT} O áudio está em ${config.language}; responda nesse idioma.`
    : GEMINI_PROMPT;
  const response = await doFetch(
    `${config.baseUrl}/models/${config.modelId}:generateContent`,
    requestInit(
      { "x-goog-api-key": config.apiKey, "content-type": "application/json" },
      JSON.stringify({
        contents: [
          {
            parts: [
              { text: instruction },
              {
                inline_data: {
                  mime_type: audio.mimeType,
                  data: Buffer.from(audio.data).toString("base64"),
                },
              },
            ],
          },
        ],
      }),
      signal,
    ),
  );
  if (!response.ok) throw new Error(`transcrição ${response.status}`);
  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  };
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}
