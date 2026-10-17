import { deflateSync } from "node:zlib";

/** One auxiliary vision backend, resolved from env plus the stored selection. */
export interface VisionConfig {
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

/** Why describe instead of attach: the main model cannot read images at all. */
const PROMPT = [
  "Transcreva todo o texto visível na imagem, preservando a ordem de leitura.",
  "Depois descreva em uma frase o que a imagem mostra e qualquer dado numérico,",
  "tabela, gráfico ou mensagem de erro relevante. Não invente o que não está visível.",
].join(" ");

/**
 * Turns an image into text with a separate model, for a main model that cannot see.
 * OpenAI-compatible `chat/completions` with a `data:` URL: the widest shape across
 * providers, and no registry wiring for a second backend.
 */
export async function describeImage(
  config: VisionConfig,
  image: { data: string; mimeType: string },
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            },
          ],
        },
      ],
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`vision ${response.status}`);
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === "object" && "text" in part
                ? String((part as { text: unknown }).text)
                : "",
            )
            .join("")
        : "";
  const trimmed = text.trim();
  if (!trimmed) throw new Error("vision: resposta vazia");
  return trimmed;
}

/** CRC32 as the PNG spec wants it; a table is overkill for two chunks. */
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/**
 * A 64x64 flat PNG built here instead of pasted as base64 - one mistyped character would
 * become "unsupported image" on the provider and a false "text only" verdict.
 */
function probePng() {
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = 200;
      raw[row + 2 + x * 3] = 60;
      raw[row + 3 + x * 3] = 60;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const PROBE_PNG = probePng();

type ImageSupport = "vision" | "text" | "unknown";

/**
 * Asks the model itself whether it reads images. A catalog lies and a status code alone
 * is ambiguous - OpenAI answers 500 both for "no such modality" and for a real outage -
 * so a control call without the image separates the two: if the plain call works and the
 * image call fails twice, the image is the cause.
 */
export async function probeImageSupport(
  config: { modelId: string; baseUrl: string; apiKey: string },
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ verdict: ImageSupport; detail?: string }> {
  const doFetch = options.fetch ?? fetch;
  const send = async (withImage: boolean) => {
    const content = withImage
      ? [
          { type: "text", text: "ok" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PROBE_PNG}` },
          },
        ]
      : "ok";
    const response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: "user", content }],
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = response.ok ? "" : await response.text().catch(() => "");
    // Short provider message: "missing field model" is worth showing, the JSON is not.
    const found =
      /"message"\s*:\s*"([^"]{1,120})"/.exec(body)?.[1] ??
      body.replace(/\s+/g, " ").slice(0, 60);
    // "{}" or punctuation alone says nothing; only a readable message is worth showing.
    const hint = /[a-z]{3,}/i.test(found) ? found : "";
    return { ok: response.ok, status: response.status, hint };
  };
  const control = await send(false).catch(() => undefined);
  if (!control?.ok)
    return {
      verdict: "unknown",
      detail: control
        ? `modelo não respondeu (${control.status}${control.hint ? `: ${control.hint}` : ""})`
        : "sem resposta",
    };
  const first = await send(true).catch(() => undefined);
  if (first?.ok) return { verdict: "vision" };
  // A transient outage would not repeat; a missing modality does.
  const second = first ? await send(true).catch(() => undefined) : undefined;
  if (first && second && !first.ok && !second.ok)
    return {
      verdict: "text",
      detail: `resposta ${first.status}${first.hint ? `: ${first.hint}` : ""}`,
    };
  return {
    verdict: "unknown",
    detail: first ? `resposta ${first.status}, não confirmada` : "sem resposta",
  };
}
