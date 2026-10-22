# Resultado MCP incerto

Quando o Pi-Agent perde o retorno de uma chamada MCP com efeito (timeout, queda de sessão, falha ao gravar o cartão de aprovação), a linha correspondente em `mcp_calls` fica com estado `uncertain`. Isso **persiste no volume SQLite** e sobrevive a redeploy.

## O que continua funcionando

- **Leituras** (`search`, `describe`, `call` com `kind: query`, ferramentas `get`/`list`/… e programas `execute` que só consultam via `tools.search` / `tools.describe` / `pick("…listRuns…")`) **não são bloqueadas**. Uma leitura bem-sucedida dispensa automaticamente o flag incerto da conversa.
- **`/status`** lista chamadas incertas e oferece **Registrar verificação externa**.
- O bot também envia um aviso no tópico (uma vez por chamada incerta) com o mesmo botão de registro.

## Como destravar sem repetir a ação

1. **Verificar no serviço externo** (Executor, Gmail, etc.) se a ação rodou ou não.
2. Em seguida, escolha uma opção:
   - **Registrar verificação externa** no cartão (via `/status` ou o aviso automático) → “Verifiquei: ação concluída” ou “não executada”.
   - **`/destravar`** ou **`/reload`** no mesmo tópico → dispensa todos os resultados incertos **sem apagar o histórico** (o registro passa a `skipped` e aparece no log do processo).

`/stop` encerra esperas locais e aprovações pendentes; **não** remove um resultado incerto já gravado.

## O que não fazer

- Não confie em redeploy sozinho para limpar o estado: o volume mantém `uncertain`.
- Não tente “reenviar” a mesma chamada com o mesmo `taskId`: o ledger recusa replay automático.
