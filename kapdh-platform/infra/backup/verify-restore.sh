#!/bin/sh
# Verifikasi hasil restore KAPDH sebelum layanan dibuka (PRD 5.5 "memeriksa login/MFA, anggota, total uang, tiket, chat,
# berkas dan penghapusan terdahulu", PRD 8.4, PRD 9.2 #8, N-06, AC F14-6). Dipanggil restore.sh; dapat dijalankan
# ulang sendiri:
#
#   infra/backup/verify-restore.sh --manifest <manifest.json> [--db kapdh] [--files-root /data/files]
#     [--ledger-dir <folder salinan ledger>] [--report <berkas>] [--sample 50] [--post-start] [--baseline-empty]
#
#   --post-start     dijalankan ulang SESUDAH API/worker pulihan menyala (runbook bagian 7 langkah 6): lease outbox milik
#                    worker baru adalah normal (INFO, bukan FAIL). Pakai --ledger-dir <bukti>/ledger dari restore.sh.
#   --baseline-empty bukti PRD 8.2 langkah 1 (database tanpa data pengguna, sebelum bootstrap Super Admin): nol Super
#                    Admin menjadi WARN. Login/MFA admin drill dilewati bila DRILL_ADMIN_EMAIL kosong (WARN).
#   --report         bawaan: verify-report[-post-start]-<waktu>.txt di folder manifest (folder bukti restore.sh).
#
# Pemeriksaan (FAIL = jangan buka layanan; WARN = catat di bukti drill dan tindak lanjuti):
#   1. invariant  : jumlah akun, payment, payment paid, total uang per jenis, penyesuaian, tiket, event, room dan
#                   admin aktif SAMA PERSIS dengan statistik manifest (dihitung di snapshot dump yang sama).
#   2. skema      : jumlah migrasi = manifest (lebih besar hanya bila MIGRATE_CMD dijalankan -> WARN).
#   3. ledger     : setiap akun di deletion ledger yang ada di database berstatus deleted tanpa profil; objek berkas
#                   pada ledger tidak ada di FILES_ROOT; permintaan selesai tidak memiliki akun aktif.
#   4. berkas     : setiap baris `ready` driver local memiliki objek; sha256 sampel cocok; objek yatim dilaporkan.
#   5. Super Admin: minimal satu aktif (FAIL bila nol, WARN pada --baseline-empty), WARN bila kurang dari dua (PRD 8.2).
#   6. outbox     : lease lama sudah dilepas (INFO pada --post-start); event dead dilaporkan.
#   7. HTTP (bila VERIFY_API_URL diisi): /health, /health/ready, login + MFA admin drill, /admin/me, berkas publik.
set -eu
umask 077

KAPDH_BACKUP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
KAPDH_SCRIPT=kapdh-verify
# shellcheck source=lib.sh
. "$KAPDH_BACKUP_DIR/lib.sh"

MANIFEST=''
# DB/FILES bawaan diisi SESUDAH load_config: RESTORE_DB dan FILES_ROOT dapat datang dari berkas konfigurasi
# (KAPDH_BACKUP_ENV), bukan hanya dari environment pemanggil. Argumen --db/--files-root tetap menang.
DB=''
FILES=''
LEDGER_DIR=''
REPORT=''
SAMPLE=${VERIFY_SAMPLE:-50}
POST_START=0
BASELINE_EMPTY=0
while [ $# -gt 0 ]; do
  case $1 in
    --manifest | --db | --files-root | --ledger-dir | --report | --sample)
      [ $# -ge 2 ] || die "argumen $1 membutuhkan nilai"
      case $1 in
        --manifest) MANIFEST=$2 ;;
        --db) DB=$2 ;;
        --files-root) FILES=$2 ;;
        --ledger-dir) LEDGER_DIR=$2 ;;
        --report) REPORT=$2 ;;
        --sample) SAMPLE=$2 ;;
      esac
      shift 2
      ;;
    --post-start) POST_START=1 && shift ;;
    --baseline-empty) BASELINE_EMPTY=1 && shift ;;
    -h | --help)
      sed -n '2,24p' "$0"
      exit 0
      ;;
    *) die "argumen tidak dikenal: $1" ;;
  esac
done

