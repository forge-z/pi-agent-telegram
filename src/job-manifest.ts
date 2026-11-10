import { asRecord } from "./executor-result.js";
import { envWithDiscovery } from "./discover.js";
import { loadHarnessConfig } from "./harness-config.js";

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
  /**
   * MCP server for status reads. `executor` or omitted runs the observe tool
   * inside Executor `execute`. Any other name is called directly.
   */
  server?: string;
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
export function renderTemplate(
  value: unknown,
  vars: Record<string, string | number | undefined>,
): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{(\w+)\}$/.exec(value);
    if (whole && (vars[whole[1]] === undefined || vars[whole[1]] === ""))
      return undefined;
    return value.replace(/\$\{(\w+)\}/g, (part, name: string) =>
      vars[name] === undefined || vars[name] === "" ? part : String(vars[name]),
    );
  }
  if (Array.isArray(value))
    return value.map((item) => renderTemplate(item, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderTemplate(item, vars),
      ]),
    );
  return value;
}

export type ReadInput =
  { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

/**
 * Every v2 tool takes `{ accountId, input }`. Manifests may already say that,
 * or only the inner `input` (`{ path }`, `{ query }`, `{ id, path }`).
 * A missing account or a non-object `input` is a validation error, not a retry.
 */
export function buildReadInput(
  args: unknown,
  vars: Record<string, string | number | undefined>,
): ReadInput {
  const rendered = renderTemplate(args ?? {}, vars);
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

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeManifest(entry: Record<string, unknown>): JobManifest {
  const manifest = entry as unknown as JobManifest;
  const server =
    typeof manifest.server === "string" ? manifest.server.trim() : "";
  const rest = { ...manifest };
  delete rest.server;
  return {
    ...rest,
    ...(server ? { server } : {}),
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
  };
}

const ENV_VAR = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const ENV_LEFT = /\$\{[A-Z][A-Z0-9_]*\}/;

function fillEnv(
  value: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string")
    return value.replace(ENV_VAR, (whole, name: string) => {
      const filled = env[name]?.trim();
      if (filled) return filled;
      // An unset account env falls back to the dispatch's account, as before.
      return name.endsWith("_ACCOUNT_ID") ? "${accountId}" : whole;
    });
  if (Array.isArray(value)) return value.map((item) => fillEnv(item, env));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        fillEnv(item, env),
      ]),
    );
  return value;
}

/** Fills `${ENV_VAR}` from the environment; a backend missing one stays disabled. */
function withEnv(
  manifests: JobManifest[],
  env: Record<string, string | undefined>,
): JobManifest[] {
  const merged = envWithDiscovery(env);
  return manifests.flatMap((manifest) => {
    const filled = fillEnv(manifest, merged) as JobManifest;
    return ENV_LEFT.test(JSON.stringify(filled)) ? [] : [filled];
  });
}

/**
 * Jobs from config.yaml, then `ASYNC_JOB_MANIFESTS` on top. The same `tool`
 * in the env replaces the yaml entry. Invalid JSON still throws, and the
 * poller turns that into "manifesto inválido; desligado".
 */
export function loadManifests(
  env: Record<string, string | undefined> = process.env,
): JobManifest[] {
  const manifests = loadHarnessConfig(env)
    .asyncJobs.filter(
      (entry): entry is Record<string, unknown> =>
        object(entry) && typeof entry.tool === "string",
    )
    .map((entry) => normalizeManifest(entry));
  const raw = (env.ASYNC_JOB_MANIFESTS ?? "").trim();
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!object(entry) || typeof entry.tool !== "string") continue;
      const manifest = normalizeManifest(entry);
      const index = manifests.findIndex((item) => item.tool === manifest.tool);
      if (index >= 0) manifests[index] = manifest;
      else manifests.push(manifest);
    }
  }
  return withEnv(manifests, env);
}

/** Whether a state means the watch can stop. */
export function isTerminal(state: JobState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}
