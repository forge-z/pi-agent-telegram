import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramBotApi } from "../src/telegram-api.js";
import {
  attachmentMedia,
  describeMedia,
  imageVerdict,
  mediaFor,
  mediaFromText,
  outboundMedia,
} from "../src/outbound.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const mp3 = Buffer.from("ID3synthetic-audio").toString("base64");

/** Records the Bot API call: JSON body or multipart form, and the method used. */
function bot() {
  const calls: {
    method: string;
    json?: Record<string, unknown>;
    form?: FormData;
  }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const method = String(url).split("/").pop()!;
    const body = init?.body;
    calls.push(
      body instanceof FormData
        ? { method, form: body }
        : { method, json: JSON.parse(String(body ?? "{}")) },
    );
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return {
    calls,
    api: new TelegramBotApi("123:synthetic-only"),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("a file with a URL is handed to Telegram, which fetches it", async () => {
  const f = bot();
  try {
    await f.api.sendMedia("-100123", {
      kind: "audio",
      url: "https://example.test/cron.mp3",
      mimeType: "audio/mpeg",
    });
    assert.equal(f.calls.length, 1);
    // No upload: the URL travels as JSON and the bytes never pass through us.
    assert.equal(f.calls[0].method, "sendAudio");
    assert.equal(f.calls[0].json?.audio, "https://example.test/cron.mp3");
    assert.equal(f.calls[0].json?.chat_id, "-100123");
    assert.equal(f.calls[0].form, undefined);
  } finally {
    f.restore();
  }
});

test("bytes upload multipart, with the method the kind asks for", async () => {
  const f = bot();
  try {
    const cases = [
      { kind: "audio", field: "audio", method: "sendAudio", name: "anexo.mp3" },
      { kind: "voice", field: "voice", method: "sendVoice", name: "anexo.ogg" },
      { kind: "photo", field: "photo", method: "sendPhoto", name: "anexo.jpg" },
      {
        kind: "document",
        field: "document",
        method: "sendDocument",
        name: "anexo.bin",
      },
    ] as const;
    for (const item of cases) {
      await f.api.sendMedia(
        "-100123",
        { kind: item.kind, data: png, mimeType: "application/octet-stream" },
        { messageThreadId: 11 },
      );
      const call = f.calls.at(-1)!;
      assert.equal(call.method, item.method);
      assert.equal(String(call.form?.get("chat_id")), "-100123");
      assert.equal(String(call.form?.get("message_thread_id")), "11");
      const file = call.form?.get(item.field);
      assert.ok(file instanceof Blob, `${item.kind} enviado como arquivo`);
    }
  } finally {
    f.restore();
  }
});

test("the media kind follows the mime type, and only files become attachments", () => {
  assert.equal(mediaFor("audio/mpeg"), "audio");
  assert.equal(mediaFor("audio/wav"), "audio");
  assert.equal(mediaFor("audio/ogg"), "voice");
  assert.equal(mediaFor("audio/opus"), "voice");
  assert.equal(mediaFor("image/png"), "photo");
  assert.equal(mediaFor("application/pdf"), "document");

  // `audio` content with inline data or a URL
  assert.equal(
    outboundMedia({ type: "audio", mimeType: "audio/wav", data: mp3 })?.kind,
    "audio",
  );
  assert.equal(
    outboundMedia({
      type: "audio",
      mimeType: "audio/ogg",
      url: "https://x/y.ogg",
    })?.kind,
    "voice",
  );
  // `resource` with a blob, and with a fetchable uri
  const blob = outboundMedia({
    type: "resource",
    resource: { uri: "file:///tmp/a.png", mimeType: "image/png", blob: png },
  });
  assert.equal(blob?.kind, "photo");
  assert.equal(blob?.data, png);
  const linked = outboundMedia({
    type: "resource",
    resource: { uri: "https://x/y.pdf", mimeType: "application/pdf" },
  });
  assert.equal(linked?.kind, "document");
  assert.equal(linked?.url, "https://x/y.pdf");
  // A resource without bytes and without a fetchable URL is a reference, not a file
  assert.equal(
    outboundMedia({ type: "resource", resource: { uri: "file:///tmp/a.png" } }),
    undefined,
  );
  // `resource_link` and text stay in the text
  assert.equal(
    outboundMedia({ type: "resource_link", uri: "https://x" }),
    undefined,
  );
  assert.equal(outboundMedia({ type: "text", text: "oi" }), undefined);

  // The model sees a line, never the bytes
  const described = describeMedia({
    kind: "audio",
    mimeType: "audio/mpeg",
    data: mp3,
  });
  assert.match(described, /^\[anexo enviado ao chat: audio\/mpeg/);
  assert.doesNotMatch(described, /ID3/);
});

test("a refused upload is an error, never a crash", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await assert.rejects(() =>
      new TelegramBotApi("123:synthetic-only").sendMedia("-100123", {
        kind: "audio",
        data: mp3,
        mimeType: "audio/mpeg",
      }),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a JSON descriptor inside text is a file, except when it is a link", () => {
  // What the Executor returns for Fish Audio: text, not a content part.
  const audio = mediaFromText(
    JSON.stringify({
      type: "audio",
      url: "https://platform.r2.fish.audio/x/be9bc3fcd53c41e29f1590691c127f36.mp3",
      mimeType: "audio/mpeg",
    }),
  );
  assert.equal(audio?.kind, "audio");
  assert.match(
    String(audio?.url),
    /^https:\/\/platform\.r2\.fish\.audio\/.*\.mp3$/,
  );
  assert.equal(audio?.mimeType, "audio/mpeg");

  // Fenced JSON is still a descriptor.
  assert.equal(
    mediaFromText(
      '```json\n{"type":"resource","resource":{"uri":"https://x/a.png","mimeType":"image/png"}}\n```',
    )?.kind,
    "photo",
  );

  // A resource_link stays a link in the text, and ordinary JSON is untouched.
  assert.equal(
    mediaFromText(
      JSON.stringify({ type: "resource_link", uri: "https://x/a.mp3" }),
    ),
    undefined,
  );
  assert.equal(
    mediaFromText(JSON.stringify({ id: "tarefa-1", title: "Resumo" })),
    undefined,
  );
  assert.equal(mediaFromText("texto solto"), undefined);
});

test("an image too small for the provider is caught before it enters the history", () => {
  // The 1x1 PNG that broke a conversation: the provider answers 400 for it, and the
  // part then fails every later turn.
  assert.deepEqual(imageVerdict(png, "image/png"), {
    ok: false,
    reason: "1×1 px, pequena demais",
  });
  // A real photo-sized PNG passes.
  const wide = Buffer.from(png, "base64");
  wide.writeUInt32BE(1280, 16);
  wide.writeUInt32BE(960, 20);
  assert.equal(imageVerdict(wide.toString("base64"), "image/png").ok, true);
  // A GIF below the floor, an unknown format and empty bytes are refused too.
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");
  assert.equal(imageVerdict(gif.toString("base64"), "image/gif").ok, false);
  assert.equal(imageVerdict(png.slice(0, 20), "application/pdf").ok, false);
  assert.equal(imageVerdict("", "image/png").ok, false);
  // JPEG carries its size deeper in, so the byte floor catches the degenerate case.
  assert.equal(
    imageVerdict(
      Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"),
      "image/jpeg",
    ).ok,
    false,
  );
});

test("the model can ask for a file, and only a public URL is accepted", () => {
  // Kind comes from the extension when the model does not say it.
  assert.equal(
    attachmentMedia({ url: "https://platform.r2.fish.audio/x/a.mp3" }).kind,
    "audio",
  );
  assert.equal(attachmentMedia({ url: "https://x.test/a.ogg" }).kind, "voice");
  assert.equal(attachmentMedia({ url: "https://x.test/a.png" }).kind, "photo");
  assert.equal(
    attachmentMedia({ url: "https://x.test/a.pdf" }).kind,
    "document",
  );
  // A declared kind and a name win over the guess.
  assert.deepEqual(
    attachmentMedia({
      url: "https://x.test/file",
      kind: "voice",
      name: "recado.ogg",
    }),
    { kind: "voice", url: "https://x.test/file", filename: "recado.ogg" },
  );
  // The app never fetches the URL, so anything that is not public http(s) is refused:
  // a local path, another scheme or an internal host would be an SSRF door.
  for (const url of [
    "file:///etc/passwd",
    "/tmp/a.mp3",
    "ftp://x.test/a.mp3",
    "http://169.254.169.254/latest/meta-data",
    "",
  ]) {
    if (url.startsWith("http://")) {
      // http is allowed: Telegram fetches it, not us. Only the scheme gate applies.
      assert.equal(attachmentMedia({ url }).kind, "document");
      continue;
    }
    assert.throws(() => attachmentMedia({ url }), /URL pública/);
  }
});
