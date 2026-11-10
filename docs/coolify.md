# Deploy no Coolify — Pi-Agent

Checklist do lado do painel. O repositório não contém credenciais: tudo é variável de
runtime, nunca argumento de build.

## Pré-requisitos

- Repositório `https://github.com/forge-z/pi-bot`, branch `main`.
- Docker Engine + Compose v2.24+ (amd64 ou arm64).
- Um bot Telegram dedicado, sem webhook ativo e sem segundo consumidor de polling.

## 0. Checklist antes do primeiro deploy

O caminho oficial é `npm run setup` (chave de API de um provedor pi-ai) ou `npm run login`
(assinatura ChatGPT/Codex), no terminal do container, depois que ele sobe. `LLM_BASE_URL`
e `LLM_API_KEY` não são obrigatórias. Os itens abaixo só valem para o caminho compatível
opcional (menu "Outro").

Faça isso uma vez, fora do Coolify, para não descobrir erro de configuração no boot.

1. **A raiz da URL está exata?** A URL é usada literalmente: o adapter concatena
   `/chat/completions` e a descoberta concatena `/models`. Copie a raiz da documentação do
   provedor — `https://api.openai.com/v1`, `https://api.deepseek.com` (na DeepSeek o
   `/v1` também funciona).
2. **Valide URL e chave de verdade**, não só a presença:

   ```sh
   npm run build
   LLM_BASE_URL=... LLM_API_KEY=... node scripts/diagnose-tg-runtime.mjs --probe
   ```

   O `--probe` chama `GET {LLM_BASE_URL}/models` e lista os ids. O container não sobe com
   catálogo inválido, então corrija aqui antes de subir.

3. **Decida sobre `LLM_MODELS`.** Sem ele o `/thinking` fica só em `off`. Declare o
   catálogo com os limites e **os níveis que o modelo aceita**:
   `LLM_MODELS=deepseek-flash|1000000|384000|off+low+high+max`. `true` liga os níveis
   padrão (`off minimal low medium high`), mas a DeepSeek recusa `minimal` e `medium` e
   aceita `max` — nela, use a lista explícita.
4. **Use um bot novo** e confirme que não há webhook ativo nem outro processo consumindo
   o mesmo token (o app falha fechado se detectar webhook ou segundo consumidor).
5. **Volume novo.** Não reuse um `pi_agent_tg_data` de outro bot: o app recusa subir com
   "Volume pertence a outro bot".
6. Tenha em mãos o token do bot e os user IDs. Os dois entram no `npm run setup`,
   junto da chave do modelo (ou `npm run login`) e, se houver, Executor ou Composio.

## 1. Criar o recurso

- **New Resource → Docker Compose**, apontando para `forge-z/pi-bot` na branch `main`.
- **Docker Compose Location**: `docker-compose.yml` (raiz do repositório).
- O serviço se chama `pi-agent-tg`.
- **Não** configure domínio, porta ou proxy reverso. O processo usa long polling e o
  compose não declara `ports:`. Expor algo não é necessário e só aumenta a superfície.

## 2. Variáveis de runtime

Nenhuma variável de ambiente é obrigatória para o container subir. O token do bot e os user IDs entram no `npm run setup` (token em entrada oculta; Enter mantém o valor já gravado, mostrado mascarado) e ficam no volume, na mesma base `credentials` / `meta` da chave do modelo e dos agregadores. Sem token no ambiente nem no volume, o processo registra o aviso e permanece no ar, saudável, em vez de cair em restart loop.

O `docker-compose.yml` não declara variáveis em `environment:`. Nada fica travado no painel do Coolify.

### Opcionais (adicionadas manualmente no painel do Coolify)

Todas as variáveis são opcionais. Quando definidas, vencem o valor gravado no volume:

- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN_FILE` e `TELEGRAM_ALLOWED_USERS`: override do que o `npm run setup` gravou. Sem elas, vale o volume.
- `LLM_BASE_URL` e `LLM_API_KEY`: não fazem parte do caminho oficial. Use `npm run setup` ou `npm run login`. Essas duas variáveis só ligam o provedor compatível `llm` (menu "Outro") e não substituem um setup oficial já gravado no volume.
- `EXECUTOR_MCP_URL` e `EXECUTOR_TOKEN`: opcionais (em par). O caminho normal é `npm run setup`, que pergunta Executor, Composio ou ambos e grava URL, chave e user id no volume. `COMPOSIO_MCP_URL`, `COMPOSIO_API_KEY` e `COMPOSIO_USER_ID` só substituem esse registro. Sem agregador, o bot sobe normalmente, apenas sem ferramentas externas MCP.
- `TELEGRAM_ALLOWED_CHATS`: opcional (IDs negativos de grupos/supergrupos; por padrão copia os usuários permitidos para DMs). Continua só no ambiente.
- `TZ`: opcional (fuso do relógio do container para logs, ex.: `America/Sao_Paulo`; omitido usa UTC). Agendamentos gravam seu próprio timezone IANA. O setup não grava `TZ`.
- `LLM_MODELS`, `LLM_INPUT`, `VISION_*`, `AUDIO_*`, `ASYNC_JOB_*`, `INSTABOX_*`: opcionais para recursos específicos. A referência completa com exemplos está em [.env.example](.env.example).

A única forma de o assistente alcançar algo fora da conversa é MCP: ele não tem shell,
arquivo, patch nem browser, e não enxerga o host, o volume ou o código-fonte.
[Executor](https://executor.sh) ou [Composio](https://composio.dev) expõem os MCPs num
endpoint autenticado. Executor continua `Authorization: Bearer`. Composio Connect
(`https://connect.composio.dev/mcp`) usa `x-consumer-api-key`; as outras URLs MCP
da Composio usam `x-api-key` e o query `user_id`. `NODE_ENV`, `DATA_DIR` e o SHA do commit não são
configuração: dois são fixados pela imagem (`Dockerfile`) e o SHA é injetado pela plataforma.

Não existem mais variáveis de modelo: `MODEL_PROVIDER` e `MODEL_ID` saíram, e as chaves
por provedor (`OPENAI_*`, `ANTHROPIC_*`, `DEEPSEEK_*`, `AI_PROVIDERS_JSON`) foram
substituídas pelo par `LLM_*`.

### Como as opcionais chegam ao container (`env_file`)

No Coolify, **qualquer variável declarada no `docker-compose.yml` fica travada no painel e não pode ser apagada pela interface** (gerando o erro _"Please remove it from the Docker Compose file first"_).

Para resolver isso e manter o painel limpo:

1. O `docker-compose.yml` não lista variáveis em `environment:`.
2. O Compose inclui:
   ```yaml
   env_file:
     - path: .env
       required: false
   ```
3. O Coolify gera automaticamente um arquivo `.env` no diretório de deploy contendo todas as variáveis configuradas na aba **Environment Variables** (inclusive as criadas manualmente).
4. O Compose repassa esse `.env` ao container via `env_file`. Portanto, para usar qualquer opcional (como `TZ`, `EXECUTOR_MCP_URL` ou `LLM_BASE_URL`), basta criá-la manualmente na aba **Environment Variables** do Coolify — ela será gravada no `.env` e carregada pelo container sem precisar estar declarada no Compose.

### Passo de limpeza pós-migração

Se o seu deploy no Coolify foi criado antes desta alteração, o painel manteve cadastradas variáveis que antes constavam no Compose (`ASYNC_JOB_TOOLS`, `EXECUTOR_MCP_URL`, `EXECUTOR_TOKEN`, `TZ`, `ASYNC_JOB_TIMEOUT_MIN`, `ASYNC_JOB_POLL_SECONDS`).

Depois de atualizar o repositório e fazer o deploy desta versão:

- O Coolify destrava a remoção dessas variáveis no painel porque elas não constam mais no `docker-compose.yml`.
- **Apague no painel** as variáveis que o bot não lê mais: `ASYNC_JOB_TOOLS` e `EXECUTOR_ACCOUNT_ID`. A conta da leitura vem da chamada que criou o job. Não há migração manual; a coluna `pending_jobs.account_id` é criada no boot.
- Variáveis opcionais que você realmente usa (ex.: `TZ`) podem permanecer no painel: elas continuarão chegando ao container normalmente via `.env`.
- Depois de rodar `npm run setup` neste container, `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USERS` podem sair do painel: o volume guarda os dois. Se continuarem definidas, vencem o volume.

### Variáveis fixas da imagem

`NODE_ENV=production` e `DATA_DIR=/app/data` são fixadas na imagem pelo `Dockerfile` (instrução `ENV`). Não precisam e não devem ser configuradas no painel. O `SOURCE_COMMIT` é injetado pelo próprio Coolify em runtime.

### Catálogo de modelos e reasoning

Sem `LLM_MODELS`, o catálogo vem de `GET {LLM_BASE_URL}/models`. Como essa listagem não
informa capacidades, os modelos descobertos ficam com limites conservadores e
`reasoning=false` — ou seja, `/thinking` oferece apenas `off`.

