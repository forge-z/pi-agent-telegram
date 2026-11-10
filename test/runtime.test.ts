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
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Runtime, assistantClock } from "../src/runtime.js";
import { Store, type Delivery } from "../src/store.js";
const gateway = { catalog: async () => [] };
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-agent-test-"));
}
function model(responses: FauxResponseStep[]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
async function wait(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("the clock defaults to America/Sao_Paulo and follows TZ", () => {
  const now = new Date("2026-11-09T18:00:00Z");
  const fallback = assistantClock({}, now);
  assert.match(fallback, /America\/Sao_Paulo/);
  assert.match(fallback, /November 9, 2026/);
  assert.match(fallback, /15:00/);
  assert.match(fallback, /tomorrow/);
  const utc = assistantClock({ TZ: "UTC" }, now);
  assert.match(utc, /\(UTC\)/);
  assert.match(utc, /18:00/);
  assert.match(assistantClock({ TZ: "Not/AZone" }, now), /America\/Sao_Paulo/);
});

test("each turn's system prompt includes that turn's clock", async () => {
  const dir = await temp();
  const { models } = model([fauxAssistantMessage("ok")]);
  const app = await Runtime.open({
    dir,
    gateway,
    models,
    env: { TZ: "UTC" },
    now: () => Date.parse("2026-11-09T18:04:00Z"),
  });
  try {
    const found = (
      app as unknown as {
        registry: {
          snapshot: () => {
            extension: (name: string) => {
              sections?: {
                key: string;
                render: (...args: unknown[]) => Promise<string> | string;
              }[];
            };
          };
        };
      }
    ).registry
      .snapshot()
      .extension("personal-assistant")
      ?.sections?.find((item) => item.key === "now");
    const text = await found?.render(undefined, undefined);
    assert.match(text ?? "", /Current date and time/);
    assert.match(text ?? "", /November 9, 2026/);
    assert.match(text ?? "", /18:04/);
    assert.match(text ?? "", /\(UTC\)/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Durable assistant answers persist formatted Telegram chunks before delivery and deduplicate after restart", async () => {
  const dir = await temp();
  const answer = `# Resumo\n\n**${"conteúdo & < > ".repeat(700)}**\n\n[Site](https://example.com)\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
  const { models, faux } = model([fauxAssistantMessage(answer)]);
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    await app.submit(id, "formatted", "resuma", "telegram", "42");
    await wait(app, id);
    const rows = app.store.all<Delivery>(
      "SELECT * FROM deliveries ORDER BY rowid",
    );
    assert.ok(rows.length > 2);
    assert.ok(rows.every((row) => row.parseMode === "HTML"));
    assert.match(rows[0].text, /<b>Resumo<\/b>/);
    assert.match(rows[0].text, /&amp; &lt; &gt;/);
    assert.match(rows.at(-1)!.text, /<pre><code>const x = 1;<\/code><\/pre>/);
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    await app.submit(id, "formatted", "resuma", "telegram", "42");
    await wait(app, id);
    assert.deepEqual(
      app.store.all<Delivery>("SELECT * FROM deliveries ORDER BY rowid"),
      rows,
    );
    assert.equal(faux.state.callCount, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent web/Telegram inputs serialize and same requestId deduplicates across reopen", async () => {
  const dir = await temp();
  const { models, faux } = model(
    Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`answer-${i}`)),
  );
  let app = await Runtime.open({ dir, gateway, models });
  try {
    const id = await app.create();
    const replies = await Promise.all([
      app.submit(id, "one", "first"),
      app.submit(id, "two", "second", "telegram", "123"),
      app.submit(id, "one", "first"),
    ]);
    assert.equal(replies[0].submissionId, replies[2].submissionId);
    await wait(app, id);
    assert.equal(faux.state.callCount, 2);
    await assert.rejects(
      app.submit(id, "one", "changed"),
      /conteúdo diferente/,
    );
    const before = await app.snapshot(id);
    assert.equal(
      before.view.entries.filter((e) => e.kind === "pi.user").length,
      2,
    );
    await app.close();
    app = await Runtime.open({ dir, gateway, models });
    const retried = await app.submit(id, "one", "first");
    assert.equal(retried.submissionId, replies[0].submissionId);
    assert.equal(
      (await app.snapshot(id)).view.entries.filter((e) => e.kind === "pi.user")
        .length,
      2,
    );
    assert.equal(app.store.all("SELECT * FROM deliveries").length, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted in-flight actions and deliveries become uncertain, owner lock rejects second process", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, gateway });
  try {
    await assert.rejects(Runtime.open({ dir, gateway }), /already being held/);
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('a','1','mock','write','{}','running')",
    );
    app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES ('a','100','hello','sending')",
    );
    await app.close();
    const store = new Store(dir);
    try {
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM actions")?.state,
        "uncertain",
      );
      assert.equal(
        store.get<{ state: string }>("SELECT state FROM deliveries")?.state,
        "uncertain",
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
