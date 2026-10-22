import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import { McpCalls } from "../src/mcp-calls.js";
import { configureTelegram, TelegramPolling } from "../src/telegram-polling.js";
import type { TelegramApi } from "../src/telegram-api.js";
import type { ImageContent } from "@earendil-works/pi-ai";

const config = {
  token: "123:synthetic-only",
  users: ["42", "43"],
  chats: ["-100123", "-100456"],
};

class Deferred<T = void> {
  promise: Promise<T>;
  resolve!: (val: T) => void;
  reject!: (err: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

async function fixture(
  responses: FauxResponseStep[],
  onCatalog?: () => Promise<unknown[]>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-steer-test-"));
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = {
    call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    catalog: onCatalog ?? (async () => []),
  };
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    telegramOnly: true,
    initialize: (store) => configureTelegram(store, config, { id: 123 }),
  });
  return {
    dir,
    app,
    faux,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function wait(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  await new Promise((r) => setTimeout(r, 30));
}

async function until(
  check: () => boolean | Promise<boolean>,
  maxAttempts = 300,
) {
  for (let n = 0; n < maxAttempts; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(await check());
}

test("Mensagem durante turno com ferramenta pendente vira steer e é vista pelo modelo na rodada seguinte, sem abrir turno novo", async () => {
  const barrier = new Deferred<void>();
  let steerSeenInTranscript = false;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      async (transcript) => {
        const steer = transcript.messages.find(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("mensagem steer adicional"),
        );
        if (steer) steerSeenInTranscript = true;
        return fauxAssistantMessage("Resposta unificada com steer.");
      },
    ],
    async () => {
      await barrier.promise;
      return [];
    },
  );

  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);

    // Inicia turno inicial
    void f.app.submit(convId, "req-1", "pedido inicial", "telegram", "-100123");

    // Espera o turno ficar ocupado com a tool
    await until(() => f.app.isTurnBusy(convId));

    // Envia mensagem durante o turno ocupado (deve virar steer)
    await f.app.submit(
      convId,
      "req-2",
      "mensagem steer adicional",
      "telegram",
      "-100123",
    );

    // Libera a tool para concluir a rodada
    barrier.resolve();

    await wait(f.app, convId);

    assert.ok(steerSeenInTranscript, "mensagem steer foi vista pelo modelo");

    const snapshot = await f.app.snapshot(convId);
    const assistants = snapshot.view.entries.filter(
      (e) => e.kind === "pi.assistant",
    );
    // Na mesma execução: 1 assistant entry da tool call + 1 assistant entry da resposta final
    assert.equal(
      assistants.length,
      2,
      "apenas 1 rodada completa de resposta (sem abrir turno novo)",
    );
    // A última mensagem do assistente incorpora o resultado
    const lastAssistant = assistants[1];
    const content = lastAssistant.model?.[0]?.content;
    const firstPart = Array.isArray(content) ? content[0] : undefined;
    const text = firstPart && "text" in firstPart ? firstPart.text : content;
    assert.equal(text, "Resposta unificada com steer.");

    // Verifica que a resposta final foi entregue apenas uma vez
    const deliveries = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? AND text LIKE '%Resposta unificada%'",
      "-100123",
    );
    assert.equal(deliveries.length, 1, "resposta entregue exatamente uma vez");
  } finally {
    await f.close();
  }
});

test("Sem turno ativo, mensagem abre turno novo como hoje", async () => {
  const f = await fixture([
    fauxAssistantMessage("Resposta 1"),
    fauxAssistantMessage("Resposta 2"),
  ]);

  try {
    const id = await f.app.create();

    await f.app.submit(id, "req-1", "mensagem 1");
    await wait(f.app, id);

    await f.app.submit(id, "req-2", "mensagem 2");
    await wait(f.app, id);

    const snapshot = await f.app.snapshot(id);
    const assistants = snapshot.view.entries.filter(
      (e) => e.kind === "pi.assistant",
    );
    assert.equal(
      assistants.length,
      2,
      "duas respostas do assistente em turnos separados",
    );
  } finally {
    await f.close();
  }
});

test("/stop durante turno continua interrompendo; outros comandos não viram steer", async () => {
  const barrier = new Deferred<void>();
  let commandSeenInTranscript = false;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      async (transcript) => {
        const cmd = transcript.messages.find(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("/model"),
        );
        if (cmd) commandSeenInTranscript = true;
        return fauxAssistantMessage("Concluído.");
      },
      fauxAssistantMessage("Turno após stop"),
    ],
    async () => {
      await barrier.promise;
      return [];
    },
  );

  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);

    // Teste 1: /stop interrompe MCP / chamadas pendentes
    f.app.mcpCalls = new McpCalls(f.app.store, new McpGateway([]));
    f.app.store.run(
      "INSERT INTO mcp_interactions(id,conversationId,callId,server,kind,payload,state) VALUES ('i1',?,'c1','srv','act','{}','pending')",
      convId,
    );
    assert.equal(
      f.app.mcpCalls.interactions(convId).some((i) => i.state === "pending"),
      true,
    );
    // /stop cancela
    f.app.mcpCalls.cancelConversation(convId);
    assert.equal(
      f.app.mcpCalls.interactions(convId).some((i) => i.state === "pending"),
      false,
      "MCP pendente cancelado por /stop",
    );

    // Teste 2: comando /model durante tool não vira steer
    void f.app.submit(
      convId,
      "req-cmd-1",
      "inicia tool",
      "telegram",
      "-100123",
    );
    await until(() => f.app.isTurnBusy(convId));

    // Envia comando /model
    await f.app.submit(convId, "req-cmd-2", "/model", "telegram", "-100123");

    barrier.resolve();
    await wait(f.app, convId);

    assert.equal(
      commandSeenInTranscript,
      false,
      "comando não entra como steer na rodada de ferramentas",
    );
  } finally {
    await f.close();
  }
});

