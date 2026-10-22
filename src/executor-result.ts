/**
 * One reader for Executor `execute`/`call` results.
 * Success is `{status:"completed", execution:{ok:true, value}}`.
 * Failure is `{status:"completed", execution:{ok:false, error}}`.
 * A pause is `{status:"approval-required"|"paused", requestId:"apr_…"}`.
 * `status:"completed"` is the call, not a job.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
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

/** Objects inside an MCP/Executor result, outermost first. */
export function executorBodies(
  value: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return [];
    try {
      return executorBodies(JSON.parse(trimmed), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((item) => executorBodies(item, depth + 1));
  const body = asRecord(value);
  if (!body) return [];
  const nested = [
    "structuredContent",
    "content",
    "text",
    "execution",
    "value",
    "error",
    "response",
    "output",
    "result",
  ].flatMap((key) => (key in body ? executorBodies(body[key], depth + 1) : []));
  return [body, ...nested];
}

/**
 * Why this object is an approval pause, or undefined.
 * Browser-mode `approvalUrl` is not a pause this process can answer.
 */
export function executorPauseKind(
  value: Record<string, unknown>,
): "approval-required" | "input-required" | undefined {
  if (Object.hasOwn(value, "approvalUrl")) return undefined;
  const status = statusWord(value.status);
  if (status === "approval_required" || status === "paused")
    return "approval-required";
  if (status === "input_required") return "input-required";
  if (
    status === "waiting_for_interaction" ||
    status === "awaiting_approval" ||
    status === "awaiting_input"
  )
    return "approval-required";
  if (value.paused === true) return "approval-required";
  if (
    typeof value.executionId === "string" &&
    value.executionId.trim() &&
    (asRecord(value.invocation) ||
      typeof value.tool === "string" ||
      asRecord(value.execution) ||
      asRecord(value.elicitation)?.mode === "form")
  )
    return "approval-required";
  return undefined;
}

/** Approval / paused Executor result (`apr_…`), not a finished job. */
export function isExecutorApproval(value: unknown): boolean {
  const body = asRecord(value);
  if (!body || Object.hasOwn(body, "approvalUrl")) return false;
  if (executorPauseKind(body)) return true;
  return /^apr_/i.test(approvalId(body));
}

/** `execution.ok === false` or an MCP `isError` result. Not a job status. */
export function isExecutorFailure(value: unknown): boolean {
  const body = asRecord(value);
  if (!body) return false;
  if (body.isError === true) return true;
  const execution = asRecord(body.execution);
  return !!execution && execution.ok === false;
}

/**
 * The program's own return. Unwraps `{status, execution:{ok, value}}` and MCP
 * text content. A list's `data` array and a run's `result` stay put.
 */
/** HTTP 422 / InputInvalid is a bad read, not a transient outage. 404 is not this. */
export function isInputInvalid(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message}\n${JSON.stringify(
          (error as { detail?: unknown }).detail ?? "",
        )}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  if (/\b404\b/.test(text) || /not[\s_-]*found/i.test(text)) return false;
  if (/\b422\b/.test(text)) return true;
  if (/InputInvalid|InvalidToolInput/i.test(text)) return true;
  if (/Input failed validation|Expected object|accountId ausente/i.test(text))
    return true;
  if (
    /"retryable"\s*:\s*false/i.test(text) &&
    /validat|invalid input|422/i.test(text)
  )
    return true;
  return false;
}

export function programPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") {
      try {
        current = JSON.parse(current);
      } catch {
        return current;
      }
      continue;
    }
    if (!current || typeof current !== "object") return current;
    const body = current as Record<string, unknown>;
    const execution = asRecord(body.execution);
    if (execution) {
      if (execution.ok === false) return current;
      if (execution.value !== undefined && execution.value !== null) {
        current = execution.value;
        continue;
      }
    }
    if ("run_id" in body || "runId" in body || Array.isArray(body.data))
      return current;
    if (Array.isArray(body.content)) {
      const text = body.content.find(
        (item) =>
          !!item &&
          typeof item === "object" &&
          (item as { type?: string }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      ) as { text: string } | undefined;
      if (text) {
        current = text.text;
        continue;
      }
    }
    if (typeof body.result === "string") {
      current = body.result;
      continue;
    }
    return current;
  }
  return current;
}
