# Resultado MCP incerto

Quando uma escrita MCP perde o retorno (timeout, queda depois do envio, falha ao gravar o cartão), a linha em `mcp_calls` fica `uncertain`. Isso fica no SQLite e sobrevive a reinício. A chamada não é reenviada. A incerteza bloqueia novas ações **naquele servidor**; outro servidor da mesma conversa continua. Uma leitura continua disponível e **não** apaga a incerteza.

`/resume` marca todas as incertezas da conversa como `skipped` e registra no log. A resposta avisa, em inglês, que a chamada pode já ter sido executada (por exemplo, um e-mail pode ter saído) antes de o agente continuar. O mesmo comando também retoma uma tarefa estacionada por quedas, e faz as duas coisas numa resposta só quando as duas estão pendentes. `/status` lista cada incerteza e oferece o cartão de verificação. O cartão mostra servidor, ferramenta, alvo e parâmetros em texto. Se o conteúdo teve de ser ocultado, os botões de confirmação não aparecem e o texto aponta `/resume` como saída.

## O que conta como leitura

Nomes que começam com `get`, `list`, `read`, `search`, `fetch`, `find`, `query`, `describe`, `show`, `view` ou `status`, mais um conjunto pequeno de caminhos conhecidos (`tools.instabox.machines.list`, `tools.tinyfish.fetch.root.fetchUrls` e os outros em `KNOWN_READS`). O mesmo coletor de caminhos vale para um `call` direto, um lote `calls` e um envelope `execution`. O lote só é leitura se todo caminho coletado for leitura. `resume` nunca é leitura: o modelo não pode chamar `resume`; só a decisão humana em `decide` despacha.

## O que não é incerteza

`McpNotSentError` e `PolicyError` aconteceram antes do envio e ficam `failed`. Uma rejeição do Executor `InputInvalid` / `UnknownTool` (inclusive HTTP 422) sem `toolCalls` bem-sucedidos também fica `failed`, com um aviso de que nada foi despachado. Qualquer outro erro de escrita fica `uncertain`.

Linhas antigas `mcp-stage:*` são apagadas na subida. Um `running` de leitura vira `failed`; um `running` de escrita vira `uncertain`.