test("Mensagem que chega depois da última rodada de ferramentas (modelo respondendo) não se perde: é processada como follow-up/turno novo", async () => {
  const modelStepBarrier = new Deferred<void>();

  const f = await fixture([
    async () => {
      await modelStepBarrier.promise;
      return fauxAssistantMessage("Resposta do primeiro turno");
    },
    fauxAssistantMessage("Resposta do segundo turno (follow-up)"),
  ]);

  try {
    const id = await f.app.create();

    // Inicia primeiro turno (sem tools, modelo gerando resposta)
    void f.app.submit(id, "req-1", "primeiro pedido");

    // Aguarda o turno estar ativo
    await until(() => f.app.isTurnBusy(id));

    // Envia segunda mensagem enquanto o modelo já está gerando a resposta
    void f.app.submit(id, "req-2", "segundo pedido enquanto respondia");

    // Libera a resposta do modelo para o primeiro turno
    modelStepBarrier.resolve();

    await wait(f.app, id);

    // As duas mensagens devem ter sido respondidas (nada perdido)
    const snapshot = await f.app.snapshot(id);
    const assistants = snapshot.view.entries.filter(
      (e) => e.kind === "pi.assistant",
    );
    assert.equal(
      assistants.length,
      2,
      "duas respostas completas: a segunda virou novo turno automaticamente",
    );
  } finally {
    await f.close();
  }
});

test("Foto com legenda e áudio transcrito durante turno viram steer com o conteúdo correto", async () => {
  const barrier = new Deferred<void>();
  let imageSeen = false;
  let audioSeen = false;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      async (transcript) => {
        for (const m of transcript.messages) {
          if (m.role === "user" && Array.isArray(m.content)) {
            const hasImage = m.content.some((part) => part.type === "image");
            const hasCaption = m.content.some(
              (part) =>
                part.type === "text" && part.text.includes("legenda foto"),
            );
            if (hasImage && hasCaption) imageSeen = true;
          }
          if (
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("audio transcrito aqui")
          ) {
            audioSeen = true;
          }
        }
        return fauxAssistantMessage("Recebido foto e audio");
      },
    ],
    async () => {
      await barrier.promise;
      return [];
    },
  );

  try {
    const id = await f.app.create();

    void f.app.submit(id, "req-1", "inicia turno com ferramenta");
    await until(() => f.app.isTurnBusy(id));

    // Envia foto com legenda como steer
    const fakeImage: ImageContent = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    await f.app.submit(
      id,
      "req-photo",
      "legenda foto",
      "web",
      null,
      undefined,
      [fakeImage],
    );

    // Envia áudio transcrito como steer
    await f.app.submit(id, "req-audio", "audio transcrito aqui", "web");

    barrier.resolve();
    await wait(f.app, id);

    assert.ok(imageSeen, "imagem e legenda entraram no transcript do modelo");
    assert.ok(audioSeen, "áudio transcrito entrou no transcript do modelo");
  } finally {
    await f.close();
  }
});

test("Entrega de job e turno agendado continuam followUp", async () => {
  const barrier = new Deferred<void>();
  let jobOrTaskSeenInSteer = false;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      async (transcript) => {
        const found = transcript.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            (m.content.includes("job resultado") ||
              m.content.includes("agendamento cron")),
        );
        if (found) jobOrTaskSeenInSteer = true;
        return fauxAssistantMessage("Resposta do turno do usuario");
      },
      fauxAssistantMessage("Resposta da entrega do job"),
      fauxAssistantMessage("Resposta da tarefa agendada"),
    ],
    async () => {
      await barrier.promise;
      return [];
    },
  );

  try {
    const id = await f.app.create();

    void f.app.submit(id, "req-1", "turno humano");
    await until(() => f.app.isTurnBusy(id));

    // Submissão com source "job" durante o turno
    await f.app.submit(id, "req-job", "job resultado", "job");

    // Submissão com source "system" (ou task) durante o turno
    await f.app.submit(id, "req-system", "agendamento cron", "system");

    barrier.resolve();
    await wait(f.app, id);

    assert.equal(
      jobOrTaskSeenInSteer,
      false,
      "job e cron não entraram como steer no turno do usuário",
    );

    // Verificamos que foram processados subsequentemente (1 tool call + 1 resposta do usuário + 1 job + 1 cron = 4)
    const snapshot = await f.app.snapshot(id);
    const assistants = snapshot.view.entries.filter(
      (e) => e.kind === "pi.assistant",
    );
    assert.equal(
      assistants.length,
      4,
      "todos foram executados como turnos separados",
    );
  } finally {
    await f.close();
  }
});

