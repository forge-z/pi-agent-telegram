#!/usr/bin/env bash
set -euo pipefail

image="${1:-pi-agent-tg:validation}"
fixture_dir="$(mktemp -d /tmp/pi-tg-container.XXXXXX)"
container="pi-tg-smoke-$$"
volume="pi-tg-smoke-data-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
chmod 755 "$fixture_dir"
cat > "$fixture_dir/telegram.mjs" <<'MOCK'
import {setTimeout} from 'node:timers/promises';
import {TelegramBotApi} from '/app/dist/src/telegram-api.js';
TelegramBotApi.prototype.call = async function(method, payload = {}, signal) {
  if (signal?.aborted) throw new Error('Offline mock stopped');
  if (method === 'getMe') return {id:123, username:'offline_test_bot'};
  if (method === 'getWebhookInfo') return {url:''};
  if (method === 'setMyCommands') return true;
  if (method === 'getUpdates') {
    if ((payload.offset ?? 0) < 2) return [{update_id:1,message:{message_id:1,text:'/status',from:{id:42},chat:{id:-100123,type:'supergroup'},message_thread_id:11}}];
    await setTimeout(30,undefined,{signal});
    return [];
  }
  if (method === 'sendMessage') return {message_id:50};
  if (['sendChatAction','answerCallbackQuery','editMessageText'].includes(method)) return true;
  throw new Error('Unexpected offline Telegram method');
};
MOCK
chmod 644 "$fixture_dir/telegram.mjs"

test "$(docker run --rm --network none --entrypoint id "$image" -u)" = 1000
docker volume create "$volume" >/dev/null
for run in 1 2; do
  docker run -d --name "$container" --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount "type=volume,source=$volume,target=/app/data" \
    --mount "type=bind,source=$fixture_dir,target=/validation,readonly" \
    -e TELEGRAM_BOT_TOKEN=123:offline-container-token \
    -e TELEGRAM_ALLOWED_USERS=42 -e TELEGRAM_ALLOWED_CHATS=-100123 \
    -e LLM_BASE_URL=https://llm.example/v1 \
    -e LLM_API_KEY=synthetic-offline-key \
    -e LLM_MODELS=offline-model \
    --entrypoint node "$image" --import /validation/telegram.mjs dist/src/main.js >/dev/null
  healthy=false
  for attempt in $(seq 1 40); do
    if docker exec "$container" node dist/src/healthcheck.js >/dev/null 2>&1; then healthy=true; break; fi
    sleep 0.25
  done
  if [ "$healthy" != true ]; then echo "Offline heartbeat failed on run $run" >&2; docker logs "$container"; exit 1; fi
  docker exec "$container" node -e '
    const fs=require("node:fs");
    if(fs.existsSync("/app/public")||fs.existsSync("/app/dist/src/server.js")||fs.existsSync("/run/secrets/npm_ca")) process.exit(1);
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync("/app/data/app.sqlite",{readOnly:true});
    if(db.prepare("SELECT count(*) AS n FROM conversations").get().n!==1) process.exit(2);
    db.close();'
  docker stop --time 10 "$container" >/dev/null
  test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
  docker logs "$container" > "$fixture_dir/log" 2>&1
  if grep -qE 'offline-container-token|synthetic-offline-key' "$fixture_dir/log"; then echo 'Synthetic credential appeared in logs' >&2; exit 1; fi
  docker rm "$container" >/dev/null
  echo "Offline container run $run: uid 1000, volume, heartbeat, graceful shutdown OK"
done
