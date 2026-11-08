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
  /** Kept so existing config objects load. Direct mode does not consult these lists. */
  readTools: string[];
  actionTools: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  tokenFile?: string;
  token?: string;
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
    throw new McpError("Servidor MCP solicitou uma interação URL inválida");
  const parsed = ElicitRequestURLParamsSchema.safeParse(value);
  if (!parsed.success)
    throw new McpError("Servidor MCP solicitou uma interação URL inválida");
  const { url, message, elicitationId } = parsed.data;
  if (
    !elicitationId.trim() ||
    elicitationId.length > 200 ||
    message.length > 2000 ||
    url.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(url) ||
    /[\u0000-\u001f\u007f]/.test(elicitationId)
  )
    throw new McpError("Servidor MCP solicitou uma interação URL inválida");
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw new McpError("Servidor MCP solicitou uma interação URL inválida");
  }
  if (
    address.protocol !== "https:" ||
    address.username ||
    address.password ||
    address.href.length > 4096
  )
    throw new McpError(
      "Servidor MCP solicitou um endereço de interação inválido",
    );
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
      throw new McpError("Servidor MCP solicitou uma interação URL inválida");
    const elicitations = value.map(validateMcpUrlElicitation);
    if (
      new Set(elicitations.map((item) => item.elicitationId)).size !==
      elicitations.length
    )
      throw new McpError("Servidor MCP solicitou uma interação URL inválida");
    super(
      "Servidor MCP exige uma etapa externa por URL. Conclua ou cancele as solicitações e verifique separadamente o resultado da chamada original; ela não será repetida automaticamente.",
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
  "Tempo de resposta MCP excedido. O resultado da chamada pode ser incerto.";
/** One `/status` line when a background rediscovery does not answer. */
export const MCP_DISCOVERY_UNANSWERED = "A descoberta não respondeu.";
/**
 * True when discovery itself did not answer: the SDK timeout, our fetch abort,
 * or the sanitized timeout sentence. Other failures stay ordinary catalog errors.
 */
export function mcpDiscoveryTimedOut(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if (error instanceof McpError)
    return error.message.startsWith("Tempo de resposta MCP excedido");
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
    server.error?.startsWith("Tempo de resposta MCP excedido") === true
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
  if (!servers.length) return "Nenhum";
  return servers
    .map((server) => {
      if (server.error) {
        const error = server.error.replace(/\s+/g, " ").trim().slice(0, 400);
        return `${server.server}: indisponível — ${error}`;
      }
      const names = server.tools.map((tool) =>
        tool.name.replace(/\s+/g, " ").trim().slice(0, 80),
      );
      const shown = names.slice(0, 30);
      const extra = names.length - shown.length;
      const list = shown.join(", ");
      return `${server.server}: conectado — ${names.length} ferramenta(s)${
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
        "Servidor MCP solicitou uma interação URL inválida; verifique o resultado da chamada no serviço sem repeti-la automaticamente.",
      );
    }
  }
  if (code === 401 || code === 403)
    return new McpError(
      `MCP recusou a autenticação (HTTP ${code}). Verifique o token ou o método de login exigido pelo servidor.`,
    );
  if (code === 404 || code === 405)
    return new McpError(
      `Endpoint MCP incompatível ou não encontrado (HTTP ${code}). Confira o endpoint MCP completo.`,
    );
  if (code === -32001) return new McpError(MCP_TIMEOUT_ERROR);
  return new McpError(
    "Falha na conexão ou operação MCP. Confira endpoint, transporte e disponibilidade do servidor.",
  );
}
const configKeys = new Set([
  "name",
  "url",
  "mode",
  "readTools",
  "actionTools",
  "allowedTools",
  "deniedTools",
  "alwaysLoad",
  "tokenFile",
  "token",
  // Legacy key: still accepted so stored configs keep loading; ignored.
  "cuaViewer",
]);
function validateEntry(item: McpConfig) {
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw new PolicyError(
      "Configuração MCP inválida: cada servidor deve ser um objeto",
    );
  const unknown = Object.keys(item).find((key) => !configKeys.has(key));
  if (unknown !== undefined)
    throw new PolicyError(
      `Configuração MCP com campo desconhecido: ${JSON.stringify(unknown.slice(0, 40))}`,
    );
  if (typeof item.name !== "string" || typeof item.url !== "string")
    throw new PolicyError(
      "Configuração MCP inválida: nome e URL são obrigatórios",
    );
  if (
    (item.token !== undefined &&
      (typeof item.token !== "string" || /[\r\n]/.test(item.token))) ||
    (item.tokenFile !== undefined &&
      (typeof item.tokenFile !== "string" || !item.tokenFile))
  )
    throw new PolicyError(
      "Configuração MCP inválida: token e tokenFile devem ser texto de uma linha",
    );
  const lists = [
    item.readTools,
    item.actionTools,
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
      "Configuração MCP inválida: confira nome, modo e listas de ferramentas",
    );
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    throw new PolicyError("URL MCP inválida");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PolicyError(
      "MCP exige URL HTTP(S) sem query, fragmento ou credenciais embutidas; use bearer token",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new PolicyError("MCP fora de loopback exige HTTPS");
  if (item.readTools.some((t) => item.actionTools.includes(t)))
    throw new PolicyError(
      "MCP tool não pode ser leitura e ação ao mesmo tempo",
    );
}
function configuredToken(config: McpConfig) {
  if (config.token || !config.tokenFile) return config.token;
  try {
    return readFileSync(config.tokenFile, "utf8").trim();
  } catch {
    throw new PolicyError("Arquivo de token MCP indisponível");
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
        new McpNotSentError("Chamada MCP cancelada antes do envio."),
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
          reject(new McpNotSentError("Chamada MCP cancelada antes do envio."));
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
  private schemas = new CachedSchemaValidator();
  private operations = 0;
  private locks = new Map<string, ServerRwLock>();
  private active = new Map<string, Set<McpCallOptions>>();
  private dispatchGuard?: (server: string) => void;
  constructor(readonly config: McpConfig[]) {
    if (!Array.isArray(config))
      throw new PolicyError(
        "Configuração MCP deve ser uma lista de servidores",
      );
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
          `${error.message} (servidor MCP ${index + 1}${name})`,
        );
      }
    });
    if (new Set(config.map((c) => c.name)).size !== config.length)
      throw new PolicyError("Nomes MCP duplicados");
  }
  setDispatchGuard(guard: (server: string) => void) {
    this.dispatchGuard = guard;
  }
  serverOrigin(server: string) {
    const config = this.config.find((item) => item.name === server);
    if (!config) throw new PolicyError("Servidor MCP não autorizado");
    return new URL(config.url).origin;
  }
  hasActiveOrigin(origin: string) {
    return [...this.active.keys()].some(
      (server) =>
        this.serverOrigin(server) === origin &&
        (this.active.get(server)?.size ?? 0) > 0,
    );
  }
  credentialBinding(server: string) {
    const c = this.config.find((c) => c.name === server);
    if (!c) throw new PolicyError("Servidor MCP não autorizado");
    const token = configuredToken(c);
    return createHash("sha256")
      .update(JSON.stringify([c.url, token, c.tokenFile]))
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
      throw new PolicyError("Ferramenta MCP fora das restrições configuradas");
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
    this.assertDirect(server, tool);
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
        throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
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
  private async listClientTools(client: Client, signal?: AbortSignal) {
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
          throw new McpError("Servidor MCP não concluiu o catálogo paginado.");
        throw error;
      }
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new McpError("Servidor MCP repetiu o cursor de descoberta");
      if (cursor) cursors.add(cursor);
      if (tools.size > 2000 || cursors.size > 100)
        throw new McpError("Catálogo MCP excedeu o limite de descoberta");
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
    return [...tools.values()];
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
        throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
      const client = await this.client(server);
      // Another waiter may have just finished the full probe.
      if (this.canSkipCatalogProbe(server, client)) return client;
      try {
        // Full pagination, same 30s-per-page timeout as discovery. Safe to
        // retry when an idle session expires. Refresh every page so output
        // validation and task restrictions also survive a replacement.
        await this.listClientTools(client, signal);
        return client;
      } catch (error) {
        if (this.expired.has(client)) {
          await this.discard(server, client);
          if (attempt === 0 && !signal?.aborted) continue;
          throw new McpSessionError(
            "A sessão MCP expirou novamente antes do envio. Verifique a disponibilidade do servidor.",
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
      this.dispatchGuard?.(server);
      if (options.signal?.aborted)
        throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
      let client: Client;
      try {
        client = await this.ensureLiveClient(server, options.signal);
      } catch (error) {
        const safe =
          error instanceof McpError || error instanceof PolicyError
            ? error
            : safeError(error);
        throw new McpNotSentError(
          `${safe.message} Nenhuma chamada de ferramenta foi enviada.`,
        );
      }
      if (options.binding && this.bindings.get(client) !== options.binding)
        throw new PolicyError(
          "Credenciais da conexão MCP mudaram; a chamada não será enviada",
        );
      if (options.signal?.aborted)
        throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
      const metadata = this.metadata.get(client)?.get(tool);
      if (metadata?.taskRequired)
        throw new McpNotSentError(
          "Ferramenta MCP exige execução baseada em tarefas, não suportada nesta conexão. Nenhuma chamada de ferramenta foi enviada.",
        );
      this.dispatchGuard?.(server);
      let set = this.active.get(server);
      if (!set) {
        set = new Set();
        this.active.set(server, set);
      }
      set.add(options);
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
              { timeout: mcpCallTimeoutMs(), signal: options.signal },
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
            "Resposta MCP incompatível com o schema de saída da ferramenta. O resultado da chamada pode ser incerto.",
          );
        return parsed;
      } catch (error) {
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
            "A sessão MCP expirou ou foi encerrada (HTTP 404). A chamada não foi reenviada; verifique o resultado no serviço. A próxima operação abrirá uma nova sessão.",
          );
        }
        throw error instanceof McpError ? error : safeError(error);
      } finally {
        set.delete(options);
        if (set.size === 0) this.active.delete(server);
      }
    }
  }
  private async client(server: string) {
    const config = this.config.find((c) => c.name === server);
    if (!config) throw new PolicyError("Servidor MCP não autorizado");
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
        const headers: Record<string, string> = {};
        const token = configuredToken(config);
        if (token && /[\r\n]/.test(token))
          throw new PolicyError("Arquivo de token MCP inválido");
        if (token) headers.Authorization = `Bearer ${token}`;
        const makeClient = () => {
          const client = new Client(
            { name: "pi-agent", version: "0.1.0" },
            {
              capabilities: { elicitation: { form: {}, url: {} } },
              jsonSchemaValidator: this.schemas,
            },
          );
          this.secrets.set(client, headers.Authorization?.slice(7) ?? "");
          this.bindings.set(
            client,
            createHash("sha256")
              .update(
                JSON.stringify([
                  config.url,
                  headers.Authorization?.slice(7),
                  config.tokenFile,
                ]),
              )
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
              new StreamableHTTPClientTransport(new URL(config.url), {
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
                "A sessão MCP expirou durante a inicialização. Tente conectar novamente; nenhuma ferramenta foi enviada.",
              );
            if (code !== 404 && code !== 405) throw error;
            client = makeClient();
            legacyTransport = true;
            await client.connect(
              new SSEClientTransport(new URL(config.url), {
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
                : "Não foi possível descobrir ferramentas MCP",
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
          return await this.listClientTools(client);
        } catch (error) {
          if (this.expired.has(client)) {
            await this.discard(server, client);
            // Restart the whole catalog: pagination cursors belong to a session.
            if (attempt === 0) continue;
            throw new McpSessionError(
              "A sessão MCP expirou novamente durante a descoberta. Verifique a disponibilidade do servidor.",
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
      throw new PolicyError("Aguarde as operações MCP em andamento");
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
