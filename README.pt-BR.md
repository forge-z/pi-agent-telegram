# Pi Bot

Um assistente de IA pessoal que vive no Telegram: um container, um volume, nenhum painel web. Roda sobre o harness do [pi.dev](https://pi.dev). As ferramentas vêm do [Executor](https://executor.sh) e, se quiser, do [Composio](https://composio.dev).

O Pi Bot mantém o serviço do Compose `pi-agent-tg` e o volume `pi_agent_tg_data` para os deploys que já existem. Renomear o volume é uma mudança futura, separada.

**Alfa.** Este projeto ainda está em alfa: espere mudanças incompatíveis, imperfeições e recursos incompletos. Ainda não é recomendado para uso crítico.

## Instalar

```sh
git clone https://github.com/forge-z/pi-bot.git
cd pi-bot
cp .env.example .env
docker compose up -d --build
```

Nenhuma variável de ambiente é obrigatória para o container subir. A imagem é somente leitura, fora o volume em `/app/data` (`app.sqlite` e `durable.sqlite`).

## Configurar

Rode o setup no container antes de usar o bot. Um container novo permanece no ar e saudável enquanto espera.

```sh
docker exec -it <container> npm run setup
```

O menu edita uma seção de cada vez. **Save and back** grava essa seção. **Save and restart gateway** recarrega o bot em execução a partir do volume.

1. **Setup gateway** → **Telegram** — token do bot (oculto; Enter mantém o valor gravado) e os ids numéricos dos usuários permitidos.
2. **Text model** — um provedor oficial do pi-ai, ou `[0]` ChatGPT (OAuth Plus/Pro, sem chave de API). `npm run login` é só OAuth.
3. **Image model**
4. **Audio model**
5. **MCP platform** — Executor, Composio, os dois, ou nenhum.

O Executor decide quais chamadas precisam de aprovação; o bot só encaminha essa pausa. Não há uma segunda aprovação a partir das listas de leitura/escrita. No chat, a pausa é o cartão que já existe. Num run agendado a chamada é enviada, e se o Executor devolver approval-required a ferramenta falha com `needs approval; not available in scheduled runs` mais o caminho da ferramenta. Não há cartão e não há resume. Um servidor sem lista `tools` própria usa as listas do Executor e a mesma regra. O Composio tem lista própria: uma escrita continua recusada antes do envio num run agendado. `writes=true` em `sandbox_code_task` continua esperando o cartão.

Não existe comando `/login`. O OAuth precisa de callback em localhost ou da URL de redirect colada.

Variáveis de ambiente são overrides opcionais. Quando uma está definida, ela vence o valor gravado no volume. `TZ` é o relógio do container (o horário dos logs). Cada agendamento guarda o próprio fuso IANA. O setup não grava `TZ`. Sem ela, o relógio fica em UTC.

Ids de grupo e tópico (`TELEGRAM_ALLOWED_CHATS`) ficam só no ambiente. A reserva compatível (`LLM_BASE_URL` / `LLM_API_KEY`, menu **Other**) é ignorada quando já existe um setup oficial no volume.

### Sandbox

A tarefa longa de código é `sandbox_code_task` (Instabox por padrão). Ela fica desligada até o operador configurar. O config que vem no repositório não nomeia máquina, conta nem repositório.

- `INSTABOX_ACCOUNT_ID` e `INSTABOX_MACHINE_ID` são opcionais. Sem elas, a descoberta usa uma conta só quando existe exatamente uma vinculada, e uma máquina só quando existe exatamente uma em execução. Zero ou várias é um erro que lista o que encontrou. Não há nome de máquina padrão.
- `INSTABOX_REPO_ALLOWLIST` (ou `sandbox_code_task.allow.patterns` em `$DATA_DIR/config.yaml`) é a allowlist de repositórios. O padrão é vazio: nenhum repositório é permitido até você definir a lista. `owner/*` casa com esse dono. A variável de ambiente, quando definida, vence o arquivo.

`writes=true` (push, pull request ou comentário) espera o cartão de aprovação. Sem isso a tarefa é somente leitura.

### Skills do operador

Instruções opcionais no volume valem para toda resposta, inclusive os runs agendados. Cada skill é uma pasta, por exemplo `$DATA_DIR/skills/weekly-review/SKILL.md`:

```md
---
name: weekly-review
description: O que verificar numa revisão semanal
---

Liste o que ainda está aberto na semana e o que pode esperar.
```

Liste as pastas em `$DATA_DIR/config.yaml`. A lista substitui o padrão, que é vazio:

```yaml
skills:
  always:
    - weekly-review
```

Cada corpo é lido uma vez na subida e acrescentado, nessa ordem, ao prompt de sistema, depois das instruções base e antes das seções de MCP. Uma lista vazia, ou uma pasta de skills que não existe, deixa o prompt igual. Um nome ausente, frontmatter inválido ou arquivo ilegível é registrado no log e ignorado. O bot sobe mesmo assim.

## Comandos

O app registra este menu ao subir. Não há o que configurar no BotFather. Os comandos são em inglês.

| Comando     | O que faz                                                                               |
| ----------- | --------------------------------------------------------------------------------------- |
| `/model`    | Provedor e modelo deste tópico                                                          |
| `/thinking` | Esforço deste tópico                                                                    |
| `/crons`    | Criar e administrar agendamentos                                                        |
| `/new`      | Outra conversa neste tópico. A anterior permanece no volume                             |
| `/resume`   | Retoma uma tarefa presa: uma tarefa estacionada após crash, ou um resultado MCP incerto |
| `/stop`     | Para este tópico                                                                        |
| `/status`   | Modelo, MCPs, a execução atual e a versão                                               |
| `/help`     | Esta lista                                                                              |

`/resume` dispensa um resultado MCP incerto sem repetir a chamada (a chamada pode já ter ocorrido) e continua uma tarefa que ficou estacionada depois de um crash. `/new` não limpa um resultado incerto.

Cada tópico nativo (tópico de forum) tem o próprio histórico, modelo e esforço.

## Atualizar

Faça backup do volume antes de atualizar. O primeiro boot desta release migra `pending_jobs` acrescentando colunas. O `ALTER TABLE` do SQLite não tem migração de volta. Na subida, linhas antigas de `mcp_calls` cujo id começa com `mcp-stage:` são apagadas, e uma chamada que ficou `running` é reclassificada (`failed` se era leitura, `uncertain` se era escrita). O poller de jobs apaga em seguida as linhas de jobs já terminados com mais de 30 dias. Linhas abertas permanecem. Não há rollback desses dados: restaure o backup se precisar do volume anterior. A migração anterior do `durable.sqlite` para o schema 2, da release passada, também continua sem rollback.

Voltar a imagem sem restaurar o backup deixa o ledger numa forma que a release anterior pode não ler.

## Notas

- Histórico, credenciais e o ledger são tão privados quanto o volume e o host.
- O assistente não tem shell, arquivo, patch nem browser próprios. O que volta do MCP é dado não confiável.
- Notas de deploy: [docs/coolify.md](docs/coolify.md) e [docs/verification.md](docs/verification.md).
- English: [README.md](README.md).
