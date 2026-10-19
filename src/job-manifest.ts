/**
 * Declarative job manifests: everything provider-specific about an async job, in config.
 * The core only knows state, queue, dedupe and delivery, so a new integration is a manifest,
 * not a patch.
 */

export type JobState =
  "pending" | "running" | "done" | "failed" | "cancelled" | "unknown";

/** Where the id comes from: at dispatch, later, or nowhere (blocking call). */
export type DispatchMode = "immediate" | "deferred" | "opaque";
/** How the job is watched: a status call, an pushed event, or a search. */
export type ObserveMode = "poll" | "webhook" | "reconcile";

export interface JobManifest {
  /** Tool path that starts the job, e.g. `tools.tinyfish.agent.automation.runAsync`. */
  tool: string;
  dispatch: { mode: DispatchMode; idPath?: string };
  observe: {
    mode: ObserveMode;
    /** Tool path that reads the job (poll: one id; reconcile: a filter). */
    tool?: string;
    /** Arguments for that tool; `${id}` is replaced by the job id. */
    args?: Record<string, unknown>;
    statePath?: string;
    resultPath?: string;
    errorPath?: string;
    /** Provider vocabulary per normalized state. */
    states?: Partial<Record<Exclude<JobState, "unknown">, string[]>>;
    /** Attributes a reconcile search may filter by, e.g. `{ goal: "${goal}" }`. */
    match?: Record<string, string>;
    /** Provider account the read call is scoped to, when the tool requires one. */
    accountArg?: string;
  };
  /**
   * How to find the job when the dispatch never returned an id. Providers rewrite the goal
   * they store ("Navigate to <url> to complete the goal: <ours>"), so the match is a suffix.
   */
  reconcile?: {
    tool: string;
    args: Record<string, unknown>;
    match?: "goalSuffix" | "goalExact";
    windowMinutes?: number;
  };
  /** Template for the delivery dedupe key; `${row}` and `${id}` are substituted. */
  dedupe?: string;
  poll?: { intervalSeconds?: number; backoff?: number[]; maxAttempts?: number };
  /** A job absent for this long is `unknown`, and silence is the correct answer. */
  graceMinutes?: number;
  /** Internal: synthesized from ASYNC_JOB_TOOLS, handled by the battle-tested path. */
  synthetic?: boolean;
}

/** The provider vocabulary most job APIs use, so a minimal manifest still works. */
const DEFAULT_STATES: Record<Exclude<JobState, "unknown">, string[]> = {
  pending: ["PENDING", "QUEUED", "WAITING", "CREATED"],
  running: ["RUNNING", "IN_PROGRESS", "STARTED", "ACTIVE"],
  done: ["COMPLETED", "COMPLETE", "SUCCESS", "SUCCEEDED", "DONE", "FINISHED"],
  failed: ["FAILED", "ERROR", "TIMED_OUT", "TIMEOUT", "REJECTED"],
  cancelled: ["CANCELLED", "CANCELED", "ABORTED", "STOPPED", "REVOKED"],
};

const MODES: DispatchMode[] = ["immediate", "deferred", "opaque"];

