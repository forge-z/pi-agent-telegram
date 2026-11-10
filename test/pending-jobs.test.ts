import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import {
  deterministicFailure,
  dispatchOutcome,
  matchDelegatedTools,
  normalizeToolPath,
  PendingJobs,
  programPayload,
} from "../src/pending-jobs.js";
import { buildReadInput } from "../src/job-manifest.js";
import { isInputInvalid } from "../src/executor-result.js";
import type { Runtime } from "../src/runtime.js";

const TOOL = "tinyfish_mcp.user.exampleTinyfishMcp.run_web_automation";
const SERVER = "tinyfish_mcp.user.exampleTinyfishMcp";

/** A normal reconcile manifest. The v1 ASYNC_JOB_TOOLS list no longer exists. */
const RECONCILE_MANIFEST = {
  tool: TOOL,
  dispatch: { mode: "immediate", idPath: "run_id" },
  observe: {
    mode: "reconcile",
    tool: `${SERVER}.list_runs`,
    args: {
      accountId: "acc-test",
      input: {
        query: { limit: 20, sort_direction: "asc", goal: "${goal}" },
      },
    },
    statePath: "status",
    resultPath: "result",
    errorPath: "error",
  },
  reconcile: {
    tool: `${SERVER}.list_runs`,
    args: {
      accountId: "acc-test",
      input: {
        query: { limit: 20, sort_direction: "asc", goal: "${goal}" },
      },
    },
    match: "goalSuffix",
    windowMinutes: 15,
  },
  graceMinutes: 5,
};

/** Real Executor `execute` success: the program return sits in `execution.value`. */
function executorOk(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

/** A Runtime stand-in: the store, a gateway that answers list_runs, and submit. */
async function fixture(
  runs: unknown[],
  pages: unknown[][] = [],
  env: Record<string, string | undefined> = {},
) {
  env = {
    ASYNC_JOB_MANIFESTS: JSON.stringify([RECONCILE_MANIFEST]),
    ...env,
  };
  let catalog: unknown = {
    namespaces: [
      {
        path: "tools.tinyfish",
        app: "TinyFish",
        accounts: "tinyfish: acc-test (Default)",
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "pi-pending-jobs-"));
  let store = new Store(dir);
  const submissions: {
    conversationId: string;
    text: string;
    source: string;
    requestId: string;
  }[] = [];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let observed: unknown;
  let scripted: unknown;
  let scriptedSet = false;
  const gateway = {
    callDirect: async (
      _server: string,
      tool: string,
      args: Record<string, unknown>,
      options: { signal?: AbortSignal } = {},
    ) => {
      calls.push({ tool, args });
      if (tool === "search" || tool === "describe") return catalog;
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Timeout");
      }
      // The poller goes through `execute`, so the filter travels inside the program.
      const program = String((args as { code?: string }).code ?? "");
      if (!program.includes("list_runs")) {
        // A poll manifest names its own status tool; the test decides what it answers.
        if (scriptedSet) {
          if (scripted instanceof Error) throw scripted;
          return scripted;
        }
        if (observed instanceof Error) throw observed;
        if (observed === undefined)
          throw new Error("502: transient provider failure");
        return executorOk(observed);
      }
      const raw = JSON.parse(
        /(?<=list_runs(?:"\))?\()\{.*\}(?=\)\);)/s.exec(program)?.[0] ?? "{}",
      ) as {
        accountId?: string;
        input?: {
          query?: {
            created_after?: string;
            created_before?: string;
            limit?: unknown;
            sort_direction?: unknown;
            cursor?: string;
          };
        };
        created_after?: string;
        created_before?: string;
        limit?: unknown;
        sort_direction?: unknown;
        cursor?: string;
      };
      const filter = { ...raw, ...(raw.input?.query ?? {}) };
      // The provider rejects a call without limit and sort_direction.
      if (!filter.limit || !filter.sort_direction)
        throw new Error("400: limit and sort_direction are required");
      const from = filter.created_after
        ? Date.parse(filter.created_after)
        : -Infinity;
      const to = filter.created_before
        ? Date.parse(filter.created_before)
        : Infinity;
      const visible = runs.filter((run) => {
        const at = Date.parse(
          String((run as { created_at?: string }).created_at ?? ""),
        );
        return !Number.isFinite(at) || (at >= from && at <= to);
      });
      const index = Number(filter.cursor ?? 0);
      const page = pages[index] ?? visible;
      // The program JSON.stringifies the tool result; Executor wraps that string
      // as {status:"completed", execution:{ok:true, value}}.
      const payload = {
        data: page,
        pagination:
          index + 1 < pages.length
            ? { has_more: true, next_cursor: String(index + 1) }
            : { has_more: false },
      };
      return executorOk(JSON.stringify(payload));
    },
  };
  const app = {
    store,
    options: { gateway },
    submit: async (
      conversationId: string,
      requestId: string,
      text: string,
      source: string,
    ) => {
      submissions.push({ conversationId, text, source, requestId });
      return {};
    },
  };
  let jobs = new PendingJobs(app as unknown as Runtime, env);
  return {
    get store() {
      return store;
    },
    restart: () => {
      jobs.close();
      store.db.close();
      store = new Store(dir);
      app.store = store;
      jobs = new PendingJobs(app as unknown as Runtime, env);
    },
    setObserved: (value: unknown) => {
      observed = value;
      scriptedSet = false;
    },
    setResult: (value: unknown) => {
      scripted = value;
      scriptedSet = true;
    },
    setCatalog: (value: unknown) => {
      catalog = value;
    },
    get jobs() {
      return jobs;
    },
    submissions,
    calls,
    app,
    close: async () => {
      jobs.close();
      store.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("a finished job wakes one turn, even when the dispatch returned no id", async () => {
  const runAt = Date.now();
  const f = await fixture([
    {
      run_id: "run-1",
      status: "COMPLETED",
      goal: "extrair preços",
      created_at: new Date(runAt).toISOString(),
      result: { answer: 42 },
    },
  ]);
  try {
    // The dispatch died before returning a run id: only the pre-registration exists.
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "extrair preços"),
      true,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0].conversationId, "7");
    assert.equal(f.submissions[0].source, "job");
    assert.match(f.submissions[0].text, /extrair preços/);
    assert.match(f.submissions[0].text, /answer/);
    // Reconciled by goal and date, and the run id is kept for the next pass.
    assert.equal(
      f.store.get<{ run_id: string }>("SELECT run_id FROM pending_jobs")
        ?.run_id,
      "run-1",
    );
    // A second pass delivers nothing: the row is closed.
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
  } finally {
    await f.close();
  }
});

test("a run that outlives the timeout becomes a short notice", async () => {
  const f = await fixture([
    {
      run_id: "run-2",
      status: "RUNNING",
      goal: "raspar o site",
      created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "raspar o site");
    // Pretend the dispatch was 40 minutes ago.
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 40 * 60_000,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Status: RUNNING depois de/);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "o aviso é único");
    // The row stays open: a late COMPLETED still reaches the chat.
    assert.equal(
      f.store.get<{ delivered_at: number | null }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
      null,
    );
  } finally {
    await f.close();
  }
});

test("a failed run is a notice, never silence", async () => {
  const f = await fixture([
    {
      run_id: "run-3",
      status: "FAILED",
      goal: "raspar",
      error: "browser crashed at step 3",
      created_at: new Date().toISOString(),
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "raspar");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    // The notice says which job, which tool and what the provider reported.
    assert.match(f.submissions[0].text, /FAILED/);
    assert.match(f.submissions[0].text, /run_web_automation/);
    assert.match(f.submissions[0].text, /job /);
    assert.match(f.submissions[0].text, /browser crashed at step 3/);
  } finally {
    await f.close();
  }
});

test("a turn born from a job does not register another", async () => {
  const f = await fixture([]);
  try {
    f.jobs.enterJobTurn("7");
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "outro"),
      false,
    );
    f.jobs.leaveJobTurn("7");
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "outro"),
      true,
    );
    // A tool outside the allowlist is not a job.
    assert.equal(
      f.jobs.register("other", "run_web_automation", "7", "x"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("the provider rewrites the goal, and the sent one is still the tail", async () => {
  const runAt = Date.now();
  const f = await fixture([
    {
      run_id: "run-9",
      status: "COMPLETED",
      // What the API really returns: our goal is appended to an instruction.
      goal: "Navigate to https://www.sympla.com.br/eventos to complete the goal: Liste SOMENTE os eventos",
      created_at: new Date(runAt).toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    f.jobs.register(
      SERVER,
      "run_web_automation",
      "7",
      "Liste SOMENTE os eventos",
    );
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "casou por sufixo, não por igualdade",
    );
  } finally {
    await f.close();
  }
});

test("a dispatch rejected with a 4xx closes the row instead of waiting", async () => {
  const f = await fixture([]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "sessão inválida");
    f.jobs.closeUnstarted(SERVER, "run_web_automation", "7");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0);
    assert.equal(
      f.calls.length,
      0,
      "sem linha aberta, o poller não chama nada",
    );
  } finally {
    await f.close();
  }
});

test("only a deterministic rejection proves no run was created", () => {
  const text = (body: string) => ({ content: [{ type: "text", text: body }] });
  assert.equal(
    deterministicFailure(text('{"status":400,"message":"bad session id"}')),
    true,
  );
  assert.equal(
    deterministicFailure(text('{"error":{"retryable":false}}')),
    true,
  );
  assert.equal(
    deterministicFailure(
      text(
        '{"status":"completed","execution":{"ok":false,"error":{"kind":"InvalidDataValue","message":"Binary operators require data values."}}}',
      ),
    ),
    true,
  );
  // A transport error or a 5xx may have created the run: the row must survive.
  assert.equal(
    deterministicFailure(text("Internal tool error [088cc443]")),
    false,
  );
  assert.equal(deterministicFailure(text('{"status":503}')), false);
  assert.equal(deterministicFailure(undefined), false);
});

test("a failing reconcile read keeps the row open and retries", async () => {
  const f = await fixture([]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "x");
    const broken = {
      callDirect: async () => {
        throw new Error("tool not found");
      },
    };
    Object.assign(
      (f.jobs as unknown as { app: { options: object } }).app.options,
      {
        gateway: broken,
      },
    );
    for (let pass = 0; pass < 4; pass += 1) await f.jobs.tick();
    const after = f.store.get<{
      poll_attempts: number;
      delivered_at: number | null;
      next_poll_at: number;
    }>("SELECT poll_attempts, delivered_at, next_poll_at FROM pending_jobs")!;
    assert.equal(
      after.poll_attempts,
      1,
      "o backoff impede outra leitura imediata",
    );
    assert.equal(after.delivered_at, null);
    assert.ok(after.next_poll_at > Date.now());
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(
      f.store.get<{ poll_attempts: number }>(
        "SELECT poll_attempts FROM pending_jobs",
      )?.poll_attempts,
      2,
    );
  } finally {
    await f.close();
  }
});

test("poll errors do not exhaust delivery retries when the completed result first fails to submit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const manifest = {
    ...RECONCILE_MANIFEST,
    observe: {
      ...RECONCILE_MANIFEST.observe,
      mode: "poll",
      tool: `${SERVER}.get_status`,
      args: { accountId: "acc-test", input: { id: "${id}" } },
    },
    poll: { backoff: [5, 15, 45], maxAttempts: 3 },
  };
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([manifest]),
  });
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.jobs.capture(SERVER, "run_web_automation", "7", "run-retries");
    f.setObserved(new Error("503: transient provider failure"));
    for (const delay of [5_000, 15_000, 45_000]) {
      await f.jobs.tick();
      t.mock.timers.tick(delay);
    }
    f.setObserved({
      run_id: "run-retries",
      status: "COMPLETED",
      result: { answer: 42 },
    });
    const submit = f.app.submit;
    f.app.submit = async () => {
      throw new Error("local admission failed before delivery");
    };
    await f.jobs.tick();
    const row = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
      result: string;
      next_poll_at: number;
    }>("SELECT delivered_at, outcome, result, next_poll_at FROM pending_jobs")!;
    assert.equal(
      row.delivered_at,
      null,
      "a first delivery failure still has two retries",
    );
    assert.notEqual(row.outcome, "expired");
    assert.equal(row.next_poll_at, Date.now() + 5_000);
    assert.equal(row.result, '{"answer":42}');
    f.app.submit = submit;
    t.mock.timers.tick(5_000);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(
      f.store.get<{ outcome: string }>("SELECT outcome FROM pending_jobs")
        ?.outcome,
      "delivered",
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
  } finally {
    await f.close();
  }
});

