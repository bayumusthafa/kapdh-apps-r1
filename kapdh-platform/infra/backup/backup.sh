#!/bin/sh
# Backup harian KAPDH (PRD 5.5, N-06, D2, D9; ARCHITECTURE §10; runbook docs/runbooks/backup-restore.md).
#
#   KAPDH_BACKUP_ENV=/etc/kapdh/backup.env infra/backup/backup.sh
#   (dijalankan systemd timer infra/backup/systemd/kapdh-backup.timer atau cron infra/backup/cron/kapdh-backup)
#
# Urutan dan alasan konsistensi (lihat runbook bagian "Konsistensi DB dan berkas"):
#   1. Database: transaksi REPEATABLE READ READ ONLY mengekspor snapshot; pg_dump (format custom) memakai snapshot
#      yang SAMA (--snapshot), dan statistik manifest (jumlah, total uang, versi skema) dihitung di transaksi itu juga.
#   2. Berkas: restic snapshot /data/files SESUDAH dump. Unggahan menulis objek lebih dahulu lalu baris `ready`, jadi
#      setiap baris `ready` di dump sudah punya objek sebelum dump; objek yang dihapus setelah dump (penghapusan akun,
#      discard, cleanup) diselesaikan ulang oleh deletion ledger dan job cleanup saat restore; objek baru sesudah dump
#      menjadi yatim tanpa baris (tidak pernah dilayani) dan dilaporkan verify-restore.sh.
#   3. Deletion ledger luar VPS (bucket append-only, DELETION_LEDGER_S3_* di worker) disalin ke backup sebagai bukti
#      titik ini; restore TETAP membaca bucket terbaru (AC F14-6, audit D5-07).
#   4. Manifest JSON mengikat dump (sha256), snapshot berkas, ledger (sha256 per objek), versi skema, image dan versi
#      alat; dump + manifest + salinan ledger diunggah sebagai snapshot restic kedua (terenkripsi AES-256 restic).
#   5. Retensi (D2: backup berotasi 30 hari): snapshot dump di luar RETENTION_DAYS dilupakan, snapshot berkas
#      dilupakan BERPASANGAN dengan dump-nya (tag backup_id yang sama), lalu `prune --max-unused 0` agar blob akun
#      terhapus benar-benar hilang dari repo (bukan tertahan di pack campuran). RETENTION_DAYS + BUCKET_NONCURRENT_DAYS
#      (masa versi lama objek di bucket penyedia) maksimal 30.
#
# Keluar 0 bila seluruh langkah berhasil; selain itu 1 dan heartbeat Uptime Kuma `down` (termasuk production dengan
# images.api/worker kosong: backup tersimpan tetapi run gagal). Dump berisi data pribadi: folder stage 0700 dan dihapus
# setelah diunggah/gagal. Tidak ada secret yang dicetak.
set -eu
umask 077

KAPDH_BACKUP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-backup
# shellcheck source=lib.sh
. "$KAPDH_BACKUP_DIR/lib.sh"

case ${1:-} in
  -h | --help)
    sed -n '2,25p' "$0"
    exit 0
    ;;
  '') ;;
  *) die "argumen tidak dikenal: $1 (backup.sh tidak menerima argumen; konfigurasi lewat env)" ;;
esac

load_config

KAPDH_ENV=${KAPDH_ENV:-production}
WORK_DIR=${WORK_DIR:-/var/backups/kapdh}
FILES_ROOT=${FILES_ROOT:-/data/files}
RETENTION_DAYS=${RETENTION_DAYS:-30}
BUCKET_NONCURRENT_DAYS=${BUCKET_NONCURRENT_DAYS:-0}
RESTIC_PRUNE=${RESTIC_PRUNE:-1}
RESTIC_HOST=${RESTIC_HOST:-kapdh-$KAPDH_ENV}
LEDGER_RCLONE_REMOTE=${LEDGER_RCLONE_REMOTE:-}
KUMA_PUSH_BACKUP=${KUMA_PUSH_BACKUP:-}
STATS_SQL=$KAPDH_BACKUP_DIR/sql/stats.sql
SNAPSHOT_TIMEOUT_S=${SNAPSHOT_TIMEOUT_S:-120}
STATS_TIMEOUT_S=${STATS_TIMEOUT_S:-600}

