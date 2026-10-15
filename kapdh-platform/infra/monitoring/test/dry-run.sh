#!/bin/sh
# Uji kering pemeriksa monitoring KAPDH (infra/monitoring/check-*.sh; docs/runbooks/monitoring.md) dengan alat tiruan
# (curl, restic, psql, docker di infra/monitoring/test/stubs). Membuktikan keputusan up/down setiap monitor Push Uptime
# Kuma, pesan tanpa data pribadi, dan kode keluar. df, du, awk, sed dan date memakai alat sistem sungguhan.
# TIDAK membuktikan Uptime Kuma, PostgreSQL atau restic sungguhan: itu diuji di staging (U-11). SQL pemeriksa diuji
# terpisah di PostgreSQL 17 (apps/api/test/pg/backup-roles.pg.test.ts).
#
#   sh infra/monitoring/test/dry-run.sh [folder-kerja]
#
# Keluar 0 bila semua skenario lulus.
set -eu

TEST_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
MON_DIR=$(dirname "$TEST_DIR")
ROOT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/kapdh-monitoring-dry-run.XXXXXX")}
mkdir -p "$ROOT"
if command -v cygpath >/dev/null 2>&1; then ROOT=$(cygpath -m "$ROOT"); fi

PASSED=0
FAILED=0
pass() {
  PASSED=$((PASSED + 1))
  printf 'LULUS  %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'GAGAL  %s\n' "$1"
}
expect() {
  _desc=$1
  shift
  if "$@"; then pass "$_desc"; else fail "$_desc"; fi
}
# kuma <id-monitor> -> baris heartbeat terakhir monitor itu.
kuma() {
  grep "^https://kuma.test/api/push/$1 " "$FAKE_STATE_DIR/kuma.log" 2>/dev/null | tail -n 1
}
reset_state() {
  rm -rf "$FAKE_STATE_DIR"
  mkdir -p "$FAKE_STATE_DIR"
}

PATH=$TEST_DIR/stubs:$PATH
FAKE_STATE_DIR=$ROOT/state
KAPDH_BACKUP_ENV=$ROOT/tidak-ada.env
KAPDH_BACKUP_SECRETS=$ROOT/tidak-ada.secrets.env
export PATH FAKE_STATE_DIR KAPDH_BACKUP_ENV KAPDH_BACKUP_SECRETS
chmod +x "$TEST_DIR/stubs/"* "$MON_DIR/"check-*.sh

# ============================================================================================ check-worker.sh
WORKER_HEALTH_URL=http://127.0.0.1:3001/healthz
KUMA_PUSH_WORKER=https://kuma.test/api/push/worker
export WORKER_HEALTH_URL KUMA_PUSH_WORKER
FAKE_WORKER_JSON=$ROOT/worker.json
export FAKE_WORKER_JSON

reset_state
printf '%s' '{"status":"ok","service":"kapdh-worker","time":"2026-10-14T10:00:00.000Z","issues":[],"checks":{"database":{"ok":true}}}' >"$FAKE_WORKER_JSON"
if sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-ok.log" 2>&1; then pass "worker ok -> keluar 0"; else fail "worker ok -> keluar 0"; fi
expect "worker ok -> heartbeat up" sh -c "printf '%s' '$(kuma worker)' | grep -q ' status=up msg=worker ok'"

# URL Push yang disalin apa adanya dari Kuma membawa query bawaan; tanpa dibuang, `status` terkirim dua kali dan Kuma
# mencatat DOWN untuk setiap heartbeat.
reset_state
KUMA_PUSH_WORKER='https://kuma.test/api/push/worker?status=up&msg=OK&ping=' sh "$MON_DIR/check-worker.sh" \
  >"$ROOT/worker-query.log" 2>&1 || true
expect "URL Push berisi ?status=up&msg=OK&ping= -> query bawaan dibuang, satu status" \
  sh -c "printf '%s' '$(kuma worker)' | grep -q ' status=up msg=worker ok' && ! grep -q '?' '$FAKE_STATE_DIR/kuma.log'"

