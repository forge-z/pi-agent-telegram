# Pi-Agent

A personal AI assistant that lives in Telegram: one container, one volume, no web panel. It runs on the [pi.dev](https://pi.dev) harness and reaches every integration through [Executor](https://executor.sh), one authenticated MCP endpoint.

The repository and container keep the `pi-agent-tg` name so existing volumes and deployments keep working.

## Docker + Telegram + Executor

**Docker** wraps the whole thing: one image, one volume at `/app/data`, read-only root filesystem, no secrets in build arguments. It runs on any VPS with arm64 or amd64, and the state is two SQLite files.

**Telegram** is the only interface — there is no HTTP port to expose. A native topic is a conversation: each one keeps its own history, model and effort. Media arrives as images and voice notes, and the bot answers where it was asked.

**Executor** is the single tool endpoint. It turns any OpenAPI, MCP or GraphQL service into a tool behind one API key, so a mail account, a calendar, a repository or a sandbox appears to the assistant without this app holding those credentials. Every effectful call pauses for an approval card, and the ledger keeps what was decided.

The supported Executor is **v2, the cloud build** (`https://mcp.executor.sh/mcp`). Pi-Agent targets it, and integrations are Executor apps. Jobs are manifests (`ASYNC_JOB_MANIFESTS`) or the built-in TinyFish and Instabox ones. The read account comes from the dispatch. `ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID` are not read.

## Create the Telegram bot

1. Open **@BotFather** in Telegram, send `/newbot`, pick a name and a username ending in `bot`. It answers with the **token** — that is `TELEGRAM_BOT_TOKEN`.
2. Get your **numeric user id**: send any message to your new bot, then

   ```sh
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"from":{"id":[0-9]*' | head -1
   ```

   That number is `TELEGRAM_ALLOWED_USERS`. (The bot cannot write to you first: press **Start** in the chat.)

3. Optional, for a group: add the bot, then in **@BotFather** `/setprivacy` → **Disable**, otherwise Telegram only delivers commands and mentions. Put the group's negative id in `TELEGRAM_ALLOWED_CHATS`.
4. Optional, for one conversation per topic: turn the group into a **forum** (group settings → Topics). Each topic gets its own history, model and effort; no extra configuration.

The command menu (`/model`, `/thinking`, `/crons`, `/stop`, `/status`, `/reload`, `/new`, `/resume`, `/help`) is registered by the app itself on start and again on `/status`, so there is no `/setcommands` to do. `/retomar` still resumes a parked task, and `/destravar` still clears an uncertain MCP result; neither is on the menu.

## Install

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env      # bot token + your numeric Telegram user ID
docker compose up -d --build
```

Required: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`. Add `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` to give it tools. Everything else is optional and documented in [.env.example](.env.example).

That Executor pair registers one **direct** server (the default, also when `mode` is omitted). Its tools — search, describe, call, execute, resume, skills — stay in the prompt with full schemas, and an effectful call still pauses on the approval card ("Aprovação MCP pendente"). A large MCP beside it can set `"mode": "deferred"` so its schemas stay hidden until the model calls `tool_search`. Names in `alwaysLoad` stay direct. `allowedTools` and `deniedTools` apply in both modes. Executor itself stays direct:

```json
[
  {
    "name": "executor",
    "url": "https://executor.example/mcp",
    "tokenEnv": "EXECUTOR_TOKEN"
  },
  {
    "name": "github",
    "url": "https://github.example/mcp",
    "tokenEnv": "GH_TOKEN",
    "mode": "deferred",
    "alwaysLoad": ["search_code"]
  }
]
```

## Configure once

```sh
docker exec -it <container> npm run setup
```

**Run this before the bot is usable.** A fresh container has no provider, so it logs `Configuração inicial ausente` and waits — it stays up and healthy rather than restart-looping, which is what keeps the terminal available. The wizard is what ends that wait. It speaks Portuguese; this is the flow:

```
[0] ChatGPT (assinatura Plus/Pro — OAuth, sem chave de API)
[1] Anthropic — catálogo oficial
…
[n] Outro (OpenAI-compatible) — reserva opcional
Provedor [1]: anthropic
Chave de API (não aparece): █                     ← hidden; never printed
Modelo (número ou id): 3
Esforço: high
Modelo do chat: lê imagens (catálogo pi-ai)
…
Configuração gravada no volume (anthropic) — chave em credentials com esse id.
```

1. **Provider** — `[0]` is the ChatGPT subscription (same login as `npm run login`). The numbered rows are official pi-ai providers (API key). The last row, **Outro**, is the optional OpenAI-compatible reserve.
2. **Key** — never echoed. Official providers store it under the provider id (`anthropic`, `openai`, `google`, …). The compat reserve is the only path that calls `GET /models`.
3. **Model and effort** — the official catalog: native API, context window, reasoning levels and prices. `/model` lists `provider/modelId` and only switches; it never asks for a key or a login.
4. **Image** — taken from the catalog for an official model. `o` can still point vision at another OpenAI-compatible endpoint, `-` disables.
5. **Audio** — a transcription endpoint, since a chat endpoint cannot transcribe. It warns that the model must accept OGG/Opus.
6. **Confirm** — the choice goes to `meta`, the key to `credentials`, and the bot starts answering within ten seconds. No restart. `LLM_BASE_URL` and `LLM_API_KEY` are not required.

`npm run setup` can be run again later. A complete official setup is not replaced by leftover `LLM_BASE_URL` / `LLM_API_KEY`. Those two variables only apply to the compat reserve, and only when no official setup is stored.

## ChatGPT subscription (no API key)

Start the container and run `docker exec -it <container> npm run login` once (or pick `[0]` in `npm run setup`). Tokens are stored in the volume SQLite (`credentials` table) with automatic refresh via pi-ai. Use `/model` to pick `openai` (Sign in with ChatGPT) or `openai-codex` (legacy Codex; `npm run login -- openai-codex --device-code` for headless VPS). See [README.pt-BR.md](README.pt-BR.md) for the full walkthrough. There is no `/login` Telegram command: OAuth needs a localhost callback or pasted redirect URL, not a link-only flow. `LLM_AUTH=chatgpt` is optional; the volume record is enough.

`npm run setup` is the full wizard, including vision and audio. `npm run login` is OAuth only (and the headless Codex device-code path). Both write the volume. There is no third command. When login finds no model yet, it stores the first catalog model; `/model` changes it. Anthropic here is an API key, not a Claude subscription login.

## Providers

The wizard lists every pi-ai provider that accepts a single API key (Anthropic, OpenAI, Google, Groq, xAI, DeepSeek, Mistral, OpenRouter, OpenCode Zen, OpenCode Go, and the rest of that catalog). Each one uses the library's native API, context window, reasoning levels and prices. The menu is generated from the installed `@earendil-works/pi-ai` catalog, not from a second list in this repo.

| Path             | What it is                                                                           |
| ---------------- | ------------------------------------------------------------------------------------ |
| Official API key | `npm run setup`, key stored as `credentials.provider = <pi-ai id>`                   |
| ChatGPT / Codex  | `npm run login` or setup `[0]`, providers `openai` and `openai-codex`                |
| Outro            | optional OpenAI-compatible reserve (`llm`) for a proxy or a host pi-ai does not ship |

Audio is configured separately because a chat endpoint does not transcribe: OpenAI, Groq and Gemini are offered with their default model.

An existing volume that still has `credentials.provider = 'llm'` keeps working. On the next start, if `LLM_BASE_URL` / `LLM_API_KEY` are unset and the saved model exists in the native catalog, the key is copied onto that provider. If the model is not in the catalog, the bot stays on the compat endpoint.

## There's an API or MCP for that

Steve Jobs closed the 2010 iPad event with "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). The modern version: before the assistant answers that it cannot do something, check whether an API or an MCP server already does it. Add it in [Executor](https://executor.sh) and it becomes a tool, with an approval card before anything is written.

| Service                                | What it adds                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | an inbox as a tool: receive, reply, send — 3 inboxes and 3,000 emails/month, no card                                                    |
| [Browser Use](https://browser-use.com) | a real browser for pages that need clicking, not just reading                                                                           |
| [Cal.com](https://cal.com)             | scheduling: availability and bookings as tools                                                                                          |
| [Firecrawl](https://www.firecrawl.dev) | crawl a whole site and extract it as clean text                                                                                         |
| [Fish Audio](https://fish.audio)       | speech synthesis the assistant can call ([MCP](https://docs.fish.audio/overview/mcp)) — 8,000 credits/month                             |
| [GitHub](https://github.com)           | repositories, issues and pull requests ([official MCP](https://github.com/github/github-mcp-server))                                    |
| [Instabox](https://instabox.sh)        | a Linux sandbox as a tool: real shell, browser and persistent disk — run code, build and publish artifacts; 5 machines on the free plan |
| [TinyFish](https://www.tinyfish.ai)    | web search and page fetch — free on every plan                                                                                          |

Roughly in the order a personal assistant needs them: mail, web, voice, then scraping, browsing, calendar, code and compute. Voice here means the _agent_ producing audio as a tool result: the bot still answers in text, and a Telegram voice bubble is not implemented.

## What it does

- **Text** — the default; no prefix, no ceremony.
- **Automatic steer** — messages sent while a turn is in progress are injected as steer (after the current tool round) without opening a new turn; /stop cancels.
- **Images** — a model that reads them receives the picture itself; a text-only model gets a description from `VISION_MODEL`.
- **Voice notes** — transcribed into the turn text; the audio never enters the model context or the history.
- **Origin is explicit** — a converted message arrives as `[áudio transcrito · {"origin":"audio","model":"whisper-1"}]`, so the model never confuses a transcription with something you typed. A failed transcription is admitted with the reason instead of disappearing.
- **Schedules** — create a cron in the chat; scheduled runs never approve anything and never create new schedules. Any schedule can also be fired on demand — **Rodar agora** in `/crons`, or `tasks_run_now` for the model — through the same pipeline and the same delivery, without moving the next run. A run that is not an interactive user turn does not deliver its final text. It speaks only by calling `notify`, which posts to that schedule's chat and topic and may be called more than once. Text that is empty once spaces and invisible characters are removed is refused. `replyTo` is a `message_id` already seen in that same chat; if it cannot be confirmed, the reply is ignored and the notice still posts in the topic. Recent ids are in the run's context. If there is nothing to report, the model calls nothing: the run stays `silencioso` and the final text is written to the log with the routine id. Runner failures (exception, timeout, provider error, a parked task, a job error) are still announced by the system, with the cause, and do not depend on the model. `delivery: none` still sends nothing.
- **Telegram replies** — when a message replies to another one, and when it quotes a passage, the turn receives the id, the author (bot or user) and the text or caption, truncated when long.
- **Async jobs by manifest** — each job declares how it is dispatched, watched and read; the core only knows state, queue, dedupe and delivery. The official Executor path is built in and needs no configuration. Sandbox code tasks on Instabox (`instabox_code_task`) run agents in the background and report via status polling. Reference: [docs/jobs.md](docs/jobs.md).
- **Container clock** — `TZ` (e.g. `America/Sao_Paulo`) moves log timestamps only; schedules keep their own IANA timezone and never shift.
- **Approvals** — every effectful tool call becomes a card with Approve, Deny and Edit; the result is recorded before it is delivered.

## Commands

| Command     | What it does                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- |
| `/status`   | the three models in use, effort, MCP servers (error, tool count and names) and version        |
| `/reload`   | dismiss uncertain MCP results in this conversation (history kept). `/destravar` is the same   |
| `/new`      | start another conversation in this topic; the previous one stays on disk. `/nova` is the same |
| `/resume`   | run again a task parked after repeated crashes. `/retomar` is the same                        |
| `/model`    | provider and model for this conversation                                                      |
| `/thinking` | effort for this conversation                                                                  |
| `/crons`    | create and manage schedules                                                                   |
| `/stop`     | cancel what is running in this topic                                                          |
| `/help`     | the same list, in the chat                                                                    |

## Limits worth knowing

- A **transcription model must accept OGG/Opus** — it is the only format Telegram sends for a voice note. `whisper-1`, Gemini and Groq do; the `gpt-4o-transcribe` family does not list it.
- **The compat reserve reports ids only**. Without `LLM_MODELS`, a model on provider `llm` claims no reasoning and `/thinking` offers `off` alone. Official providers already declare their levels.
- **Compaction** summarises older turns automatically, so a long conversation does not grow forever.
- Chat history, credentials and the ledger are only as private as the volume and the host: protect the volume and its backups.
- **Upgrade from Pi 1.3.** The first boot migrates `durable.sqlite` to schema 2, and that migration has no rollback. Back up the volume before deploying. Rolling the image back without restoring that backup leaves the ledger on a schema the previous release does not read. This release does not add another migration.

## Projects

| Project          | Site                                                    | Source                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pi.dev           | [pi.dev](https://pi.dev)                                | [earendil-works/pi](https://github.com/earendil-works/pi)                           |
| pi-durable       | the harness this app runs on                            | [packages/durable](https://github.com/earendil-works/pi/tree/main/packages/durable) |
| Executor         | [executor.sh](https://executor.sh)                      | [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor)           |
| Telegram Bot API | [core.telegram.org](https://core.telegram.org/bots/api) | —                                                                                   |
| Pi-Agent         | this project                                            | [forge-z/pi-agent-telegram](https://github.com/forge-z/pi-agent-telegram)           |

Deployment notes for Coolify and a plain VPS live in [docs/coolify.md](docs/coolify.md) and [docs/verification.md](docs/verification.md).