case $KAPDH_ENV in '' | *[!a-z0-9-]*) die "KAPDH_ENV hanya huruf kecil, angka, tanda hubung" ;; esac
case $RETENTION_DAYS in '' | *[!0-9]*) die "RETENTION_DAYS harus bilangan bulat" ;; esac
case $BUCKET_NONCURRENT_DAYS in '' | *[!0-9]*) die "BUCKET_NONCURRENT_DAYS harus bilangan bulat" ;; esac
# D2: backup berotasi 30 hari; retensi lebih panjang menyimpan data akun terhapus melebihi janji kepada pengguna.
[ "$RETENTION_DAYS" -le 30 ] || die "RETENTION_DAYS maksimal 30 (D2, PRD 3.14)"
# Versi lama objek yang ditahan penyedia sesudah prune (versioning/lifecycle bucket backup) ikut dihitung: data akun
# terhapus baru hilang setelah RETENTION_DAYS + BUCKET_NONCURRENT_DAYS. Nilai ini WAJIB sama dengan aturan bucket.
[ $((RETENTION_DAYS + BUCKET_NONCURRENT_DAYS)) -le 30 ] ||
  die "RETENTION_DAYS + BUCKET_NONCURRENT_DAYS maksimal 30 (D2); turunkan RETENTION_DAYS atau masa versi lama bucket"
case $RESTIC_PRUNE in 0 | 1) ;; *) die "RESTIC_PRUNE harus 0 atau 1" ;; esac
if [ "$RESTIC_PRUNE" != 1 ] && [ "$KAPDH_ENV" = production ]; then
  die "RESTIC_PRUNE=1 wajib di production: tanpa prune data akun terhapus tertahan di repositori (D2)"
fi
require_var RESTIC_REPOSITORY
[ -n "${RESTIC_PASSWORD_FILE:-}${RESTIC_PASSWORD_COMMAND:-}" ] ||
  die "RESTIC_PASSWORD_FILE atau RESTIC_PASSWORD_COMMAND wajib (kunci backup terpisah dari salinan backup, PRD 5.5)"
require_cmd restic sha256sum find sort sed tr wc mkfifo head cut
[ -n "${PG_EXEC:-}" ] || require_cmd psql pg_dump pg_restore
[ -d "$FILES_ROOT" ] || die "FILES_ROOT $FILES_ROOT tidak ada"
[ -f "$STATS_SQL" ] || die "berkas $STATS_SQL tidak ada"
if [ -n "$LEDGER_RCLONE_REMOTE" ]; then
  require_cmd rclone
elif [ "$KAPDH_ENV" = production ]; then
  die "LEDGER_RCLONE_REMOTE wajib di production (salinan deletion ledger luar VPS, AC F14-6)"
else
  log "PERINGATAN: LEDGER_RCLONE_REMOTE kosong; manifest tidak memuat salinan deletion ledger luar VPS"
fi

