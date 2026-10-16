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

/** Discovery runs before every call, in the SDK and here; compile each distinct schema once. */
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

export interface McpConfig {
  name: string;
  url: string;
  mode?: "direct" | "legacy";
  readTools: string[];
  actionTools: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  tokenFile?: string;
  token?: string;
}
export class PolicyError extends Error {}
export class McpError extends Error {}
class McpSessionError extends McpError {}
// Created only before dispatch; transport errors from callTool are never assigned this type.
export class McpNotSentError extends McpError {}
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
  assertAllowed?(server: string, tool: string, kind: "read" | "action"): void;
  catalog?(): Promise<unknown>;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    kind: "read" | "action",
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  mode: "direct" | "legacy";
  tools: (Tool & { operation: "direct" | "read" | "action" })[];
  error?: string;
  instructions?: string;
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
  if (code === -32001)
    return new McpError(
      "Tempo de resposta MCP excedido. O resultado da chamada pode ser incerto.",
    );
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
    (item.mode !== undefined && !["direct", "legacy"].includes(item.mode))
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
export class McpGateway implements ToolGateway {
  private clients = new Map<string, Promise<Client>>();
  private bindings = new WeakMap<Client, string>();
  private secrets = new WeakMap<Client, string>();
  private expired = new WeakSet<Client>();
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
  private tails = new Map<string, Promise<unknown>>();
  private active = new Map<string, McpCallOptions>();
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
      (server) => this.serverOrigin(server) === origin,
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
    return this.enqueue(server, async () =>
      this.bindings.get(await this.client(server))!,
    );
  }
  assertAllowed(server: string, tool: string, kind: "read" | "action") {
    const config = this.config.find((c) => c.name === server);
    // Direct connections cannot be reached through the legacy replay-safe read wrapper.
    if (
      !config ||
      config.mode === "direct" ||
      !(kind === "read" ? config.readTools : config.actionTools).includes(
        tool,
      ) ||
      config.deniedTools?.includes(tool)
    )
      throw new PolicyError("Ferramenta MCP não autorizada para esta operação");
  }
  assertDirect(server: string, tool: string) {
    const config = this.config.find((c) => c.name === server);
    if (
      !config ||
      config.mode !== "direct" ||
      config.deniedTools?.includes(tool) ||
      (config.allowedTools !== undefined && !config.allowedTools.includes(tool))
    )
      throw new PolicyError("Ferramenta MCP fora das restrições configuradas");
  }
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    kind: "read" | "action",
    signal?: AbortSignal,
  ) {
    this.assertAllowed(server, tool, kind);
    return this.invoke(server, tool, args, { signal }, kind === "read");
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
  // Discovery and tool calls share a queue so a session replacement cannot close
  // a client while another operation or elicitation still uses it.
  private async enqueue<T>(
    server: string,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.operations++;
    let started = false;
    let stopWaiting = () => {};
    const operation = (this.tails.get(server) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        started = true;
        stopWaiting();
        if (signal?.aborted)
          throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
        return run();
      });
    this.tails.set(server, operation);
    const completion = operation.finally(() => {
      this.operations--;
      if (this.tails.get(server) === operation) this.tails.delete(server);
    });
    if (!signal) return completion;
    return new Promise<T>((resolve, reject) => {
      const cancelWaiting = () => {
        if (started) return;
        stopWaiting();
        // Release the caller immediately, but leave the cancelled item in the
        // server queue. It must never bypass or interrupt the active operation.
        reject(new McpNotSentError("Chamada MCP cancelada antes do envio."));
      };
      stopWaiting = () => signal.removeEventListener("abort", cancelWaiting);
      signal.addEventListener("abort", cancelWaiting, { once: true });
      void completion.then(
        (value) => {
          stopWaiting();
          resolve(value);
        },
        (error) => {
          stopWaiting();
          reject(error);
        },
      );
      if (signal.aborted) cancelWaiting();
    });
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
    return [...tools.values()];
  }
  private async liveClient(server: string, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const client = await this.client(server);
      try {
        // Probe before sending any tool. Discovery is safe to retry when an
        // idle session expires. Refresh every page so output validation and
        // task restrictions also survive a replacement.
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
        // Legacy configurations historically allow tools/call without discovery.
        // Preserve that only for an explicit JSON-RPC method-not-found response.
        if (
          this.config.find((config) => config.name === server)?.mode !==
            "direct" &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === -32601
        )
          return client;
        throw error;
      }
    }
  }
  private async invoke(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
    retryRead = false,
  ) {
    return this.enqueue(
      server,
      async () => {
        for (let attempt = 0; ; attempt++) {
          this.dispatchGuard?.(server);
          if (options.signal?.aborted)
            throw new McpNotSentError("Chamada MCP cancelada antes do envio.");
          let client: Client;
          try {
            client = await this.liveClient(server, options.signal);
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
          this.active.set(server, options);
          try {
            // A session can still end after the probe. Once callTool starts,
            // any failure remains uncertain and effects must never be replayed.
            const result = await client.callTool(
              { name: tool, arguments: args },
              undefined,
              { timeout: 300000, signal: options.signal },
            );
            const parsed = CallToolResultSchema.parse(
              "toolResult" in result ? result.toolResult : result,
            );
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
              await this.discard(server, client);
              // Direct tools can execute arbitrary effects, including tools with
              // readOnlyHint. Only an explicit local read policy permits replay.
              if (retryRead && attempt === 0 && !options.signal?.aborted)
                continue;
              throw new McpSessionError(
                "A sessão MCP expirou ou foi encerrada (HTTP 404). A chamada não foi reenviada; verifique o resultado no serviço. A próxima operação abrirá uma nova sessão.",
              );
            }
            throw error instanceof McpError ? error : safeError(error);
          } finally {
            this.active.delete(server);
          }
        }
      },
      options.signal,
    );
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
            { name: "pi-personal-agent", version: "0.1.0" },
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
            async (request, extra) =>
              this.active
                .get(server)
                ?.onElicitation?.(request.params, extra.signal) ?? {
                action: "cancel",
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
          // Tool calls (and their elicitation replies) use the same five-minute
          // budget as callTool. Discovery and connection setup stay bounded at 30s.
          const timeout =
            this.active.has(server) && init?.method === "POST" ? 300000 : 30000;
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
  async catalog(onlyDirect = false): Promise<McpCatalog[]> {
    return Promise.all(
      this.config
        .filter((c) => !onlyDirect || c.mode === "direct")
        .map(async (config) => {
          try {
            const discovered = await this.discover(config.name);
            const client = await this.clients.get(config.name);
            let instructions =
              config.mode === "direct" ? client?.getInstructions() : undefined;
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
              mode: config.mode ?? "legacy",
              ...(instructions ? { instructions } : {}),
              tools: discovered
                .filter((tool) =>
                  config.mode === "direct"
                    ? !config.deniedTools?.includes(tool.name) &&
                      (config.allowedTools === undefined ||
                        config.allowedTools.includes(tool.name))
                    : !config.deniedTools?.includes(tool.name) &&
                      (config.readTools.includes(tool.name) ||
                        config.actionTools.includes(tool.name)),
                )
                .map((tool) => ({
                  ...tool,
                  operation:
                    config.mode === "direct"
                      ? ("direct" as const)
                      : config.readTools.includes(tool.name)
                        ? ("read" as const)
                        : ("action" as const),
                })),
            };
          } catch (error) {
            return {
              server: config.name,
              mode: config.mode ?? "legacy",
              tools: [],
              error:
                error instanceof McpError
                  ? error.message
                  : "Não foi possível descobrir ferramentas MCP",
            };
          }
        }),
    );
  }
  async discover(server: string): Promise<Tool[]> {
    return this.enqueue(server, async () => {
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
