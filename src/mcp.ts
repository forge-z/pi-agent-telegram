import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import {
  ElicitRequestSchema,
  ElicitRequestURLParamsSchema,
  UrlElicitationRequiredError,
  CallToolResultSchema,
  type ElicitRequest,
  type ElicitResult,
  type Tool,
  type ElicitRequestURLParams,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Compile each distinct output schema once across catalog probes. */
class CachedSchemaValidator implements jsonSchemaValidator {
  private compiled = new Map<string, JsonSchemaValidator<unknown>>();
  private ajv = new AjvJsonSchemaValidator();
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const key = JSON.stringify(schema);
    let validator = this.compiled.get(key);
    if (!validator) {
      if (this.compiled.size >= 4000) {
        this.compiled.clear();
        this.ajv = new AjvJsonSchemaValidator();
      }
      // Ajv resolves a known $id to its first schema; an edited schema needs its own instance.
      validator = (
        "$id" in schema ? new AjvJsonSchemaValidator() : this.ajv
      ).getValidator(schema);
      this.compiled.set(key, validator);
    }
    return validator as JsonSchemaValidator<T>;
  }
}

export type McpServerMode = "direct" | "deferred";
export interface McpConfig {
  name: string;
  url: string;
  /**
   * `direct` (default, also when omitted) registers every tool with its schema.
   * `deferred` hides schemas until `tool_search` loads them. Any other mode is rejected.
   */
  mode?: McpServerMode;
  /** Tool names that stay direct when `mode` is `deferred`. */
  alwaysLoad?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  tokenFile?: string;
  token?: string;
  /**
   * Header that carries `token`. Omitted or `Authorization` sends
   * `Authorization: Bearer`. Any other name sends the raw token.
   */
  tokenHeader?: string;
  /** Appended as the `user_id` query when the MCP URL itself has none. */
  userId?: string;
}
/** Omitted mode is direct, including the default Executor server. */
export function mcpServerMode(mode: McpConfig["mode"]): McpServerMode {
  return mode === "deferred" ? "deferred" : "direct";
}
export function supportedMcpMode(mode: McpConfig["mode"]): boolean {
  return mode === undefined || mode === "direct" || mode === "deferred";
}
/**
 * A deferred server hides this tool until `tool_search` loads it.
 * Names in `alwaysLoad` stay direct. Any other mode, including omitted, stays direct.
 */
export function mcpToolDeferred(
  config: Pick<McpConfig, "mode" | "alwaysLoad"> | undefined,
  toolName: string,
): boolean {
  return config?.mode === "deferred" && !config.alwaysLoad?.includes(toolName);
}
/**
 * Stamp `deferred` from server config. When every server is direct (the default
 * Executor setup, including an omitted mode), the catalog array is returned as-is.
 */
export function projectDeferredCatalog(
  catalog: readonly McpCatalog[],
  configs: readonly Pick<McpConfig, "name" | "mode" | "alwaysLoad">[],
): McpCatalog[] {
  if (!configs.some((config) => config.mode === "deferred"))
    return catalog as McpCatalog[];
  return catalog.map((server) => {
    const config = configs.find((item) => item.name === server.server);
    if (config?.mode !== "deferred") return server;
    return {
      ...server,
      mode: "deferred",
      tools: server.tools.map((tool) => {
        if (!mcpToolDeferred(config, tool.name)) {
          if (!tool.deferred) return tool;
          const copy = { ...tool };
          delete copy.deferred;
          return copy;
        }
        return tool.deferred ? tool : { ...tool, deferred: true as const };
      }),
    };
  });
}
export class PolicyError extends Error {}
export class McpError extends Error {}
class McpSessionError extends McpError {}
// Created only before dispatch; transport errors from callTool are never assigned this type.
export class McpNotSentError extends McpError {}

export function mcpCallTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.MCP_CALL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}
/**
 * How long a session that just answered may skip the full catalog probe.
 * Sequential hops inside this window go straight to callTool. A quiet
 * session is listed again so idle expiry is still discovered before dispatch.
 */