# Referensi image yang sedang berjalan (PRD 5.5 "image version"; restore memakai image yang sama): IMAGE_<NAMA> yang
# ditulis langkah rilis ke backup.env, atau dibaca dari kontainer CONTAINER_<NAMA> (nama kontainer, atau filter
# `label=<kunci>=<nilai>` untuk docker ps bila nama kontainer berubah setiap deploy) sebagai `tag@sha256:digest`.
image_ref() {
  eval "_ref=\${IMAGE_$1:-}"
  eval "_container=\${CONTAINER_$1:-}"
  if [ -z "$_ref" ] && [ -n "$_container" ] && command -v docker >/dev/null 2>&1; then
    case $_container in
      label=*) _container=$(docker ps --filter "$_container" --format '{{.ID}}' 2>/dev/null | head -n 1 || true) ;;
    esac
    if [ -n "$_container" ]; then
      _tag=$(docker inspect --format '{{.Config.Image}}' "$_container" 2>/dev/null || true)
      _image_id=$(docker inspect --format '{{.Image}}' "$_container" 2>/dev/null || true)
      _digest=''
      if [ -n "$_image_id" ]; then
        _digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$_image_id" \
          2>/dev/null | head -n 1 || true)
      fi
      case $_tag in
        *@sha256:*) _ref=$_tag ;;
        *) if [ -n "$_digest" ] && [ -n "$_tag" ]; then _ref="$_tag@${_digest#*@}"; else _ref=${_tag:-$_digest}; fi ;;
      esac
    fi
  fi
  printf '%s' "$_ref"
}
IMG_API=$(image_ref API)
IMG_WORKER=$(image_ref WORKER)
IMG_WEB=$(image_ref WEB)
IMG_ADMIN=$(image_ref ADMIN)
# Production: image API/worker wajib tercatat (restore dan ledger-reapply memakai image yang sama). Backup TETAP dibuat
# (RPO lebih penting), tetapi run diakhiri gagal + heartbeat down agar konfigurasi diperbaiki hari itu juga.
IMAGES_MISSING=''
if [ "$KAPDH_ENV" = production ]; then
  [ -n "$IMG_API" ] || IMAGES_MISSING="api"
  [ -n "$IMG_WORKER" ] || IMAGES_MISSING="${IMAGES_MISSING:+$IMAGES_MISSING,}worker"
fi

STARTED_EPOCH=$(now_epoch)
STARTED_AT=$(now_iso)
BACKUP_ID="kapdh-$KAPDH_ENV-$(date -u +%Y%m%dT%H%M%SZ)"
FAIL_NOTE=''
# Path stage TETAP: grup retensi restic (host, paths) harus stabil antarhari.
STAGE=$WORK_DIR/stage
TMP=$WORK_DIR/tmp
LOCK=$WORK_DIR/.backup.lock
SNAP_PID=''
KAPDH_LOG_FILE=''

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
acquire_lock "$LOCK"

cleanup() {
  _code=$?
  set +e
  # Menutup FIFO sesi snapshot (EOF mengakhiri psql); menutup fd yang belum dibuka bukan galat.
  exec 7>&-
  if [ -n "$SNAP_PID" ]; then
    kill "$SNAP_PID" 2>/dev/null
    wait "$SNAP_PID" 2>/dev/null
  fi
  # Dump berisi data pribadi: tidak pernah ditinggal di VPS (salinan resmi hanya di repositori restic terenkripsi).
  rm -rf "$STAGE" "$TMP"
  release_lock "$LOCK"
  if [ "$_code" -ne 0 ]; then
    log "${FAIL_NOTE:-backup $BACKUP_ID GAGAL (kode $_code)}"
    kuma_push "$KUMA_PUSH_BACKUP" down "${FAIL_NOTE:-backup $BACKUP_ID gagal (kode $_code)}" ""
  fi
  exit "$_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

rm -rf "$STAGE" "$TMP"
mkdir -p "$STAGE" "$TMP"
if [ -n "$IMAGES_MISSING" ]; then
  log "PERINGATAN: images.$IMAGES_MISSING kosong (IMAGE_*/CONTAINER_* di backup.env); backup tetap dibuat, run berakhir gagal"
fi

# Menunggu baris `<NAMA>=<nilai>` dari sesi psql latar belakang.
wait_marker() {
  _i=0
  while [ "$_i" -lt "$3" ]; do
    _v=$(sed -n "s/^$1=//p" "$2" | head -n 1)
    if [ -n "$_v" ]; then
      printf '%s\n' "$_v"
      return 0
    fi
    kill -0 "$SNAP_PID" 2>/dev/null || return 1
    sleep 1
    _i=$((_i + 1))
  done
  return 1
}

psql_error_hint() {
  # Baris pertama galat psql (tanpa URL/sandi; libpq tidak mencetak sandi).
  head -n 3 "$TMP/psql.err" 2>/dev/null | tr '\n' ' ' | cut -c 1-300
}

# ------------------------------------------------------------------------------------------- 1. database
log "1/6 database: snapshot REPEATABLE READ diekspor; pg_dump dan statistik manifest memakai snapshot yang sama"
mkfifo "$TMP/psql.in"
: >"$TMP/psql.out"
psql_q <"$TMP/psql.in" >"$TMP/psql.out" 2>"$TMP/psql.err" &
SNAP_PID=$!
exec 7>"$TMP/psql.in"
printf '%s\n' \
  "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;" \
  "SELECT 'SNAPSHOT=' || pg_export_snapshot();" >&7
SNAPSHOT=$(wait_marker SNAPSHOT "$TMP/psql.out" "$SNAPSHOT_TIMEOUT_S") ||
  die "snapshot database gagal diekspor: $(psql_error_hint)"
case $SNAPSHOT in *[!0-9A-Fa-f-]*) die "id snapshot database tidak dikenal" ;; esac

