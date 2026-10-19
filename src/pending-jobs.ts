import type { Runtime } from "./runtime.js";
import {
  applyTemplate,
  dedupeKey,
  isTerminal,
  jobState,
  loadManifests,
  readPath,
  tolerantExtract,
  type JobManifest,
  type JobState,
} from "./job-manifest.js";

/** One line of `pending_jobs`: a run registered when the tool was dispatched. */
export interface PendingJob {
  id: number;
  integration: string;
  tool: string;
  run_id: string | null;
  goal: string | null;
  conversation_id: string;
  created_at: number;
  delivered_at: number | null;
  /** Set when the "still running" notice was sent, so it is not repeated. */
  notified_at: number | null;
  outcome: string | null;
  /** The result a synchronous dispatch already returned, kept until the turn delivers. */
  result: string | null;
  /** Failed delivery attempts; the row expires instead of retrying for ever. */
  attempts: number;
  /** When the worker may ask the provider again (ms since epoch). */
  next_poll_at: number;
  /** Last normalized state the provider reported. */
  job_state: string | null;
}

interface JobTool {
  /** `server.tool` path that starts the job, from a manifest. */
  path: string;
  server: string;
  tool: string;
  /** Sibling tool the poller uses to read runs; `list_runs` by default. */
  list: { server: string; tool: string; path: string };
  manifest: JobManifest;
}

const DEFAULT_TIMEOUT_MIN = 30;
const DEFAULT_POLL_SECONDS = 25;
/** How far before the registration a run may have been created. */
const SLACK_MS = 5 * 60 * 1000;
/** How long a job-born turn blocks new registrations before it is assumed dead. */
const JOB_TURN_TTL_MS = 10 * 60 * 1000;
/** Delivery attempts before a job result is given up (the crash repeats, the loop stops). */
const MAX_ATTEMPTS = 3;
/** How long a closed job waits for a `sent` delivery before the operator is told. */
const DELIVERY_CHECK_MS = 10 * 60 * 1000;
/** How long a dispatched result waits for its turn before the poller resends it. */
const DISPATCH_GRACE_MS = 3 * 60 * 1000;
/** Consecutive list failures before an integration is left alone. */
const MAX_LIST_FAILURES = 3;

/**
 * Jobs that outlive the turn. A tool may start one and return before it finishes; the
 * poller below wakes a turn when the run completes, so the result is not orphaned.
 *
 * Registration happens where the tool is dispatched (`conversationId` in scope), and a
 * pre-registration without `run_id` covers the case where the call died before returning
 * one: the poller reconciles by `goal` and creation time.
 */
export class PendingJobs {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Conversations running a job-born turn, with the moment they entered it. */
  private readonly jobTurns = new Map<string, number>();
  /** Consecutive list failures per integration, to stop polling a tool that is not there. */
  private readonly failing = new Map<string, number>();

  constructor(
    private app: Runtime,
    private env: Record<string, string | undefined> = process.env,
  ) {}

