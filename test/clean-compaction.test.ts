import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";

test("upstream automatic compaction uses active conversation model/effort, preserves transcript and isolates topics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-clean-compact-"));
  const faux = fauxProvider({
    models: [
      { id: "initial", reasoning: true, contextWindow: 40000, maxTokens: 8192 },
      { id: "active", reasoning: true, contextWindow: 40000, maxTokens: 8192 },
    ],
  });
  const observed: { summary: boolean; model: string; effort: unknown }[] = [];
  faux.setResponses(
    Array.from(
      { length: 30 },
      () => async (transcript, opts, _state, model) => {
        const summary = JSON.stringify(transcript).includes(
          "context summarization assistant",
        );
        observed.push({ summary, model: model.id, effort: opts?.reasoning });
        return fauxAssistantMessage(
          summary
            ? "Mock checkpoint: preserve original goal."
            : "mock response",
        );
      },
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({}) },
    modelId: "initial",
    telegramOnly: true,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "123:synthetic", users: ["42"], chats: ["-100123"] },
        { id: 123 },
      ),
  });
  try {
    const first = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 11,
    });
    const second = await app.telegramChats.ensure({
      chat: "-100123",
      user: "42",
      messageThreadId: 22,
    });
    await app.settings.saveConversation(first, {
      provider: "faux",
      modelId: "active",
      effort: "low",
    });
    for (let n = 0; n < 7; n++) {
      await app.admit(
        first,
        `large-${n}`,
        `Entry ${n}: ${"unique-context ".repeat(1900)}`,
        {
          source: "telegram",
          chat: "-100123",
          user: "42",
          messageThreadId: 11,
        },
      );
      await (await app.conversation(first)).waitForIdle(context);
    }
    const summaries = observed.filter((row) => row.summary);
    assert.ok(
      summaries.length > 0,
      "automatic summary must actually run with unmodified upstream thresholds",
    );
    assert.ok(
      summaries.every((row) => row.model === "active" && row.effort === "low"),
    );
    assert.equal(
      observed.some((row) => row.model === "initial"),
      false,
    );
    assert.equal((await app.snapshot(second)).view.entries.length, 0);
    const entries = (
      await (
        await app.conversation(first)
      ).entries({}, 1000, undefined, context)
    ).items;
    assert.ok(entries.length >= 14, "original transcript retained");
    assert.equal((await app.settings.conversation(first)).modelId, "active");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