DB_STARTED_EPOCH=$(now_epoch)
pg pg_dump --format=custom --no-password --snapshot="$SNAPSHOT" >"$STAGE/db.dump" 2>"$TMP/pg_dump.err" ||
  die "pg_dump gagal: $(head -n 3 "$TMP/pg_dump.err" | tr '\n' ' ' | cut -c 1-300)"
{
  printf "SELECT 'STATS=' || ("
  cat "$STATS_SQL"
  printf ')::text;\n'
} >&7
STATS=$(wait_marker STATS "$TMP/psql.out" "$STATS_TIMEOUT_S") ||
  die "statistik manifest gagal dihitung: $(psql_error_hint)"
printf '%s\n' "COMMIT;" '\q' >&7
exec 7>&-
wait "$SNAP_PID" || die "sesi snapshot psql berakhir dengan galat: $(psql_error_hint)"
SNAP_PID=''
case $STATS in '{'*'}') ;; *) die "statistik manifest bukan objek JSON" ;; esac
DB_SECONDS=$(($(now_epoch) - DB_STARTED_EPOCH))

pg pg_restore --list <"$STAGE/db.dump" >"$STAGE/db.toc" 2>"$TMP/pg_restore.err" ||
  die "arsip dump tidak dapat dibaca pg_restore --list"
DB_TOC_ENTRIES=$(grep -c '^[0-9]' "$STAGE/db.toc" || true)
[ "${DB_TOC_ENTRIES:-0}" -gt 0 ] || die "daftar isi dump kosong"
DB_SHA=$(sha256_of "$STAGE/db.dump")
DB_BYTES=$(bytes_of "$STAGE/db.dump")
DB_CAPTURED_AT=$(printf '%s' "$STATS" | sed -n 's/^{"captured_at" *: *"\([0-9TZ:-]*\)".*/\1/p')
log "dump selesai: $DB_BYTES byte, $DB_TOC_ENTRIES entri TOC, ${DB_SECONDS}s, snapshot $DB_CAPTURED_AT"

# ------------------------------------------------------------------------------------------- 2. berkas
log "2/6 berkas: snapshot restic $FILES_ROOT (sesudah dump)"
FILES_STARTED_AT=$(now_iso)
# shellcheck disable=SC2086 # RESTIC_BACKUP_ARGS sengaja dipecah (mis. --limit-upload 20000)
restic backup --json --host "$RESTIC_HOST" \
  --tag "kapdh,kapdh-files,env-$KAPDH_ENV,$BACKUP_ID" \
  --exclude "$FILES_ROOT/.tmp" \
  ${RESTIC_BACKUP_ARGS:-} "$FILES_ROOT" >"$TMP/files.json" 2>"$TMP/files.err" ||
  die "restic backup berkas gagal: $(tail -n 3 "$TMP/files.err" | tr '\n' ' ' | cut -c 1-300)"
FILES_SNAPSHOT=$(restic_summary_field "$TMP/files.json" snapshot_id)
FILES_TOTAL=$(restic_summary_field "$TMP/files.json" total_files_processed)
FILES_BYTES=$(restic_summary_field "$TMP/files.json" total_bytes_processed)
[ -n "$FILES_SNAPSHOT" ] || die "id snapshot berkas tidak ditemukan di keluaran restic"
LOCAL_LEDGER_ENTRIES=0
if [ -d "$FILES_ROOT/ledger/account-deletions" ]; then
  LOCAL_LEDGER_ENTRIES=$(find "$FILES_ROOT/ledger/account-deletions" -type f -name '*.json' | wc -l | tr -d ' ')
