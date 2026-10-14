#!/bin/sh
# Restore KAPDH ke LINGKUNGAN BERSIH (PRD 5.5, 8.4, N-06, AC F14-6; runbook docs/runbooks/backup-restore.md).
#
#   KAPDH_BACKUP_ENV=/etc/kapdh/restore.env infra/backup/restore.sh --target-kind drill [--snapshot <id>|latest] [--yes]
#
# Urutan (layanan API/worker/web TETAP MATI sampai skrip selesai dan seluruh pemeriksaan lulus):
#   1. Prasyarat: database tujuan belum berisi skema app/drizzle, FILES_ROOT kosong, alat tersedia.
#   2. Ambil snapshot dump (kapdh-db) dari restic, cocokkan sha256 dump dengan manifest.
#   3. Database: roles.sql -> pg_restore --single-transaction -> roles.sql (grant objek, append-only).
#   4. (Opsional) MIGRATE_CMD bila image yang dipakai lebih baru dari skema backup, lalu roles.sql lagi.
#   5. Berkas: restore snapshot berkas yang DIRUJUK manifest (bukan "terbaru"), cocokkan jumlah berkas.
#   6. Deletion ledger: salinan bucket luar VPS TERBARU (rclone) + salinan di backup + ledger di berkas pulihan ke
#      <bukti>/ledger (hanya id dan object key; dipakai lagi oleh verify-restore.sh --post-start), dimiliki FILES_OWNER
#      agar terbaca pengguna image (node, uid 1000), lalu LEDGER_REAPPLY_CMD (CLI ledger-reapply) wajib keluar 0.
#      AC F14-6: sebelum layanan dibuka. CLI tidak membutuhkan Redis (Redis pulihan boleh belum menyala).
#   7. Replay outbox: lease instance lama dilepas (sql/release-outbox.sql); worker baru memproses ulang.
#   8. verify-restore.sh: jumlah + total uang vs manifest, ledger diterapkan, berkas, Super Admin, (opsional) HTTP.
#   9. Ringkasan bukti: RTO (durasi skrip) dan umur backup (RPO) di folder bukti.
#
# Pengguna: root (berkas pulihan dan salinan ledger di-chown ke FILES_OWNER) atau uid FILES_OWNER sendiri; pengguna lain
# ditolak sebelum mengunduh apa pun karena CLI di kontainer (uid 1000) tidak akan bisa membaca/menghapus berkasnya.
# Restore data production ke staging DILARANG (PRD 5.3); drill memakai lingkungan bersih terisolasi yang dimusnahkan
# setelah selesai. Keluar bukan nol = jangan buka layanan.
set -eu
umask 077

KAPDH_BACKUP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-restore
# shellcheck source=lib.sh
. "$KAPDH_BACKUP_DIR/lib.sh"

usage() {
  cat <<'EOF'
Pakai: restore.sh --target-kind drill|production [opsi]
  --target-kind K                drill (lingkungan bersih sementara) atau production (pemulihan bencana)
  --snapshot ID|latest           snapshot restic kapdh-db (bawaan: latest untuk RESTIC_HOST)
  --evidence-dir DIR             folder bukti (bawaan: $WORK_DIR/evidence/<run>)
  --yes                          tanpa konfirmasi interaktif
  --allow-missing-offsite-ledger HANYA bila bucket ledger luar VPS hilang permanen; akun yang dihapus sesudah
                                 backup dapat muncul kembali (catat dan laporkan, AC F14-6)
  --baseline-empty               bukti PRD 8.2 langkah 1 (backup/restore database tanpa data pengguna, sebelum
                                 bootstrap Super Admin): nol Super Admin menjadi WARN, bukan FAIL
Konfigurasi lewat env/berkas (KAPDH_BACKUP_ENV, lihat infra/backup/backup.env.example bagian restore).
EOF
}

