# Pi Agent TG — Telegram + Docker Compose

[Português](README.pt-BR.md). This repository is a small, Telegram-only deployment around pinned `@earendil-works/pi-durable` / `pi-ai` **1.3.0**, Node 24 and SQLite. There is no web server, web chat, login page, local browser or subscription OAuth login. The bot uses long polling; no public port, domain, reverse proxy or webhook is needed.

**Pi Agent is an AI assistant, not a coding agent.** It ships no file, shell, patch, repository or browser tools, and it has no notion of the host, the volume or the source tree. Beyond conversation and the built-in schedule tools, its only capabilities are the MCP servers the operator exposes. If nothing is exposed, it can talk and schedule and do nothing else. Treat everything coming back from MCP as untrusted external data.

It is built around [Executor](https://executor.sh): the preferred way to expose every MCP server behind one authenticated endpoint, so a single `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` covers the whole tool surface. It runs on [pi.dev](https://pi.dev) with the pinned [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) harness.

## Install on an Oracle VM

Use Docker Engine and Compose v2.24+ on Linux amd64 or arm64. The official `node:24-bookworm-slim` image has both architectures. Runtime persistence uses built-in `node:sqlite`, with no application-specific native binary. Local verification covers amd64; arm64 execution was not exercised here.

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env
# Edit .env ON THE SERVER with your own credentials and Telegram numeric IDs.
chmod 600 .env
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
docker compose ps
docker compose logs --tail=50
# First configuration, from the container terminal: pick the global default model.
docker compose exec pi-agent-tg npm run setup-model -- --list
docker compose exec pi-agent-tg npm run setup-model -- --model llm/<id> --effort high
```

Deploying on Coolify? See [docs/coolify.md](docs/coolify.md) for the panel-side checklist: runtime variables, commit availability, volume and healthcheck.

Use a dedicated bot and the new `pi_agent_tg_data` volume. Do not attach another deployment's volume or run two processes against the same volume. The code retains conservative ledger compatibility helpers, but migrating production web histories is outside this deployment's setup. No topics or conversations are created at startup. Send the first message or command inside an existing Telegram topic to create its isolated local conversation. Create/rename native topics in Telegram itself; the bot never calls `createForumTopic`.

Configure `TELEGRAM_ALLOWED_USERS`. `TELEGRAM_ALLOWED_CHATS` is optional and defaults to the same IDs (private DM). Set it only for groups or supergroups (negative chat IDs). An update must pass both the user and chat allowlists. Private chats and native forum supergroups (negative chat IDs) are supported. A conversation is scoped to **chat + user + native topic ID**. Use private chats or trusted groups: Telegram group members can see messages even when only allowlisted users can control the bot. Ensure the bot can receive the intended group messages, using Telegram's own group/privacy settings. A pre-existing webhook or a second polling consumer causes a safe startup failure; this app does not remove webhooks.

## Configuration

| Variable                               | Meaning                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                   | Bot token, server side only                                                       |
| `TELEGRAM_ALLOWED_USERS`               | Comma-separated user IDs (required)                                               |
| `LLM_BASE_URL`                         | OpenAI-compatible endpoint registered as the single provider `llm`                |
| `LLM_API_KEY`                          | API key for that endpoint (raw; no `Bearer` prefix)                               |
| `LLM_MODELS`                           | Catalog declaration. Needed for `/thinking`: discovery reports no capabilities    |
| `EXECUTOR_MCP_URL`                     | Executor MCP HTTPS endpoint for this deployment (self-hosted or cloud); see below |
| `EXECUTOR_TOKEN`                       | Raw Executor API key (`Authorization: Bearer` is added by the app)                |
| `MCP_SERVERS_JSON` / `MCP_CONFIG_FILE` | Optional full MCP list; when non-empty and not `[]`, replaces `EXECUTOR_MCP_URL`  |

The rest of the optional set — `TELEGRAM_ALLOWED_CHATS` (groups/supergroups), `NAME_FILE` variants, `MCP_SERVERS_JSON`, `MCP_CONFIG_FILE` — lives in [.env.example](.env.example). **A panel variable that the compose does not declare never reaches the container**: Coolify forwards only what the `environment:` block maps, so add the line there first. Everything else the image needs is fixed in the Dockerfile or injected by the platform.

API keys and bot/MCP env tokens also support `NAME_FILE`, pointing to an operator-mounted file. Use runtime secret variables in Coolify; never build arguments. MCP config accepts `tokenEnv` or an operator-mounted `tokenFile`, optional `allowedTools` / `deniedTools`, and only direct mode. Endpoints require HTTPS; HTTP is restricted to loopback for local development/tests. Subscription credentials are unsupported. The `llm` provider speaks the OpenAI-compatible completion API; catalog entries need explicit `contextWindow`, `maxTokens` and `reasoning` because `GET /models` cannot report them.

Compose injects the variables the process needs to start: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODELS`, `EXECUTOR_MCP_URL` and `EXECUTOR_TOKEN`. `NODE_ENV`, `DATA_DIR` and the commit SHA are not operator configuration: `NODE_ENV` and `DATA_DIR` are fixed by the image and the SHA is injected by the platform at deploy time. Set `EXECUTOR_MCP_URL` per host (self-hosted Executor vs cloud) in `.env`, Coolify, or your shell — the repository does not ship a real Executor URL. Executor MCP is registered only when `EXECUTOR_TOKEN` is also set; until then the bot can start but MCP tools stay unavailable. A non-empty `MCP_SERVERS_JSON` other than `[]` still overrides and supports multiple servers. `EXECUTOR_TOKEN` is the raw API key. The process adds `Authorization: Bearer` itself — do not include the `Bearer ` prefix in the variable.

## Choosing the model

**The first configuration is done in the terminal, not in Telegram.** Open the container terminal (Coolify → service terminal) and set the global default there:

```sh
npm run setup-model -- --list
npm run setup-model -- --model llm/<id> --effort high
```

That is the intended first step: it lists the catalog and writes the default used by new conversations. Everything the Telegram menus change afterwards (`/model`, `/thinking`) applies to **one conversation only**, and `setup-model` is the only way to move the global default from inside the deployment.

No model is pinned in the environment. Without `LLM_MODELS` the catalog is read from `GET {LLM_BASE_URL}/models`; discovery cannot report capabilities, so `/thinking` offers only `off`. The URL is the API root used verbatim — `https://api.openai.com/v1`, `https://api.deepseek.com`.

Each `LLM_MODELS` entry is `id` or `id|contextWindow|maxTokens|reasoning`, where `reasoning` is `false`, `true` (standard levels) or exactly the `+` separated levels the upstream model accepts:

```sh
LLM_MODELS=chat-model,reasoning-model|65536|8192|true
LLM_MODELS=deepseek-flash|1000000|384000|off+low+high+max
```

The second line is the DeepSeek recipe: its catalog rejects `minimal` and `medium` and supports `max`. A conversation with no saved selection uses the **first catalog entry** and the bot warns once per conversation until a choice is stored.

Set the global default from the container terminal with `npm run setup-model`: it lists the catalog and writes the default for new conversations.

```sh
npm run setup-model -- --list
npm run setup-model -- --model llm/<id> --effort high
```

Run it without arguments in an interactive terminal for a numbered menu. `/model` and `/thinking` in Telegram stay per conversation and always take precedence, including across restart. See [docs/coolify.md](docs/coolify.md). Startup logs print safe configuration hints (for example a missing `LLM_API_KEY`); transport failures stay generic. Replace placeholder values in `.env` with real Telegram, LLM and Executor credentials before expecting a healthy container.

Credentials remain in process memory/config files; the Telegram credential ledger stores a fingerprint, not the token. Histories, tool payloads and results can still be sensitive. Protect volume/backups and the host. Logs omit raw exceptions and known configured secrets are redacted from Telegram output. Redaction is not a substitute for choosing trustworthy MCP servers.

## Telegram commands

| Command     | Behavior                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `/model`    | Inline provider/model menu for the configured `llm` catalog                                                    |
| `/thinking` | Inline reasoning efforts supported by the active model                                                         |
| `/crons`    | List, create, edit, pause, resume and delete schedules; create/edit/delete require confirmation                |
| `/stop`     | Abort this topic's execution and queue; invalidate its local approval buttons; future schedules remain         |
| `/status`   | Active model/effort, runs, MCP availability/pending/uncertain states, version/commit and verification controls |
| `/help`     | Show these commands                                                                                            |

`/model` and `/thinking` are persisted per conversation, including across container recreation and changed bootstrap environment defaults. There is no `/new`, `/topics`, `/compact`, web mirroring or cross-topic selection. `//` sends a literal leading slash.

Compaction is automatic in installed `pi-durable` 1.3.0. It uses the **conversation's active model and thinking level** when compaction starts. Upstream policy defaults are unmodified (`enabled=true`, reserve 16384 tokens, keep recent 20000, background threshold offset 32768). Original durable entries are retained; only the model context is summarized. There is no Jev or separate summarization model. The test suite exercises actual automatic compaction with a mock provider.

## MCP and Executor approvals

A real `approval-required` / `input-required` Executor result is persisted with its `requestId`, expiration and original invocation. A Telegram card shows the action, destination and complete input when reviewable, with **Approve / Deny** buttons. Approving calls the advertised `resume` tool with `{requestId, response: {action: "accept", content: {}}}`; it never resubmits the original program. Denial sends `decline`. Agent tools cannot call `resume` themselves. Native MCP empty-form elicitation is answered on its existing request. Configure Executor in MODEL mode for the requestId/response contract, or NATIVE mode for live elicitation. BROWSER mode (approvalUrl / resume without response) is refused and its private ticket is not shown.

Buttons bind to owner, chat, native topic, conversation, pending ID, immutable payload, credential binding, original delivered message, one-use nonce and expiration. Every review part must be delivered before approval is possible. Concurrent clicks are claimed before I/O. Restart preserves Executor pending requests, but native live elicitation expires because its original transport waiter no longer exists. A crash after a resume claim makes its outcome uncertain; it is never automatically sent again. A second pause always requires a fresh card.

**Supported Telegram approval boundary:** an empty form and a recognized, complete review contract are both required. The current contract is deliberately limited to **direct plain-text email sends**: explicit send-email/send-mail action aliases, or send/send-message/messages-send within a mail/Gmail/Outlook namespace; a flat input with bare email addresses in `to`, optional `cc`/`bcc`, an explicit `subject`, and a nonempty textual `body`. Address fields accept a string of comma-separated addresses or an array. Supported exact aliases are `recipients`, `to_addresses`/`toAddresses`, `cc_addresses`/`ccAddresses`, `bcc_addresses`/`bccAddresses`, and `text`, `body_text`/`bodyText` for body. Duplicate aliases, other field casing and any additional fields are refused.

Draft/message/template IDs, reply/forward/resend operations, wrappers, unknown operations, attachments, raw/MIME/base64/HTML, hidden controls, missing recipients/body, private URL/OAuth/account flows, nonempty forms and oversized/hidden reviews have **no Approve button**. This applies to other MCP operations until a specific review contract is supported. The bot offers denial and the service's existing secure flow; it never looks up a draft, invents missing content, decodes opaque data or reruns the program. NATIVE elicitation from `execute`/`code` wrappers cannot establish the underlying action from its prose: it needs external review. Direct native mail tools with supported arguments can answer their existing waiter; MODEL requests use the structured invocation.

A send is recognized from several signals together, not from one tool name: `send-email` / `send-mail` aliases, `send` / `send-message` / `messages-send` inside a mail, Gmail or Outlook namespace, draft/reply/forward/resend verbs, and top-level identifier fields (`draftId`, `messageId`, `templateId`, `threadId`, `raw`, `mime`, `rfc822`) even when the tool is named something else. A bare `id` counts only together with a mail namespace or one of those verbs, so a calendar event id is not treated as mail. Recognition never grants approval and never fetches or reads the message. When one of those signals is present and the contract is not met, the card keeps only **Negar** and says to review the send in the external service.

Executor invocations are approvable only when their own keys are exactly `app`, `tool` and `input`. A sibling `draftId`, note or any other field is shown and refused, even if `input` is a complete plaintext message. A body that is only a padded base64 token (including a short one such as `SGVsbG8=`) is refused; ordinary short plaintext such as `Hi` stays approvable. Nested objects, unknown field casing and duplicate aliases stay refused. `JSON.parse` keeps the last duplicate key. Address syntax is ASCII; unicode and punycode domains are refused. This client cannot prove that a remote server sends only the reviewed fields, and it does not decode opaque content to find a hidden message.

Review JSON is displayed literally, including Markdown, links and backticks. The same contract is checked again on click. Old cards are inert and a new versioned card is queued for a still-pending request without executing/resuming it. Supported names and shapes do not prove a remote server's honesty or verify its external account; use trusted MCP servers. This client cannot force a server to request approval for every side effect.

`/stop` cancels local waiters and aborts in-flight transport. For an already paused Executor it invalidates the local approval and leaves the remote program to expire; it does not imply external rollback. On uncertain outcomes, `/status` keeps the relevant server blocked for that conversation until the owner verifies externally and confirms the observed outcome through the inline verification controls. That confirmation records the owner's declaration and authorizes no retry. If review cannot safely be shown, keep it blocked and inspect the server directly.

## Schedules, persistence and operations

`/crons` creates a schedule with a four-line reply (title, cron/date, IANA timezone, full prompt), then a complete preview and confirmation. The original conversation/chat/user/topic/bot is frozen in both the schedule and admitted occurrence. Other topic selection or configuration cannot redirect it. Removed/revoked/closed destinations fail explicitly without fallback. Already admitted runs may finish after pause/delete; future occurrences are stopped. Schedules do not authorize future external actions: those still follow MCP approvals. Concurrent workers are prevented by the data-directory owner lock and durable occurrence receipts.

### Scheduled runs

Every occurrence is logged for **7 days**: start/end, status (`ok`, `erro`, `silencioso`), a short summary and the MCP tools that completed during the run — plus any whose approval was skipped. The assistant reads it with the `tasks_runs` tool, filtered by schedule and period; the default window is the last 24 hours.

Delivery is the schedule's own Telegram topic. `tasks_edit` can switch a schedule between **origin** (post results in that topic) and **none** (no message at all, side effects only). There is no web destination, and a schedule can never be moved to another chat or topic.

An answer that is empty, whitespace-only, or only `<silent/>` posts nothing and is logged as `silencioso`; the sentinel itself is never sent. Inside a scheduled occurrence, an MCP request for human approval is not awaited: the step is skipped, recorded as `skipped` in the ledger and in the run log, and the run continues. The assistant still never approves or resumes a pending request on its own.

A turn that ends **without an answer** is never silent again: the chat gets the category pi-durable reports (`model_error`, `no_model`, `stale`, `reset`) and the run log keeps the category plus the upstream detail, readable with `tasks_runs`. `/stop` is the exception — a user-initiated abort stays silent. Only the category reaches a chat: raw upstream text is never forwarded, so a provider error can leak neither a secret nor its wording. If you see `model_error` with a compaction detail, check that `LLM_MODELS` declares the model's real limits: without it the conservative discovery defaults (32768 context / 4096 output) leave the automatic compaction almost no room, and its summary fails.

The named volume contains `app.sqlite` and `durable.sqlite` (WAL), histories, topic mappings, preferences, schedules, delivery/approval ledgers. Use one replica. Stop the container before backing up the entire volume. `docker compose down` preserves it; **`down -v` deletes it**. Rebuild with `SOURCE_COMMIT=$(git rev-parse HEAD)` to identify the running version in `/status`.

The process runs as uid 1000 with read-only root filesystem, dropped capabilities and graceful SIGTERM/SIGINT. Health checks use a fresh local heartbeat after successful polling and delivery-loop checks; they make no model/tool calls and do not guarantee every configured MCP is online. Network or Telegram outages are retried with bounded backoff; authentication/conflict/setup failures close the process. Ambiguous Telegram sends are never blindly retried, so a network loss can require manual inspection instead of a duplicate message.

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm run build
npm test
docker compose config --quiet
```

Tests use fake providers, an actual SDK MCP server on loopback, mocked Telegram, temporary SQLite volumes and offline container smoke checks. No real bot, email, paid tools or deployment is needed. See [verification](docs/verification.md) and [secret scanning](docs/secret-scanning.md).
