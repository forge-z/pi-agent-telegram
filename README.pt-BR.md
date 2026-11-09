# Pi-Agent

Um assistente de IA pessoal que vive no Telegram: um container, um volume, nenhum painel web. Roda sobre o harness do [pi.dev](https://pi.dev) e alcança qualquer integração pelo [Executor](https://executor.sh), um único endpoint MCP autenticado.

O repositório e o container mantêm o nome `pi-agent-tg` para não quebrar volumes e deploys existentes.

**O Pi-Agent é um assistente, não um agente de programação.** Ele não traz ferramentas de arquivo, shell, patch ou browser, e não conhece o host, o volume nem o código-fonte. Além da conversa e dos agendamentos, suas únicas capacidades são os servidores MCP que o operador expõe. Trate tudo que volta do MCP como dado externo não confiável.

**Alfa.** Este projeto ainda está em alfa: espere mudanças incompatíveis, imperfeições e recursos incompletos. Ainda não é recomendado para uso crítico.

## Docker + Telegram + Executor

**Docker** embala tudo: uma imagem, um volume em `/app/data`, sistema de arquivos somente leitura, nenhum segredo em argumento de build. Roda em qualquer VPS amd64 ou arm64, e o estado são dois arquivos SQLite.

**Telegram** é a única interface — não há porta HTTP para expor. Um tópico nativo é uma conversa: cada um guarda histórico, modelo e esforço próprios. Imagem e recado de voz chegam como anexo, e o bot responde onde foi perguntado.

**Executor** é o único endpoint de ferramentas. Ele transforma qualquer serviço OpenAPI, MCP ou GraphQL numa ferramenta atrás de uma chave, então e-mail, calendário, repositório ou sandbox aparecem para o assistente sem que este app guarde essas credenciais. Toda chamada com efeito pausa para um cartão de aprovação, e o registro guarda o que foi decidido.

## Criar o bot no Telegram

1. Abra o **@BotFather**, mande `/newbot`, escolha nome e um usuário terminado em `bot`. Ele responde com o **token** — é o `TELEGRAM_BOT_TOKEN`.
2. Pegue seu **ID numérico**: mande qualquer mensagem para o bot novo e rode

   ```sh
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"from":{"id":[0-9]*' | head -1
   ```

   Esse número é o `TELEGRAM_ALLOWED_USERS`. (O bot não pode falar com você primeiro: aperte **Start** na conversa.)

3. Opcional, para grupo: adicione o bot e, no **@BotFather**, `/setprivacy` → **Disable**; sem isso o Telegram só entrega comandos e menções. O id negativo do grupo vai em `TELEGRAM_ALLOWED_CHATS`.
4. Opcional, para uma conversa por tópico: transforme o grupo em **fórum** (configurações do grupo → Tópicos). Cada tópico fica com histórico, modelo e esforço próprios, sem configuração extra.

O menu de comandos (`/model`, `/thinking`, `/crons`, `/stop`, `/status`, `/reload`, `/new`, `/resume`, `/help`) é registrado pelo próprio app ao subir e de novo no `/status` — não há `/setcommands` para fazer. `/retomar` continua retomando uma tarefa estacionada, e `/destravar` continua dispensando um MCP incerto; nenhum dos dois aparece no menu.

## Instalação

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env      # token do bot + seu ID numérico do Telegram
docker compose up -d --build
```

Obrigatórias: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USERS`. Para ter ferramentas, acrescente `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN`. O resto é opcional e está em [.env.example](.env.example).

Esse par registra um servidor **direct** (o padrão, também quando `mode` é omitido). As ferramentas do Executor — search, describe, call, execute, resume, skills — continuam no prompt com o schema completo, e uma chamada com efeito continua parando no cartão "Aprovação MCP pendente". Um MCP grande ao lado pode usar `"mode": "deferred"`: os schemas ficam ocultos até o modelo chamar `tool_search`. Nomes em `alwaysLoad` continuam direct. `allowedTools` e `deniedTools` valem nos dois modos. O Executor permanece direct:

```json
[
  {
    "name": "executor",
    "url": "https://executor.example/mcp",
    "tokenEnv": "EXECUTOR_TOKEN"
  },
  {
    "name": "github",
    "url": "https://github.example/mcp",
    "tokenEnv": "GH_TOKEN",
    "mode": "deferred",
    "alwaysLoad": ["search_code"]
  }
]
```

## Configuração única

```sh
docker exec -it <container> npm run setup
```

**Rode isto antes de o bot ser útil.** Container novo não tem provedor, então ele registra `Configuração inicial ausente` e espera — fica de pé e saudável em vez de entrar em restart loop, que é o que mantém o terminal disponível. O wizard é o que encerra essa espera:

```
[0] ChatGPT (assinatura Plus/Pro — OAuth, sem chave de API)
[1] Anthropic — catálogo oficial
…
[n] Outro (OpenAI-compatible) — reserva opcional
Provedor [1]: 0
Assinatura [1] Sign in with ChatGPT (openai) [2] Codex legado (openai-codex) [1]: 1
Siga o login OAuth abaixo (código de dispositivo ou cole a URL de redirect se pedido).
…
openai/gpt-5  —  esforços: off low high
Modelo (número ou id): 1
Esforço: high
Configuração gravada no volume (openai, authMode=chatgpt) — o registro do volume basta.
```

Ou escolha um provedor oficial (Anthropic, Google, OpenAI, Groq, …) para chave de API:

```
Provedor [1]: anthropic
Chave de API (não aparece): █                  ← oculta; não vai para o histórico
  ✔ chave guardada para anthropic — catálogo oficial
Modelo (número ou id): 3
Esforço: high
Modelo do chat: lê imagens (catálogo pi-ai)
…
Configuração gravada no volume (anthropic) — chave em credentials com esse id.
```

1. **Provedor** — **`[0] ChatGPT`** (OAuth, o mesmo login do `npm run login`) ou um id nativo do pi-ai. O último item, **Outro**, é a reserva OpenAI-compatible e não é o caminho oficial.
2. **Chave** — só no modo chave de API; nunca aparece na tela. No provedor oficial ela fica em `credentials` com o id do provedor (`anthropic`, `google`, `openai`, …). `GET /models` só roda na reserva compatível.
3. **Modelo e esforço** — catálogo oficial: API nativa, janela de contexto, níveis de raciocínio e preços. O `/model` lista `provedor/modelId` e só troca o modelo; não pede chave nem login.
4. **Imagem** — no provedor oficial vem do catálogo. `o` ainda pode apontar a visão para outro endpoint compatível, `-` desativa.
5. **Áudio** — endpoint de transcrição, porque endpoint de chat não transcreve; avisa que o modelo precisa aceitar OGG/Opus.
6. **Confirmar** — a escolha vai para `meta`, a chave para `credentials`, e o bot começa a responder em até dez segundos. Sem restart. `LLM_BASE_URL` e `LLM_API_KEY` não são necessárias.

O `npm run setup` pode ser rodado de novo. Um setup oficial completo **não** é substituído por `LLM_BASE_URL` / `LLM_API_KEY` deixadas no ambiente. Essas duas variáveis só valem na reserva compatível, e só quando não há setup oficial no volume.

## Assinatura ChatGPT (sem chave de API)

Para usar a **assinatura ChatGPT Plus/Pro** (Sign in with ChatGPT ou Codex legado):

1. Suba o container. `LLM_AUTH=chatgpt` é opcional; o registro no volume basta. Não defina `LLM_API_KEY`.
2. Sem login, ele fica aguardando, saudável, como no wizard inicial.
3. No terminal do container (precisa de TTY para colar a URL de retorno):

   ```sh
   docker exec -it <container> npm run login
   ```

   Por padrão entra no fluxo **Sign in with ChatGPT** (`openai`). O script imprime a URL de autorização; abra no navegador do operador. Se o callback em `localhost:1455` não existir no servidor (Docker típico), **cole a URL final de redirecionamento** quando o terminal pedir.

   Codex legado (modelos GPT-5.x Codex):

   ```sh
   docker exec -it <container> npm run login -- openai-codex --device-code
   ```

   O fluxo `--device-code` só precisa abrir o link e confirmar o código — não usa callback local; é o mais simples em VPS.

4. Tokens OAuth ficam no volume (`app.sqlite`, tabela `credentials`); o pi-ai renova automaticamente. Escolha o modelo em `/model` (provedores `openai` ou `openai-codex`).

Logout: `npm run login -- --logout openai`.

**Por que não há `/login` no Telegram:** o Sign in with ChatGPT exige callback OAuth em `localhost` ou colar a URL de redirecionamento completa — não há fluxo só “abrir link e pronto” confiável sem interação no terminal. O Codex aceita device code, mas ainda exige digitar o código no site; o CLI no container é o caminho suportado.

A Anthropic neste bot é chave de API, não login de assinatura Claude. A assinatura ChatGPT pode ser configurada **no próprio `npm run setup` (`[0]`)** ou com `npm run login`; os provedores `openai` / `openai-codex` aparecem no `/model` depois do OAuth.

`npm run setup` é o assistente completo, inclusive visão e áudio. `npm run login` é só OAuth (e o device-code do Codex sem TTY). Os dois gravam no volume. Não há terceiro comando. Quando o login não encontra modelo, grava o primeiro do catálogo; `/model` troca.

## Provedores

O menu lista cada provedor do pi-ai que aceita uma chave só (Anthropic, OpenAI, Google, Groq, xAI, DeepSeek, Mistral, OpenRouter, OpenCode Zen, OpenCode Go e o resto desse catálogo). Cada um usa a API nativa, a janela de contexto, os níveis de raciocínio e os preços da biblioteca. A lista sai do catálogo instalado, não de uma segunda tabela neste repositório.

| Caminho         | O que é                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| Chave oficial   | `npm run setup`; a chave fica em `credentials.provider = <id do pi-ai>`    |
| ChatGPT / Codex | `npm run login` ou `[0]` no setup; provedores `openai` e `openai-codex`    |
| Outro           | reserva OpenAI-compatible (`llm`), para proxy ou host que o pi-ai não traz |

Áudio é configurado à parte, porque endpoint de chat não transcreve: OpenAI, Groq e Gemini aparecem com o modelo padrão de cada um.

Um volume antigo com `credentials.provider = 'llm'` continua de pé. No próximo start, se `LLM_BASE_URL` / `LLM_API_KEY` estiverem vazias e o modelo salvo existir no catálogo nativo, a chave é copiada para esse provedor. Se o modelo não estiver no catálogo, o bot segue no endpoint compatível.

## Existe uma API ou um MCP para isso

Steve Jobs fechou o evento do iPad em 2010 com "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). A versão de hoje: antes de o assistente responder que não consegue, vale verificar se já existe uma API ou um servidor MCP que faz. Adicione no [Executor](https://executor.sh) e ele vira ferramenta, com cartão de aprovação antes de qualquer escrita.

| Serviço                                | O que acrescenta                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | uma caixa de entrada como ferramenta: recebe, responde, envia — 3 caixas e 3.000 e-mails/mês, sem cartão                                              |
| [Browser Use](https://browser-use.com) | um navegador de verdade para páginas que exigem clique, não só leitura                                                                                |
| [Cal.com](https://cal.com)             | agenda: disponibilidade e marcações como ferramentas                                                                                                  |
| [Firecrawl](https://www.firecrawl.dev) | varre um site inteiro e devolve texto limpo                                                                                                           |
| [Fish Audio](https://fish.audio)       | síntese de voz que o assistente chama ([MCP](https://docs.fish.audio/overview/mcp)) — 8.000 créditos/mês                                              |
| [GitHub](https://github.com)           | repositórios, issues e pull requests ([MCP oficial](https://github.com/github/github-mcp-server))                                                     |
| [Instabox](https://instabox.sh)        | um sandbox Linux como ferramenta: shell de verdade, navegador e disco persistente — roda código, gera e publica artefatos; 5 máquinas no plano grátis |
| [TinyFish](https://www.tinyfish.ai)    | busca na web e leitura de página — grátis em todos os planos                                                                                          |

Mais ou menos na ordem em que um assistente pessoal precisa: e-mail, web, voz, depois scraping, navegação, agenda, código e computação. Voz aqui é o **agente** produzindo áudio como resultado de ferramenta: o bot continua respondendo em texto, e bolha de voz no Telegram não está implementada.

## O que ele faz

- **Texto** — o padrão; sem prefixo, sem cerimônia.
- **Steer automático** — mensagens enviadas no meio de uma tarefa entram como steer no turno em andamento (após a rodada de ferramentas atual) sem abrir turno novo; /stop cancela.
- **Imagem** — modelo que lê imagem recebe a imagem; modelo só-texto recebe uma descrição do `VISION_MODEL`.
- **Recado de voz** — transcrito para o texto do turno; o áudio nunca entra no contexto nem no histórico.
- **Anexos de saída** — o agente pode pedir o envio de um arquivo por URL pública (`send_attachment`), e arquivos que vêm dentro de um resultado de ferramenta também são entregues (áudio, imagem, documento), ele é entregue no chat: áudio como `sendAudio` (bolha de voz quando ogg/opus), imagem como `sendPhoto`, o resto como `sendDocument`. Se o conteúdo traz URL, o Telegram busca o arquivo; só há upload quando existem apenas bytes. Falha de upload não derruba o turno.
- **Origem explícita** — a mensagem convertida chega como `[áudio transcrito · {"origin":"audio","model":"whisper-1"}]`, então o modelo não confunde transcrição com algo digitado. Falha de transcrição é admitida com o motivo, não descartada.
- **Fuso do container** — `TZ` (ex.: `America/Sao_Paulo`) muda só o horário dos logs; agendamentos guardam o próprio timezone IANA e não se movem.
- **Versão do Executor** — a suportada é a **v2 da nuvem** (`https://mcp.executor.sh/mcp`); cada integração é um app do Executor. Jobs são manifestos (`ASYNC_JOB_MANIFESTS`) ou os embutidos do TinyFish e do Instabox. A conta da leitura vem da chamada. `ASYNC_JOB_TOOLS` e `EXECUTOR_ACCOUNT_ID` não são lidas.
- **Jobs assíncronos por manifesto** — cada job é descrito em `ASYNC_JOB_MANIFESTS` (disparo, como observar, vocabulário de status, caminhos de id/resultado). O núcleo só conhece estado, fila, dedupe e entrega, então integrar outro provedor é escrever manifesto, não patch. Tarefas de código na sandbox Instabox (`instabox_code_task`) rodam em segundo plano e entregam o resultado (incluindo link de PR) via poller de status. O caminho oficial do Executor v2 já vem pronto, sem configuração. Referência completa em [docs/jobs.md](docs/jobs.md).
- **Resultado MCP incerto** — quando o provedor perde o retorno de uma chamada, a conversa para de executar ações até alguém verificar. **Leituras continuam funcionando** (incluindo `execute` só de consulta no Executor), uma leitura bem-sucedida já dispensa a pendência, o tópico recebe um aviso com botão de registro, e `/reload` (atalho `/destravar`) limpa o flag **sem apagar o histórico**. Detalhes em [docs/mcp-uncertain.md](docs/mcp-uncertain.md).
- **Agendamento fala só por `notify`** — o texto final de um run que não é um turno do usuário (agenda, disparo manual, job) **não é entregue**. Para avisar, o modelo chama `notify`, que posta no chat e no tópico daquele agendamento e pode ser chamada mais de uma vez. Texto que fica vazio depois de tirar espaços e caracteres invisíveis é recusado e nada sai. `replyTo` é o `message_id` de uma mensagem já vista neste mesmo chat; se não der para confirmar, o reply é ignorado e o aviso sai no tópico mesmo assim. Os ids recentes entram no contexto do run. Se não houver o que relatar, o modelo não chama nada: o run fica `silencioso` e o texto final vai para o log, com o id da rotina. Falha do runner (exceção, timeout, erro de provedor, tarefa estacionada, erro de job) continua sendo avisada pelo sistema, com a causa, e não depende do modelo. `delivery: none` continua sem envio.
- **Resposta no Telegram** — quando a mensagem responde outra (e quando traz uma citação), o turno recebe o id, o autor (bot ou usuário) e o texto ou a legenda, truncados se forem longos.
- **Agendamentos** — crie um cron pelo chat; execuções agendadas nunca aprovam nada e nunca criam novos agendamentos. Qualquer agendamento pode ser disparado na hora — **Rodar agora** no `/crons`, ou `tasks_run_now` para o modelo — pelo mesmo pipeline e com a mesma entrega, sem mexer no próximo horário.
- **Aprovações** — toda ferramenta com efeito vira um cartão com Aprovar, Negar e Editar; o resultado é registrado antes de ser entregue.

## Comandos

| Comando     | O que faz                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------- |
| `/status`   | os três modelos em uso, esforço, MCPs (erro, quantidade e nomes) e versão                    |
| `/reload`   | dispensar resultado MCP incerto desta conversa (histórico intacto). `/destravar` faz o mesmo |
| `/new`      | outra conversa neste tópico; a anterior permanece no volume. `/nova` faz o mesmo             |
| `/resume`   | executar de novo uma tarefa estacionada depois de quedas seguidas. `/retomar` faz o mesmo    |
| `/model`    | provedor e modelo desta conversa                                                             |
| `/thinking` | esforço desta conversa                                                                       |
| `/crons`    | criar e gerenciar agendamentos                                                               |
| `/stop`     | interromper o que está rodando neste tópico                                                  |
| `/help`     | a mesma lista, no chat                                                                       |

## Limites que vale saber

- **O modelo de transcrição precisa aceitar OGG/Opus** — é o único formato que o Telegram manda num recado de voz. `whisper-1`, Gemini e Groq aceitam; a família `gpt-4o-transcribe` não lista ogg.
- **A reserva compatível informa só ids.** Sem `LLM_MODELS`, um modelo do provedor `llm` declara não ter raciocínio e o `/thinking` oferece apenas `off`. Provedores oficiais já declaram os níveis.
- **Compactação** resume turnos antigos automaticamente, para a conversa não crescer sem fim.
- Histórico, credenciais e registro são tão privados quanto o volume e o host: proteja o volume e os backups.
- **Upgrade a partir do Pi 1.3.** O primeiro boot migra o `durable.sqlite` para o schema 2, e essa migração não tem rollback. Faça backup do volume antes do deploy. Voltar a imagem sem restaurar esse backup deixa o ledger num schema que o release anterior não lê. Esta release não adiciona outra migração.

## Projetos

| Projeto          | Site                                                    | Código                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pi.dev           | [pi.dev](https://pi.dev)                                | [earendil-works/pi](https://github.com/earendil-works/pi)                           |
| pi-durable       | o harness deste app                                     | [packages/durable](https://github.com/earendil-works/pi/tree/main/packages/durable) |
| Executor         | [executor.sh](https://executor.sh)                      | [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor)           |
| Telegram Bot API | [core.telegram.org](https://core.telegram.org/bots/api) | —                                                                                   |
| Pi-Agent         | este projeto                                            | [forge-z/pi-agent-telegram](https://github.com/forge-z/pi-agent-telegram)           |

Notas de deploy em Coolify e VPS estão em [docs/coolify.md](docs/coolify.md) e [docs/verification.md](docs/verification.md).