SNAPSHOT=latest
TARGET_KIND=''
EVIDENCE_DIR=''
ASSUME_YES=0
ALLOW_NO_OFFSITE=0
BASELINE_EMPTY=0
while [ $# -gt 0 ]; do
  case $1 in
    --snapshot | --target-kind | --evidence-dir)
      [ $# -ge 2 ] || die "argumen $1 membutuhkan nilai"
      case $1 in
        --snapshot) SNAPSHOT=$2 ;;
        --target-kind) TARGET_KIND=$2 ;;
        --evidence-dir) EVIDENCE_DIR=$2 ;;
      esac
      shift 2
      ;;
    --yes) ASSUME_YES=1 && shift ;;
    --allow-missing-offsite-ledger) ALLOW_NO_OFFSITE=1 && shift ;;
    --baseline-empty) BASELINE_EMPTY=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) die "argumen tidak dikenal: $1 (lihat --help)" ;;
  esac
done
case $TARGET_KIND in
  drill | production) ;;
  *) die "--target-kind wajib drill atau production (staging tidak boleh menerima data production, PRD 5.3)" ;;
esac

load_config

KAPDH_ENV=${KAPDH_ENV:-production}
RESTIC_HOST=${RESTIC_HOST:-kapdh-$KAPDH_ENV}
WORK_DIR=${WORK_DIR:-/var/restore/kapdh}
RESTORE_DB=${RESTORE_DB:-kapdh}
RESTORE_ADMIN_DB=${RESTORE_ADMIN_DB:-postgres}
FILES_ROOT=${FILES_ROOT:-/data/files}
# uid[:gid] pengguna image API/worker (node = 1000:1000). Kosong (FILES_OWNER= di berkas env) = CLI berjalan sebagai
# pengguna skrip ini (mis. LEDGER_REAPPLY_CMD langsung di host).
FILES_OWNER=${FILES_OWNER-1000:1000}
ROLES_SQL=${ROLES_SQL:-$KAPDH_BACKUP_DIR/../db/roles.sql}
LEDGER_RCLONE_REMOTE=${LEDGER_RCLONE_REMOTE:-}
LEDGER_REAPPLY_CMD=${LEDGER_REAPPLY_CMD:-}
MIGRATE_CMD=${MIGRATE_CMD:-}
KUMA_PUSH_RESTORE=${KUMA_PUSH_RESTORE:-}

case $RESTORE_DB in '' | *[!a-z0-9_]*) die "RESTORE_DB hanya huruf kecil, angka, garis bawah" ;; esac
case $SNAPSHOT in latest) ;; '' | *[!0-9a-f]*) die "--snapshot harus id heksadesimal restic atau latest" ;; esac
require_var RESTIC_REPOSITORY LEDGER_REAPPLY_CMD
[ -n "${RESTIC_PASSWORD_FILE:-}${RESTIC_PASSWORD_COMMAND:-}" ] || die "RESTIC_PASSWORD_FILE wajib"
[ -f "$ROLES_SQL" ] || die "ROLES_SQL $ROLES_SQL tidak ada"
RUN_UID=$(id -u)
if [ -n "$FILES_OWNER" ]; then
  case $FILES_OWNER in *[!0-9:]* | :* | *: | *:*:*) die "FILES_OWNER harus uid atau uid:gid numerik" ;; esac
  if [ "$RUN_UID" != 0 ] && [ "$RUN_UID" != "${FILES_OWNER%%:*}" ]; then
    die "jalankan restore.sh sebagai root atau uid ${FILES_OWNER%%:*} (FILES_OWNER): berkas pulihan dan salinan ledger wajib dapat dibaca/dihapus CLI ledger-reapply di kontainer"
  fi
fi
require_cmd restic sha256sum find sort sed tr wc head cut cp
[ -n "${PG_EXEC:-}" ] || require_cmd psql pg_restore
if [ -n "$LEDGER_RCLONE_REMOTE" ]; then
  require_cmd rclone
elif [ "$ALLOW_NO_OFFSITE" -ne 1 ]; then
  die "LEDGER_RCLONE_REMOTE wajib: ledger luar VPS TERBARU harus diterapkan ulang sebelum layanan dibuka (AC F14-6)"
