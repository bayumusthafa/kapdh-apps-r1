#!/bin/sh
# Pemeriksaan disk host -> heartbeat Uptime Kuma (PRD 5.4 "alert disk warning 60 persen, critical 80 persen", PRD 5.5;
# D9; docs/runbooks/monitoring.md). Cron/systemd setiap 5 menit.
#
#   KAPDH_BACKUP_ENV=/etc/kapdh/monitoring.env infra/monitoring/check-host.sh
#
#   DISK_PATHS            path yang diperiksa (bawaan: "/ /data/files /var/lib/docker")
#   KUMA_PUSH_DISK_WARN   down bila salah satu path >= DISK_WARN_PCT (bawaan 60): rencanakan pindah S3 (PRD 5.4)
#   KUMA_PUSH_DISK_CRIT   down bila salah satu path >= DISK_CRIT_PCT (bawaan 80): tindakan segera (runbook)
#   FILES_ROOT, FILES_MAX_GB  ukuran berkas lokal; > 20 GB juga memicu warning (pemicu migrasi S3, PRD 5.4)
set -eu

MON_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-check-host
# shellcheck source=../backup/lib.sh
. "$MON_DIR/../backup/lib.sh"
load_config
require_cmd df awk

DISK_PATHS=${DISK_PATHS:-/ /data/files /var/lib/docker}
DISK_WARN_PCT=${DISK_WARN_PCT:-60}
DISK_CRIT_PCT=${DISK_CRIT_PCT:-80}
FILES_ROOT=${FILES_ROOT:-/data/files}
FILES_MAX_GB=${FILES_MAX_GB:-20}

MAX=0
WORST=''
SUMMARY=''
for _path in $DISK_PATHS; do
  [ -e "$_path" ] || continue
  # df -P: format POSIX satu baris per filesystem; kolom 5 = persen terpakai.
  _pct=$(df -P "$_path" | awk 'NR == 2 { sub("%", "", $5); print $5 }')
  case $_pct in '' | *[!0-9]*) continue ;; esac
  SUMMARY="$SUMMARY $_path=${_pct}%"
  if [ "$_pct" -gt "$MAX" ]; then
    MAX=$_pct
    WORST=$_path
  fi
done

FILES_GB=0
if [ -d "$FILES_ROOT" ] && command -v du >/dev/null 2>&1; then
  FILES_GB=$(du -sk "$FILES_ROOT" 2>/dev/null | awk '{ printf "%d", $1 / 1048576 }')
fi

if [ "$MAX" -ge "$DISK_CRIT_PCT" ]; then
  kuma_push "${KUMA_PUSH_DISK_CRIT:-}" down "disk $WORST ${MAX}% >= ${DISK_CRIT_PCT}%:$SUMMARY" "$MAX"
else
  kuma_push "${KUMA_PUSH_DISK_CRIT:-}" up "maks ${MAX}%:$SUMMARY" "$MAX"
fi
if [ "$MAX" -ge "$DISK_WARN_PCT" ] || [ "$FILES_GB" -gt "$FILES_MAX_GB" ]; then
  kuma_push "${KUMA_PUSH_DISK_WARN:-}" down "disk maks ${MAX}% ($WORST), berkas ${FILES_GB} GB: rencanakan migrasi S3 (PRD 5.4)" "$MAX"
else
  kuma_push "${KUMA_PUSH_DISK_WARN:-}" up "maks ${MAX}%, berkas ${FILES_GB} GB" "$MAX"
fi
log "disk:$SUMMARY; berkas ${FILES_GB} GB"
