# Diagnóstico histórico: poller de jobs assíncronos sem entrega

Este texto descreve uma falha vista em 21/10/2026, antes das correções que estão no código atual. O comportamento vigente está em [jobs.md](jobs.md). `EXECUTOR_ACCOUNT_ID` e `ASYNC_JOB_TOOLS` não são lidas: a conta da leitura vem da chamada que disparou o job. Os números de linha abaixo são do código da época. O `run_id` é fictício.

`run_id` `00000000-0000-4000-8000-000000000096`
terminou `COMPLETED` em 26 s, mas 3,9 min depois não houve entrega nem aviso.

## Onde cada etapa vive (antes das correções)

| Etapa                           | Arquivo:linha                                                                                          | Comportamento observado                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Conta do Executor           | `src/job-account.ts:2-6`                                                                               | Só lê `EXECUTOR_ACCOUNT_ID`; vazio vira `undefined`, sem default.                                                                                                                                                                                                         |
| (a) Template da conta           | `src/pending-jobs.ts:374-385` e `src/job-manifest.ts:195-208`                                          | `${accountId}` vazio faz `buildReadInput` retornar erro.                                                                                                                                                                                                                  |
| (a) Ferramenta desligada        | `src/pending-jobs.ts:433-455` (HEAD `readable`)                                                        | `register`/`registerDelegated` retornam `false`, nenhuma linha nasce. O aviso era um `console.error` por ferramenta e não havia estado de saúde consultável.                                                                                                              |
| (b) Criação da linha            | `src/pending-jobs.ts:642-649` (`register`)                                                             | `integration` e `tool` vêm do manifesto normalizado; `run_id` começa nulo.                                                                                                                                                                                                |
| (b) Disparo dentro de `execute` | `src/runtime.ts:936-942`                                                                               | `register` direto falha para `executor.execute`; `registerDelegated` varre o código.                                                                                                                                                                                      |
| (b) Extração do run_id          | `src/runtime.ts:966-974` -> `src/pending-jobs.ts:782-845` (`capture`)                                  | HEAD chamava `capture` somente dentro de `if (job)`. Se a varredura não reconhecesse a invocação, a linha não existia e o `run_id` retornado era descartado. A varredura do HEAD cobria caminho direto, `/` e nome curto, mas não `tools["a"]["b"]` nem path em variável. |
| (c) Início do worker            | `src/pending-jobs.ts:931-958` (`start`), timer em `:952`, `src/main.ts:87`                             | O worker só roda se a conta resolve e o manifesto abre. `tick` em `src/pending-jobs.ts:1001` retorna cedo sem log quando desabilitado, sem linhas devidas ou sem `callDirect`.                                                                                            |
| (d) Entrega/dedupe              | `src/pending-jobs.ts:1802-1916` (`deliverOnce`), `dedupeFor` em `:1736-1738`, `submit` em `:1921-1940` | `delivered_at` era gravado antes do envio no caminho de validação; falha de entrega não reagendava com backoff; `checkDelivered` só olhava `dispatch_result`. O silêncio podia significar worker desligado, linha inexistente ou retry sem próxima tentativa.             |

## Causas raiz

1. **Config ausente desligava sem canal de saúde.** Sem `EXECUTOR_ACCOUNT_ID`,
   nenhuma linha era criada; o único sinal era um log de erro fácil de perder.
2. **Registro por varredura incompleto + `capture` condicionado ao registro.**
   Uma chamada `tools[...]` ou via variável não abria a linha, e o `run_id`
   devolvido pelo `execute` não era gravado. Sem `run_id`, a reconciliação por
   `goal` também não avança se o goal não foi extraído.
3. **Tick sem contadores.** Era impossível distinguir “worker não acordou”,
   “nada vencido” e “leitura falhou”.
4. **Retry de entrega sem agendamento explícito e fechamento cedo.** Uma falha
   de `app.submit` podia encerrar a linha antes de um envio confirmado, e o
   caminho de 422 fechava a linha antes de tentar avisar.

## O que foi corrigido

- A conta não vem mais de `EXECUTOR_ACCOUNT_ID`. Ela vem da chamada que disparou
  o job; zero contas vira `missing_account` e duas ou mais vira `ambiguous_account`.
- Varredura reconhece caminho direto, bracket, variável de segmento/path,
  alias de objeto, destructuring e `/`; `capture` grava `run_id` e o caminho
  normalizado mesmo quando a pré-registração não abriu linha.
- Todo tick publica `rows_polled`, `delivered`, `errors`; o último tick fica na
  saúde consultável.
- `delivered_at` só é gravado após `submit`; falha agenda retry com backoff e,
  após 3 tentativas, emite aviso explícito com o resultado preservado na linha.
- `ASYNC_JOB_TOOLS` deixou de ser lido. Um job é um manifesto em
  `ASYNC_JOB_MANIFESTS` ou um dos manifestos embutidos (TinyFish, Instabox).

## Pendente

- Conferir `health.json` e a linha em `pending_jobs` após o primeiro tick de um
  job novo. Não há variável de conta para preencher.
- Se o provedor devolver um `run_id` fora dos formatos conhecidos, a captura
  ainda depende de `dispatchOutcome`; um log do payload bruto nesse caso é o
  próximo passo.