fi
# Sandi role LOGIN (ALTER ROLE ... PASSWORD ...) dari berkas 0600 di host restore; diperiksa sebelum mengunduh apa pun.
ROLE_PASSWORDS_SQL=${ROLE_PASSWORDS_SQL:-}
if [ -n "$ROLE_PASSWORDS_SQL" ]; then
  [ -f "$ROLE_PASSWORDS_SQL" ] || die "ROLE_PASSWORDS_SQL $ROLE_PASSWORDS_SQL tidak ada"
  [ -z "$(find "$ROLE_PASSWORDS_SQL" -prune -perm -004 2>/dev/null)" ] || die "ROLE_PASSWORDS_SQL dapat dibaca semua pengguna"
fi

T0_EPOCH=$(now_epoch)
T0=$(now_iso)
RUN_ID="restore-$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR=${EVIDENCE_DIR:-$WORK_DIR/evidence/$RUN_ID}
TMP=$WORK_DIR/tmp/$RUN_ID
mkdir -p "$EVIDENCE_DIR" "$TMP"
chmod 700 "$WORK_DIR" "$TMP"
KAPDH_LOG_FILE=$EVIDENCE_DIR/restore.log
LOCK=$WORK_DIR/.restore.lock
acquire_lock "$LOCK"

cleanup() {
  _code=$?
  set +e
  # Dump berisi data pribadi dan dihapus; folder bukti hanya berisi angka, log dan salinan ledger (id dan object key).
  rm -rf "$TMP"
  release_lock "$LOCK"
  if [ "$_code" -ne 0 ]; then
    log "RESTORE GAGAL (kode $_code). JANGAN buka layanan. Bukti: $EVIDENCE_DIR"
    kuma_push "$KUMA_PUSH_RESTORE" down "restore $RUN_ID gagal" ""
  fi
  exit "$_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  log "$*"
  printf '%s %s\n' "$(now_iso)" "$*" >>"$EVIDENCE_DIR/timeline.txt"
}

# Menjalankan SQL dari stdin pada database tertentu dengan variabel psql (-v nama=nilai ...).
sql_on() {
  _db=$1
  shift
  psql_q -d "$_db" "$@" -f -
}

step "0/8 mulai restore $RUN_ID (target: $TARGET_KIND, database $RESTORE_DB, berkas $FILES_ROOT)"

# ------------------------------------------------------------------------------------------- 1. prasyarat
DB_EXISTS=$(printf '%s\n' "/* kapdh:db-exists */ select count(*) from pg_database where datname = :'db';" |
  sql_on "$RESTORE_ADMIN_DB" -v db="$RESTORE_DB")
if [ "$DB_EXISTS" = 1 ]; then
  DIRTY=$(printf '%s\n' "/* kapdh:target-state */ select count(*) from pg_namespace where nspname in ('app', 'drizzle');" |
    sql_on "$RESTORE_DB")
  [ "$DIRTY" = 0 ] || die "database $RESTORE_DB tidak bersih (skema app/drizzle sudah ada); restore hanya ke lingkungan bersih"
fi
if [ -d "$FILES_ROOT" ] && [ -n "$(ls -A "$FILES_ROOT" 2>/dev/null)" ]; then
  die "FILES_ROOT $FILES_ROOT tidak kosong; restore hanya ke volume berkas bersih"
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Restore %s ke database %s dan %s. Pastikan API/worker/web MATI. Ketik PULIHKAN untuk lanjut: ' \
    "$TARGET_KIND" "$RESTORE_DB" "$FILES_ROOT" >&2
  read -r _answer || _answer=''
  [ "$_answer" = PULIHKAN ] || die "dibatalkan operator"
fi

# ------------------------------------------------------------------------------------------- 2. snapshot dump
step "1/8 mengambil snapshot dump dari repositori restic"
if [ "$SNAPSHOT" = latest ]; then
  restic snapshots --no-lock --json --host "$RESTIC_HOST" --tag kapdh-db --latest 1 >"$TMP/snapshots.json" ||
    die "daftar snapshot restic gagal dibaca"
  _count=$(restic_ids "$TMP/snapshots.json" | wc -l | tr -d ' ')
  [ "$_count" = 1 ] || die "ditemukan $_count snapshot kapdh-db terbaru untuk $RESTIC_HOST; pilih --snapshot <id>"
  DB_SNAPSHOT=$(restic_first_id "$TMP/snapshots.json")
else
  DB_SNAPSHOT=$SNAPSHOT