load_config
DB=${DB:-${RESTORE_DB:-kapdh}}
FILES=${FILES:-${FILES_ROOT:-/data/files}}
[ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || die "--manifest wajib menunjuk manifest.json backup"
case $DB in '' | *[!a-z0-9_]*) die "--db hanya huruf kecil, angka, garis bawah" ;; esac
case $SAMPLE in '' | *[!0-9]*) die "--sample harus bilangan bulat" ;; esac
[ -n "${PG_EXEC:-}" ] || require_cmd psql
require_cmd sha256sum find sort sed tr wc head cut comm
# Bawaan di samping manifest (folder bukti restore.sh), bukan di folder kerja saat ini; nama berwaktu agar laporan
# restore.sh tidak tertimpa.
if [ -z "$REPORT" ]; then
  _suffix=''
  [ "$POST_START" -eq 1 ] && _suffix=-post-start
  REPORT="$(dirname "$MANIFEST")/verify-report$_suffix-$(date -u +%Y%m%dT%H%M%SZ).txt"
fi
: >"$REPORT"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/kapdh-verify.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

FAILS=0
WARNS=0
result() {
  # result PASS|WARN|FAIL nama detail
  printf '%-4s %-34s %s\n' "$1" "$2" "$3" | tee -a "$REPORT" >&2
  case $1 in FAIL) FAILS=$((FAILS + 1)) ;; WARN) WARNS=$((WARNS + 1)) ;; esac
  return 0
}

sql_file() {
  psql_q -d "$DB" "$@" -f -
}

[ "$(manifest_get "$MANIFEST" kind)" = kapdh.backup_manifest ] || die "manifest tidak dikenal"
EXPECTED=$(manifest_get_object "$MANIFEST" stats)
[ -n "$EXPECTED" ] || die "manifest tidak memuat statistik database"
_mode=sebelum-layanan
[ "$POST_START" -eq 1 ] && _mode=sesudah-layanan-menyala
[ "$BASELINE_EMPTY" -eq 1 ] && _mode="$_mode baseline-kosong"
printf 'manifest %s\nbackup %s\nverifikasi %s\nmode %s\n\n' "$MANIFEST" "$(manifest_get "$MANIFEST" backup_id)" \
  "$(now_iso)" "$_mode" >>"$REPORT"

# ------------------------------------------------------------------------------- 1-2. invariant dan skema
ACTUAL=$({
  printf "SELECT 'STATS=' || ("
  cat "$KAPDH_BACKUP_DIR/sql/stats.sql"
  printf ')::text;\n'
} | sql_file | sed -n 's/^STATS=//p')
case $ACTUAL in '{'*'}') ;; *) die "statistik database pulihan gagal dihitung" ;; esac
sql_file -v expected="$EXPECTED" -v actual="$ACTUAL" <"$KAPDH_BACKUP_DIR/sql/compare-stats.sql" >"$WORK/compare.txt"
while IFS='|' read -r grp key exp act; do
  [ -n "$grp" ] || continue
  case $grp in
    invariant)
      if [ "$exp" = "$act" ]; then result PASS "$key" "$act"; else result FAIL "$key" "manifest $exp, restore $act"; fi
      ;;
    schema)
      if [ "$exp" = "$act" ]; then
        result PASS "skema.$key" "$act"
      elif [ "$key" = applied ] && [ "$act" -gt "$exp" ] 2>/dev/null; then
        result WARN "skema.$key" "manifest $exp, restore $act (migrasi dijalankan sesudah restore)"
      elif [ "$key" = last_created_at ] && [ "$act" -gt "$exp" ] 2>/dev/null; then
        result WARN "skema.$key" "manifest $exp, restore $act (migrasi dijalankan sesudah restore)"
      else
        result FAIL "skema.$key" "manifest $exp, restore $act"
      fi
      ;;
    info)
      printf 'INFO %-34s manifest %s, restore %s\n' "$key" "$exp" "$act" >>"$REPORT"
      ;;
  esac
done <"$WORK/compare.txt"

# ------------------------------------------------------------------------------- 3. deletion ledger
: >"$WORK/ledger-users"
: >"$WORK/ledger-keys"
if [ -n "$LEDGER_DIR" ] && [ ! -d "$LEDGER_DIR" ]; then
  result FAIL ledger.folder "--ledger-dir tidak ada; pakai <bukti>/ledger dari restore.sh"
fi
if [ -z "$LEDGER_DIR" ] && [ "$POST_START" -eq 1 ]; then
  result FAIL ledger.folder "--post-start wajib --ledger-dir <bukti>/ledger (tanpanya pemeriksaan ledger kosong)"
fi
if [ -n "$LEDGER_DIR" ] && [ -d "$LEDGER_DIR" ]; then
  find "$LEDGER_DIR" -type f -name '*.json' >"$WORK/ledger-files"
  while IFS= read -r _f; do
    _flat=$(tr -d '\n\r' <"$_f")
    printf '%s\n' "$_flat" | grep -o '"user_id": *"[0-9a-f-]\{36\}"' | sed 's/.*"\([0-9a-f-]\{36\}\)"/\1/' >>"$WORK/ledger-users" || true
    printf '%s\n' "$_flat" | grep -o '"object_keys": *\[[^]]*\]' | grep -o '"[a-z0-9][a-z0-9._/-]*"' |
      tr -d '"' >>"$WORK/ledger-keys" || true
  done <"$WORK/ledger-files"