  /**
   * Created on first use: the field is built before Runtime has a store, and the poller
   * must work on an app whose tasks never opened.
   */
  private ready = false;
  private ensure() {
    if (this.ready) return;
    this.app.store.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_jobs(
        id INTEGER PRIMARY KEY AUTOINCREMENT, integration TEXT NOT NULL, tool TEXT NOT NULL,
        run_id TEXT, goal TEXT, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        delivered_at INTEGER, notified_at INTEGER, outcome TEXT, result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_jobs_run ON pending_jobs(run_id);
      CREATE INDEX IF NOT EXISTS pending_jobs_open ON pending_jobs(delivered_at);
    `);
    // A database created by the first version of this table lacks the columns below;
    // SQLite cannot add them with IF NOT EXISTS, so the presence check is explicit.
    const columns = this.app.store
      .all<{ name: string }>("PRAGMA table_info(pending_jobs)")
      .map((column) => column.name);
    if (!columns.includes("notified_at"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN notified_at INTEGER",
      );
    if (!columns.includes("outcome"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN outcome TEXT",
      );
    if (!columns.includes("result"))
      this.app.store.db.exec("ALTER TABLE pending_jobs ADD COLUMN result TEXT");
    if (!columns.includes("attempts"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      );
    // Per-row scheduling: the worker asks only what is due, with backoff per manifest.
    if (!columns.includes("next_poll_at"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.includes("job_state"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN job_state TEXT",
      );
    this.ready = true;
  }

  /** The MCP server that runs programs; the integration is reached inside it. */
  private executorServer() {
    return this.env.ASYNC_JOB_EXECUTOR?.trim() || "executor";
  }

  /** Manifests describe every provider detail; the core never names a tool. */
  private manifests(): JobManifest[] {
    try {
      return loadManifests(this.env);
    } catch (error) {
      console.warn(
        `Jobs assíncronos: manifesto inválido (${(error as Error).message}); desligado.`,
      );
      return [];
    }
  }

  private tools(): JobTool[] {
    return this.manifests().map((manifest) => {
      const parts = manifest.tool.split(".");
      const tool = parts.pop() ?? "";
      // The path addresses the integration: the list sibling lives on the same prefix.
      return {
        path: manifest.tool,
        server: parts.join("."),
        tool,
        list: {
          server: parts.join("."),
          tool: "list_runs",
          path: `${manifest.tool.slice(0, manifest.tool.lastIndexOf("."))}.list_runs`,
        },
        manifest,
      };
    });
  }

  private timeoutMs() {
    const minutes = Number(this.env.ASYNC_JOB_TIMEOUT_MIN);
    return (
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_TIMEOUT_MIN) * 60_000
    );
  }

  private pollMs() {
    const seconds = Number(this.env.ASYNC_JOB_POLL_SECONDS);
    return (
      (Number.isFinite(seconds) && seconds > 0
        ? seconds
        : DEFAULT_POLL_SECONDS) * 1000
    );
  }

  /** The tool config for a dispatched call, when it is one that starts a job. */
  private match(server: string, tool: string) {
    return this.tools().find(
      (entry) => entry.server === server && entry.tool === tool,
    );
  }

  /**
   * Records a job before the call, so a lost response is still covered. Returns false
   * when the tool is not an async job or the conversation is inside a job-born turn.
   */
  register(
    server: string,
    tool: string,
    conversationId: string,
    goal: string | undefined,
  ) {
    this.ensure();
    const entry = this.match(server, tool);
    if (!entry || this.inJobTurn(conversationId)) return false;
    this.app.store.run(
      "INSERT INTO pending_jobs(integration,tool,goal,conversation_id,created_at) VALUES (?,?,?,?,?)",
      entry.server,
      entry.tool,
      goal ?? null,
      conversationId,
      Date.now(),
    );
    return true;
  }

  /**
   * A dispatch that already returned the result. The row stays open: the turn can still
   * die before delivering (the crash seen after a tool returns), and then the poller sends
   * the stored result instead of losing it.
   */
  markDispatchedResult(
    server: string,
    tool: string,
    conversationId: string,
    result: string,
  ) {
    if (!this.match(server, tool)) return;
    this.ensure();
    this.app.store.run(
      `UPDATE pending_jobs SET outcome='dispatch_result',result=? WHERE id=(
         SELECT id FROM pending_jobs WHERE integration=? AND tool=? AND
           conversation_id=? AND delivered_at IS NULL ORDER BY id LIMIT 1)`,
      result,
      server,
      tool,
      conversationId,
    );
  }
  /**
   * The turn settled, so its reply is in the durable delivery list: the dispatched result
   * arrived and the row closes.
   */
  settleTurn(conversationId: string) {
    this.ensure();
    this.app.store.run(
      `UPDATE pending_jobs SET delivered_at=? WHERE conversation_id=? AND
         outcome='dispatch_result' AND delivered_at IS NULL`,
      Date.now(),
      conversationId,
    );
  }
  /**
   * Registers the job tools whose name appears in a delegated call. The Executor's
   * `execute` runs the integration inside its sandbox, so the direct-tool hook never sees
   * `run_web_automation`; the code the model sent does, and that is enough to know a run
   * may exist.
   */
  /** Registers a job dispatched inside the Executor's `execute`; true if a row opened. */
  registerDelegated(conversationId: string, payload: unknown) {
    if (this.inJobTurn(conversationId)) return false;
    const text = (
      typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
    ).replace(/\\"/g, '"');
    let opened = false;
    for (const entry of this.tools()) {
      if (!new RegExp(`\\b${entry.tool}\\b`).test(text)) continue;
      const goal = /["'`]?goal["'`]?\s*[:=]\s*["'`]([^"'`]{3,300})["'`]/i.exec(
        text,
      )?.[1];
      if (this.register(entry.server, entry.tool, conversationId, goal))
        opened = true;
    }
    return opened;
  }
  /**
   * The dispatch failed deterministically (a 400, a bad session id): no run exists, so the
   * row closes now instead of waiting for a timeout that would blame the provider.
   */
  closeUnstarted(server: string, tool: string, conversationId: string) {
    if (!this.match(server, tool)) return;
    this.ensure();
    this.app.store.run(
      `UPDATE pending_jobs SET delivered_at=?,outcome='dispatch_error'
       WHERE id=(SELECT id FROM pending_jobs WHERE integration=? AND tool=? AND
         conversation_id=? AND delivered_at IS NULL ORDER BY id LIMIT 1)`,
      Date.now(),
      server,
      tool,
      conversationId,
    );
  }
  /** Attaches the run id a successful dispatch returned to its pre-registration. */
  capture(server: string, tool: string, conversationId: string, runId: string) {
    this.ensure();
    if (!this.match(server, tool)) return;
    this.app.store.run(
      `UPDATE pending_jobs SET run_id=? WHERE id=(
         SELECT id FROM pending_jobs WHERE integration=? AND tool=? AND conversation_id=?
         AND run_id IS NULL AND delivered_at IS NULL ORDER BY id LIMIT 1)`,
      runId,
      server,
      tool,
      conversationId,
    );
  }

  /** A turn born from a job must not start another one. */
  enterJobTurn(conversationId: string) {
    this.jobTurns.set(conversationId, Date.now());
  }
  /**
   * A turn that dies without settling would otherwise block jobs forever, so the mark
   * expires on its own.
   */
  private inJobTurn(conversationId: string) {
    const since = this.jobTurns.get(conversationId);
    if (since === undefined) return false;
    if (Date.now() - since > JOB_TURN_TTL_MS) {
      this.jobTurns.delete(conversationId);
      return false;
    }
    return true;
  }

  leaveJobTurn(conversationId: string) {
    this.jobTurns.delete(conversationId);
  }

  /** The rows this tick may ask about: open, and past their own next poll. */
  private pending() {
    return this.app.store.all<PendingJob>(
      "SELECT * FROM pending_jobs WHERE delivered_at IS NULL AND next_poll_at <= ? ORDER BY next_poll_at, id",
      Date.now(),
    );
  }

  /** How long a job may be invisible before the wait becomes a notice. */
  private graceMs(manifest: JobManifest) {
    const minutes = manifest.graceMinutes;
    return (
      (Number.isFinite(minutes) && (minutes ?? 0) > 0 ? minutes! : 5) * 60_000
    );
  }

  /** Seconds until the next read, from the manifest's backoff ladder. */
  private backoffMs(manifest: JobManifest, attempts: number) {
    const ladder = manifest.poll?.backoff ?? [];
    const seconds =
      ladder[Math.min(Math.max(attempts - 1, 0), ladder.length - 1)] ??
      manifest.poll?.intervalSeconds ??
      DEFAULT_POLL_SECONDS;
    return Math.max(5, Number(seconds) || DEFAULT_POLL_SECONDS) * 1000;
  }

  /** Records what the provider said and when it may be asked again. */
  private noteState(
    row: PendingJob,
    manifest: JobManifest,
    state: JobState,
    attempts?: number,
  ) {
    const retry = attempts ?? row.attempts;
    this.app.store.run(
      "UPDATE pending_jobs SET job_state=?, attempts=?, next_poll_at=? WHERE id=?",
      state,
      retry,
      isTerminal(state)
        ? row.next_poll_at
        : Date.now() + this.backoffMs(manifest, retry),
      row.id,
    );
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* The next tick retries; a poll failure is not a user-facing event. */
      });
    }, this.pollMs());
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Settlement means the reply left the application, not that Telegram delivered it - the
   * attachment buffer taught that. A closed job whose request has no `sent` delivery is
   * reported to the operator, once, instead of vanishing.
   */
  private checkDelivered(now: number) {
    for (const row of this.app.store.all<PendingJob>(
      "SELECT * FROM pending_jobs WHERE outcome='dispatch_result' AND delivered_at IS NOT NULL",
    )) {
      if (now - (row.delivered_at ?? 0) < DELIVERY_CHECK_MS) continue;
      const prefix = `${row.conversation_id}:job:${row.id}:${row.run_id ?? "unknown"}`;
      const sent = this.app.store.get(
        "SELECT 1 FROM deliveries WHERE id>=? AND id<? AND state='sent'",
        `${prefix}:`,
        `${prefix};`,
      );
      if (sent) {
        this.app.store.run(
          "UPDATE pending_jobs SET outcome='delivered' WHERE id=?",
          row.id,
        );
        continue;
      }
      this.app.store.run(
        "UPDATE pending_jobs SET outcome='delivery_unconfirmed' WHERE id=?",
        row.id,
      );
      console.warn(
        `Job assíncrono ${row.run_id ?? row.id}: o turno terminou mas nenhuma entrega foi confirmada. O resultado está em pending_jobs.result.`,
      );
    }
  }
  /** One reconciliation pass. Public for the timer and for tests. */
  async tick() {
    this.ensure();
    if (this.ticking) return;
    const pending = this.pending();
    this.ticking = true;
    try {
      this.checkDelivered(Date.now());
      if (!pending.length) return;
      // Only a gateway that can reach a direct connection has runs to read.
      const gateway = this.app.options.gateway as
        | {
            callDirect?: (
              server: string,
              tool: string,
              args: Record<string, unknown>,
              options: object,
            ) => Promise<unknown>;
          }
        | undefined;
      if (!gateway?.callDirect) return;
      const groups = new Map<string, PendingJob[]>();
      for (const row of pending) {
        const key = `${row.integration}|${row.tool}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [key, rows] of groups) {
        const [integration, tool] = key.split("|");
        const entry = this.match(integration, tool);
        if (!entry) continue;
        // Any manifest that names a read tool (poll or reconcile) is asked here, with its
        // own arguments. Whether one job or a list comes back is the provider's business;
        // the manifest says where the fields live.
        const observe = entry.manifest.observe;
        if (
          !entry.manifest.synthetic &&
          observe.mode !== "webhook" &&
          observe.tool
        ) {
          for (const row of rows) {
            // No id (an approval round-trip loses the dispatch result): ask the provider
            // which job carries our goal, and claim it only when the answer is unique.
            const reconcile = entry.manifest.reconcile;
            if (!row.run_id && reconcile) {
              try {
                const args = applyTemplate(reconcile.args, {
                  id: "",
                  row: row.id,
                  goal: row.goal ?? undefined,
                  since: new Date(row.created_at - SLACK_MS).toISOString(),
                  now: new Date().toISOString(),
                  account: entry.manifest.observe.accountArg ?? "",
                });
                const executed = await gateway.callDirect(
                  this.executorServer(),
                  "execute",
                  {
                    code: sandboxCall(reconcile.tool, args),
                  },
                  {},
                );
                const window =
                  Date.now() - (reconcile.windowMinutes ?? 15) * 60_000;
                const candidates = runsOf(
                  programResult(executed),
                  entry.manifest,
                ).filter(
                  (run) =>
                    !this.app.store.get(
                      "SELECT 1 FROM pending_jobs WHERE run_id=? AND id<>?",
                      run.run_id,
                      row.id,
                    ) &&
                    run.created_at >=
                      Math.min(window, row.created_at - SLACK_MS) &&
                    // Without the goal we sent there is nothing to match: claiming the
                    // only run in the window would eventually deliver someone else's job.
                    !!row.goal &&
                    (reconcile.match === "goalExact"
                      ? (run.goal ?? "").trim().toLowerCase() ===
                        row.goal.trim().toLowerCase()
                      : this.sameGoal(run.goal, row.goal)),
                );
                if (candidates.length > 1) {
                  this.app.store.run(
                    "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                  if (!row.notified_at)
                    await this.warn(row, {
                      run_id: "?",
                      state: "unknown",
                      status: "AMBIGUOUS",
                      created_at: row.created_at,
                    });
                  continue;
                }
                if (candidates.length === 1) {
                  const run = candidates[0]!;
                  this.app.store.run(
                    "UPDATE pending_jobs SET run_id=? WHERE id=?",
                    run.run_id,
                    row.id,
                  );
                  this.noteState(row, entry.manifest, run.state, 0);
                  await this.settle(row, [run]);
                  continue;
                }
                // Nothing yet: silence inside the grace window, a notice after it.
                if (Date.now() - row.created_at > this.graceMs(entry.manifest))
                  await this.settle(row, []);
                else
                  this.app.store.run(
                    "UPDATE pending_jobs SET next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                continue;
              } catch {
                this.app.store.run(
                  "UPDATE pending_jobs SET attempts=attempts+1, next_poll_at=? WHERE id=?",
                  Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
                  row.id,
                );
                continue;
              }
            }
            if (!row.run_id && observe.mode === "poll") continue;
            try {
              const args = applyTemplate(observe.args ?? {}, {
                id: row.run_id ?? "",
                row: row.id,
                goal: row.goal ?? undefined,
                since: new Date(row.created_at - SLACK_MS).toISOString(),
                now: new Date().toISOString(),
              });
              const executed = await gateway.callDirect(
                this.executorServer(),
                "execute",
                {
                  code: sandboxCall(observe.tool, args),
                },
                {},
              );
              const payload = programResult(executed);
              const found = runsOf(payload, entry.manifest);
              if (found.length) {
                const candidates = row.run_id
                  ? found.filter((run) => run.run_id === row.run_id)
                  : found.filter(
                      (run) =>
                        !this.app.store.get(
                          "SELECT 1 FROM pending_jobs WHERE run_id=? AND id<>?",
                          run.run_id,
                          row.id,
                        ) &&
                        (!row.goal || this.sameGoal(run.goal, row.goal)) &&
                        run.created_at >= row.created_at - SLACK_MS,
                    );
                if (!row.run_id && candidates.length > 1) {
                  // Two jobs could be this one: claiming either would deliver the wrong
                  // result, so the row waits and says so once.
                  this.app.store.run(
                    "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                  if (!row.notified_at)
                    await this.warn(row, {
                      run_id: "?",
                      state: "unknown",
                      status: "AMBIGUOUS",
                      created_at: row.created_at,
                    });
                  continue;
                }
                if (candidates.length === 1) {
                  const run = candidates[0]!;
                  if (!row.run_id)
                    this.app.store.run(
                      "UPDATE pending_jobs SET run_id=? WHERE id=?",
                      run.run_id,
                      row.id,
                    );
                  this.noteState(row, entry.manifest, run.state, 0);
                  await this.settle(row, [run]);
                }
                continue;
              }
              // Only a row that knows its id may read a single-job payload; a row still
              // waiting for an id must never claim whatever came back.
              if (!row.run_id) continue;
              const single = this.runFromPayload(
                entry.manifest,
                payload,
                row.run_id,
              );
              if (single) {
                this.noteState(row, entry.manifest, single.state, 0);
                await this.settle(row, [single]);
              }
            } catch {
              const count = (this.failing.get(key) ?? 0) + 1;
              this.failing.set(key, count);
              // Backoff per row, and a pause that always lifts: a provider that is down
              // must not turn into permanent silence.
              this.app.store.run(
                "UPDATE pending_jobs SET attempts=attempts+1, next_poll_at=? WHERE id=?",
                Date.now() + this.backoffMs(entry.manifest, count),
                row.id,
              );
              const max = entry.manifest.poll?.maxAttempts ?? MAX_LIST_FAILURES;
              if (count === max)
                console.warn(
                  `Jobs assíncronos: ${entry.path} falhou ${count} vezes seguidas; seguindo com backoff.`,
                );
            }
          }
          continue;
        }
        const since = Math.min(...rows.map((row) => row.created_at)) - SLACK_MS;
        // limit and sort_direction are required by the provider; has_more means the
        // window held more runs than one page, and losing them would be silent.
        if ((this.failing.get(key) ?? 0) >= MAX_LIST_FAILURES) continue;
        const runs: Run[] = [];
        try {
          let cursor: string | undefined;
          for (let page = 0; page < 5; page += 1) {
            // The integration is a path inside the Executor's sandbox, not an MCP
            // server: the only way to read runs is a small program it executes.
            const args = {
              created_after: new Date(since).toISOString(),
              sort_direction: "asc",
              limit: 20,
              ...(cursor ? { cursor } : {}),
            };
            const code = sandboxCall(entry.list.path, args);
            const executed = await gateway.callDirect(
              this.executorServer(),
              "execute",
              { code },
              {},
            );
            const result = programResult(executed) as {
              pagination?: { has_more?: boolean; next_cursor?: string };
            };
            runs.push(...runsOf(result, entry.manifest));
            if (!result?.pagination?.has_more || !result.pagination.next_cursor)
              break;
            cursor = result.pagination.next_cursor;
          }
        } catch {
          const count = (this.failing.get(key) ?? 0) + 1;
          this.failing.set(key, count);
          if (count >= MAX_LIST_FAILURES)
            console.warn(
              `Jobs assíncronos: ${entry.list.server} não respondeu ${count} vezes; parando até o próximo start.`,
            );
          continue;
        }
        this.failing.delete(key);
        for (const row of rows) await this.settle(row, runs);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Reconciles one registration against the runs the provider listed. */
  private async settle(row: PendingJob, runs: Run[]) {
    if (row.outcome === "dispatch_result") {
      // The dispatch already had the result, so the turn delivers it. Give the turn time
      // to settle; if it died (the crash after a tool returns), the stored result is sent
      // here instead of being lost.
      if (Date.now() - row.created_at < DISPATCH_GRACE_MS) return;
      return this.deliver(row, row.result ? { stored: row.result } : {});
    }
    const run =
      (row.run_id
        ? runs.find((candidate) => candidate.run_id === row.run_id)
        : undefined) ??
      runs.find(
        (candidate) =>
          !this.app.store.get(
            "SELECT 1 FROM pending_jobs WHERE run_id=? AND id<>?",
            candidate.run_id,
            row.id,
          ) &&
          (!row.goal || this.sameGoal(candidate.goal, row.goal)) &&
          candidate.created_at >= row.created_at - SLACK_MS,
      );
    const timedOut = Date.now() - row.created_at > this.timeoutMs();
    if (!run) {
      // The window may not contain the run yet: silence, not "not confirmed".
      if (!timedOut) return;
      return this.deliver(row, {
        notice: `Não consegui confirmar no provedor o job ${this.label(row)}${row.run_id ? ` (execução ${row.run_id})` : ""}.`,
      });
    }
    // A finished job whose payload carries no result is gone, not failed: providers expire
    // results, and saying so once beats looping for ever.
    if (run.state === "done" && run.result === undefined) {
      this.app.store.run(
        "UPDATE pending_jobs SET outcome='expired' WHERE id=?",
        row.id,
      );
      return this.deliver(row, {
        notice: `O job ${this.label(row)} terminou, mas o provedor não devolveu o resultado (expirado). Nada será repetido.`,
      });
    }
    // Claim the id so a second registration cannot deliver the same run.
    if (!row.run_id)
      this.app.store.run(
        "UPDATE pending_jobs SET run_id=? WHERE id=?",
        run.run_id,
        row.id,
      );
    if (!isTerminal(run.state) && run.state !== "unknown") {
      // Alive: only a long wait earns a notice, never "não entregou resultado".
      if (timedOut && !row.notified_at) return this.warn(row, run);
      return;
    }
    if (run.state === "done") return this.deliver(row, { result: run });
    if (run.state === "failed" || run.state === "cancelled")
      return this.deliver(row, {
        notice: [
          `O job ${this.label(row)} terminou como ${run.status || run.state}.`,
          run.run_id ? `Execução no provedor: ${run.run_id}.` : "",
          run.error ? `Erro do provedor: ${run.error}` : "",
          run.num_of_steps ? `Passos executados: ${run.num_of_steps}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
  }

  /**
   * The provider rewrites the goal it returns ("Navigate to <url> to complete the goal:
   * <ours>"), so equality never matches; the sent goal is the tail of the stored one.
   */
  private sameGoal(returned: string | null | undefined, sent: string | null) {
    if (!returned || !sent) return false;
    const a = returned.trim().toLowerCase();
    const b = sent.trim().toLowerCase();
    return a === b || a.endsWith(b) || a.includes(b);
  }

  /** A notice must say which job it is about: id, tool and provider. */
  private label(row: PendingJob) {
    return `job ${row.id} (${row.integration}/${row.tool})`;
  }

  /** Warns once that a run is taking too long; the row stays open for the result. */
  private async warn(row: PendingJob, run: Run) {
    const changed = this.app.store.run(
      "UPDATE pending_jobs SET notified_at=? WHERE id=? AND notified_at IS NULL",
      Date.now(),
      row.id,
    ).changes;
    if (!changed) return;
    await this.submit(row, [
      `O job assíncrono ${this.label(row)} ainda não terminou.`,
      row.run_id ? `Execução no provedor: ${row.run_id}.` : "",
      row.goal ? `Objetivo: ${row.goal}` : "",
      `Status: ${run.status} depois de ${Math.round(this.timeoutMs() / 60_000)} minutos.`,
      "Avise o usuário em uma linha de que o job continua rodando; o resultado chegará quando terminar. Não dispare novos jobs.",
    ]);
  }
  /** Stable per job manifest; a re-delivery of the same job is the same request. */
  private dedupeFor(row: PendingJob) {
    const entry = this.match(row.integration, row.tool);
    return entry
      ? dedupeKey(entry.manifest, row.id, row.run_id)
      : `job:${row.id}:${row.run_id ?? "unknown"}`;
  }
  /** Webhook entry point: an event converges on the same delivery path as a poll. */
  notify(payload: unknown) {
    this.ensure();
    for (const row of this.pending()) {
      const entry = this.match(row.integration, row.tool);
      if (!entry || entry.manifest.observe.mode !== "webhook") continue;
      const run = this.runFromPayload(entry.manifest, payload, row.run_id);
      if (!run) continue;
      if (row.run_id && run.run_id !== row.run_id) continue;
      void this.settle(row, [run]);
    }
  }
  /** The object inside a payload that actually describes the job. */
  private jobObject(
    manifest: JobManifest,
    payload: unknown,
  ): Record<string, unknown> {
    const walk = (
      value: unknown,
      depth = 0,
    ): Record<string, unknown> | undefined => {
      if (depth > 6 || value === null || value === undefined) return undefined;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed[0] !== "{") return undefined;
        try {
          return walk(JSON.parse(trimmed), depth + 1);
        } catch {
          return undefined;
        }
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
        return undefined;
      }
      if (typeof value !== "object") return undefined;
      const body = value as Record<string, unknown>;
      const hasStatus =
        typeof readPath(body, manifest.observe.statePath) === "string" ||
        typeof body.status === "string";
      if (hasStatus) return body;
      for (const [key, child] of Object.entries(body)) {
        if (key === "result") continue;
        const found = walk(child, depth + 1);
        if (found) return found;
      }
      return undefined;
    };
    return (
      walk(payload) ??
      (payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {})
    );
  }
  /** One observed payload, read through the manifest, as the core's own run shape. */
  private runFromPayload(
    manifest: JobManifest,
    payload: unknown,
    fallbackId?: string | null,
  ): Run | undefined {
    const id = String(
      readPath(payload, manifest.dispatch.idPath) ??
        tolerantExtract(payload) ??
        fallbackId ??
        "",
    ).trim();
    if (!id) return undefined;
    // The job object may sit inside the provider's or the Executor's envelope; the
    // declared paths are read from the object that actually carries the status.
    const job = this.jobObject(manifest, payload);
    const status = String(
      readPath(job, manifest.observe.statePath) ??
        (job as { status?: unknown })?.status ??
        "",
    );
    const error = readPath(job, manifest.observe.errorPath);
    return {
      run_id: id,
      state: jobState(manifest, job),
      status,
      goal: null,
      error: typeof error === "string" ? error : null,
      num_of_steps: null,
      created_at: Date.now(),
      result: readPath(job, manifest.observe.resultPath),
    };
  }
  /** Wakes a turn for the job and marks the row, once. */
  private async deliver(
    row: PendingJob,
    outcome: { result?: Run; notice?: string; stored?: string },
  ) {
    const changed = this.app.store.run(
      "UPDATE pending_jobs SET delivered_at=? WHERE id=? AND delivered_at IS NULL",
      Date.now(),
      row.id,
    ).changes;
    if (!changed) return;
    const prompt =
      outcome.result || outcome.stored
        ? [
            "Um job assíncrono disparado neste tópico terminou.",
            row.goal ? `Objetivo: ${row.goal}` : "",
            `Status: ${outcome.result?.status ?? "COMPLETED"}`,
            `Resultado:\n${(outcome.stored ?? JSON.stringify(outcome.result?.result ?? outcome.result)).slice(0, 8000)}`,
            "Resuma em poucas linhas o que aconteceu e o que importa para o usuário. Não dispare novos jobs.",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            "Um job assíncrono disparado neste tópico não entregou resultado.",
            row.goal ? `Objetivo: ${row.goal}` : "",
            outcome.notice ?? "",
            "Avise o usuário em uma linha. Não dispare novos jobs.",
          ]
            .filter(Boolean)
            .join("\n");
    // Marked before the send; the request id below makes a retry harmless.
    const sent = await this.submit(row, prompt);
    if (sent) return;
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // The same crash can repeat; a row that never delivers must stop, not loop.
      this.app.store.run(
        "UPDATE pending_jobs SET attempts=?,delivered_at=?,outcome='expired' WHERE id=?",
        attempts,
        Date.now(),
        row.id,
      );
      console.warn(
        `Job assíncrono ${row.run_id ?? row.id}: entrega falhou ${attempts} vezes; desistindo. O resultado está em pending_jobs.result.`,
      );
      return;
    }
    this.app.store.run(
      "UPDATE pending_jobs SET attempts=?,delivered_at=NULL WHERE id=?",
      attempts,
      row.id,
    );
  }
  /**
   * Wakes the turn in the conversation the job came from. The request id is stable per
   * row and run, so a retry cannot produce two turns.
   */
  private async submit(row: PendingJob, prompt: string | string[]) {
    const conversationId = row.conversation_id;
    if (this.app.store.conversationDeleted(conversationId)) return true;
    this.enterJobTurn(conversationId);
    try {
      await this.app.submit(
        conversationId,
        this.dedupeFor(row),
        Array.isArray(prompt) ? prompt.filter(Boolean).join("\n") : prompt,
        "job",
      );
      return true;
    } catch {
      this.leaveJobTurn(conversationId);
      return false;
    }
  }
}