fi
restic restore --no-lock "$DB_SNAPSHOT" --target "$TMP/db" >"$EVIDENCE_DIR/restic-restore-db.log" 2>&1 ||
  die "restic restore snapshot dump $DB_SNAPSHOT gagal"
MANIFEST=$(find "$TMP/db" -type f -name manifest.json | head -n 1)
[ -n "$MANIFEST" ] || die "manifest.json tidak ada di snapshot $DB_SNAPSHOT"
STAGE_DIR=$(dirname "$MANIFEST")
[ "$(manifest_get "$MANIFEST" kind)" = kapdh.backup_manifest ] || die "berkas manifest tidak dikenal"
cp "$MANIFEST" "$EVIDENCE_DIR/manifest.json"
BACKUP_ID=$(manifest_get "$MANIFEST" backup_id)
BACKUP_ENV=$(manifest_get "$MANIFEST" environment)
DB_SHA_EXPECTED=$(manifest_get "$MANIFEST" db_dump_sha256)
CAPTURED_AT=$(manifest_get "$MANIFEST" db_snapshot_captured_at)
FILES_SNAPSHOT=$(manifest_get "$MANIFEST" files_snapshot_id)
BACKUP_FILES_ROOT=$(manifest_get "$MANIFEST" files_root)
FILES_TOTAL_EXPECTED=$(manifest_get "$MANIFEST" files_total)
[ -n "$FILES_SNAPSHOT" ] && [ -n "$BACKUP_FILES_ROOT" ] || die "manifest tidak memuat snapshot berkas"
DB_SHA_ACTUAL=$(sha256_of "$STAGE_DIR/db.dump")
[ "$DB_SHA_ACTUAL" = "$DB_SHA_EXPECTED" ] || die "sha256 dump tidak cocok dengan manifest (backup rusak)"
step "backup $BACKUP_ID (lingkungan $BACKUP_ENV, snapshot DB $CAPTURED_AT); dump terverifikasi sha256"
if [ "$BACKUP_ENV" = production ] && [ "$TARGET_KIND" = drill ]; then
  log "PERINGATAN: data pribadi production. Lingkungan drill wajib berakses setara production dan dimusnahkan setelah drill (PRD 5.3)."
fi

# ------------------------------------------------------------------------------------------- 3. database
step "2/8 database: roles.sql -> pg_restore (satu transaksi) -> roles.sql"
if [ "$DB_EXISTS" != 1 ]; then
  printf '%s\n' "/* kapdh:create-db */ CREATE DATABASE :\"db\";" | sql_on "$RESTORE_ADMIN_DB" -v db="$RESTORE_DB" ||
    die "CREATE DATABASE $RESTORE_DB gagal"
fi
sql_on "$RESTORE_DB" <"$ROLES_SQL" >"$EVIDENCE_DIR/roles-before.log" 2>&1 || die "roles.sql (sebelum restore) gagal"
# Sandi role sesudah roles.sql pertama (role sudah ada); keluaran dibuang agar tidak ada yang tercatat di bukti.
if [ -n "$ROLE_PASSWORDS_SQL" ]; then
  sql_on "$RESTORE_ADMIN_DB" <"$ROLE_PASSWORDS_SQL" >/dev/null 2>&1 || die "pengaturan sandi role gagal"
fi
pg pg_restore --single-transaction --exit-on-error --no-password -d "$RESTORE_DB" <"$STAGE_DIR/db.dump" \
  >"$EVIDENCE_DIR/pg_restore.log" 2>&1 || die "pg_restore gagal (lihat pg_restore.log)"
sql_on "$RESTORE_DB" <"$ROLES_SQL" >"$EVIDENCE_DIR/roles-after.log" 2>&1 || die "roles.sql (sesudah restore) gagal"

if [ -n "$MIGRATE_CMD" ]; then
  step "3/8 migrasi skema ke versi image rilis (MIGRATE_CMD), lalu roles.sql"
  sh -c "$MIGRATE_CMD" >"$EVIDENCE_DIR/migrate.log" 2>&1 || die "migrasi gagal (lihat migrate.log)"
  sql_on "$RESTORE_DB" <"$ROLES_SQL" >"$EVIDENCE_DIR/roles-after-migrate.log" 2>&1 || die "roles.sql gagal"
