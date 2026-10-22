#!/usr/bin/env bash
# Offline-safe checks for the pi-agent-tg Telegram deployment. Never prints secret values.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

section() {
  printf '\n=== %s ===\n' "$1"
}

mask_env() {
  awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key=$1
      val=substr($0, length(key)+2)
      if (val == "") status="VAZIO"
      else if (val ~ /^replace_with/i) status="PLACEHOLDER"
      else status="definido"
      print key "=" status
    }
  '
}

section "Host e diretório"
pwd
command -v docker >/dev/null && docker --version || echo "docker: ausente"
docker compose version 2>/dev/null || echo "docker compose: ausente"
git rev-parse --abbrev-ref HEAD 2>/dev/null || true
git rev-parse --short HEAD 2>/dev/null || true

section "Arquivo .env (somente presença, sem valores)"
if [[ -f .env ]]; then
  mask_env < .env
else
  echo ".env: AUSENTE (copie .env.example e edite no servidor)"
fi

section "docker compose config"
if docker compose config --quiet 2>/dev/null; then
  echo "compose config: OK"
else
  echo "compose config: FALHOU"
  docker compose config 2>&1 | tail -20 || true
fi

section "Containers"
docker compose ps 2>/dev/null || true

SERVICE=pi-agent-tg
section "Últimas linhas de log (sem filtro de segredo — revise antes de colar em chat público)"
docker compose logs --tail=80 "$SERVICE" 2>/dev/null || echo "sem logs para $SERVICE"

section "Healthcheck do container"
CID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
if [[ -n "$CID" ]]; then
  docker inspect --format 'State={{.State.Status}} Health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} ExitCode={{.State.ExitCode}}' "$CID"
  if docker exec "$CID" node dist/src/healthcheck.js >/dev/null 2>&1; then
    echo "healthcheck exec: OK"
  else
    echo "healthcheck exec: FALHOU (container up mas heartbeat/polling pode estar ruim)"
  fi
else
  echo "container $SERVICE não está rodando"
fi

section "Variáveis efetivas no container (mascaradas)"
if [[ -n "${CID:-}" ]]; then
  docker exec "$CID" sh -c 'for k in TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TELEGRAM_ALLOWED_CHATS LLM_API_KEY LLM_BASE_URL EXECUTOR_TOKEN EXECUTOR_MCP_URL; do v="${!k-}"; if [ -z "$v" ]; then echo "$k=VAZIO"; elif printf "%s" "$v" | grep -qi replace_with; then echo "$k=PLACEHOLDER"; else echo "$k=definido"; fi; done' 2>/dev/null || true
fi

section "Dicas rápidas"
cat <<'EOF'
- TELEGRAM_ALLOWED_CHATS é opcional (omita em DM; supergrupo = negativo, ex. -100…).
- TELEGRAM_ALLOWED_USERS = user ID de quem controla o bot (@userinfobot no privado).
- Chat privado: CHATS pode ser o mesmo ID positivo do seu usuário.
- LLM_BASE_URL + LLM_API_KEY registram um provedor OpenAI-compatible (id llm).
- Sem LLM_MODELS o catálogo vem de GET {LLM_BASE_URL}/models e fica sem reasoning.
- Padrão global: npm run setup-model -- --list | --model llm/<id> [--effort high].
- Rebuild após git pull: SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
- Um processo por volume: use o volume dedicado pi_agent_tg_data.
EOF
