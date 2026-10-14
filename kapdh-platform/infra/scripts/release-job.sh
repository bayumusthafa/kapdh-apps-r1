#!/bin/sh
# Job rilis KAPDH: SATU job deployment per rilis, bukan setiap startup replica API/worker (PRD 5.5, 8.2 langkah 2-4,
# 9.2, 9.3; ARCHITECTURE §10). Entry image `kapdh-release` (infra/Dockerfile.api target `release`). Urutan:
#
#   1. tunggu PostgreSQL siap (pg_isready)
#   2. infra/db/roles.sql           role + hak tingkat database (superuser/pemilik database)
#   3. infra/db/role-passwords.sql  sandi role LOGIN dari env (hanya variabel yang terisi)
#   4. migrasi skema                sebagai kapdh_migrator, pg_advisory_lock 4711000517, semua migrasi tertunda 1 transaksi
#   5. infra/db/roles.sql           grant objek skema app (append-only, mfa_totp, sequence) diterapkan ulang
#   6. seed referensi               idempoten; hanya baris yang belum ada (nilai pengurus tidak ditimpa)
#   7. gerbang go-live              golive:check; mode enforce menggagalkan job bila konfigurasi belum disahkan
#
# Environment:
#   KAPDH_ENV                    wajib: production | staging (D12: lingkungan terpisah)
#   ADMIN_DATABASE_URL           wajib: superuser/pemilik database (langkah 2, 3, 5)
#   MIGRATOR_DATABASE_URL        wajib: login kapdh_migrator (langkah 4, 6, 7)
#   KAPDH_MIGRATOR_DB_PASSWORD   opsional: sandi role (langkah 3); kosong = tidak diubah
#   KAPDH_APP_DB_PASSWORD        opsional: idem untuk kapdh_app
#   KAPDH_WORKER_DB_PASSWORD     opsional: idem untuk kapdh_worker
#   RELEASE_GATE                 enforce | report. Bawaan: enforce untuk production, report untuk staging. `report`
#                                di production HANYA untuk inisialisasi pertama sebelum bootstrap Super Admin dan
#                                konfigurasi pengurus (docs/runbooks/rilis-dan-gerbang-go-live.md).
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
export PGAPPNAME="kapdh-release"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

log() {
  printf '[rilis] %s\n' "$*"
}

die() {
  printf '[rilis] GAGAL: %s\n' "$*" >&2
  exit "${2:-1}"
}

# ------------------------------------------------------------------------------------------- validasi konfigurasi
KAPDH_ENV="${KAPDH_ENV:-}"
case "$KAPDH_ENV" in
  production | staging) ;;
  *)
    printf '[rilis] GAGAL: KAPDH_ENV wajib production atau staging.\n' >&2
    exit 2
    ;;
esac

[ -n "${ADMIN_DATABASE_URL:-}" ] || { printf '[rilis] GAGAL: ADMIN_DATABASE_URL wajib diisi.\n' >&2; exit 2; }
[ -n "${MIGRATOR_DATABASE_URL:-}" ] || { printf '[rilis] GAGAL: MIGRATOR_DATABASE_URL wajib diisi.\n' >&2; exit 2; }

# Objek skema wajib dimiliki kapdh_migrator (roles.sql: default privileges, kaskade FK sebagai pemilik tabel).
migrator_user="$(printf '%s' "$MIGRATOR_DATABASE_URL" | sed -n 's#^postgres\(ql\)\{0,1\}://\([^:@/]*\)[:@].*#\2#p')"
if [ "$migrator_user" != "kapdh_migrator" ]; then
  printf '[rilis] GAGAL: MIGRATOR_DATABASE_URL harus login sebagai kapdh_migrator (ditemukan: %s).\n' \
    "${migrator_user:-tidak terbaca}" >&2
  exit 2
fi

if [ -z "${RELEASE_GATE:-}" ]; then
  if [ "$KAPDH_ENV" = "production" ]; then RELEASE_GATE="enforce"; else RELEASE_GATE="report"; fi
fi
case "$RELEASE_GATE" in
  enforce | report) ;;
  *)
    printf '[rilis] GAGAL: RELEASE_GATE wajib enforce atau report.\n' >&2
    exit 2
    ;;
esac

wait_seconds="${RELEASE_DB_WAIT_SECONDS:-60}"
case "$wait_seconds" in
  '' | *[!0-9]*)
    printf '[rilis] GAGAL: RELEASE_DB_WAIT_SECONDS harus bilangan bulat.\n' >&2
    exit 2
    ;;
esac

log "lingkungan $KAPDH_ENV, mode gerbang $RELEASE_GATE"
if [ "$KAPDH_ENV" = "production" ] && [ "$RELEASE_GATE" = "report" ]; then
  log "PERINGATAN: gerbang go-live mode laporan di production. Hanya sah untuk inisialisasi pertama (PRD 8.2);"
  log "PERINGATAN: go-live dan rilis berikutnya wajib mode enforce (PRD 9.2, 9.3)."
fi

# ----------------------------------------------------------------------------------------------- 1. database siap
log "1/7 menunggu PostgreSQL (maks. ${wait_seconds} detik)"
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

# ------------------------------------------------------------------------------------- 2-3. role dan sandi role
log "2/7 roles.sql (role dan hak tingkat database)"
run_psql "$DB_DIR/roles.sql" || die "roles.sql gagal sebelum migrasi."

log "3/7 sandi role LOGIN dari environment"
# Variabel kosong diperlakukan tidak diisi agar \getenv tidak menetapkan sandi kosong.
for name in KAPDH_MIGRATOR_DB_PASSWORD KAPDH_APP_DB_PASSWORD KAPDH_WORKER_DB_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then unset "$name"; fi
done
unset value
run_psql "$DB_DIR/role-passwords.sql" || die "role-passwords.sql gagal."

# ---------------------------------------------------------------------------------------------------- 4. migrasi
log "4/7 migrasi skema sebagai kapdh_migrator (advisory lock)"
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$APP_DIR/node_modules/@kapdh/database/dist/bin/migrate.js" \
  || die "migrasi gagal; skema tidak berubah bila transaksi migrasi dibatalkan. Periksa log di atas."

# ------------------------------------------------------------------------------------------------ 5. grant objek
log "5/7 roles.sql (grant objek skema app setelah migrasi)"
run_psql "$DB_DIR/roles.sql" || die "roles.sql gagal setelah migrasi."

# ---------------------------------------------------------------------------------------------- 6. seed referensi
log "6/7 seed referensi (idempoten, tanpa fixture)"
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$APP_DIR/node_modules/@kapdh/database/dist/bin/seed-reference.js" \
  || die "seed referensi gagal."

# ------------------------------------------------------------------------------------------------ 7. gerbang
log "7/7 gerbang go-live (mode $RELEASE_GATE)"
set +e
DATABASE_URL="$MIGRATOR_DATABASE_URL" "$NODE_BIN" "$APP_DIR/dist/cli/golive-check.js"
gate_code=$?
set -e
case "$gate_code" in
  0) log "gerbang LULUS." ;;
  1)
    if [ "$RELEASE_GATE" = "enforce" ]; then
      die "gerbang go-live MENOLAK konfigurasi; image tidak boleh dipromosikan (PRD 9.2, 9.3)." 1
    fi
    log "gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live."
    ;;
  *) die "gerbang go-live tidak dapat dijalankan (kode $gate_code)." 1 ;;
esac

log "selesai: skema, grant, seed referensi dan gerbang untuk $KAPDH_ENV."