test("O aviso 'Recebi, vou considerar...' é enviado uma vez por turno ocupado", async () => {
  const barrier1 = new Deferred<void>();
  const barrier2 = new Deferred<void>();
  let catalogCallCount = 0;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Fim do turno 1"),
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-2",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Fim do turno 2"),
    ],
    async () => {
      catalogCallCount++;
      if (catalogCallCount === 1) await barrier1.promise;
      else await barrier2.promise;
      return [];
    },
  );

  try {
    const owner = { chat: "-100123", user: "42" };
    const convId = await f.app.telegramChats.ensure(owner);

    const polling = new TelegramPolling(
      f.app,
      { call: async () => ({}) } as unknown as TelegramApi,
      config,
      { id: 123 },
    );

    // Mensagem 1 inicia o turno 1
    await polling.engine.receive({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "inicia turno 1",
        date: 1000,
      },
    });

    await until(() => f.app.isTurnBusy(convId));

    // Mensagem 2 durante turno ocupado: deve enviar aviso
    await polling.engine.receive({
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "steer 1",
        date: 1001,
      },
    });

    const deliveries1 = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const count1 = deliveries1.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(count1, 1, "primeiro steer envia aviso");

    // Mensagem 3 durante o mesmo turno: NÃO duplica aviso (sem spam)
    await polling.engine.receive({
      update_id: 3,
      message: {
        message_id: 12,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "steer 2",
        date: 1002,
      },
    });

    const deliveries2 = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const count2 = deliveries2.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(count2, 1, "não repete aviso no mesmo turno ocupado");

    // Mensagem 4 (comando /status): NÃO envia aviso
    await polling.engine.receive({
      update_id: 4,
      message: {
        message_id: 13,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "/status",
        date: 1003,
      },
    });

    const deliveries3 = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const count3 = deliveries3.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(count3, 1, "comando não envia aviso");

    // Finaliza o turno 1
    barrier1.resolve();
    await wait(f.app, convId);

    // Mensagem 5 inicia o turno 2
    await polling.engine.receive({
      update_id: 5,
      message: {
        message_id: 20,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "inicia turno 2",
        date: 2000,
      },
    });

    await until(() => f.app.isTurnBusy(convId));

    // Mensagem 6 durante o novo turno ocupado: deve enviar o aviso novamente
    await polling.engine.receive({
      update_id: 6,
      message: {
        message_id: 21,
        from: { id: 42, is_bot: false },
        chat: { id: -100123, type: "supergroup" },
        text: "steer no turno 2",
        date: 2001,
      },
    });

    const deliveries4 = f.app.store.all<{ text: string }>(
      "SELECT text FROM deliveries WHERE chat=? ORDER BY rowid",
      "-100123",
    );
    const count4 = deliveries4.filter((d) =>
      d.text.includes(
        "Recebi, vou considerar no que estou fazendo. /stop cancela.",
      ),
    ).length;
    assert.equal(count4, 2, "novo turno ocupado envia aviso uma vez novamente");

    barrier2.resolve();
    await wait(f.app, convId);

    await polling.close();
  } finally {
    await f.close();
  }
});

test("Mesmo requestId repetido não gera envio duplicado", async () => {
  const barrier = new Deferred<void>();
  let msgCountInTranscript = 0;

  const f = await fixture(
    [
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "call-1",
          name: "mcp_tools",
          arguments: {},
        },
        { stopReason: "toolUse" },
      ),
      async (transcript) => {
        msgCountInTranscript = transcript.messages.filter(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("mensagem repetida"),
        ).length;
        return fauxAssistantMessage("Final");
      },
    ],
    async () => {
      await barrier.promise;
      return [];
    },
  );

  try {
    const id = await f.app.create();

    void f.app.submit(id, "req-init", "inicia turno com ferramenta");
    await until(() => f.app.isTurnBusy(id));

    // Envia primeira vez com requestId "req-idempotente"
    const sub1 = await f.app.submit(id, "req-idempotente", "mensagem repetida");

    // Envia segunda vez com O MESMO requestId "req-idempotente"
    const sub2 = await f.app.submit(id, "req-idempotente", "mensagem repetida");

    assert.equal(
      sub1.submissionId,
      sub2.submissionId,
      "mesmo requestId retorna a mesma submissão",
    );

    barrier.resolve();
    await wait(f.app, id);

    assert.equal(
      msgCountInTranscript,
      1,
      "mensagem aparece exatamente uma vez no transcript",
    );
  } finally {
    await f.close();
  }
});
