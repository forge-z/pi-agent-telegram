import { loadHarnessConfig } from "./harness-config.js";
import {
  asRecord,
  isExecutorApproval,
  isExecutorFailure,
  programPayload,
} from "./executor-result.js";

/**
 * Fills `${ENV_VAR}` from a manifest `discover` step when the variable is unset.
 * The tool path and the selector live in config. A set env var wins.
 * Resolved values stay on the env object for the process lifetime.
 */

type Env = Record<string, string | undefined>;

export type DiscoveryCall = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

interface Step {
  var: string;
  tool: string;
  server?: string;
  args: Record<string, unknown>;
  pick?: "single";
  list?: string;
  id: string;
  label: string;
  prefer?: string;
  running?: string;
}

type Choice = { ok: true; id: string } | { ok: false; error: string };

const caches = new WeakMap<object, Map<string, string>>();
const TOOL_IDENT = /^[A-Za-z_$][\w$]*$/;
const TOOL_SEGMENT = /^[A-Za-z0-9_$:.-]+$/;
const ENV_REF = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const ACCOUNT_ID = /\b(acc[_-][0-9a-z_-]{4,})(?:\s*\(([^)]*)\))?/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cacheOf(env: object) {
  let cache = caches.get(env);
  if (!cache) {
    cache = new Map();
    caches.set(env, cache);
  }
  return cache;
}

/** Drops resolved ids so the next lookup runs again. */
export function clearDiscovery(env: object) {
  caches.delete(env);
}

/** Env values win. Blank env entries do not hide a resolved id. */
export function envWithDiscovery(env: Env): Env {
  const merged: Env = {};
  for (const [key, value] of cacheOf(env)) merged[key] = value;
  for (const [key, value] of Object.entries(env)) {
    if (value?.trim()) merged[key] = value;
  }
  return merged;
}

function defined(env: Env, name: string) {
  return env[name]?.trim() || cacheOf(env).get(name)?.trim() || "";
}

function refsOf(value: unknown) {
  return [...JSON.stringify(value ?? "").matchAll(ENV_REF)].map(
    (match) => match[1],
  );
}

function parseStep(value: unknown): Step | undefined {
  if (!isRecord(value)) return;
  const name = typeof value.var === "string" ? value.var.trim() : "";
  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !tool) return;
  const list = typeof value.list === "string" ? value.list.trim() : "";
  const prefer = typeof value.prefer === "string" ? value.prefer.trim() : "";
  const running = typeof value.running === "string" ? value.running.trim() : "";
  const server = typeof value.server === "string" ? value.server.trim() : "";
  return {
    var: name,
    tool,
    ...(server ? { server } : {}),
    args: isRecord(value.args) ? value.args : {},
    ...(value.pick === "single" ? { pick: "single" } : {}),
    ...(list ? { list } : {}),
    id:
      typeof value.id === "string" && value.id.trim() ? value.id.trim() : "id",
    label:
      typeof value.label === "string" && value.label.trim()
        ? value.label.trim()
        : "name",
    ...(prefer ? { prefer } : {}),
    ...(running ? { running } : {}),
  };
}

function discoverySteps(env: Env): Step[] {
  const config = loadHarnessConfig(env);
  const raw = [
    ...config.asyncJobs.flatMap((job) =>
      isRecord(job) && Array.isArray(job.discover) ? job.discover : [],
    ),
    ...(isRecord(config.sandboxTask) &&
    Array.isArray(config.sandboxTask.discover)
      ? config.sandboxTask.discover
      : []),
  ];
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const step = parseStep(item);
    if (!step || seen.has(step.var)) continue;
    seen.add(step.var);
    steps.push(step);
  }
  return steps;
}

function plan(env: Env, templates: unknown[]) {
  const steps = discoverySteps(env);
  const wanted = new Set(
    refsOf(templates).filter((name) => !defined(env, name)),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) {
      if (!wanted.has(step.var)) continue;
      for (const name of refsOf(step.args)) {
        if (!defined(env, name) && !wanted.has(name)) {
          wanted.add(name);
          grew = true;
        }
      }
    }
  }
  return steps.filter((step) => wanted.has(step.var));
}

