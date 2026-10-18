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

O menu de comandos (`/model`, `/thinking`, `/crons`, `/stop`, `/status`, `/help`) é registrado pelo próprio app ao subir e de novo no `/status` — não há `/setcommands` para fazer.

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

## MCPs recomendados

Tudo o que o assistente **faz** além de conversar vem de servidores MCP. Adicione um no [Executor](https://executor.sh) e ele aparece como ferramenta, com cartão de aprovação antes de qualquer escrita.

| Serviço                               | O que acrescenta                                                                                                                  | Onde         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| [AgentMail](https://www.agentmail.to) | uma caixa de entrada como ferramenta: recebe, responde e envia — o cartão de aprovação é a última chance antes de a mensagem sair | agentmail.to |
| [TinyFish](https://www.tinyfish.ai)   | busca na web e leitura de página, para a resposta vir da página em vez da memória                                                 | tinyfish.ai  |
| [Fish Audio](https://fish.audio)      | síntese de voz que o assistente pode chamar ([docs de MCP](https://docs.fish.audio/overview/mcp))                                 | fish.audio   |

Esses três são os primeiros que valem ligar: e-mail, web e voz cobrem a maior parte do que se pede a um assistente pessoal. Voz aqui significa o **agente** produzindo áudio como resultado de ferramenta — o bot continua respondendo em texto; resposta falada não está implementada.

## Free tiers bastam para experimentar

- **Google AI Studio** ([aistudio.google.com](https://aistudio.google.com), [preços](https://ai.google.dev/pricing)) — o free tier do Gemini cobre **visão** (imagem vira descrição) e **áudio** (recado vira transcrição), sem cartão de crédito. As cotas são por minuto e por dia, e o Google pode usar conteúdo do free tier para melhorar seus produtos: ótimo para testar, pense duas vezes antes de mandar um documento pessoal ou um recado de voz.
- **Groq** ([groq.com](https://groq.com)) — free tier para transcrição com Whisper, rápido o suficiente para recados.
- **OpenRouter** ([openrouter.ai](https://openrouter.ai)) — modelos `:free` para todas as modalidades, com limite de requisições.

Uma chave gratuita do Gemini e um bot no Telegram já são o conjunto completo mais barato: um provedor, duas funções.

## O que ele faz

- **Texto** — o padrão; sem prefixo, sem cerimônia.
- **Imagem** — modelo que lê imagem recebe a imagem; modelo só-texto recebe uma descrição do `VISION_MODEL`.
- **Recado de voz** — transcrito para o texto do turno; o áudio nunca entra no contexto nem no histórico.
- **Origem explícita** — a mensagem convertida chega como `[áudio transcrito · {"origin":"audio","model":"whisper-1"}]`, então o modelo não confunde transcrição com algo digitado. Falha de transcrição é admitida com o motivo, não descartada.
- **Agendamentos** — crie um cron pelo chat; execuções agendadas nunca aprovam nada e nunca criam novos agendamentos.
- **Aprovações** — toda ferramenta com efeito vira um cartão com Aprovar, Negar e Editar; o resultado é registrado antes de ser entregue.

## Comandos

| Comando     | O que faz                                      |
| ----------- | ---------------------------------------------- |
| `/status`   | os três modelos em uso, esforço, MCPs e versão |
| `/model`    | provedor e modelo desta conversa               |
| `/thinking` | esforço desta conversa                         |
| `/crons`    | criar e gerenciar agendamentos                 |
| `/stop`     | interromper o que está rodando neste tópico    |
| `/help`     | a mesma lista, no chat                         |

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
