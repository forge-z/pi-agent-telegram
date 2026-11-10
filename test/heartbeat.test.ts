import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LongCallHeartbeat,
  longCallRoute,
  longCallText,
  type LongCallState,
} from "../src/heartbeat.js";
import { Store } from "../src/store.js";
import { configureTelegram } from "../src/telegram-polling.js";

const start = Date.parse("2026-10-08T12:00:00Z");

function fakeTransport() {
  const sent: {
    chat: string;
    text: string;
    messageThreadId?: number;
  }[] = [];
  const edits: { chat: string; messageId: number; text: string }[] = [];
  const deleted: number[] = [];
  return {
    sent,
    edits,
    deleted,
    send: async (
      chat: string,
      text: string,
      options: { messageThreadId?: number },
    ) => {
      sent.push({ chat, text, ...options });
      return { message_id: 500 + sent.length };
    },
    edit: async (chat: string, messageId: number, text: string) => {
      edits.push({ chat, messageId, text });
    },
    delete: async (_chat: string, messageId: number) => {
      deleted.push(messageId);
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

test("long call: nothing under 60s, then one message edited every 3 min", async (t) => {
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: start,
  });
  const transport = fakeTransport();
  const heartbeat = new LongCallHeartbeat(transport);
  const state = (): LongCallState => ({ startedAt: start });
  const stop = heartbeat.start("c1", { chat: "42" }, state);

  t.mock.timers.tick(59_000);
  await settle();
  assert.equal(transport.sent.length, 0);

  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].text, longCallText(60_000));
  assert.match(transport.sent[0].text, /^still running \(1 min\)…$/);
  assert.equal(transport.sent[0].chat, "42");

  t.mock.timers.tick(180_000);
  await settle();
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.edits.length, 1);
  assert.equal(transport.edits[0].messageId, 501);
  assert.match(transport.edits[0].text, /^still running \(4 min\)…$/);

  t.mock.timers.tick(180_000);
  await settle();
  assert.equal(transport.edits.length, 2);
  assert.match(transport.edits[1].text, /^still running \(7 min\)…$/);

  stop();
  heartbeat.close();
});

test("long call: shows the last progress message the server sent", async (t) => {
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: start,
  });
  const transport = fakeTransport();
  const heartbeat = new LongCallHeartbeat(transport);
  let progress = "baixando 10%";
  const stop = heartbeat.start("c1", { chat: "42" }, () => ({
    startedAt: start,
    progress,
  }));

  t.mock.timers.tick(60_000);
  await settle();
  assert.match(transport.sent[0].text, /\nbaixando 10%$/);

  progress = "baixando 80%";
  t.mock.timers.tick(180_000);
  await settle();
  assert.match(transport.edits[0].text, /\(4 min\)…\nbaixando 80%$/);

  stop();
  heartbeat.close();
});

test("long call: cleanup when the call finishes or the probe fails", async (t) => {
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: start,
  });
  const transport = fakeTransport();
  const heartbeat = new LongCallHeartbeat(transport);
  let state: LongCallState | undefined = { startedAt: start };
  const stop = heartbeat.start("c1", { chat: "42" }, () => state);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(transport.sent.length, 1);

  // The tool returned: the stop callback runs in the tool's finally.
  stop();
  await settle();
  assert.deepEqual(transport.deleted, [501]);

  // A probe that throws cleans up too instead of leaving the message behind.
  const other = fakeTransport();
  const second = new LongCallHeartbeat(other);
  second.start("c2", { chat: "42" }, () => state);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(other.sent.length, 1);
  state = undefined;
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(other.deleted, [501]);
  second.close();
  heartbeat.close();
});

test("long call: a refused status is attempted once, never every tick", async (t) => {
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: start,
  });
  let attempts = 0;
  const heartbeat = new LongCallHeartbeat({
    send: async () => {
      attempts++;
      throw new Error("telegram down");
    },
    edit: async () => {},
  });
  heartbeat.start("c1", { chat: "42" }, () => ({ startedAt: start }));

  t.mock.timers.tick(60_000);
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(attempts, 1);
  heartbeat.close();
});

test("long call: scheduled and job runs never get a heartbeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-heartbeat-"));
  const store = new Store(dir);
  try {
    configureTelegram(
      store,
      { token: "123:synthetic-only", users: ["42"], chats: ["42"] },
      { id: 123 },
    );
    const id = "1001";
    store.run("INSERT INTO conversations VALUES (?,?)", id, "Conversa");
    store.run("INSERT INTO telegram VALUES (?,?,?)", "42", id, "42");
    store.run("INSERT INTO telegram_grants VALUES (?,?,?)", "42", "42", id);
    store.run("INSERT INTO telegram_topic_conversations VALUES (?,?)", id, 7);
    const request = (requestId: string, source: string) =>
      store.run(
        "INSERT INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,?,?)",
        id,
        requestId,
        "oi",
        source,
        "42",
      );

    request("r1", "task");
    assert.equal(longCallRoute(store, id), undefined);
    request("r2", "job");
    assert.equal(longCallRoute(store, id), undefined);
    request("r3", "system");
    assert.equal(longCallRoute(store, id), undefined);

    request("r4", "telegram");
    assert.deepEqual(longCallRoute(store, id), {
      chat: "42",
      messageThreadId: 7,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