interface Run {
  run_id: string;
  /** Normalized state; the provider's own word is kept in `status`. */
  state: JobState;
  status: string;
  goal?: string | null;
  error?: string | null;
  num_of_steps?: number | null;
  created_at: number;
  result?: unknown;
}

/**
 * A tool call as the Executor's sandbox sees it. The integration is a path inside that
 * sandbox, so this small program is the only way to reach it.
 */
function sandboxCall(tool: string, args: unknown) {
  return [
    `const pick = (p) => p.split(".").reduce((o, k) => o[k], tools);`,
    `return JSON.stringify(await pick(${JSON.stringify(tool)})(${JSON.stringify(args)}));`,
  ].join("\n");
}

/** Accepts the provider's envelope (`{data:[…]}`) or the bare array. */
function runsOf(result: unknown, manifest?: JobManifest): Run[] {
  const items = Array.isArray(result)
    ? result
    : Array.isArray((result as { data?: unknown })?.data)
      ? (result as { data: unknown[] }).data
      : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const run = item as Record<string, unknown>;
    const run_id = String(
      readPath(run, manifest?.dispatch.idPath) ?? tolerantExtract(run) ?? "",
    ).trim();
    if (!run_id) return [];
    const status = String(
      readPath(run, manifest?.observe.statePath) ?? run.status ?? "",
    );
    const createdAt = Date.parse(String(run.created_at ?? ""));
    const error = readPath(run, manifest?.observe.errorPath) ?? run.error;
    return [
      {
        run_id,
        state: manifest ? jobState(manifest, run) : ("unknown" as JobState),
        status,
        goal: typeof run.goal === "string" ? run.goal : null,
        error: typeof error === "string" ? error : null,
        num_of_steps:
          typeof run.num_of_steps === "number" ? run.num_of_steps : null,
        created_at: Number.isFinite(createdAt) ? createdAt : Date.now(),
        result: readPath(run, manifest?.observe.resultPath) ?? run.result,
      },
    ];
  });
}

