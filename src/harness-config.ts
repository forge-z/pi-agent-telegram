import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Product defaults in `config.default.yaml`, with an optional user file on top.
 * The user path is `$DATA_DIR/config.yaml` unless `CONFIG_FILE` is set.
 * A file that does not parse is logged and ignored. This never throws.
 */

type Env = Record<string, string | undefined>;

export interface ServerTools {
  trust: "trusted" | "untrusted";
  read: string[];
  write: string[];
  /** False when this server did not set `tools`, so it uses the executor lists. */
  ownTools: boolean;
}

export interface HarnessConfig {
  mcpServers: Record<string, ServerTools>;
  asyncJobs: unknown[];
  /** Worker timing from `async_job`. Absent numbers fall back in the poller. */
  asyncJob: { timeoutMin?: number; pollSeconds?: number };
  /** Raw `sandbox_code_task` block; the tool validates it before registering. */
  sandboxTask?: unknown;
  /** Folder names under `$DATA_DIR/skills`, in prompt order. */
  skillsAlways: string[];
}

const EMPTY: HarnessConfig = {
  mcpServers: {},
  asyncJobs: [],
  asyncJob: {},
  skillsAlways: [],
};
const globCache = new Map<string, RegExp | null>();
let cache: { key: string; config: HarnessConfig } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** `*` is one dotted segment. `**` crosses segments. Match is case-insensitive. */
export function globMatch(pattern: string, value: string) {
  let regex = globCache.get(pattern);
  if (regex === undefined) {
    try {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^.]*")
        .replace(/\0/g, ".*");
      regex = new RegExp(`^${source}$`, "i");
    } catch {
      regex = null;
    }
    globCache.set(pattern, regex);
  }
  return regex ? regex.test(value.trim()) : false;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function positiveNumber(value: unknown) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function schemaProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "o arquivo precisa ser um mapa";
  if ("mcp_servers" in value && value.mcp_servers != null) {
    if (!isRecord(value.mcp_servers)) return "mcp_servers precisa ser um mapa";
    for (const [name, server] of Object.entries(value.mcp_servers)) {
      if (server === null) continue;
      if (!isRecord(server)) return `mcp_servers.${name} precisa ser um mapa`;
      if (
        server.trust !== undefined &&
        server.trust !== "trusted" &&
        server.trust !== "untrusted"
      )
        return `mcp_servers.${name}.trust aceita trusted ou untrusted`;
      if (server.tools === undefined || server.tools === null) continue;
      if (!isRecord(server.tools))
        return `mcp_servers.${name}.tools precisa ser um mapa`;
      for (const key of ["read", "write"] as const) {
        const list = server.tools[key];
        if (list === undefined || list === null) continue;
        if (
          !Array.isArray(list) ||
          list.some((item) => typeof item !== "string" || item.length === 0)
        )
          return `mcp_servers.${name}.tools.${key} precisa ser uma lista de textos`;
      }
    }
  }
  if ("skills" in value && value.skills != null) {
    if (!isRecord(value.skills)) return "skills precisa ser um mapa";
    if ("always" in value.skills && value.skills.always != null) {
      const list = value.skills.always;
      if (
        !Array.isArray(list) ||
        list.some((item) => typeof item !== "string" || item.length === 0)
      )
        return "skills.always precisa ser uma lista de textos";
    }
  }
  if ("async_jobs" in value && value.async_jobs != null) {
    const jobs = value.async_jobs;
    if (Array.isArray(jobs)) {
      if (jobs.some((item) => !isRecord(item)))
        return "async_jobs precisa ser uma lista de mapas";
    } else if (!isRecord(jobs)) return "async_jobs precisa ser um mapa";
    else {
      for (const [name, job] of Object.entries(jobs)) {
        if (job !== null && !isRecord(job))
          return `async_jobs.${name} precisa ser um mapa`;
      }
    }
  }
  return undefined;
}