Cada entrada de `LLM_MODELS` é `id` ou `id|contextWindow|maxTokens|reasoning`, com
`contextWindow >= 32768` e `0 < maxTokens < contextWindow`. O campo `reasoning` aceita:

- `false` — sem raciocínio (`/thinking` só `off`);
- `true` — níveis padrão (`off minimal low medium high`);
- uma lista separada por `+` — exatamente os níveis que o modelo aceita.

Limites e níveis precisam vir do provedor: a descoberta não os informa, e escolher um
nível que o modelo recusa gera erro na chamada. A DeepSeek, por exemplo, recusa `minimal`
e `medium` e aceita `max`:

```sh
LLM_MODELS=deepseek-flash|1000000|384000|off+low+high+max
```

Esses valores vêm do catálogo do `pi-ai` 1.4.0 que embute `deepseek-flash` com
`contextWindow=1000000`, `maxTokens=384000` e esse mapa de níveis (`off/low/high/max`).

### Nunca use build args para segredos

O Dockerfile não aceita nenhum argumento de build. Chaves de API passadas como build
arg ficam gravadas nas camadas da imagem.

## 3. SHA do commit em `/status`

Nada a configurar no painel: o Coolify injeta `SOURCE_COMMIT` em runtime e o processo o
lê direto para `/status` e `npm run diagnose`. Também são aceitos `GIT_COMMIT`,
`COMMIT_SHA`, `COOLIFY_COMMIT` e `COOLIFY_SOURCE_COMMIT`, com fallback para
`git rev-parse HEAD` quando existe `.git` (fora do container). Não há mais argumento de
build nem necessidade de **Source commit availability → Available during build**.

## 4. Volume e persistência

- Volume nomeado `pi_agent_tg_data` montado em `/app/data`.
- Banco: `/app/data/app.sqlite` (SQLite embutido do Node 24; a imagem não traz o
  binário `sqlite3`).
- **Um único processo por volume.** Não aponte para o volume de outro deploy e não
  rode duas instâncias contra o mesmo volume.
- Antes de trocar de versão, faça backup do volume. Tópicos e conversas só são criados
  no primeiro uso — nada é criado no startup.

## 5. Hardening e possíveis atritos

O compose roda com `read_only: true`, `tmpfs` de 16 MB em `/tmp`, `cap_drop: ALL`,
`no-new-privileges`, `init: true`, `restart: unless-stopped`,
`stop_grace_period: 45s` e healthcheck a cada 30 s (`node dist/src/healthcheck.js`,
`start_period` 40 s, 3 tentativas).

Os únicos caminhos de escrita esperados são `/app/data` (volume) e `/tmp` (tmpfs). Se o
Coolify reclamar de escrita negada, verifique se o volume foi realmente montado — não
relaxe o `read_only` por padrão.

O `start_period` de 40 s é intencional: o primeiro ciclo de polling precisa concluir
antes do healthcheck ficar verde. Um `unhealthy` logo após o deploy, com logs normais,
costuma ser só isso.

## 6. Verificação pós-deploy

- `docker compose ps` e `docker compose logs --tail=100 pi-agent-tg`.
- No terminal do serviço (Coolify): `node scripts/diagnose-tg-runtime.mjs` ou
  `npm run diagnose`.
- Defina o modelo padrão (opcional, mas recomendado para quem não vai usar `/model`):
  `npm run setup -- --list`. `npm run setup` é o assistente completo (visão e áudio inclusive);
  `npm run login` é só OAuth. Os dois gravam no volume. Um setup oficial não é trocado por
  `LLM_BASE_URL`/`LLM_API_KEY` (isso só vale no caminho compatível). Sem modelo escolhido, o
  primeiro item do catálogo é usado e o bot avisa uma vez por conversa. `/model` troca.
- No host, via SSH: `bash scripts/diagnose-tg-deploy.sh .`.
- No Telegram: envie `/status` dentro de um tópico existente.

O diagnóstico imprime apenas a presença das variáveis (`definido`, `VAZIO`,
`PLACEHOLDER`), nunca os valores.

## 7. BuildKit secret `npm_ca` (opcional)

O Dockerfile aceita `--mount=type=secret,id=npm_ca` para `npm ci` atrás de um proxy com
CA própria. Em build normal, ignore: o secret é opcional e nunca é copiado para a
imagem.

## 8. Atualização e rollback

