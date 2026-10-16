import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/runtime.js";

function linkChat(
  app: Runtime,
  chat: string,
  user: string,
  conversationId: string,
) {
  app.store.run(
    "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
    chat,
    conversationId,
    user,
  );
  app.store.run(
    "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
    chat,
    user,
    conversationId,
  );
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-sidebar-"));
  const options = { dir, gateway: { call: async () => ({}) } };
  let app = await Runtime.open(options);
  const webId = await app.create("Legacy web history");
  linkChat(app, "42", "7", webId);
  const dedicatedId = await app.create("Dedicated Telegram conversation", {
    chat: "42",
    user: "7",
  });
  return {
    get app() {
      return app;
    },
    webId,
    dedicatedId,
    async restart() {
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function channels(app: Runtime, deleted = false) {
  return app
    .listConversations(deleted)
    .map(({ id, channel, telegramLinked }) => ({
      id,
      channel,
      telegramLinked,
    }));
}

test("sidebar includes dedicated Telegram chats and marks origin rather than legacy web/cron links", async () => {
  const f = await fixture();
  try {
    const titledId = await f.app.create("Telegram in the title only");
    const schedule = await f.app.tasks.create({
      title: "Web cron",
      prompt: "Synthetic schedule",
      conversationId: f.webId,
      kind: "once",
      schedule: "2099-01-01T00:00:00Z",
      timezone: "Etc/UTC",
      delivery: "web",
    });
    f.app.store.run(
      "INSERT INTO meta VALUES ('telegram:connection',?)",
      JSON.stringify({
        enabled: true,
        bot: { id: 123 },
        userId: "7",
        chatId: "42",
        conversationId: f.webId,
      }),
    );
    f.app.store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ token: "123:synthetic-fixture", botId: 123 }),
    );
    assert.deepEqual(channels(f.app), [
      { id: titledId, channel: "web", telegramLinked: false },
      { id: f.dedicatedId, channel: "telegram", telegramLinked: true },
      { id: f.webId, channel: "web", telegramLinked: false },
    ]);
    assert.equal(
      f.app.tasks.list().find((task) => task.id === schedule.id)
        ?.conversationId,
      f.webId,
    );
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='42'",
      )?.conversationId,
      f.webId,
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.webId,
      ),
    );
    assert.ok(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.dedicatedId,
      ),
    );
    for (const row of f.app.listConversations())
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "channel",
          "deletedAt",
          "id",
          "purgeAt",
          "telegramLinked",
          "title",
        ].sort(),
      );
  } finally {
    await f.close();
  }
});

test("all Telegram origins remain visible across selection, disconnect, revoke and restart", async () => {
  const f = await fixture();
  try {
    const secondId = await f.app.create("Second Telegram", {
      chat: "42",
      user: "7",
    });
    const foreignAnchor = await f.app.create("Other web binding");
    linkChat(f.app, "100", "99", foreignAnchor);
    const foreignId = await f.app.create("Other Telegram origin", {
      chat: "100",
      user: "99",
    });
    f.app.telegramChats.select(f.dedicatedId, { chat: "42", user: "7" });
    const before = channels(f.app);
    assert.equal(before.length, 5);
    assert.deepEqual(
      before.filter((row) => row.channel === "telegram").map((row) => row.id),
      [foreignId, secondId, f.dedicatedId],
    );
    f.app.telegramChats.select(secondId, { chat: "42", user: "7" });
    assert.deepEqual(channels(f.app), before);
    f.app.store.run(
      "INSERT INTO meta VALUES ('telegram:connection',?)",
      JSON.stringify({
        enabled: false,
        bot: { id: 123 },
        userId: "7",
        chatId: "42",
        conversationId: f.webId,
      }),
    );
    f.app.store.run("DELETE FROM telegram");
    f.app.store.run("DELETE FROM telegram_grants");
    assert.deepEqual(channels(f.app), before);
    f.app.store.run(
      "UPDATE meta SET value='malformed synthetic configuration' WHERE key='telegram:connection'",
    );
    assert.deepEqual(channels(f.app), before);
    await f.restart();
    assert.deepEqual(channels(f.app), before);
    assert.equal(
      (
        await f.app.renameConversation(
          f.dedicatedId,
          "Renamed web-looking title",
        )
      ).id,
      f.dedicatedId,
    );
    assert.equal(
      channels(f.app).find((row) => row.id === f.dedicatedId)?.channel,
      "telegram",
    );
  } finally {
    await f.close();
  }
});

test("Telegram origin persists in trash and after restore while purged IDs stay hidden", async () => {
  const f = await fixture();
  try {
    const archived = await f.app.deleteConversation(f.dedicatedId);
    assert.deepEqual(channels(f.app), [
      { id: f.webId, channel: "web", telegramLinked: false },
    ]);
    assert.deepEqual(channels(f.app, true), [
      { id: f.dedicatedId, channel: "telegram", telegramLinked: true },
    ]);
    assert.equal(f.app.listConversations(true)[0].purgeAt, archived.purgeAt);
    await f.restart();
    assert.deepEqual(channels(f.app, true), [
      { id: f.dedicatedId, channel: "telegram", telegramLinked: true },
    ]);
    f.app.restoreConversation(f.dedicatedId);
    assert.deepEqual(channels(f.app), [
      { id: f.dedicatedId, channel: "telegram", telegramLinked: true },
      { id: f.webId, channel: "web", telegramLinked: false },
    ]);
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        f.dedicatedId,
      ),
      undefined,
    );
    const rearchived = await f.app.deleteConversation(f.dedicatedId);
    await f.app.purgeConversation(f.dedicatedId, true, rearchived.deletedAt);
    assert.deepEqual(channels(f.app, true), []);
    assert.deepEqual(channels(f.app), [
      { id: f.webId, channel: "web", telegramLinked: false },
    ]);
    await f.restart();
    assert.deepEqual(channels(f.app), [
      { id: f.webId, channel: "web", telegramLinked: false },
    ]);
  } finally {
    await f.close();
  }
});
