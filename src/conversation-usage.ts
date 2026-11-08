import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import {
  defineTool,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";

/** Model-facing name. Always registered, like the task tools. */
export const CONVERSATION_USAGE_TOOL_NAME = "conversation_usage";

/** Shown to the model when the ledger cannot be read. No ids, no cause. */
export const CONVERSATION_USAGE_READ_ERROR =
  "Não foi possível ler o consumo desta conversa.";

const USD_UNAVAILABLE = "indisponível";

export type UsageCostReport =
  | {
      available: true;
      total: number;
      source: "catalog" | "provider" | "mixed";
    }
  | { available: false; reason: typeof USD_UNAVAILABLE };

export interface TokenReport {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + cacheRead + cacheWrite. Output is separate. */
  prompt: number;
  totalTokens: number;
  /** Subset of output. Present only when every summed record reported it. */
  reasoning?: number;
  /** Subset of cacheWrite. Present only when every summed record reported it. */
  cacheWrite1h?: number;
}

export interface UsageBucketReport {
  tokens: TokenReport;
  /** cacheRead / prompt, or null when prompt is 0. */
  cacheHitRate: number | null;
  usd: UsageCostReport;
}

export interface ConversationUsageReport {
  scope: "conversa atual";
  tokens: TokenReport;
  cacheHitRate: number | null;
  usd: UsageCostReport;
  models: ({ id: string } & UsageBucketReport)[];
  tools: ({ name: string } & UsageBucketReport)[];
  note: string;
}

const SCOPE_NOTE =
  "Somente esta conversa. prompt = input + cacheRead + cacheWrite. reasoning já está em output; cacheWrite1h já está em cacheWrite; não some esses subconjuntos de novo.";

/**
 * USD for one stored Usage.
 * `cost.total` is the figure: the provider's billed amount when
 * `totalFromProvider` is true, otherwise the catalog estimate. A zero total
 * with tokens and no provider figure means the rates were zero (the legacy
 * `llm` provider registers zeros). That is not a free call.
 */
function priceOf(usage: Usage): UsageCostReport {
  const cost = usage.cost;
  const components =
    finite(cost?.input) +
    finite(cost?.output) +
    finite(cost?.cacheRead) +
    finite(cost?.cacheWrite);
  const total = optionalFinite(cost?.total);
  const tokens =
    finite(usage.input) +
    finite(usage.output) +
    finite(usage.cacheRead) +
    finite(usage.cacheWrite);
  if (cost?.totalFromProvider === true && total !== undefined)
    return { available: true, total, source: "provider" };
  if (total !== undefined && total > 0)
    return { available: true, total, source: "catalog" };
  if (components > 0)
    return { available: true, total: components, source: "catalog" };
  if (tokens > 0) return { available: false, reason: USD_UNAVAILABLE };
  return { available: true, total: 0, source: "catalog" };
}

function combineCosts(parts: UsageCostReport[]): UsageCostReport {
  if (parts.some((part) => !part.available))
    return { available: false, reason: USD_UNAVAILABLE };
  const priced = parts.filter(
    (part): part is Extract<UsageCostReport, { available: true }> =>
      part.available,
  );
  const total = priced.reduce((sum, part) => sum + part.total, 0);
  const sources = new Set(
    priced
      .filter((part) => part.total > 0 || part.source === "provider")
      .map((part) => part.source),
  );
  if (sources.size === 0)
    return { available: true, total: 0, source: "catalog" };
  if (sources.size === 1) {
    const source = [...sources][0]!;
    return { available: true, total, source };
  }
  return { available: true, total, source: "mixed" };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function optionalFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokensOf(usage: Usage): TokenReport {
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const report: TokenReport = {
    input,
    output,
    cacheRead,
    cacheWrite,
    prompt: input + cacheRead + cacheWrite,
    totalTokens:
      optionalFinite(usage.totalTokens) ??
      input + output + cacheRead + cacheWrite,
  };
  const reasoning = optionalFinite(usage.reasoning);
  const cacheWrite1h = optionalFinite(usage.cacheWrite1h);
  if (reasoning !== undefined) report.reasoning = reasoning;
  if (cacheWrite1h !== undefined) report.cacheWrite1h = cacheWrite1h;
  return report;
}

function sumTokens(parts: TokenReport[]): TokenReport {
  const report: TokenReport = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    prompt: 0,
    totalTokens: 0,
  };
  for (const part of parts) {
    report.input += part.input;
    report.output += part.output;
    report.cacheRead += part.cacheRead;
    report.cacheWrite += part.cacheWrite;
    report.totalTokens += part.totalTokens;
  }
  report.prompt = report.input + report.cacheRead + report.cacheWrite;
  if (parts.length > 0 && parts.every((part) => part.reasoning !== undefined))
    report.reasoning = parts.reduce((sum, part) => sum + part.reasoning!, 0);
  if (
    parts.length > 0 &&
    parts.every((part) => part.cacheWrite1h !== undefined)
  )
    report.cacheWrite1h = parts.reduce(
      (sum, part) => sum + part.cacheWrite1h!,
      0,
    );
  return report;
}

function cacheHitRate(tokens: TokenReport): number | null {
  if (tokens.prompt <= 0) return null;
  return Math.round((tokens.cacheRead / tokens.prompt) * 1e6) / 1e6;
}

function bucket(usage: Usage): UsageBucketReport {
  const tokens = tokensOf(usage);
  return { tokens, cacheHitRate: cacheHitRate(tokens), usd: priceOf(usage) };
}

function ownEntries(
  record: Record<string, Usage> | undefined,
): [string, Usage][] {
  if (!record) return [];
  return Object.entries(record)
    .filter(
      (entry): entry is [string, Usage] =>
        !!entry[1] && typeof entry[1] === "object",
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function noteFor(
  usd: UsageCostReport,
  tokens: TokenReport,
  parts: UsageCostReport[],
): string {
  if (!usd.available) {
    const someKnown = parts.some((part) => part.available && part.total > 0);
    const partial = someKnown
      ? " O total da conversa não fecha; use só o usd dos modelos ou ferramentas com usd.available true e diga que o restante está sem preço."
      : "";
    return `${SCOPE_NOTE} Estimativa total em USD indisponível: preço de catálogo ausente ou tarifas zeradas. Não apresente $0.00 e não diga que a inferência foi gratuita. Os tokens continuam válidos.${partial}`;
  }
  if (
    usd.total === 0 &&
    tokens.totalTokens === 0 &&
    tokens.prompt === 0 &&
    tokens.output === 0
  )
    return `${SCOPE_NOTE} Não há consumo registrado nesta conversa.`;
  if (usd.source === "provider")
    return `${SCOPE_NOTE} USD é o valor reportado pelo provedor.`;
  if (usd.source === "mixed")
    return `${SCOPE_NOTE} USD mistura estimativa de catálogo e valor reportado pelo provedor.`;
  return `${SCOPE_NOTE} USD é estimativa de catálogo.`;
}

/** Structured summary of one conversation's UsageDoc. Never reads another conversation. */
export function summarizeConversationUsage(
  state: UsageState | undefined,
): ConversationUsageReport {
  const models = ownEntries(state?.models).map(([id, usage]) => ({
    id,
    ...bucket(usage),
  }));
  const tools = ownEntries(state?.tools).map(([name, usage]) => ({
    name,
    ...bucket(usage),
  }));
  const parts = [...models, ...tools];
  const tokens = sumTokens(parts.map((part) => part.tokens));
  const usd = combineCosts(parts.map((part) => part.usd));
  return {
    scope: "conversa atual",
    tokens,
    cacheHitRate: cacheHitRate(tokens),
    usd,
    models,
    tools,
    note: noteFor(
      usd,
      tokens,
      parts.map((part) => part.usd),
    ),
  };
}

export const conversationUsageTool = defineTool({
  name: CONVERSATION_USAGE_TOOL_NAME,
  description:
    "Consulta tokens e custo estimado em USD somente desta conversa. Chame quando o usuário perguntar sobre tokens, consumo, usage, gasto ou custo desta conversa. Não lê outras conversas nem o total do armazenamento. Se usd.available for false, diga que a estimativa em USD está indisponível; nunca apresente $0.00 nem diga que a inferência foi gratuita. reasoning já está em output e cacheWrite1h já está em cacheWrite: não some de novo.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, ctx) => {
    try {
      const state = await api.snapshot(UsageDoc, api.conversationId, ctx);
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(summarizeConversationUsage(state)),
          },
        ],
      };
    } catch {
      return {
        isError: true,
        output: [{ type: "text", text: CONVERSATION_USAGE_READ_ERROR }],
      };
    }
  },
});
