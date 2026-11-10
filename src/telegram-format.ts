import { lexer } from "marked";

const CHUNK_LIMIT = 3800;

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownCell[];
  rows?: MarkdownCell[][];
  ordered?: boolean;
  start?: number | string;
  depth?: number;
  href?: string;
};
type MarkdownCell = { text?: string; tokens?: MarkdownToken[] };
type Tag = { name: "b" | "i" | "s" | "code" | "pre" | "a"; open: string };

/** Format Markdown into independently valid Telegram HTML messages. */
export function formatTelegramMessage(text: string): string[] {
  const writer = new HtmlChunks();
  writeBlocks(writer, lexer(text) as unknown as MarkdownToken[]);
  return writer.finish();
}

class HtmlChunks {
  private chunks: string[] = [];
  private current = "";
  private visible = 0;
  private visibleText = "";
  private tags: Tag[] = [];

  text(value: string) {
    for (const character of value) {
      // Count UTF-16 code units conservatively for Telegram's length limit,
      // while iterating by code point so a surrogate pair is never divided.
      if (this.visible + character.length > CHUNK_LIMIT) this.split();
      this.current += escapeText(character);
      this.visible += character.length;
      this.visibleText += character;
    }
  }

  open(name: Tag["name"], attributes = "") {
    if (this.visible >= CHUNK_LIMIT) this.split();
    const open = `<${name}${attributes}>`;
    this.current += open;
    this.tags.push({ name, open });
  }

  close(name: Tag["name"]) {
    const tag = this.tags.pop();
    if (!tag || tag.name !== name)
      throw new Error("Formatter produced unbalanced Telegram tags");
    this.current += `</${name}>`;
  }

  withoutFormatting(write: () => void) {
    const suspended = this.tags;
    for (const tag of [...suspended].reverse())
      this.current += `</${tag.name}>`;
    this.tags = [];
    write();
    this.tags = suspended;
    this.current += suspended.map((tag) => tag.open).join("");
  }

  private split() {
    if (!this.visible) return;
    for (const tag of [...this.tags].reverse())
      this.current += `</${tag.name}>`;
    this.chunks.push(this.current);
    this.current = this.tags.map((tag) => tag.open).join("");
    this.visible = 0;
    this.visibleText = "";
  }

  finish() {
    if (this.visible && this.visibleText.trim()) {
      for (const tag of [...this.tags].reverse())
        this.current += `</${tag.name}>`;
      this.chunks.push(this.current);
    }
    return this.chunks;
  }
}

function writeBlocks(writer: HtmlChunks, tokens: MarkdownToken[]) {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
        writeInline(writer, token.tokens);
        writer.text("\n\n");
        break;
      case "heading":
        writer.open("b");
        writeInline(writer, token.tokens, token.text);
        writer.close("b");
        writer.text("\n\n");
        break;
      case "text":
        writeInline(writer, token.tokens, token.text ?? token.raw);
        writer.text("\n\n");
        break;
      case "code":
        writer.withoutFormatting(() => {
          writer.open("pre");
          writer.open("code");
          writer.text(token.text ?? "");
          writer.close("code");
          writer.close("pre");
        });
        writer.text("\n\n");
        break;
      case "list":
        writer.text("\n");
        writeList(writer, token, 0);
        writer.text("\n\n");
        break;
      case "blockquote":
        writer.text("> ");
        writeBlocks(writer, token.tokens ?? []);
        break;
      case "hr":
        writer.text("────────\n\n");
        break;
      case "table":
        writeTable(writer, token);
        break;
      case "html":
        writer.text(token.raw ?? token.text ?? "");
        break;
      default:
        writeInline(writer, token.tokens, token.text ?? token.raw);
    }
  }
}

function writeList(writer: HtmlChunks, list: MarkdownToken, depth: number) {
  const items = list.items ?? [];
  let number = Number(list.start) || 1;
  items.forEach((item, index) => {
    if (index) writer.text("\n");
    writer.text(`${"  ".repeat(depth)}${list.ordered ? `${number++}.` : "•"} `);
    let hasContent = false;
    let nestedLast = false;
    for (const child of item.tokens ?? []) {
      if (child.type === "list") {
        writer.text("\n");
        writeList(writer, child, depth + 1);
        hasContent = true;
        nestedLast = true;
      } else if (child.type === "text" || child.type === "paragraph") {
        if (nestedLast) writer.text(`\n${"  ".repeat(depth + 1)}`);
        writeInline(writer, child.tokens, child.text ?? child.raw);
        hasContent = true;
        nestedLast = false;
      } else {
        if (hasContent) writer.text(`\n${"  ".repeat(depth + 1)}`);
        writeBlocks(writer, [child]);
        hasContent = true;
        nestedLast = child.type === "list";
      }
    }
  });
}

function writeTable(writer: HtmlChunks, token: MarkdownToken) {
  const rows = [token.header ?? [], ...(token.rows ?? [])];
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (index) writer.text(" | ");
      writeInline(writer, cell.tokens, cell.text);
    });
    writer.text("\n");
  }
  writer.text("\n");
}

function writeInline(
  writer: HtmlChunks,
  tokens?: MarkdownToken[],
  fallback?: string,
) {
  if (!tokens?.length) {
    if (fallback) writer.text(decodeEntities(fallback));
    return;
  }
  for (const token of tokens) {
    const tag =
      token.type === "strong"
        ? "b"
        : token.type === "em"
          ? "i"
          : token.type === "del"
            ? "s"
            : null;
    if (tag) {
      writer.open(tag);
      writeInline(writer, token.tokens, token.text);
      writer.close(tag);
    } else if (token.type === "codespan") {
      writer.withoutFormatting(() => {
        writer.open("code");
        writer.text(token.text ?? "");
        writer.close("code");
      });
    } else if (token.type === "link") {
      const href = safeHref(token.href);
      if (!href) writer.text(decodeEntities(token.raw ?? token.text ?? ""));
      else {
        writer.open("a", ` href="${escapeAttribute(href)}"`);
        // Telegram forbids nested non-formatting entities; keep link labels plain.
        writer.text(plainText(token.tokens, token.text ?? ""));
        writer.close("a");
      }
    } else if (token.type === "image") {
      writer.text(decodeEntities(token.text ?? ""));
    } else if (token.type === "br") {
      writer.text("\n");
    } else if (token.type === "escape") {
      writer.text(token.text ?? token.raw ?? "");
    } else if (token.type === "html") {
      writer.text(token.raw ?? token.text ?? "");
    } else if (token.tokens?.length) {
      writeInline(writer, token.tokens, token.text);
    } else {
      writer.text(decodeEntities(token.text ?? token.raw ?? ""));
    }
  }
}

function plainText(
  tokens: MarkdownToken[] | undefined,
  fallback: string,
): string {
  if (!tokens?.length) return decodeEntities(fallback);
  return tokens
    .map((token) => {
      if (token.type === "image") return decodeEntities(token.text ?? "");
      if (token.type === "escape") return token.text ?? token.raw ?? "";
      if (token.tokens?.length)
        return plainText(token.tokens, token.text ?? "");
      return decodeEntities(token.text ?? token.raw ?? "");
    })
    .join("");
}

function safeHref(value: string | undefined) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function decodeEntities(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi,
    (entity) => {
      const named: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const value = entity.slice(2, -1);
      const point =
        value[0]?.toLowerCase() === "x"
          ? Number.parseInt(value.slice(1), 16)
          : Number.parseInt(value, 10);
      return Number.isInteger(point) &&
        point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "\ufffd";
    },
  );
}

function escapeText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeText(value);
}
