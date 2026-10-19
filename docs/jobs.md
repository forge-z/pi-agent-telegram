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
        "accountId": "acc_...",
        "input": { "path": { "id": "${id}" } }
      },
      "statePath": "status",
      "resultPath": "result",
      "errorPath": "error"
    },
    "dedupe": "job:${row}:${id}",
    "poll": {
      "intervalSeconds": 25,
      "backoff": [25, 60, 150],
      "maxAttempts": 3
    },
    "graceMinutes": 5
  }
]
```

Put it in `ASYNC_JOB_MANIFESTS` (a JSON array, forwarded by the compose file).

| Field                                            | Meaning                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `tool`                                           | path that starts the job, as the Executor sees it                                       |
| `dispatch.mode`                                  | `immediate` (id in the response), `deferred` (id arrives later), `opaque` (no id)       |
| `dispatch.idPath`                                | dotted path to the id, e.g. `value.run_id`                                              |
| `observe.mode`                                   | `poll` (one id), `reconcile` (a search, needs `match`), `webhook`                       |
| `observe.tool` / `observe.args`                  | how the job is read; `${id}`, `${goal}`, `${row}`, `${since}`, `${now}` are substituted |
| `observe.statePath` / `resultPath` / `errorPath` | dotted paths inside the observed payload                                                |
| `observe.states`                                 | extra vocabulary, e.g. `{ "failed": ["TIMED_OUT"] }`                                    |
| `dedupe`                                         | request id of the delivery; a re-delivery of the same job is the same message           |
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
2. delivery is at-least-once with a stable dedupe key — settlement and the worker converge on
   one message;
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

`ASYNC_JOB_TOOLS` (comma separated paths) is still accepted: each path becomes an equivalent
reconcile manifest at startup, which is also how a v1 deployment keeps working. Both are
deprecated and scheduled for removal on **2026-12-31**.

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
