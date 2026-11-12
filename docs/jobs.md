# Async jobs

A tool that starts a job outliving the turn — a browser automation, a batch, a render — is
registered when it is dispatched, watched by a worker, and delivered once in the topic that
asked for it. The core knows state, queue, dedupe and delivery; **every provider detail lives
in a manifest**, so adding an integration does not touch code.

## Adding an integration

Declare the tool that starts the job, the tool that reads it, and where the fields live:

```json
[
  {
    "tool": "tools.tinyfish.agent.automation.runAsync",
    "dispatch": { "mode": "immediate", "idPath": "value.run_id" },
    "observe": {
      "mode": "poll",
      "tool": "tools.tinyfish.agent.runs.getRunById",
      "args": {
        "accountId": "${accountId}",
        "input": { "path": { "id": "${job_id}" } }
      },
      "statePath": "status",
      "resultPath": "result",
      "errorPath": "error"
    },
    "poll": {
      "intervalSeconds": 25,
      "backoff": [25, 60, 150],
      "maxAttempts": 3
    },
    "graceMinutes": 5
  }
]
```

Put it in `ASYNC_JOB_MANIFESTS` (a JSON array, passed via `.env` / `env_file`).

Every v2 read is `{ accountId, input }`. The account is the one the dispatch
passed (`accountId` on `runAsync` / `call`). If that call has none, the poller
asks Executor `search` for the namespace and uses the account only when there
is exactly one. Zero accounts is `missing_account`; two or more is
`ambiguous_account`. Neither guesses, and both tell the topic.

| Field                                            | Meaning                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `tool`                                           | path that starts the job, as the Executor sees it                                       |
| `dispatch.mode`                                  | `immediate` (id in the response), `deferred` (id arrives later), `opaque` (no id)       |
| `dispatch.idPath`                                | dotted path to the id, e.g. `value.run_id`                                              |
| `observe.mode`                                   | `poll` (one id), `reconcile` (a search, needs `match`), `webhook`                       |
| `observe.tool` / `observe.args`                  | how the job is read; `${id}`, `${goal}`, `${row}`, `${since}`, `${now}` are substituted |
| `observe.statePath` / `resultPath` / `errorPath` | dotted paths inside the observed payload                                                |
| `observe.states`                                 | extra vocabulary, e.g. `{ "failed": ["TIMED_OUT"] }`                                    |
| `poll`                                           | seconds between reads and the backoff ladder                                            |
| `graceMinutes`                                   | how long a job may be missing before the operator hears about it                        |

Without `states`, the vocabulary below is assumed (case and separators ignored):

```
pending    PENDING QUEUED WAITING CREATED
running    RUNNING IN_PROGRESS STARTED ACTIVE
done       COMPLETED COMPLETE SUCCESS SUCCEEDED DONE FINISHED
failed     FAILED ERROR TIMED_OUT TIMEOUT REJECTED
cancelled  CANCELLED CANCELED ABORTED STOPPED REVOKED
```

Anything else is `unknown`, which is **silence**, never a failure.

## Built-in: Executor v2

The TinyFish manifest above is registered with no configuration at all: v2 binds the account in
the tool's own signature, so nothing has to be filled in. Every v2 job call is scoped to one account,
which is why the id is required.

## Guarantees

1. the row is created **before** the dispatch, so a lost response is still covered;
2. delivery is at-least-once with a stable request id (`job:<row>:<run>`) — settlement and
   the worker converge on one message. The turn that summarizes a finished job does not
   deliver its final text; it calls `notify` to post in the topic. A runner failure
   (the turn itself faulting, or the poller giving up) is still posted by the system
   with the cause, and does not depend on that call;
3. `unknown` is not `failed`: a job that is not visible yet is silence until `graceMinutes`;
4. the Executor's own envelope status is never read as the job's status — the status comes
   from the object that carries the job id;
5. a failing read keeps the row open, backs off, and warns once at the ceiling instead of
   going quiet for ever;
6. a finished job whose payload carries no result becomes `expired`, once, with a notice;
7. the worker never dispatches: it only reads and delivers;
8. provider read failures (`poll_attempts`) and delivery failures (`delivery_attempts`) are counted separately. Three failed reads do not expire a finished result. Three rejected deliveries do. A successful read clears only `poll_attempts`. Delivery uses the stable request id `job:<row>:<run>`, which the runtime dedupes.

## Counters, retention, and old databases

