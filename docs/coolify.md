# Deploy no Coolify — Pi-Agent

Checklist do lado do painel. O repositório não contém credenciais: tudo é variável de
runtime, nunca argumento de build.

## Pré-requisitos

- Repositório `https://github.com/forge-z/pi-agent-tg`, branch `main`.
- Docker Engine + Compose v2.24+ (amd64 ou arm64).
- Um bot Telegram dedicado, sem webhook ativo e sem segundo consumidor de polling.

## 0. Checklist antes do primeiro deploy

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
6. Tenha em mãos: bot token, user IDs permitidos, `LLM_BASE_URL`, `LLM_API_KEY` e, se
   houver, `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN`.

## 1. Criar o recurso

- **New Resource → Docker Compose**, apontando para `forge-z/pi-agent-tg` na branch `main`.
- **Docker Compose Location**: `docker-compose.yml` (raiz do repositório).
- O serviço se chama `pi-agent-tg`.
- **Não** configure domínio, porta ou proxy reverso. O processo usa long polling e o
  compose não declara `ports:`. Expor algo não é necessário e só aumenta a superfície.

## 2. Variáveis de runtime

Obrigatórias para o container subir saudável:

- `TELEGRAM_BOT_TOKEN` — token do bot, apenas no servidor.
- `TELEGRAM_ALLOWED_USERS` — user IDs numéricos que controlam o bot.
- `LLM_BASE_URL` — endpoint OpenAI-compatible do provedor.
- `LLM_API_KEY` — chave crua desse endpoint (a aplicação não usa prefixo `Bearer`).
- `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` — em par. Sem o token, o MCP não é registrado
  (o bot sobe, mas as ferramentas MCP ficam indisponíveis).

Opcionais: `TELEGRAM_ALLOWED_CHATS` (grupos/supergrupos, IDs negativos), `LLM_MODELS`,
`MCP_SERVERS_JSON`, `MCP_CONFIG_FILE` e as variantes `NAME_FILE`.

A única forma de o assistente alcançar algo fora da conversa é MCP: ele não tem shell,
arquivo, patch nem browser, e não enxerga o host, o volume ou o código-fonte.
[Executor](https://executor.sh) é a forma preferida de expor todos os MCPs num único
endpoint autenticado — um `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` já cobre toda a
superfície de ferramentas. `NODE_ENV`, `DATA_DIR` e o SHA do commit não são
configuração: dois são fixados pela imagem e o SHA é injetado pela plataforma.

Não existem mais variáveis de modelo: `MODEL_PROVIDER` e `MODEL_ID` saíram, e as chaves
por provedor (`OPENAI_*`, `ANTHROPIC_*`, `DEEPSEEK_*`, `AI_PROVIDERS_JSON`) foram
substituídas pelo par `LLM_*`.

### `environment:` do compose e o `env_file`

O `docker-compose.yml` repassa explicitamente ao container apenas
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `SOURCE_COMMIT`, `LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODELS`, `LLM_INPUT`, `VISION_MODE`, `VISION_MODEL`,
`VISION_BASE_URL`, `VISION_API_KEY`, `AUDIO_MODEL`, `AUDIO_API`, `AUDIO_BASE_URL`,
`AUDIO_API_KEY`, `AUDIO_LANGUAGE`, `EXECUTOR_TOKEN` e `EXECUTOR_MCP_URL` (além de
`NODE_ENV` e `DATA_DIR`, fixados no arquivo). Em branco significam "não configurado":
o bot sobe sem visão e sem áudio e responde explicando o que falta.

As demais variáveis chegam ao processo pelo `env_file: .env`, opcional e relativo ao
diretório do compose. O Coolify normalmente materializa as variáveis do painel nesse
`.env`; confirme no servidor com `cat .env` dentro do diretório de deploy. Se o arquivo
não existir, acrescente as variáveis extras ao bloco `environment:`.

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

Esses valores vêm do catálogo do `pi-ai` 1.3.0 que embute `deepseek-flash` com
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
  `npm run setup-model -- --list` e então
  `npm run setup-model -- --model llm/<id> --effort high`. Sem isso, o primeiro item do
  catálogo é usado e o bot avisa uma vez por conversa.
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
| `Configure TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN_FILE.`                              | token ausente ou fora de `123456:ABC…`                            | preencha o token do bot                                   |
| `Configure TELEGRAM_ALLOWED_USERS (IDs numéricos …).`                                   | allowlist ausente ou não numérica                                 | informe user IDs                                          |
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
