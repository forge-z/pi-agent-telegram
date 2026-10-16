# Pi Agent TG — Telegram + Docker Compose

Versão exclusiva do Telegram, sobre `pi-durable`/`pi-ai` **1.3.0**, Node 24 e SQLite. Sem chat web, servidor HTTP, login de assinatura, browser próprio ou espelhamento. Usa long polling e não expõe porta pública. [Referência completa em inglês](README.md).

**O Pi Agent é um assistente de IA, não um agente de programação.** Ele não traz ferramentas de arquivo, shell, patch, repositório ou browser, e não conhece o host, o volume nem o código-fonte. Além da conversa e das ferramentas internas de agendamento, suas únicas capacidades são os servidores MCP que o operador expõe — ele não vê mais nada. Sem MCP conectado, ele conversa e agenda, e só. Trate tudo que volta do MCP como dado externo não confiável.

Foi feito para rodar com o [Executor](https://executor.sh): a forma preferida de expor todos os MCPs atrás de um único endpoint autenticado, de modo que um `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN` cobre toda a superfície de ferramentas. Roda sobre o [pi.dev](https://pi.dev) e o harness [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).

## Instalação na Oracle

Requer Docker e Compose v2.24+ em Linux amd64/arm64. A imagem oficial Node oferece ambas as arquiteturas e a persistência usa `node:sqlite`. O teste local executa amd64; não houve execução ARM64 neste ambiente.

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env
# Edite .env NO SERVIDOR: token do bot, IDs permitidos e chaves de API.
chmod 600 .env
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
docker compose ps
docker compose logs --tail=50
# Primeira configuração, no terminal do container: escolha o modelo padrão global.
docker compose exec pi-agent-tg npm run setup-model -- --list
docker compose exec pi-agent-tg npm run setup-model -- --model llm/<id> --effort high
```

Deploy no Coolify: veja [docs/coolify.md](docs/coolify.md) — variáveis de runtime no painel, origem do commit, volume e healthcheck.

Use bot dedicado e o novo volume `pi_agent_tg_data`; não conecte o volume de outro deployment. Configure `TELEGRAM_ALLOWED_USERS`. `TELEGRAM_ALLOWED_CHATS` é opcional e, se omitida, usa os mesmos IDs (DM privada). Defina chats só para grupos/supergrupos (IDs negativos). Supergrupos usam IDs negativos. Cada combinação **chat + usuário + tópico nativo** tem uma conversa isolada. Crie os tópicos no próprio Telegram; a conversa local nasce no primeiro uso. Nada é criado no startup. Em grupos, os membros veem as mensagens: use grupos confiáveis e configure a privacidade/permissões do bot no Telegram. Webhook existente ou outro consumidor de polling bloqueiam o início; o aplicativo não remove webhook automaticamente.

### Diagnóstico

**Dentro do container (Coolify → terminal do serviço), após redeploy:**

```sh
node scripts/diagnose-tg-runtime.mjs
```

Ou `npm run diagnose`. O script valida variáveis (sem mostrar segredos), `readConfig`, modelos, MCP e heartbeat.

**No host com Docker Compose (SSH na VM):**

```sh
bash scripts/diagnose-tg-deploy.sh .
```

## Ambiente e modelos

**A primeira configuração é no terminal, não no Telegram.** Abra o terminal do container (Coolify → terminal do serviço) e defina o padrão global ali:

```sh
npm run setup-model -- --list
npm run setup-model -- --model llm/<id> --effort high
```

Esse é o passo inicial pretendido: lista o catálogo e grava o padrão usado por conversas novas. O que os menus do Telegram mudam depois (`/model`, `/thinking`) vale **só para aquela conversa**; o `setup-model` é a única forma de mover o padrão global de dentro do deploy.

`MODEL_PROVIDER` e `MODEL_ID` foram removidas: não há modelo fixado no ambiente. `LLM_BASE_URL` + `LLM_API_KEY` registram um único provedor OpenAI-compatible com id `llm`. A URL é usada literalmente como raiz (`https://api.openai.com/v1`, `https://api.deepseek.com`). Sem `LLM_MODELS`, o catálogo vem de `GET {LLM_BASE_URL}/models`; como a descoberta não informa capacidades, `/thinking` fica só em `off`. Declare o catálogo com limites e níveis: cada entrada é `id` ou `id|contextWindow|maxTokens|reasoning`, e `reasoning` aceita `false`, `true` ou os níveis exatos separados por `+` (ex.: `LLM_MODELS=deepseek-flash|1000000|384000|off+low+high+max` — a DeepSeek recusa `minimal`/`medium` e aceita `max`). Uma conversa sem seleção salva usa o **primeiro item do catálogo** e o bot avisa uma vez por conversa até existir escolha. `/model` e `/thinking` persistem na conversa após restart/redeploy e sempre têm precedência.

Para definir o padrão global (novas conversas) direto do terminal do container:

```sh
npm run setup-model -- --list
npm run setup-model -- --model llm/<id> --effort high
```

Sem argumentos, num terminal interativo, abre um menu numerado. Exemplos das variáveis em [.env.example](.env.example). Não há OAuth de assinatura.

O Compose injeta `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODELS`, `EXECUTOR_MCP_URL` e `EXECUTOR_TOKEN`. **Variável do painel que o compose não declara não chega ao container** — o Coolify só repassa o que o bloco `environment:` mapeia; acrescente a linha ali antes de configurar `TELEGRAM_ALLOWED_CHATS`, `MCP_SERVERS_JSON`, `MCP_CONFIG_FILE` ou `*_FILE`. Os opcionais — `TELEGRAM_ALLOWED_CHATS` (grupos), `LLM_MODELS` (raciocínio além de `off`), `MCP_SERVERS_JSON`, `*_FILE` — **não** são declarados no compose, para não aparecerem como variáveis dele: defina no painel ou no `.env`. Build local: `npm run compose:up` exporta `SOURCE_COMMIT`. Não é preciso habilitar nada no painel do Coolify para o SHA aparecer em `/status`. Substitua os placeholders do `.env.example` por valores reais. A subida imprime mensagens seguras (por exemplo falta de `LLM_API_KEY` ou token Telegram inválido); falhas de rede continuam genéricas.

`EXECUTOR_MCP_URL` define o endpoint HTTPS do Executor neste deploy (auto-hospedado ou nuvem). **Não há URL real no git** — configure na UI do Coolify ou no `.env` do servidor. O Executor só entra na configuração MCP quando `EXECUTOR_TOKEN` também estiver definido (sem token, o bot ainda pode subir, mas ferramentas MCP ficam indisponíveis). `EXECUTOR_TOKEN` é a chave crua (`Authorization: Bearer` é montado pela aplicação). Se `MCP_SERVERS_JSON` estiver preenchido e não for `[]`, ele substitui `EXECUTOR_MCP_URL` (vários servidores). Fora do Compose, vale a mesma regra, ou use `MCP_CONFIG_FILE`. [Exemplo MCP](docs/mcp.example.json). Endpoints exigem HTTPS; HTTP só em loopback para testes/desenvolvimento.

Segredos são variáveis de runtime no servidor/Coolify, nunca argumentos de build. Chaves/tokens aceitam `NAME_FILE` com arquivo montado somente leitura. A aplicação guarda apenas fingerprint do token Telegram no ledger; chaves de IA ficam em memória. Históricos e resultados podem ser sensíveis: proteja volume e backups. Exceções cruas não entram nos logs; valores secretos conhecidos são redigidos na saída Telegram.

## Comandos

| Comando     | Função                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| `/model`    | Menu inline de modelo do catálogo `llm`                                                      |
| `/thinking` | Menu inline dos esforços suportados pelo modelo                                              |
| `/crons`    | Listar, criar, editar, pausar, retomar e excluir; criação/edição/exclusão exigem confirmação |
| `/stop`     | Interromper execução/fila e invalidar aprovações deste tópico; preservar crons futuros       |
| `/status`   | Modelo/esforço, execuções, MCPs/pendências/incertezas, versão e verificação externa          |
| `/help`     | Ajuda                                                                                        |

Não há `/new`, `/topics` ou `/compact`. `//` envia barra literal. A compactação automática da versão instalada usa **modelo e esforço ativos da conversa** ao começar; conserva as entradas originais. Defaults upstream intactos: enabled=true, reserva 16384 tokens, recentes 20000, offset de background 32768. Sem Jev e sem modelo separado de resumo. Há teste comportamental da compactação real com provedor mock.

## Aprovações reais MCP/Executor

O bot reconhece `approval-required`/`input-required` com `requestId`, expiração e invocação original. Mostra ação, destino e conteúdo completo, com botões aprovar/negar quando a revisão é segura. Aprovar usa `resume({requestId,response:{action:"accept",content:{}}})`; negar usa `decline`. **Nunca reexecuta o programa original**. O agente não pode usar `resume` para se autoaprovar. Elicitação MCP nativa responde à requisição pendente existente. Configure Executor em modo MODEL (requestId/response) ou NATIVE (elicitação). Modo BROWSER (approvalUrl/retomada sem response) é recusado, sem exibir o ticket privado.

Callbacks vinculam proprietário autorizado, chat, tópico, conversa, ID/payload da pendência, mensagem original entregue, credencial, nonce de uso único e expiração. Todas as partes da revisão precisam estar entregues. Cliques concorrentes são reivindicados antes da rede. Reinício preserva a pendência Executor; elicitação nativa ao vivo expira sem seu waiter original. Crash após reivindicar uma retomada deixa resultado incerto, sem reenvio. Nova pausa exige novo cartão.

**Limites:** formulário vazio e contrato de revisão reconhecido são necessários. O contrato atual é conservador e limitado a **envio direto de email em texto simples**: aliases explícitos de send-email/send-mail, ou send/send-message/messages-send em namespace mail/Gmail/Outlook; objeto direto com endereços de email explícitos em `to`, `cc`/`bcc` opcionais, `subject` presente e `body` textual não vazio. Endereços podem ser string separada por vírgulas ou array. Aliases exatos aceitos: `recipients`, `to_addresses`/`toAddresses`, `cc_addresses`/`ccAddresses`, `bcc_addresses`/`bccAddresses`; corpo em `text`, `body_text`/`bodyText`. Aliases duplicados, outra capitalização dos campos e qualquer campo adicional são recusados.

Rascunhos/IDs de mensagem/template, reply/forward/resend, wrappers, operações desconhecidas, anexos, raw/MIME/base64/HTML, controles invisíveis, ausência de destinatários/corpo, OAuth/URLs privadas, formulários com campos e revisão ocultada/excessiva ficam **sem Aprovar**. Isso inclui outros MCPs até existir contrato específico de revisão. Permanece Negar e a orientação para o fluxo seguro existente do serviço; o bot não consulta rascunho, inventa conteúdo, decodifica entrada opaca nem repete o programa. Elicitação NATIVE de wrappers `execute`/`code` não comprova a ação subjacente pela prosa: exige revisão externa. Ferramenta nativa direta com argumentos suportados pode responder ao waiter existente; MODEL usa a invocação estruturada.

O envio é reconhecido por vários sinais, não por um único nome: aliases send-email/send-mail, send/send-message/messages-send em namespace mail/Gmail/Outlook, verbos draft/reply/forward/resend, e campos de identificador no topo (`draftId`, `messageId`, `templateId`, `threadId`, `raw`, `mime`, `rfc822`) mesmo com outro nome de ferramenta. `id` sozinho só conta junto com namespace de e-mail ou um desses verbos; o id de um evento de calendário não vira e-mail. Reconhecer não aprova e não busca a mensagem. Se o sinal existe e o contrato não fecha, o cartão fica só com **Negar** e pede revisão no serviço externo.

A invocação Executor só pode ser aprovada com as chaves exatas `app`, `tool` e `input`. Um `draftId` ou qualquer outro campo irmão aparece no cartão e é recusado, mesmo quando `input` tem o e-mail completo. Corpo que é só um token base64 com padding (inclusive curto, como `SGVsbG8=`) é recusado; texto curto comum, como `Hi`, continua aprovável. Objetos aninhados, outra capitalização e aliases duplicados continuam recusados. `JSON.parse` fica com a última chave duplicada. Endereços são ASCII; domínios unicode/punycode são recusados. Este cliente não prova que o servidor remoto envia só os campos revisados e não decodifica conteúdo opaco para achar uma mensagem escondida.

O JSON aparece literalmente, inclusive Markdown, links e backticks. O mesmo contrato é revalidado no clique. Cartões antigos ficam inertes e uma revisão versionada é emitida para a pendência existente, sem executar/retomar a chamada. Nomes e formatos suportados não provam honestidade do servidor nem verificam sua conta externa; use MCPs confiáveis. O cliente não obriga todos os servidores a pedir confirmação de cada efeito.

`/stop` cancela a espera local e aborta transporte; uma execução já pausada no Executor fica para expirar no serviço, sem autorização local. Isso não desfaz efeitos externos. `/status` mostra resultados incertos e mantém esse servidor bloqueado na conversa. Após verificar externamente, o dono pode confirmar o resultado observado pelos controles inline. Esse registro é uma declaração do usuário, não uma repetição da ação. Se a revisão não puder ser exibida com segurança, mantenha bloqueado e inspecione o serviço.

## Crons, volume e operação

O botão criar em `/crons` pede quatro linhas: título, cron de 5 campos ou data ISO com offset, fuso IANA, instrução completa (pode ocupar mais linhas). Em seguida apresenta prévia e confirmação. Chat/usuário/tópico/bot/conversa de origem são imutáveis no cron e em cada ocorrência admitida. Destino removido/revogado/fechado falha explicitamente, sem fallback. Pausa/exclusão impede ocorrências futuras; execução já admitida pode terminar. Agendar não aprova ações externas futuras.

### Execuções agendadas

Cada ocorrência fica registrada por **7 dias**: início/fim, status (`ok`, `erro`, `silencioso`), resumo curto e as ferramentas MCP que concluíram — mais as que tiveram aprovação pulada. O assistente lê com a ferramenta `tasks_runs`, filtrando por agendamento e período (padrão: últimas 24h).

A entrega é o tópico do próprio agendamento. `tasks_edit` alterna entre **origin** (posta naquele tópico) e **none** (nenhuma mensagem, só efeitos colaterais). Não existe destino web, e o agendamento nunca muda de chat ou tópico.

Resposta vazia, só espaços ou apenas `<silent/>` não posta nada e é registrada como `silencioso`; o sentinela nunca é enviado. Dentro de uma execução agendada, um pedido de aprovação MCP não é aguardado: o passo é pulado, marcado como `skipped` no ledger e no log, e a execução segue. O assistente continua sem aprovar ou retomar pendências por conta própria.

Turno que termina **sem resposta** não fica mais em silêncio: o chat recebe a **categoria** que o pi-durable reporta (`model_error`, `no_model`, `stale`, `reset`) e o log de execução guarda a categoria mais o detalhe upstream, legível com `tasks_runs`. A exceção é `/stop`: aborto pedido pelo usuário continua silencioso. Só a categoria chega ao chat — texto cru do provedor nunca é repassado, então um erro de provider não vaza segredo nem o texto. Se aparecer `model_error` com detalhe de compactação, confira se o `LLM_MODELS` declara os limites reais do modelo: sem ele os padrões conservadores da descoberta (32768 de contexto / 4096 de saída) não deixam quase espaço para a compactação automática, e o resumo dela falha.

O volume mantém `app.sqlite` e `durable.sqlite` com WAL: histórico, mapeamentos, preferências, crons e registros de entrega/aprovação. Use uma réplica; o lock impede dois donos do diretório. Pare o container para copiar o volume inteiro. `docker compose down` preserva os dados; **`down -v` apaga o volume**. Reconstrua passando `SOURCE_COMMIT` para identificar a versão em `/status`.

Container sem root (uid 1000), filesystem somente leitura, capabilities removidas, SIGTERM/SIGINT gracioso. Healthcheck verifica heartbeat local fresco após polling bem-sucedido e fila; não chama IA/ferramentas e não garante que todos os MCPs estejam online. Erros transitórios têm backoff. Resultado ambíguo de envio Telegram exige verificação, sem reenvio automático que poderia duplicar mensagem.

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm run build
npm test
docker compose config --quiet
```

Testes usam mocks, SDK MCP real em loopback, SQLite temporário e smoke de container offline. Nenhum email, bot real, chamada paga ou deploy é necessário. [Evidências e limites](docs/verification.md).
