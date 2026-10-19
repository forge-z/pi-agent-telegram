# Pi-Agent

A personal AI assistant that lives in Telegram: one container, one volume, no web panel. It runs on the [pi.dev](https://pi.dev) harness and reaches every integration through [Executor](https://executor.sh), one authenticated MCP endpoint.

The repository and container keep the `pi-agent-tg` name so existing volumes and deployments keep working.

## Docker + Telegram + Executor

**Docker** wraps the whole thing: one image, one volume at `/app/data`, read-only root filesystem, no secrets in build arguments. It runs on any VPS with arm64 or amd64, and the state is two SQLite files.

**Telegram** is the only interface — there is no HTTP port to expose. A native topic is a conversation: each one keeps its own history, model and effort. Media arrives as images and voice notes, and the bot answers where it was asked.

**Executor** is the single tool endpoint. It turns any OpenAPI, MCP or GraphQL service into a tool behind one API key, so a mail account, a calendar, a repository or a sandbox appears to the assistant without this app holding those credentials. Every effectful call pauses for an approval card, and the ledger keeps what was decided.

The supported Executor is **v2, the cloud build** (`https://mcp.executor.sh/mcp`). Pi-Agent targets it, and integrations are Executor apps. No version variable is needed: the v1 self-hosted adapter only exists for deployments that still list tools in `ASYNC_JOB_TOOLS`, and it is deprecated (removal 2026-12-31).

## Create the Telegram bot

1. Open **@BotFather** in Telegram, send `/newbot`, pick a name and a username ending in `bot`. It answers with the **token** — that is `TELEGRAM_BOT_TOKEN`.
2. Get your **numeric user id**: send any message to your new bot, then

   ```sh
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"from":{"id":[0-9]*' | head -1
   ```

   That number is `TELEGRAM_ALLOWED_USERS`. (The bot cannot write to you first: press **Start** in the chat.)

3. Optional, for a group: add the bot, then in **@BotFather** `/setprivacy` → **Disable**, otherwise Telegram only delivers commands and mentions. Put the group's negative id in `TELEGRAM_ALLOWED_CHATS`.
4. Optional, for one conversation per topic: turn the group into a **forum** (group settings → Topics). Each topic gets its own history, model and effort; no extra configuration.

The command menu (`/model`, `/thinking`, `/crons`, `/stop`, `/status`, `/reload`, `/help`) is registered by the app itself on start and again on `/status`, so there is no `/setcommands` to do.

## Install

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env      # bot token + your numeric Telegram user ID
docker compose up -d --build
```

Required: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`. Add `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` to give it tools. Everything else is optional and documented in [.env.example](.env.example).

## Configure once

```sh
docker exec -it <container> npm run setup
```

**Run this before the bot is usable.** A fresh container has no provider, so it logs `Configuração inicial ausente` and waits — it stays up and healthy rather than restart-looping, which is what keeps the terminal available. The wizard is what ends that wait. It speaks Portuguese; this is the flow:

```
[1] DeepSeek  [2] Gemini  [3] OpenAI  [4] OpenCode Zen
[5] OpenCode Go  [6] OpenRouter  [7] Outro (OpenAI-compatible)
Provedor [1]: 2
Chave de API (não aparece): █                     ← hidden; validated on the spot
  ✔ chave válida — 63 modelos listados
Modelo (número ou id): 12
Esforço: high
Modelo do chat: lê imagens                        ← the model is asked, not assumed
IMAGEM — Enter mantém o do chat, "-" desativa
Modelo de visão [usa o do chat]:                  ← or "o" for another provider
ÁUDIO — Enter desativa
  [1] OpenAI — whisper-1  [2] Groq  [3] Gemini  [4] Outro
Transcrição [desativada]: 1
Idioma [auto]: pt
Gravar? [y/N] y
Configuração gravada no volume (gemini) — as variáveis LLM_* deixam de ser necessárias.
```

1. **Provider** — a number from the list, an id, or a root URL. "Outro" asks for the URL.
2. **Key** — never echoed, checked against `GET /models` before going further; a wrong key is rejected right there.
3. **Model and effort** — the list is what that provider actually serves, not a guess.
4. **Image** — the chat model is probed; if it reads images, Enter keeps it as is. `o` opens the provider list again (vision on Gemini while the chat runs on DeepSeek), `-` disables.
5. **Audio** — a transcription endpoint, since a chat endpoint cannot transcribe. It warns that the model must accept OGG/Opus.
6. **Confirm** — the choice goes to `meta`, the keys to `credentials`, and the bot starts answering within ten seconds. No restart.

Every step after the first can be skipped with Enter, and `npm run setup` can be run again later: it shows the current values and keeps whatever you do not change. Environment variables still work and win over the stored setup.

## Providers it already knows

`.env` is not the only way in, and the wizard ships with these endpoints:

| Provider     | Endpoint                                                  | Notes                                                      |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| DeepSeek     | `https://api.deepseek.com`                                | `deepseek-flash` reads images; limits and levels are known |
| Gemini       | `https://generativelanguage.googleapis.com/v1beta/openai` | the OpenAI-compatible surface; free tier works             |
| OpenAI       | `https://api.openai.com/v1`                               | also the audio path (`/audio/transcriptions`)              |
| OpenCode Zen | `https://opencode.ai/zen/v1`                              | separate catalogue from Go                                 |
| OpenCode Go  | `https://opencode.ai/zen/go/v1`                           | the key may not be the same                                |
| OpenRouter   | `https://openrouter.ai/api/v1`                            | many models, `:free` variants included                     |
| Other        | any root URL                                              | anything that speaks the OpenAI completion API             |

Audio is configured separately because a chat endpoint does not transcribe: OpenAI, Groq and Gemini are offered with their default model.

## There's an API or MCP for that

Steve Jobs closed the 2010 iPad event with "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). The modern version: before the assistant answers that it cannot do something, check whether an API or an MCP server already does it. Add it in [Executor](https://executor.sh) and it becomes a tool, with an approval card before anything is written.

| Service                                | What it adds                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | an inbox as a tool: receive, reply, send — 3 inboxes and 3,000 emails/month, no card                        |
| [TinyFish](https://www.tinyfish.ai)    | web search and page fetch — free on every plan                                                              |
| [Fish Audio](https://fish.audio)       | speech synthesis the assistant can call ([MCP](https://docs.fish.audio/overview/mcp)) — 8,000 credits/month |
| [Firecrawl](https://www.firecrawl.dev) | crawl a whole site and extract it as clean text                                                             |
| [Browser Use](https://browser-use.com) | a real browser for pages that need clicking, not just reading                                               |
| [Cal.com](https://cal.com)             | scheduling: availability and bookings as tools                                                              |
| [GitHub](https://github.com)           | repositories, issues and pull requests ([official MCP](https://github.com/github/github-mcp-server))        |
| [Freestyle](https://www.freestyle.sh)  | a disposable sandbox with Docker and GPU when a job needs a machine                                         |

Roughly in the order a personal assistant needs them: mail, web, voice, then scraping, browsing, calendar, code and compute. Voice here means the _agent_ producing audio as a tool result: the bot still answers in text, and a Telegram voice bubble is not implemented.

## What it does

- **Text** — the default; no prefix, no ceremony.
- **Images** — a model that reads them receives the picture itself; a text-only model gets a description from `VISION_MODEL`.
- **Voice notes** — transcribed into the turn text; the audio never enters the model context or the history.
- **Origin is explicit** — a converted message arrives as `[áudio transcrito · {"origin":"audio","model":"whisper-1"}]`, so the model never confuses a transcription with something you typed. A failed transcription is admitted with the reason instead of disappearing.
- **Schedules** — create a cron in the chat; scheduled runs never approve anything and never create new schedules. Any schedule can also be fired on demand — **Rodar agora** in `/crons`, or `tasks_run_now` for the model — through the same pipeline and the same delivery, without moving the next run.
- **Async jobs by manifest** — each job declares how it is dispatched, watched and read; the core only knows state, queue, dedupe and delivery. The official Executor path is built in and needs no configuration. `ASYNC_JOB_TOOLS` (v1) still works and is deprecated (removal 2026-12-31). Reference: [docs/jobs.md](docs/jobs.md).
- **Container clock** — `TZ` (e.g. `America/Sao_Paulo`) moves log timestamps only; schedules keep their own IANA timezone and never shift.
- **Approvals** — every effectful tool call becomes a card with Approve, Deny and Edit; the result is recorded before it is delivered.

## Commands

| Command     | What it does                                                       |
| ----------- | ------------------------------------------------------------------ |
| `/status`   | the three models in use, effort, MCP servers and version           |
| `/reload`   | start a new conversation in this chat; the old history stays saved |
| `/model`    | provider and model for this conversation                           |
| `/thinking` | effort for this conversation                                       |
| `/crons`    | create and manage schedules                                        |
| `/stop`     | cancel what is running in this topic                               |
| `/help`     | the same list, in the chat                                         |

## Limits worth knowing

- A **transcription model must accept OGG/Opus** — it is the only format Telegram sends for a voice note. `whisper-1`, Gemini and Groq do; the `gpt-4o-transcribe` family does not list it.
- **Discovery reports ids only**. Without `LLM_MODELS`, every model claims no reasoning and `/thinking` offers `off` alone.
- **Compaction** summarises older turns automatically, so a long conversation does not grow forever.
- Chat history, credentials and the ledger are only as private as the volume and the host: protect the volume and its backups.

## Projects

| Project          | Site                                                    | Source                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pi.dev           | [pi.dev](https://pi.dev)                                | [earendil-works/pi](https://github.com/earendil-works/pi)                           |
| pi-durable       | the harness this app runs on                            | [packages/durable](https://github.com/earendil-works/pi/tree/main/packages/durable) |
| Executor         | [executor.sh](https://executor.sh)                      | [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor)           |
| Telegram Bot API | [core.telegram.org](https://core.telegram.org/bots/api) | —                                                                                   |
| Pi-Agent         | this project                                            | [forge-z/pi-agent-telegram](https://github.com/forge-z/pi-agent-telegram)           |

Deployment notes for Coolify and a plain VPS live in [docs/coolify.md](docs/coolify.md) and [docs/verification.md](docs/verification.md).