function merge(base: unknown, over: unknown): unknown {
  if (over === null || !isRecord(base) || !isRecord(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

function serverFrom(value: Record<string, unknown>): ServerTools {
  const tools = isRecord(value.tools) ? value.tools : undefined;
  return {
    trust: value.trust === "trusted" ? "trusted" : "untrusted",
    read: stringList(tools?.read),
    write: stringList(tools?.write),
    ownTools: tools !== undefined,
  };
}

function configFrom(raw: Record<string, unknown>): HarnessConfig {
  const servers = isRecord(raw.mcp_servers) ? raw.mcp_servers : {};
  const mcpServers: Record<string, ServerTools> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) mcpServers[name] = serverFrom(value);
  }
  const jobs = raw.async_jobs;
  const asyncJobs = Array.isArray(jobs)
    ? jobs.filter(isRecord)
    : isRecord(jobs)
      ? Object.values(jobs).filter(isRecord)
      : [];
  const timing = isRecord(raw.async_job) ? raw.async_job : {};
  return {
    mcpServers,
    asyncJobs,
    asyncJob: {
      timeoutMin: positiveNumber(timing.timeout_min),
      pollSeconds: positiveNumber(timing.poll_seconds),
    },
    sandboxTask: raw.sandbox_code_task,
    skillsAlways: stringList(
      isRecord(raw.skills) ? raw.skills.always : undefined,
    ),
  };
}

export function defaultsPath() {
  const candidates = [
    join(import.meta.dirname, "../config.default.yaml"),
    join(import.meta.dirname, "../../config.default.yaml"),
    join(process.cwd(), "config.default.yaml"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

export function userConfigPath(env: Env = process.env) {
  const override = env.CONFIG_FILE?.trim();
  if (override) return override;
  return join(env.DATA_DIR?.trim() || "data", "config.yaml");
}

/** Lists for one MCP server. A server with no `tools` of its own uses executor's. */
export function mcpServerPolicy(config: HarnessConfig, server?: string) {
  const named = server ? config.mcpServers[server] : undefined;
  const source = named?.ownTools ? named : config.mcpServers.executor;
  return {
    read: source?.read ?? [],
    write: source?.write ?? [],
    trusted: named?.trust === "trusted",
  };
}

function stamp(path: string) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function readDocument(path: string): {
  doc: Record<string, unknown>;
  problem?: string;
  missing?: boolean;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { doc: {}, missing: true };
    return {
      doc: {},
      problem: code === "EISDIR" ? "não é um arquivo" : "ilegível",
    };
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { doc: {}, problem: message.split("\n")[0]?.slice(0, 240) };
  }
  if (parsed === null || parsed === undefined) return { doc: {} };
  const problem = schemaProblem(parsed);
  if (problem) return { doc: {}, problem };
  return { doc: parsed as Record<string, unknown> };
}

/** Loads defaults and the user file. Never throws; a bad user file is logged once. */
export function loadHarnessConfig(env: Env = process.env): HarnessConfig {
  const defaults = defaultsPath();
  const user = userConfigPath(env);
  const key = `${defaults}|${stamp(defaults)}|${user}|${stamp(user)}`;
  if (cache?.key === key) return cache.config;
  const base = readDocument(defaults);
  const over = readDocument(user);
  if (base.missing)
    console.error(
      `Pi-Agent: config.default.yaml ausente (${defaults}). Sem padrões de classificação nem de jobs.`,
    );
  else if (base.problem)
    console.error(
      `Pi-Agent: config.default.yaml inválido (${base.problem}). Sem padrões de classificação nem de jobs.`,
    );
  if (!over.missing && over.problem)
    console.error(
      `Pi-Agent: ${user} inválido (${over.problem}). Usando config.default.yaml.`,
    );
  const usableBase = base.problem || base.missing ? {} : base.doc;
  const usableUser = over.problem || over.missing ? {} : over.doc;
  const merged = merge(usableBase, usableUser);
  const config = isRecord(merged) ? configFrom(merged) : EMPTY;
  cache = { key, config };
  return config;
}