const RETRY_MANIFEST = {
  ...RECONCILE_MANIFEST,
  observe: {
    ...RECONCILE_MANIFEST.observe,
    mode: "poll",
    tool: `${SERVER}.get_status`,
    args: { accountId: "acc-test", input: { id: "${id}" } },
  },
  poll: { backoff: [5, 15, 45], maxAttempts: 3 },
};

type RetryRow = {
  attempts: number;
  poll_attempts: number;
  delivery_attempts: number;
  next_poll_at: number;
  delivered_at: number | null;
  outcome: string | null;
  result: string | null;
};

test("delivery failures keep their own budget and backoff across successful polls and restarts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([RETRY_MANIFEST]),
  });
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.jobs.capture(SERVER, "run_web_automation", "7", "run-budget");
    f.setObserved(new Error("503: temporary"));
    await f.jobs.tick();
    f.restart();
    const afterPoll = f.store.get<RetryRow>("SELECT * FROM pending_jobs")!;
    assert.equal(afterPoll.poll_attempts, 1);
    assert.equal(afterPoll.delivery_attempts, 0);
    assert.equal(afterPoll.next_poll_at, Date.now() + 5_000);
    await f.jobs.tick();
    assert.equal(
      f.calls.length,
      1,
      "restart must respect the persisted due time",
    );
    t.mock.timers.tick(5_000);
    await f.jobs.tick();
    assert.equal(
      f.store.get<RetryRow>("SELECT * FROM pending_jobs")!.next_poll_at,
      Date.now() + 15_000,
    );
    t.mock.timers.tick(15_000);
    f.setObserved({
      run_id: "run-budget",
      status: "COMPLETED",
      result: { answer: 42 },
    });
    let deliveries = 0;
    f.app.submit = async () => {
      deliveries++;
      throw new Error("local admission failed before delivery");
    };
    for (const [failures, delay] of [
      [1, 5_000],
      [2, 15_000],
      [3, 45_000],
    ]) {
      await f.jobs.tick();
      const row = f.store.get<RetryRow>("SELECT * FROM pending_jobs")!;
      assert.equal(
        row.poll_attempts,
        0,
        "a successful read clears only poll failures",
      );
      assert.equal(row.delivery_attempts, failures);
      assert.equal(
        row.attempts,
        0,
        "new failures do not alter legacy evidence",
      );
      assert.equal(row.result, '{"answer":42}');
      if (failures < 3) {
        assert.equal(row.delivered_at, null);
        assert.equal(row.next_poll_at, Date.now() + delay);
        f.restart();
        await f.jobs.tick();
        assert.equal(deliveries, failures, "no early delivery after restart");
        t.mock.timers.tick(delay);
      } else {
        assert.equal(row.outcome, "expired");
        assert.ok(row.delivered_at);
      }
    }
    f.restart();
    t.mock.timers.tick(60_000);
    await f.jobs.tick();
    assert.equal(deliveries, 3, "the delivery limit remains effective");
  } finally {
    await f.close();
  }
});

for (const kind of [
  "reconcile",
  "poll",
  "returned not-found",
  "thrown not-found",
] as const) {
  test(`${kind} failures persist poll backoff without spending delivery budget`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const manifest =
      kind === "reconcile"
        ? { ...RECONCILE_MANIFEST, poll: RETRY_MANIFEST.poll }
        : RETRY_MANIFEST;
    const f = await fixture([], [], {
      ASYNC_JOB_MANIFESTS: JSON.stringify([manifest]),
    });
    try {
      f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
      if (kind !== "reconcile")
        f.jobs.capture(SERVER, "run_web_automation", "7", "run-poll");
      f.store.run(
        "UPDATE pending_jobs SET created_at=?",
        Date.now() - 6 * 60_000,
      );
      if (kind === "returned not-found")
        f.setObserved({ error: "404: not found" });
      else if (kind === "thrown not-found")
        f.setObserved(new Error("404: not found"));
      else
        f.app.options.gateway.callDirect = async () => {
          throw new Error("503: temporary");
        };
      for (const [failures, delay] of [
        [1, 5_000],
        [2, 15_000],
        [3, 45_000],
        [4, 45_000],
      ]) {
        await f.jobs.tick();
        const row = f.store.get<RetryRow>("SELECT * FROM pending_jobs")!;
        assert.equal(row.poll_attempts, failures);
        assert.equal(row.delivery_attempts, 0);
        assert.equal(row.delivered_at, null);
        assert.equal(row.next_poll_at, Date.now() + delay);
        f.restart();
        await f.jobs.tick();
        assert.equal(
          f.store.get<RetryRow>("SELECT * FROM pending_jobs")!.poll_attempts,
          failures,
        );
        t.mock.timers.tick(delay);
      }
    } finally {
      await f.close();
    }
  });
}