function renderValue(value: unknown, vars: Env): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{(\w+)\}$/.exec(value);
    if (whole) return vars[whole[1]]?.trim() || undefined;
    return value.replace(/\$\{(\w+)\}/g, (part, name: string) => {
      const filled = vars[name]?.trim();
      return filled || part;
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, vars));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderValue(item, vars),
      ]),
    );
  return value;
}

/** A dotted tool path inside Executor `execute`, not an MCP tool name. */
function executorProgram(tool: string, args: unknown) {
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
  return `return JSON.stringify(await ${expression}(${JSON.stringify(args)}));`;
}

function readPath(value: unknown, path: string) {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function records(value: unknown, list?: string) {
  const payload = programPayload(value) ?? value;
  if (Array.isArray(payload)) return payload.filter(isRecord);
  const body = asRecord(payload);
  if (!body) return [];
  const raw = list ? readPath(body, list) : undefined;
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (list) return [];
  for (const key of ["machines", "data", "items", "accounts"]) {
    if (Array.isArray(body[key])) return body[key].filter(isRecord);
  }
  return [];
}

function linkedAccounts(value: unknown) {
  const payload = programPayload(value) ?? value;
  const namespaces = asRecord(payload)?.namespaces;
  if (!Array.isArray(namespaces)) return [];
  const found = new Map<string, string>();
  for (const entry of namespaces) {
    const accounts = asRecord(entry)?.accounts;
    if (typeof accounts !== "string") continue;
    for (const match of accounts.matchAll(ACCOUNT_ID)) {
      const id = match[1];
      if (!id || found.has(id)) continue;
      found.set(id, match[2]?.trim() || id);
    }
  }
  return [...found].map(([id, label]) => ({ id, label }));
}

function sawNamespaces(value: unknown) {
  const payload = programPayload(value) ?? value;
  return Array.isArray(asRecord(payload)?.namespaces);
}

function clip(text: string) {
  return text.slice(0, 800);
}

function listed(items: { label: string; id: string; state?: string }[]) {
  return items
    .map((item) =>
      item.state
        ? `${item.label} (${item.id}, ${item.state})`
        : `${item.label} (${item.id})`,
    )
    .join(", ");
}

function rejected(value: unknown) {
  const payload = programPayload(value);
  if (isExecutorApproval(value) || isExecutorApproval(payload))
    return "a listagem aguarda aprovação";
  if (isExecutorFailure(value) || isExecutorFailure(payload))
    return "a listagem falhou";
  return "";
}

function selectSingle(step: Step, value: unknown): Choice {
  const linked = linkedAccounts(value);
  if (linked.length === 1) return { ok: true, id: linked[0]!.id };
  if (linked.length > 1)
    return {
      ok: false,
      error: clip(
        `Não foi possível resolver ${step.var}: há mais de uma conta. Encontradas: ${listed(linked)}.`,
      ),
    };
  if (sawNamespaces(value))
    return {
      ok: false,
      error: `Não foi possível resolver ${step.var}: nenhuma conta encontrada.`,
    };
  const items = records(value, step.list)
    .map((item) => ({
      id: String(item[step.id] ?? "").trim(),
      label: String(item[step.label] ?? item[step.id] ?? "").trim(),
    }))
    .filter((item) => item.id);
  if (items.length === 1) return { ok: true, id: items[0]!.id };
  if (!items.length)
    return {
      ok: false,
      error: `Não foi possível resolver ${step.var}: nenhuma conta encontrada.`,
    };
  return {
    ok: false,
    error: clip(
      `Não foi possível resolver ${step.var}: há mais de uma conta. Encontradas: ${listed(items)}.`,
    ),
  };
}

function selectNamed(step: Step, value: unknown): Choice {
  const stateKey = step.running ?? "";
  const items = records(value, step.list)
    .map((item) => ({
      id: String(item[step.id] ?? "").trim(),
      label:
        String(item[step.label] ?? "").trim() ||
        String(item[step.id] ?? "").trim(),
      state: stateKey ? String(item[stateKey] ?? "").trim() : "",
    }))
    .filter((item) => item.id);
  const prefer = step.prefer ?? "";
  const named = prefer
    ? items.filter((item) => item.label.toLowerCase() === prefer.toLowerCase())
    : [];
  if (named.length === 1) return { ok: true, id: named[0]!.id };
  const found = items.length ? ` Encontradas: ${listed(items)}.` : "";
  if (named.length > 1)
    return {
      ok: false,
      error: clip(
        `Não foi possível resolver ${step.var}: há mais de uma máquina chamada "${prefer}".${found}`,
      ),
    };
  const running = stateKey
    ? items.filter((item) => item.state.toLowerCase() === "running")
    : [];
  if (running.length === 1) return { ok: true, id: running[0]!.id };
  if (!items.length)
    return {
      ok: false,
      error: `Não foi possível resolver ${step.var}: nenhuma máquina encontrada.`,
    };
  const why = prefer
    ? `nenhuma máquina chamada "${prefer}" e não há exatamente uma em execução`
    : "não há exatamente uma máquina em execução";
  return {
    ok: false,
    error: clip(`Não foi possível resolver ${step.var}: ${why}.${found}`),
  };
}

function select(step: Step, value: unknown): Choice {
  const problem = rejected(value);
  if (problem)
    return {
      ok: false,
      error: `Não foi possível resolver ${step.var}: ${problem}.`,
    };
  if (step.pick === "single" || (!step.prefer && !step.running))
    return selectSingle(step, value);
  return selectNamed(step, value);
}

async function invoke(
  env: Env,
  call: DiscoveryCall,
  step: Step,
  args: Record<string, unknown>,
) {
  const executor = env.ASYNC_JOB_EXECUTOR?.trim() || "executor";
  const server = step.server || executor;
  const signal = AbortSignal.timeout(20_000);
  const viaExecute =
    step.tool.includes(".") && (server === executor || server === "executor");
  if (!viaExecute) return call(server, step.tool, args, { signal });
  return call(
    server,
    "execute",
    { code: executorProgram(step.tool, args) },
    { signal },
  );
}

/**
 * Runs the discover steps for `${ENV}` placeholders still empty in `templates`.
 * A later call with the same env object reuses the cached ids.
 */
export async function resolveTemplates(
  env: Env,
  call: DiscoveryCall,
  templates: unknown[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const step of plan(env, templates)) {
    if (defined(env, step.var)) continue;
    const rendered = renderValue(step.args, envWithDiscovery(env));
    try {
      const value = await invoke(
        env,
        call,
        step,
        isRecord(rendered) ? rendered : {},
      );
      const chosen = select(step, value);
      if (!chosen.ok) return chosen;
      cacheOf(env).set(step.var, chosen.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: clip(`Não foi possível resolver ${step.var}: ${message}`),
      };
    }
  }
  return { ok: true };
}

/**
 * Before a poll, fill ids the open rows' manifests still need.
 * Rows whose lookup failed are returned so the tick leaves them open.
 */
export async function ensureDiscovered(
  env: Env,
  call: DiscoveryCall,
  rows: { tool: string }[],
): Promise<Set<string>> {
  const jobs = loadHarnessConfig(env).asyncJobs.filter(isRecord);
  const steps = discoverySteps(env);
  const templates: unknown[] = [];
  const pending = new Set<string>();
  for (const row of rows) {
    const tool = row.tool.trim();
    const job = jobs.find((item) => item.tool === tool);
    if (!job || !isRecord(job.observe)) continue;
    const args = [
      job.observe.args,
      isRecord(job.reconcile) ? job.reconcile.args : undefined,
    ];
    const needed = refsOf(args).filter((name) => !defined(env, name));
    if (!needed.some((name) => steps.some((step) => step.var === name)))
      continue;
    templates.push(...args);
    pending.add(tool);
  }
  if (!templates.length) return new Set();
  try {
    const resolved = await resolveTemplates(env, call, templates);
    if (resolved.ok) return new Set();
    console.warn(`jobs_poller: ${resolved.error}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`jobs_poller: descoberta falhou (${message})`);
  }
  return pending;
}