export const MCP_SESSION_PROBE_TTL_MS = 45_000;
export function validateMcpUrlElicitation(
  value: unknown,
): ElicitRequestURLParams {
  // The SDK URL schema normalizes whitespace; reject malformed raw URLs first.
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    value.url.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value.url)
  )
    throw new McpError("MCP server requested an invalid URL interaction");
  const parsed = ElicitRequestURLParamsSchema.safeParse(value);
  if (!parsed.success)
    throw new McpError("MCP server requested an invalid URL interaction");
  const { url, message, elicitationId } = parsed.data;
  if (
    !elicitationId.trim() ||
    elicitationId.length > 200 ||
    message.length > 2000 ||
    url.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(url) ||
    /[\u0000-\u001f\u007f]/.test(elicitationId)
  )
    throw new McpError("MCP server requested an invalid URL interaction");
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new McpError("MCP server requested an invalid URL interaction");
  }
  if (
    address.protocol !== "https:" ||
    address.username ||
    address.password ||
    address.href.length > 4096
  )
    throw new McpError("MCP server requested an invalid interaction address");
  return {
    mode: "url",
    url: address.href,
    message: message.replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      " ",
    ),
    elicitationId,
  };
}
export class McpUrlElicitationRequiredError extends McpError {
  readonly elicitations: readonly ElicitRequestURLParams[];
  constructor(value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 8)
      throw new McpError("MCP server requested an invalid URL interaction");
    const elicitations = value.map(validateMcpUrlElicitation);
    if (
      new Set(elicitations.map((item) => item.elicitationId)).size !==
      elicitations.length
    )
      throw new McpError("MCP server requested an invalid URL interaction");
    super(
      "The MCP server requires an external URL step. Finish or cancel the requests and check the original call's result separately; it will not be repeated automatically.",
    );
    this.elicitations = elicitations;
  }
}
export interface ToolGateway {
  catalog?(): Promise<unknown>;
}
interface McpCallOptions {
  signal?: AbortSignal;
  binding?: string;
  onElicitation?: (
    params: ElicitRequest["params"],
    signal?: AbortSignal,
  ) => Promise<ElicitResult>;
}
export interface McpCatalog {
  server: string;
  mode: McpServerMode;
  tools: (Tool & { operation: "direct"; deferred?: true })[];
  error?: string;
  instructions?: string;
  /** This attempt timed out. A later status may keep the previous snapshot. */
  timedOut?: boolean;
}
/** Sanitized discovery/call timeout. Upstream text is never copied into it. */
export const MCP_TIMEOUT_ERROR =
  "MCP response timed out. The call result may be uncertain.";
/** One `/status` line when a background rediscovery does not answer. */
export const MCP_DISCOVERY_UNANSWERED = "Discovery did not answer.";
/**
 * True when discovery itself did not answer: the SDK timeout, our fetch abort,
 * or the sanitized timeout sentence. Other failures stay ordinary catalog errors.
 */
export function mcpDiscoveryTimedOut(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if (error instanceof McpError)
    return error.message.startsWith("MCP response timed out");
  const record = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    record.code === -32001 ||
    record.name === "TimeoutError" ||
    record.name === "AbortError"
  )
    return true;
  if (
    typeof record.message === "string" &&
    /timed out|timeout/i.test(record.message)
  )
    return true;
  return mcpDiscoveryTimedOut(record.cause, depth + 1);
}
export function mcpCatalogTimedOut(server: {
  timedOut?: boolean;
  error?: string;
}): boolean {
  return (
    server.timedOut === true ||
    server.error?.startsWith("MCP response timed out") === true
  );
}
/**
 * Background rediscovery keeps a server's previous snapshot when that server
 * times out, and replaces it when the server actually answers.
 */
export function mergeMcpDiscovery(
  previous: readonly McpCatalog[],
  next: readonly McpCatalog[],
): { catalog: McpCatalog[]; unanswered: boolean; changed: boolean } {
  let unanswered = false;
  const catalog = next.map((server) => {
    if (!mcpCatalogTimedOut(server)) return server;
    const prior = previous.find((item) => item.server === server.server);
    if (!prior) return server;
    unanswered = true;
    return prior;
  });
  const changed =
    catalog.length !== previous.length ||
    catalog.some((server, index) => server !== previous[index]);
  return { catalog, unanswered, changed };
}
/**
 * One status line per server: sanitized error, tool count, and the original MCP
 * names. Catalog errors are already collapsed; this does not read URLs or tokens.
 */
