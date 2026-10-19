import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  deterministicFailure,
  dispatchOutcome,
  PendingJobs,
  programPayload,
} from "../src/pending-jobs.js";
import type { Runtime } from "../src/runtime.js";

const TOOL = "tinyfish_mcp.user.personalTinyfishMcp.run_web_automation";
const SERVER = "tinyfish_mcp.user.personalTinyfishMcp";

/** A Runtime stand-in: the store, a gateway that answers list_runs, and submit. */
async function fixture(
  runs: unknown[],
  pages: unknown[][] = [],
  env: Record<string, string | undefined> = { ASYNC_JOB_TOOLS: TOOL },
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pending-jobs-"));
  const store = new Store(dir);
  const submissions: {
    conversationId: string;
    text: string;
    source: string;
  }[] = [];
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let observed: unknown;
  const gateway = {
    callDirect: async (
      _server: string,
      tool: string,
      args: Record<string, unknown>,
    ) => {
      calls.push({ tool, args });
      // The poller goes through `execute`, so the filter travels inside the program.
      const program = String((args as { code?: string }).code ?? "");
      if (!program.includes("list_runs")) {
        // A poll manifest names its own status tool; the test decides what it answers.
        if (observed === undefined)
          throw new Error("502: transient provider failure");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                data: {
                  content: [{ type: "text", text: JSON.stringify(observed) }],
                },
              }),
            },
          ],
        };
      }
      const filter = JSON.parse(
        /(?<=list_runs"\)\()\{.*\}(?=\)\);)/s.exec(program)?.[0] ?? "{}",
      ) as {
        created_after?: string;
        created_before?: string;
        limit?: unknown;
        sort_direction?: unknown;
        cursor?: string;
      };
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
      // The real shape nests three times: MCP result, execute envelope (ok/data/content),
      // then the payload the program returned.
      const payload = {
        data: page,
        pagination:
          index + 1 < pages.length
            ? { has_more: true, next_cursor: String(index + 1) }
            : { has_more: false },
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              data: {
                content: [{ type: "text", text: JSON.stringify(payload) }],
              },
            }),
          },
        ],
      };
    },
  };
  const app = {
    store,
    options: { gateway },
    submit: async (
      conversationId: string,
      _requestId: string,
      text: string,
      source: string,
    ) => {
      submissions.push({ conversationId, text, source });
      return {};
    },
  };
  const jobs = new PendingJobs(app as unknown as Runtime, env);
  return {
    store,
    setObserved: (value: unknown) => {
      observed = value;
    },
    jobs,
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
      created_at: new Date().toISOString(),
    },
  ]);
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "raspar");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.match(f.submissions[0].text, /FAILED/);
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

test("a run on a second page is still found", async () => {
  const f = await fixture(
    [],
    [
      [],
      [
        {
          run_id: "run-page-2",
          status: "COMPLETED",
          goal: "segundo item",
          created_at: new Date().toISOString(),
          result: { ok: true },
        },
      ],
    ],
  );
  try {
    f.jobs.register(SERVER, "run_web_automation", "7", "segundo item");
    await f.jobs.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.calls.length, 2, "seguiu o next_cursor");
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
  // A transport error or a 5xx may have created the run: the row must survive.
  assert.equal(
    deterministicFailure(text("Internal tool error [088cc443]")),
    false,
  );
  assert.equal(deterministicFailure(text('{"status":503}')), false);
  assert.equal(deterministicFailure(undefined), false);
});

test("an integration without list_runs is left alone instead of erroring every tick", async () => {
  const f = await fixture([]);
  try {
    // A provider that does not implement the sibling tool.
    f.jobs.register(SERVER, "run_web_automation", "7", "x");
    const broken = {
      callDirect: async () => {
        throw new Error("tool not found");
      },
    };
    // Replace the gateway the poller reads.
    Object.assign(
      (f.jobs as unknown as { app: { options: object } }).app.options,
      {
        gateway: broken,
      },
    );
    for (let pass = 0; pass < 4; pass += 1) await f.jobs.tick();
    // Three failures disable the group; the fourth pass does not try again.
    assert.equal(
      (f.jobs as unknown as { failing: Map<string, number> }).failing.get(
        `${SERVER}|run_web_automation`,
      ),
      3,
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
      for (let pass = 0; pass < 4; pass += 1) await f.jobs.tick();
    } finally {
      console.warn = warn;
    }
    const row = f.store.get<{
      attempts: number;
      outcome: string;
      delivered_at: number | null;
    }>("SELECT attempts,outcome,delivered_at FROM pending_jobs")!;
    assert.equal(row.attempts, 3);
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
        "const r = await tools.tinyfish_mcp.user.personalTinyfishMcp.run_web_automation({",
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
    assert.equal(row.tool, "run_web_automation");
    assert.match(row.goal, /ETAPA3-2026-10-19/);
    assert.equal(row.delivered_at, null);
  } finally {
    await f.close();
  }
});

test("without a goal the run is matched by the window it was dispatched in", async () => {
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
    assert.equal(f.submissions.length, 1, "casou pela janela, sem goal");
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
    assert.match(code, /tinyfish_mcp\.user\.personalTinyfishMcp\.list_runs/);
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
        dedupe: "job:${row}:${id}",
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
        dedupe: "job:${row}:${id}",
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
        dedupe: "job:${row}:${id}",
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
      code: "await tools.tinyfish.agent.automation.runAsync({})",
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

test("the built-in v2 manifest needs no configuration at all", async () => {
  const f = await fixture([], [], {});
  try {
    f.jobs.registerDelegated("7", {
      code: "await tools.tinyfish.agent.automation.runAsync({})",
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
    // v2 binds the account in the tool signature; nothing comes from the environment.
    assert.doesNotMatch(program, /accountId/);
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