/**
 * Whether a failed dispatch proves no run exists. A 4xx or `retryable: false` is the
 * provider rejecting the request (a bad session id, a missing argument); a transport
 * error or a 5xx may well have created the run, so the row stays open for the poller.
 */
export function deterministicFailure(result: unknown): boolean {
  const text = [
    ...(((result as { content?: { type?: string; text?: string }[] })
      ?.content ?? []) as { type?: string; text?: string }[]),
  ]
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  const body = text || JSON.stringify(result ?? "");
  // A program that never ran (a TS annotation, a wrong path) created nothing.
  if (/"kind"\s*:\s*"(?:ParseError|UnknownTool)"/i.test(body)) return true;
  if (/"retryable"\s*:\s*false/i.test(body)) return true;
  if (/\b5\d\d\b/.test(body)) return false;
  return /\b(400|401|403|404|409|422)\b/.test(body);
}

/** What a synchronous dispatch says about the run, in whichever shape it came. */
export interface DispatchOutcome {
  runId?: string;
  /** True when the dispatch already returned the result, so no turn is needed later. */
  completed: boolean;
}

const DONE = new Set(["COMPLETED", "SUCCESS", "DONE", "FINISHED"]);

/**
 * `run_web_automation` answers `{runId, status:"completed", result}` while `get_run` and
 * `list_runs` use `run_id` and upper case. Normalizing at the boundary is what keeps the
 * row from staying open after the result was already delivered in this turn.
 */