fi
log "snapshot berkas $FILES_SNAPSHOT: ${FILES_TOTAL:-?} berkas, ${FILES_BYTES:-?} byte"

# ------------------------------------------------------------------------------------------- 3. ledger luar VPS
LEDGER_ENTRIES=0
LEDGER_INDEX_SHA=''
mkdir -p "$STAGE/ledger-offsite"
: >"$TMP/ledger.list"
if [ -n "$LEDGER_RCLONE_REMOTE" ]; then
  log "3/6 deletion ledger luar VPS: salinan $LEDGER_RCLONE_REMOTE (account-deletions/**)"
  rclone copy "$LEDGER_RCLONE_REMOTE" "$STAGE/ledger-offsite" --include "/account-deletions/**" \
    >"$TMP/rclone.log" 2>&1 || die "salinan deletion ledger luar VPS gagal (rclone)"
  (cd "$STAGE/ledger-offsite" && find . -type f -name '*.json' | sed 's#^\./##' | LC_ALL=C sort) >"$TMP/ledger.list"
else
  log "3/6 deletion ledger luar VPS: dilewati (bukan production, LEDGER_RCLONE_REMOTE kosong)"
fi
: >"$STAGE/ledger-offsite.sha256"
while IFS= read -r rel; do
  case $rel in *[!a-z0-9._/-]*) die "nama objek ledger tidak aman: tidak sesuai pola key" ;; esac
  printf '%s  %s\n' "$(sha256_of "$STAGE/ledger-offsite/$rel")" "$rel" >>"$STAGE/ledger-offsite.sha256"
  LEDGER_ENTRIES=$((LEDGER_ENTRIES + 1))
done <"$TMP/ledger.list"
LEDGER_INDEX_SHA=$(sha256_of "$STAGE/ledger-offsite.sha256")

# ------------------------------------------------------------------------------------------- 4. manifest
log "4/6 manifest"
tool_version() {
  # Versi alat sebagai token aman (mis. 0.18.0, v1.69.1, 17.6).
  "$@" 2>/dev/null | head -n 1 | tr ' ' '\n' | grep -E '^v?[0-9]+(\.[0-9]+)+' | head -n 1 || true
}
RESTIC_VERSION=$(tool_version restic version)
RCLONE_VERSION=''
[ -n "$LEDGER_RCLONE_REMOTE" ] && RCLONE_VERSION=$(tool_version rclone version)
PG_DUMP_VERSION=$(tool_version pg pg_dump --version)

# Semua nilai divalidasi lewat penugasan sederhana (set -e menghentikan skrip bila json_safe/json_int gagal; galat di
# dalam substitusi argumen printf tidak akan menghentikannya).
MANIFEST_WRITTEN_AT=$(now_iso)
J_BACKUP_ID=$(json_safe "$BACKUP_ID" backup_id)
J_ENV=$(json_safe "$KAPDH_ENV" environment)
J_HOST=$(json_safe "$RESTIC_HOST" restic_host)
J_STARTED=$(json_safe "$STARTED_AT" started_at)
J_WRITTEN=$(json_safe "$MANIFEST_WRITTEN_AT" manifest_written_at)
J_RETENTION=$(json_int "$RETENTION_DAYS" retention_days)
J_RESTIC=$(json_safe "$RESTIC_VERSION" restic)
J_RCLONE=$(json_safe "$RCLONE_VERSION" rclone)
J_PG_DUMP=$(json_safe "$PG_DUMP_VERSION" pg_dump)
J_IMG_API=$(json_safe "$IMG_API" image_api)
J_IMG_WORKER=$(json_safe "$IMG_WORKER" image_worker)
J_IMG_WEB=$(json_safe "$IMG_WEB" image_web)
J_IMG_ADMIN=$(json_safe "$IMG_ADMIN" image_admin)
J_DB_SHA=$(json_safe "$DB_SHA" db_dump_sha256)
J_DB_BYTES=$(json_int "$DB_BYTES" db_dump_bytes)
J_DB_TOC=$(json_int "$DB_TOC_ENTRIES" db_toc_entries)
J_DB_CAPTURED=$(json_safe "$DB_CAPTURED_AT" db_snapshot_captured_at)
J_DB_SECONDS=$(json_int "$DB_SECONDS" db_dump_seconds)
J_FILES_ROOT=$(json_safe "$FILES_ROOT" files_root)
J_FILES_SNAPSHOT=$(json_safe "$FILES_SNAPSHOT" files_snapshot_id)
J_FILES_STARTED=$(json_safe "$FILES_STARTED_AT" files_snapshot_started_at)
J_FILES_TOTAL=$(json_int "${FILES_TOTAL:-0}" files_total)
J_FILES_BYTES=$(json_int "${FILES_BYTES:-0}" files_bytes)
J_LOCAL_LEDGER=$(json_int "$LOCAL_LEDGER_ENTRIES" files_local_ledger_entries)
J_LEDGER_REMOTE=$(json_safe "$LEDGER_RCLONE_REMOTE" ledger_offsite_remote)
J_LEDGER_ENTRIES=$(json_int "$LEDGER_ENTRIES" ledger_offsite_entries)
J_LEDGER_INDEX=$(json_safe "$LEDGER_INDEX_SHA" ledger_offsite_index_sha256)

