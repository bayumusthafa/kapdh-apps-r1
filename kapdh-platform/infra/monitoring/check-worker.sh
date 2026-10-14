#!/bin/sh
# Kesehatan worker -> heartbeat Uptime Kuma (PRD 5.5 "umur job/outbox tertua", ARCHITECTURE §4.8;
# docs/runbooks/monitoring.md). Endpoint GET /healthz worker tidak dirutekan publik, jadi diperiksa dari VPS:
#   WORKER_HEALTH_URL   mis. http://127.0.0.1:3001/healthz bila port dipublikasikan hanya ke loopback host, ATAU
#   WORKER_CONTAINER    nama kontainer worker: diperiksa dengan `docker exec <kontainer> node -e fetch(...)`.
#   KUMA_PUSH_WORKER    URL monitor Push; up hanya bila status "ok" (degraded/error/stopping = down dengan kode isu,
#                       mis. outbox_lagging, dispatcher_failing, scheduler_failing, queue_unreachable).
set -eu

MON_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-check-worker
# shellcheck source=../backup/lib.sh
. "$MON_DIR/../backup/lib.sh"
load_config

BODY=''
if [ -n "${WORKER_HEALTH_URL:-}" ]; then
  require_cmd curl
  # Tanpa -f: 503 tetap membawa body laporan health.
  BODY=$(curl -sS -m 10 "$WORKER_HEALTH_URL" 2>/dev/null || true)
elif [ -n "${WORKER_CONTAINER:-}" ]; then
  require_cmd docker
  BODY=$(docker exec "$WORKER_CONTAINER" node -e \
    "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||3001)+'/healthz',{signal:AbortSignal.timeout(8000)}).then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.exit(1))" \
    2>/dev/null || true)
else
  die "isi WORKER_HEALTH_URL atau WORKER_CONTAINER"
fi

STATUS=$(printf '%s' "$BODY" | sed -n 's/^{"status":"\([a-z]*\)".*/\1/p')
ISSUES=$(printf '%s' "$BODY" | sed -n 's/.*"issues":\[\([^]]*\)\].*/\1/p' | tr -d '"' | cut -c 1-150)
if [ "$STATUS" = ok ]; then
  kuma_push "${KUMA_PUSH_WORKER:-}" up "worker ok" ""
  log "worker ok"
else
  kuma_push "${KUMA_PUSH_WORKER:-}" down "worker ${STATUS:-tidak-terjangkau} ${ISSUES}" ""
  log "worker ${STATUS:-tidak terjangkau}: ${ISSUES}"
  exit 1
fi