export function dispatchOutcome(result: unknown): DispatchOutcome {
  const payloads: unknown[] = [
    (result as { structuredContent?: unknown })?.structuredContent,
  ];
  for (const item of (
    result as { content?: { type?: string; text?: string }[] }
  )?.content ?? [])
    if (item.type === "text" && item.text)
      try {
        payloads.push(JSON.parse(item.text));
      } catch {
        /* ordinary text */
      }
  for (const value of payloads) {
    if (!value || typeof value !== "object") continue;
    const body = programPayload(value) as Record<string, unknown>;
    // v2 answers `{status:"completed", execution:{ok, value}}` and puts the payload in
    // `value`; v1 answers `{runId, status:"completed", result}`.
    const execution =
      body.execution && typeof body.execution === "object"
        ? (body.execution as Record<string, unknown>)
        : undefined;
    const inner =
      execution && execution.value && typeof execution.value === "object"
        ? (execution.value as Record<string, unknown>)
        : body;
    const runId = ["runId", "run_id", "id"]
      .map((key) => inner[key] ?? body[key])
      .find(
        (candidate): candidate is string =>
          typeof candidate === "string" && !!candidate.trim(),
      );
    const status = String(body.status ?? "").toUpperCase();
    const ok = !execution || execution.ok !== false;
    const hasResult = !execution
      ? body.result !== undefined && body.result !== null
      : execution.value !== undefined && execution.value !== null;
    return {
      ...(runId ? { runId: runId.trim() } : {}),
      completed: DONE.has(status) && ok && hasResult,
    };
  }
  return { completed: false };
}

