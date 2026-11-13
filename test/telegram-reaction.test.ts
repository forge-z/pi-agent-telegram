import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { TelegramApiError, type TelegramApi } from "../src/telegram-api.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramUpdate } from "../src/telegram.js";

const config = {
  token: "123:synthetic-only",
  users: ["42"],
  chats: ["-100123"],
};

function message(
  updateId: number,
  messageId: number,
  text: string,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      text,
      from: { id: 42, is_bot: false },
      chat: { id: -100123, type: "supergroup" },
      date: 1000 + updateId,
    },
  };
}

test("an accepted message gets one eyes reaction, and a failed reaction still handles it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-reaction-"));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const reactions: Record<string, unknown>[] = [];
  let hold: Promise<void> | undefined;
  let releaseHold = () => {};
  const debug = t.mock.method(console, "debug", () => {});
  const api = {
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      if (method !== "setMessageReaction") return {};
      reactions.push(payload);
      if (!hold) return true;
      await hold;
      throw new TelegramApiError("unavailable");
    },
  };
  const app = await Runtime.open({
    dir,
    models,
    gateway: { catalog: async () => [] },
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  const polling = new TelegramPolling(
    app,
    api as unknown as TelegramApi,
    config,
    { id: 123 },
  );
  const textOf = (requestId: string) =>
    app.store.get<{ conversationId: string; text: string }>(
      "SELECT conversationId, text FROM requests WHERE requestId=?",
      requestId,
    );
  try {
    const incoming = message(1, 10, "hello");
    await polling.engine.receive(incoming);
    const first = textOf("telegram:1");
    assert.equal(first?.text, "hello");
    await (await app.conversation(first!.conversationId)).waitForIdle(context);
    assert.equal(reactions.length, 1);
    assert.deepEqual(reactions[0], {
      chat_id: "-100123",
      message_id: 10,
      reaction: [{ type: "emoji", emoji: "👀" }],
    });

    await polling.engine.receive(incoming);
    await polling.engine.receive(message(2, 11, "/status"));
    assert.equal(reactions.length, 1);
    const queued = app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=?",
      "-100123",
    );
    assert.ok(queued.some((row) => row.text.startsWith("Models:")));

    hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const received = polling.engine.receive(message(3, 12, "still here"));
    const outcome = await Promise.race([
      received.then(
        () => "ok" as const,
        () => "threw" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 5000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, "ok");
    const second = textOf("telegram:3");
    assert.equal(second?.text, "still here");
    await (await app.conversation(second!.conversationId)).waitForIdle(context);
    assert.equal(reactions.length, 2);
    assert.deepEqual(reactions[1]?.reaction, [{ type: "emoji", emoji: "👀" }]);
    releaseHold();
    await delay(0);
    assert.ok(
      debug.mock.calls.some((call) =>
        String(call.arguments[0]).includes("setMessageReaction"),
      ),
    );
    assert.equal(reactions.length, 2);
  } finally {
    releaseHold();
    await polling.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
