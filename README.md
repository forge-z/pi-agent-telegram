# Pi-Agent

A personal AI assistant that lives in Telegram: one container, one volume, no web panel. It runs on the [pi.dev](https://pi.dev) harness. Tools come from [Executor](https://executor.sh) and, optionally, [Composio](https://composio.dev).

The repository and container keep the `pi-agent-tg` name so existing volumes and deployments keep working. Renaming the volume is a separate future change. The Compose service stays `pi-agent-tg` and the volume stays `pi_agent_tg_data`.

**Alpha.** This project is still in alpha: expect breaking changes, rough edges, and incomplete features. It is not yet recommended for critical use.

## Install

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
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

Back up the volume before upgrading. The first boot of this release migrates `pending_jobs` by adding columns. SQLite `ALTER TABLE` has no down migration. On startup, leftover `mcp_calls` rows whose id starts with `mcp-stage:` are deleted, and a call left `running` is reclassified (`failed` for a read, `uncertain` for a write). The jobs poller then deletes finished job rows older than 30 days. Open rows stay. There is no rollback of that data: restore the backup if you need the previous volume. The earlier `durable.sqlite` migration to schema 2, from the previous release, still has no rollback either.

Rolling the image back without restoring the backup leaves the ledger on a shape the previous release may not read.

## Notes

- Chat history, credentials, and the ledger are only as private as the volume and the host.
- The assistant has no shell, file, patch, or browser of its own. MCP results are untrusted data.
- Deployment notes: [docs/coolify.md](docs/coolify.md) and [docs/verification.md](docs/verification.md).
- Portuguese: [README.pt-BR.md](README.pt-BR.md).
