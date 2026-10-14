#!/bin/sh
# Job rilis KAPDH: SATU job deployment per rilis, bukan setiap startup replica API/worker (PRD 5.5, 8.2 langkah 2-4,
# 9.2, 9.3; ARCHITECTURE §10). Entry image `kapdh-release` (infra/Dockerfile.api target `release`). Urutan:
#
#   1. tunggu PostgreSQL siap (pg_isready)
#   2. cek versi skema             baca saja: database dengan migrasi LEBIH BANYAK dari journal image ditolak di semua
#                                  mode (image lama di atas skema baru; roles.sql lama dapat memberi ulang hak yang
#                                  dicabut rilis baru). Rollback image tidak memakai job ini (runbook rilis bagian 6).
#   3. infra/db/roles.sql           role + hak tingkat database (superuser/pemilik database)
#   4. infra/db/role-passwords.sql  sandi role LOGIN dari env (hanya variabel yang terisi)
#   5. gerbang pra-migrasi          mode enforce: golive:check --preflight (konfigurasi pengurus, tanpa schema/settings)
#                                   SEBELUM skema berubah; ditolak → job berhenti, skema dan API lama tidak tersentuh
#   6. migrasi skema                sebagai kapdh_migrator, pg_advisory_lock 4711000517, semua migrasi tertunda 1 transaksi
#   7. infra/db/roles.sql           grant objek skema app (append-only, mfa_totp, sequence) diterapkan ulang
#   8. seed referensi               idempoten; hanya baris yang belum ada (nilai pengurus tidak ditimpa)
#   9. gerbang go-live penuh        golive:check; mode enforce menggagalkan job bila konfigurasi belum disahkan. Penolakan
#                                   di langkah ini terjadi SETELAH migrasi: perbaikan maju (PRD 8.4), bukan rollback skema.
#
# Environment:
#   KAPDH_ENV                    wajib: production | staging (D12: lingkungan terpisah)
#   ADMIN_DATABASE_URL           wajib: superuser/pemilik database (langkah 2, 3, 4, 7)
#   MIGRATOR_DATABASE_URL        wajib: login kapdh_migrator (langkah 5, 6, 8, 9)
#   KAPDH_MIGRATOR_DB_PASSWORD   opsional: sandi role (langkah 4); kosong = tidak diubah
#   KAPDH_APP_DB_PASSWORD        opsional: idem untuk kapdh_app
#   KAPDH_WORKER_DB_PASSWORD     opsional: idem untuk kapdh_worker
#   KAPDH_BACKUP_DB_PASSWORD     opsional: idem untuk kapdh_backup (backup harian, infra/backup)
#   KAPDH_MONITOR_DB_PASSWORD    opsional: idem untuk kapdh_monitor (pemeriksa kesehatan, infra/monitoring)
#   RELEASE_GATE                 enforce | report. Bawaan: enforce untuk production, report untuk staging.
#   RELEASE_GATE_REASON          wajib bila production + report (pengecualian gerbang): alasan tertulis, mis.
#                                "inisialisasi pertama PRD 8.2" atau "hotfix keamanan <id insiden>".
#   RELEASE_GATE_APPROVER        wajib bila production + report: nama penyetuju (pemilik produk/Super Admin, D9).
#                                Alasan dan penyetuju dicetak ke log job untuk paket bukti/log insiden (PRD 9.3).
#   RELEASE_DB_WAIT_SECONDS      batas menunggu database (bawaan 60)
#
# Kode keluar: 0 sukses; 1 langkah gagal atau gerbang menolak (enforce); 2 konfigurasi job salah. URL koneksi dan sandi
# tidak pernah dicetak (N-14). Jangan menjalankan dua job rilis bersamaan untuk database yang sama: migrasi aman berkat
# advisory lock, tetapi GRANT bersamaan dapat gagal "tuple concurrently updated" (ulangi job).
set -eu

APP_DIR="${APP_DIR:-/app}"
DB_DIR="${KAPDH_DB_SQL_DIR:-$APP_DIR/infra/db}"
NODE_BIN="${NODE_BIN:-node}"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_ISREADY_BIN="${PG_ISREADY_BIN:-pg_isready}"
JOURNAL="$APP_DIR/node_modules/@kapdh/database/migrations/meta/_journal.json"
GATE_CLI="$APP_DIR/dist/cli/golive-check.js"
export PGAPPNAME="kapdh-release"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

log() {
  printf '[rilis] %s\n' "$*"
}