/** Reads a dotted path; `a.b[0].c` works too. Undefined when any step is missing. */
export function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const step of path.split(".")) {
    for (const part of step.split(/[[\]]/).filter(Boolean)) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;
      current = Array.isArray(current)
        ? current[Number(part)]
        : (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

const ID_KEYS = ["run_id", "runId", "id", "jobId", "job_id"];

/**
 * Finds an id in a payload nobody described. Descends through envelopes, stops at the first
 * object that carries one, and never enters a run's own `result` - that is the job's output,
 * not another job.
 */
export function tolerantExtract(
  value: unknown,
  keys: string[] = ID_KEYS,
  depth = 0,
): unknown {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return undefined;
    try {
      return tolerantExtract(JSON.parse(trimmed), keys, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = tolerantExtract(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof body[key] === "string" && (body[key] as string).trim())
      return body[key];
  for (const [key, child] of Object.entries(body)) {
    if (key === "result") continue;
    const found = tolerantExtract(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Normalizes a provider status into the core's vocabulary, never guessing `failed`. */
export function jobState(manifest: JobManifest, value: unknown): JobState {
  const raw = readPath(value, manifest.observe.statePath) ?? value;
  const status = String(
    typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).status ?? "")
      : (raw ?? ""),
  )
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (!status) return "unknown";
  for (const [state, words] of Object.entries({
    ...DEFAULT_STATES,
    ...manifest.observe.states,
  }) as [Exclude<JobState, "unknown">, string[]][])
    if ((words ?? []).some((word) => word.toUpperCase() === status))
      return state;
  return "unknown";
}

/** Substitutes `${id}`, `${goal}` and `${row}` in a template value. */
export function applyTemplate(
  value: unknown,
  vars: Record<string, string | number | undefined>,
): unknown {
  if (typeof value === "string")
    return value.replace(/\$\{(\w+)\}/g, (whole, name: string) =>
      vars[name] === undefined ? whole : String(vars[name]),
    );
  if (Array.isArray(value))
    return value.map((item) => applyTemplate(item, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        applyTemplate(item, vars),
      ]),
    );
  return value;
}

/** The dedupe key of a delivery: stable for the same job, whatever re-sent it. */
export function dedupeKey(
  manifest: JobManifest,
  row: number,
  id: string | null,
): string {
  return applyTemplate(manifest.dedupe ?? "job:${row}:${id}", {
    row,
    id: id ?? "unknown",
  }) as string;
}

/**
 * The built-in job manifest for the official Executor v2 path. It is only usable when an
 * account id is configured, because every v2 job call is scoped to one account.
 */
export const BUILTIN: JobManifest[] = [
  {
    tool: "tools.tinyfish.agent.automation.runAsync",
    dispatch: { mode: "immediate", idPath: "value.run_id" },
    observe: {
      mode: "poll",
      tool: "tools.tinyfish.agent.runs.getRunById",
      args: { input: { path: { id: "${id}" } } },
      statePath: "status",
      resultPath: "result",
      errorPath: "error",
    },
    // The dispatch result does not survive an approval round-trip, so the job is found by
    // the goal we sent: the provider stores it as a suffix of its own rewritten goal.
    reconcile: {
      tool: "tools.tinyfish.agent.runs.listRuns",
      args: {
        input: {
          query: { goal: "${goal}", limit: 20, sort_direction: "desc" },
        },
      },
      match: "goalSuffix",
      windowMinutes: 15,
    },
    poll: { intervalSeconds: 25, backoff: [25, 60, 150], maxAttempts: 3 },
    graceMinutes: 5,
    dedupe: "job:${row}:${id}",
  },
];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Warned once per process, not once per read. */
let legacyWarned = false;

/**
 * Parses `ASYNC_JOB_MANIFESTS` (a JSON array) and, for deployments that predate manifests,
 * synthesize an equivalent one per `ASYNC_JOB_TOOLS` path so nothing breaks.
 */
export function loadManifests(
  env: Record<string, string | undefined> = process.env,
): JobManifest[] {
  const manifests: JobManifest[] = [];
  const raw = (env.ASYNC_JOB_MANIFESTS ?? "").trim();
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    for (const entry of Array.isArray(parsed) ? parsed : [parsed])
      if (object(entry) && typeof entry.tool === "string") {
        const manifest = entry as unknown as JobManifest;
        manifests.push({
          ...manifest,
          dispatch: {
            mode: MODES.includes(manifest.dispatch?.mode as DispatchMode)
              ? (manifest.dispatch.mode as DispatchMode)
              : "immediate",
            ...(manifest.dispatch?.idPath
              ? { idPath: manifest.dispatch.idPath }
              : {}),
          },
          observe: {
            ...manifest.observe,
            mode: manifest.observe?.mode ?? "poll",
          },
        });
      }
  }
  // v2 binds the account in the tool's own signature, so the built-in manifest needs no
  // account id from the environment; EXECUTOR_ACCOUNT_ID only overrides it.
  const account = (env.EXECUTOR_ACCOUNT_ID ?? "").trim();
  // The built-in v2 manifest is harmless where v2 is not there: its tool never appears in
  // a call, so no row is ever opened. That is why no version flag is needed.
  for (const manifest of BUILTIN) {
    if (manifests.some((entry) => entry.tool === manifest.tool)) continue;
    manifests.push(
      account
        ? {
            ...manifest,
            observe: {
              ...manifest.observe,
              args: { ...manifest.observe.args, accountId: account },
            },
          }
        : manifest,
    );
  }

  const legacy = (env.ASYNC_JOB_TOOLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (legacy.length && !legacyWarned) {
    legacyWarned = true;
    // Deprecated: a path list can only describe the v1 shape of a job.
    console.warn(
      "Jobs assíncronos: ASYNC_JOB_TOOLS está obsoleto; descreva o job em ASYNC_JOB_MANIFESTS (remoção prevista para 2026-12-31).",
    );
  }
  for (const path of legacy) {
    if (manifests.some((manifest) => manifest.tool === path)) continue;
    manifests.push({
      tool: path,
      synthetic: true,
      dispatch: { mode: "immediate" },
      // v1 shaped: the sibling `list_runs` reads runs, and a run that is absent is matched
      // by goal once it appears.
      observe: {
        mode: "reconcile",
        tool: `${path.slice(0, path.lastIndexOf("."))}.list_runs`,
        args: {
          created_after: "${since}",
          created_before: "${now}",
          sort_direction: "asc",
          limit: 20,
        },
        match: { goal: "${goal}" },
      },
      poll: { intervalSeconds: undefined },
    });
  }
  return manifests;
}

/** Whether a state means the watch can stop. */
export function isTerminal(state: JobState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}
