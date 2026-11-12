<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/c-wordmark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo/c-wordmark-on-light.svg">
    <img alt="Pi Bot" src="assets/logo/c-wordmark-on-light.svg" width="360">
  </picture>
</p>

# Pi Bot

A personal AI assistant that lives in Telegram: one container, one volume, no web panel. It runs on the [pi.dev](https://pi.dev) harness. Tools come from [Executor](https://executor.sh) and, optionally, [Composio](https://composio.dev).

**Alpha.** This project is still in alpha: expect breaking changes, rough edges, and incomplete features. It is not yet recommended for critical use.

## Install

```sh
git clone https://github.com/forge-z/pi-bot.git
cd pi-bot
cp .env.example .env
docker compose up -d --build
```

No environment variable is required to boot. The image is read-only except for the volume at `/app/data` (`app.sqlite` and `durable.sqlite`).

## Configure

Run setup in the container before the bot is usable. A fresh container stays up and healthy while it waits.

```sh
docker exec -it <container> npm run setup
```

The menu edits one section at a time. **Save and back** writes that section. **Save and restart gateway** reloads the running bot from the volume.

1. **Setup gateway** → **Telegram** — bot token (hidden; Enter keeps the saved value) and allowed numeric user ids.
2. **Text model** — an official pi-ai provider, or `[0]` ChatGPT (Plus/Pro OAuth, no API key). `npm run login` is OAuth only.
3. **Image model**
4. **Audio model**
5. **MCP platform** — Executor, Composio, both, or none.

There is no `/login` command. OAuth needs a localhost callback or a pasted redirect URL.

Environment variables are optional overrides. When one is set, it wins over the value stored on the volume. `TZ` is the container clock (log timestamps). Schedules keep their own IANA timezone. Setup does not store `TZ`. Omit it for UTC.

Group and topic ids (`TELEGRAM_ALLOWED_CHATS`) stay environment-only. The compat reserve (`LLM_BASE_URL` / `LLM_API_KEY`, menu **Other**) is ignored when an official setup is already on the volume.

### Sandbox

The long-running code task is `sandbox_code_task` (Instabox by default). It is off until the operator configures it. Nothing in the shipped config names a machine, an account, or a repository.

- `INSTABOX_ACCOUNT_ID` and `INSTABOX_MACHINE_ID` are optional. When unset, discovery uses an account only when exactly one is linked, and a machine only when exactly one is running. Zero or several is an error that lists them. There is no default machine name.
- `INSTABOX_REPO_ALLOWLIST` (or `sandbox_code_task.allow.patterns` in `$DATA_DIR/config.yaml`) is the repository allowlist. It is empty by default, so no repository is allowed until you set it. `owner/*` matches that owner. A set environment variable wins over the file.

`writes=true` (push, pull request, or comment) waits for an approval card. Without it the task is read-only.

[Freestyle](https://freestyle.sh) is another hosted Linux VM sandbox ([docs](https://www.freestyle.sh/docs), [quickstart](https://www.freestyle.sh/docs/quickstart)). This feature does not use it. The shipped `sandbox_code_task` block, the `INSTABOX_*` variables, discovery, and `scripts/instabox/` target Instabox. Freestyle's current docs describe an API and a CLI for those VMs. They do not publish an MCP that runs the VMs, so an entry in the MCP list does not switch the code task to Freestyle.

### Operator skills

Optional instructions on the volume apply to every reply, including scheduled runs. Each skill is a folder, for example `$DATA_DIR/skills/weekly-review/SKILL.md`:

```md
---
name: weekly-review
description: What to check in a weekly review
---

List what is still open from the week and what can wait.
```

Name the folders in `$DATA_DIR/config.yaml`. The list replaces the default empty list:

```yaml
skills:
  always:
    - weekly-review
```

Each body is read once at startup and appended, in that order, to the system prompt after the base instructions and before the MCP sections. An empty list, or a skills folder that is not there, leaves the prompt unchanged. A missing name, invalid frontmatter, or an unreadable file is logged and skipped. The bot still starts.

## There's an API or MCP for that

Steve Jobs closed the 2010 iPad event with "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). Before adding a capability to the bot, connect an API or an MCP server that already does the job.

`npm run setup` attaches [Executor](https://executor.sh), [Composio](https://composio.dev), both, or neither, and stores the choice on the volume. Further servers go in an MCP list: a JSON file named by `MCP_CONFIG_FILE`, or the same JSON in `MCP_SERVERS_JSON`. That list replaces the aggregators that setup saved, so repeat Executor or Composio in it when you still want them. Each entry has `name`, `url`, and, when the server needs a key, `tokenEnv` (the environment variable that holds the raw key). Leave the key out of the file. The bot sends `Authorization: Bearer <key>` unless `tokenHeader` names another header. The env value is the raw key, with no `Bearer` prefix. A URL with a query string is rejected, so use the bare endpoint even when a provider's docs show `?login` or `?tools=`. Naming a `tokenEnv` variable that is unset stops startup. A write still waits for an approval card.

`$DATA_DIR/config.yaml` does not connect servers. Its `mcp_servers` map only classifies tools as read or write. A server with no `tools` list of its own uses the executor globs in `config.default.yaml`.

| Service                                | What it adds                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | an inbox as a tool: receive, reply, send                                                                                                           |
| [Browser Use](https://browser-use.com) | a real browser for pages that need clicking, not just reading                                                                                      |
| [Cal.com](https://cal.com)             | scheduling: availability and bookings as tools                                                                                                     |
| [Exa](https://exa.ai)                  | web search and content extraction. Hosted MCP `https://mcp.exa.ai/mcp` ([docs](https://exa.ai/docs/get-started/exa-mcp)). Key header: `x-api-key`  |
| [Firecrawl](https://www.firecrawl.dev) | crawl a whole site and extract it as clean text                                                                                                    |
| [Fish Audio](https://fish.audio)       | speech synthesis the assistant can call ([MCP](https://docs.fish.audio/overview/mcp))                                                              |
| [GitHub](https://github.com)           | repositories, issues and pull requests ([official MCP](https://github.com/github/github-mcp-server))                                               |
| [Instabox](https://instabox.sh)        | a Linux sandbox as a tool: real shell, browser and persistent disk — run code, build and publish artifacts                                         |
| [Parallel](https://parallel.ai)        | web search, page extraction, and research. Hosted MCP `https://mcp.parallel.ai/mcp` ([docs](https://docs.parallel.ai/integrations/mcp/quickstart)) |
| [TinyFish](https://www.tinyfish.ai)    | web search and page fetch                                                                                                                          |

A personal assistant usually needs them in this order: mail, web, voice, then scraping, browsing, calendar, code and compute. Voice here means the agent producing audio as a tool result: the bot still answers in text, and a Telegram voice bubble is not implemented.

Exa and Parallel use the same list as Executor and Composio. Point `MCP_CONFIG_FILE` at a file on the volume (for example `/app/data/mcp.json`) and set `EXA_API_KEY` and `PARALLEL_API_KEY` in the environment. Those names are placeholders for your own keys:

```json
[
  {
    "name": "exa",
    "url": "https://mcp.exa.ai/mcp",
    "tokenEnv": "EXA_API_KEY",
    "tokenHeader": "x-api-key"
  },
  {
    "name": "parallel",
    "url": "https://mcp.parallel.ai/mcp",
    "tokenEnv": "PARALLEL_API_KEY"
  }
]
```

Exa documents the key in `x-api-key` ([MCP docs](https://exa.ai/docs/get-started/exa-mcp)). Parallel accepts `Authorization: Bearer` (omit `tokenHeader`) or `x-api-key` ([MCP docs](https://docs.parallel.ai/integrations/mcp/quickstart), [programmatic use](https://docs.parallel.ai/integrations/mcp/programmatic-use)). With a key, Exa also lists `agent_run` and Parallel also lists `web_research`. Without `tokenEnv`, both stay on keyless search and fetch.

Executor and Composio use those same fields. The Executor v2 cloud URL in [docs/jobs.md](docs/jobs.md) is `https://mcp.executor.sh/mcp` with `tokenEnv` set to `EXECUTOR_TOKEN`. Composio Connect is `https://connect.composio.dev/mcp` with `tokenEnv` set to `COMPOSIO_API_KEY` and `tokenHeader` set to `x-consumer-api-key`. Repeat the URL that `npm run setup` stored when it is different. Other Composio MCP hosts use `x-api-key` and a `userId`.

## Commands

The app registers this menu on start. There is nothing to set in BotFather.

| Command     | What it does                                                             |
| ----------- | ------------------------------------------------------------------------ |
| `/model`    | Provider and model for this topic                                        |
| `/thinking` | Effort for this topic                                                    |
| `/crons`    | Create and manage schedules                                              |
| `/new`      | Another conversation in this topic. The previous one stays on the volume |
| `/resume`   | Resume a stuck task: a crash-parked task, or an uncertain MCP result     |
| `/stop`     | Stop this topic                                                          |
| `/status`   | Model, MCPs, the current run, and the version                            |
| `/help`     | This list                                                                |

`/resume` dismisses an uncertain MCP result without repeating the call (the call may already have run) and continues a task that was parked after a crash. `/new` does not clear an uncertain result.

Each native topic (a forum topic) has its own history, model, and effort.

## Upgrade

### Upgrading from pi-agent-tg

The Compose service is `pi-bot` and the named volume is `pi_bot_data`, still mounted at `/app/data`. A renamed volume is a new empty volume. To keep data, stop the container, copy the old volume into the new one, then deploy and check `/status`. Keep the old volume as a backup for a few days.

```sh
docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/
```

`old` is the existing `pi_agent_tg_data` volume and `new` is `pi_bot_data`. Use the names from `docker volume ls` when Compose has prefixed them with the project name.

Back up the volume before upgrading. The first boot of this release migrates `pending_jobs` by adding columns. SQLite `ALTER TABLE` has no down migration. On startup, leftover `mcp_calls` rows whose id starts with `mcp-stage:` are deleted, and a call left `running` is reclassified (`failed` for a read, `uncertain` for a write). The jobs poller then deletes finished job rows older than 30 days. Open rows stay. There is no rollback of that data: restore the backup if you need the previous volume. The earlier `durable.sqlite` migration to schema 2, from the previous release, still has no rollback either.

Rolling the image back without restoring the backup leaves the ledger on a shape the previous release may not read.

## Notes

- Chat history, credentials, and the ledger are only as private as the volume and the host.
- The assistant has no shell, file, patch, or browser of its own. MCP results are untrusted data.
- Deployment notes: [docs/coolify.md](docs/coolify.md) and [docs/verification.md](docs/verification.md).
- Portuguese: [README.pt-BR.md](README.pt-BR.md).