else
  step "3/8 migrasi dilewati (image rilis memakai versi skema yang sama dengan backup)"
fi

# ------------------------------------------------------------------------------------------- 4. berkas
step "4/8 berkas: snapshot $FILES_SNAPSHOT ($BACKUP_FILES_ROOT) -> $FILES_ROOT"
mkdir -p "$FILES_ROOT"
restic restore --no-lock "$FILES_SNAPSHOT:$BACKUP_FILES_ROOT" --target "$FILES_ROOT" \
  >"$EVIDENCE_DIR/restic-restore-files.log" 2>&1 || die "restic restore berkas gagal"
FILES_RESTORED=$(find "$FILES_ROOT" -type f | wc -l | tr -d ' ')
if [ -n "$FILES_TOTAL_EXPECTED" ] && [ "$FILES_RESTORED" != "$FILES_TOTAL_EXPECTED" ]; then
  die "jumlah berkas pulihan $FILES_RESTORED berbeda dari manifest $FILES_TOTAL_EXPECTED"
fi
if [ "$RUN_UID" = 0 ] && [ -n "$FILES_OWNER" ]; then chown -R "$FILES_OWNER" "$FILES_ROOT"; fi
log "berkas pulihan: $FILES_RESTORED (manifest: ${FILES_TOTAL_EXPECTED:-?})"

# ------------------------------------------------------------------------------------------- 5. deletion ledger
step "5/8 deletion ledger: salinan TERBARU bucket luar VPS + salinan backup + ledger di berkas pulihan"
# Di folder bukti, bukan TMP: verify-restore.sh --post-start sesudah layanan menyala membutuhkannya lagi. Isinya hanya
# id dan object key (tanpa nama/email/telepon); tetap jangan disalin ke repo (docs/qa).
LEDGER_WORK=$EVIDENCE_DIR/ledger
rm -rf "$LEDGER_WORK"
mkdir -p "$LEDGER_WORK"
if [ -n "$LEDGER_RCLONE_REMOTE" ]; then
  rclone copy "$LEDGER_RCLONE_REMOTE" "$LEDGER_WORK/offsite-now" --include "/account-deletions/**" \
    >"$EVIDENCE_DIR/rclone-ledger.log" 2>&1 || die "salinan bucket deletion ledger luar VPS gagal"
  mkdir -p "$LEDGER_WORK/offsite-now"
else
  log "PERINGATAN: --allow-missing-offsite-ledger: hanya ledger dari backup yang diterapkan (AC F14-6 TIDAK terjamin)"
  printf 'ledger_offsite_missing=1\n' >>"$EVIDENCE_DIR/summary.txt"
fi
if [ -d "$STAGE_DIR/ledger-offsite" ]; then cp -R "$STAGE_DIR/ledger-offsite" "$LEDGER_WORK/offsite-backup"; fi
if [ -d "$FILES_ROOT/ledger/account-deletions" ]; then
  cp -R "$FILES_ROOT/ledger/account-deletions" "$LEDGER_WORK/files-backup"
fi
# umask 077 membuat salinan 0700/0600 milik pengguna skrip; CLI di image berjalan sebagai FILES_OWNER (node, uid 1000).
if [ "$RUN_UID" = 0 ] && [ -n "$FILES_OWNER" ]; then chown -R "$FILES_OWNER" "$LEDGER_WORK"; fi
LEDGER_FILES=$(find "$LEDGER_WORK" -type f -name '*.json' | wc -l | tr -d ' ')
log "berkas entri ledger: $LEDGER_FILES"

# Argumen --dir: path di host, atau di dalam kontainer CLI bila LEDGER_DIR_IN_CMD diisi (LEDGER_WORK dipasang ke
# sana; perintah dapat memakai $KAPDH_LEDGER_DIR untuk -v <host>:<kontainer>).
KAPDH_LEDGER_DIR=$LEDGER_WORK
export KAPDH_LEDGER_DIR
DIR_PREFIX=${LEDGER_DIR_IN_CMD:-$LEDGER_WORK}
set --
for _sub in offsite-now offsite-backup files-backup; do
  if [ -d "$LEDGER_WORK/$_sub" ]; then set -- "$@" --dir "$DIR_PREFIX/$_sub"; fi
