# Pi-Agent verification

Validation on 2026-10-15, in an isolated worktree and temporary test volumes. No deployment, real Telegram request, email, paid model/tool call, webhook change or production data was involved.

## Automated checks

- `npm ci` with the committed lockfile; Pi durable/AI/chord are pinned to 1.3.0 (aligned with [packages/durable](https://github.com/earendil-works/pi/tree/main/packages/durable) on Pi `main`).
- Internal `defineTool` handlers return model text via `output`, not `content`, per pi-durable 1.2+.
- `npm run check`, `npm run lint`, `npm run build`, `npm run format:check` and `git diff --check` pass.
- `npm test`: **272 passed, 0 failed**, with concurrency limited to 2.
- `node --import tsx --test --test-concurrency=2 test/clean*.test.ts test/telegram-approval-review.test.ts`: **30 passed** in the focused clean flow/protocol/lifecycle/compaction suites; these are also included in the full suite.
- `docker compose config --quiet` passes without runtime credentials or exposed ports.

The retained tests exercise durable admission, recovery, task occurrences, conversation isolation, delivery authorization and MCP ledgers. Tests specific to the removed web UI/server, login and topic mirroring were removed together with those surfaces.

## Behavior covered

- Native negative-ID supergroups, private routing, same topic IDs in different chats, multiple allowlisted users, first-use mapping and persisted conversation/model/effort after restart. A changed bootstrap model does not replace a saved selection.
- Telegram model/provider/effort menus and cron create/edit/pause/delete confirmation. Cron creation is idempotent; destination snapshots survive restart and selection changes. Refused, removed or revoked destinations never fall back to another chat/topic. Incomplete or copied creation confirmations are refused.
- Executor `requestId`/`response` wire contract through an actual local MCP SDK HTTP server; no source-program replay. Native elicitation waits on the real request, validates the schema and settles once.
- Approval/denial, expiration, wrong user/topic/message, replay, concurrent opposite clicks, a second pause, restart before decision, crash after the durable decision claim, direct-resume bypass prevention and `/stop` isolation. All card parts and the original message receipt are required. Sensitive/oversized inputs cannot be approved. Private BROWSER tickets are removed before returning a result to the model.
- Busy/unavailable/capacity/failed/legacy malformed Executor outcomes fail closed. Uncertain outcomes remain blocked until explicit owner verification through `/status`, which records a declaration and never repeats the action.
- Custom environment key names, MCP token files and escaped credential values are redacted. Startup/polling failures and shutdown during setup are exercised without a bot connection.
- Real automatic compaction in the installed harness, driven by a faux provider and sufficient history. The summary uses the active conversation model and effort, original durable entries remain and another topic stays isolated. Production does not override upstream compaction thresholds.

## Container and architecture

The Docker image uses `node:24-bookworm-slim`, uid 1000, built-in `node:sqlite`, no web assets/server, and a local heartbeat health check. Compose uses a new named volume, read-only root filesystem, dropped capabilities, no public ports and graceful shutdown. The reproducible offline container check is `scripts/smoke-container.sh IMAGE`; it mocks Telegram in-process and disables container networking, exercises two startups with the same test volume, checks heartbeat, one persisted native conversation, credential-free logs and successful SIGTERM.

The upstream Node image manifest was inspected and includes `linux/amd64` and `linux/arm64/v8`. Runtime dependencies have no application-specific fixed-architecture native SQLite binary. Build and runtime smoke are validated on **amd64**. This builder has no ARM emulator, so **ARM64 execution is not claimed**; validate on the intended Oracle ARM VM before relying on it operationally.

This execution environment's BuildKit needed its proxy hostname mapped with `--add-host`, predefined HTTP(S) proxy build arguments and the optional `npm_ca` BuildKit secret. The CA is mounted only for dependency installation, never copied into the image. Normal Docker builds require neither these environment-specific options nor runtime credentials.

## Explicit limits

Telegram approval requires an empty form plus a recognized direct plaintext email contract. Explicit destinations/subject/body are required. Send attempts are recognized from several signals at once — send-email/send-mail aliases, mail-namespace send verbs, draft/reply/forward/resend verbs, and top-level identifier fields — not from one tool name. A bare `id` counts only with a mail namespace or those verbs. Recognition never authorizes the send. Identifier-only, nested, raw, short padded-base64 and unknown shapes have no Approve button and tell the owner to review the send in the external service. An Executor invocation is approvable only when its own keys are exactly `app`, `tool` and `input`; a sibling draft id or other field is displayed and refused. The same checks run again on click. Tests cover aliases, to/cc/bcc, draftId and other identifiers, other tool names, escaped keys, bidi tool names, sibling fields, short base64, controls, legacy persisted cards after restart, literal Markdown/HTML/backticks, and live native wrapper/draft denial versus direct email acceptance. Old cards are replaced with a versioned literal review without replay; an old opaque card is rejected even with matching owner, payload hash and delivered receipt.

This client does not read a mailbox, fetch a draft, or decode opaque content. It cannot prove a remote server sends only the reviewed fields. `JSON.parse` keeps the last duplicate key. Address checks are ASCII, so unicode and punycode domains are refused. A body that is only a padded base64 token is refused even when short; ordinary short plaintext remains eligible. Nested identifiers on a tool that does not look like mail get the generic refusal, still without Approve. No email or external draft was read or sent.

Executor MODEL uses its structured invocation; native approval uses the actual direct tool and arguments, never wrapper prose. Nonempty forms, private URL/account/OAuth flows and Executor BROWSER mode require the external service's supported secure flow. Native live requests cannot survive process restart; Executor pending requests can survive until their remote expiration. `/stop` invalidates local pending decisions; it cannot undo a remote action. An ambiguous send or interrupted action is not retried automatically. Only one process may own a data volume.

The immutable source route uses a compatibility `web_telegram` enum internally; clean mode delivers only to the captured Telegram origin. Legacy database/runtime helpers remain where they protect durable ledgers; there is no HTTP server or web chat entrypoint.