test("legacy migration seeds poll attempts and releases the row to normal polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-legacy-"));
  const legacy = new DatabaseSync(join(dir, "app.sqlite"));
  legacy.exec(`
    CREATE TABLE pending_jobs(
      id INTEGER PRIMARY KEY, integration TEXT NOT NULL, tool TEXT NOT NULL,
      run_id TEXT, goal TEXT, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      delivered_at INTEGER, notified_at INTEGER, outcome TEXT, result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0,
      job_state TEXT, last_error TEXT);
  `);
  legacy
    .prepare(
      `INSERT INTO pending_jobs(id,integration,tool,run_id,goal,conversation_id,created_at,delivered_at,outcome,result,attempts,job_state,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      1,
      SERVER,
      TOOL,
      "legacy-1",
      "Liste",
      "7",
      Date.now(),
      null,
      null,
      '{"saved":true}',
      2,
      "pending",
      "old",
    );
  legacy.close();
  const store = new Store(dir);
  const jobs = new PendingJobs(
    {
      store,
      options: { gateway: { callDirect: async () => ({}) } },
      submit: async () => "sent",
    } as unknown as Runtime,
    { ASYNC_JOB_MANIFESTS: JSON.stringify([RETRY_MANIFEST]) },
  );
  try {
    jobs.health();
    const row = store.get<RetryRow>("SELECT * FROM pending_jobs WHERE id=1")!;
    assert.equal(row.poll_attempts, 2);
    assert.equal(row.delivery_attempts, 0);
    assert.equal(row.attempts, 2);
    assert.equal(row.delivered_at, null);
    jobs.health();
    assert.equal(
      store.get<RetryRow>("SELECT * FROM pending_jobs WHERE id=1")!
        .poll_attempts,
      2,
    );
  } finally {
    jobs.close();
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a permanent input error after transient polls closes once without retrying the action", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([RETRY_MANIFEST]),
  });
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.jobs.capture(SERVER, "run_web_automation", "7", "run-permanent");
    f.setObserved(new Error("503: temporary"));
    await f.jobs.tick();
    t.mock.timers.tick(5_000);
    f.setObserved(new Error("InputInvalid (HTTP 422): input is invalid"));
    await f.jobs.tick();
    const row = f.store.get<RetryRow>("SELECT * FROM pending_jobs")!;
    assert.equal(row.outcome, "input_invalid");
    assert.ok(row.delivered_at);
    assert.equal(row.poll_attempts, 1);
    assert.equal(row.delivery_attempts, 0);
    assert.equal(f.submissions.length, 1);
    f.restart();
    t.mock.timers.tick(60_000);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.calls.length, 2);
    assert.ok(
      f.calls.every(
        (call) =>
          call.tool === "execute" &&
          String(call.args.code).includes("get_status"),
      ),
      "only read tools were called",
    );
  } finally {
    await f.close();
  }
});

test("a synchronous dispatch that already has the result closes the row", () => {
  // The real shape of run_web_automation: camelCase id, lower case status, inline result.
  assert.deepEqual(
    dispatchOutcome({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            runId: "ab6564c5",
            status: "completed",
            runUrl: "https://x",
            result: { events: [] },
          }),
        },
      ],
    }),
    { runId: "ab6564c5", completed: true },
  );
  // A dispatch still running: captured, not completed.
  assert.deepEqual(
    dispatchOutcome({
      structuredContent: { run_id: "21270a97", status: "RUNNING" },
    }),
    { runId: "21270a97", completed: false },
  );
  // Completed without a result is not a delivery: the result has to come from the poller.
  assert.equal(
    dispatchOutcome({ structuredContent: { run_id: "x", status: "COMPLETED" } })
      .completed,
    false,
  );
  assert.equal(dispatchOutcome({ content: [] }).completed, false);
});

test("a dispatched result is delivered once: the turn closes it, the poller is silent", async () => {
  const f = await fixture([
    {
      run_id: "run-sync",
      status: "COMPLETED",
      goal: "Liste os eventos",
      created_at: new Date().toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste os eventos");
    f.jobs.markDispatchedResult(
      SERVER,
      "run_web_automation",
      "7",
      JSON.stringify({
        runId: "run-sync",
        status: "completed",
        result: { ok: true },
      }),
    );
    // The turn answered: its reply is in the delivery list, so the row closes.
    f.jobs.settleTurn("7");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "uma mensagem, não duas");
    assert.ok(
      f.store.get<{ delivered_at: number }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
    );
  } finally {
    await f.close();
  }
});

test("a dispatched result is resent when the turn died before delivering", async () => {
  const f = await fixture([
    {
      run_id: "run-lost",
      status: "COMPLETED",
      goal: "Liste os eventos",
      created_at: new Date().toISOString(),
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste os eventos");
    f.jobs.markDispatchedResult(
      SERVER,
      "run_web_automation",
      "7",
      JSON.stringify({ runId: "run-lost", result: { itens: 3 } }),
    );
    // No settleTurn: the turn crashed after the tool returned.
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "espera o turno terminar primeiro");
    // Past the grace window the stored result is delivered instead of lost.
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 5 * 60_000,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /itens/);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "e só uma vez");
  } finally {
    await f.close();
  }
});

test("a delivery that keeps failing expires instead of looping for ever", async () => {
  const f = await fixture([
    {
      run_id: "run-loop",
      status: "COMPLETED",
      goal: "Liste",
      created_at: new Date().toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    // The crash repeats: every submit fails, as it did three times in the field.
    f.app.submit = async () => {
      throw new Error("Internal tool error");
    };
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.jobs.markDispatchedResult(SERVER, "run_web_automation", "7", '{"x":1}');
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 5 * 60_000,
    );
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...parts: unknown[]) =>
      logged.push(parts.map(String).join(" "));
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        await f.jobs.tick();
        if (pass === 0) {
          const retry = f.store.get<{ next_poll_at: number }>(
            "SELECT next_poll_at FROM pending_jobs",
          )!;
          assert.ok(
            retry.next_poll_at > Date.now(),
            "entrega falha agenda retry com backoff",
          );
        }
        // Simulate the clock reaching the next delivery attempt.
        f.store.run("UPDATE pending_jobs SET next_poll_at=0");
      }
    } finally {
      console.warn = warn;
    }
    const row = f.store.get<{
      delivery_attempts: number;
      outcome: string;
      delivered_at: number | null;
    }>("SELECT delivery_attempts,outcome,delivered_at FROM pending_jobs")!;
    assert.equal(row.delivery_attempts, 3);
    assert.equal(row.outcome, "expired");
    assert.ok(row.delivered_at, "a linha fecha em vez de tentar para sempre");
    assert.ok(logged.some((line) => /desistindo/.test(line)));
  } finally {
    await f.close();
  }
});

test("a settled job with no confirmed delivery is reported once", async () => {
  const f = await fixture([]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.jobs.markDispatchedResult(SERVER, "run_web_automation", "7", '{"x":1}');
    f.jobs.settleTurn("7");
    // Ten minutes later no `sent` delivery exists for that request.
    f.store.run(
      "UPDATE pending_jobs SET delivered_at=?",
      Date.now() - 11 * 60_000,
    );
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...parts: unknown[]) =>
      logged.push(parts.map(String).join(" "));
    try {
      await f.jobs.tick();
      await f.jobs.tick();
    } finally {
      console.warn = warn;
    }
    assert.equal(
      f.store.get<{ outcome: string }>("SELECT outcome FROM pending_jobs")
        ?.outcome,
      "delivery_unconfirmed",
    );
    assert.equal(
      logged.filter((line) => /nenhuma entrega foi confirmada/.test(line))
        .length,
      1,
      "avisa uma vez, não a cada tick",
    );
  } finally {
    await f.close();
  }
});

test("a job called inside execute is registered from the code the model sent", async () => {
  const f = await fixture([]);
  try {
    // The shape the agent really sends: the integration is called inside the sandbox.
    const opened = f.jobs.registerDelegated("7", {
      code: [
        "const r = await tools.tinyfish_mcp.user.exampleTinyfishMcp.run_web_automation({",
        '  goal: "ETAPA3-2026-10-19 Liste os eventos",',
        "});",
      ].join("\n"),
    });
    // The caller needs this: it decides whether a runtime error is indeterminate or failed.
    assert.equal(opened, true);
    const row = f.store.get<{ goal: string; tool: string; delivered_at: null }>(
      "SELECT goal,tool,delivered_at FROM pending_jobs",
    )!;
    // The caller needs this to know a job was dispatched: it decides whether a runtime
    // error is indeterminate instead of failed.
    assert.equal(opened, true);
    assert.equal(row.tool, TOOL);
    assert.match(row.goal, /ETAPA3-2026-10-19/);
    assert.equal(row.delivered_at, null);
  } finally {
    await f.close();
  }
});

test("without a goal the run is never claimed by the window alone", async () => {
  const registeredAt = Date.now();
  const f = await fixture([
    {
      run_id: "run-window",
      status: "COMPLETED",
      goal: "Navigate to https://x to complete the goal: algo",
      created_at: new Date(registeredAt + 1000).toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", undefined);
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      0,
      "sem job_id e sem goal não há como reivindicar a execução",
    );
  } finally {
    await f.close();
  }
});

test("the poller reads runs through execute, with the integration path inside", async () => {
  const f = await fixture([
    {
      run_id: "run-path",
      status: "COMPLETED",
      goal: "Liste",
      created_at: new Date().toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    await f.jobs.tick();
    const call = f.calls.at(-1)!;
    // The integration is a path inside the sandbox, not an MCP server name.
    assert.equal(call.tool, "execute");
    const code = String((call.args as { code?: string }).code ?? "");
    assert.match(code, /tinyfish_mcp\.user\.exampleTinyfishMcp\.list_runs/);
    assert.match(code, /"sort_direction":"asc"/);
    assert.equal(f.submissions.length, 1);
  } finally {
    await f.close();
  }
});

test("the execute envelope's lowercase status is not the run's status", async () => {
  const f = await fixture([
    {
      run_id: "run-running",
      status: "RUNNING",
      goal: "Liste",
      created_at: new Date().toISOString(),
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    await f.jobs.tick();
    // `completed` in the envelope would have looked like a finished run.
    assert.equal(f.submissions.length, 0);
  } finally {
    await f.close();
  }
});

test("a synchronous run inside the envelope is read, not the envelope", () => {
  const outcome = dispatchOutcome({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "completed",
          result: JSON.stringify({
            runId: "run-sync",
            status: "completed",
            runUrl: "https://x",
            result: { ok: true },
          }),
        }),
      },
    ],
  });
  assert.equal(outcome.runId, "run-sync");
  assert.equal(outcome.completed, true);
});

test("a list payload is not mistaken for a dispatch result", () => {
  const outcome = dispatchOutcome({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "completed",
          result: JSON.stringify({ data: [], pagination: { total: 0 } }),
        }),
      },
    ],
  });
  assert.equal(outcome.runId, undefined);
});

test("the payload is read past the Executor envelope, whatever its status says", () => {
  const payload = programPayload({
    status: "completed",
    result: JSON.stringify({
      data: [{ run_id: "run-1" }],
      pagination: { total: 1 },
    }),
  }) as { data: { run_id: string }[] };
  assert.equal(payload.data[0].run_id, "run-1");
  // A run's own shape is never unwrapped: its `result` belongs to it.
  const run = { runId: "run-2", status: "completed", result: { ok: true } };
  assert.deepEqual(programPayload(run), run);
});

test("a run created seconds after the row is found, not hidden by a ceiling", async () => {
  // The real timeline: the row is registered at dispatch, the run is created a few seconds
  // later. A window ending at the row's time would hide every run ever dispatched.
  const registeredAt = Date.now();
  const f = await fixture([
    {
      run_id: "run-after",
      status: "COMPLETED",
      goal: "Navigate to https://x to complete the goal: ETAPA3C",
      created_at: new Date(registeredAt + 5000).toISOString(),
      result: { ok: true },
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "ETAPA3C");
    f.store.run("UPDATE pending_jobs SET created_at=?", registeredAt);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "o run nasceu depois da linha");
  } finally {
    await f.close();
  }
});

test("a run not yet in the window is not reported as unconfirmed", async () => {
  const f = await fixture([]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "ETAPA3C");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "silêncio na carência");
  } finally {
    await f.close();
  }
});

test("code that names no configured tool opens nothing", async () => {
  const f = await fixture([]);
  try {
    assert.equal(
      f.jobs.registerDelegated("7", { code: "return 1 + 1" }),
      false,
    );
  } finally {
    await f.close();
  }
});

test("a manifest poll asks the status tool by id and delivers once", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
          errorPath: "error",
        },
      },
    ]),
  });
  try {
    // Dispatch returns the id inside the Executor envelope, as v2 does.
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ accountId: "acc" })',
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.setObserved({
      data: { run_id: "run-1", status: "COMPLETED", result: { eventos: [] } },
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "entregue uma vez");
    assert.match(f.submissions[0].text, /eventos/);
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    assert.match(program, /getRunById/, "a leitura é o tool do manifesto");
    assert.match(program, /run-1/, "com o id do job");
  } finally {
    await f.close();
  }
});

test("the provider vocabulary is mapped, and an unknown word is never a failure", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
          errorPath: "error",
        },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.setObserved({ data: { run_id: "run-1", status: "SOMETHING_NEW" } });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "unknown é silêncio");
    f.setObserved({ data: { run_id: "run-1", status: "succeeded" } });
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "palavra conhecida vira done");
  } finally {
    await f.close();
  }
});

test("a webhook event delivers without a single poll", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: { mode: "webhook", statePath: "status", resultPath: "result" },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.jobs.notify({ run_id: "run-1", status: "COMPLETED", result: { ok: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 0, "nenhum poll");
    assert.equal(f.submissions.length, 1);
  } finally {
    await f.close();
  }
});

test("a status call that fails keeps the row open instead of closing it", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
          errorPath: "error",
        },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    // observed stays undefined: the fake answers 502.
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0);
    const row = f.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs",
    )!;
    assert.equal(row.delivered_at, null, "a linha segue aberta");
  } finally {
    await f.close();
  }
});

test("a deferred id is picked up when it arrives", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
        },
        graceMinutes: 5,
        poll: { backoff: [1, 2, 3], maxAttempts: 3 },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    // No id in the dispatch response: the first ticks have nothing to ask.
    await f.jobs.tick();
    assert.equal(f.calls.length, 0, "sem id não há o que consultar");
    // ... until it arrives (a late response or a webhook-free capture).
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-9");
    f.setObserved({
      data: { run_id: "run-9", status: "COMPLETED", result: { ok: 1 } },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
  } finally {
    await f.close();
  }
});

test("two candidate runs are never claimed, and the row says so once", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "opaque" },
        observe: {
          mode: "reconcile",
          tool: "tools.tinyfish.agent.runs.listRuns",
          args: { input: { query: { goal: "${goal}" } } },
          statePath: "status",
          resultPath: "result",
        },
        poll: { backoff: [1], maxAttempts: 3 },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "ETAPA9" } } })',
    });
    const at = new Date().toISOString();
    f.setObserved({
      data: [
        {
          run_id: "a",
          status: "COMPLETED",
          goal: "ETAPA9",
          created_at: at,
          result: {},
        },
        {
          run_id: "b",
          status: "COMPLETED",
          goal: "ETAPA9",
          created_at: at,
          result: {},
        },
      ],
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "avisa que é ambíguo");
    assert.match(f.submissions[0].text, /AMBIGUOUS|ambígu/i);
    const row = f.store.get<{ run_id: string | null; job_state: string }>(
      "SELECT run_id, job_state FROM pending_jobs",
    )!;
    assert.equal(row.run_id, null, "não reivindica");
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "o aviso não se repete");
  } finally {
    await f.close();
  }
});

test("a finished job without a result is expired, not failed", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
        },
        graceMinutes: 5,
        poll: { backoff: [1, 2, 3], maxAttempts: 3 },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.setObserved({ data: { run_id: "run-1", status: "COMPLETED" } });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /expirad/i);
    const row = f.store.get<{ outcome: string }>(
      "SELECT outcome FROM pending_jobs",
    )!;
    assert.equal(row.outcome, "expired");
  } finally {
    await f.close();
  }
});

test("an approval waiting in the conversation does not stop the worker", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { accountId: "acc", input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
        },
        graceMinutes: 5,
        poll: { backoff: [1, 2, 3], maxAttempts: 3 },
      },
    ]),
  });
  try {
    // The poller does not depend on the MCP call layer at all: it talks to the gateway.
    // The row exists only to prove nothing here reads that queue.
    f.store.db.exec(
      "CREATE TABLE mcp_interactions(id TEXT PRIMARY KEY, callId TEXT, conversationId TEXT, server TEXT, kind TEXT, payload TEXT, state TEXT, response TEXT)",
    );
    f.store.run(
      "INSERT INTO mcp_interactions VALUES ('i1','c1','7','executor','resume','{}','pending',NULL)",
    );
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.setObserved({
      data: { run_id: "run-1", status: "COMPLETED", result: { ok: 1 } },
    });
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "a leitura não passa pelo pedido pendente",
    );
  } finally {
    await f.close();
  }
});

test("the built-in v2 read uses the account from the invocation", async () => {
  const account = "acc_explicit_not_a_default";
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: `await tools.tinyfish.agent.automation.runAsync({accountId:'${account}'})`,
    });
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", "run-1");
    f.setObserved({
      data: { run_id: "run-1", status: "COMPLETED", result: { eventos: [] } },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    assert.match(program, /tools\.tinyfish\.agent\.runs\.getRunById/);
    const args = JSON.parse(
      /getRunById\((\{.*\})\)/.exec(program)?.[1] ?? "null",
    );
    assert.deepEqual(args, {
      accountId: account,
      input: { path: { id: "run-1" } },
    });
  } finally {
    await f.close();
  }
});

test("without an id the job is found by the goal suffix the provider stored", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate", idPath: "value.run_id" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
        },
        reconcile: {
          tool: "tools.tinyfish.agent.runs.listRuns",
          args: { input: { query: { goal: "${goal}", limit: 20 } } },
          match: "goalSuffix",
          windowMinutes: 15,
        },
        graceMinutes: 5,
        poll: { backoff: [1], maxAttempts: 3 },
      },
    ]),
  });
  try {
    // The approval round-trip loses the dispatch result: no id, but the goal survives.
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "TOKEN-UNICO-1 varra as paginas" } } })',
    });
    const at = new Date().toISOString();
    f.setObserved({
      data: [
        {
          run_id: "run-4f21",
          status: "COMPLETED",
          goal: "Navigate to https://www.sympla.com.br/eventos/joinville-sc to complete the goal: TOKEN-UNICO-1 varra as paginas",
          created_at: at,
          result: { eventos: [{ nome: "x" }] },
        },
      ],
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "reconciliado e entregue");
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    assert.match(program, /listRuns/, "a leitura é o reconcile do manifesto");
    const row = f.store.get<{
      run_id: string | null;
      delivered_at: number | null;
    }>("SELECT run_id, delivered_at FROM pending_jobs")!;
    assert.equal(row.run_id, "run-4f21");
    assert.ok(row.delivered_at, "linha fechada");
  } finally {
    await f.close();
  }
});

test("a run whose goal is not a suffix of ours is never claimed", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate", idPath: "value.run_id" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { input: { path: { id: "${id}" } } },
          statePath: "status",
          resultPath: "result",
        },
        reconcile: {
          tool: "tools.tinyfish.agent.runs.listRuns",
          args: { input: { query: { goal: "${goal}", limit: 20 } } },
          match: "goalSuffix",
          windowMinutes: 15,
        },
        graceMinutes: 5,
        poll: { backoff: [1], maxAttempts: 3 },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
    });
    f.setObserved({
      data: [
        {
          run_id: "outro",
          status: "COMPLETED",
          goal: "Navigate to https://x to complete the goal: OUTRA-COISA",
          created_at: new Date().toISOString(),
          result: {},
        },
      ],
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "sem aviso dentro da carência");
    assert.equal(
      f.store.get<{ run_id: string | null }>("SELECT run_id FROM pending_jobs")!
        .run_id,
      null,
    );
  } finally {
    await f.close();
  }
});

test("built-in v2 runAsync registers from delegated execute and polls getRunById", async () => {
  const f = await fixture([], [], {});
  try {
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "ETAPA-V2" } } })',
      }),
      true,
    );
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-v2",
    );
    f.setObserved({
      status: "completed",
      execution: {
        ok: true,
        value: { run_id: "run-v2", status: "COMPLETED", result: { ok: true } },
      },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    assert.match(program, /getRunById/);
    assert.match(program, /run-v2/);
    assert.ok(
      f.store.get(
        "SELECT 1 FROM pending_jobs WHERE run_id='run-v2' AND delivered_at IS NOT NULL",
      ),
    );
  } finally {
    await f.close();
  }
});

test("an unknown dispatch path closes the row immediately without waking the user", async () => {
  const f = await fixture([], [], {});
  try {
    await f.jobs.tick();
    f.store.run(
      `INSERT INTO pending_jobs(integration,tool,goal,conversation_id,created_at,next_poll_at)
       VALUES (?,?,?,?,?,?)`,
      "ghost.integration",
      "missing_tool",
      "Liste",
      "7",
      Date.now(),
      Date.now(),
    );
    await f.jobs.tick();
    const row = f.store.get<{
      outcome: string;
      job_state: string;
      delivered_at: number | null;
    }>("SELECT outcome, job_state, delivered_at FROM pending_jobs")!;
    assert.equal(row.outcome, "unrecoverable_tool_path");
    assert.equal(row.job_state, "expired");
    assert.ok(row.delivered_at);
    assert.equal(f.submissions.length, 0);
  } finally {
    await f.close();
  }
});

test("two poller passes on a timed-out row wake the user at most once", async () => {
  const f = await fixture([]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "Liste");
    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?, poll_attempts=? WHERE id=1",
      Date.now() - 60 * 60_000,
      Date.now(),
      3,
    );
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "notified_at impede um segundo aviso na mesma linha",
    );
    assert.ok(
      f.store.get<{ notified_at: number | null }>(
        "SELECT notified_at FROM pending_jobs",
      )?.notified_at,
    );
  } finally {
    await f.close();
  }
});

test("sandbox pick reaches tools whose slug contains a hyphen", async () => {
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.fish-audio.speak",
        dispatch: { mode: "immediate" },
        observe: {
          mode: "poll",
          tool: "tools.fish-audio.status",
          args: { accountId: "acc-test", input: { id: "${id}" } },
          statePath: "status",
          resultPath: "result",
        },
      },
    ]),
  });
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools["fish-audio"].speak({ text: "oi" })',
    });
    f.jobs.capture("tools.fish-audio", "speak", "7", "fish-1");
    f.setObserved({ status: "COMPLETED", result: "done" });
    await f.jobs.tick();
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    assert.match(program, /fish-audio/);
    assert.doesNotMatch(program, /:\s*string/);
  } finally {
    await f.close();
  }
});

test("a slashed tool path is normalized to dots and matches the manifest", async () => {
  assert.equal(
    normalizeToolPath("agent.automation/runAsync"),
    "agent.automation.runAsync",
  );
  assert.equal(
    normalizeToolPath("tools.tinyfish.agent.automation/runAsync"),
    "tools.tinyfish.agent.automation.runAsync",
  );
  const f = await fixture([], [], {});
  try {
    // The provider handed the last separator as a slash, the way jobs 10 and 11 did.
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: 'await tools.tinyfish.agent.automation/runAsync({ input: { body: { goal: "slash" } } })',
      }),
      true,
    );
    const row = f.store.get<{ integration: string; tool: string }>(
      "SELECT integration,tool FROM pending_jobs",
    )!;
    assert.equal(row.integration, "tools.tinyfish.agent.automation");
    assert.equal(row.tool, "tools.tinyfish.agent.automation.runAsync");

    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-slash",
    );
    f.setObserved({
      data: { run_id: "run-slash", status: "COMPLETED", result: { ok: 1 } },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /ok/);
  } finally {
    await f.close();
  }
});

test("a tool path without a manifest is not written, nor does it wake anyone", async () => {
  const f = await fixture([], [], {});
  try {
    assert.equal(
      f.jobs.register("tools", "unknown/runAsync", "7", "fantasma"),
      false,
    );
    assert.equal(
      f.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs",
      )?.total,
      0,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a row with a job id is reconciled by id, even when the goal differs", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "GOAL-ENVIADO" } } })',
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-by-id",
    );
    f.setObserved({
      data: {
        run_id: "run-by-id",
        status: "COMPLETED",
        goal: "um goal totalmente diferente",
        result: { encontrado: true },
      },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /encontrado/);
    const row = f.store.get<{
      run_id: string;
      delivered_at: number | null;
    }>("SELECT run_id,delivered_at FROM pending_jobs")!;
    assert.equal(row.run_id, "run-by-id");
    assert.ok(row.delivered_at);
  } finally {
    await f.close();
  }
});

test("a run completed in 42 seconds is delivered before any timeout", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "rapido" } } })',
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-42s",
    );
    f.store.run("UPDATE pending_jobs SET created_at=?", Date.now() - 42_000);
    f.setObserved({
      data: {
        run_id: "run-42s",
        status: "COMPLETED",
        result: { titulo: "Usinagem360" },
      },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Usinagem360/);
    assert.doesNotMatch(
      f.submissions[0].text,
      /TIMEOUT|ainda não terminou|continua rodando/,
    );
    const row = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
    }>("SELECT delivered_at,outcome FROM pending_jobs")!;
    assert.ok(row.delivered_at);
    assert.equal(row.outcome, "delivered");
  } finally {
    await f.close();
  }
});

test("a terminal run after a running notice is delivered, never warned as a timeout", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "longo" } } })',
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-late",
    );
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 40 * 60_000,
    );
    f.setObserved({
      data: { run_id: "run-late", status: "RUNNING" },
    });
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "o aviso de execução longa sai uma vez",
    );
    assert.match(f.submissions[0].text, /Status: RUNNING/);

    // The provider finished between reads: the next pass must deliver, not warn again.
    f.setObserved({
      data: {
        run_id: "run-late",
        status: "COMPLETED",
        result: { pronto: true },
      },
    });
    f.store.run("UPDATE pending_jobs SET next_poll_at=0");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 2);
    assert.match(f.submissions[1].text, /pronto/);
    assert.doesNotMatch(
      f.submissions[1].text,
      /TIMEOUT|ainda não terminou|continua rodando/,
    );
    assert.ok(
      f.store.get<{ delivered_at: number | null }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
    );
  } finally {
    await f.close();
  }
});

test("a failed re-read is a notice with the last status and the read error", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "sem leitura" } } })',
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-read-error",
    );
    f.setObserved({
      data: { run_id: "run-read-error", status: "RUNNING" },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0);

    // Past the timeout, the provider read fails (the fixture answers 502 when unset).
    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=0",
      Date.now() - 40 * 60_000,
    );
    f.setObserved(undefined);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Última leitura: RUNNING/);
    assert.match(f.submissions[0].text, /502: transient provider failure/);
    assert.doesNotMatch(
      f.submissions[0].text,
      /continua rodando|segue rodando/,
    );
    assert.equal(
      f.store.get<{ delivered_at: number | null }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
      null,
      "a linha segue aberta para uma leitura posterior",
    );
  } finally {
    await f.close();
  }
});

test("two poller passes deliver one message, with the job dedupe key", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: 'await tools.tinyfish.agent.automation.runAsync({ input: { body: { goal: "uma vez" } } })',
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-once",
    );
    f.setObserved({
      data: { run_id: "run-once", status: "COMPLETED", result: { n: 1 } },
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0].requestId, "job:1:run-once");
    assert.ok(
      f.store.get<{ delivered_at: number | null }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
    );
  } finally {
    await f.close();
  }
});

test("status.json lido via content -> DONE entrega uma vez com o link do PR", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-done-1",
      "implementar feature",
    );
    f.setObserved({
      path: "/data/home/jobs/cj-done-1/status.json",
      type: "file",
      size: 150,
      content: JSON.stringify({
        state: "DONE",
        result: {
          pr: "https://github.com/example/repo/pull/123",
          branch: "agent/cj-done-1",
          summary: "Feature implementada com sucesso",
        },
      }),
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "entrega exatamente uma vez");
    assert.match(
      f.submissions[0].text,
      /https:\/\/github\.com\/example\/repo\/pull\/123/,
      "resumo cita o link do PR",
    );
    assert.match(f.submissions[0].text, /Status: DONE/);
  } finally {
    await f.close();
  }
});

test("status.json lido via content -> FAILED entrega erro", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-failed-1",
      "tentar tarefa",
    );
    f.setObserved({
      path: "/data/home/jobs/cj-failed-1/status.json",
      type: "file",
      size: 80,
      content: JSON.stringify({
        state: "FAILED",
        error: "Build falhou: syntax error in index.ts",
      }),
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "entrega uma vez");
    assert.match(
      f.submissions[0].text,
      /Build falhou: syntax error in index\.ts/,
      "erro entregue",
    );
    assert.match(f.submissions[0].text, /FAILED/);
  } finally {
    await f.close();
  }
});

test("404 logo após o disparo é silêncio dentro da carência", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-notfound-1",
      "tarefa recém iniciada",
    );
    // Simula erro 404
    f.setObserved(
      new Error(
        "404: File not found: /data/home/jobs/cj-notfound-1/status.json",
      ),
    );
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      0,
      "silêncio durante a carência de 3 minutos",
    );

    // Passou da carência (3 min) -> agora deve avisar
    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 4 * 60_000,
      Date.now() - 1000,
    );
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "avisa uma vez após carência expirar",
    );
    assert.match(
      f.submissions[0].text,
      /NOT_FOUND|não pôde ser relido|File not found/i,
    );
  } finally {
    await f.close();
  }
});

test("leitura que estoura o timeout não segura o próximo tick", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-timeout-1",
      "tarefa lenta",
    );
    // Simula erro de Timeout da leitura
    f.setObserved(
      new Error("TimeoutError: The operation was aborted due to timeout"),
    );
    await f.jobs.tick();

    // A guarda ticking precisa estar liberada no finally, permitindo que o próximo tick rode
    f.setObserved({
      path: "/data/home/jobs/cj-timeout-1/status.json",
      content: JSON.stringify({
        state: "DONE",
        result: { pr: "https://github.com/example/repo/pull/999" },
      }),
    });
    // Forçar next_poll_at para agora
    f.store.run("UPDATE pending_jobs SET next_poll_at=?", Date.now() - 1000);
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "próximo tick rodou e entregou o resultado",
    );
  } finally {
    await f.close();
  }
});

test("aviso após 25 min (padrão de async_job.timeout_min)", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-25min-1",
      "tarefa longa",
    );
    f.setObserved({
      path: "/data/home/jobs/cj-25min-1/status.json",
      content: JSON.stringify({ state: "RUNNING" }),
    });

    // 20 min ainda está dentro do prazo (25 min padrão)
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 20 * 60_000,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "ainda sem aviso aos 20 min");

    // Aos 26 min ultrapassou 25 min -> avisa
    f.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 26 * 60_000,
    );
    f.store.run("UPDATE pending_jobs SET next_poll_at=?", Date.now() - 1000);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "aviso aos 25 minutos");
    assert.match(f.submissions[0].text, /depois de 25 minutos/i);
  } finally {
    await f.close();
  }
});

test("async job timeout and poll use config.yaml, with env as an override", async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const empty = await mkdtemp(join(tmpdir(), "pi-job-timing-empty-"));
  const root = await mkdtemp(join(tmpdir(), "pi-job-timing-"));
  await writeFile(
    join(root, "config.yaml"),
    ["async_job:", "  timeout_min: 10", "  poll_seconds: 8", ""].join("\n"),
  );
  const instabox = {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
    DATA_DIR: root,
  };
  const plain = await fixture([], [], { DATA_DIR: empty });
  const custom = await fixture([], [], instabox);
  const fromEnv = await fixture([], [], {
    ...instabox,
    ASYNC_JOB_TIMEOUT_MIN: "4",
    ASYNC_JOB_POLL_SECONDS: "3",
  });
  try {
    plain.jobs.start();
    custom.jobs.start();
    fromEnv.jobs.start();
    assert.ok(lines.some((line) => line.includes("poll_interval=25s")));
    assert.ok(lines.some((line) => line.includes("poll_interval=8s")));
    assert.ok(lines.some((line) => line.includes("poll_interval=3s")));
    plain.jobs.close();
    custom.jobs.close();
    fromEnv.jobs.close();

    const running = {
      path: "/data/home/jobs/cj-cfg/status.json",
      content: JSON.stringify({ state: "RUNNING" }),
    };
    custom.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-cfg",
      "tarefa longa",
    );
    custom.setObserved(running);
    custom.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 9 * 60_000,
    );
    await custom.jobs.tick();
    assert.equal(custom.submissions.length, 0, "9 min ainda cabe em 10");
    custom.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 11 * 60_000,
      Date.now() - 1000,
    );
    await custom.jobs.tick();
    assert.equal(custom.submissions.length, 1);
    assert.match(custom.submissions[0].text, /depois de 10 minutos/i);

    fromEnv.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-env",
      "tarefa curta",
    );
    fromEnv.setObserved({
      ...running,
      path: "/data/home/jobs/cj-env/status.json",
    });
    fromEnv.store.run(
      "UPDATE pending_jobs SET created_at=?",
      Date.now() - 3 * 60_000,
    );
    await fromEnv.jobs.tick();
    assert.equal(fromEnv.submissions.length, 0, "3 min ainda cabe em 4");
    fromEnv.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 5 * 60_000,
      Date.now() - 1000,
    );
    await fromEnv.jobs.tick();
    assert.equal(fromEnv.submissions.length, 1);
    assert.match(fromEnv.submissions[0].text, /depois de 4 minutos/i);
  } finally {
    console.info = original;
    await plain.close();
    await custom.close();
    await fromEnv.close();
    await rm(empty, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/** Real Executor `execute` envelopes. `status:"completed"` is the wrapper. */
function executorCompleted(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

function executorFailed(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status: "completed",
          execution: { ok: false, error },
        }),
      },
    ],
  };
}

function assertNeverExpired(submissions: { text: string }[], message: string) {
  for (const submission of submissions)
    assert.doesNotMatch(submission.text, /expirado/i, message);
}

test("status.json no envelope real do Executor entrega o PR e não expira", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-real-1",
      "implementar feature",
    );
    const file = {
      path: "/data/home/jobs/cj-real-1/status.json",
      content: JSON.stringify({
        state: "DONE",
        result: {
          pr: "https://github.com/example/other/pull/7",
          summary: "pronto",
        },
      }),
    };
    // The program JSON.stringifies the tool result, so `execution.value` is a string.
    f.setResult(executorCompleted(JSON.stringify(file)));
    await f.jobs.tick();
    const code = String(
      (f.calls.at(-1)?.args as { code?: string } | undefined)?.code ?? "",
    );
    assert.match(code, /await tools\.instabox\.machines\.readFiles\(/);
    assert.doesNotMatch(code, /==\s*null/);
    assert.equal(f.submissions.length, 1);
    assert.match(
      f.submissions[0].text,
      /https:\/\/github\.com\/example\/other\/pull\/7/,
    );
    assertNeverExpired(f.submissions, "sucesso não é resultado expirado");
  } finally {
    await f.close();
  }
});

test("404 de status.json ausente fica em silêncio na carência e nunca diz expirado", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-missing-1",
      "tarefa recém disparada",
    );
    f.setResult(
      executorFailed({
        kind: "ToolCallFailed",
        message:
          "Instabox 404 not_found: /data/home/jobs/cj-missing-1/status.json",
        response: { code: "not_found", status: 404, message: "not_found" },
      }),
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0, "silêncio dentro da carência");
    assertNeverExpired(f.submissions, "404 na carência não expira");

    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 4 * 60_000,
      Date.now() - 1000,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1, "avisa depois da carência");
    assert.match(f.submissions[0].text, /não pôde ser relido|not_found|404/i);
    assertNeverExpired(f.submissions, "404 depois da carência não expira");
    assert.equal(
      f.store.get<{ delivered_at: number | null; outcome: string | null }>(
        "SELECT delivered_at, outcome FROM pending_jobs",
      )?.outcome,
      null,
    );

    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 30 * 60_000,
      Date.now() - 1000,
    );
    await f.jobs.tick();
    assertNeverExpired(
      f.submissions,
      "status.json ausente nunca produz o aviso de expirado",
    );
  } finally {
    await f.close();
  }
});

test("a poll error names the job, and a stuck missing status file ends at the timeout", async () => {
  const errors: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]) => {
    infos.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  const secret = "Bearer fixture sk-abcdefgh";
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-stuck-1",
      "tarefa que não chegou a começar",
    );
    const detail =
      `File not found: /data/home/jobs/cj-stuck-1/status.json ${secret} ` +
      `${"y".repeat(300)} TAILMARKER`;
    f.setResult(
      executorFailed({
        kind: "ToolCallFailed",
        message: detail,
        response: { code: "not_found", status: 404, message: "not_found" },
      }),
    );
    await f.jobs.tick();
    const rowId = f.store.get<{ id: number }>(
      "SELECT id FROM pending_jobs",
    )!.id;
    const line = errors.find((item) => item.startsWith("jobs_poller: error "));
    assert.ok(line, "cada erro do tick tem uma linha");
    assert.equal(line.includes("\n"), false);
    assert.match(line, new RegExp(`job=${rowId} manifest=`));
    assert.match(line, /manifest=internal\.instabox\.codeTask/);
    assert.match(line, /step=observe/);
    const reason = line.slice(line.indexOf(" error=") + " error=".length);
    assert.ok(reason.length > 0 && reason.length <= 200, reason);
    assert.match(reason, /File not found/);
    assert.doesNotMatch(reason, /sk-abcdefgh/);
    assert.doesNotMatch(reason, /Bearer/);
    assert.doesNotMatch(reason, /TAILMARKER/);
    assert.ok(
      infos.some((item) =>
        /jobs_poller: tick rows_polled=1 delivered=0 errors=1/.test(item),
      ),
      "o resumo do tick continua",
    );
    assert.equal(f.submissions.length, 0, "silêncio dentro da carência");
    assert.equal(
      f.store.get<{ delivered_at: number | null }>(
        "SELECT delivered_at FROM pending_jobs",
      )?.delivered_at,
      null,
    );

    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 4 * 60_000,
      Date.now() - 1000,
    );
    await f.jobs.tick();
    assert.equal(
      f.submissions.length,
      1,
      "o aviso da carência segue o de hoje",
    );
    assert.match(f.submissions[0].text, /não pôde ser relido/);
    assert.doesNotMatch(f.submissions[0].text, /expirado/i);
    const mid = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
    }>("SELECT delivered_at, outcome FROM pending_jobs")!;
    assert.equal(
      mid.delivered_at,
      null,
      "antes do timeout a linha segue aberta",
    );
    assert.equal(mid.outcome, null);

    f.store.run(
      "UPDATE pending_jobs SET created_at=?, next_poll_at=?",
      Date.now() - 26 * 60_000,
      Date.now() - 1000,
    );
    await f.jobs.tick();
    const closed = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
    }>("SELECT delivered_at, outcome FROM pending_jobs")!;
    assert.ok(closed.delivered_at, "depois do timeout a linha fecha");
    assert.equal(closed.outcome, "provider_timeout");
    assert.equal(f.submissions.length, 1, "fechar não avisa de novo");
    assert.doesNotMatch(f.submissions[0].text, /expirado/i);
    assert.ok(
      warns.some((item) => /outcome=provider_timeout/.test(item)),
      "o fechamento fica no log do operador",
    );
    assert.ok(
      warns.every(
        (item) => !item.includes("sk-abcdefgh") && !item.includes("Bearer "),
      ),
    );

    const logged = errors.length;
    await f.jobs.tick();
    assert.equal(errors.length, logged, "a linha fechada não erra de novo");
    assert.equal(f.submissions.length, 1);
    assert.ok(
      infos.some((item) =>
        /jobs_poller: tick rows_polled=0 delivered=0 errors=0/.test(item),
      ),
    );
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    console.warn = originalWarn;
    await f.close();
  }
});

test("InvalidDataValue do Executor não é job concluído nem resultado expirado", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-invalid-1",
      "tarefa",
    );
    f.setResult(
      executorFailed({
        kind: "InvalidDataValue",
        message: "Binary operators require data values. (line 1, col 48)",
      }),
    );
    await f.jobs.tick();
    f.store.run("UPDATE pending_jobs SET next_poll_at=?", Date.now() - 1000);
    await f.jobs.tick();
    assert.equal(f.submissions.length, 0);
    assertNeverExpired(f.submissions, "InvalidDataValue não expira o job");
    const row = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
      job_state: string | null;
    }>("SELECT delivered_at, outcome, job_state FROM pending_jobs")!;
    assert.equal(row.delivered_at, null);
    assert.notEqual(row.outcome, "expired");
    assert.notEqual(row.job_state, "done");
  } finally {
    await f.close();
  }
});

test("DONE sem resultado ainda avisa que expirou de verdade", async () => {
  const f = await fixture([], [], {
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  });
  try {
    f.jobs.registerKnown(
      "chat-1",
      "internal.instabox.codeTask",
      "cj-empty-1",
      "tarefa sem payload",
    );
    f.setResult(
      executorCompleted({
        path: "/data/home/jobs/cj-empty-1/status.json",
        content: JSON.stringify({ state: "DONE" }),
      }),
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /expirado/i);
  } finally {
    await f.close();
  }
});

test("getRunById and listRuns are built as { accountId, input }", () => {
  const account = "acc_explicit_not_a_default";
  const run = "7cdceb90-bb6f-456c-86ef-4b6628a021a4";
  const byId = buildReadInput(
    {
      accountId: "${accountId}",
      input: { path: { id: "${job_id}" } },
    },
    { accountId: account, job_id: run },
  );
  assert.equal(byId.ok, true);
  if (!byId.ok) return;
  assert.deepEqual(byId.input, {
    accountId: account,
    input: { path: { id: run } },
  });
  const listed = buildReadInput(
    {
      input: {
        query: { goal: "${goal}", limit: 20, sort_direction: "desc" },
      },
    },
    { accountId: account, goal: "FECHAMENTO-2026-10-21" },
  );
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(listed.input, {
    accountId: account,
    input: {
      query: {
        goal: "FECHAMENTO-2026-10-21",
        limit: 20,
        sort_direction: "desc",
      },
    },
  });
});

test("a COMPLETED run is delivered from getRunById with the explicit account", async () => {
  const account = "acc_explicit_not_a_default";
  const run = "7cdceb90-bb6f-456c-86ef-4b6628a021a4";
  const f = await fixture([], [], {});
  try {
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: `await tools.tinyfish.agent.automation.runAsync({accountId:'${account}', input:{body:{goal:'FECHAMENTO-2026-10-21'}}})`,
      }),
      true,
    );
    f.jobs.capture("tools.tinyfish.agent.automation", "runAsync", "7", run);
    f.setObserved({
      run_id: run,
      status: "COMPLETED",
      result: { titulo: "Example Domain" },
    });
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Example Domain/);
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    const args = JSON.parse(
      /getRunById\((\{.*\})\)/.exec(program)?.[1] ?? "null",
    );
    assert.deepEqual(args, {
      accountId: account,
      input: { path: { id: run } },
    });
    const row = f.store.get<{ delivered_at: number | null }>(
      "SELECT delivered_at FROM pending_jobs",
    )!;
    assert.ok(row.delivered_at);
  } finally {
    await f.close();
  }
});

test("listRuns reconciliation sends { accountId, input: { query } }", async () => {
  const account = "acc_explicit_not_a_default";
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: `await tools.tinyfish.agent.automation.runAsync({accountId:'${account}', input:{body:{goal:'FECHAMENTO-2026-10-21'}}})`,
    });
    await f.jobs.tick();
    const program = String(
      (f.calls.at(-1)!.args as { code?: string }).code ?? "",
    );
    const args = JSON.parse(
      /listRuns\((\{.*\})\)/.exec(program)?.[1] ?? "null",
    );
    assert.deepEqual(args, {
      accountId: account,
      input: {
        query: {
          goal: "FECHAMENTO-2026-10-21",
          limit: 20,
          sort_direction: "desc",
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("HTTP 422 InputInvalid closes the row immediately", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({accountId:'acc_explicit_not_a_default'})",
    });
    f.jobs.capture(
      "tools.tinyfish.agent.automation",
      "runAsync",
      "7",
      "run-422",
    );
    f.setResult(
      executorFailed({
        kind: "ToolFailure",
        message:
          "InputInvalid (HTTP 422): Input failed validation: input: Expected object {accountId, input}",
        response: { code: "InputInvalid", status: 422, retryable: false },
      }),
    );
    await f.jobs.tick();
    const calls = f.calls.length;
    f.store.run("UPDATE pending_jobs SET next_poll_at=?", Date.now() - 1000);
    await f.jobs.tick();
    assert.equal(f.calls.length, calls, "422 não é relido");
    assert.equal(f.submissions.length, 1);
    const notice = f.submissions[0].text.split("\n")[0] ?? "";
    assert.match(notice, /validação/i);
    assert.match(notice, /Expected object/);
    assert.doesNotMatch(notice, /desconhecido/i);
    const row = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
      job_state: string | null;
      attempts: number;
      last_error: string | null;
    }>(
      "SELECT delivered_at, outcome, job_state, attempts, last_error FROM pending_jobs",
    )!;
    assert.ok(row.delivered_at);
    assert.equal(row.outcome, "input_invalid");
    assert.equal(row.job_state, "failed");
    assert.equal(row.attempts, 0);
    assert.match(row.last_error ?? "", /Expected object/);
  } finally {
    await f.close();
  }
});

test("an unreadable shape does not open a row and disables the tool", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const f = await fixture([], [], {
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        dispatch: { mode: "immediate", idPath: "run_id" },
        observe: {
          mode: "poll",
          tool: "tools.tinyfish.agent.runs.getRunById",
          args: { input: "texto" },
          statePath: "status",
        },
      },
    ]),
  });
  try {
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: "await tools.tinyfish.agent.automation.runAsync({})",
      }),
      false,
    );
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: "await tools.tinyfish.agent.automation.runAsync({})",
      }),
      false,
    );
    assert.equal(
      f.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs",
      )?.total,
      0,
    );
    assert.equal(errors.length, 1, "o alerta sai uma vez");
    assert.match(errors[0]!, /disabled/);
    assert.match(errors[0]!, /Expected object/);
  } finally {
    console.error = original;
    await f.close();
  }
});

test("isInputInvalid is a 422, not a missing file", () => {
  assert.equal(
    isInputInvalid(
      "InputInvalid (HTTP 422): input: Expected object {accountId, input}",
    ),
    true,
  );
  assert.equal(
    isInputInvalid({
      kind: "ToolCallFailed",
      message: "HTTP 404 Not Found",
      response: { status: 404, retryable: false },
    }),
    false,
  );
});

test("varredura reconhece o job em qualquer forma de invocação", () => {
  const path = "tools.tinyfish.agent.automation.runAsync";
  const forms = [
    'await tools.tinyfish.agent.automation.runAsync({ goal: "direto" })',
    'await tools["tinyfish"]["agent"]["automation"]["runAsync"]({ goal: "bracket" })',
    'const call = "runAsync"; await tools.tinyfish.agent.automation[call]({ goal: "variável" })',
    'const automation = tools.tinyfish.agent.automation; await automation.runAsync({ goal: "alias" })',
    'const p = "tinyfish.agent.automation.runAsync"; await tools[p]({ goal: "path" })',
    'const { runAsync } = tools.tinyfish.agent.automation; await runAsync({ goal: "destructuring" })',
    'await tools.tinyfish.agent.automation/runAsync({ goal: "slash" })',
  ];
  for (const code of forms)
    assert.deepEqual(matchDelegatedTools({ code }, [path]), [path], code);
});

test("capture abre a linha normalizada com o run_id quando a varredura não a abriu", async () => {
  const f = await fixture([], [], {});
  try {
    const payload = {
      code: 'const p = "tinyfish.agent.automation.runAsync"; await tools[p]({ goal: "capturado" })',
    };
    assert.equal(
      f.jobs.capture(
        "tools.tinyfish.agent.automation",
        "runAsync",
        "7",
        "run-captured",
        payload,
      ),
      true,
    );
    const row = f.store.get<{
      integration: string;
      tool: string;
      run_id: string;
    }>("SELECT integration,tool,run_id FROM pending_jobs")!;
    assert.equal(row.integration, "tools.tinyfish.agent.automation");
    assert.equal(row.tool, "tools.tinyfish.agent.automation.runAsync");
    assert.equal(row.run_id, "run-captured");
  } finally {
    await f.close();
  }
});

test("sem conta na chamada e sem conta no catálogo o tópico recebe missing_account", async () => {
  const f = await fixture([], [], {});
  f.setCatalog({ namespaces: [] });
  try {
    f.jobs.start();
    assert.equal(f.jobs.health().enabled, true);
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: 'await tools.tinyfish.agent.automation.runAsync({ goal: "sem conta" })',
      }),
      true,
    );
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    const notice = f.submissions[0].text.split("\n")[0] ?? "";
    assert.match(notice, /missing_account/);
    assert.doesNotMatch(notice, /desconhecido/i);
    const row = f.store.get<{
      delivered_at: number | null;
      outcome: string | null;
    }>("SELECT delivered_at, outcome FROM pending_jobs")!;
    assert.ok(row.delivered_at);
    assert.equal(row.outcome, "missing_account");
  } finally {
    await f.close();
  }
});

test("cada tick publica contadores, inclusive quando não há linhas", async () => {
  const f = await fixture([], [], {});
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await f.jobs.tick();
    assert.ok(
      lines.some((line) =>
        /jobs_poller: tick rows_polled=0 delivered=0 errors=0/.test(line),
      ),
      "tick vazio continua visível",
    );
    assert.deepEqual(f.jobs.health().last_tick, {
      at: f.jobs.health().last_tick!.at,
      rows_polled: 0,
      delivered: 0,
      errors: 0,
    });
  } finally {
    console.info = original;
    await f.close();
  }
});

test("runAsync via execute entrega o resultado sem env de conta", async () => {
  const account = "acc_from_the_call";
  const run = "8871d083-2a94-45fb-ab51-e11e85cfebb8";
  const goal =
    "POS-PI-2026-10-21: abra https://example.com e devolva o titulo da pagina";
  const f = await fixture([], [], {});
  f.setCatalog({
    namespaces: [
      {
        path: "tools.tinyfish",
        accounts: "tinyfish: acc-other-catalog (Default)",
      },
    ],
  });
  try {
    const args = {
      code: `await tools.tinyfish.agent.automation.runAsync({accountId:'${account}', input:{body:{url:'https://example.com', goal:'${goal}'}}})`,
    };
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "completed",
            execution: {
              ok: true,
              value: { run_id: run, status: "PENDING", goal },
            },
          }),
        },
      ],
    };
    const job = f.jobs.beginDispatch("7", "executor", "execute", args);
    assert.equal(job, true);
    const dispatch = f.jobs.finishDispatch(
      "7",
      "executor",
      "execute",
      args,
      envelope,
    );
    assert.equal(dispatch.runId, run);
    assert.equal(
      dispatch.completed,
      false,
      "status completed do envelope é o programa, não o job",
    );
    assert.doesNotThrow(() =>
      f.jobs.finishDispatch("7", "executor", "execute", args, envelope),
    );
    assert.equal(
      f.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs WHERE run_id=?",
        run,
      )?.total,
      1,
      "o segundo registro do mesmo run_id não abre outra linha",
    );
    assert.match(
      envelope.content[0].text,
      new RegExp(run),
      "o retorno da tool continua sendo o run_id do provedor",
    );
    const opened = f.store.get<{
      account_id: string | null;
      run_id: string | null;
      delivered_at: number | null;
    }>("SELECT account_id, run_id, delivered_at FROM pending_jobs")!;
    assert.equal(opened.account_id, account);
    assert.equal(opened.run_id, run);
    assert.equal(opened.delivered_at, null);
    f.setObserved({
      run_id: run,
      status: "COMPLETED",
      result: { titulo: "Example Domain" },
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Example Domain/);
    const reads = f.calls.filter((call) => call.tool === "execute");
    assert.equal(reads.length, 1);
    const program = String(reads[0]?.args.code ?? "");
    const read = JSON.parse(
      /getRunById\((\{.*\})\)/.exec(program)?.[1] ?? "null",
    );
    assert.deepEqual(read, {
      accountId: account,
      input: { path: { id: run } },
    });
    assert.equal(
      f.calls.filter((call) => call.tool === "search").length,
      0,
      "a conta da chamada dispensa o catálogo",
    );
  } finally {
    await f.close();
  }
});

test("runAsync via call também entrega uma vez", async () => {
  const account = "acc_from_call";
  const run = "8871d083-2a94-45fb-ab51-e11e85cfebb8";
  const f = await fixture([], [], {});
  try {
    const args = {
      path: "tools.tinyfish.agent.automation.runAsync",
      input: {
        accountId: account,
        input: {
          body: {
            url: "https://example.com",
            goal: "POS-PI via call",
          },
        },
      },
    };
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "completed",
            execution: {
              ok: true,
              value: { run_id: run, status: "RUNNING" },
            },
          }),
        },
      ],
    };
    const job = f.jobs.beginDispatch("7", "executor", "call", args);
    assert.equal(job, true);
    f.jobs.finishDispatch("7", "executor", "call", args, envelope);
    f.setObserved({
      run_id: run,
      status: "COMPLETED",
      result: { titulo: "Example Domain" },
    });
    await f.jobs.tick();
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /Example Domain/);
    const program = String(
      f.calls.filter((call) => call.tool === "execute").at(-1)?.args.code ?? "",
    );
    assert.match(program, new RegExp(account));
  } finally {
    await f.close();
  }
});

test("duas contas no catálogo sem conta na chamada fecham com ambiguous_account", async () => {
  const f = await fixture([], [], {});
  f.setCatalog({
    namespaces: [
      {
        path: "tools.tinyfish",
        accounts: "tinyfish: acc-one-aaaa (Default), acc-two-bbbb (Other)",
      },
    ],
  });
  try {
    assert.equal(
      f.jobs.registerDelegated("7", {
        code: 'await tools.tinyfish.agent.automation.runAsync({ goal: "duas contas" })',
      }),
      true,
    );
    await f.jobs.tick();
    const notice = f.submissions[0]?.text.split("\n")[0] ?? "";
    assert.match(notice, /ambiguous_account/);
    assert.match(notice, /acc-one-aaaa/);
    assert.match(notice, /acc-two-bbbb/);
    assert.doesNotMatch(notice, /desconhecido/i);
    assert.equal(
      f.store.get<{ outcome: string }>("SELECT outcome FROM pending_jobs")
        ?.outcome,
      "ambiguous_account",
    );
  } finally {
    await f.close();
  }
});

test("o mesmo run_id real não é inserido duas vezes e várias linhas sem id convivem", async () => {
  const run = "c7f42ac4-f479-4ef1-9ad4-9fd0d7a82e1f";
  const account = "acc_from_the_call";
  const f = await fixture([], [], {});
  try {
    const args = {
      code: `await tools.tinyfish.agent.automation.runAsync({accountId:'${account}', input:{body:{goal:'POS-99: abra https://example.com e devolva o titulo'}}})`,
    };
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "completed",
            execution: {
              ok: true,
              value: { run_id: run, status: "PENDING" },
            },
          }),
        },
      ],
    };
    const job = f.jobs.beginDispatch("7", "executor", "execute", args);
    assert.equal(job, true);
    // The poller can claim the id while execute is still in flight.
    f.store.run("UPDATE pending_jobs SET run_id=? WHERE run_id IS NULL", run);
    let thrown: unknown;
    let dispatchRun: string | undefined;
    try {
      dispatchRun = f.jobs.finishDispatch(
        "7",
        "executor",
        "execute",
        args,
        envelope,
      ).runId;
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, undefined);
    assert.equal(dispatchRun, run);
    assert.match(envelope.content[0].text, new RegExp(run));
    assert.equal(
      f.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs",
      )?.total,
      1,
    );
    assert.equal(
      f.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs WHERE run_id=''",
      )?.total,
      0,
    );
    assert.equal(
      f.jobs.capture("executor", "execute", "7", "   ", args),
      false,
    );
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "um"),
      true,
    );
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "dois"),
      true,
    );
    assert.equal(
      f.jobs.register(SERVER, "run_web_automation", "7", "tres"),
      true,
    );
    const blanks = f.store.all<{ run_id: string | null }>(
      "SELECT run_id FROM pending_jobs WHERE run_id IS NULL",
    );
    assert.equal(blanks.length, 3);
    assert.ok(blanks.every((row) => row.run_id === null));
  } finally {
    await f.close();
  }
});
