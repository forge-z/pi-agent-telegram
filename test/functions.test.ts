import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFunctions } from "../src/functions.js";
import { transcribeAudio } from "../src/transcribe.js";
import { describeImage, probeImageSupport } from "../src/vision.js";

const chat = {
  LLM_BASE_URL: "https://api.chat.com/v1",
  LLM_API_KEY: "sk-chat",
};

test("function env inherits the chat backend and defaults per provider", () => {
  const off = resolveFunctions({ ...chat });
  assert.equal(off.vision, undefined);
  assert.equal(off.audio, undefined);
  assert.equal(off.imageMode, "auto");

  const shared = resolveFunctions({
    ...chat,
    VISION_MODEL: "vision-1",
    AUDIO_MODEL: "whisper-1",
  });
  // same provider, same key: only the model name is new
  assert.deepEqual(shared.vision, {
    modelId: "vision-1",
    baseUrl: "https://api.chat.com/v1",
    apiKey: "sk-chat",
  });
  // a chat endpoint does not transcribe: with no audio key, audio stays off
  assert.equal(shared.audio, undefined);

  // one provider serving both (Groq-like): same host inherits the chat key
  const sameHost = resolveFunctions({
    ...chat,
    AUDIO_MODEL: "whisper-1",
    AUDIO_BASE_URL: "https://api.chat.com/openai/v1",
  });
  assert.equal(sameHost.audio?.apiKey, "sk-chat");

  // another host never borrows the chat key: that would be a confusing 401
  const otherHost = resolveFunctions({
    ...chat,
    VISION_MODEL: "vision-1",
    VISION_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
    AUDIO_MODEL: "whisper-1",
    AUDIO_API_KEY: "sk-openai",
  });
  assert.equal(otherHost.vision, undefined);
  assert.equal(otherHost.audio?.apiKey, "sk-openai");
  assert.equal(otherHost.audio?.baseUrl, "https://api.openai.com/v1");
});

test("audio api is declared or inferred, and the stored selection is a fallback", () => {
  const gemini = resolveFunctions({
    ...chat,
    AUDIO_MODEL: "gemini-3-flash",
    AUDIO_API: "gemini",
    AUDIO_API_KEY: "g-key",
  });
  assert.equal(
    gemini.audio?.baseUrl,
    "https://generativelanguage.googleapis.com/v1beta",
  );

  const inferred = resolveFunctions({
    ...chat,
    AUDIO_MODEL: "gemini-3-flash",
    AUDIO_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
    AUDIO_API_KEY: "g-key",
  });
  assert.equal(inferred.audio?.api, "gemini");

  // the setup menu stores the model; env still decides keys and endpoints
  const stored = resolveFunctions(
    { ...chat, AUDIO_API_KEY: "sk-audio", AUDIO_LANGUAGE: "pt" },
    {
      providerId: "custom",
      baseUrl: "https://api.chat.com/v1",
      modelId: "m-1",
      vision: { modelId: "v-2" },
      audio: {
        modelId: "whisper-1",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    },
  );
  assert.equal(stored.vision?.modelId, "v-2");
  assert.deepEqual(stored.audio, {
    modelId: "whisper-1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-audio",
    api: "openai",
    language: "pt",
  });

  // env wins over the stored choice
  const override = resolveFunctions(
    { ...chat, VISION_MODEL: "v-env" },
    {
      providerId: "custom",
      baseUrl: "https://x/v1",
      modelId: "m",
      vision: { modelId: "v-stored" },
    },
  );
  assert.equal(override.vision?.modelId, "v-env");

  assert.equal(
    resolveFunctions({ ...chat, VISION_MODE: "text" }).imageMode,
    "text",
  );
  assert.equal(
    resolveFunctions({ ...chat, VISION_MODE: "bogus" }).imageMode,
    "auto",
  );
});

test("describeImage posts a data URL and reads the answer", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: " uma nota " } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const text = await describeImage(
    { modelId: "vision-1", baseUrl: "https://v.example/v1", apiKey: "k" },
    { data: "QUJD", mimeType: "image/jpeg" },
    { fetch: doFetch },
  );
  assert.equal(text, "uma nota");
  assert.equal(calls[0].url, "https://v.example/v1/chat/completions");
  const body = calls[0].body as {
    model: string;
    messages: { content: { type: string; image_url?: { url: string } }[] }[];
  };
  assert.equal(body.model, "vision-1");
  assert.equal(
    body.messages[0].content[1].image_url?.url,
    "data:image/jpeg;base64,QUJD",
  );
});