- Push na `main` dispara o workflow **Verify pi-agent-tg Telegram agent**, que roda
  `check`, `lint`, `format:check`, `build`, a suíte offline, `docker compose config` e o
  smoke do container.
- Rebuild local: `npm run compose:up`, ou
  `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`.
- Rollback: selecione um commit anterior no Coolify e redeploy. Restaure o backup do
  volume junto — o ledger SQLite é a única fonte de verdade das conversas.

## 9. Quando algo falha

O processo falha fechado e imprime uma mensagem segura (sem segredos). Localize a linha:

| Mensagem no log                                                                         | Causa                                                             | Correção                                                  |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `Configure LLM_BASE_URL (endpoint OpenAI-compatible).`                                  | variável ausente/vazia                                            | preencha no painel                                        |
| `Endpoint exige HTTPS sem credenciais/query (HTTP somente loopback).`                   | URL com `user:pass@`, query ou `http://` fora de loopback         | use HTTPS limpo                                           |
| `Endpoint inválido`                                                                     | URL não parseável                                                 | corrija o valor                                           |
| `Configure LLM_API_KEY ou LLM_API_KEY_FILE.`                                            | chave ausente ou ainda `replace_with…`                            | preencha a chave crua                                     |
| `Catálogo de modelos indisponível em LLM_BASE_URL (endpoint LLM respondeu HTTP 401)…`   | chave inválida/ausente no provedor                                | corrija `LLM_API_KEY`                                     |
| `Catálogo de modelos indisponível em LLM_BASE_URL (endpoint LLM respondeu HTTP 404)…`   | `LLM_BASE_URL` sem o segmento de versão                           | acrescente `/v1`                                          |
| `Catálogo de modelos indisponível em LLM_BASE_URL (endpoint LLM inacessível)…`          | rede, DNS, TLS ou host errado                                     | teste do host com `--probe`                               |
| `Catálogo de modelos indisponível em LLM_BASE_URL (endpoint LLM não respondeu em 10s)…` | timeout de 10s no `GET /models`                                   | teste do host com `--probe`                               |
| `Catálogo de modelos indisponível em LLM_BASE_URL (catálogo inválido)…`                 | resposta fora de `{data:[{id}]}` ou lista                         | declare `LLM_MODELS`                                      |
| `Nenhum modelo disponível. Verifique LLM_BASE_URL ou defina LLM_MODELS.`                | endpoint respondeu sem modelos                                    | declare `LLM_MODELS`                                      |
| `LLM_MODELS inválido: …`                                                                | formato fora de `id` ou `id\|contextWindow\|maxTokens\|reasoning` | ajuste o formato                                          |
| `Sem token do Telegram no ambiente nem no volume. Rode npm run setup…`                  | token ausente no ambiente e no volume                             | `npm run setup` no terminal do container                  |
| `Configure TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN_FILE.`                              | token fora de `123456:ABC…`                                       | corrija o token (ambiente ou setup)                       |
| `Sem usuários permitidos do Telegram no ambiente nem no volume…`                        | allowlist ausente                                                 | `npm run setup` ou `TELEGRAM_ALLOWED_USERS`               |
| `TELEGRAM_ALLOWED_USERS inválido: use IDs numéricos …`                                  | allowlist não numérica                                            | informe user IDs                                          |
| `TELEGRAM_ALLOWED_CHATS contém <id>, que é o id do bot, não do chat.`                   | allowlist usando o id do bot                                      | omita `TELEGRAM_ALLOWED_CHATS` em DM                      |
| `Volume pertence a outro bot. Use um volume separado.`                                  | volume reaproveitado                                              | aponte um volume novo                                     |
| `Comando Telegram ignorado (allowlist ou tipo de chat): …` (warn)                       | update fora da allowlist ou tipo de chat não suportado            | revise `TELEGRAM_ALLOWED_USERS`/`_CHATS`                  |
| `/status` mostra `(sem SHA)`                                                            | `SOURCE_COMMIT` não chegou em runtime                             | confirme a injeção da variável; fora do Coolify exporte-a |
| container `unhealthy` logo após o deploy                                                | `start_period` de 40 s do primeiro ciclo de polling               | aguarde ~1 min antes de investigar                        |

Com o container no ar, `npm run diagnose` (ou `node scripts/diagnose-tg-runtime.mjs`)
mostra presença das variáveis, catálogo, quantos modelos têm reasoning e o padrão global.

## Limites

Sem porta pública, domínio, webhook, chat web ou login de assinatura. As credenciais de
IA são apenas API keys. Não rode dois processos contra um volume.