`poll_attempts` and `delivery_attempts` are the live counters. The old `attempts` column is left in place and is not written. On a database from before the split, `poll_attempts` is copied from `attempts` and `delivery_attempts` starts at 0. On a database that already held rows (`legacy_attempts_unknown` and the other holds), every hold is cleared and the row returns to normal polling. For `legacy_attempts_unknown`, `poll_attempts` is taken from `attempts` again and `delivery_attempts` is set to 0. The migration is idempotent: a later boot does not reset counters on a row that is no longer held. Holds no longer block deleting a conversation.

Finished rows (`delivered_at` set) older than 30 days are deleted. Open rows are kept. There is no environment variable for the window.

A poller tick that throws is recorded on `health().last_tick_error` and logged at most once a minute for the same message. A later successful tick does not clear that error, and nothing is sent to the chat.

## Which Executor

The supported one is **v2, the cloud build** (`https://mcp.executor.sh/mcp`):
integrations are Executor apps, and their approval policy is part of the app — a tool that must
return a value to the caller (like `agent.automation.runAsync`) is declared without approval,
because an approval pause drops that value on resume. The bot relays that pause and does not
add a second approval of its own. An interactive pause is the existing card. A scheduled run
cannot wait, so an approval-required pause fails that call and resume is not sent.

## Migrating from v1

`ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID` are not read. A job is a manifest in
`ASYNC_JOB_MANIFESTS`, or the built-in TinyFish / Instabox manifests. The account
is taken from the call that started the job.

What changed in the v2 path:

|          | v1                                               | v2                                                 |
| -------- | ------------------------------------------------ | -------------------------------------------------- |
| dispatch | `tinyfish_mcp.user.example.run_web_automation`   | `tools.tinyfish.agent.automation.runAsync`         |
| read     | `list_runs` with a time window and a goal suffix | `getRunById` with `input.path.id`                  |
| id       | `runId` at the top level                         | `value.run_id`                                     |
| envelope | `{ status, result: "<json string>" }`            | `{ status, execution: { ok, value, error } }`      |
| status   | `COMPLETED`                                      | `COMPLETED` (same words, manifest maps them)       |
| program  | any                                              | pure JS: a TypeScript annotation is a `ParseError` |

`session_id` (and its `tf-` prefix) no longer exists. `send_attachment` and the approval card
are unchanged.

### Instabox (sandbox lifecycle)

Creating or resuming a sandbox returns an operation, not a finished machine. Declare it so the
topic that asked is told when the machine is ready:

```json
{
  "tool": "tools.instabox.machines.create",
  "dispatch": { "mode": "immediate", "idPath": "id" },
  "observe": {
    "mode": "poll",
    "tool": "tools.instabox.operations.get",
    "args": {
      "accountId": "acc_...",
      "input": { "id": "${id}", "wait": "25s" }
    },
    "statePath": "state",
    "resultPath": "machine",
    "errorPath": "error"
  },
  "poll": { "intervalSeconds": 5, "backoff": [5, 15, 30], "maxAttempts": 3 },
  "graceMinutes": 5
}
```

`machines.exec` is synchronous (up to 600 s) and needs no manifest; wrap long builds in
`nohup` and register the work with the job tools instead.

### Tarefas de código na sandbox (`sandbox_code_task`)

`sandbox_code_task` hoje suporta só o Instabox. O bloco em `config.default.yaml`, as variáveis `INSTABOX_*` e `scripts/instabox/` são desse provedor. Apontar o YAML para outro sandbox (freestyle.sh, por exemplo) não faz o bot usá-lo.

```yaml
sandbox_code_task:
  tool: sandbox_code_task
  job: "internal.instabox.codeTask" # manifesto em async_jobs
  server: executor # executor usa `execute` + tools.*; outro nome é chamado direto
  goal: prompt
  idPrefix: "cj-"
  exec:
    tool: "tools.instabox.machines.exec"
    args:
      accountId: "${INSTABOX_ACCOUNT_ID}"
      input:
        id: "${INSTABOX_MACHINE_ID}"
        cmd: "bash ~/bin/start-job.sh ${job_id}" # writes=false prefixa com readonly.env
        timeoutSeconds: 15
        stdin: "${payload}" # parâmetros do modelo em JSON
  parameters: # JSON Schema da chamada do modelo
    type: object
    required: [repo, agent, prompt]
    properties:
      repo: { type: string }
      agent: { type: string, enum: [agy, pi, claude] }
      prompt: { type: string }
      branch: { type: string }
      writes: { type: boolean } # padrão false; true pede o cartão antes do exec
  readonly:
    env: "JOB_READONLY=1" # prefixo do comando quando writes é false
    command: input.cmd
    prompt: "Somente leitura: não faça push, não abra pull requests e não comente."
  allow:
    field: repo
    # patterns is empty in config.default.yaml. Set it here or via
    # INSTABOX_REPO_ALLOWLIST. Example only, not a shipped default:
    patterns: "example/*"
```