# Larik objek ledger: {"key", "sha256"} per objek, ditulis lebih dahulu ke berkas sementara.
: >"$TMP/ledger-objects.json"
_first=1
while IFS= read -r _line; do
  [ -n "$_line" ] || continue
  J_KEY=$(json_safe "${_line#*  }" ledger_key)
  J_SHA=$(json_safe "${_line%%  *}" ledger_sha256)
  if [ "$_first" -eq 1 ]; then _sep=''; else _sep=','; fi
  _first=0
  printf '%s\n      {"key": %s, "sha256": %s}' "$_sep" "$J_KEY" "$J_SHA" >>"$TMP/ledger-objects.json"
done <"$STAGE/ledger-offsite.sha256"

{
  printf '{\n'
  printf '  "kind": "kapdh.backup_manifest",\n'
  printf '  "version": 1,\n'
  printf '  "backup_id": %s,\n' "$J_BACKUP_ID"
  printf '  "environment": %s,\n' "$J_ENV"
  printf '  "restic_host": %s,\n' "$J_HOST"
  printf '  "started_at": %s,\n' "$J_STARTED"
  printf '  "manifest_written_at": %s,\n' "$J_WRITTEN"
  printf '  "consistency": "db_snapshot_then_files",\n'
  printf '  "retention_days": %s,\n' "$J_RETENTION"
  printf '  "tools": {\n'
  printf '    "restic": %s,\n' "$J_RESTIC"
  printf '    "rclone": %s,\n' "$J_RCLONE"
  printf '    "pg_dump": %s\n' "$J_PG_DUMP"
  printf '  },\n'
  printf '  "images": {\n'
  printf '    "api": %s,\n' "$J_IMG_API"
  printf '    "worker": %s,\n' "$J_IMG_WORKER"
  printf '    "web": %s,\n' "$J_IMG_WEB"
  printf '    "admin": %s\n' "$J_IMG_ADMIN"
  printf '  },\n'
  printf '  "database": {\n'
  printf '    "dump_file": "db.dump",\n'
  printf '    "dump_format": "custom",\n'
  printf '    "db_dump_sha256": %s,\n' "$J_DB_SHA"
  printf '    "db_dump_bytes": %s,\n' "$J_DB_BYTES"
  printf '    "db_toc_entries": %s,\n' "$J_DB_TOC"
  printf '    "db_snapshot_captured_at": %s,\n' "$J_DB_CAPTURED"
  printf '    "db_dump_seconds": %s,\n' "$J_DB_SECONDS"
  printf '    "stats": %s\n' "$STATS"
  printf '  },\n'
  printf '  "files": {\n'
  printf '    "files_root": %s,\n' "$J_FILES_ROOT"
  printf '    "files_snapshot_id": %s,\n' "$J_FILES_SNAPSHOT"
  printf '    "files_snapshot_started_at": %s,\n' "$J_FILES_STARTED"
  printf '    "files_total": %s,\n' "$J_FILES_TOTAL"
  printf '    "files_bytes": %s,\n' "$J_FILES_BYTES"
  printf '    "files_local_ledger_entries": %s\n' "$J_LOCAL_LEDGER"
  printf '  },\n'
  printf '  "deletion_ledger": {\n'
  printf '    "ledger_offsite_remote": %s,\n' "$J_LEDGER_REMOTE"
  printf '    "ledger_offsite_dir": "ledger-offsite",\n'
  printf '    "ledger_offsite_entries": %s,\n' "$J_LEDGER_ENTRIES"
  printf '    "ledger_offsite_index_sha256": %s,\n' "$J_LEDGER_INDEX"
  printf '    "objects": ['
  cat "$TMP/ledger-objects.json"
  if [ "$_first" -eq 1 ]; then printf ']\n'; else printf '\n    ]\n'; fi
  printf '  }\n'
  printf '}\n'
} >"$STAGE/manifest.json"
MANIFEST_SHA=$(sha256_of "$STAGE/manifest.json")