fi
LC_ALL=C sort -u -o "$WORK/ledger-users" "$WORK/ledger-users"
LC_ALL=C sort -u -o "$WORK/ledger-keys" "$WORK/ledger-keys"
LEDGER_USERS=$(wc -l <"$WORK/ledger-users" | tr -d ' ')
IDS="{$(paste -s -d ',' "$WORK/ledger-users")}"
sql_file -v ledger_user_ids="$IDS" <"$KAPDH_BACKUP_DIR/sql/verify-checks.sql" >"$WORK/checks.txt"
check_value() {
  sed -n "s/^$1=//p" "$WORK/checks.txt" | head -n 1
}
result INFO "ledger.akun" "$LEDGER_USERS akun pada ledger, $(check_value ledger_users_present) ada di database"
_v=$(check_value ledger_users_not_deleted)
if [ "$_v" = 0 ]; then result PASS ledger.akun_terhapus "semua akun ledger deleted/absen"; else result FAIL ledger.akun_terhapus "$_v akun ledger belum deleted (AC F14-6)"; fi
_v=$(check_value ledger_users_with_profile)
if [ "$_v" = 0 ]; then result PASS ledger.profil_terhapus "0"; else result FAIL ledger.profil_terhapus "$_v profil alumni masih ada"; fi
_v=$(check_value deletions_completed_not_deleted)
if [ "$_v" = 0 ]; then result PASS penghapusan.selesai "0 akun aktif"; else result FAIL penghapusan.selesai "$_v permintaan selesai dengan akun belum deleted"; fi
_present=0
while IFS= read -r _key; do
  [ -n "$_key" ] || continue
  if [ -e "$FILES/$_key" ]; then _present=$((_present + 1)); fi
done <"$WORK/ledger-keys"
if [ "$_present" -eq 0 ]; then
  result PASS ledger.objek_berkas "$(wc -l <"$WORK/ledger-keys" | tr -d ' ') objek ledger tidak ada di berkas"
else
  result FAIL ledger.objek_berkas "$_present objek berkas akun terhapus masih ada"
fi
_v=$(check_value deletions_open)
if [ "$_v" = 0 ]; then result PASS penghapusan.terbuka "0"; else result WARN penghapusan.terbuka "$_v permintaan terbuka; diproses worker setelah layanan menyala"; fi

# ------------------------------------------------------------------------------- 4. berkas
sql_file <"$KAPDH_BACKUP_DIR/sql/files-local.sql" >"$WORK/files.txt"
_ready=0
_missing=0
_checked=0
_mismatch=0
: >"$WORK/missing.txt"
: >"$WORK/db-keys"
while IFS=' ' read -r _key _sha _status; do
  [ -n "$_key" ] || continue
  printf '%s\n' "$_key" >>"$WORK/db-keys"
  [ "$_status" = ready ] || continue
  _ready=$((_ready + 1))
  if [ ! -f "$FILES/$_key" ]; then
    _missing=$((_missing + 1))
    printf '%s\n' "$_key" >>"$WORK/missing.txt"
    continue
  fi
  if [ "$_checked" -lt "$SAMPLE" ]; then
    _checked=$((_checked + 1))
    [ "$(sha256_of "$FILES/$_key")" = "$_sha" ] || _mismatch=$((_mismatch + 1))
  fi
done <"$WORK/files.txt"
MAX_MISSING=${VERIFY_MAX_MISSING_FILES:-10}
if [ "$_missing" -eq 0 ]; then
  result PASS berkas.ready "$_ready baris ready, semua objek ada"
elif [ "$_missing" -le "$MAX_MISSING" ]; then
  result WARN berkas.ready "$_missing dari $_ready objek tidak ada (dihapus di antara dump dan snapshot berkas; lihat runbook)"
  cp "$WORK/missing.txt" "$(dirname "$REPORT")/missing-objects.txt" 2>/dev/null || true
else
  result FAIL berkas.ready "$_missing dari $_ready objek tidak ada (> $MAX_MISSING)"
  cp "$WORK/missing.txt" "$(dirname "$REPORT")/missing-objects.txt" 2>/dev/null || true
