#!/bin/sh
# Pemeriksaan kesehatan aplikasi dari database -> heartbeat Uptime Kuma (PRD 5.5, N-05; docs/runbooks/monitoring.md).
# Dijalankan cron/systemd setiap 5 menit sebagai root di VPS; koneksi database memakai role kapdh_monitor.
#
#   KAPDH_BACKUP_ENV=/etc/kapdh/monitoring.env infra/monitoring/check-app.sh
#
# Monitor Push (masing-masing URL sendiri; kosong = dilewati):
#   KUMA_PUSH_OUTBOX     down bila event outbox tertua > OUTBOX_MAX_AGE_S (bawaan 300) atau ada event dead
#   KUMA_PUSH_PROVIDERS  down bila galat penyedia push/email 1 jam > PUSH_PROVIDER_MAX/EMAIL_PROVIDER_MAX (20/5)
#   KUMA_PUSH_DELETIONS  down bila ada penghapusan akun gagal, lewat 7 hari, atau gagal menulis ledger luar VPS
#   KUMA_PUSH_PAYMENTS   down bila bukti bayar tertua menunggu > PAYMENT_REVIEW_MAX_HOURS (bawaan 48)
# Database tidak terjangkau: semua monitor di atas dikirim down. Tidak ada data pribadi dalam pesan.
set -eu
umask 077

MON_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-check-app
# shellcheck source=../backup/lib.sh
. "$MON_DIR/../backup/lib.sh"
load_config
[ -n "${PG_EXEC:-}" ] || require_cmd psql

OUTBOX_MAX_AGE_S=${OUTBOX_MAX_AGE_S:-300}
PUSH_PROVIDER_MAX=${PUSH_PROVIDER_MAX:-20}
EMAIL_PROVIDER_MAX=${EMAIL_PROVIDER_MAX:-5}
PAYMENT_REVIEW_MAX_HOURS=${PAYMENT_REVIEW_MAX_HOURS:-48}
# Koneksi monitor (PGUSER=kapdh_monitor) terpisah dari kapdh_backup bila MONITOR_PGUSER diisi.
if [ -n "${MONITOR_PGUSER:-}" ]; then PGUSER=$MONITOR_PGUSER && export PGUSER; fi

if ! OUT=$(psql_q -f - <"$MON_DIR/sql/app-health.sql" 2>&1); then
  log "database tidak terjangkau untuk pemeriksaan aplikasi"
  for _url in "${KUMA_PUSH_OUTBOX:-}" "${KUMA_PUSH_PROVIDERS:-}" "${KUMA_PUSH_DELETIONS:-}" "${KUMA_PUSH_PAYMENTS:-}"; do
    kuma_push "$_url" down "database tidak terjangkau dari pemeriksa" ""
  done
  exit 1
fi

value() {
  _v=$(printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | head -n 1)
  case $_v in '' | *[!0-9]*) printf '0' ;; *) printf '%s' "$_v" ;; esac
}

AGE=$(value outbox_oldest_pending_seconds)
DEAD=$(value outbox_dead)
if [ "$AGE" -gt "$OUTBOX_MAX_AGE_S" ] || [ "$DEAD" -gt 0 ]; then
  kuma_push "${KUMA_PUSH_OUTBOX:-}" down "outbox tertua ${AGE}s, dead $DEAD" "$AGE"
else
  kuma_push "${KUMA_PUSH_OUTBOX:-}" up "outbox tertua ${AGE}s" "$AGE"
fi

PUSH_ERR=$(value push_provider_errors_1h)
MAIL_ERR=$(value email_provider_errors_1h)
SENT=$(value deliveries_sent_1h)
if [ "$PUSH_ERR" -gt "$PUSH_PROVIDER_MAX" ] || [ "$MAIL_ERR" -gt "$EMAIL_PROVIDER_MAX" ]; then
  kuma_push "${KUMA_PUSH_PROVIDERS:-}" down "galat penyedia 1 jam: push $PUSH_ERR, email $MAIL_ERR (terkirim $SENT)" ""
else
  kuma_push "${KUMA_PUSH_PROVIDERS:-}" up "push $PUSH_ERR, email $MAIL_ERR, terkirim $SENT" ""
fi

DEL_FAILED=$(value deletions_failed)
DEL_OVERDUE=$(value deletions_overdue)
DEL_LEDGER=$(value deletions_offsite_ledger_failed)
if [ "$DEL_FAILED" -gt 0 ] || [ "$DEL_OVERDUE" -gt 0 ] || [ "$DEL_LEDGER" -gt 0 ]; then
  kuma_push "${KUMA_PUSH_DELETIONS:-}" down "penghapusan gagal $DEL_FAILED, lewat 7 hari $DEL_OVERDUE, ledger luar VPS $DEL_LEDGER" ""
else
  kuma_push "${KUMA_PUSH_DELETIONS:-}" up "penghapusan akun normal" ""
fi

REVIEW=$(value payments_review_oldest_hours)
if [ "$REVIEW" -gt "$PAYMENT_REVIEW_MAX_HOURS" ]; then
  kuma_push "${KUMA_PUSH_PAYMENTS:-}" down "bukti bayar tertua menunggu ${REVIEW} jam" "$REVIEW"
else
  kuma_push "${KUMA_PUSH_PAYMENTS:-}" up "bukti bayar tertua ${REVIEW} jam" "$REVIEW"
fi
log "outbox ${AGE}s/dead $DEAD; penyedia push $PUSH_ERR email $MAIL_ERR; penghapusan $DEL_FAILED/$DEL_OVERDUE/$DEL_LEDGER; review ${REVIEW}j"