export function formatMcpStatus(servers: McpCatalog[]): string {
  if (!servers.length) return "None";
  return servers
    .map((server) => {
      if (server.error) {
        const error = server.error.replace(/\s+/g, " ").trim().slice(0, 400);
        return `${server.server}: unavailable — ${error}`;
      }
      const names = server.tools.map((tool) =>
        tool.name.replace(/\s+/g, " ").trim().slice(0, 80),
      );
      const shown = names.slice(0, 30);
      const extra = names.length - shown.length;
      const list = shown.join(", ");
      return `${server.server}: connected — ${names.length} tool(s)${
        list ? ` (${list}${extra > 0 ? `, +${extra}` : ""})` : ""
      }`;
    })
    .join("\n");
}
export function mcpToolName(server: string, tool: string) {
  const hash = createHash("sha256")
    .update(`${server}:${tool}`)
    .digest("hex")
    .slice(0, 10);
  return (
    `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 52) +
    `_${hash}`
  );
}
// Never propagate upstream messages: they may echo credentials, URLs or response bodies.
function safeError(error: unknown): McpError {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === -32042) {
    try {
      const value =
        error instanceof UrlElicitationRequiredError
          ? error.elicitations
          : error &&
              typeof error === "object" &&
              "data" in error &&
              error.data &&
              typeof error.data === "object" &&
              "elicitations" in error.data
            ? error.data.elicitations
            : undefined;
      return new McpUrlElicitationRequiredError(value);
    } catch {
      return new McpError(
        "MCP server requested an invalid URL interaction; check the call result in the service without repeating it automatically.",
      );
    }
  }
  if (code === 401 || code === 403)
    return new McpError(
      `MCP refused authentication (HTTP ${code}). Check the token or the login method the server requires.`,
    );
  if (code === 404 || code === 405)
    return new McpError(
      `MCP endpoint incompatible or not found (HTTP ${code}). Check the full MCP endpoint.`,
    );
  if (code === -32001) return new McpError(MCP_TIMEOUT_ERROR);
  return new McpError(
    "MCP connection or operation failed. Check the endpoint, transport, and server availability.",
  );
}
const configKeys = new Set([
  "name",
  "url",
  "mode",
  "allowedTools",
  "deniedTools",
  "alwaysLoad",
  "tokenFile",
  "token",
  "tokenHeader",
  "userId",
  // Legacy key: still accepted so stored configs keep loading; ignored.
  "cuaViewer",
]);
function validateEntry(item: McpConfig) {
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw new PolicyError(
      "Invalid MCP configuration: each server must be an object",
    );
  const unknown = Object.keys(item).find((key) => !configKeys.has(key));
  if (unknown !== undefined)
    throw new PolicyError(
      `MCP configuration has an unknown field: ${JSON.stringify(unknown.slice(0, 40))}`,
    );
  if (typeof item.name !== "string" || typeof item.url !== "string")
    throw new PolicyError(
      "Invalid MCP configuration: name and URL are required",
    );
  if (
    (item.token !== undefined &&
      (typeof item.token !== "string" || /[\r\n]/.test(item.token))) ||
    (item.tokenFile !== undefined &&
      (typeof item.tokenFile !== "string" || !item.tokenFile)) ||
    (item.tokenHeader !== undefined &&
      (typeof item.tokenHeader !== "string" ||
        !/^[\w-]{1,64}$/.test(item.tokenHeader))) ||
    (item.userId !== undefined &&
      (typeof item.userId !== "string" ||
        !/^[\w.:@+-]{1,200}$/.test(item.userId)))
  )
    throw new PolicyError(
      "Invalid MCP configuration: token and tokenFile must be single-line text",
    );
  const lists = [
    item.allowedTools ?? [],
    item.deniedTools ?? [],
    item.alwaysLoad ?? [],
  ];
  if (
    !/^[a-zA-Z0-9_-]+$/.test(item.name) ||
    item.name.length > 80 ||
    lists.some(
      (list) =>
        !Array.isArray(list) ||
        list.length > 200 ||
        list.some((t) => typeof t !== "string" || !t || t.length > 200),
    ) ||
    !supportedMcpMode(item.mode)
  )
    throw new PolicyError(
      "Invalid MCP configuration: check the name, mode, and tool lists",
    );
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    throw new PolicyError("Invalid MCP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PolicyError(
      "MCP requires an HTTP(S) URL with no query, fragment, or embedded credentials; use a bearer token",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new PolicyError("MCP off loopback requires HTTPS");
}
function credentialMaterial(config: McpConfig, token: string | undefined) {
  const material: unknown[] = [config.url, token, config.tokenFile];
  if (config.tokenHeader) material.push(config.tokenHeader);
  if (config.userId) material.push(config.userId);
  return JSON.stringify(material);
}
/** Bearer unless the server names another header (Composio uses `x-api-key`). */
function authHeaders(config: McpConfig, token: string | undefined) {
  const headers: Record<string, string> = {};
  if (!token) return headers;
  const name = config.tokenHeader?.trim();
  if (!name || name.toLowerCase() === "authorization")
    headers.Authorization = `Bearer ${token}`;
  else headers[name] = token;
  return headers;
}
function connectionUrl(config: McpConfig) {
  const url = new URL(config.url);
  if (config.userId && !url.searchParams.has("user_id"))
    url.searchParams.set("user_id", config.userId);
  return url;
}
function configuredToken(config: McpConfig) {
  if (config.token || !config.tokenFile) return config.token;
  try {
    return readFileSync(config.tokenFile, "utf8").trim();
  } catch {
    throw new PolicyError("MCP token file unavailable");
  }
}
interface LockWaiter {
  mode: "shared" | "exclusive";
  grant: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  cancelled: boolean;
}

class ServerRwLock {
  readers = 0;
  writer = false;
  queue: LockWaiter[] = [];

  acquire(
    mode: "shared" | "exclusive",
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        new McpNotSentError("MCP call cancelled before it was sent."),
      );
    }

    if (mode === "shared") {
      const hasWaitingWriter = this.queue.some(
        (w) => w.mode === "exclusive" && !w.cancelled,
      );
      if (!this.writer && !hasWaitingWriter) {
        this.readers++;
        let released = false;
        return Promise.resolve(() => {
          if (released) return;
          released = true;
          this.readers--;
          this.drain();
        });
      }
    } else {
      if (this.readers === 0 && !this.writer && this.queue.length === 0) {
        this.writer = true;
        let released = false;
        return Promise.resolve(() => {
          if (released) return;
          released = true;
          this.writer = false;
          this.drain();
        });
      }
    }

    return new Promise<() => void>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (mode === "shared") {
          this.readers--;
        } else {
          this.writer = false;
        }
        this.drain();
      };

      const waiter: LockWaiter = {
        mode,
        grant: () => resolve(release),
        reject,
        signal,
        cancelled: false,
      };

      if (signal) {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.drain();
          reject(new McpNotSentError("MCP call cancelled before it was sent."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  drain() {
    while (this.queue.length > 0) {
      const first = this.queue[0];
      if (first.cancelled) {
        this.queue.shift();
        continue;
      }

      if (first.mode === "exclusive") {
        if (this.readers === 0 && !this.writer) {
          this.queue.shift();
          this.writer = true;
          first.grant();
        }
        break;
      }

      if (first.mode === "shared") {
        if (!this.writer) {
          while (this.queue.length > 0 && this.queue[0].mode === "shared") {
            const next = this.queue.shift()!;
            if (!next.cancelled) {
              this.readers++;
              next.grant();
            }
          }
        }
        break;
      }
    }
  }
}

export class McpGateway implements ToolGateway {
  private clients = new Map<string, Promise<Client>>();
  private bindings = new WeakMap<Client, string>();
  private secrets = new WeakMap<Client, string>();
  private expired = new WeakSet<Client>();
  /** Absolute time until which this client can skip a catalog probe. */
  private liveUntil = new WeakMap<Client, number>();
  private metadata = new WeakMap<
    Client,
    Map<
      string,
      {
        taskRequired: boolean;
        validateOutput?: JsonSchemaValidator<unknown>;
      }
    >
  >();
  /** Tools whose latest tools/list set `annotations.readOnlyHint` exactly true. */
  private readOnlyHints = new Map<string, Set<string>>();
  private schemas = new CachedSchemaValidator();
  private operations = 0;
  private locks = new Map<string, ServerRwLock>();
  private active = new Map<string, Set<McpCallOptions>>();
  // shortcut: progress is keyed by server, not by conversation, so two chats on
  // the same server can briefly see each other's text; key it per call if that matters.
  private progressMessages = new Map<string, string>();
  constructor(readonly config: McpConfig[]) {
    if (!Array.isArray(config))
      throw new PolicyError("MCP configuration must be a list of servers");
    config.forEach((item, index) => {
      try {
        validateEntry(item);
      } catch (error) {
        if (!(error instanceof PolicyError)) throw error;
        const name =
          typeof item?.name === "string" &&
          /^[a-zA-Z0-9_-]{1,80}$/.test(item.name)
            ? ` "${item.name}"`
            : "";
        throw new PolicyError(
          `${error.message} (MCP server ${index + 1}${name})`,
        );
      }
    });
    if (new Set(config.map((c) => c.name)).size !== config.length)
      throw new PolicyError("Duplicate MCP names");
  }
  /** Last progress notification of this server's current call, for the long-call status. */
  lastProgressMessage(server: string) {
    return this.progressMessages.get(server);
  }
  credentialBinding(server: string) {
    const c = this.config.find((c) => c.name === server);
    if (!c) throw new PolicyError("MCP server not authorized");
    const token = configuredToken(c);
    return createHash("sha256")
      .update(credentialMaterial(c, token))
      .digest("hex");
  }
  async connectionBinding(server: string) {
    return this.withLock(server, "exclusive", async () =>
      this.bindings.get(await this.client(server))!,
    );
  }
  assertDirect(server: string, tool: string) {
    const config = this.config.find((c) => c.name === server);
    if (
      !config ||
      !supportedMcpMode(config.mode) ||
      config.deniedTools?.includes(tool) ||
      (config.allowedTools !== undefined && !config.allowedTools.includes(tool))
    )
      throw new PolicyError("MCP tool is outside the configured restrictions");
  }
  /** Drops a wedged session so the next call can open another one. */
  async releaseSession(server: string) {
    const pending = this.clients.get(server);
    if (this.clients.get(server) === pending) this.clients.delete(server);
    const client = pending ? await pending.catch(() => undefined) : undefined;
    if (!client) return;
    this.expired.add(client);
    await client.close().catch(() => {});
  }
  async callDirect(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ) {
    try {
      this.assertDirect(server, tool);
    } catch (error) {
      throw new McpNotSentError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.invoke(server, tool, args, options);
  }
  private getLock(server: string): ServerRwLock {
    let lock = this.locks.get(server);
    if (!lock) {
      lock = new ServerRwLock();
      this.locks.set(server, lock);
    }
    return lock;
  }
  private async withLock<T>(
    server: string,
    mode: "shared" | "exclusive",
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.operations++;
    let release: (() => void) | undefined;
    try {
      release = await this.getLock(server).acquire(mode, signal);
      if (signal?.aborted) {
        throw new McpNotSentError("MCP call cancelled before it was sent.");
      }
      return await run();
    } finally {
      try {
        release?.();
      } finally {
        this.operations--;
      }
    }
  }
  private async discard(server: string, client: Client) {
    const pending = this.clients.get(server);
    if (pending && (await pending.catch(() => undefined)) === client)
      this.clients.delete(server);
    await client.close().catch(() => {});
  }
  /** True only when tools/list reported `annotations.readOnlyHint === true`. */
  toolReadOnlyHint(server: string, tool: string) {
    return this.readOnlyHints.get(server)?.has(tool) ? true : undefined;
  }
  private rememberReadOnlyHints(server: string, tools: Iterable<Tool>) {
    const hints = new Set<string>();
    for (const tool of tools) {
      const annotations = (tool as { annotations?: { readOnlyHint?: boolean } })
        .annotations;
      if (annotations?.readOnlyHint === true) hints.add(tool.name);
    }
    this.readOnlyHints.set(server, hints);
  }
  private async listClientTools(
    server: string,
    client: Client,
    signal?: AbortSignal,
  ) {
    const tools = new Map<string, Tool>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      let page;
      try {
        page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: 30000,
          signal,
        });
      } catch (error) {
        // A server that already returned a page supports discovery. A missing
        // continuation must never trigger the legacy call-only fallback.
        if (
          cursor &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === -32601
        )
          throw new McpError(
            "MCP server did not finish the paginated catalog.",
          );
        throw error;
      }
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new McpError("MCP server repeated the discovery cursor");
      if (cursor) cursors.add(cursor);
      if (tools.size > 2000 || cursors.size > 100)
        throw new McpError("MCP catalog exceeded the discovery limit");
    } while (cursor);
    // The SDK keeps metadata only from its last listTools page. Preserve the
    // entire catalog using public APIs, including after a client is replaced.
    this.metadata.set(
      client,
      new Map(
        [...tools.values()].map((tool) => [
          tool.name,
          {
            taskRequired: tool.execution?.taskSupport === "required",
            validateOutput: tool.outputSchema
              ? this.schemas.getValidator(tool.outputSchema)
              : undefined,
          },
        ]),
      ),
    );
    this.noteLive(client);
    const listed = [...tools.values()];
    this.rememberReadOnlyHints(server, listed);
    return listed;
  }
  private sessionFresh(client: Client) {
    return (this.liveUntil.get(client) ?? 0) > Date.now();
  }
  private noteLive(client: Client) {
    if (this.expired.has(client)) return;
    this.liveUntil.set(client, Date.now() + MCP_SESSION_PROBE_TTL_MS);
  }
  /**
   * Skip the paginated catalog only when this client already has metadata and
   * is not expired, and either another call is in flight or a recent listTools
   * or callTool proved the session is alive. A new session, a session marked
   * expired, a discovery error (noteLive is not called), or a quiet window
   * still runs the full probe under the exclusive lock.
   */
  private canSkipCatalogProbe(server: string, client: Client) {
    if (!this.metadata.has(client) || this.expired.has(client)) return false;
    if ((this.active.get(server)?.size ?? 0) > 0) return true;
    return this.sessionFresh(client);
  }
  private async ensureLiveClient(
    server: string,
    signal?: AbortSignal,
  ): Promise<Client> {
    const existing = this.clients.get(server);
    const cached = existing ? await existing.catch(() => undefined) : undefined;
    if (cached && this.canSkipCatalogProbe(server, cached)) return cached;

    return this.withLock(
      server,
      "exclusive",
      async () => {
        return this.liveClientUnderLock(server, signal);
      },
      signal,
    );
  }
  private async liveClientUnderLock(server: string, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted)
        throw new McpNotSentError("MCP call cancelled before it was sent.");
      const client = await this.client(server);
      // Another waiter may have just finished the full probe.
      if (this.canSkipCatalogProbe(server, client)) return client;
      try {
        // Full pagination, same 30s-per-page timeout as discovery. Safe to
        // retry when an idle session expires. Refresh every page so output
        // validation and task restrictions also survive a replacement.
        await this.listClientTools(server, client, signal);
        return client;
      } catch (error) {
        if (this.expired.has(client)) {
          await this.discard(server, client);
          if (attempt === 0 && !signal?.aborted) continue;
          throw new McpSessionError(
            "The MCP session expired again before the send. Check that the server is available.",
          );
        }
        throw error;
      }
    }
  }
  private async invoke(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted)
        throw new McpNotSentError("MCP call cancelled before it was sent.");
      let client: Client;
      try {
        client = await this.ensureLiveClient(server, options.signal);
      } catch (error) {
        const safe =
          error instanceof McpError || error instanceof PolicyError
            ? error
            : safeError(error);
        throw new McpNotSentError(`${safe.message} No tool call was sent.`);
      }
      if (options.binding && this.bindings.get(client) !== options.binding)
        throw new McpNotSentError(
          "MCP connection credentials changed; the call will not be sent",
        );
      if (options.signal?.aborted)
        throw new McpNotSentError("MCP call cancelled before it was sent.");
      const metadata = this.metadata.get(client)?.get(tool);
      if (metadata?.taskRequired)
        throw new McpNotSentError(
          "MCP tool requires task-based execution, which this connection does not support. No tool call was sent.",
        );
      let set = this.active.get(server);
      if (!set) {
        set = new Set();
        this.active.set(server, set);
      }
      set.add(options);
      this.progressMessages.delete(server);
      const timeout = mcpCallTimeoutMs();
      // SDK bug #2695: maxTotalTimeout only starts counting after the first
      // progress notification, so a silent server could hang past the budget.
      // This abort is the hard limit; the call still counts progress separately.
      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => deadline.abort(), timeout);
      try {
        // A session can still end after the probe or a trusted hop. Once
        // callTool starts, any failure remains uncertain and must not be replayed.
        const result = await this.withLock(
          server,
          "shared",
          async () => {
            return await client.callTool(
              { name: tool, arguments: args },
              undefined,
              {
                timeout,
                signal: options.signal
                  ? AbortSignal.any([options.signal, deadline.signal])
                  : deadline.signal,
                resetTimeoutOnProgress: true,
                maxTotalTimeout: timeout,
                onprogress: (progress) => {
                  if (progress.message)
                    this.progressMessages.set(server, progress.message);
                },
              },
            );
          },
          options.signal,
        );
        const parsed = CallToolResultSchema.parse(
          "toolResult" in result ? result.toolResult : result,
        );
        this.noteLive(client);
        if (
          metadata?.validateOutput &&
          ((!parsed.structuredContent && !parsed.isError) ||
            (parsed.structuredContent &&
              !metadata.validateOutput(parsed.structuredContent).valid))
        )
          throw new McpError(
            "MCP response does not match the tool output schema. The call result may be uncertain.",
          );
        return parsed;
      } catch (error) {
        if (deadline.signal.aborted) throw new McpError(MCP_TIMEOUT_ERROR);
        // URL completion never authorizes replay, including locally classified reads.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === -32042
        )
          throw safeError(error);
        if (this.expired.has(client)) {
          await this.withLock(server, "exclusive", async () => {
            await this.discard(server, client);
          });
          // A lost session after dispatch is not replayed. The result stays uncertain.
          throw new McpSessionError(
            "The MCP session expired or was closed (HTTP 404). The call was not resent; check the result in the service. The next operation will open a new session.",
          );
        }
        throw error instanceof McpError ? error : safeError(error);
      } finally {
        clearTimeout(deadlineTimer);
        set.delete(options);
        if (set.size === 0) this.active.delete(server);
      }
    }
  }
  private async client(server: string) {
    const config = this.config.find((c) => c.name === server);
    if (!config) throw new PolicyError("MCP server not authorized");
    let pending = this.clients.get(server);
    if (pending) {
      const cached = await pending;
      if (this.expired.has(cached)) {
        await this.discard(server, cached);
        pending = undefined;
      }
    }
    if (!pending) {
      pending = (async () => {
        const token = configuredToken(config);
        if (token && /[\r\n]/.test(token))
          throw new PolicyError("Invalid MCP token file");
        const headers = authHeaders(config, token);
        const url = connectionUrl(config);
        const makeClient = () => {
          const client = new Client(
            { name: "pi-agent", version: "0.1.0" },
            {
              capabilities: { elicitation: { form: {}, url: {} } },
              jsonSchemaValidator: this.schemas,
            },
          );
          this.secrets.set(client, token ?? "");
          this.bindings.set(
            client,
            createHash("sha256")
              .update(credentialMaterial(config, token))
              .digest("hex"),
          );
          client.setRequestHandler(
            ElicitRequestSchema,
            async (request, extra) => {
              const activeSet = this.active.get(server);
              if (activeSet) {
                for (const opt of activeSet) {
                  if (opt.onElicitation) {
                    return opt.onElicitation(request.params, extra.signal);
                  }
                }
              }
              return { action: "cancel" };
            },
          );
          return client;
        };
        let client = makeClient();
        let legacyTransport = false;
        let connected = false;
        const limitedFetch: typeof fetch = async (input, init) => {
          const requestClient = client;
          const establishedSsePost =
            legacyTransport && connected && init?.method === "POST";
          const controller = new AbortController();
          // Tool calls (and their elicitation replies) use the configured
          // MCP_CALL_TIMEOUT_MS budget (default 60s). Discovery and connection setup stay bounded at 30s.
          const callTimeout = mcpCallTimeoutMs();
          const timeout =
            (this.active.get(server)?.size ?? 0) > 0 && init?.method === "POST"
              ? callTimeout
              : 30000;
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetch(input, {
              ...init,
              signal: AbortSignal.any([
                controller.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
            // Streamable HTTP identifies sessions in a header; legacy SSE
            // advertises a POST endpoint tied to its stream, often in a query.
            // Only classify SSE POST failures after initialization completed.
            if (
              response.status === 404 &&
              (new Headers(init?.headers).has("mcp-session-id") ||
                establishedSsePost)
            )
              this.expired.add(requestClient);
            return response;
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          try {
            await client.connect(
              new StreamableHTTPClientTransport(url, {
                requestInit: { headers },
                fetch: limitedFetch,
              }),
              { timeout: 30000 },
            );
          } catch (error) {
            await client.close().catch(() => {});
            const code =
              error && typeof error === "object" && "code" in error
                ? error.code
                : undefined;
            if (this.expired.has(client))
              throw new McpSessionError(
                "The MCP session expired during startup. Try connecting again; no tool was sent.",
              );
            if (code !== 404 && code !== 405) throw error;
            client = makeClient();
            legacyTransport = true;
            await client.connect(
              new SSEClientTransport(url, {
                requestInit: { headers },
                fetch: limitedFetch,
              }),
              { timeout: 30000 },
            );
          }
          connected = true;
          client.onclose = () => {
            if (this.clients.get(server) === pending)
              this.clients.delete(server);
          };
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          throw error instanceof McpError ? error : safeError(error);
        }
      })();
      this.clients.set(server, pending);
      void pending.catch(() => {
        if (this.clients.get(server) === pending) this.clients.delete(server);
      });
    }
    return pending;
  }
  async catalog(): Promise<McpCatalog[]> {
    return Promise.all(
      this.config.map(async (config) => {
        const mode = mcpServerMode(config.mode);
        try {
          const discovered = await this.discover(config.name);
          const client = await this.clients.get(config.name);
          let instructions = client?.getInstructions();
          if (instructions) {
            const secret = client ? this.secrets.get(client) : undefined;
            if (secret)
              instructions = instructions.split(secret).join("[redacted]");
            instructions = instructions
              .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
              .slice(0, 4000);
          }
          return {
            server: config.name,
            mode,
            ...(instructions ? { instructions } : {}),
            tools: discovered
              .filter(
                (tool) =>
                  !config.deniedTools?.includes(tool.name) &&
                  (config.allowedTools === undefined ||
                    config.allowedTools.includes(tool.name)),
              )
              .map((tool) => ({
                ...tool,
                operation: "direct" as const,
                ...(mcpToolDeferred(config, tool.name)
                  ? { deferred: true as const }
                  : {}),
              })),
          };
        } catch (error) {
          const timedOut = mcpDiscoveryTimedOut(error);
          return {
            server: config.name,
            mode,
            tools: [],
            ...(timedOut ? { timedOut: true } : {}),
            error: timedOut
              ? MCP_TIMEOUT_ERROR
              : error instanceof McpError
                ? error.message
                : "Could not discover MCP tools",
          };
        }
      }),
    );
  }
  async discover(server: string): Promise<Tool[]> {
    return this.withLock(server, "exclusive", async () => {
      for (let attempt = 0; ; attempt++) {
        const client = await this.client(server);
        try {
          return await this.listClientTools(server, client);
        } catch (error) {
          if (this.expired.has(client)) {
            await this.discard(server, client);
            // Restart the whole catalog: pagination cursors belong to a session.
            if (attempt === 0) continue;
            throw new McpSessionError(
              "The MCP session expired again during discovery. Check that the server is available.",
            );
          }
          if (mcpDiscoveryTimedOut(error))
            throw new McpError(MCP_TIMEOUT_ERROR);
          throw error instanceof McpError || error instanceof PolicyError
            ? error
            : safeError(error);
        }
      }
    });
  }
  checkReplacement(config: McpConfig[]) {
    if (this.operations)
      throw new PolicyError("Wait for MCP operations already in progress");
    new McpGateway(config);
  }
  replace(config: McpConfig[]) {
    this.checkReplacement(config);
    const old = this.clients;
    this.clients = new Map();
    this.config.splice(0, this.config.length, ...config);
    return Promise.allSettled(
      [...old.values()].map(async (pending) => (await pending).close()),
    );
  }
  async close() {
    for (const client of this.clients.values())
      await client.then((c) => c.close()).catch(() => {});
    this.clients.clear();
  }
}