reset_state
printf '%s' '{"status":"degraded","service":"kapdh-worker","time":"2026-10-14T10:00:00.000Z","issues":["outbox_lagging","outbox_dead_events"],"checks":{}}' >"$FAKE_WORKER_JSON"
if sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-degraded.log" 2>&1; then fail "worker degraded -> keluar 1"; else pass "worker degraded -> keluar 1"; fi
expect "worker degraded -> heartbeat down dengan kode isu" \
  sh -c "printf '%s' '$(kuma worker)' | grep -q 'status=down msg=worker degraded outbox_lagging,outbox_dead_events'"

reset_state
rm -f "$FAKE_WORKER_JSON"
if sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-down.log" 2>&1; then fail "worker tak terjangkau -> keluar 1"; else pass "worker tak terjangkau -> keluar 1"; fi
expect "worker tak terjangkau -> heartbeat down" sh -c "printf '%s' '$(kuma worker)' | grep -q 'status=down msg=worker tidak-terjangkau'"

reset_state
printf '%s' '{"status":"ok","service":"kapdh-worker","issues":[]}' >"$FAKE_WORKER_JSON"
if WORKER_HEALTH_URL='' WORKER_CONTAINER=kapdh-worker-1 sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-docker.log" 2>&1; then
  pass "worker lewat docker exec (WORKER_CONTAINER) -> keluar 0"
else
  fail "worker lewat docker exec (WORKER_CONTAINER) -> keluar 0"
fi
expect "worker lewat docker exec -> heartbeat up" sh -c "printf '%s' '$(kuma worker)' | grep -q 'status=up'"

# Coolify mengganti nama kontainer setiap deploy: WORKER_CONTAINER=label=... dicari lewat docker ps.
reset_state
if WORKER_HEALTH_URL='' WORKER_CONTAINER=label=coolify.resourceName=kapdh-worker sh "$MON_DIR/check-worker.sh" \
  >"$ROOT/worker-label.log" 2>&1; then
  pass "worker lewat filter label -> keluar 0"
else
  fail "worker lewat filter label -> keluar 0"
fi
expect "filter label -> docker exec ke nama kontainer Coolify yang ditemukan, heartbeat up" \
  sh -c "grep -qx 'fcxew2rctsrvmjrb8ea1u1uk-20261015T142844' '$FAKE_STATE_DIR/docker-exec.log' && printf '%s' '$(kuma worker)' | grep -q 'status=up'"
reset_state
if WORKER_HEALTH_URL='' WORKER_CONTAINER=label=coolify.resourceName=tidak-ada sh "$MON_DIR/check-worker.sh" \
  >"$ROOT/worker-label-none.log" 2>&1; then
  fail "filter label tanpa kontainer -> keluar 1"
else
  pass "filter label tanpa kontainer -> keluar 1"
fi
expect "filter label tanpa kontainer -> heartbeat down, tanpa docker exec" \
  sh -c "! test -s '$FAKE_STATE_DIR/docker-exec.log' && printf '%s' '$(kuma worker)' | grep -q 'status=down msg=worker tidak-terjangkau'"

# Layanan ping (Healthchecks.io): sukses = URL apa adanya, gagal = URL + /fail, pesan sebagai badan. Query status=down
# tidak boleh dipakai karena layanan ping mencatatnya sebagai SUKSES.
reset_state
printf '%s' '{"status":"ok","service":"kapdh-worker","time":"2026-10-14T10:00:00.000Z","issues":[],"checks":{"database":{"ok":true}}}' >"$ROOT/worker-ping.json"
KUMA_PUSH_WORKER=https://hc-ping.com/0b1c2d3e FAKE_WORKER_JSON="$ROOT/worker-ping.json" WORKER_CONTAINER='' \
  sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-ping-ok.log" 2>&1 || true