# ------------------------------------------------------------------------------------------- 5. unggah
log "5/6 unggah dump + manifest + salinan ledger (snapshot restic terenkripsi)"
# shellcheck disable=SC2086
restic backup --json --host "$RESTIC_HOST" \
  --tag "kapdh,kapdh-db,env-$KAPDH_ENV,$BACKUP_ID" \
  ${RESTIC_BACKUP_ARGS:-} "$STAGE" >"$TMP/db.json" 2>"$TMP/db.err" ||
  die "restic backup dump gagal: $(tail -n 3 "$TMP/db.err" | tr '\n' ' ' | cut -c 1-300)"
DB_SNAPSHOT=$(restic_summary_field "$TMP/db.json" snapshot_id)
[ -n "$DB_SNAPSHOT" ] || die "id snapshot dump tidak ditemukan di keluaran restic"
# Baca-balik: manifest di repositori identik dengan salinan lokal.
REMOTE_MANIFEST_SHA=$(restic dump "$DB_SNAPSHOT" "$STAGE/manifest.json" 2>/dev/null | sha256sum | cut -d ' ' -f 1)
[ "$REMOTE_MANIFEST_SHA" = "$MANIFEST_SHA" ] || die "manifest di repositori tidak cocok dengan salinan lokal"

# ------------------------------------------------------------------------------------------- 6. retensi
# a) Snapshot dump (+ manifest) di luar jendela RETENTION_DAYS dilupakan (relatif terhadap snapshot dump terbaru).
# b) Snapshot berkas dilupakan BERPASANGAN: hanya dipertahankan bila snapshot dump dengan backup_id yang sama masih ada.
#    Tanpa ini grup berkas dihitung mundur dari waktunya sendiri (snapshot berkas diambil beberapa menit/jam sebelum
#    dump diunggah), sehingga manifest tertua yang masih ada dapat merujuk snapshot berkas yang sudah dibuang. Snapshot
#    berkas dari run gagal (tanpa dump) ikut dilupakan: restore selalu berawal dari manifest.
# c) prune --max-unused 0: pack yang bercampur blob terpakai dan tidak terpakai juga dikemas ulang, sehingga data akun
#    terhapus tidak tertahan melewati masa rotasi (bawaan restic menoleransi 5 % data tak terpakai; D2).
log "6/6 retensi: dump keep-within ${RETENTION_DAYS}d, berkas berpasangan dengan dump, prune=${RESTIC_PRUNE}"
restic forget --host "$RESTIC_HOST" --tag kapdh-db --group-by host,paths --keep-within "${RETENTION_DAYS}d" \
  >"$TMP/forget.log" 2>&1 || die "restic forget (dump) gagal: $(tail -n 3 "$TMP/forget.log" | tr '\n' ' ')"
restic snapshots --json --host "$RESTIC_HOST" --tag kapdh-db >"$TMP/db-snapshots.json" 2>>"$TMP/forget.log" ||
  die "daftar snapshot dump gagal dibaca untuk retensi"