/**
 * The program's own return, past every envelope the Executor wraps it in. A real answer
 * nests three times (`{result:{content:[text]}}` from MCP, `{ok,data:{content:[text]}}` from
 * execute, then the payload), so this unwraps until it meets a run or a list - and never
 * mistakes an envelope's `status` for a run's.
 */
export function programPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(current);
      } catch {
        return current;
      }
      current = parsed;
      continue;
    }
    if (!current || typeof current !== "object") return current;
    const body = current as Record<string, unknown>;
    // A run or a list is the answer; its own `result`/`data` belongs to it.
    if ("run_id" in body || "runId" in body || Array.isArray(body.data))
      return current;
    const content =
      (body.data as { content?: unknown[] } | undefined)?.content ??
      body.content;
    if (Array.isArray(content)) {
      const text = content.find(
        (item) =>
          !!item &&
          typeof item === "object" &&
          (item as { type?: string }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      ) as { text: string } | undefined;
      if (text) {
        current = text.text;
        continue;
      }
    }
    if (typeof body.result === "string") {
      current = body.result;
      continue;
    }
    return current;
  }
  return current;
}

/** The JSON a program returned, from the tool result's content. */
function programResult(result: unknown) {
  const candidates: unknown[] = [
    (result as { structuredContent?: unknown })?.structuredContent,
    (result as { result?: unknown })?.result,
    ...(
      (result as { content?: { type?: string; text?: string }[] })?.content ??
      []
    ).map((item) => item.text),
    result,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const payload = programPayload(candidate);
    if (payload !== undefined && payload !== null) return payload;
  }
  return undefined;
}