expect "layanan ping: worker ok -> URL tanpa /fail, pesan sebagai badan" \
  sh -c "grep -q '^https://hc-ping.com/0b1c2d3e body=worker ok' '$FAKE_STATE_DIR/kuma.log' && ! grep -q 'status=' '$FAKE_STATE_DIR/kuma.log'"
KUMA_PUSH_WORKER='https://hc-ping.com/0b1c2d3e/' FAKE_WORKER_JSON="$ROOT/tidak-ada.json" WORKER_CONTAINER='' \
  sh "$MON_DIR/check-worker.sh" >"$ROOT/worker-ping-down.log" 2>&1 || true
expect "layanan ping: worker tak terjangkau -> URL/fail (garis miring akhir tidak digandakan)" \
  grep -q '^https://hc-ping.com/0b1c2d3e/fail body=worker tidak-terjangkau' "$FAKE_STATE_DIR/kuma.log"

# ============================================================================================== check-host.sh
DISK_DIR=$ROOT/disk
mkdir -p "$DISK_DIR"
DISK_PATHS=$DISK_DIR
FILES_ROOT=$DISK_DIR

KUMA_PUSH_DISK_WARN=https://kuma.test/api/push/disk-warn
KUMA_PUSH_DISK_CRIT=https://kuma.test/api/push/disk-crit
export DISK_PATHS FILES_ROOT KUMA_PUSH_DISK_WARN KUMA_PUSH_DISK_CRIT

reset_state
DISK_WARN_PCT=101 DISK_CRIT_PCT=101 sh "$MON_DIR/check-host.sh" >"$ROOT/host-ok.log" 2>&1
expect "disk di bawah ambang -> peringatan dan kritis up" \
  sh -c "printf '%s' '$(kuma disk-warn)' | grep -q 'status=up' && printf '%s' '$(kuma disk-crit)' | grep -q 'status=up'"
expect "persen terpakai dibaca dari df -P (bukan nilai bawaan 0)" grep -Eq 'disk: .+=[0-9]+%' "$ROOT/host-ok.log"

reset_state
DISK_WARN_PCT=0 DISK_CRIT_PCT=101 sh "$MON_DIR/check-host.sh" >"$ROOT/host-warn.log" 2>&1
expect "disk >= ambang peringatan (60 %) -> peringatan down, kritis up" \
  sh -c "printf '%s' '$(kuma disk-warn)' | grep -q 'status=down msg=disk maks' && printf '%s' '$(kuma disk-crit)' | grep -q 'status=up'"

reset_state
DISK_WARN_PCT=0 DISK_CRIT_PCT=0 sh "$MON_DIR/check-host.sh" >"$ROOT/host-crit.log" 2>&1
expect "disk >= ambang kritis (80 %) -> kritis down" sh -c "printf '%s' '$(kuma disk-crit)' | grep -q 'status=down msg=disk $DISK_DIR'"

reset_state
DISK_WARN_PCT=101 DISK_CRIT_PCT=101 FILES_MAX_GB=-1 sh "$MON_DIR/check-host.sh" >"$ROOT/host-files.log" 2>&1
expect "ukuran berkas > FILES_MAX_GB (PRD 5.4 pemicu S3) -> peringatan down" \
  sh -c "printf '%s' '$(kuma disk-warn)' | grep -q 'status=down.*rencanakan migrasi S3'"

# =============================================================================================== check-app.sh
FAKE_APP_HEALTH=$ROOT/app-health.txt
KUMA_PUSH_OUTBOX=https://kuma.test/api/push/outbox
KUMA_PUSH_PROVIDERS=https://kuma.test/api/push/providers
KUMA_PUSH_DELETIONS=https://kuma.test/api/push/deletions
KUMA_PUSH_PAYMENTS=https://kuma.test/api/push/payments
export FAKE_APP_HEALTH KUMA_PUSH_OUTBOX KUMA_PUSH_PROVIDERS KUMA_PUSH_DELETIONS KUMA_PUSH_PAYMENTS
app_health() {
  # app_health <outbox_age> <dead> <push_err> <mail_err> <del_failed> <del_overdue> <del_ledger> <review_hours>
  printf '%s\n' "outbox_oldest_pending_seconds=$1" "outbox_dead=$2" "push_provider_errors_1h=$3" \
    "email_provider_errors_1h=$4" "deliveries_sent_1h=120" "deletions_failed=$5" "deletions_overdue=$6" \
    "deletions_offsite_ledger_failed=$7" "payments_review_oldest_hours=$8" >"$FAKE_APP_HEALTH"
}

