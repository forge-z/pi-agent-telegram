import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTelegramMessage } from "../src/telegram-format.js";

test("formats Markdown with Telegram-supported HTML and plain-text lists", () => {
  const chunks = formatTelegramMessage(
    '# Heading\n\nA & <B>\n\n**bold _both_** and *italic* with `inline <code>`.\n\n- first\n- **second**\n  - nested\n\n```ts\nif (a < b) return "&";\n```',
  );
  const output = chunks.join("");
  assert.match(output, /<b>Heading<\/b>/);
  assert.match(output, /A &amp; &lt;B&gt;/);
  assert.match(output, /<b>bold <i>both<\/i><\/b>/);
  assert.match(output, /<i>italic<\/i>/);
  assert.match(output, /<code>inline &lt;code&gt;<\/code>/);
  assert.match(output, /• first\n• <b>second<\/b>\n  • nested/);
  assert.match(
    output,
    /<pre><code>if \(a &lt; b\) return &quot;&amp;&quot;;<\/code><\/pre>/,
  );
  assertValidChunks(chunks);
});

test("turns raw HTML into inert text and never emits remote images or unsafe links", () => {
  const chunks = formatTelegramMessage(
    '<img src="https://evil.example/x" onerror="alert(1)"> ![remote](https://evil.example/image.png) [safe](https://example.com/a_(b)?x=1&y=2) [javascript](javascript:alert(1)) [data](data:text/html,x) [auth](https://user:pass@example.com/)',
  );
  const output = chunks.join("");
  assert.match(output, /&lt;img src=&quot;https:\/\/evil\.example\/x&quot;/);
  assert.match(output, / remote /);
  assert.match(
    output,
    /<a href="https:\/\/example\.com\/a_\(b\)\?x=1&amp;y=2">safe<\/a>/,
  );
  assert.doesNotMatch(output, /<img\b/i);
  assert.doesNotMatch(output, /<a href="(?:javascript|data):/i);
  assert.doesNotMatch(output, /<a href="https:\/\/[^\"]*@/i);
  assertValidChunks(chunks);
});

test("splits long inline formatting with balanced reopened tags under 3800 visible chars", () => {
  const source = `${"x".repeat(3797)} **bold${"y".repeat(25)}** end`;
  const chunks = formatTelegramMessage(source);
  assert.ok(chunks.length > 1);
  assert.match(chunks[0], /<b>bo<\/b>$/);
  assert.match(chunks[1], /^<b>ld/);
  assertValidChunks(chunks);
});

test("keeps code outside style tags and drops whitespace-only trailing chunks", () => {
  const inline = formatTelegramMessage("**bold `code` after**");
  assert.match(
    inline.join(""),
    /<b>bold <\/b><code>code<\/code><b> after<\/b>/,
  );
  assertValidChunks(inline);

  const exactLimit = formatTelegramMessage("x".repeat(3800));
  assert.equal(exactLimit.length, 1);
  assert.equal(assertValidChunks(exactLimit).visible, "x".repeat(3800));

  const multiChunk = formatTelegramMessage("x".repeat(3800) + "y");
  assert.ok(multiChunk.length > 1);
  assert.ok(multiChunk.every((chunk) => chunk.replace(/<[^>]*>/g, "").trim()));
  assert.equal(
    assertValidChunks(multiChunk).visible,
    "x".repeat(3800) + "y\n\n",
  );
});

test("splits fenced code, long links, and lists without breaking entities or surrogate pairs", () => {
  const source = [
    "```js",
    ...Array.from({ length: 90 }, () => 'const item = "< & 😀";'),
    "```",
    "",
    `- [long](${"https://example.com/"}${"a".repeat(1400)}?x=1&y=2) ${"z".repeat(2600)}`,
    `- final ${"🙂".repeat(2000)}`,
  ].join("\n");
  const chunks = formatTelegramMessage(source);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.some((chunk) => chunk.includes("<pre><code>")));
  const parsed = assertValidChunks(chunks);
  assert.ok(parsed.visible.includes('const item = "< & 😀";'));
  assert.ok(parsed.visible.includes("• final "));
  assert.equal(hasUnpairedSurrogate(parsed.visible), false);
});

function assertValidChunks(chunks: string[], limit = 3800) {
  const visible: string[] = [];
  for (const chunk of chunks) {
    const stack: string[] = [];
    let text = "";
    for (let index = 0; index < chunk.length;) {
      const rest = chunk.slice(index);
      if (rest.startsWith("<")) {
        const tag = rest.match(
          /^<(\/)?(b|i|s|code|pre|a)(?: href="([^"]*)")?>/,
        );
        assert.ok(tag, `unexpected or malformed HTML: ${rest.slice(0, 40)}`);
        if (tag[1]) assert.equal(stack.pop(), tag[2]);
        else {
          if (tag[2] === "code" || tag[2] === "pre")
            assert.ok(!stack.some((name) => ["b", "i", "s"].includes(name)));
          stack.push(tag[2]);
          if (tag[2] === "a")
            assert.match(decodeEntities(tag[3] ?? ""), /^https?:\/\//);
        }
        index += tag[0].length;
        continue;
      }
      if (rest.startsWith("&")) {
        const entity = rest.match(/^&(amp|lt|gt|quot|#39|#\d+|#x[\da-f]+);/i);
        assert.ok(
          entity,
          `HTML entity split or unescaped: ${rest.slice(0, 20)}`,
        );
        text += decodeEntities(entity[0]);
        index += entity[0].length;
        continue;
      }
      const codePoint = chunk.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      text += character;
      index += character.length;
    }
    assert.deepEqual(
      stack,
      [],
      `unbalanced tags in chunk: ${chunk.slice(-60)}`,
    );
    assert.ok(
      [...text].length <= limit,
      `visible chunk exceeds limit: ${[...text].length}`,
    );
    assert.ok(
      text.length <= limit,
      `UTF-16 chunk exceeds limit: ${text.length}`,
    );
    visible.push(text);
  }
  const result = visible.join("");
  assert.equal(hasUnpairedSurrogate(result), false);
  return { visible: result };
}

function decodeEntities(value: string) {
  return value.replace(/&(amp|lt|gt|quot|#39|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
    };
    const lowered = entity.toLowerCase();
    if (named[lowered]) return named[lowered];
    const body = entity.slice(2, -1);
    const point =
      body[0]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(1), 16)
        : Number.parseInt(body, 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity;
  });
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

test("web mirror labels fit every HTML chunk and preserve all body characters and formatting", () => {
  const source = "**Bold** & <literal> 😀 ".repeat(500);
  const plain = assertValidChunks(formatTelegramMessage(source)).visible;
  for (const role of ["web_user", "web_assistant"] as const) {
    const chunks = formatTelegramMessage(source, role);
    assert.ok(chunks.length > 1);
    const withoutLabels = chunks.map((chunk) => {
      assert.match(
        chunk,
        /^<b>(?:👤 Você · via web|🤖 Agente · resposta à web) · \d+\/\d+<\/b>\n\n/,
      );
      return chunk.replace(/^<b>[^<]+<\/b>\n\n/, "");
    });
    assertValidChunks(chunks, 4096);
    assert.equal(assertValidChunks(withoutLabels).visible, plain);
  }
});