restic snapshots --json --host "$RESTIC_HOST" --tag kapdh-files >"$TMP/files-snapshots.json" 2>>"$TMP/forget.log" ||
  die "daftar snapshot berkas gagal dibaca untuk retensi"
restic_backup_pairs "$TMP/db-snapshots.json" | cut -d ' ' -f 2 | sed '/^$/d' | LC_ALL=C sort -u >"$TMP/keep-backup-ids"
restic_backup_pairs "$TMP/files-snapshots.json" >"$TMP/files-pairs"
# Pengaman: run ini sendiri wajib terbaca di kedua daftar; bila tidak (format JSON restic berubah), tidak ada snapshot
# berkas yang dilupakan.
grep -qx "$BACKUP_ID" "$TMP/keep-backup-ids" || die "retensi dibatalkan: snapshot dump run ini tidak terbaca"
grep -q "^$FILES_SNAPSHOT[0-9a-f]* $BACKUP_ID\$" "$TMP/files-pairs" ||
  die "retensi dibatalkan: snapshot berkas run ini tidak terbaca beserta backup_id-nya"
: >"$TMP/forget-files"
while read -r _id _bid; do
  [ -n "$_id" ] || continue
  if [ -z "$_bid" ]; then
    log "PERINGATAN: snapshot berkas $_id tanpa tag backup_id; tidak diubah, tinjau manual"
    continue
  fi
  grep -qx "$_bid" "$TMP/keep-backup-ids" || printf '%s\n' "$_id" >>"$TMP/forget-files"
done <"$TMP/files-pairs"
FORGET_FILES=$(wc -l <"$TMP/forget-files" | tr -d ' ')
if [ "$FORGET_FILES" -gt 0 ]; then
  # shellcheck disable=SC2046 # id heksadesimal, satu per baris
  restic forget $(cat "$TMP/forget-files") >>"$TMP/forget.log" 2>&1 ||
    die "restic forget (berkas berpasangan) gagal: $(tail -n 3 "$TMP/forget.log" | tr '\n' ' ')"
fi
log "retensi: $(wc -l <"$TMP/keep-backup-ids" | tr -d ' ') backup dipertahankan, $FORGET_FILES snapshot berkas dilupakan"
if [ "$RESTIC_PRUNE" = 1 ]; then
  restic prune --max-unused 0 >>"$TMP/forget.log" 2>&1 ||
    die "restic prune gagal: $(tail -n 3 "$TMP/forget.log" | tr '\n' ' ')"
fi

FINISHED_EPOCH=$(now_epoch)
DURATION=$((FINISHED_EPOCH - STARTED_EPOCH))
mkdir -p "$WORK_DIR/status"
{
  printf 'backup_id=%s\n' "$BACKUP_ID"
  printf 'db_snapshot=%s\n' "$DB_SNAPSHOT"
  printf 'files_snapshot=%s\n' "$FILES_SNAPSHOT"
  printf 'db_snapshot_captured_at=%s\n' "$DB_CAPTURED_AT"
  printf 'finished_at=%s\n' "$(now_iso)"
  printf 'finished_epoch=%s\n' "$FINISHED_EPOCH"
  printf 'duration_seconds=%s\n' "$DURATION"
  printf 'manifest_sha256=%s\n' "$MANIFEST_SHA"
} >"$WORK_DIR/status/last-success"
if [ -n "$IMAGES_MISSING" ]; then
  FAIL_NOTE="backup $BACKUP_ID TERSIMPAN (db=$DB_SNAPSHOT), tetapi images.$IMAGES_MISSING kosong di manifest"
  die "isi IMAGE_* (tag@digest dari langkah rilis) atau CONTAINER_* di backup.env (PRD 5.5)"
fi
log "selesai $BACKUP_ID: db=$DB_SNAPSHOT files=$FILES_SNAPSHOT ledger=$LEDGER_ENTRIES objek, ${DURATION}s"
kuma_push "$KUMA_PUSH_BACKUP" up "$BACKUP_ID ledger=$LEDGER_ENTRIES" "$DURATION"
