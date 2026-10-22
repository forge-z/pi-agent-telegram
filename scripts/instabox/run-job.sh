#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:-}"

if [[ ! "$JOB_ID" =~ ^[a-z0-9-]{8,40}$ ]]; then
  echo "jobId inválido" >&2
  exit 1
fi

if [ -f "$HOME/.agents-env.sh" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.agents-env.sh"
fi

JOBS_BASE="$HOME/jobs"
JOB_DIR="$JOBS_BASE/$JOB_ID"
STATUS_FILE="$JOB_DIR/status.json"
AGENT_LOG="$JOB_DIR/agent.log"

# `node -e` has no script name: argv is [node, arg, ...]. `[,, x]` skips the first arg.
fail() {
  local err="$1"
  node -e '
    const fs = require("fs");
    const [, statusPath, err] = process.argv;
    const data = { state: "FAILED", error: err, finishedAt: Date.now() };
    fs.writeFileSync(statusPath + ".tmp", JSON.stringify(data));
    fs.renameSync(statusPath + ".tmp", statusPath);
  ' "$STATUS_FILE" "$err"
  exit 1
}

if [ ! -f "$JOB_DIR/request.json" ]; then
  fail "request.json não encontrado no diretório do job"
fi

# Grava status RUNNING de forma atômica
node -e '
  const fs = require("fs");
  const [, statusPath] = process.argv;
  const data = { state: "RUNNING", startedAt: Date.now() };
  fs.writeFileSync(statusPath + ".tmp", JSON.stringify(data));
  fs.renameSync(statusPath + ".tmp", statusPath);
' "$STATUS_FILE"

# Lê parâmetros de request.json via node
REPO=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.repo||"");' "$JOB_DIR/request.json")
AGENT=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.agent||"");' "$JOB_DIR/request.json")
BRANCH=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.branch||"");' "$JOB_DIR/request.json")
PROMPT=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(r.prompt||"");' "$JOB_DIR/request.json")

if [ -z "$REPO" ]; then
  fail "Campo repo não fornecido em request.json"
fi

if [ -z "$BRANCH" ]; then
  BRANCH="agent/$JOB_ID"
fi

WORK_DIR="$HOME/work/$REPO"
mkdir -p "$(dirname "$WORK_DIR")"

if [ ! -d "$WORK_DIR/.git" ]; then
  gh repo clone "$REPO" "$WORK_DIR" > "$JOB_DIR/clone.log" 2>&1 || fail "Falha ao clonar repositório $REPO"
else
  git -C "$WORK_DIR" fetch origin > "$JOB_DIR/fetch.log" 2>&1 || fail "Falha no git fetch do repositório $REPO"
fi

# Cria/reseta branch a partir de origin/HEAD
git -C "$WORK_DIR" checkout -B "$BRANCH" origin/HEAD > "$JOB_DIR/checkout.log" 2>&1 || \
git -C "$WORK_DIR" checkout -B "$BRANCH" HEAD > "$JOB_DIR/checkout.log" 2>&1 || \
fail "Falha ao criar branch $BRANCH no repositório $REPO"

if [ -f "$WORK_DIR/package-lock.json" ]; then
  (cd "$WORK_DIR" && npm ci) > "$JOB_DIR/npm-ci.log" 2>&1 || fail "Falha no npm ci em $REPO"
fi

# Executa agente pedido com timeout de 20 min (1200 segundos) e stdin de /dev/null
set +e
case "$AGENT" in
  agy)
    (cd "$WORK_DIR" && timeout 1200 agy -p "$PROMPT" --dangerously-skip-permissions --add-dir "$JOB_DIR" </dev/null) > "$AGENT_LOG" 2>&1
    AGENT_EXIT=$?
    ;;
  pi)
    (cd "$WORK_DIR" && timeout 1200 pi -p "$PROMPT" </dev/null) > "$AGENT_LOG" 2>&1
    AGENT_EXIT=$?
    ;;
  claude)
    (cd "$WORK_DIR" && timeout 1200 claude -p "$PROMPT" --dangerously-skip-permissions </dev/null) > "$AGENT_LOG" 2>&1
    AGENT_EXIT=$?
    ;;
  *)
    fail "Agente $AGENT desconhecido"
    ;;
esac
set -e

if [ "$AGENT_EXIT" -eq 124 ]; then
  fail "Agente excedeu o tempo limite de 20 minutos (timeout)"
elif [ "$AGENT_EXIT" -ne 0 ]; then
  fail "Agente $AGENT finalizou com erro (código $AGENT_EXIT)"
fi

PR_URL=""
# Verifica se há alterações para commitar e criar PR
if [ -n "$(git -C "$WORK_DIR" status --porcelain)" ]; then
  git -C "$WORK_DIR" add -A > "$JOB_DIR/git.log" 2>&1
  COMMIT_MSG="feat(agent): tarefa $JOB_ID"
  git -C "$WORK_DIR" commit -m "$COMMIT_MSG" >> "$JOB_DIR/git.log" 2>&1 || true
fi

# Se a branch local estiver à frente da origin, faz push normal e cria PR
LOCAL_REV=$(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null || true)
REMOTE_REV=$(git -C "$WORK_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || true)

if [ "$LOCAL_REV" != "$REMOTE_REV" ] && [ -n "$LOCAL_REV" ]; then
  git -C "$WORK_DIR" push -u origin "$BRANCH" >> "$JOB_DIR/git.log" 2>&1 || fail "Falha ao enviar branch $BRANCH para origin"
  PR_URL=$(cd "$WORK_DIR" && gh pr create --fill --head "$BRANCH" 2>> "$JOB_DIR/git.log" || gh pr view --json url -q .url 2>> "$JOB_DIR/git.log" || true)
fi

# Grava status final DONE com JSON.stringify via node de forma atômica
node -e '
  const fs = require("fs");
  const [, statusPath, agentLogPath, prUrl, branch] = process.argv;
  let summary = "";
  try {
    if (fs.existsSync(agentLogPath)) {
      const content = fs.readFileSync(agentLogPath, "utf8");
      summary = content.slice(-1500).trim();
    }
  } catch {}
  const res = {
    state: "DONE",
    result: {
      pr: prUrl ? prUrl.trim() : undefined,
      branch,
      summary: summary || "Tarefa concluída com sucesso.",
    },
    finishedAt: Date.now()
  };
  fs.writeFileSync(statusPath + ".tmp", JSON.stringify(res));
  fs.renameSync(statusPath + ".tmp", statusPath);
' "$STATUS_FILE" "$AGENT_LOG" "$PR_URL" "$BRANCH"

exit 0
