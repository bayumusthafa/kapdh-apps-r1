#!/bin/sh
# Umur backup terbaru dan integritas repositori -> heartbeat Uptime Kuma (PRD 5.5 "umur backup", N-06, D9;
# docs/runbooks/monitoring.md). Membaca repositori restic (bukti data sampai di luar VPS), bukan hanya status lokal.
# Cron/systemd setiap jam.
#
#   KAPDH_BACKUP_ENV=/etc/kapdh/backup.env KAPDH_BACKUP_SECRETS=/etc/kapdh/backup.secrets.env \
#     infra/monitoring/check-backup.sh
#
#   KUMA_PUSH_BACKUP_AGE    down bila snapshot kapdh-db atau kapdh-files terbaru lebih tua dari BACKUP_MAX_AGE_H (26)
#   KUMA_PUSH_BACKUP_CHECK  hasil `restic check --read-data-subset` mingguan pada CHECK_WEEKDAY/CHECK_HOUR_UTC (bawaan
#                           6/21 = Sabtu 21.00 UTC = Minggu 04.00 WIB; date +%u, 1 = Senin)
set -eu
umask 077

MON_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-check-backup
# shellcheck source=../backup/lib.sh
. "$MON_DIR/../backup/lib.sh"
load_config
require_cmd restic date
require_var RESTIC_REPOSITORY

KAPDH_ENV=${KAPDH_ENV:-production}
RESTIC_HOST=${RESTIC_HOST:-kapdh-$KAPDH_ENV}
BACKUP_MAX_AGE_H=${BACKUP_MAX_AGE_H:-26}
CHECK_WEEKDAY=${CHECK_WEEKDAY:-6}
CHECK_HOUR_UTC=${CHECK_HOUR_UTC:-21}
CHECK_SUBSET=${CHECK_SUBSET:-5%}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/kapdh-check-backup.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

NOW=$(now_epoch)
WORST_AGE=0
DETAIL=''
for _tag in kapdh-db kapdh-files; do
  if ! restic snapshots --no-lock --json --host "$RESTIC_HOST" --tag "$_tag" --latest 1 >"$TMP/$_tag.json" 2>"$TMP/err"; then
    kuma_push "${KUMA_PUSH_BACKUP_AGE:-}" down "repositori restic tidak terbaca" ""
    die "restic snapshots gagal: $(tail -n 2 "$TMP/err" | tr '\n' ' ' | cut -c 1-200)"
  fi
  _time=$(restic_first_time "$TMP/$_tag.json")
  if [ -z "$_time" ]; then
    kuma_push "${KUMA_PUSH_BACKUP_AGE:-}" down "tidak ada snapshot $_tag" ""
    die "tidak ada snapshot $_tag untuk $RESTIC_HOST"
  fi
  _epoch=$(date -u -d "$_time" +%s)
  _age=$((NOW - _epoch))
  DETAIL="$DETAIL $_tag=$((_age / 3600))j"
  if [ "$_age" -gt "$WORST_AGE" ]; then WORST_AGE=$_age; fi
done

if [ "$WORST_AGE" -gt $((BACKUP_MAX_AGE_H * 3600)) ]; then
  kuma_push "${KUMA_PUSH_BACKUP_AGE:-}" down "backup terlalu tua:$DETAIL (maks ${BACKUP_MAX_AGE_H}j; RPO N-06)" "$((WORST_AGE / 60))"
else
  kuma_push "${KUMA_PUSH_BACKUP_AGE:-}" up "umur backup:$DETAIL" "$((WORST_AGE / 60))"
fi
log "umur backup:$DETAIL"

# Jam dibandingkan tanpa nol di depan (CHECK_HOUR_UTC=4 sama dengan 04).
HOUR_NOW=$(date -u +%H)
if [ "$(date -u +%u)" = "$CHECK_WEEKDAY" ] && [ "${HOUR_NOW#0}" = "${CHECK_HOUR_UTC#0}" ]; then
  log "restic check --read-data-subset=$CHECK_SUBSET"
  if restic check --read-data-subset="$CHECK_SUBSET" >"$TMP/check.log" 2>&1; then
    kuma_push "${KUMA_PUSH_BACKUP_CHECK:-}" up "restic check subset $CHECK_SUBSET lulus" ""
  else
    kuma_push "${KUMA_PUSH_BACKUP_CHECK:-}" down "restic check gagal: repositori rusak?" ""
    die "restic check gagal: $(tail -n 3 "$TMP/check.log" | tr '\n' ' ' | cut -c 1-300)"
  fi
fi
