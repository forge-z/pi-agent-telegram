import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Delivery } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { Telegram, TelegramHttp } from "../src/telegram.js";
import { PendingJobs } from "../src/pending-jobs.js";

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
    gateway: { catalog: async () => [] },
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
      gateway: { catalog: async () => [] },
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

test("an uncertain Telegram send is never repeated across the job settlement crash window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-job-uncertain-"));
  const gateway = {
    catalog: async () => [],
    callDirect: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "completed",
            execution: {
              ok: true,
              value: {
                status: "COMPLETED",
                run_id: "uncertain-run",
                result: { answer: 42 },
              },
            },
          }),
        },
      ],
    }),
  };
  const env = {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.test.jobs.start",
        dispatch: { mode: "immediate", idPath: "run_id" },
        observe: {
          mode: "poll",
          tool: "tools.test.jobs.status",
          args: { accountId: "acc-test", input: { id: "${id}" } },
          statePath: "status",
          resultPath: "result",
        },
      },
    ]),
  };
  let app = await Runtime.open({ dir, mode: "demo", gateway, env });
  const conversationId = await app.create();
  let submissions = 0;
  const requestIds: string[] = [];
  let sends = 0;
  const makeJobs = () =>
    new PendingJobs(
      {
        store: app.store,
        options: { gateway },
        submit: async (
          conversationId: string,
          requestId: string,
          text: string,
        ) => {
          // Keep the real admission ledger and deduplication in this crash-window test.
          await app.submit(conversationId, requestId, text, "job");
          submissions++;
          requestIds.push(requestId);
          app.store.queueTelegram(
            `${conversationId}:${requestId}`,
            "42",
            "saved job result",
          );
        },
      } as unknown as Runtime,
      env,
    );
  let jobs = makeJobs();
  const transport = {
    send: async () => {
      sends++;
      throw new Error("unknown send outcome");
    },
  };
  let telegram = new Telegram(app, transport, ["42"], ["42"]);
  try {
    jobs.register("tools.test.jobs", "start", conversationId, "Liste");
    jobs.capture("tools.test.jobs", "start", conversationId, "uncertain-run");
    await jobs.tick();
    await telegram.flush();
    const delivery = app.store.get<Delivery>("SELECT * FROM deliveries")!;
    assert.equal(delivery.state, "uncertain");
    assert.equal(submissions, 1);
    assert.equal(sends, 1);
    assert.equal(
      app.store.get<{ delivery_attempts: number }>(
        "SELECT delivery_attempts FROM pending_jobs",
      )!.delivery_attempts,
      0,
      "uncertainty is not a retryable submission failure",
    );
    // Model a process loss after turn admission/send but before closing the job row.
    app.store.run("UPDATE pending_jobs SET delivered_at=NULL,outcome=NULL");
    jobs.close();
    await telegram.drain();
    await app.close();
    app = await Runtime.open({ dir, mode: "demo", gateway, env });
    jobs = makeJobs();
    telegram = new Telegram(app, transport, ["42"], ["42"]);
    await jobs.tick();
    await telegram.flush();
    assert.equal(submissions, 2, "re-admission uses the same durable key");
    assert.deepEqual(requestIds, [
      "job:1:uncertain-run",
      "job:1:uncertain-run",
    ]);
    assert.equal(sends, 1);
    assert.deepEqual(
      app.store.get<Delivery>("SELECT * FROM deliveries"),
      delivery,
    );
    assert.equal(
      app.store.get<{ delivery_attempts: number }>(
        "SELECT delivery_attempts FROM pending_jobs",
      )!.delivery_attempts,
      0,
    );
  } finally {
    jobs.close();
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