done
[ $# -gt 0 ] || die "tidak ada salinan ledger sama sekali"
sh -c "$LEDGER_REAPPLY_CMD \"\$@\"" ledger-reapply "$@" >"$EVIDENCE_DIR/ledger-reapply.log" 2>&1 ||
  die "CLI ledger-reapply gagal (lihat ledger-reapply.log); JANGAN buka layanan (AC F14-6)"
log "ledger-reapply: $(tr '\n' ';' <"$EVIDENCE_DIR/ledger-reapply.log" | cut -c 1-400)"

# ------------------------------------------------------------------------------------------- 6. outbox
step "6/8 replay outbox: lepas lease instance lama"
sql_on "$RESTORE_DB" <"$KAPDH_BACKUP_DIR/sql/release-outbox.sql" >"$EVIDENCE_DIR/outbox.txt" ||
  die "pelepasan lease outbox gagal"
log "outbox: $(tr '\n' ' ' <"$EVIDENCE_DIR/outbox.txt")"

# ------------------------------------------------------------------------------------------- 7. verifikasi
step "7/8 verifikasi konsistensi (verify-restore.sh)"
VERIFY_MODE=''
[ "$BASELINE_EMPTY" -eq 1 ] && VERIFY_MODE=--baseline-empty
# shellcheck disable=SC2086 # VERIFY_MODE kosong atau satu opsi
"$KAPDH_BACKUP_DIR/verify-restore.sh" --manifest "$MANIFEST" --db "$RESTORE_DB" --files-root "$FILES_ROOT" \
  --ledger-dir "$LEDGER_WORK" --report "$EVIDENCE_DIR/verify-report.txt" $VERIFY_MODE ||
  die "verifikasi gagal (lihat verify-report.txt); JANGAN buka layanan"

# ------------------------------------------------------------------------------------------- 8. ringkasan
T_END_EPOCH=$(now_epoch)
RTO_SECONDS=$((T_END_EPOCH - T0_EPOCH))
CAPTURED_EPOCH=$(date -u -d "$CAPTURED_AT" +%s 2>/dev/null || true)
BACKUP_AGE_SECONDS=''
[ -n "$CAPTURED_EPOCH" ] && BACKUP_AGE_SECONDS=$((T0_EPOCH - CAPTURED_EPOCH))
{
  printf 'run_id=%s\n' "$RUN_ID"
  printf 'target_kind=%s\n' "$TARGET_KIND"
  printf 'backup_id=%s\n' "$BACKUP_ID"
  printf 'db_snapshot=%s\n' "$DB_SNAPSHOT"
  printf 'files_snapshot=%s\n' "$FILES_SNAPSHOT"
  printf 'db_snapshot_captured_at=%s\n' "$CAPTURED_AT"
  printf 'restore_started_at=%s\n' "$T0"
  printf 'restore_finished_at=%s\n' "$(now_iso)"
  printf 'restore_seconds=%s\n' "$RTO_SECONDS"
  printf 'backup_age_at_start_seconds=%s\n' "${BACKUP_AGE_SECONDS:-tidak-diketahui}"
  printf 'files_restored=%s\n' "$FILES_RESTORED"
  printf 'ledger_entry_files=%s\n' "$LEDGER_FILES"
  printf 'ledger_copy_dir=%s\n' "$LEDGER_WORK"
  printf 'baseline_empty=%s\n' "$BASELINE_EMPTY"
} >>"$EVIDENCE_DIR/summary.txt"
step "8/8 SELESAI dalam ${RTO_SECONDS}s; umur backup saat mulai: ${BACKUP_AGE_SECONDS:-?}s. Bukti: $EVIDENCE_DIR"
log "Langkah berikut (runbook bagian 7): Redis kosong -> API 1 replika tertutup (readiness deletion_ledger ok) -> worker -> verify-restore.sh --post-start --ledger-dir $LEDGER_WORK -> smoke test -> buka web/admin."
kuma_push "$KUMA_PUSH_RESTORE" up "restore $RUN_ID ${RTO_SECONDS}s" "$RTO_SECONDS"
