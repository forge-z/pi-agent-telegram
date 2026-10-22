import { asRecord } from "./executor-result.js";

/**
 * Declarative job manifests: everything provider-specific about an async job, in config.
 * The core only knows state, queue, dedupe and delivery, so a new integration is a manifest,
 * not a patch.
 */

export type JobState =
  "pending" | "running" | "done" | "failed" | "cancelled" | "unknown";

/** Where the id comes from: at dispatch, later, or nowhere (blocking call). */
type DispatchMode = "immediate" | "deferred" | "opaque";
/** How the job is watched: a status call, an pushed event, or a search. */
type ObserveMode = "poll" | "webhook" | "reconcile";

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
  /** Concrete account baked into this manifest. The invocation's accountId wins. */
  accountId?: string;
  poll?: { intervalSeconds?: number; backoff?: number[]; maxAttempts?: number };
  /** A job absent for this long is `unknown`, and silence is the correct answer. */
  graceMinutes?: number;
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
function applyTemplate(
  value: unknown,
  vars: Record<string, string | number | undefined>,
): unknown {
  if (typeof value === "string")
    return value.replace(/\$\{(\w+)\}/g, (whole, name: string) =>
      vars[name] === undefined || vars[name] === ""
        ? whole
        : String(vars[name]),
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

export type ReadInput =
  | {
      ok: true;
      input: { accountId: string; input: Record<string, unknown> };
    }
  | { ok: false; error: string };

/**
 * Every v2 tool takes `{ accountId, input }`. Manifests may already say that,
 * or only the inner `input` (`{ path }`, `{ query }`, `{ id, path }`).
 * A missing account or a non-object `input` is a validation error, not a retry.
 */
export function buildReadInput(
  args: unknown,
  vars: Record<string, string | number | undefined>,
): ReadInput {
  const rendered = applyTemplate(args ?? {}, vars);
  const body = asRecord(rendered);
  if (!body)
    return {
      ok: false,
      error: "input: Expected object {accountId, input}",
    };
  let accountId =
    typeof body.accountId === "string" ? body.accountId.trim() : "";
  let input = asRecord(body.input);
  if (!input) {
    const inner = { ...body };
    delete inner.accountId;
    if (inner.path || inner.query || inner.id) input = inner;
  }
  if (!accountId) accountId = String(vars.accountId ?? "").trim();
  if ("input" in body && !asRecord(body.input))
    return {
      ok: false,
      error: "input: Expected object {accountId, input}",
    };
  if (!accountId || accountId.includes("${"))
    return {
      ok: false,
      error: "accountId ausente na leitura",
    };
  if (!input)
    return {
      ok: false,
      error: "input: Expected object {accountId, input}",
    };
  return { ok: true, input: { accountId, input } };
}

export const INSTABOX_CODE_TASK_TOOL = "internal.instabox.codeTask";

export const BUILTIN: JobManifest[] = [
  {
    tool: "tools.tinyfish.agent.automation.runAsync",
    dispatch: { mode: "immediate", idPath: "run_id" },
    observe: {
      mode: "poll",
      tool: "tools.tinyfish.agent.runs.getRunById",
      args: {
        accountId: "${accountId}",
        input: { path: { id: "${job_id}" } },
      },
      statePath: "status",
      resultPath: "result",
      errorPath: "error",
    },
    reconcile: {
      tool: "tools.tinyfish.agent.runs.listRuns",
      args: {
        accountId: "${accountId}",
        input: {
          query: {
            goal: "${goal}",
            limit: 20,
            sort_direction: "desc",
          },
        },
      },
      match: "goalSuffix",
      windowMinutes: 15,
    },
    poll: { intervalSeconds: 25, backoff: [25, 60, 150], maxAttempts: 3 },
    graceMinutes: 5,
  },
];

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parses `ASYNC_JOB_MANIFESTS` (a JSON array) and adds the in-code app manifests. */
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
  for (const manifest of BUILTIN) {
    if (manifests.some((entry) => entry.tool === manifest.tool)) continue;
    manifests.push(manifest);
  }

  const instaboxMachineId = (env.INSTABOX_MACHINE_ID ?? "").trim();
  if (
    instaboxMachineId &&
    !manifests.some((entry) => entry.tool === INSTABOX_CODE_TASK_TOOL)
  ) {
    const instaboxAccountId = (env.INSTABOX_ACCOUNT_ID ?? "").trim();
    manifests.push({
      tool: INSTABOX_CODE_TASK_TOOL,
      dispatch: { mode: "immediate" },
      observe: {
        mode: "poll",
        tool: "tools.instabox.machines.readFiles",
        args: {
          accountId: instaboxAccountId || "${accountId}",
          input: {
            id: instaboxMachineId,
            path: "/data/home/jobs/${id}/status.json",
          },
        },
        statePath: "state",
        resultPath: "result",
        errorPath: "error",
      },
      poll: { intervalSeconds: 20, backoff: [20, 30, 60], maxAttempts: 3 },
      graceMinutes: 3,
    });
  }

  return manifests;
}

/** Whether a state means the watch can stop. */
export function isTerminal(state: JobState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}
