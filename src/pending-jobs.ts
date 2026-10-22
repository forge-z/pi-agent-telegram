import type { Runtime } from "./runtime.js";
import {
  asRecord,
  executorBodies,
  isExecutorApproval,
  isExecutorFailure,
  isInputInvalid,
  programPayload,
} from "./executor-result.js";

export { programPayload };
import {
  BUILTIN,
  buildReadInput,
  isTerminal,
  jobState,
  loadManifests,
  readPath,
  tolerantExtract,
  type JobManifest,
  type JobState,
  type ReadInput,
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
  /** Provider word from the last successful read, e.g. `RUNNING` or `COMPLETED`. */
  last_status?: string | null;
  /** When the provider was last read successfully. */
  last_seen_at?: number | null;
  /** Error from the last failed read, kept so a notice can cite it. */
  last_error?: string | null;
  /** Account the dispatch itself passed. Reads use this, never an env default. */
  account_id?: string | null;
}

interface JobTool {
  /** Full dispatch tool path from the manifest. */
  path: string;
  server: string;
  tool: string;
  manifest: JobManifest;
}

const DEFAULT_TIMEOUT_MIN = 25;
const DEFAULT_POLL_SECONDS = 25;
const DEFAULT_READ_TIMEOUT_MS = 20_000;
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
 * The canonical form of a tool path. A provider sometimes returns the last separator as
 * `/` (`agent.automation/runAsync`); only the final segment is rewritten, so a slash in
 * an earlier app path is not silently changed into a package separator.
 */