- O disparo gera um `jobId` (`<idPrefix><timestamp-base36>-<random>`) e registra a linha em `pending_jobs` antes de chamar a sandbox. No caso do Instabox, o `jobId` vira `cmd` e os parâmetros vão apenas no `stdin` em JSON — o prompt nunca trafega pela linha de comando nem por variáveis de ambiente.
- A ferramenta retorna imediatamente (`{ jobId, status: "dispatched" }`, ou `{ status: "approval_pending" }` quando `writes` é true), liberando o turno do Telegram.
- O poller usa o manifesto `job` para ler o status; no padrão, `/data/home/jobs/${id}/status.json` via `tools.instabox.machines.readFiles` a cada 20 segundos (com backoff). O `status:"completed"` do Executor é o envelope da chamada, não o estado do job. Um `status.json` ausente (404) durante a carência fica em silêncio.
- Quando o job conclui, o poller entrega o resultado como um turno novo no tópico original. Um job com `writes: true` pode incluir o link do Pull Request (`result.pr`). Com `writes` omitido ou false, o disparo não abre cartão: o comando de início ganha o prefixo `readonly.env` e o prompt do agente ganha `readonly.prompt`.
- `writes: true` não registra a linha nem chama o exec até o cartão de aprovação (o mesmo "Aprovação MCP pendente", com repositório, agente, branch e um trecho curto do prompt). Recusar não dispara nada.
- Linhas antigas de `instabox_code_task` continuam resolvendo porque o manifesto padrão mantém `tool: internal.instabox.codeTask`.
- **Instalação na Sandbox Instabox**:
  1. Copie os scripts versionados no repositório (`scripts/instabox/start-job.sh` e `scripts/instabox/run-job.sh`) para o diretório `~/bin/` da máquina:
     ```bash
     mkdir -p ~/bin
     cp scripts/instabox/*.sh ~/bin/
     chmod +x ~/bin/*.sh
     ```
  2. Configure `~/.agents-env.sh` com as chaves e tokens necessários (autenticação `gh`, chaves de API para os agentes CLI):
     ```bash
     # ~/.agents-env.sh
     export GITHUB_TOKEN="..."
     export ANTHROPIC_API_KEY="..."
     export OPENAI_API_KEY="..."
     ```
  3. Certifique-se de que as ferramentas `git`, `gh`, `node` e os agentes CLI (`agy`, `pi`, `claude`) estejam instalados no ambiente da sandbox.
  4. Atualize o `~/bin/run-job.sh` da máquina com a cópia do repositório. `start-job.sh` não muda: ele herda o ambiente, então `JOB_READONLY=1 bash ~/bin/start-job.sh <jobId>` chega no runner. Com essa variável, depois do clone o script apaga `GH_TOKEN`, `GITHUB_TOKEN` e `GH_ENTERPRISE_TOKEN`, aponta `GH_CONFIG_DIR` para um diretório vazio (um `gh` já logado ignora o token apagado e usa `~/.config/gh`), remove o `credential.helper` do worktree, define `GIT_TERMINAL_PROMPT=0`, pula commit, push e `gh pr create`, e acrescenta a frase de somente leitura ao prompt se ela ainda não estiver lá.

- **Variáveis de Ambiente**:
  - `INSTABOX_MACHINE_ID`: opcional. Sem ela, o `discover` do manifesto escolhe a máquina somente quando existe exatamente uma em execução. Zero ou várias é erro e a lista é mostrada. Não há nome padrão.
  - `INSTABOX_ACCOUNT_ID`: opcional. Sem ela, usa a única conta encontrada. Mais de uma é erro.
  - `INSTABOX_REPO_ALLOWLIST`: override opcional de `sandbox_code_task.allow.patterns`. O padrão em `config.default.yaml` é vazio: nada é permitido até o operador definir a lista em `$DATA_DIR/config.yaml` ou nesta variável. Lista separada por vírgula; `owner/*` casa com o dono. A variável, quando definida, vence o arquivo.
  - `MCP_CALL_TIMEOUT_MS`: Timeout de chamadas de ferramenta no MCP (padrão `60000` ms).
  - `ASYNC_JOB_TIMEOUT_MIN`: override opcional de `async_job.timeout_min` (padrão `25`).
  - `ASYNC_JOB_POLL_SECONDS`: override opcional de `async_job.poll_seconds` (padrão `25`).
  - `ASYNC_JOB_READ_TIMEOUT_MS`: Timeout de leitura do poller (padrão `20000` ms).
