# Pi Agent TG — Telegram + Docker Compose

[Português](README.pt-BR.md). This repository is a small, Telegram-only deployment around pinned `@earendil-works/pi-durable` / `pi-ai` **1.3.0**, Node 24 and SQLite. There is no web server, web chat, login page, local browser or subscription OAuth login. The bot uses long polling; no public port, domain, reverse proxy or webhook is needed.

**Pi Agent is an AI assistant, not a coding agent.** It ships no file, shell, patch, repository or browser tools, and it has no notion of the host, the volume or the source tree. Beyond conversation and the built-in schedule tools, its only capabilities are the MCP servers the operator exposes. If nothing is exposed, it can talk and schedule and do nothing else. Treat everything coming back from MCP as untrusted external data.

It is built around [Executor](https://executor.sh): the preferred way to expose every MCP server behind one authenticated endpoint, so a single `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` covers the whole tool surface. It runs on [pi.dev](https://pi.dev) with the pinned [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) harness.

## Install on an Oracle VM

Use Docker Engine and Compose v2.24+ on Linux amd64 or arm64. The official `node:24-bookworm-slim` image has both architectures. Runtime persistence uses built-in `node:sqlite`, with no application-specific native binary. Local verification covers amd64; arm64 execution was not exercised here.

```sh
git clone https://github.com/forge-z/pi-agent-tg.git
cd pi-agent-tg
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

## First start: run the setup wizard

**Only two variables are required to boot:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`. Everything else — provider, endpoint, API key, model, thinking level, vision and audio backends — is chosen once in the terminal and stored in the volume.

```sh
# while the container is up (it stays up, waiting, when nothing is configured yet)
docker exec -it <container> npm run setup
# with plain compose, before the first start:
docker compose run --rm pi-agent-tg npm run setup
```

The bot does **not** crash without a provider: it logs that setup is missing, keeps the container alive, and starts answering by itself a few seconds after the wizard finishes — no restart needed.

What the wizard stores: the provider id, endpoint, model, effort and the optional vision/audio models in `meta` (`setup:live`), and the API key in the `credentials` table — the same place pi-ai already reads credentials from. `LLM_*` / `VISION_*` / `AUDIO_*` keep working as a declarative override and, when present, **win** over the stored record.

## Configuration

Required — the container cannot be a bot without them:

| Variable                 | Meaning                          |
| ------------------------ | -------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | Bot token, server side only      |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated numeric user IDs |

Everything else is optional:

| Group      | How to set it                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Provider   | `npm run setup`. `LLM_*`, `VISION_*`, `AUDIO_*` still work as an override and **win** over it               |
| MCP        | `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN`, or a full list in `MCP_SERVERS_JSON` / `MCP_CONFIG_FILE`             |
| Everything | `TELEGRAM_ALLOWED_CHATS` (groups), `*_FILE` variants for mounted secrets — see [.env.example](.env.example) |

The compose declares only the four variables a working bot needs: the two Telegram ones and the two Executor ones. Anything else reaches the process through `env_file: .env`, so the declaration list does not grow there.

Notes that change behaviour: API keys and tokens accept `NAME_FILE` for an operator-mounted secret (never build arguments — they stay in the image layer); endpoints require HTTPS, HTTP only on loopback for tests; MCP is direct mode with optional `allowedTools` / `deniedTools`; Executor MCP registers only when both variables are set, and a non-empty `MCP_SERVERS_JSON` overrides it. `EXECUTOR_TOKEN` is the raw key — the process adds `Authorization: Bearer` itself. Catalog entries need explicit `contextWindow`, `maxTokens` and `reasoning` in `LLM_MODELS`, because `GET /models` reports neither.

## Vision and audio (optional)

Neither is required. A multimodal chat model and no extra variables is the default: images go straight to it, and a voice note answers with a short note saying audio is not configured.

| Chat model                       | `VISION_MODEL` | What happens to an image                                           |
| -------------------------------- | -------------- | ------------------------------------------------------------------ |
| reads images (`LLM_INPUT` unset) | unset          | sent as an image part (cheapest, full fidelity)                    |
| reads images                     | set            | still an image part; `VISION_MODE=text` forces the auxiliary model |
| text only (`LLM_INPUT=text`)     | set            | described by that model, admitted as text                          |
| text only                        | unset          | the bot explains the model cannot read images                      |

Audio is always text: `pi-ai` has no audio content part, so the voice note is transcribed and **the transcription becomes the turn text**. The audio never enters the model context or the conversation history.

Every converted message tells the chat model where it came from, in the text it reads:

```
[áudio transcrito · {"origin":"audio","model":"whisper-1"}]
reunião sexta às dez
[imagem: descrição automática · {"origin":"image","model":"gemini-3-flash"}]
um gráfico de vendas
```

Typed text has no prefix. The transcription reaches the model verbatim. When a specialist fails, the message is still admitted, carrying the origin and the reason (`{"origin":"audio","error":"resposta 500"}`), so the model answers the user instead of staying silent.

**The audio model must accept OGG/Opus.** That is the only format Telegram uses for a voice note. `whisper-1`, Gemini and Groq read it as-is; the `gpt-4o-transcribe` family does not list `ogg` and will fail, because converting would need ffmpeg in the image. The failure is answered in the chat, not silently.

```sh
# vision only, same provider as chat (empty key/endpoint inherit the chat ones)
VISION_MODEL=<vision-capable model>
# vision on another provider: Gemini's OpenAI-compatible surface
VISION_MODEL=gemini-3-flash
VISION_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
VISION_API_KEY=<gemini key>
# audio via OpenAI-compatible multipart
AUDIO_MODEL=whisper-1
AUDIO_API_KEY=sk-...
# audio via Gemini (inline base64 JSON instead of multipart)
AUDIO_MODEL=gemini-3-flash
AUDIO_API=gemini
```

An empty `VISION_API_KEY` / `AUDIO_API_KEY` inherits `LLM_API_KEY` **only when the endpoint is the same host** as the chat one (Groq serves chat and audio this way); for any other host, set the key explicitly, otherwise the function stays off instead of failing with a confusing 401.

Choose the models in the terminal with `npm run setup-model` (the menu offers chat, image and audio); keys stay in the environment and are never written to the database or shown on screen.

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

A photo — or a document whose type is an image — arrives as an **image part of the model input**: the model reads it directly, and the caption becomes the turn text (`[imagem]` when there is none). Our own 5 MB bound applies on top of Telegram's download cap; anything larger, and any other attachment type (audio, PDF), gets a short refusal in the chat instead of silence. The ledger and the deduplication key stay textual, so a redelivered update is still deduplicated, and the image never leaves your infrastructure.

A voice note is transcribed and **the transcription becomes the turn text** — the audio itself never enters the model context. Transcription runs in the Executor's sandbox, against whichever integration exposes a `transcribe` tool (today Gemini, because it takes base64 inside JSON); no provider credential lives in this app. Notes up to 10 MB are accepted, and a failed transcription answers in the chat instead of admitting an empty turn.

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
