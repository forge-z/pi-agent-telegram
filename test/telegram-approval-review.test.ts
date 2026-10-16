import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatMcpApprovalDisplay,
  formatMcpOutcomeMessage,
  looksLikeMailSend,
  reviewableEmail,
  reviewText,
} from "../src/telegram-approvals.js";
import type { McpCall, McpInteraction } from "../src/mcp-calls.js";

const mail = {
  to: "recipient@example.test",
  subject: "Review",
  body: "Complete plain message.",
};
test("review contracts accept direct plaintext mail aliases and explicit to/cc/bcc", () => {
  for (const [app, tool] of [
    ["mail", "send"],
    ["gmail", "messages.send"],
    ["outlook", "sendMail"],
    ["custom", "send_email"],
    ["custom", "gmail.messages.send"],
    ["custom", "SEND_EMAIL"],
  ])
    assert.equal(reviewableEmail(app, tool, mail), true, `${app}/${tool}`);
  assert.equal(
    reviewableEmail("outlook", "sendMail", {
      toAddresses: ["one@example.test", "two@example.test"],
      cc: "three@example.test, four@example.test",
      bcc_addresses: ["five@example.test"],
      subject: "",
      bodyText: "Plain text\nSecond line & punctuation.",
    }),
    true,
  );
  assert.equal(
    reviewableEmail("custom", "send_email", {
      recipients: "one@example.test",
      subject: "subject",
      text: "**Literal** [label](https://example.test/path) `code`",
    }),
    true,
  );
});
test("unknown or reference-based sends cannot borrow a direct email review contract", () => {
  const inputs: unknown[] = [
    { draftId: "draft-123" },
    { id: "123" },
    { messageId: "123" },
    { templateId: "123" },
    { raw: "VG86IHJlY2lwaWVudEBleGFtcGxlLnRlc3Q=" },
    { params: mail },
    { input: mail },
    { message: mail },
    { operation: "send", ...mail },
    { ...mail, draftId: "123" },
    { ...mail, raw: "123" },
    { ...mail, templateId: "123" },
    { ...mail, attachments: [] },
    { ...mail, headers: {} },
    { ...mail, isHtml: false },
    { subject: "Review", body: "Body" },
    { to: mail.to, subject: "Review" },
    { to: mail.to, body: "Body" },
    { ...mail, to: null },
    { ...mail, to: [] },
    { ...mail, to: { address: mail.to } },
    { ...mail, to: "contact-123" },
    { ...mail, cc: "group-123" },
    { ...mail, bcc: [{ email: mail.to }] },
    { ...mail, body: { content: "Body" } },
    { ...mail, body: "SGVsbG8gdGhpcyBpcyBhIG1lc3NhZ2U=" },
    { ...mail, body: "<p>HTML body</p>" },
    { ...mail, body: "Hello {{recipient}}" },
    { ...mail, recipients: mail.to },
    { ...mail, text: mail.body },
    { ...mail, TO: mail.to },
    { ...mail, Body: mail.body },
    JSON.parse(
      '{"to":"recipient@example.test","subject":"s","body":"Body","\\u0064raftId":"123"}',
    ),
    JSON.stringify(mail),
    [mail],
    null,
  ];
  for (const input of inputs)
    assert.equal(
      reviewableEmail("gmail", "send_email", input),
      false,
      JSON.stringify(input),
    );
  for (const tool of [
    "sendDraft",
    "send_draft",
    "drafts.send",
    "reply",
    "replyEmail",
    "forward",
    "forward_email",
    "resend",
    "execute",
    "execute_code",
    "dispatch",
    "unknown",
    "safe_send_email",
    "send\u202eEmail",
  ])
    assert.equal(reviewableEmail("gmail", tool, mail), false, tool);
  assert.equal(reviewableEmail("unknown", "send", mail), false);
  assert.equal(reviewableEmail(undefined, "send_email", mail), false);
  assert.equal(reviewableEmail("", "send_email", mail), false);
  assert.equal(
    reviewableEmail("executor", "execute", { code: JSON.stringify(mail) }),
    false,
  );
});
test("escaped controls and hidden Unicode cannot change a review's visible meaning", () => {
  for (const input of [
    { ...mail, to: "one@example.test\nBcc: hidden@example.test" },
    { ...mail, to: "one%40example.test" },
    { ...mail, subject: "s\r\nBcc: hidden@example.test" },
    { ...mail, body: "safe\u202e hidden" },
    { ...mail, body: "safe\u200bhidden" },
    { ...mail, body: "safe\u0000hidden" },
    { ...mail, body: "safe\ud800hidden" },
  ])
    assert.equal(reviewableEmail("mail", "send", input), false);
  const text = reviewText({ body: "safe\u202e hidden" });
  assert.equal(text.complete, false);
  assert.doesNotMatch(text.text, /\u202e/);
  assert.match(text.text, /u202e/);
  const key = reviewText({ ["hidden\u202e"]: "value" });
  assert.equal(key.complete, false);
  assert.doesNotMatch(key.text, /\u202e/);
});
test("send recognition does not depend on one tool name, and opaque bodies stay unapprovable", () => {
  assert.equal(
    reviewableEmail("gmail", "send", { ...mail, body: "SGVsbG8=" }),
    false,
  );
  assert.equal(reviewableEmail("gmail", "send", { ...mail, body: "Hi" }), true);
  const sparse = ["one@example.test"];
  sparse.length = 2;
  assert.equal(reviewableEmail("mail", "send", { ...mail, to: sparse }), false);
  assert.equal(reviewableEmail("microsoft", "outlook.send", mail), true);
  assert.equal(reviewableEmail("gmail", "messages/send", mail), true);
  assert.equal(reviewableEmail("gmail", "SEND", mail), true);
  for (const [app, tool, input] of [
    ["gmail", "send_email", { draftId: "d" }],
    ["outlook", "sendMail", { message_id: "m" }],
    ["mail", "send", { id: "m" }],
    ["custom", "dispatch", { draftId: "d" }],
    ["gmail", "users.drafts.send", { id: "d" }],
    ["custom", "gmail.messages.send", mail],
    ["microsoft", "outlook.send", mail],
    ["gmail", "send\u202eEmail", mail],
    ["notes", "save", { templateId: "t" }],
    ["files", "upload", { raw: "abc" }],
  ] as const)
    assert.equal(looksLikeMailSend(app, tool, input), true, `${app}/${tool}`);
  assert.equal(looksLikeMailSend("calendar", "send", { id: "event-1" }), false);
  assert.equal(
    looksLikeMailSend("files", "read", { path: "notes.txt" }),
    false,
  );
  assert.equal(
    looksLikeMailSend("executor", "execute", { code: "send()" }),
    false,
  );
  assert.equal(looksLikeMailSend("unknown", "send", mail), false);
});
test("MCP approval display hides executor JSON for executionId pauses", () => {
  const item = {
    kind: "resume",
    server: "executor",
    payload: JSON.stringify({
      protocol: "executor",
      requestId: "exec_abc",
      executionId: "exec_abc",
      elicitation: {
        mode: "form",
        message: "Atualizar catálogo Zoho?",
        requestedSchema: { type: "object", properties: {} },
      },
      invocation: {
        app: "executor",
        tool: "execute",
        input: { executionId: "exec_abc" },
      },
    }),
  } as McpInteraction;
  const call = {
    server: "executor",
    tool: "execute",
    args: "{}",
  } as McpCall;
  const display = formatMcpApprovalDisplay(item, call, {
    view: { text: "{}" },
    canAccept: true,
    opaque: false,
    executorExecutionPause: true,
  });
  assert.match(display, /Atualizar catálogo Zoho/);
  assert.doesNotMatch(display, /"invocation"/);
});
test("MCP outcome message summarizes completed executor runs", () => {
  const call = {
    state: "done",
    result: JSON.stringify({
      isError: false,
      structuredContent: {
        status: "completed",
        result: { ok: true },
      },
    }),
  } as McpCall;
  assert.match(formatMcpOutcomeMessage(call), /sucesso/i);
});