export function normalizeToolPath(path: string): string {
  const value = String(path ?? "").trim();
  if (!value) return value;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return value.replace(/\//g, ".");
  return `${value.slice(0, dot)}.${value.slice(dot + 1).replace(/\//g, ".")}`;
}

/**
 * Normalizes code and extracts known job manifest tools invoked inside `execute`.
 * Handles direct proxy access (tools.x.y.z(...)), bracket access (tools["x"]["y"]["z"]),
 * variable aliases (paths, subpaths, functions, destructuring), and string references.
 */
export function matchDelegatedTools(
  payload: unknown,
  catalogPaths: string[],
): string[] {
  let rawText = "";
  if (typeof payload === "string") {
    rawText = payload;
  } else if (payload && typeof payload === "object") {
    if (typeof (payload as { code?: unknown }).code === "string") {
      rawText = (payload as { code: string }).code;
    } else {
      rawText = JSON.stringify(payload);
    }
  }
  if (!rawText) return [];

  // Step 1: Unescape JSON slashes/quotes
  let text = rawText.replace(/\\"/g, '"').replace(/\\'/g, "'");

  // Step 2: Normalize bracket string access: ["foo"]["bar"] or ['foo']['bar'] or [`foo`][`bar`]
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/\[\s*(['"`])([a-zA-Z0-9_$.-]+)\1\s*\]/g, ".$2");
  }

  // Step 3: Find string variable assignments: const a = "runAsync" or let a = 'runAsync'
  const stringVars = new Map<string, string>();
  const strVarRegex =
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(['"`])([a-zA-Z0-9_$.-]+)\2/g;
  let strMatch: RegExpExecArray | null;
  while ((strMatch = strVarRegex.exec(text)) !== null) {
    stringVars.set(strMatch[1], strMatch[3]);
  }
  for (const [vName, vVal] of stringVars) {
    const varBracketRegex = new RegExp(`\\[\\s*${vName}\\s*\\]`, "g");
    text = text.replace(varBracketRegex, `.${vVal}`);
  }

  // Step 4: Find object/subpath variable assignments: const tf = tools.tinyfish.agent.automation
  const objVars = new Map<string, string>();
  const objVarRegex =
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(tools(?:\.[a-zA-Z0-9_$-]+)+)/g;
  let objMatch: RegExpExecArray | null;
  while ((objMatch = objVarRegex.exec(text)) !== null) {
    objVars.set(objMatch[1], objMatch[2]);
  }
  for (const [vName, vTarget] of objVars) {
    const objDotRegex = new RegExp(`\\b${vName}\\.`, "g");
    text = text.replace(objDotRegex, `${vTarget}.`);
  }

  // Step 5: Find tool variable assignments via destructuring: const { runAsync } = tools.tinyfish.agent.automation
  const fnVars = new Map<string, string>();
  const fnDestructRegex =
    /(?:const|let|var)\s*\{\s*([a-zA-Z_$][\w$]*)\s*\}\s*=\s*(tools(?:\.[a-zA-Z0-9_$-]+)+)/g;
  let fnDestructMatch: RegExpExecArray | null;
  while ((fnDestructMatch = fnDestructRegex.exec(text)) !== null) {
    fnVars.set(
      fnDestructMatch[1],
      `${fnDestructMatch[2]}.${fnDestructMatch[1]}`,
    );
  }

  // Step 6: Direct function assignment: const fn = tools.tinyfish.agent.automation.runAsync
  const fnAssignRegex =
    /(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(tools(?:\.[a-zA-Z0-9_$-]+)+)/g;
  let fnAssignMatch: RegExpExecArray | null;
  while ((fnAssignMatch = fnAssignRegex.exec(text)) !== null) {
    fnVars.set(fnAssignMatch[1], fnAssignMatch[2]);
  }

  const matched: string[] = [];
  for (const tool of catalogPaths) {
    const normalized = normalizeToolPath(tool);
    const short = normalized.slice(normalized.lastIndexOf(".") + 1);
    const withoutTools = normalized.startsWith("tools.")
      ? normalized.slice("tools.".length)
      : normalized;

    // Direct path in text (normalized or raw)
    if (text.includes(normalized) || rawText.includes(normalized)) {
      matched.push(tool);
      continue;
    }
    if (text.includes(withoutTools) || rawText.includes(withoutTools)) {
      matched.push(tool);
      continue;
    }

    // Function alias called: fn(...)
    let foundFnAlias = false;
    for (const [fName, fTarget] of fnVars) {
      if (
        (fTarget === normalized || fTarget === withoutTools) &&
        new RegExp(`\\b${fName}\\s*\\(`).test(text)
      ) {
        matched.push(tool);
        foundFnAlias = true;
        break;
      }
    }
    if (foundFnAlias) continue;

    // Check if short name appears as property access on tools proxy:
    const escapedShort = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`\\.${escapedShort}\\b`).test(text) &&
      (text.includes("tools") || text.includes(withoutTools.split(".")[0]))
    ) {
      matched.push(tool);
      continue;
    }

    // Fallback: raw regex on slash/escaped forms
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const slash =
      tool.slice(0, tool.lastIndexOf(".")) +
      "/" +
      tool.slice(tool.lastIndexOf(".") + 1);
    const escapedSlash = slash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(escaped).test(rawText) ||
      new RegExp(escapedSlash).test(rawText) ||
      new RegExp(`\\b${escapedShort}\\b`).test(rawText)
    ) {
      matched.push(tool);
    }
  }

  return [...new Set(matched)];
}

function payloadText(payload: unknown): string {
  let raw = "";
  if (typeof payload === "string") raw = payload;
  else if (payload && typeof payload === "object") {
    const code = (payload as { code?: unknown }).code;
    raw = typeof code === "string" ? code : JSON.stringify(payload);
  }
  return raw.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function extractGoal(payload: unknown): string | undefined {
  return /["'`]?goal["'`]?\s*[:=]\s*["'`]([^"'`]{3,300})["'`]/i.exec(
    payloadText(payload),
  )?.[1];
}

const ACCOUNT_ID =
  /["']?accountId["']?\s*[:=]\s*["'](acc[_-][0-9a-z_-]{4,})["']/gi;

/** Account ids the model passed in this dispatch. Duplicates collapse. */
function invocationAccountIds(payload: unknown): string[] {
  return [
    ...new Set(
      [...payloadText(payload).matchAll(ACCOUNT_ID)].map((match) => match[1]),
    ),
  ];
}

/** App slug of a tool path: `tools.tinyfish...` → `tinyfish`. */
function appNamespace(path: string): string {
  const parts = normalizeToolPath(path).split(".").filter(Boolean);
  if (parts[0] === "tools" && parts[1]) return parts[1]!;
  return parts[0] ?? path;
}

/**
 * Accounts a `search` or `describe` payload lists for one namespace.
 * Ids are taken from that namespace's `accounts` field, then from a single
 * `accountId: "acc_..."` in a signature. Several ids are returned as-is so
 * the caller can refuse to guess.
 */
function accountsInCatalog(value: unknown, namespace: string): string[] {
  const ids = new Set<string>();
  let scoped = false;
  for (const body of executorBodies(value)) {
    const namespaces = body.namespaces;
    if (!Array.isArray(namespaces)) continue;
    for (const entry of namespaces) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const path = String(rec.path ?? "");
      const blob =
        typeof rec.accounts === "string"
          ? rec.accounts
          : JSON.stringify(rec.accounts ?? "");
      if (namespace && !path.includes(namespace) && !blob.includes(namespace))
        continue;
      scoped = true;
      for (const match of blob.matchAll(/\bacc[_-][0-9a-z_-]{4,}\b/gi))
        ids.add(match[0]);
    }
  }
  if (scoped) return [...ids];
  const text = JSON.stringify(value ?? "");
  return [
    ...new Set(
      [
        ...text.matchAll(
          /accountId["']?\s*[:=]\s*["'](acc[_-][0-9a-z_-]{4,})["']/gi,
        ),
      ].map((match) => match[1]),
    ),
  ];
}

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
  private disabled = false;
  private disabledReason?: string;
  private lastTick?: {
    at: number;
    rows_polled: number;
    delivered: number;
    errors: number;
  };
  /** Conversations running a job-born turn, with the moment they entered it. */
  private readonly jobTurns = new Map<string, number>();
  /** Consecutive list failures per integration, to stop polling a tool that is not there. */
  private readonly failing = new Map<string, number>();
  /** Tools whose read input cannot be built. Logged once; no new rows. */
  private readonly unreadable = new Set<string>();

  constructor(
    private app: Runtime,
    private env: Record<string, string | undefined> = process.env,
  ) {}

  /** Consultable health status of the jobs poller. */
  health(): {
    enabled: boolean;
    reason?: string;
    open_rows: number;
    manifests_count: number;
    last_tick?: {
      at: number;
      rows_polled: number;
      delivered: number;
      errors: number;
    };
  } {
    this.ensure();
    const openCount =
      this.app.store.get<{ total: number }>(
        "SELECT count(*) AS total FROM pending_jobs WHERE delivered_at IS NULL",
      )?.total ?? 0;
    const lastTick = this.lastTick ? { ...this.lastTick } : undefined;
    return {
      enabled: !this.disabled,
      ...(this.disabledReason ? { reason: this.disabledReason } : {}),
      open_rows: openCount,
      manifests_count: this.manifests().length,
      ...(lastTick ? { last_tick: lastTick } : {}),
    };
  }

  healthLine(): string {
    const h = this.health();
    const base = h.enabled
      ? `Jobs assíncronos: ativo (${h.open_rows} linha(s) em aberto)`
      : `Jobs assíncronos: desabilitado (reason=${h.reason ?? "disabled"}), ${h.open_rows} linha(s) em aberto`;
    if (!h.last_tick) return base;
    return `${base}; último tick às ${new Date(h.last_tick.at).toISOString().slice(11, 19)} (rows_polled=${h.last_tick.rows_polled} delivered=${h.last_tick.delivered} errors=${h.last_tick.errors})`;
  }

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
    if (!columns.includes("last_status"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN last_status TEXT",
      );
    if (!columns.includes("last_seen_at"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN last_seen_at INTEGER",
      );
    if (!columns.includes("last_error"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN last_error TEXT",
      );
    if (!columns.includes("account_id"))
      this.app.store.db.exec(
        "ALTER TABLE pending_jobs ADD COLUMN account_id TEXT",
      );
    // '' is not NULL and would collide on the unique index. Unknown ids stay NULL.
    this.app.store.db.exec(`
      UPDATE pending_jobs SET run_id=NULL WHERE run_id IS NOT NULL AND trim(run_id)='';
      DROP INDEX IF EXISTS pending_jobs_run;
      CREATE UNIQUE INDEX pending_jobs_run ON pending_jobs(tool, run_id) WHERE run_id IS NOT NULL;
    `);
    this.ready = true;
  }

  /** A blank id is unknown: NULL, never '' or another sentinel. */
  private runIdOrNull(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text || null;
  }

  /**
   * Gives this row the run id when no other row already owns it.
   * The loser is closed without a second delivery.
   */
  private claimRun(rowId: number, runId: string): boolean {
    const clean = this.runIdOrNull(runId);
    if (!clean) return false;
    const owner = this.app.store.get<{ id: number }>(
      "SELECT id FROM pending_jobs WHERE run_id=?",
      clean,
    );
    if (owner?.id === rowId) return true;
    if (owner) {
      this.app.store.run(
        `UPDATE pending_jobs
         SET delivered_at=COALESCE(delivered_at, ?), outcome=COALESCE(outcome, 'duplicate_run')
         WHERE id=? AND delivered_at IS NULL`,
        Date.now(),
        rowId,
      );
      return false;
    }
    let changed = false;
    try {
      changed =
        this.app.store.run(
          "UPDATE pending_jobs SET run_id=? WHERE id=? AND run_id IS NULL",
          clean,
          rowId,
        ).changes > 0;
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(String(error))) throw error;
    }
    if (changed) return true;
    const winner = this.app.store.get<{ id: number }>(
      "SELECT id FROM pending_jobs WHERE run_id=?",
      clean,
    );
    if (winner?.id === rowId) return true;
    if (winner)
      this.app.store.run(
        `UPDATE pending_jobs
         SET delivered_at=COALESCE(delivered_at, ?), outcome=COALESCE(outcome, 'duplicate_run')
         WHERE id=? AND delivered_at IS NULL AND run_id IS NULL`,
        Date.now(),
        rowId,
      );
    return false;
  }

  /**
   * The only insert. The same (tool, run_id) is a no-op; a missing id is NULL,
   * so several jobs can wait at once.
   */
  private placeRun(input: {
    server: string;
    tool: string;
    conversationId: string;
    runId?: string | null;
    goal?: string | null;
    accountId?: string | null;
  }): boolean {
    const runId = this.runIdOrNull(input.runId);
    const tool = normalizeToolPath(input.tool);
    const accountId = input.accountId?.trim() || null;
    const goal = input.goal ?? null;
    if (runId) {
      const existing = this.app.store.get<{ id: number }>(
        "SELECT id FROM pending_jobs WHERE run_id=?",
        runId,
      );
      if (existing) {
        this.app.store.run(
          `UPDATE pending_jobs
           SET account_id=COALESCE(NULLIF(account_id, ''), ?), goal=COALESCE(goal, ?)
           WHERE id=?`,
          accountId,
          goal,
          existing.id,
        );
        return true;
      }
      const open = this.app.store.get<{ id: number }>(
        `SELECT id FROM pending_jobs
         WHERE conversation_id=? AND delivered_at IS NULL AND run_id IS NULL
         ORDER BY id DESC LIMIT 1`,
        input.conversationId,
      );
      if (open && this.claimRun(open.id, runId)) {
        this.app.store.run(
          `UPDATE pending_jobs
           SET tool=?, account_id=COALESCE(NULLIF(account_id, ''), ?), goal=COALESCE(goal, ?)
           WHERE id=?`,
          tool,
          accountId,
          goal,
          open.id,
        );
        return true;
      }
    }
    const inserted =
      this.app.store.run(
        `INSERT INTO pending_jobs(integration,tool,run_id,goal,conversation_id,created_at,account_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tool, run_id) WHERE run_id IS NOT NULL DO NOTHING`,
        input.server,
        tool,
        runId,
        goal,
        input.conversationId,
        Date.now(),
        accountId,
      ).changes > 0;
    if (inserted) return true;
    return runId
      ? !!this.app.store.get("SELECT 1 FROM pending_jobs WHERE run_id=?", runId)
      : false;
  }

  private templateVars(row: PendingJob, entry?: JobTool) {
    const declared = entry?.manifest.accountId?.trim() ?? "";
    const accountId =
      (row.account_id ?? "").trim() ||
      (declared && !declared.includes("${") ? declared : "");
    const jobId = row.run_id ?? "";
    return {
      id: jobId,
      job_id: jobId,
      row: row.id,
      goal: row.goal ?? undefined,
      since: new Date(row.created_at - SLACK_MS).toISOString(),
      now: new Date().toISOString(),
      account: entry?.manifest.observe.accountArg ?? "",
      accountId,
    };
  }

  /** Preview vars so a read template can be checked before a run id exists. */
  private previewVars(entry: JobTool, goal?: string) {
    return this.templateVars(
      {
        id: 0,
        integration: entry.server,
        tool: entry.path,
        run_id: "preview",
        goal: goal ?? "preview",
        conversation_id: "",
        created_at: Date.now(),
        delivered_at: null,
        notified_at: null,
        outcome: null,
        result: null,
        attempts: 0,
        next_poll_at: 0,
        job_state: "pending",
      },
      entry,
    );
  }

  /**
   * A broken read template never opens a row. A missing account does not: the
   * invocation or a later catalog lookup can still supply it.
   */
  private shapeError(entry: JobTool, accountId?: string): string | undefined {
    if (entry.manifest.observe.mode === "webhook") return undefined;
    const vars = this.previewVars(entry);
    if (accountId) vars.accountId = accountId;
    const checks = [
      buildReadInput(entry.manifest.observe.args ?? {}, vars),
      ...(entry.manifest.reconcile
        ? [buildReadInput(entry.manifest.reconcile.args, vars)]
        : []),
    ];
    const bad = checks.find((check) => !check.ok);
    if (!bad || bad.ok) return undefined;
    if (bad.error.includes("accountId ausente")) return undefined;
    return bad.error;
  }

  private readInput(args: unknown, row: PendingJob, entry: JobTool): ReadInput {
    return buildReadInput(args, this.templateVars(row, entry));
  }

  /** Path desconhecido ou sem tool de leitura declarado: fecha sem acordar turno. */
  private expireUnrecoverable(
    row: PendingJob,
    outcome = "unrecoverable_tool_path",
  ) {
    const changed = this.app.store.run(
      `UPDATE pending_jobs SET delivered_at=?,outcome=?,job_state='expired'
       WHERE id=? AND delivered_at IS NULL`,
      Date.now(),
      outcome,
      row.id,
    ).changes;
    if (changed) {
      console.warn(
        `jobs_poller: terminal outcome=${outcome} job=${row.id} run_id=${row.run_id ?? "unknown"} error=${row.integration}/${row.tool}`,
      );
    }
  }

  private expireTerminal(row: PendingJob, outcome: string, error?: string) {
    const changed = this.app.store.run(
      `UPDATE pending_jobs SET delivered_at=?,outcome=?,job_state='expired',last_error=?
       WHERE id=? AND delivered_at IS NULL`,
      Date.now(),
      outcome,
      error ?? outcome,
      row.id,
    ).changes;
    if (changed) {
      console.warn(
        `jobs_poller: terminal outcome=${outcome} job=${row.id} run_id=${row.run_id ?? "unknown"} error=${error ?? outcome}`,
      );
    }
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
      const path = normalizeToolPath(manifest.tool);
      const parts = path.split(".");
      const tool = parts.pop() ?? "";
      return {
        path,
        server: parts.join("."),
        tool,
        manifest,
      };
    });
  }

  /** Manifest catalog keyed by full dispatch path (never derived at poll time). */
  private manifestByPath() {
    return new Map(
      this.manifests().map((manifest) => [
        normalizeToolPath(manifest.tool),
        manifest,
      ]),
    );
  }

  /**
   * A dispatch path may arrive as `server`, `tool`, a full path, or an old row split in
   * two columns. Try the composed and the raw forms before declaring it unknown, but
   * always return the manifest's own path - never one rebuilt for the poll call.
   */
  private candidatePaths(first: string, second?: string) {
    const a = String(first ?? "").trim();
    const b = String(second ?? "").trim();
    const paths = [
      ...(a && b ? [normalizeToolPath(`${a}.${b}`)] : []),
      ...(b ? [normalizeToolPath(b)] : []),
      ...(a ? [normalizeToolPath(a)] : []),
    ];
    return [...new Set(paths.filter(Boolean))];
  }

  private rowPath(row: PendingJob) {
    const entry = this.match(row.integration, row.tool);
    return (
      entry?.path ??
      this.candidatePaths(row.integration, row.tool)[0] ??
      normalizeToolPath(row.tool)
    );
  }

  private timeoutMs() {
    const minutes = Number(this.env.ASYNC_JOB_TIMEOUT_MIN);
    return (
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : DEFAULT_TIMEOUT_MIN) * 60_000
    );
  }

  private readTimeoutMs() {
    const ms = Number(this.env.ASYNC_JOB_READ_TIMEOUT_MS);
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_READ_TIMEOUT_MS;
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
  private match(first: string, second?: string) {
    const paths = this.candidatePaths(first, second);
    return this.tools().find((entry) => paths.includes(entry.path));
  }

  /** The open row for a dispatch path, matched on its canonical form. */
  private openRow(
    server: string,
    tool: string,
    conversationId: string,
    withoutRun = false,
  ) {
    const entry = this.match(server, tool);
    if (!entry) return undefined;
    return this.app.store
      .all<PendingJob>(
        `SELECT * FROM pending_jobs WHERE conversation_id=? AND delivered_at IS NULL
         ${withoutRun ? "AND run_id IS NULL" : ""} ORDER BY id`,
        conversationId,
      )
      .find(
        (row) => this.match(row.integration, row.tool)?.path === entry.path,
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
    payload?: unknown,
  ) {
    this.ensure();
    const entry = this.match(server, tool);
    if (!entry || this.inJobTurn(conversationId)) return false;
    if (!this.observeTool(entry.manifest)) {
      console.warn(
        `Jobs assíncronos: manifesto sem tool de leitura para ${entry.path}; dispatch ignorado.`,
      );
      return false;
    }
    if (!this.manifestByPath().has(entry.path)) return false;
    const accounts = invocationAccountIds(payload);
    if (accounts.length > 1) {
      void this.announce(
        conversationId,
        `job:ambiguous_account:${entry.path}`,
        `ambiguous_account: a chamada de ${entry.path} passou mais de uma conta (${accounts.join(", ")}). Nada foi lido.`,
      );
      return false;
    }
    const broken = this.shapeError(entry, accounts[0]);
    if (broken) {
      if (!this.unreadable.has(entry.path)) {
        this.unreadable.add(entry.path);
        console.error(
          `Jobs assíncronos: ${entry.path} desabilitado. A leitura não monta {accountId, input}: ${broken}`,
        );
      }
      void this.announce(
        conversationId,
        `job:shape:${entry.path}`,
        `A leitura de ${entry.path} falhou na validação: ${broken}`,
      );
      return false;
    }
    return this.placeRun({
      server: entry.server,
      tool: entry.path,
      conversationId,
      goal: goal ?? null,
      accountId: accounts[0] ?? null,
    });
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
    this.ensure();
    const row = this.openRow(server, tool, conversationId);
    if (!row) return;
    this.app.store.run(
      "UPDATE pending_jobs SET outcome='dispatch_result',result=? WHERE id=?",
      result,
      row.id,
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
    const catalog = this.manifestByPath();
    const matched = matchDelegatedTools(payload, [...catalog.keys()]);
    let opened = false;
    const goal = extractGoal(payload);
    for (const path of matched) {
      const manifest = catalog.get(path);
      if (!manifest || !this.observeTool(manifest)) continue;
      const parts = path.split(".");
      const tool = parts.pop() ?? "";
      const server = parts.join(".");
      if (this.register(server, tool, conversationId, goal, payload))
        opened = true;
    }
    return opened;
  }

  private observeTool(manifest: JobManifest) {
    if (manifest.observe.mode === "webhook") return true;
    return !!(manifest.observe.tool ?? manifest.reconcile?.tool);
  }
  /**
   * The dispatch failed deterministically (a 400, a bad session id): no run exists, so the
   * row closes now instead of waiting for a timeout that would blame the provider.
   */
  closeUnstarted(server: string, tool: string, conversationId: string) {
    this.ensure();
    let row = this.openRow(server, tool, conversationId);
    if (!row) {
      row = this.app.store.get<PendingJob>(
        `SELECT * FROM pending_jobs
         WHERE conversation_id=? AND delivered_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        conversationId,
      );
    }
    if (!row) return;
    const changed = this.app.store.run(
      "UPDATE pending_jobs SET delivered_at=?,outcome='dispatch_error' WHERE id=?",
      Date.now(),
      row.id,
    ).changes;
    if (changed) {
      console.warn(
        `jobs_poller: terminal outcome=dispatch_error job=${row.id} run_id=${row.run_id ?? "none"} error=dispatch rejected or unstarted`,
      );
    }
  }

  /** Registers a pre-identified job with run_id already set. */
  registerKnown(
    conversationId: string,
    manifestTool: string,
    runId: string,
    goal?: string,
    accountId?: string,
  ): boolean {
    this.ensure();
    if (this.inJobTurn(conversationId)) return false;
    const entry = this.match(manifestTool);
    if (!entry) return false;
    const broken = this.shapeError(entry, accountId);
    if (broken) {
      void this.announce(
        conversationId,
        `job:shape:${entry.path}`,
        `A leitura de ${entry.path} falhou na validação: ${broken}`,
      );
      return false;
    }
    const clean = this.runIdOrNull(runId);
    if (!clean) return false;
    return this.placeRun({
      server: entry.server,
      tool: entry.path,
      conversationId,
      runId: clean,
      goal: goal ?? null,
      accountId: accountId ?? null,
    });
  }

  /** Deterministic failure for a pre-identified job before dispatch succeeded. */
  closeKnownUnstarted(runId: string, conversationId: string) {
    this.ensure();
    const changed = this.app.store.run(
      "UPDATE pending_jobs SET delivered_at=?,outcome='dispatch_error' WHERE run_id=? AND conversation_id=? AND delivered_at IS NULL",
      Date.now(),
      runId,
      conversationId,
    ).changes;
    if (changed) {
      console.warn(
        `jobs_poller: terminal outcome=dispatch_error run_id=${runId} error=dispatch rejected or unstarted`,
      );
    }
  }
  /** Attaches the run id a successful dispatch returned to its pre-registration. */
  capture(
    server: string,
    tool: string,
    conversationId: string,
    runId: string,
    payload?: unknown,
  ): boolean {
    this.ensure();
    const cleanId = this.runIdOrNull(runId);
    if (!cleanId) return false;

    // 1. Direct match on openRow
    let row = this.openRow(server, tool, conversationId, true);

    // 2. Open delegated row without run_id
    if (!row) {
      row = this.app.store.get<PendingJob>(
        `SELECT * FROM pending_jobs
         WHERE conversation_id=? AND delivered_at IS NULL AND run_id IS NULL
         ORDER BY id DESC LIMIT 1`,
        conversationId,
      );
    }

    const accounts = invocationAccountIds(payload);
    if (accounts.length > 1) {
      const message = `ambiguous_account: a chamada passou mais de uma conta (${accounts.join(", ")}). Nada foi lido.`;
      if (row) void this.failNamed(row, "ambiguous_account", message);
      else
        void this.announce(
          conversationId,
          `job:ambiguous_account:${cleanId}`,
          message,
        );
      return false;
    }
    const accountId = accounts[0];
    // 3. The result carried a run id. Attach it to the manifest whose tool or
    // namespace is in the invocation. Never pick a manifest just because it
    // is the only one loaded.
    const catalog = this.manifestByPath();
    let matchedPath: string | undefined;
    if (row) matchedPath = normalizeToolPath(row.tool);
    if (!matchedPath && payload)
      matchedPath = matchDelegatedTools(payload, [...catalog.keys()])[0];
    if (!matchedPath) matchedPath = this.match(server, tool)?.path;
    if (!matchedPath && payload) {
      const text = payloadText(payload);
      matchedPath = [...catalog.keys()].find((path) =>
        text.includes(appNamespace(path)),
      );
    }
    if (!matchedPath) return false;
    const manifest = catalog.get(matchedPath);
    if (!manifest || !this.observeTool(manifest)) return false;
    const parts = matchedPath.split(".");
    const t = parts.pop() ?? "";
    const s = parts.join(".");
    const entry = { path: matchedPath, server: s, tool: t, manifest };
    if (this.shapeError(entry, accountId)) return false;
    return this.placeRun({
      server: entry.server,
      tool: entry.path,
      conversationId,
      runId: cleanId,
      accountId: accountId ?? null,
    });
  }

  /**
   * The MCP hook's two steps, so a test can run the same sequence as `execute`/`call`.
   * Registration happens before the call; the run id is attached after it returns.
   */
  beginDispatch(
    conversationId: string,
    server: string,
    tool: string,
    args: unknown,
  ): boolean {
    const directGoal =
      args &&
      typeof args === "object" &&
      typeof (args as { goal?: unknown }).goal === "string"
        ? (args as { goal: string }).goal
        : undefined;
    return (
      this.register(
        server,
        tool,
        conversationId,
        directGoal ?? extractGoal(args),
        args,
      ) || this.registerDelegated(conversationId, args)
    );
  }

  finishDispatch(
    conversationId: string,
    server: string,
    tool: string,
    args: unknown,
    result: unknown,
  ): DispatchOutcome {
    let dispatch: DispatchOutcome = { completed: false };
    try {
      dispatch = dispatchOutcome(result);
      if (dispatch.runId)
        this.capture(server, tool, conversationId, dispatch.runId, args);
      // The Executor wrapper status is "completed" when the program returned.
      // Only a finished run inside that value closes the row here; the model
      // already has that result in the turn.
      if (dispatch.completed) this.closeUnstarted(server, tool, conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const run = dispatch.runId ? ` ${dispatch.runId}` : "";
      void this.announce(
        conversationId,
        `job:register:${dispatch.runId ?? "none"}`,
        `Não consegui registrar o job${run}: ${message}. O disparo no provedor não foi desfeito.`,
      );
    }
    return dispatch;
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
    observed: Run | JobState,
    attempts?: number,
  ) {
    const state = typeof observed === "string" ? observed : observed.state;
    const status =
      typeof observed === "string"
        ? observed.toUpperCase()
        : observed.status || observed.state.toUpperCase();
    const error =
      typeof observed === "string" ? null : (observed.error ?? null);
    const retry = attempts ?? row.attempts;
    this.app.store.run(
      `UPDATE pending_jobs SET job_state=?, last_status=?, last_seen_at=?,
         last_error=?, attempts=?, next_poll_at=? WHERE id=?`,
      state,
      status,
      Date.now(),
      error,
      retry,
      isTerminal(state)
        ? row.next_poll_at
        : Date.now() + this.backoffMs(manifest, retry),
      row.id,
    );
  }

  private concreteAccount(entry: JobTool): string | undefined {
    for (const args of [
      entry.manifest.observe.args,
      entry.manifest.reconcile?.args,
    ]) {
      const body = asRecord(args);
      const id =
        typeof body?.accountId === "string" ? body.accountId.trim() : "";
      if (id && !id.includes("${")) return id;
    }
    const declared = entry.manifest.accountId?.trim() ?? "";
    if (declared && !declared.includes("${")) return declared;
    return undefined;
  }

  /** One account from search, then describe. Zero or many is a named failure. */
  private async lookupAccounts(
    namespace: string,
    tool?: string,
  ): Promise<string[]> {
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
    if (!gateway?.callDirect) return [];
    const call = gateway.callDirect.bind(gateway);
    const timeout = { signal: AbortSignal.timeout(this.readTimeoutMs()) };
    let searchError: unknown;
    try {
      const searched = await call(
        this.executorServer(),
        "search",
        { namespace, limit: 20 },
        timeout,
      );
      const found = accountsInCatalog(
        programPayload(searched) ?? searched,
        namespace,
      );
      if (found.length) return found;
    } catch (error) {
      if (isInputInvalid(error)) throw error;
      searchError = error;
    }
    if (!tool) {
      if (searchError) throw searchError;
      return [];
    }
    try {
      const described = await call(
        this.executorServer(),
        "describe",
        { paths: [tool] },
        timeout,
      );
      return accountsInCatalog(
        programPayload(described) ?? described,
        namespace,
      );
    } catch (error) {
      if (searchError) throw searchError;
      if (isInputInvalid(error)) throw error;
      return [];
    }
  }

  /**
   * The read account is the one stored on the row, a literal in the manifest,
   * or the single account the catalog lists for the namespace.
   */
  private async ensureAccount(
    row: PendingJob,
    entry: JobTool,
  ): Promise<boolean> {
    const current = (row.account_id ?? "").trim();
    if (current) return true;
    const literal = this.concreteAccount(entry);
    if (literal) {
      this.app.store.run(
        "UPDATE pending_jobs SET account_id=? WHERE id=?",
        literal,
        row.id,
      );
      row.account_id = literal;
      return true;
    }
    const namespace = appNamespace(entry.path);
    let found: string[] = [];
    try {
      found = await this.lookupAccounts(namespace, entry.manifest.observe.tool);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failNamed(
        row,
        "missing_account",
        `missing_account: não consegui consultar as contas de ${namespace}: ${message}`,
      );
      return false;
    }
    if (found.length === 1) {
      this.app.store.run(
        "UPDATE pending_jobs SET account_id=? WHERE id=?",
        found[0],
        row.id,
      );
      row.account_id = found[0];
      return true;
    }
    if (found.length === 0) {
      await this.failNamed(
        row,
        "missing_account",
        `missing_account: a chamada de ${entry.path} não trouxe accountId e a busca no namespace ${namespace} não achou nenhuma conta.`,
      );
      return false;
    }
    await this.failNamed(
      row,
      "ambiguous_account",
      `ambiguous_account: há mais de uma conta para ${namespace} (${found.join(", ")}) e a chamada não escolheu. Nada foi lido.`,
    );
    return false;
  }

  private async announce(conversationId: string, key: string, text: string) {
    if (this.app.store.conversationDeleted(conversationId)) return;
    try {
      await this.app.submit(conversationId, key, text, "job");
    } catch {
      /* A later dispatch can say it again. */
    }
  }

  private async failNamed(row: PendingJob, outcome: string, message: string) {
    const text = message.trim().slice(0, 1500) || outcome;
    this.app.store.run(
      `UPDATE pending_jobs SET job_state='failed', last_status=?, last_error=?, last_seen_at=?
       WHERE id=? AND delivered_at IS NULL`,
      outcome,
      text,
      Date.now(),
      row.id,
    );
    await this.deliverOnce(
      row,
      {
        notice: [
          text,
          "Avise o usuário em uma linha com essa causa. Não diga que o status é desconhecido. Não dispare outro job.",
        ].join("\n"),
      },
      outcome,
    );
  }

  start() {
    this.ensure();
    this.disabled = false;
    this.disabledReason = undefined;
    if (this.timer) return;
    console.info(
      `jobs_poller: started (poll_interval=${this.pollMs() / 1000}s)`,
    );
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
        console.info(
          `jobs_poller: terminal outcome=delivered job=${row.id} run_id=${row.run_id ?? "unknown"}`,
        );
        continue;
      }
      this.app.store.run(
        "UPDATE pending_jobs SET outcome='delivery_unconfirmed' WHERE id=?",
        row.id,
      );
      console.warn(
        `jobs_poller: terminal outcome=delivery_unconfirmed job=${row.id} run_id=${row.run_id ?? "unknown"}: o turno terminou mas nenhuma entrega foi confirmada. O resultado está em pending_jobs.result.`,
      );
    }
  }
  /** One reconciliation pass. Public for the timer and for tests. */
  async tick() {
    this.ensure();
    if (this.ticking) return;
    if (this.disabled) return;
    const pending = this.pending();
    this.ticking = true;
    let deliveredCount = 0;
    let errorsCount = 0;
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
        const key = this.rowPath(row);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [key, rows] of groups) {
        const entry = this.match(key);
        if (!entry || !this.observeTool(entry.manifest)) {
          for (const row of rows) this.expireUnrecoverable(row);
          continue;
        }
        const observe = entry.manifest.observe;
        if (observe.mode !== "webhook" && observe.tool) {
          for (const row of rows) {
            if (!(await this.ensureAccount(row, entry))) {
              errorsCount++;
              continue;
            }
            const reconcile =
              entry.manifest.reconcile ??
              (observe.mode === "reconcile"
                ? {
                    tool: observe.tool!,
                    args: observe.args ?? {},
                    match: "goalSuffix" as const,
                  }
                : undefined);
            if (!row.run_id && reconcile) {
              try {
                const args = await this.argsOrFail(row, entry, reconcile.args);
                if (!args) {
                  errorsCount++;
                  continue;
                }
                const executed = await gateway.callDirect(
                  this.executorServer(),
                  "execute",
                  {
                    code: sandboxCall(reconcile.tool, args),
                  },
                  { signal: AbortSignal.timeout(this.readTimeoutMs()) },
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
                  if (!this.claimRun(row.id, run.run_id)) continue;
                  row.run_id = run.run_id;
                  this.noteState(row, entry.manifest, run, 0);
                  if (await this.settle(row, [run])) deliveredCount++;
                  continue;
                }
                // Nothing yet: silence inside the grace window, a notice after it.
                if (
                  Date.now() - row.created_at >
                  this.graceMs(entry.manifest)
                ) {
                  if (await this.settle(row, [])) deliveredCount++;
                } else
                  this.app.store.run(
                    "UPDATE pending_jobs SET next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                continue;
              } catch (error) {
                errorsCount++;
                if (await this.failIfInputInvalid(row, error)) continue;
                this.app.store.run(
                  "UPDATE pending_jobs SET attempts=attempts+1, next_poll_at=? WHERE id=?",
                  Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
                  row.id,
                );
                await this.warnIfTimedOut(row, error);
                continue;
              }
            }
            if (!row.run_id && observe.mode === "poll") continue;
            try {
              const args = await this.argsOrFail(
                row,
                entry,
                observe.args ?? {},
              );
              if (!args) {
                errorsCount++;
                continue;
              }
              const executed = await gateway.callDirect(
                this.executorServer(),
                "execute",
                {
                  code: sandboxCall(observe.tool, args),
                },
                { signal: AbortSignal.timeout(this.readTimeoutMs()) },
              );
              const payload = programResult(executed);
              if (isNotFoundError(payload)) {
                if (
                  Date.now() - row.created_at <=
                  this.graceMs(entry.manifest)
                ) {
                  this.app.store.run(
                    "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                  continue;
                }
                this.app.store.run(
                  "UPDATE pending_jobs SET attempts=attempts+1, next_poll_at=? WHERE id=?",
                  Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
                  row.id,
                );
                if (!row.notified_at)
                  await this.warn(
                    row,
                    {
                      run_id: row.run_id ?? "?",
                      state: "unknown",
                      status: "NOT_FOUND",
                      created_at: row.created_at,
                    },
                    payload,
                  );
                continue;
              }
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
                        !!row.goal &&
                        this.sameGoal(run.goal, row.goal) &&
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
                  if (!row.run_id && !this.claimRun(row.id, run.run_id))
                    continue;
                  if (!row.run_id) row.run_id = run.run_id;
                  this.noteState(row, entry.manifest, run, 0);
                  if (await this.settle(row, [run])) deliveredCount++;
                } else if (
                  row.run_id &&
                  Date.now() - row.created_at > this.timeoutMs()
                ) {
                  // The list did not carry our id: settle re-reads it by id before any
                  // timeout notice.
                  if (await this.settle(row, [])) deliveredCount++;
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
                this.noteState(row, entry.manifest, single, 0);
                if (await this.settle(row, [single])) deliveredCount++;
              } else if (Date.now() - row.created_at > this.timeoutMs()) {
                // The read succeeded but carried no run: settle re-reads once before
                // deciding whether this is a timeout or just an empty payload.
                if (await this.settle(row, [])) deliveredCount++;
              } else {
                this.app.store.run(
                  "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
                  Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
                  row.id,
                );
              }
            } catch (error) {
              errorsCount++;
              if (await this.failIfInputInvalid(row, error)) continue;
              if (isNotFoundError(error)) {
                if (
                  Date.now() - row.created_at <=
                  this.graceMs(entry.manifest)
                ) {
                  // Silence inside grace window
                  this.app.store.run(
                    "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
                    Date.now() +
                      this.backoffMs(entry.manifest, row.attempts + 1),
                    row.id,
                  );
                  continue;
                }
                this.app.store.run(
                  "UPDATE pending_jobs SET attempts=attempts+1, next_poll_at=? WHERE id=?",
                  Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
                  row.id,
                );
                if (!row.notified_at)
                  await this.warn(
                    row,
                    {
                      run_id: row.run_id ?? "?",
                      state: "unknown",
                      status: "NOT_FOUND",
                      created_at: row.created_at,
                    },
                    error,
                  );
                continue;
              }
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
              await this.warnIfTimedOut(row, error);
            }
          }
        }
      }
    } finally {
      this.ticking = false;
      this.lastTick = {
        at: Date.now(),
        rows_polled: pending.length,
        delivered: deliveredCount,
        errors: errorsCount,
      };
      console.info(
        `jobs_poller: tick rows_polled=${pending.length} delivered=${deliveredCount} errors=${errorsCount}`,
      );
    }
  }

  /** Reconciles one registration against the runs the provider listed. */
  private async settle(row: PendingJob, runs: Run[]): Promise<boolean> {
    const entry = this.match(row.integration, row.tool);
    if (!entry) {
      this.expireUnrecoverable(row);
      return false;
    }
    if (row.outcome === "dispatch_result") {
      // The dispatch already had the result, so the turn delivers it. Give the turn time
      // to settle; if it died (the crash after a tool returns), the stored result is sent
      // here instead of being lost.
      if (Date.now() - row.created_at < DISPATCH_GRACE_MS) return false;
      return this.deliverOnce(row, row.result ? { stored: row.result } : {});
    }
    // A row with an id is read only by that id. The goal/window fallback is exclusively
    // for a row that never got an id.
    const candidates = row.run_id
      ? runs.filter((candidate) => candidate.run_id === row.run_id)
      : runs.filter(
          (candidate) =>
            !this.app.store.get(
              "SELECT 1 FROM pending_jobs WHERE run_id=? AND id<>?",
              candidate.run_id,
              row.id,
            ) &&
            !!row.goal &&
            this.sameGoal(candidate.goal, row.goal) &&
            candidate.created_at >= row.created_at - SLACK_MS,
        );
    const timedOut = Date.now() - row.created_at > this.timeoutMs();
    if (!row.run_id && candidates.length > 1) {
      // Two runs could be this job: claiming either would deliver the wrong result.
      this.app.store.run(
        "UPDATE pending_jobs SET job_state='unknown', next_poll_at=? WHERE id=?",
        Date.now() + this.backoffMs(entry.manifest, row.attempts + 1),
        row.id,
      );
      if (!row.notified_at)
        await this.warn(row, {
          run_id: "?",
          state: "unknown",
          status: "AMBIGUOUS",
          created_at: row.created_at,
        });
      return false;
    }
    const run = candidates[0];
    if (!run) {
      if (!timedOut) return false;
      // Never turn a stale observation into TIMEOUT: re-read the run (by id when the row
      // has one) and deliver it if it is already terminal.
      const fresh = await this.refresh(row, entry);
      if (fresh.run) {
        this.noteState(row, entry.manifest, fresh.run);
        return this.settle(row, [fresh.run]);
      }
      if (fresh.error && isInputInvalid(fresh.error)) {
        await this.failInput(row, fresh.error);
        return false;
      }
      if (!row.notified_at) {
        await this.warn(row, undefined, fresh.error);
        return false;
      }
      const max = entry.manifest.poll?.maxAttempts ?? MAX_LIST_FAILURES;
      if (row.attempts >= max)
        this.expireTerminal(
          row,
          "provider_timeout",
          "timeout sem execução encontrada",
        );
      return false;
    }
    this.noteState(row, entry.manifest, run);
    // A finished job whose payload carries no result is gone, not failed: providers expire
    // results, and saying so once beats looping for ever.
    if (run.state === "done" && run.result === undefined) {
      this.app.store.run(
        "UPDATE pending_jobs SET outcome='expired' WHERE id=?",
        row.id,
      );
      return this.deliverOnce(
        row,
        {
          notice: `O job ${this.label(row)} terminou, mas o provedor não devolveu o resultado (expirado). Nada será repetido.`,
        },
        "expired",
      );
    }
    // Claim the id so a second registration cannot deliver the same run.
    if (!row.run_id) {
      if (!this.claimRun(row.id, run.run_id)) return false;
      row.run_id = run.run_id;
    }
    if (!isTerminal(run.state) && run.state !== "unknown") {
      // Alive: only a long wait earns a notice, never "não entregou resultado".
      if (timedOut && !row.notified_at) await this.warn(row, run);
      return false;
    }
    if (run.state === "done") {
      this.persistResult(row, run);
      return this.deliverOnce(row, { result: run });
    }
    if (run.state === "failed" || run.state === "cancelled")
      return this.deliverOnce(
        row,
        {
          notice: [
            "Um job assíncrono disparado neste tópico não entregou resultado.",
            row.goal ? `Objetivo: ${row.goal}` : "",
            `O job ${this.label(row)} terminou como ${run.status || run.state}.`,
            run.run_id ? `Execução no provedor: ${run.run_id}.` : "",
            run.error ? `Erro do provedor: ${run.error}` : "",
            run.num_of_steps ? `Passos executados: ${run.num_of_steps}.` : "",
            "Avise o usuário em uma linha. Não dispare novos jobs.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        run.state === "failed" ? "failed" : "cancelled",
      );
    return false;
  }

  /**
   * The last read a timeout notice is based on. A row with an id is read by it; a row
   * that never got one is reconciled by the goal suffix inside the manifest window.
   */
  private async refresh(
    row: PendingJob,
    entry: JobTool,
  ): Promise<{ run?: Run; error?: string }> {
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
    if (!gateway?.callDirect) return { error: "gateway indisponível" };
    try {
      const observe = entry.manifest.observe;
      if (row.run_id && observe.tool) {
        const built = this.readInput(observe.args ?? {}, row, entry);
        if (!built.ok) return { error: built.error };
        const executed = await gateway.callDirect(
          this.executorServer(),
          "execute",
          { code: sandboxCall(observe.tool, built.input) },
          { signal: AbortSignal.timeout(this.readTimeoutMs()) },
        );
        const payload = programResult(executed);
        const run =
          runsOf(payload, entry.manifest).find(
            (candidate) => candidate.run_id === row.run_id,
          ) ?? this.runFromPayload(entry.manifest, payload, row.run_id);
        if (
          run &&
          (run.status || run.result !== undefined || run.state !== "unknown")
        )
          return { run };
        return { error: `a leitura não devolveu o run ${row.run_id}` };
      }
      const reconcile =
        entry.manifest.reconcile ??
        (observe.mode === "reconcile" && observe.tool
          ? {
              tool: observe.tool,
              args: observe.args ?? {},
              match: "goalSuffix" as const,
            }
          : undefined);
      if (!reconcile)
        return { error: "sem job_id e sem ferramenta de reconciliação" };
      const built = this.readInput(reconcile.args, row, entry);
      if (!built.ok) return { error: built.error };
      const executed = await gateway.callDirect(
        this.executorServer(),
        "execute",
        { code: sandboxCall(reconcile.tool, built.input) },
        { signal: AbortSignal.timeout(this.readTimeoutMs()) },
      );
      const window = Date.now() - (reconcile.windowMinutes ?? 15) * 60_000;
      const candidates = runsOf(programResult(executed), entry.manifest).filter(
        (candidate) =>
          !this.app.store.get(
            "SELECT 1 FROM pending_jobs WHERE run_id=? AND id<>?",
            candidate.run_id,
            row.id,
          ) &&
          candidate.created_at >= Math.min(window, row.created_at - SLACK_MS) &&
          !!row.goal &&
          (reconcile.match === "goalExact"
            ? (candidate.goal ?? "").trim().toLowerCase() ===
              row.goal.trim().toLowerCase()
            : this.sameGoal(candidate.goal, row.goal)),
      );
      if (candidates.length === 1) return { run: candidates[0] };
      if (candidates.length > 1)
        return { error: "duas execuções candidatas na última leitura" };
      return { error: "nenhuma execução encontrada na última leitura" };
    } catch (error) {
      return { error: this.errorText(error) };
    }
  }

  private async argsOrFail(
    row: PendingJob,
    entry: JobTool,
    template: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    const built = this.readInput(template, row, entry);
    if (built.ok) return built.input;
    await this.failInput(row, built.error);
    return undefined;
  }

  private async failIfInputInvalid(row: PendingJob, error: unknown) {
    if (!isInputInvalid(error)) return false;
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    await this.failInput(row, message.trim() || "Input failed validation");
    return true;
  }

  /**
   * A 422 / InputInvalid read can never succeed unchanged. Close now and say
   * why — not "status desconhecido" after a long backoff.
   */
  private async failInput(row: PendingJob, message: string) {
    const text = message.trim().slice(0, 1500) || "Input failed validation";
    this.app.store.run(
      `UPDATE pending_jobs SET job_state='failed', last_status='INPUT_INVALID',
         last_error=?, last_seen_at=?
       WHERE id=? AND delivered_at IS NULL`,
      text,
      Date.now(),
      row.id,
    );
    await this.deliverOnce(
      row,
      {
        notice: [
          `A leitura do job ${row.id} (${this.rowPath(row)}) falhou na validação: ${text}`,
          "Avise o usuário em uma linha, citando a causa da validação. Não diga que o status é desconhecido. Não dispare outro job.",
        ].join("\n"),
      },
      "input_invalid",
    );
  }

  private errorText(error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    return message.trim().slice(0, 300) || "erro desconhecido";
  }

  /** A failed read only becomes a notice after the timeout, and never for a terminal run. */
  private async warnIfTimedOut(row: PendingJob, error: unknown) {
    if (row.notified_at) return;
    if (Date.now() - row.created_at <= this.timeoutMs()) return;
    const state = row.job_state as JobState | null;
    if (state && isTerminal(state)) return;
    await this.warn(row, undefined, error);
  }

  /**
   * The provider rewrites the goal it returns ("Navigate to <url> to complete the goal:
   * <ours>"), so equality never matches; the sent goal is the tail of the stored one.
   */
  private sameGoal(returned: string | null | undefined, sent: string | null) {
    if (!returned || !sent) return false;
    const a = returned.trim().toLowerCase();
    const b = sent.trim().toLowerCase();
    return a === b || a.endsWith(b);
  }

  /** A notice must say which job it is about: id, tool and provider. */
  private label(row: PendingJob) {
    return `job ${row.id} (${this.rowPath(row)})`;
  }

  /** Keeps the run's own result on the row, not a summary of the conversation. */
  private persistResult(row: PendingJob, run: Run) {
    if (row.outcome === "dispatch_result" || run.result === undefined) return;
    this.app.store.run(
      "UPDATE pending_jobs SET result=? WHERE id=?",
      JSON.stringify(run.result).slice(0, 8000),
      row.id,
    );
  }

  /** Warns once that a run is taking too long; the row stays open for the result. */
  private async warn(row: PendingJob, run?: Run, error?: unknown) {
    const lastState =
      run?.state ?? (row.job_state as JobState | null) ?? "unknown";
    // A terminal run is delivered, never announced as a timeout.
    if (!error && isTerminal(lastState)) return;
    const changed = this.app.store.run(
      "UPDATE pending_jobs SET notified_at=? WHERE id=? AND notified_at IS NULL",
      Date.now(),
      row.id,
    ).changes;
    if (!changed) return;
    const lastStatus =
      run?.status ||
      row.last_status ||
      row.job_state?.toUpperCase() ||
      "desconhecido";
    const lastAt = new Date(
      run ? Date.now() : (row.last_seen_at ?? row.created_at),
    );
    const clock = lastAt.toISOString().slice(11, 16);
    const terminal =
      isTerminal(lastState) ||
      [
        "COMPLETED",
        "COMPLETE",
        "SUCCESS",
        "SUCCEEDED",
        "DONE",
        "FINISHED",
        "FAILED",
        "ERROR",
        "TIMED_OUT",
        "TIMEOUT",
        "REJECTED",
        "CANCELLED",
        "CANCELED",
        "ABORTED",
        "STOPPED",
        "REVOKED",
      ].includes(lastStatus.toUpperCase());
    const errorText = error === undefined ? undefined : this.errorText(error);
    await this.submit(row, [
      errorText
        ? `O job assíncrono ${this.label(row)} não pôde ser relido: ${errorText}.`
        : terminal
          ? `O job assíncrono ${this.label(row)} consta como ${lastStatus} na última leitura.`
          : `O job assíncrono ${this.label(row)} ainda não terminou.`,
      row.run_id ? `Execução no provedor: ${row.run_id}.` : "",
      row.goal ? `Objetivo: ${row.goal}` : "",
      `Última leitura: ${lastStatus} às ${clock}.`,
      `Status: ${lastStatus} depois de ${Math.round(this.timeoutMs() / 60_000)} minutos.`,
      errorText
        ? "Avise o usuário em uma linha que não foi possível confirmar o status; não afirme que o job ainda está em execução nem invente um resultado. Não dispare novos jobs."
        : terminal
          ? "Avise em uma linha que o job consta como terminado na última leitura e que o resultado ainda não foi confirmado; não diga que ainda está em execução. Não dispare novos jobs."
          : "Avise o usuário em uma linha de que o job continua rodando; o resultado chegará quando terminar. Não dispare novos jobs.",
    ]);
  }
  /** Stable per job; a re-delivery of the same job is the same request. */
  private dedupeFor(row: PendingJob) {
    return `job:${row.id}:${row.run_id ?? "unknown"}`;
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
      // `{status:"completed", execution:{...}}` is the Executor wrapper. Its
      // status is the call, not the job — including when statePath is `status`.
      if (isExecutorEnvelope(body)) {
        const execution = body.execution as Record<string, unknown>;
        if (execution.ok === false) return undefined;
        if (execution.value !== undefined && execution.value !== null)
          return walk(execution.value, depth + 1);
        return undefined;
      }
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
    const found = walk(payload);
    if (found) return found;
    if (isExecutorEnvelope(payload)) return {};
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  }
  /** One observed payload, read through the manifest, as the core's own run shape. */
  private runFromPayload(
    manifest: JobManifest,
    payload: unknown,
    fallbackId?: string | null,
  ): Run | undefined {
    // An Executor error or a paused call is not a finished job. Reading the
    // wrapper's `status:"completed"` here is what produced the false "expirado".
    if (isExecutorFailure(payload) || isExecutorApproval(payload))
      return undefined;
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
    if (isExecutorEnvelope(job) || isExecutorFailure(job)) return undefined;
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
  /**
   * Delivers exactly once. The row closes only after the send returns, and the request id
   * (`job:<row>:<id>`) makes a retry of the same job harmless.
   */
  private async deliverOnce(
    row: PendingJob,
    outcome: { result?: Run; notice?: string; stored?: string },
    forcedOutcome?: string,
  ): Promise<boolean> {
    const current = this.app.store.get<{
      delivered_at: number | null;
      outcome: string | null;
      run_id: string | null;
    }>(
      "SELECT delivered_at,outcome,run_id FROM pending_jobs WHERE id=?",
      row.id,
    );
    if (!current || current.delivered_at) return false;
    // A run id claimed by this settlement is the one in the dedupe key, even if the local
    // row object predates the claim.
    const deliveryRow = current.run_id
      ? { ...row, run_id: current.run_id }
      : row;
    const resultText =
      outcome.stored ??
      (outcome.result
        ? JSON.stringify(outcome.result.result ?? outcome.result)
        : undefined);
    const prCandidate =
      outcome.result?.result && typeof outcome.result.result === "object"
        ? (outcome.result.result as Record<string, unknown>).pr
        : outcome.result && typeof outcome.result === "object"
          ? (outcome.result as unknown as Record<string, unknown>).pr
          : undefined;
    const pr =
      typeof prCandidate === "string" && prCandidate.trim()
        ? prCandidate.trim()
        : undefined;
    const prompt =
      resultText !== undefined
        ? [
            "Um job assíncrono disparado neste tópico terminou.",
            row.goal ? `Objetivo: ${row.goal}` : "",
            `Status: ${outcome.result?.status ?? "COMPLETED"}`,
            pr ? `Pull Request: ${pr}` : "",
            `Resultado:\n${resultText.slice(0, 8000)}`,
            pr
              ? `Resuma em poucas linhas o que aconteceu e o que importa para o usuário, citando o link do Pull Request (${pr}). Não dispare novos jobs.`
              : "Resuma em poucas linhas o que aconteceu e o que importa para o usuário. Não dispare novos jobs.",
          ]
            .filter(Boolean)
            .join("\n")
        : (outcome.notice ??
          "Um job assíncrono disparado neste tópico não entregou resultado.");
    const delivery = await this.submit(deliveryRow, prompt);
    const now = Date.now();
    if (delivery === "sent" || delivery === "silent") {
      const finalOutcome =
        forcedOutcome ??
        (current.outcome === "expired"
          ? "expired"
          : delivery === "sent"
            ? "delivered"
            : "silent");
      if (
        finalOutcome === "input_invalid" ||
        finalOutcome === "missing_account" ||
        finalOutcome === "ambiguous_account" ||
        finalOutcome === "expired" ||
        finalOutcome === "failed" ||
        finalOutcome === "cancelled"
      )
        this.app.store.run(
          "UPDATE pending_jobs SET delivered_at=?,outcome=? WHERE id=?",
          now,
          finalOutcome,
          row.id,
        );
      else
        this.app.store.run(
          "UPDATE pending_jobs SET delivered_at=?,outcome=?,last_error=NULL WHERE id=?",
          now,
          finalOutcome,
          row.id,
        );
      console.info(
        `jobs_poller: terminal outcome=${finalOutcome} job=${row.id} run_id=${deliveryRow.run_id ?? "unknown"}`,
      );
      return true;
    }
    const attempts = row.attempts + 1;
    const entry = this.match(row.integration, row.tool);
    const manifest = entry?.manifest ?? BUILTIN[0];
    if (attempts >= MAX_ATTEMPTS) {
      // The same crash can repeat; a row that never delivers must stop, not loop.
      this.app.store.run(
        `UPDATE pending_jobs SET attempts=?,delivered_at=?,outcome='expired',
           last_error=? WHERE id=?`,
        attempts,
        now,
        "delivery_failed",
        row.id,
      );
      console.warn(
        `jobs_poller: terminal outcome=expired job=${row.id} run_id=${deliveryRow.run_id ?? "unknown"} error=delivery_failed_after_${attempts}_attempts; desistindo da entrega. O resultado está em pending_jobs.result.`,
      );
      return false;
    }
    const retryMs = this.backoffMs(manifest, attempts);
    this.app.store.run(
      "UPDATE pending_jobs SET attempts=?,last_error=?,next_poll_at=? WHERE id=?",
      attempts,
      "delivery_failed",
      now + retryMs,
      row.id,
    );
    console.warn(
      `jobs_poller: delivery attempt ${attempts}/${MAX_ATTEMPTS} failed for job ${row.id}; retrying in ${retryMs / 1000}s`,
    );
    return false;
  }
  /**
   * Wakes the turn in the conversation the job came from. The request id is stable per
   * row and run, so a retry cannot produce two turns.
   */
  private async submit(
    row: PendingJob,
    prompt: string | string[],
  ): Promise<"sent" | "silent" | "failed"> {
    const conversationId = row.conversation_id;
    if (this.app.store.conversationDeleted(conversationId)) return "silent";
    this.enterJobTurn(conversationId);
    try {
      await this.app.submit(
        conversationId,
        this.dedupeFor(row),
        Array.isArray(prompt) ? prompt.filter(Boolean).join("\n") : prompt,
        "job",
      );
      return "sent";
    } catch {
      this.leaveJobTurn(conversationId);
      return "failed";
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

const TOOL_IDENT = /^[A-Za-z_$][\w$]*$/;
const TOOL_SEGMENT = /^[A-Za-z0-9_$:.-]+$/;

/**
 * A tool call as the Executor sandbox sees it. `tools.instabox.machines.exec` is a
 * property of the `tools` proxy, not an MCP tool name. The proxy is not a data value:
 * `o == null` is rejected as InvalidDataValue, so the program calls the path directly.
 * A hyphenated segment (`fish-audio`) uses a string key, which is still not a comparison.
 */
export function sandboxCall(tool: string, args: unknown) {
  return `return JSON.stringify(await ${sandboxToolExpression(tool)}(${JSON.stringify(args)}));`;
}

function sandboxToolExpression(tool: string) {
  const parts = String(tool ?? "")
    .split(".")
    .filter(Boolean);
  if (!parts.length || parts.some((part) => !TOOL_SEGMENT.test(part)))
    throw new Error(`caminho de ferramenta inválido: ${tool}`);
  if (parts[0] !== "tools") parts.unshift("tools");
  let expression = "tools";
  for (const part of parts.slice(1))
    expression += TOOL_IDENT.test(part)
      ? `.${part}`
      : `[${JSON.stringify(part)}]`;
  return expression;
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
  // A program that never ran (a TS annotation, a wrong path, a proxy compared
  // with ==) created nothing.
  if (
    /"kind"\s*:\s*"(?:ParseError|UnknownTool|InvalidDataValue|InvalidToolInput|UnsupportedSyntax)"/i.test(
      body,
    )
  )
    return true;
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

/** The JSON a program returned, from the tool result's content. */
function programResult(result: unknown) {
  // A failed or paused Executor call is an error, never a job payload. The
  // wrapper's `status:"completed"` must not reach jobObject.
  if (isExecutorFailure(result) || isExecutorApproval(result))
    throw new ExecutorProgramError(result);
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
    if (isExecutorFailure(candidate) || isExecutorApproval(candidate))
      throw new ExecutorProgramError(candidate);
    const payload = programPayload(candidate);
    if (payload === undefined || payload === null) continue;
    if (isExecutorFailure(payload) || isExecutorApproval(payload))
      throw new ExecutorProgramError(payload);
    return payload;
  }
  return undefined;
}

function statusWord(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function approvalId(body: Record<string, unknown>) {
  for (const key of ["requestId", "executionId"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Executor envelope `{status, execution}`. Its status is not a job state. */
function isExecutorEnvelope(
  value: unknown,
): value is Record<string, unknown> & { execution: Record<string, unknown> } {
  const body = asRecord(value);
  const execution = asRecord(body?.execution);
  return !!body && !!execution && typeof body.status === "string";
}

function notFoundText(message: string) {
  return (
    /\b404\b/.test(message) ||
    /not[\s_-]*found/i.test(message) ||
    /no\s*such\s*file/i.test(message) ||
    /arquivo\s*n[aã]o\s*encontrado/i.test(message)
  );
}

/**
 * Missing status.json comes back as a completed Executor call whose
 * `execution.error` wraps Instabox 404 / not_found. The wrapper status is
 * "completed", so the 404 has to be read from the nested error.
 */
function isNotFoundError(error: unknown, depth = 0): boolean {
  if (error == null || depth > 6) return false;
  if (typeof error === "number") return error === 404;
  if (typeof error === "string") return notFoundText(error);
  if (error instanceof Error) {
    const extra = error as { detail?: unknown; cause?: unknown };
    return (
      notFoundText(error.message) ||
      isNotFoundError(extra.detail, depth + 1) ||
      isNotFoundError(extra.cause, depth + 1)
    );
  }
  const body = asRecord(error);
  if (!body) return false;
  if (body.code === 404 || body.status === 404 || body.statusCode === 404)
    return true;
  for (const key of ["code", "status", "kind", "message"] as const) {
    const value = body[key];
    if (typeof value === "string" && notFoundText(value)) return true;
  }
  if (typeof body.error === "string" && notFoundText(body.error)) return true;
  for (const key of [
    "error",
    "response",
    "cause",
    "detail",
    "details",
    "data",
  ]) {
    const value = body[key];
    if (value && typeof value === "object" && isNotFoundError(value, depth + 1))
      return true;
  }
  const execution = asRecord(body.execution);
  if (execution?.ok === false)
    return isNotFoundError(execution.error ?? execution, depth + 1);
  return false;
}

function formatExecutorError(detail: unknown, depth = 0): string {
  if (detail == null || depth > 5) return "";
  if (typeof detail === "string" || typeof detail === "number")
    return String(detail);
  if (detail instanceof Error) {
    const extra = detail as { detail?: unknown };
    return [detail.message, formatExecutorError(extra.detail, depth + 1)]
      .filter(Boolean)
      .join(" ");
  }
  const body = asRecord(detail);
  if (!body) return "";
  const parts = ["kind", "code", "message"]
    .map((key) => body[key])
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
  // The envelope status is the call (`completed`), not the job and not the error.
  if (
    !isExecutorEnvelope(body) &&
    (typeof body.status === "string" || typeof body.status === "number") &&
    statusWord(body.status) !== "completed"
  )
    parts.push(String(body.status));
  if (Array.isArray(body.content)) {
    for (const item of body.content) {
      const text = asRecord(item)?.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  for (const key of ["error", "response", "cause", "detail", "execution"]) {
    const nested = formatExecutorError(body[key], depth + 1);
    if (nested) parts.push(nested);
  }
  return parts.join(" ").slice(0, 500);
}

/** A program the Executor rejected or paused. The poller must not treat it as a job. */
class ExecutorProgramError extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) {
    super(formatExecutorError(detail) || "erro do Executor");
    this.name = "ExecutorProgramError";
    this.detail = detail;
  }
}

type ExecutorCall =
  | { kind: "success"; value: unknown }
  | {
      kind: "failure";
      deterministic: boolean;
      notFound: boolean;
      message: string;
    }
  | { kind: "approval"; requestId: string; status: string };

/**
 * Whether a completed Executor error means the command never started. A 5xx,
 * a timeout or `retryable: true` may have started it; the row stays open.
 */
function failureIsDeterministic(detail: unknown) {
  if (deterministicFailure(detail)) return true;
  const text = formatExecutorError(detail);
  if (/\b5\d\d\b/.test(text)) return false;
  if (/timeout|timed out|capacity-exceeded|unavailable/i.test(text))
    return false;
  if (/"retryable"\s*:\s*true/i.test(JSON.stringify(detail ?? "")))
    return false;
  return true;
}

/**
 * What an `execute`/`call` result actually means. `status:"completed"` is the
 * Executor wrapper, not a job that finished.
 */
export function classifyExecutorCall(result: unknown): ExecutorCall {
  const bodies = executorBodies(result);
  for (const body of bodies) {
    if (!isExecutorApproval(body)) continue;
    const requestId = approvalId(body);
    return {
      kind: "approval",
      requestId,
      status: statusWord(body.status) || "paused",
    };
  }
  for (const body of bodies) {
    if (!isExecutorFailure(body)) continue;
    return {
      kind: "failure",
      deterministic: failureIsDeterministic(body),
      notFound: isNotFoundError(body),
      message: formatExecutorError(body) || "erro do Executor",
    };
  }
  return { kind: "success", value: programPayload(result) };
}

/** Non-zero exit from `machines.exec` means the launcher did not stay running. */
export function commandExitCode(value: unknown): number | undefined {
  const record = asRecord(value) ?? asRecord(tryParseJson(value));
  if (!record) return undefined;
  const code = record.exitCode ?? record.exit_code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && /^-?\d+$/.test(code.trim()))
    return Number(code.trim());
  return undefined;
}

function tryParseJson(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