reset_state
app_health 12 0 0 0 0 0 0 5
if sh "$MON_DIR/check-app.sh" >"$ROOT/app-ok.log" 2>&1; then pass "aplikasi sehat -> keluar 0"; else fail "aplikasi sehat -> keluar 0"; fi
expect "aplikasi sehat -> keempat monitor up" sh -c "
  printf '%s\n' '$(kuma outbox)' '$(kuma providers)' '$(kuma deletions)' '$(kuma payments)' | grep -c ' status=up ' | grep -qx 4"

reset_state
app_health 900 0 0 0 0 0 0 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-outbox.log" 2>&1
expect "outbox tertua > 300 s -> outbox down" sh -c "printf '%s' '$(kuma outbox)' | grep -q 'status=down msg=outbox tertua 900s, dead 0'"

reset_state
app_health 12 3 0 0 0 0 0 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-dead.log" 2>&1
expect "event outbox dead -> outbox down" sh -c "printf '%s' '$(kuma outbox)' | grep -q 'status=down.*dead 3'"

reset_state
app_health 12 0 25 0 0 0 0 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-push.log" 2>&1
expect "galat penyedia push > 20 per jam -> penyedia down" sh -c "printf '%s' '$(kuma providers)' | grep -q 'status=down.*push 25'"

reset_state
app_health 12 0 0 6 0 0 0 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-mail.log" 2>&1
expect "galat penyedia email > 5 per jam -> penyedia down" sh -c "printf '%s' '$(kuma providers)' | grep -q 'status=down.*email 6'"

reset_state
app_health 12 0 0 0 1 0 1 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-del.log" 2>&1
expect "D5-07: penulisan ledger luar VPS gagal -> penghapusan akun down" \
  sh -c "printf '%s' '$(kuma deletions)' | grep -q 'status=down.*ledger luar VPS 1'"

reset_state
app_health 12 0 0 0 0 2 0 5
sh "$MON_DIR/check-app.sh" >"$ROOT/app-overdue.log" 2>&1
expect "F-14: penghapusan lewat 7 hari -> penghapusan akun down" sh -c "printf '%s' '$(kuma deletions)' | grep -q 'status=down.*lewat 7 hari 2'"

reset_state
app_health 12 0 0 0 0 0 0 49
sh "$MON_DIR/check-app.sh" >"$ROOT/app-review.log" 2>&1
expect "bukti bayar menunggu > 48 jam -> antrean bayar down" sh -c "printf '%s' '$(kuma payments)' | grep -q 'status=down.*49 jam'"

reset_state
if FAKE_PSQL_FAIL=1 sh "$MON_DIR/check-app.sh" >"$ROOT/app-db.log" 2>&1; then fail "database tak terjangkau -> keluar 1"; else pass "database tak terjangkau -> keluar 1"; fi
expect "database tak terjangkau -> keempat monitor down" \
  sh -c "grep -c 'status=down msg=database tidak terjangkau' '$FAKE_STATE_DIR/kuma.log' | grep -qx 4"
expect "pesan galat database tidak diteruskan ke heartbeat" sh -c "! grep -q 'connection to server' '$FAKE_STATE_DIR/kuma.log'"

