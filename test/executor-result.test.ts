import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executorPauseKind,
  isExecutorApproval,
  isExecutorFailure,
  programPayload,
} from "../src/executor-result.js";

const pause = {
  status: "approval-required",
  requestId: "apr_c4b477c6",
  invocation: { tool: "machines.exec", input: {} },
  elicitation: {
    mode: "form",
    message: "Approve?",
    requestedSchema: { type: "object", properties: {} },
  },
};

test("execution.value is the program result, not the wrapper status", () => {
  const payload = programPayload({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "completed",
          execution: {
            ok: true,
            value: { state: "DONE", result: { pr: "https://example/pull/1" } },
          },
        }),
      },
    ],
  }) as { state: string; result: { pr: string } };
  assert.equal(payload.state, "DONE");
  assert.equal(payload.result.pr, "https://example/pull/1");
});

test("execution.ok false stays an error and is not a completed job", () => {
  const envelope = {
    status: "completed",
    execution: {
      ok: false,
      error: {
        kind: "ToolCallFailed",
        message: "Instabox 404 not_found",
        response: { status: 404, code: "not_found" },
      },
    },
  };
  assert.equal(isExecutorFailure(envelope), true);
  assert.equal(isExecutorApproval(envelope), false);
  const unwrapped = programPayload(envelope) as { status?: string };
  assert.equal(unwrapped.status, "completed");
  assert.equal(
    (unwrapped as { execution?: { ok?: boolean } }).execution?.ok,
    false,
  );
});

test("an apr_ pause is approval, including when nested in execution.value", () => {
  assert.equal(executorPauseKind(pause), "approval-required");
  assert.equal(isExecutorApproval(pause), true);
  const nested = {
    status: "completed",
    execution: { ok: true, value: pause },
  };
  assert.equal(isExecutorApproval(pause), true);
  assert.equal(
    programPayload(nested),
    pause,
    "the pause is the value, not a job status",
  );
  assert.equal(isExecutorApproval(programPayload(nested)), true);
});

test("the old ok/data/content envelope is not unwrapped", () => {
  const inner = { state: "DONE", result: { pr: "https://example/pull/2" } };
  const legacy = {
    ok: true,
    data: { content: [{ type: "text", text: JSON.stringify(inner) }] },
  };
  const unwrapped = programPayload(legacy) as { ok?: boolean; state?: string };
  assert.equal(unwrapped.ok, true);
  assert.equal(unwrapped.state, undefined);
});
