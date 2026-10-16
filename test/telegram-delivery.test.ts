import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Delivery } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { Telegram, TelegramHttp } from "../src/telegram.js";

test("delivery migration preserves legacy chunks and uncertainty while new queues are atomic HTML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-delivery-migration-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  db.exec(
    "CREATE TABLE deliveries(id TEXT PRIMARY KEY,chat TEXT,text TEXT,state TEXT DEFAULT 'pending',result TEXT)",
  );
  const text = `**${"x".repeat(7400)}**`;
  db.prepare("INSERT INTO deliveries(id,chat,text,state) VALUES (?,?,?,?)").run(
    "old:0",
    "42",
    text.slice(0, 3500),
    "sending",
  );
  db.close();
  const store = new Store(dir);
  try {
    store.queueTelegram("old", "42", text);
    const old = store.all<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'old:%' ORDER BY rowid",
    );
    assert.equal(old.length, 3);
    assert.equal(old.map((row) => row.text).join(""), text);
    assert.equal(old[0].state, "uncertain");
    assert.ok(old.every((row) => row.parseMode === null));
    store.queueTelegram("new", "42", text);
    store.queueTelegram("new", "42", text);
    const fresh = store.all<Delivery>(
      "SELECT * FROM deliveries WHERE id LIKE 'new:%' ORDER BY rowid",
    );
    assert.equal(fresh.length, 2);
    assert.ok(
      fresh.every(
        (row) => row.parseMode === "HTML" && /^<b>.*<\/b>/s.test(row.text),
      ),
    );
    store.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries WHEN NEW.id='fail:1' BEGIN SELECT RAISE(ABORT,'mock disk error'); END",
    );
    assert.throws(
      () => store.queueTelegram("fail", "42", text),
      /mock disk error/,
    );
    assert.equal(
      store.all("SELECT * FROM deliveries WHERE id LIKE 'fail:%'").length,
      0,
    );
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTML delivery errors never trigger plain-text fallback or resend after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-html-delivery-"));
  let app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { call: async () => ({}) },
  });
  const sent: { text: string; mode: unknown }[] = [];
  const transport = {
    send: async (
      _chat: string,
      text: string,
      options?: { parseMode?: "HTML" },
    ) => {
      sent.push({ text, mode: options?.parseMode });
      throw new Error("mock parse error or unknown outcome");
    },
  };
  let telegram = new Telegram(app, transport, ["42"], ["42"]);
  try {
    app.store.queueTelegram(
      "formatted",
      "42",
      "**Olá** <script> & `const x = 1`\n\n- item",
    );
    await telegram.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "HTML");
    assert.match(sent[0].text, /<b>Olá<\/b>/);
    assert.match(sent[0].text, /&lt;script&gt; &amp;/);
    assert.match(sent[0].text, /<code>const x = 1<\/code>/);
    assert.equal(
      app.store.get<Delivery>("SELECT * FROM deliveries")?.state,
      "uncertain",
    );
    await telegram.drain();
    await app.close();
    app = await Runtime.open({
      dir,
      mode: "demo",
      gateway: { call: async () => ({}) },
    });
    telegram = new Telegram(app, transport, ["42"], ["42"]);
    await telegram.flush();
    assert.equal(sent.length, 1);
  } finally {
    await telegram.drain();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP transport sends explicit HTML only for new formatted ledger payloads", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const http = new TelegramHttp("local_fake_no_network");
    await http.send("42", "<b>Olá</b>", { parseMode: "HTML" });
    await http.send("42", "**old plain text**");
    assert.equal(bodies[0].parse_mode, "HTML");
    assert.equal(bodies[0].text, "<b>Olá</b>");
    assert.equal(bodies[1].parse_mode, undefined);
    assert.equal(bodies[1].text, "**old plain text**");
  } finally {
    globalThis.fetch = original;
  }
});
