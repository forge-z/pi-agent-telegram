/**
 * Binary a turn produced and the chat should receive. `url` wins over `data`: Telegram
 * fetches a URL itself, so the bytes never pass through this process.
 */
export interface OutboundMedia {
  kind: "audio" | "voice" | "photo" | "document";
  url?: string;
  /** Base64, in the shape MCP results carry a blob. */
  data?: string;
  filename?: string;
  mimeType?: string;
}

const AUDIO = /^audio\/(mpeg|mp3|wav|x-wav)$/i;
const VOICE = /^audio\/(ogg|opus)$/i;

/** Bot API method and multipart field for each kind. */
export function mediaTarget(media: OutboundMedia) {
  return {
    audio: { method: "sendAudio", field: "audio", ext: "mp3" },
    voice: { method: "sendVoice", field: "voice", ext: "ogg" },
    photo: { method: "sendPhoto", field: "photo", ext: "jpg" },
    document: { method: "sendDocument", field: "document", ext: "bin" },
  }[media.kind] as { method: string; field: string; ext: string };
}

export function mediaFor(mimeType: string): OutboundMedia["kind"] {
  if (VOICE.test(mimeType)) return "voice";
  if (AUDIO.test(mimeType)) return "audio";
  if (/^image\//i.test(mimeType)) return "photo";
  return "document";
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** File name Telegram uses for the attachment; keeps the extension honest. */
function filenameOf(media: OutboundMedia) {
  if (media.filename) return media.filename;
  const fromUrl = media.url?.split(/[?#]/)[0]?.split("/").pop();
  if (fromUrl && /\.[a-z0-9]{2,5}$/i.test(fromUrl)) return fromUrl;
  return `anexo.${mediaTarget(media).ext}`;
}

/**
 * Reads an MCP content part that carries a file: `audio` with inline data or a URL, or
 * a `resource` with a blob/uri. `resource_link` and text are not attachments, and stay in
 * the text the model reads.
 */
export function outboundMedia(part: unknown): OutboundMedia | undefined {
  if (!part || typeof part !== "object") return undefined;
  const item = part as Record<string, unknown>;
  switch (item.type) {
    case "audio": {
      const mimeType = text(item.mimeType) ?? "audio/mpeg";
      const data = text(item.data);
      const url = text(item.url);
      if (!data && !url) return undefined;
      return {
        kind: mediaFor(mimeType),
        mimeType,
        ...(url ? { url } : {}),
        ...(data ? { data } : {}),
      };
    }
    case "resource": {
      const resource = (
        item.resource && typeof item.resource === "object"
          ? item.resource
          : item
      ) as Record<string, unknown>;
      const blob = text(resource.blob);
      const uri = text(resource.uri);
      const url = uri && /^https?:\/\//i.test(uri) ? uri : undefined;
      // A resource without bytes and without a fetchable URL is only a reference.
      if (!blob && !url) return undefined;
      const mimeType = text(resource.mimeType) ?? "application/octet-stream";
      return {
        kind: mediaFor(mimeType),
        mimeType,
        ...(url ? { url } : {}),
        ...(blob ? { data: blob } : {}),
        filename: filenameOf({ kind: "document", url: uri }),
      };
    }
    default:
      return undefined;
  }
}

/** What the model reads instead of the bytes: it knows a file was sent, without them. */
export function describeMedia(media: OutboundMedia) {
  const size = media.data
    ? `${Math.round((media.data.length * 3) / 4 / 1024)} KB`
    : (media.url ?? "");
  return `[anexo enviado ao chat: ${media.mimeType ?? "binário"}${size ? `, ${size}` : ""}]`;
}

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/**
 * A descriptor inside text: the Executor returns `{"type":"audio","url":…,"mimeType":…}`
 * as a text result, so the part never looks like a file to the MCP path.
 */
export function mediaFromText(value: unknown): OutboundMedia | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const body = FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (!body.startsWith("{")) return undefined;
  try {
    return outboundMedia(JSON.parse(body));
  } catch {
    return undefined;
  }
}

/** Below this, providers refuse the image and the turn fails on every later message. */
const MIN_IMAGE_SIDE = 32;

type Dimensions =
  | { kind: "png" | "gif"; width: number; height: number }
  | { kind: "jpeg" | "webp" };

function dimensions(bytes: Buffer): Dimensions | undefined {
  // Truncated bytes are common (a broken tool result); reading past the end throws.
  if (
    bytes.byteLength >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return {
      kind: "png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  if (
    bytes.byteLength >= 10 &&
    bytes.subarray(0, 3).toString("ascii") === "GIF"
  )
    return {
      kind: "gif",
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { kind: "jpeg" };
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { kind: "webp" };
  return undefined;
}

/**
 * Whether an image can go into the model context. A provider refuses an unsupported
 * image with 400, and once that part is in the history every later turn fails - so a
 * 1x1 tool result must be caught here, not by the provider.
 */
export function imageVerdict(
  data: unknown,
  mimeType: string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof data !== "string" || !data)
    return { ok: false, reason: "sem bytes" };
  let size: Dimensions | undefined;
  let byteLength = 0;
  try {
    const raw = Buffer.from(data, "base64");
    byteLength = raw.byteLength;
    size = dimensions(raw);
  } catch {
    size = undefined;
  }
  if (!size)
    return { ok: false, reason: `${mimeType || "formato"} não reconhecido` };
  if (size.kind === "png" || size.kind === "gif") {
    if (size.width < MIN_IMAGE_SIDE || size.height < MIN_IMAGE_SIDE)
      return {
        ok: false,
        reason: `${size.width}×${size.height} px, pequena demais`,
      };
    return { ok: true };
  }
  // JPEG and WebP carry their size deeper in; the byte floor catches the degenerate case.
  if (byteLength < 1024)
    return { ok: false, reason: `${byteLength} bytes, pequena demais` };
  return { ok: true };
}

/** Extension to kind, for a URL that arrives without a mime type. */
function kindFromUrl(url: string): "audio" | "voice" | "photo" | "document" {
  const ext = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  if (ext === "ogg" || ext === "opus") return "voice";
  if (ext && ["mp3", "m4a", "wav", "flac", "aac"].includes(ext)) return "audio";
  if (ext && ["jpg", "jpeg", "png", "webp", "gif"].includes(ext))
    return "photo";
  return "document";
}

/**
 * A file the model asks to send: only a URL, because Telegram fetches it. Anything that
 * is not public http(s) is refused - the app must not fetch it (that is an SSRF door).
 */
export function attachmentMedia(input: {
  url: unknown;
  kind?: unknown;
  name?: unknown;
}): OutboundMedia {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!/^https?:\/\//i.test(url))
    throw new Error("Anexo exige uma URL pública http(s)");
  const declared =
    input.kind === "audio" ||
    input.kind === "voice" ||
    input.kind === "photo" ||
    input.kind === "document"
      ? input.kind
      : undefined;
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : undefined;
  return {
    kind: declared ?? kindFromUrl(url),
    url,
    ...(name ? { filename: name } : {}),
  };
}
