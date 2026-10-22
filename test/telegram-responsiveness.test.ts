import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../src/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramApi } from "../src/telegram-api.js";
import type { TelegramUpdate } from "../src/telegram.js";

const config = {
  token: "123:synthetic-only",
  users: ["42", "43"],
  chats: ["-100123", "-100456"],
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-resp-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const options = {
    dir,
    models,
    gateway: { call: async () => ({}) },
    telegramOnly: true,
    initialize: (store: Runtime["store"]) =>
      configureTelegram(store, config, { id: 123 }),
  };
  const app = await Runtime.open(options);
  return {
    dir,
    app,
    options,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean, maxAttempts = 300) {
  for (let n = 0; n < maxAttempts; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check());
}

test("responde aviso de pedido em andamento quando turno está ocupado (sem spam e não para comandos)", async () => {
  const f = await fixture();
  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);

    // Simula tool em andamento há mais de 10s
    const startTime = Date.now() - 15_000;
    (
      f.app as unknown as { activeToolStarts: Map<string, number> }
    ).activeToolStarts.set(convId, startTime);

    assert.equal(f.app.isTurnBusyWithTool(convId), true);

    const polling = new TelegramPolling(
      f.app,
      {
        call: async () => ({}),
      } as unknown as TelegramApi,
      config,
      { id: 123 },
    );

    // Mensagem de texto normal recebida
    await polling.engine.receive({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "Outro pedido",
        date: 1000,
      },
    });

    // Deve ter enfileirado a mensagem de aviso nas deliveries
    const deliveries = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    assert.ok(
      deliveries.some((d) =>
        d.text.includes(
          "Recebi, vou considerar no que estou fazendo. /stop cancela.",
        ),
      ),
      "aviso enviado ao usuário",
    );

    const countBefore = deliveries.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(countBefore, 1);

    // Segunda mensagem durante a mesma ferramenta ocupada NÃO duplica aviso (sem spam)
    await polling.engine.receive({
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "Mais uma pergunta",
        date: 1001,
      },
    });

    const deliveriesAfter = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const countAfter = deliveriesAfter.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(countAfter, 1, "não repete aviso para a mesma ferramenta");

    // Mensagem que é um comando NÃO deve receber aviso de ocupado
    await polling.engine.receive({
      update_id: 3,
      message: {
        message_id: 12,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "/status",
        date: 1002,
      },
    });

    const deliveriesCmd = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const countCmd = deliveriesCmd.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(countCmd, 1, "comandos não disparam aviso de ocupado");

    await polling.close();
  } finally {
    await f.close();
  }
});

test("updates de chats diferentes rodam em paralelo e offset avança apenas de forma contígua", async () => {
  const f = await fixture();
  try {
    const executed: number[] = [];
    let resolveSlow: (() => void) | undefined;
    const slowPromise = new Promise<void>((r) => {
      resolveSlow = r;
    });

    const api: TelegramApi = {
      call: async (method, payload) => {
        if (method === "getWebhookInfo") return { url: "" };
        if (method === "setMyCommands") return true;
        if (method === "getUpdates") {
          const offset = (payload as { offset?: number })?.offset;
          if (offset === undefined || offset === 1) {
            return [
              {
                update_id: 1, // Chat A: lento
                message: {
                  message_id: 1,
                  from: { id: 42, is_bot: false },
                  chat: { id: -100123, type: "supergroup" },
                  text: "mensagem lenta no chat A",
                  date: 100,
                },
              },
              {
                update_id: 2, // Chat B: rápido
                message: {
                  message_id: 2,
                  from: { id: 43, is_bot: false },
                  chat: { id: -100456, type: "supergroup" },
                  text: "mensagem rápida no chat B",
                  date: 101,
                },
              },
              {
                update_id: 3, // Callback query
                callback_query: {
                  id: "cb_3",
                  from: { id: 43, is_bot: false },
                  data: JSON.stringify({ kind: "model", menu: "noop" }),
                },
              },
            ];
          }
          await new Promise((r) => setTimeout(r, 20));
          return [];
        }
        return {};
      },
    };

    const polling = new TelegramPolling(f.app, api, config, { id: 123 });

    // Mock engine.receive para simular update 1 lento e update 2/3 rápidos
    const origReceive = polling.engine.receive.bind(polling.engine);
    polling.engine.receive = async (
      update: TelegramUpdate,
      signal?: AbortSignal,
    ) => {
      if (update.update_id === 1) {
        await slowPromise;
      }
      executed.push(update.update_id);
      return origReceive(update, signal);
    };

    polling.start();

    // Update 2 e 3 devem completar antes do update 1 terminar
    await until(() => executed.includes(2) && executed.includes(3));
    assert.ok(!executed.includes(1), "update 1 ainda está em andamento");

    // O offset NÃO pode ter avançado para 3 ou 4 ainda, pois o update 1 não completou
    const offsetKey = "telegram:offset:123";
    const metaDuring = f.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      offsetKey,
    );
    assert.equal(metaDuring, undefined, "offset não avança sem completar o 1");

    // Agora resolve o update 1
    resolveSlow?.();
    await until(() => executed.includes(1));

    // Agora que 1 completou, o offset deve avançar para 4 (1, 2 e 3 todos completos)
    await until(() => {
      const row = f.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        offsetKey,
      );
      return row?.value === "4";
    });

    const metaAfter = f.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      offsetKey,
    );
    assert.equal(
      metaAfter?.value,
      "4",
      "offset avançou de forma contígua para 4",
    );

    await polling.close();
  } finally {
    await f.close();
  }
});
