# Pi-Agent

Um assistente de IA pessoal que vive no Telegram: um container, um volume, nenhum painel web. Roda sobre o harness do [pi.dev](https://pi.dev) e alcança qualquer integração pelo [Executor](https://executor.sh), um único endpoint MCP autenticado.

O repositório e o container mantêm o nome `pi-agent-tg` para não quebrar volumes e deploys existentes.

**O Pi-Agent é um assistente, não um agente de programação.** Ele não traz ferramentas de arquivo, shell, patch ou browser, e não conhece o host, o volume nem o código-fonte. Além da conversa e dos agendamentos, suas únicas capacidades são os servidores MCP que o operador expõe. Trate tudo que volta do MCP como dado externo não confiável.

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

O menu de comandos (`/model`, `/thinking`, `/crons`, `/stop`, `/status`, `/reload`, `/help`) é registrado pelo próprio app ao subir e de novo no `/status` — não há `/setcommands` para fazer.

## Instalação

```sh
git clone https://github.com/forge-z/pi-agent-telegram.git
cd pi-agent-telegram
cp .env.example .env      # token do bot + seu ID numérico do Telegram
docker compose up -d --build
```

Obrigatórias: `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USERS`. Para ter ferramentas, acrescente `EXECUTOR_MCP_URL` + `EXECUTOR_TOKEN`. O resto é opcional e está em [.env.example](.env.example).

## Configuração única

```sh
docker exec -it <container> npm run setup
```

**Rode isto antes de o bot ser útil.** Container novo não tem provedor, então ele registra `Configuração inicial ausente` e espera — fica de pé e saudável em vez de entrar em restart loop, que é o que mantém o terminal disponível. O wizard é o que encerra essa espera:

```
[1] DeepSeek  [2] Gemini  [3] OpenAI  [4] OpenCode Zen
[5] OpenCode Go  [6] OpenRouter  [7] Outro (OpenAI-compatible)
Provedor [1]: 2
Chave de API (não aparece): █                  ← oculta; valida na hora
  ✔ chave válida — 63 modelos listados
Modelo (número ou id): 12
Esforço: high
Modelo do chat: lê imagens                     ← o modelo é sondado, não presumido
IMAGEM — Enter mantém o do chat, "-" desativa
Modelo de visão [usa o do chat]:               ← ou "o" para outro provedor
ÁUDIO — Enter desativa
  [1] OpenAI — whisper-1  [2] Groq  [3] Gemini  [4] Outro
Transcrição [desativada]: 1
Idioma [auto]: pt
Gravar? [y/N] y
Configuração gravada no volume (gemini) — as variáveis LLM_* deixam de ser necessárias.
```

1. **Provedor** — número da lista, id ou URL raiz. "Outro" pede a URL.
2. **Chave** — nunca aparece na tela, e é validada em `GET /models` antes de seguir.
3. **Modelo e esforço** — a lista é o que o provedor realmente serve.
4. **Imagem** — o modelo do chat é sondado; se lê imagens, Enter mantém. `o` abre a lista de provedores de novo (visão no Gemini com chat na DeepSeek), `-` desativa.
5. **Áudio** — endpoint de transcrição, porque endpoint de chat não transcreve; avisa que o modelo precisa aceitar OGG/Opus.
6. **Confirmar** — a escolha vai para `meta`, as chaves para `credentials`, e o bot começa a responder em até dez segundos. Sem restart.

Qualquer passo depois do primeiro pode ser pulado com Enter, e o `npm run setup` pode ser rodado de novo: mostra os valores atuais e mantém o que você não mudar. Variáveis de ambiente continuam valendo e **vencem** o registro.

## Provedores que ele já conhece

| Provedor     | Endpoint                                                  | Observação                                               |
| ------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| DeepSeek     | `https://api.deepseek.com`                                | `deepseek-flash` lê imagens; limites e níveis conhecidos |
| Gemini       | `https://generativelanguage.googleapis.com/v1beta/openai` | superfície OpenAI-compatible; tem free tier              |
| OpenAI       | `https://api.openai.com/v1`                               | também é o caminho de áudio (`/audio/transcriptions`)    |
| OpenCode Zen | `https://opencode.ai/zen/v1`                              | catálogo separado do Go                                  |
| OpenCode Go  | `https://opencode.ai/zen/go/v1`                           | a chave pode não valer nos dois                          |
| OpenRouter   | `https://openrouter.ai/api/v1`                            | muitos modelos, inclusive variantes `:free`              |
| Outro        | qualquer URL raiz                                         | qualquer endpoint que fale a API de completion da OpenAI |

Áudio é configurado à parte, porque endpoint de chat não transcreve: OpenAI, Groq e Gemini aparecem com o modelo padrão de cada um.

## Existe uma API ou um MCP para isso

Steve Jobs fechou o evento do iPad em 2010 com "there's an app for that" ([CBS](https://www.cbsnews.com/news/steve-jobs-at-the-heavenly-gates-theres-an-app-for-that/)). A versão de hoje: antes de o assistente responder que não consegue, vale verificar se já existe uma API ou um servidor MCP que faz. Adicione no [Executor](https://executor.sh) e ele vira ferramenta, com cartão de aprovação antes de qualquer escrita.

| Serviço                                | O que acrescenta                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [AgentMail](https://www.agentmail.to)  | uma caixa de entrada como ferramenta: recebe, responde, envia — 3 caixas e 3.000 e-mails/mês, sem cartão |
| [TinyFish](https://www.tinyfish.ai)    | busca na web e leitura de página — grátis em todos os planos                                             |
| [Fish Audio](https://fish.audio)       | síntese de voz que o assistente chama ([MCP](https://docs.fish.audio/overview/mcp)) — 8.000 créditos/mês |
| [Firecrawl](https://www.firecrawl.dev) | varre um site inteiro e devolve texto limpo                                                              |
| [Browser Use](https://browser-use.com) | um navegador de verdade para páginas que exigem clique, não só leitura                                   |
| [Cal.com](https://cal.com)             | agenda: disponibilidade e marcações como ferramentas                                                     |
| [GitHub](https://github.com)           | repositórios, issues e pull requests ([MCP oficial](https://github.com/github/github-mcp-server))        |
| [Freestyle](https://www.freestyle.sh)  | sandbox descartável com Docker e GPU quando o trabalho precisa de máquina                                |

Mais ou menos na ordem em que um assistente pessoal precisa: e-mail, web, voz, depois scraping, navegação, agenda, código e computação. Voz aqui é o **agente** produzindo áudio como resultado de ferramenta: o bot continua respondendo em texto, e bolha de voz no Telegram não está implementada.

## O que ele faz

- **Texto** — o padrão; sem prefixo, sem cerimônia.
- **Imagem** — modelo que lê imagem recebe a imagem; modelo só-texto recebe uma descrição do `VISION_MODEL`.
- **Recado de voz** — transcrito para o texto do turno; o áudio nunca entra no contexto nem no histórico.
- **Anexos de saída** — o agente pode pedir o envio de um arquivo por URL pública (`send_attachment`), e arquivos que vêm dentro de um resultado de ferramenta também são entregues (áudio, imagem, documento), ele é entregue no chat: áudio como `sendAudio` (bolha de voz quando ogg/opus), imagem como `sendPhoto`, o resto como `sendDocument`. Se o conteúdo traz URL, o Telegram busca o arquivo; só há upload quando existem apenas bytes. Falha de upload não derruba o turno.
- **Origem explícita** — a mensagem convertida chega como `[áudio transcrito · {"origin":"audio","model":"whisper-1"}]`, então o modelo não confunde transcrição com algo digitado. Falha de transcrição é admitida com o motivo, não descartada.
- **Fuso do container** — `TZ` (ex.: `America/Sao_Paulo`) muda só o horário dos logs; agendamentos guardam o próprio timezone IANA e não se movem.
- **Versão do Executor** — a suportada é a **v2 da nuvem** (`https://mcp.executor.sh/mcp`); cada integração é um app do Executor, e nenhuma variável de versão é necessária: o adaptador v1 auto-hospedado só existe para quem ainda lista tools em `ASYNC_JOB_TOOLS`, e está obsoleto (remoção 2026-12-31).
- **Jobs assíncronos por manifesto** — cada job é descrito em `ASYNC_JOB_MANIFESTS` (disparo, como observar, vocabulário de status, caminhos de id/resultado). O núcleo só conhece estado, fila, dedupe e entrega, então integrar outro provedor é escrever manifesto, não patch. O caminho oficial do Executor v2 já vem pronto, sem configuração; `ASYNC_JOB_TOOLS` (v1) segue aceito e está **obsoleto** (remoção 2026-12-31). Referência completa em [docs/jobs.md](docs/jobs.md).
  um tool que dispara um job longo (ex.: automação de navegador) registra a execução e o app acorda um turno novo neste tópico quando ela termina, com o resultado ou um aviso curto se falhar/estourar o tempo. Configure com `ASYNC_JOB_TOOLS` (paths separados por vírgula); a leitura usa `list_runs` do mesmo provedor.
- **Execução silenciosa não gera mensagem** — se o turno de um agendamento (ou de um disparo manual) não sobra nada além de espaços ou caracteres invisíveis, **nada é enviado** e o run fica registrado como `silencioso`. Título de tarefa nunca vira mensagem; `delivery: none` continua sem envio de qualquer forma.
- **Agendamentos** — crie um cron pelo chat; execuções agendadas nunca aprovam nada e nunca criam novos agendamentos. Qualquer agendamento pode ser disparado na hora — **Rodar agora** no `/crons`, ou `tasks_run_now` para o modelo — pelo mesmo pipeline e com a mesma entrega, sem mexer no próximo horário.
- **Aprovações** — toda ferramenta com efeito vira um cartão com Aprovar, Negar e Editar; o resultado é registrado antes de ser entregue.

## Comandos

| Comando     | O que faz                                                               |
| ----------- | ----------------------------------------------------------------------- |
| `/status`   | os três modelos em uso, esforço, MCPs e versão                          |
| `/reload`   | começar uma conversa nova neste chat; o histórico antigo continua salvo |
| `/model`    | provedor e modelo desta conversa                                        |
| `/thinking` | esforço desta conversa                                                  |
| `/crons`    | criar e gerenciar agendamentos                                          |
| `/stop`     | interromper o que está rodando neste tópico                             |
| `/help`     | a mesma lista, no chat                                                  |

## Limites que vale saber

- **O modelo de transcrição precisa aceitar OGG/Opus** — é o único formato que o Telegram manda num recado de voz. `whisper-1`, Gemini e Groq aceitam; a família `gpt-4o-transcribe` não lista ogg.
- **A descoberta informa só ids.** Sem `LLM_MODELS`, todo modelo declara não ter raciocínio e o `/thinking` oferece apenas `off`.
- **Compactação** resume turnos antigos automaticamente, para a conversa não crescer sem fim.
- Histórico, credenciais e registro são tão privados quanto o volume e o host: proteja o volume e os backups.

## Projetos

| Projeto          | Site                                                    | Código                                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pi.dev           | [pi.dev](https://pi.dev)                                | [earendil-works/pi](https://github.com/earendil-works/pi)                           |
| pi-durable       | o harness deste app                                     | [packages/durable](https://github.com/earendil-works/pi/tree/main/packages/durable) |
| Executor         | [executor.sh](https://executor.sh)                      | [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor)           |
| Telegram Bot API | [core.telegram.org](https://core.telegram.org/bots/api) | —                                                                                   |
| Pi-Agent         | este projeto                                            | [forge-z/pi-agent-telegram](https://github.com/forge-z/pi-agent-telegram)           |

Notas de deploy em Coolify e VPS estão em [docs/coolify.md](docs/coolify.md) e [docs/verification.md](docs/verification.md).