die() {
  printf '[rilis] GAGAL: %s\n' "$1" >&2
  exit "${2:-1}"
}

# ------------------------------------------------------------------------------------------- validasi konfigurasi
KAPDH_ENV="${KAPDH_ENV:-}"
case "$KAPDH_ENV" in
  production | staging) ;;
  *) die "KAPDH_ENV wajib production atau staging." 2 ;;
esac

[ -n "${ADMIN_DATABASE_URL:-}" ] || die "ADMIN_DATABASE_URL wajib diisi." 2
[ -n "${MIGRATOR_DATABASE_URL:-}" ] || die "MIGRATOR_DATABASE_URL wajib diisi." 2

# Objek skema wajib dimiliki kapdh_migrator (roles.sql: default privileges, kaskade FK sebagai pemilik tabel).
migrator_user="$(printf '%s' "$MIGRATOR_DATABASE_URL" | sed -n 's#^postgres\(ql\)\{0,1\}://\([^:@/]*\)[:@].*#\2#p')"
if [ "$migrator_user" != "kapdh_migrator" ]; then
  die "MIGRATOR_DATABASE_URL harus login sebagai kapdh_migrator (ditemukan: ${migrator_user:-tidak terbaca})." 2
fi

if [ -z "${RELEASE_GATE:-}" ]; then
  if [ "$KAPDH_ENV" = "production" ]; then RELEASE_GATE="enforce"; else RELEASE_GATE="report"; fi
fi
case "$RELEASE_GATE" in
  enforce | report) ;;
  *) die "RELEASE_GATE wajib enforce atau report." 2 ;;
esac

wait_seconds="${RELEASE_DB_WAIT_SECONDS:-60}"
case "$wait_seconds" in
  '' | *[!0-9]*) die "RELEASE_DB_WAIT_SECONDS harus bilangan bulat." 2 ;;
esac

# Pengecualian gerbang di production (inisialisasi pertama, atau hotfix mendesak saat pemeriksaan konfigurasi yang
# tidak terkait perbaikan sedang merah) wajib beralasan dan disetujui; keduanya dicetak untuk paket bukti.
if [ "$KAPDH_ENV" = "production" ] && [ "$RELEASE_GATE" = "report" ]; then
  [ -n "${RELEASE_GATE_REASON:-}" ] && [ -n "${RELEASE_GATE_APPROVER:-}" ] \
    || die "RELEASE_GATE=report di production wajib disertai RELEASE_GATE_REASON dan RELEASE_GATE_APPROVER." 2
fi

log "lingkungan $KAPDH_ENV, mode gerbang $RELEASE_GATE"
if [ "$KAPDH_ENV" = "production" ] && [ "$RELEASE_GATE" = "report" ]; then
  log "PERINGATAN: PENGECUALIAN GERBANG go-live di production (mode laporan; PRD 9.2, 9.3)."
  log "PERINGATAN: alasan: $RELEASE_GATE_REASON"
  log "PERINGATAN: disetujui: $RELEASE_GATE_APPROVER"
  log "PERINGATAN: catat di log insiden/paket bukti; pemeriksaan merah wajib punya pemilik dan tenggat."
fi

# ----------------------------------------------------------------------------------------------- 1. database siap
log "1/9 menunggu PostgreSQL (maks. ${wait_seconds} detik)"
elapsed=0
until "$PG_ISREADY_BIN" -q -d "$ADMIN_DATABASE_URL" -t 5; do
  elapsed=$((elapsed + 5))
  [ "$elapsed" -lt "$wait_seconds" ] || die "PostgreSQL tidak siap dalam ${wait_seconds} detik."
  sleep 5
done

run_psql() {
  # -X: abaikan psqlrc; -v ON_ERROR_STOP=1: berhenti pada galat pertama; -q: tanpa gema perintah.
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$1"
}

query() {
  # Satu nilai tanpa header/perataan (-t -A).
  "$PSQL_BIN" "$ADMIN_DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

# ------------------------------------------------------------------------------------------ 2. versi skema vs image
log "2/9 versi skema database dibanding journal image"
[ -r "$JOURNAL" ] || die "journal migrasi image tidak ada ($JOURNAL)."
image_migrations="$(grep -o '"tag"' "$JOURNAL" | wc -l | tr -d ' ')"
[ "$image_migrations" -gt 0 ] || die "journal migrasi image kosong."
has_table="$(query "select to_regclass('drizzle.__drizzle_migrations') is not null")" \
  || die "versi skema tidak dapat dibaca."
db_migrations=0
if [ "$has_table" = "t" ]; then
  db_migrations="$(query "select count(*) from drizzle.__drizzle_migrations")" \
    || die "jumlah migrasi tercatat tidak dapat dibaca."
fi
case "$db_migrations" in
  '' | *[!0-9]*) die "jumlah migrasi tercatat tidak valid." ;;