fi
if [ "$_mismatch" -eq 0 ]; then result PASS berkas.sha256 "$_checked sampel cocok"; else result FAIL berkas.sha256 "$_mismatch dari $_checked sampel berbeda"; fi
# Objek yatim: ada di disk tanpa baris (diunggah sesudah dump); tidak pernah dilayani, dibersihkan terpisah.
if [ -d "$FILES" ]; then
  (cd "$FILES" && find . -type f ! -path './.tmp/*' ! -path './ledger/*' ! -path './health/*' | sed 's#^\./##') |
    LC_ALL=C sort >"$WORK/disk-keys"
  LC_ALL=C sort -o "$WORK/db-keys" "$WORK/db-keys"
  _orphans=$(comm -23 "$WORK/disk-keys" "$WORK/db-keys" | wc -l | tr -d ' ')
  result INFO berkas.yatim "$_orphans objek tanpa baris files (tidak dilayani)"
fi

# ------------------------------------------------------------------------------- 5-6. Super Admin, outbox
_v=$(check_value super_admins_active)
if [ "${_v:-0}" -ge 2 ] 2>/dev/null; then
  result PASS super_admin.aktif "$_v"
elif [ "${_v:-0}" -ge 1 ] 2>/dev/null; then
  result WARN super_admin.aktif "$_v (PRD 8.2: minimal dua sebelum go-live)"
elif [ "$BASELINE_EMPTY" -eq 1 ]; then
  result WARN super_admin.aktif "0 Super Admin aktif (baseline kosong PRD 8.2 langkah 1, sebelum bootstrap)"
else
  result FAIL super_admin.aktif "0 Super Admin aktif"
fi
_v=$(check_value outbox_leased)
if [ "$_v" = 0 ]; then
  result PASS outbox.lease "0 lease lama"
elif [ "$POST_START" -eq 1 ]; then
  result INFO outbox.lease "$_v event sedang diproses worker pulihan (normal sesudah worker menyala)"
else
  result FAIL outbox.lease "$_v event masih ber-lease (jalankan sql/release-outbox.sql)"
fi
_v=$(check_value outbox_dead)
if [ "$_v" = 0 ]; then result PASS outbox.dead "0"; else result WARN outbox.dead "$_v event dead; tinjau last_error sebelum diputuskan"; fi

# ------------------------------------------------------------------------------- 7. HTTP (opsional)
if [ -n "${VERIFY_API_URL:-}" ]; then
  VERIFY_PUBLIC_FILE_ID=$(sql_file <"$KAPDH_BACKUP_DIR/sql/public-file.sql" | head -n 1)
  export VERIFY_API_URL VERIFY_PUBLIC_FILE_ID
  # Secret admin drill dari berkas (0600) ke env proses anak saja, agar juga sampai ke `docker run -e NAMA`.
  if [ -n "${DRILL_ADMIN_PASSWORD_FILE:-}" ] && [ -z "${DRILL_ADMIN_PASSWORD:-}" ]; then
    DRILL_ADMIN_PASSWORD=$(cat "$DRILL_ADMIN_PASSWORD_FILE")
    export DRILL_ADMIN_PASSWORD
  fi
  if [ -n "${DRILL_ADMIN_TOTP_SECRET_FILE:-}" ] && [ -z "${DRILL_ADMIN_TOTP_SECRET:-}" ]; then
    DRILL_ADMIN_TOTP_SECRET=$(cat "$DRILL_ADMIN_TOTP_SECRET_FILE")
    export DRILL_ADMIN_TOTP_SECRET
  fi
  [ -z "${DRILL_ADMIN_EMAIL:-}" ] || export DRILL_ADMIN_EMAIL
  NODE_CMD=${NODE_CMD:-node}
  # shellcheck disable=SC2086 # NODE_CMD dapat berupa "docker run --rm -i ... <image-api> node"
  if $NODE_CMD --input-type=module - <"$KAPDH_BACKUP_DIR/verify-http.mjs" >"$WORK/http.txt" 2>&1; then :; fi
  while IFS=' ' read -r _status _name _detail; do
    case $_status in PASS | WARN | FAIL) result "$_status" "http.$_name" "$_detail" ;; esac
  done <"$WORK/http.txt"
  grep -Eq '^(PASS|WARN|FAIL) ' "$WORK/http.txt" ||
    result FAIL http.skrip "verify-http.mjs tidak berjalan ($(head -n 1 "$WORK/http.txt" | cut -c 1-200))"
else
  result WARN http "VERIFY_API_URL kosong; login/MFA admin drill dan akses berkas lewat API belum diuji"
fi

printf '\nRingkasan: %s FAIL, %s WARN\n' "$FAILS" "$WARNS" | tee -a "$REPORT" >&2
[ "$FAILS" -eq 0 ]
