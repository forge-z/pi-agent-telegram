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
   the worker converge on one message;
3. `unknown` is not `failed`: a job that is not visible yet is silence until `graceMinutes`;
4. the Executor's own envelope status is never read as the job's status — the status comes
   from the object that carries the job id;
5. a failing read keeps the row open, backs off, and warns once at the ceiling instead of
   going quiet for ever;
6. a finished job whose payload carries no result becomes `expired`, once, with a notice;
7. the worker never dispatches: it only reads and delivers;
8. `attempts` is capped and the row ends as `expired` with its result preserved.

## Which Executor

The supported one is **v2, the cloud build** (`https://mcp.executor.sh/mcp`):
integrations are Executor apps, and their approval policy is part of the app — a tool that must
return a value to the caller (like `agent.automation.runAsync`) is declared without approval,
because an approval pause drops that value on resume.

## Migrating from v1

`ASYNC_JOB_TOOLS` and `EXECUTOR_ACCOUNT_ID` are not read. A job is a manifest in
`ASYNC_JOB_MANIFESTS`, or the built-in TinyFish / Instabox manifests. The account
is taken from the call that started the job.

What changed in the v2 path:

|          | v1                                                         | v2                                                 |
| -------- | ---------------------------------------------------------- | -------------------------------------------------- |
| dispatch | `tinyfish_mcp.user.personalTinyfishMcp.run_web_automation` | `tools.tinyfish.agent.automation.runAsync`         |
| read     | `list_runs` with a time window and a goal suffix           | `getRunById` with `input.path.id`                  |
| id       | `runId` at the top level                                   | `value.run_id`                                     |
| envelope | `{ status, result: "<json string>" }`                      | `{ status, execution: { ok, value, error } }`      |
| status   | `COMPLETED`                                                | `COMPLETED` (same words, manifest maps them)       |
| program  | any                                                        | pure JS: a TypeScript annotation is a `ParseError` |

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
      "accountId": "acc_00000000-0000-0000-0000-000000000000",
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

### Tarefas de código no Instabox (`instabox_code_task`)

Para rodar tarefas de desenvolvimento assíncronas em sandboxes Instabox (usando agentes como `agy`, `pi` ou `claude`) sem travar o bot de Telegram nem o turno da conversa:

- **Ferramenta interna**: `instabox_code_task` (disponível automaticamente quando `INSTABOX_MACHINE_ID` está configurado).
- **Parâmetros**:
  - `repo` (`string`, obrigatório): repositório no formato `owner/name` (ex.: `example/app`).
  - `agent` (`string`, obrigatório): agente a executar (`agy`, `pi` ou `claude`).
  - `prompt` (`string`, obrigatório): descrição detalhada da tarefa para o agente.
  - `branch` (`string`, opcional): nome da branch a ser criada; por padrão `agent/<jobId>`.
- **Comportamento**:
  - O disparo gera um `jobId` no formato `cj-<timestamp-base36>-<random>` e chama a ferramenta MCP `execute` com `return await tools.instabox.machines.exec({...})` (`cmd: "bash ~/bin/start-job.sh <jobId>"`, `timeoutSeconds: 15`). Esse caminho não é um nome de ferramenta MCP. O prompt nunca trafega pela linha de comando nem por variáveis de ambiente, apenas via `stdin` em JSON seguro.
  - A ferramenta retorna imediatamente para o modelo (`{ jobId, status: "dispatched" }`), liberando o turno do Telegram.
  - O poller observa `/data/home/jobs/${id}/status.json` via manifesto embutido (`internal.instabox.codeTask`) chamando `tools.instabox.machines.readFiles` dentro de `execute` a cada 20 segundos (com backoff). O `status:"completed"` do Executor é o envelope da chamada, não o estado do job. Um `status.json` ausente (404) durante a carência fica em silêncio.
  - Quando o job conclui, o poller entrega o resultado como um turno novo no tópico original, incluindo o link do Pull Request criado (`result.pr`).
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

- **Variáveis de Ambiente**:
  - `INSTABOX_MACHINE_ID`: ID da sandbox Instabox (obrigatória para habilitar a ferramenta).
  - `INSTABOX_ACCOUNT_ID`: Conta do Instabox, se a chamada não trouxer `accountId`.
  - `INSTABOX_REPO_ALLOWLIST`: Allowlist de repositórios permitidos (se vazia, o código usa `example/*`; aceita lista separada por vírgula com curingas `owner/*`). Defina a lista do deploy.
  - `MCP_CALL_TIMEOUT_MS`: Timeout de chamadas de ferramenta no MCP (padrão `60000` ms).
  - `ASYNC_JOB_TIMEOUT_MIN`: Timeout padrão de jobs assíncronos (padrão `25` min).
  - `ASYNC_JOB_READ_TIMEOUT_MS`: Timeout de leitura do poller (padrão `20000` ms).