# ============================================================================================ check-backup.sh
RESTIC_REPOSITORY=s3:https://r2.test/kapdh-prod-backup
KUMA_PUSH_BACKUP_AGE=https://kuma.test/api/push/backup-age
KUMA_PUSH_BACKUP_CHECK=https://kuma.test/api/push/backup-check
# Jadwal restic check mingguan jatuh pada jam lain (bukan sekarang) kecuali skenario khusus.
CHECK_WEEKDAY=9
export RESTIC_REPOSITORY KUMA_PUSH_BACKUP_AGE KUMA_PUSH_BACKUP_CHECK CHECK_WEEKDAY
snapshot_hours_ago() {
  FAKE_SNAPSHOT_TIME=$(date -u -d "@$(($(date -u +%s) - $1 * 3600))" +%Y-%m-%dT%H:%M:%S.123456789Z)
  export FAKE_SNAPSHOT_TIME
}

reset_state
snapshot_hours_ago 3
if sh "$MON_DIR/check-backup.sh" >"$ROOT/backup-ok.log" 2>&1; then pass "backup 3 jam -> keluar 0"; else fail "backup 3 jam -> keluar 0"; fi
expect "backup 3 jam -> umur backup up (kapdh-db dan kapdh-files)" \
  sh -c "printf '%s' '$(kuma backup-age)' | grep -q 'status=up msg=umur backup: kapdh-db=3j kapdh-files=3j'"
expect "restic check tidak dijalankan di luar jadwal mingguan" sh -c "! grep -q '^check ' '$FAKE_STATE_DIR/restic.log'"

reset_state
snapshot_hours_ago 30
sh "$MON_DIR/check-backup.sh" >"$ROOT/backup-old.log" 2>&1
expect "N-06: backup 30 jam (> 26 jam) -> umur backup down" sh -c "printf '%s' '$(kuma backup-age)' | grep -q 'status=down msg=backup terlalu tua'"

reset_state
snapshot_hours_ago 1
if FAKE_NO_SNAPSHOT_TAG=kapdh-files sh "$MON_DIR/check-backup.sh" >"$ROOT/backup-none.log" 2>&1; then
  fail "snapshot berkas tidak ada -> keluar 1"
else
  pass "snapshot berkas tidak ada -> keluar 1"
fi
expect "snapshot berkas tidak ada -> umur backup down" sh -c "printf '%s' '$(kuma backup-age)' | grep -q 'status=down msg=tidak ada snapshot kapdh-files'"

reset_state
if FAKE_RESTIC_FAIL=1 sh "$MON_DIR/check-backup.sh" >"$ROOT/backup-repo.log" 2>&1; then fail "repositori tak terbaca -> keluar 1"; else pass "repositori tak terbaca -> keluar 1"; fi
expect "repositori tak terbaca -> umur backup down" sh -c "printf '%s' '$(kuma backup-age)' | grep -q 'status=down msg=repositori restic tidak terbaca'"

reset_state
snapshot_hours_ago 2
CHECK_WEEKDAY=$(date -u +%u) CHECK_HOUR_UTC=$(date -u +%H) sh "$MON_DIR/check-backup.sh" >"$ROOT/backup-check.log" 2>&1
expect "jadwal mingguan -> restic check subset 5% dijalankan dan heartbeat up" \
  sh -c "grep -q '^check --read-data-subset=5%' '$FAKE_STATE_DIR/restic.log' && printf '%s' '$(kuma backup-check)' | grep -q 'status=up'"

reset_state
if CHECK_WEEKDAY=$(date -u +%u) CHECK_HOUR_UTC=$(date -u +%H) FAKE_RESTIC_CHECK_EXIT=1 sh "$MON_DIR/check-backup.sh" \
  >"$ROOT/backup-check-fail.log" 2>&1; then
  fail "restic check gagal -> keluar 1"
else
  pass "restic check gagal -> keluar 1"
fi
expect "restic check gagal -> heartbeat integritas down" sh -c "printf '%s' '$(kuma backup-check)' | grep -q 'status=down'"

printf '\n%s lulus, %s gagal (folder: %s)\n' "$PASSED" "$FAILED" "$ROOT"
[ "$FAILED" -eq 0 ]
