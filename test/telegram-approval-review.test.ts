import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  formatMcpApprovalDisplay,
  formatMcpOutcomeMessage,
  formatUncertainCallReview,
  looksLikeMailSend,
  reviewableEmail,
  reviewText,
  verifyMcp,
} from "../src/telegram-approvals.js";
import type { McpCall, McpInteraction } from "../src/mcp-calls.js";
import {
  type TelegramButton,
  credentialBinding,
} from "../src/telegram-controls.js";
import { hash } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import { configureTelegram } from "../src/telegram-polling.js";

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
  assert.match(formatMcpOutcomeMessage(call), /success/i);
});
test("verifyMcp with incomplete review (e.g. omitted URL query) provides no verification buttons and guides /resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-deadend-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const gateway = new McpGateway([]);
  gateway.catalog = async () => [];
  const owner = { chat: "100", user: "42" };
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "123:test", users: ["42"], chats: ["100"] },
        { id: 123, username: "test_bot" },
      ),
  });
  try {
    const conversationId = await app.telegramChats.ensure(owner);
    const call = {
      id: "call-deadend-1",
      conversationId,
      server: "web",
      tool: "fetch",
      args: JSON.stringify({
        url: "https://example.test/api?token=secret&data=1",
      }),
      state: "uncertain" as const,
      result: null,
      binding: "web:default",
      updatedAt: Date.now(),
    };
    app.store.run(
      "INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      call.id,
      call.conversationId,
      call.server,
      call.tool,
      call.args,
      call.state,
      call.result,
      call.binding,
      call.updatedAt,
    );
    const callHash = hash(JSON.stringify(call));
    const buttonData: TelegramButton = {
      kind: "mcp-check",
      owner,
      originThreadId: null,
      conversationId,
      callId: call.id,
      callHash,
      verification: "review",
      authorizationVersion: app.store.authorizationVersion(
        owner,
        conversationId,
      ),
      credentialBinding: credentialBinding(app),
      expiresAt: Date.now() + 60000,
    };
    await verifyMcp(app, buttonData, 500);

    const prefix = `telegram:mcp-check:${call.id}:${callHash}`;
    const deliveries = app.store.all<{ id: string; text: string }>(
      "SELECT id,text FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      `${prefix}:`,
      `${prefix};`,
    );
    assert.equal(deliveries.length, 1);
    const text = deliveries[0].text;
    const markupRaw = app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:markup:${deliveries[0].id}`,
    );
    const markup = markupRaw
      ? JSON.parse(markupRaw.value)
      : { inline_keyboard: [] };
    // Rule: Never offer verification buttons when review is incomplete
    assert.deepEqual(markup.inline_keyboard, []);
    // Must explain that verification options are unavailable due to hidden/abbreviated content
    assert.match(
      text,
      /Verification options are unavailable because part of the content was hidden/i,
    );
    // Must explicitly provide the /resume command exit
    assert.match(text, /\/resume/);
    assert.doesNotMatch(text, /\/reload/);
    assert.doesNotMatch(text, /\/destravar/);
    assert.doesNotMatch(text, /Confirm only what you verified/);

    // Verify that a complete review retains the verification buttons and confirmation guidance
    const callComplete = {
      id: "call-complete-1",
      conversationId,
      server: "web",
      tool: "fetch",
      args: JSON.stringify({
        url: "https://example.test/api",
      }),
      state: "uncertain" as const,
      result: null,
      binding: "web:default",
      updatedAt: Date.now(),
    };
    app.store.run(
      "INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      callComplete.id,
      callComplete.conversationId,
      callComplete.server,
      callComplete.tool,
      callComplete.args,
      callComplete.state,
      callComplete.result,
      callComplete.binding,
      callComplete.updatedAt,
    );
    const completeHash = hash(JSON.stringify(callComplete));
    const completeButtonData: TelegramButton = {
      kind: "mcp-check",
      owner,
      originThreadId: null,
      conversationId,
      callId: callComplete.id,
      callHash: completeHash,
      verification: "review",
      authorizationVersion: app.store.authorizationVersion(
        owner,
        conversationId,
      ),
      credentialBinding: credentialBinding(app),
      expiresAt: Date.now() + 60000,
    };
    await verifyMcp(app, completeButtonData, 501);

    const prefixComplete = `telegram:mcp-check:${callComplete.id}:${completeHash}`;
    const deliveriesComplete = app.store.all<{ id: string; text: string }>(
      "SELECT id,text FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      `${prefixComplete}:`,
      `${prefixComplete};`,
    );
    assert.equal(deliveriesComplete.length, 1);
    const textComplete = deliveriesComplete[0].text;
    const markupCompleteRaw = app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:markup:${deliveriesComplete[0].id}`,
    );
    const markupComplete = markupCompleteRaw
      ? JSON.parse(markupCompleteRaw.value)
      : { inline_keyboard: [] };
    assert.equal(markupComplete.inline_keyboard.length, 2);
    assert.match(textComplete, /Confirm only what you verified/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const reviewLeaves = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value.flatMap(reviewLeaves)
    : value && typeof value === "object"
      ? Object.values(value).flatMap(reviewLeaves)
      : [value];

test("uncertain call card shows a readable summary instead of raw JSON", () => {
  const view = formatUncertainCallReview({
    server: "executor",
    tool: "call",
    state: "uncertain",
    input: {
      calls: {
        path: "tools.x.y",
        input: { accountId: "acc_1", input: {} },
      },
    },
  });
  assert.equal(view.complete, true);
  for (const line of [
    "MCP call with an uncertain result",
    "Server: executor",
    "Tool: call",
    "State: uncertain",
    "Target: tools.x.y",
    "Parameters:",
    '  accountId: "acc_1"',
    "  input: {}",
  ])
    assert.ok(view.text.includes(line), `${line}\n---\n${view.text}`);
  assert.doesNotMatch(view.text, /"server"/);
  assert.doesNotMatch(view.text, /^\s*"[^"]+"\s*:/m);
  assert.doesNotMatch(view.text, /"calls"/);
});

test("uncertain call card keeps nested values and numbered arrays", () => {
  const input = {
    calls: [
      {
        path: "tools.instabox.machines.list",
        input: {
          accountId: "acc_1",
          filter: { status: "active", tags: ["alpha", "beta"] },
          limit: 5,
        },
      },
      {
        path: "tools.instabox.orders.get",
        input: { orderId: "order_9", flags: [true, false, null] },
      },
    ],
  };
  const view = formatUncertainCallReview({
    server: "executor",
    tool: "call",
    state: "uncertain",
    input,
  });
  assert.equal(view.complete, true);
  assert.ok(view.text.includes("Target:"));
  assert.ok(view.text.includes("  1. tools.instabox.machines.list"));
  assert.ok(view.text.includes("  2. tools.instabox.orders.get"));
  // Every leaf value survives, and each array keeps one numbered item per element.
  const leaves = reviewLeaves(input);
  for (const leaf of leaves.filter((item) => typeof item !== "string"))
    assert.ok(view.text.includes(JSON.stringify(leaf)), String(leaf));
  const arrays = [2, 2, 3];
  const numbered = view.text.match(/^\s*\d+\.\s/gm)?.length ?? 0;
  // Two Alvo entries plus the nested arrays: tags, flags, and the two calls.
  assert.equal(
    numbered,
    arrays.reduce((total, size) => total + size, 0),
  );
  // A different shape is still rendered field by field, not as JSON.
  const other = formatUncertainCallReview({
    server: "executor",
    tool: "call",
    state: "uncertain",
    input: {
      address: "tools.instabox.machines.read",
      payload: { ids: [1, 2] },
    },
  });
  assert.equal(other.complete, true);
  assert.ok(other.text.includes("Target: tools.instabox.machines.read"));
  assert.ok(other.text.includes("  payload:"));
  assert.match(other.text, /^\s*1\. 1$/m);
  assert.match(other.text, /^\s*2\. 2$/m);
  assert.doesNotMatch(other.text, /"address"/);
});

test("uncertain call card hides sensitive content and oversized text", () => {
  for (const input of [
    {
      calls: {
        path: "tools.x.y",
        input: { url: "https://u:p@example.test/a?q=1" },
      },
    },
    { calls: { path: "tools.x.y", input: { note: "sk-abcdefghijklmn" } } },
    { calls: { path: "tools.x.y", input: { apiKey: "plain-value" } } },
    { calls: { path: "tools.x.y", input: { note: "safe\u202e hidden" } } },
  ]) {
    const view = formatUncertainCallReview({
      server: "executor",
      tool: "call",
      state: "uncertain",
      input,
    });
    assert.equal(view.complete, false, JSON.stringify(input));
  }
  const large = formatUncertainCallReview({
    server: "executor",
    tool: "call",
    state: "uncertain",
    input: { calls: { path: "tools.x.y", input: { note: "x".repeat(30000) } } },
  });
  assert.equal(large.complete, false);
  assert.match(large.text, /Content too large to review in Telegram/);

  const view = formatUncertainCallReview(
    {
      server: "executor",
      tool: "call",
      state: "uncertain",
      input: {
        calls: { path: "tools.x.y", input: { note: "sk-abcdefghijklmn" } },
      },
    },
    (text) => text,
  );
  assert.equal(view.complete, false);
  assert.doesNotMatch(view.text, /sk-abcdefghijklmn/);
});

test("uncertain verification card sends the readable summary and keeps its buttons", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-readable-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const gateway = new McpGateway([]);
  gateway.catalog = async () => [];
  const owner = { chat: "100", user: "42" };
  const app = await Runtime.open({
    dir,
    models,
    gateway,
    initialize: (store) =>
      configureTelegram(
        store,
        { token: "123:test", users: ["42"], chats: ["100"] },
        { id: 123, username: "test_bot" },
      ),
  });
  try {
    const conversationId = await app.telegramChats.ensure(owner);
    const call = {
      id: "call-readable-1",
      conversationId,
      server: "executor",
      tool: "call",
      args: JSON.stringify({
        calls: { path: "tools.x.y", input: { accountId: "acc_1", input: {} } },
      }),
      state: "uncertain" as const,
      result: null,
      binding: "executor:default",
      updatedAt: Date.now(),
    };
    app.store.run(
      "INSERT INTO mcp_calls(id,conversationId,server,tool,args,state,result,binding,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      call.id,
      call.conversationId,
      call.server,
      call.tool,
      call.args,
      call.state,
      call.result,
      call.binding,
      call.updatedAt,
    );
    const callHash = hash(JSON.stringify(call));
    await verifyMcp(
      app,
      {
        kind: "mcp-check",
        owner,
        originThreadId: null,
        conversationId,
        callId: call.id,
        callHash,
        verification: "review",
        authorizationVersion: app.store.authorizationVersion(
          owner,
          conversationId,
        ),
        credentialBinding: credentialBinding(app),
        expiresAt: Date.now() + 60000,
      },
      600,
    );
    const prefix = `telegram:mcp-check:${call.id}:${callHash}`;
    const deliveries = app.store.all<{ id: string; text: string }>(
      "SELECT id,text FROM deliveries WHERE id>=? AND id<? ORDER BY rowid",
      `${prefix}:`,
      `${prefix};`,
    );
    assert.equal(deliveries.length, 1);
    const text = deliveries[0].text;
    for (const line of [
      "Server: executor",
      "Tool: call",
      "State: uncertain",
      "Target: tools.x.y",
      "accountId: &quot;acc_1&quot;",
    ])
      assert.ok(text.includes(line), `${line}\n---\n${text}`);
    assert.doesNotMatch(text, /"server"/);
    assert.doesNotMatch(text, /"calls"/);
    const markupRaw = app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      `telegram:markup:${deliveries[0].id}`,
    );
    const markup = markupRaw
      ? JSON.parse(markupRaw.value)
      : { inline_keyboard: [] };
    assert.equal(markup.inline_keyboard.length, 2);
    assert.match(text, /Confirm only what you verified/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