esac
log "migrasi tercatat $db_migrations, journal image $image_migrations"
if [ "$db_migrations" -gt "$image_migrations" ]; then
  die "database memuat $((db_migrations - image_migrations)) migrasi yang tidak dikenal image ini (image lebih lama dari skema). Job rilis image lama tidak boleh dijalankan pada skema baru; rollback image mengikuti runbook rilis bagian 6 (PRD 5.5, 8.4)."
fi

# ------------------------------------------------------------------------------------- 3-4. role dan sandi role
log "3/9 roles.sql (role dan hak tingkat database)"
run_psql "$DB_DIR/roles.sql" || die "roles.sql gagal sebelum migrasi."

log "4/9 sandi role LOGIN dari environment"
# Variabel kosong diperlakukan tidak diisi agar \getenv tidak menetapkan sandi kosong.
for name in KAPDH_MIGRATOR_DB_PASSWORD KAPDH_APP_DB_PASSWORD KAPDH_WORKER_DB_PASSWORD KAPDH_BACKUP_DB_PASSWORD \
  KAPDH_MONITOR_DB_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then unset "$name"; fi
done
unset value
run_psql "$DB_DIR/role-passwords.sql" || die "role-passwords.sql gagal."

# ------------------------------------------------------------------------------------ 5. gerbang pra-migrasi
if [ "$RELEASE_GATE" = "enforce" ]; then
  log "5/9 gerbang go-live pra-migrasi (konfigurasi pengurus; skema belum diubah)"
  set +e
  DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$GATE_CLI" --preflight
  preflight_code=$?
  set -e
  case "$preflight_code" in
    0) log "pra-migrasi LULUS." ;;
    1) die "gerbang go-live pra-migrasi MENOLAK konfigurasi; skema tidak diubah dan API/worker yang berjalan tidak tersentuh. Perbaiki lalu ulangi job (PRD 9.2, 9.3)." 1 ;;
    *)
      log "PERINGATAN: pra-migrasi tidak dapat dijalankan (kode $preflight_code; mis. skema lama belum memuat kolom yang"
      log "PERINGATAN: dibaca gerbang image baru). Gerbang penuh setelah migrasi tetap menentukan."
      ;;
  esac
else
  log "5/9 gerbang pra-migrasi dilewati (mode laporan)"
fi

# ---------------------------------------------------------------------------------------------------- 6. migrasi
log "6/9 migrasi skema sebagai kapdh_migrator (advisory lock)"
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$APP_DIR/node_modules/@kapdh/database/dist/bin/migrate.js" \
  || die "migrasi gagal; skema tidak berubah bila transaksi migrasi dibatalkan. Periksa log di atas."

# ------------------------------------------------------------------------------------------------ 7. grant objek
log "7/9 roles.sql (grant objek skema app setelah migrasi)"
run_psql "$DB_DIR/roles.sql" || die "roles.sql gagal setelah migrasi."

# ---------------------------------------------------------------------------------------------- 8. seed referensi
log "8/9 seed referensi (idempoten, tanpa fixture)"
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$APP_DIR/node_modules/@kapdh/database/dist/bin/seed-reference.js" \
  || die "seed referensi gagal."

# ------------------------------------------------------------------------------------------------ 9. gerbang
log "9/9 gerbang go-live penuh (mode $RELEASE_GATE)"
set +e
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$GATE_CLI"
gate_code=$?
set -e
case "$gate_code" in
  0) log "gerbang LULUS." ;;
  1)
    if [ "$RELEASE_GATE" = "enforce" ]; then
      die "gerbang go-live MENOLAK setelah migrasi; image tidak boleh dipromosikan. Skema sudah naik: perbaiki maju, jangan rollback skema (PRD 8.4, 9.2, 9.3)." 1
    fi
    log "gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live."
    ;;
  *) die "gerbang go-live tidak dapat dijalankan (kode $gate_code)." 1 ;;
esac

log "selesai: skema, grant, seed referensi dan gerbang untuk $KAPDH_ENV."