test("transcribeAudio speaks both request shapes and rejects an empty answer", async () => {
  const sent: {
    url: string;
    form?: FormData;
    body?: string;
    headers: unknown;
  }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers,
      ...(init.body instanceof FormData
        ? { form: init.body }
        : { body: String(init.body) }),
    });
    return new Response(
      JSON.stringify(
        url.includes("generateContent")
          ? { candidates: [{ content: { parts: [{ text: "oi " }] } }] }
          : { text: " oi " },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const audio = { data: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" };

  const viaOpenai = await transcribeAudio(
    {
      modelId: "whisper-1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      api: "openai",
      language: "pt",
    },
    audio,
    { fetch: doFetch },
  );
  assert.equal(viaOpenai, "oi");
  assert.equal(sent[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(sent[0].form?.get("model"), "whisper-1");
  assert.equal(sent[0].form?.get("language"), "pt");
  // Telegram always sends the voice note inside an OGG container
  assert.equal((sent[0].form?.get("file") as File).name, "voice.ogg");

  const viaGemini = await transcribeAudio(
    {
      modelId: "gemini-3-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g",
      api: "gemini",
      language: "",
    },
    audio,
    { fetch: doFetch },
  );
  assert.equal(viaGemini, "oi");
  assert.equal(
    sent[1].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
  );
  assert.match(String(sent[1].body), /"inline_data"/);
  assert.match(String(sent[1].body), /"mime_type":"audio\/ogg"/);

  const empty = (async () =>
    new Response(JSON.stringify({ text: "  " }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await assert.rejects(() =>
    transcribeAudio(
      {
        modelId: "whisper-1",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        api: "openai",
        language: "",
      },
      audio,
      { fetch: empty },
    ),
  );
});

test("probeImageSupport separates a missing modality from an outage", async () => {
  const config = {
    modelId: "m",
    baseUrl: "https://v.example/v1",
    apiKey: "k",
  };
  const stub = (statuses: number[]) => {
    const calls: { withImage: boolean; body: unknown }[] = [];
    let index = 0;
    const doFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const content = body.messages[0].content;
      calls.push({ withImage: Array.isArray(content), body });
      const status = statuses[Math.min(index++, statuses.length - 1)];
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { calls, doFetch };
  };

  // control ok, image ok -> vision
  const yes = stub([200, 200]);
  assert.equal(
    (await probeImageSupport(config, { fetch: yes.doFetch })).verdict,
    "vision",
  );

  // control ok, image fails twice -> text (the image caused it, even as 500)
  const no = stub([200, 500, 500]);
  assert.deepEqual(await probeImageSupport(config, { fetch: no.doFetch }), {
    verdict: "text",
    detail: "resposta 500",
  });
  assert.equal(no.calls.filter((call) => call.withImage).length, 2);

  // control fails -> unknown, never "text"
  const down = stub([503, 503]);
  assert.equal(
    (await probeImageSupport(config, { fetch: down.doFetch })).verdict,
    "unknown",
  );

  // image fails once then works -> not a missing modality
  const flaky = stub([200, 500, 200]);
  assert.equal(
    (await probeImageSupport(config, { fetch: flaky.doFetch })).verdict,
    "unknown",
  );

  // the probe never sends an output limit, so odd providers cannot reject the parameter
  assert.doesNotMatch(
    JSON.stringify(yes.calls[0].body),
    /max_tokens|max_completion/,
  );
});

test("the setup record carries the backend endpoints, not only the models", () => {
  const resolved = resolveFunctions(
    { LLM_BASE_URL: "https://api.chat.com/v1", LLM_API_KEY: "sk-chat" },
    {
      providerId: "custom",
      baseUrl: "https://api.chat.com/v1",
      modelId: "m-1",
      vision: {
        modelId: "gemini-3.5-flash-lite",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      audio: {
        modelId: "whisper-1",
        api: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    },
    { vision: "g-key", audio: "o-key" },
  );
  assert.equal(
    resolved.vision?.baseUrl,
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(resolved.vision?.apiKey, "g-key");
  assert.equal(resolved.audio?.baseUrl, "https://api.openai.com/v1");
  assert.equal(resolved.audio?.apiKey, "o-key");
});
