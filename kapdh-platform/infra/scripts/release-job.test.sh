#!/bin/sh
# Uji kering infra/scripts/release-job.sh tanpa database: psql, pg_isready dan node diganti shim yang mencatat
# pemanggilan, sehingga urutan langkah, mode gerbang (pra-migrasi dan penuh), penolakan image lebih lama dari skema,
# pengecualian gerbang production, kode keluar dan penanganan sandi kosong teruji. Dijalankan CI (ubuntu: /bin/sh =
# dash, sekaligus memeriksa sintaks POSIX) dan dapat dijalankan lokal:
#   sh infra/scripts/release-job.test.sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
job="$here/release-job.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

journal_dir="$work/app/node_modules/@kapdh/database/migrations/meta"
mkdir -p "$work/bin" "$work/app/node_modules/@kapdh/database/dist/bin" "$work/app/dist/cli" "$work/db" "$journal_dir"
: >"$work/db/roles.sql"
: >"$work/db/role-passwords.sql"
# Journal image tiruan: 3 migrasi (format drizzle-kit satu baris).
printf '{"version":"7","dialect":"postgresql","entries":[%s,%s,%s]}\n' \
  '{"idx":0,"version":"7","when":1,"tag":"0000_a","breakpoints":true}' \
  '{"idx":1,"version":"7","when":2,"tag":"0001_b","breakpoints":true}' \
  '{"idx":2,"version":"7","when":3,"tag":"0002_c","breakpoints":true}' >"$journal_dir/_journal.json"

# psql: berkas SQL dicatat; kueri cek skema menjawab dari SHIM_DB_MIGRATIONS (kosong = tabel bookkeeping belum ada).
cat >"$work/bin/psql" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    */roles.sql) echo "psql roles.sql" >>"$SHIM_LOG" ;;
    */role-passwords.sql)
      echo "psql role-passwords.sql migrator=${KAPDH_MIGRATOR_DB_PASSWORD+set} app=${KAPDH_APP_DB_PASSWORD+set} worker=${KAPDH_WORKER_DB_PASSWORD+set}" >>"$SHIM_LOG"
      ;;
    *to_regclass*)
      echo "psql cek-skema" >>"$SHIM_LOG"
      if [ -n "${SHIM_DB_MIGRATIONS:-}" ]; then echo t; else echo f; fi
      ;;
    *"count(*)"*) echo "${SHIM_DB_MIGRATIONS:-0}" ;;
  esac
done
exit 0
EOF

cat >"$work/bin/pg_isready" <<'EOF'
#!/bin/sh
echo "pg_isready" >>"$SHIM_LOG"
exit 0
EOF

cat >"$work/bin/node" <<'EOF'
#!/bin/sh
case "$1" in
  */migrate.js) echo "node migrate" >>"$SHIM_LOG"; exit "${SHIM_MIGRATE_CODE:-0}" ;;
  */seed-reference.js) echo "node seed-reference" >>"$SHIM_LOG"; exit 0 ;;
  */golive-check.js)
    if [ "${2:-}" = "--preflight" ]; then
      echo "node golive-check --preflight" >>"$SHIM_LOG"
      exit "${SHIM_PREFLIGHT_CODE:-0}"
    fi
    echo "node golive-check" >>"$SHIM_LOG"
    exit "${SHIM_GATE_CODE:-0}"
    ;;
esac
echo "node tidak dikenal: $1" >>"$SHIM_LOG"
exit 9
EOF
chmod +x "$work/bin/psql" "$work/bin/pg_isready" "$work/bin/node"

failures=0
ADMIN_URL="postgres://postgres:rahasia@db:5432/kapdh"
MIGRATOR_URL="postgres://kapdh_migrator:rahasia@db:5432/kapdh"

# run <nama> <kode yang diharapkan> <pola log yang diharapkan> [VAR=nilai ...]
run() {
  name="$1"
  expected="$2"
  pattern="$3"
  shift 3
  SHIM_LOG="$work/$name.log"
  : >"$SHIM_LOG"
  set +e
  env -i PATH="$work/bin:/usr/bin:/bin" SHIM_LOG="$SHIM_LOG" APP_DIR="$work/app" KAPDH_DB_SQL_DIR="$work/db" \
    RELEASE_DB_WAIT_SECONDS=5 "$@" sh "$job" >"$work/$name.out" 2>&1
  code=$?
  set -e
  calls="$(tr '\n' ';' <"$SHIM_LOG")"
  if [ "$code" -ne "$expected" ]; then
    echo "GAGAL $name: kode $code, diharapkan $expected"
    sed 's/^/    /' "$work/$name.out"
    failures=$((failures + 1))
  elif [ "$pattern" = "-" ] && [ -n "$calls" ]; then
    echo "GAGAL $name: konfigurasi salah tetapi langkah tetap berjalan: '$calls'"
    failures=$((failures + 1))
  elif [ "$pattern" != "-" ] && ! printf '%s\n' "$calls" | grep -q -- "$pattern"; then
    echo "GAGAL $name: urutan '$calls' tidak cocok '$pattern'"
    failures=$((failures + 1))
  elif grep -q "rahasia" "$work/$name.out"; then
    echo "GAGAL $name: sandi/URL tercetak di keluaran"
    failures=$((failures + 1))
  else
    echo "lulus $name"
  fi
}

# expect_output <nama skenario> <teks> : keluaran skenario memuat teks.
expect_output() {
  if grep -q -- "$2" "$work/$1.out"; then
    echo "lulus $1: keluaran memuat '$2'"
  else
    echo "GAGAL $1: keluaran tidak memuat '$2'"
    failures=$((failures + 1))
  fi
}

head="^pg_isready;psql cek-skema;psql roles.sql;psql role-passwords.sql[^;]*;"
tail="node migrate;psql roles.sql;node seed-reference;node golive-check;$"
enforce_full="${head}node golive-check --preflight;${tail}"
report_full="${head}${tail}"
OVERRIDE="RELEASE_GATE_REASON=inisialisasi pertama PRD 8.2"
APPROVER="RELEASE_GATE_APPROVER=Pemilik Produk"

run tanpa-env 2 - ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run migrator-superuser 2 - KAPDH_ENV=production ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$ADMIN_URL"
run mode-salah 2 - KAPDH_ENV=production RELEASE_GATE=skip ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-lulus 0 "$enforce_full" KAPDH_ENV=production ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-skema-sama 0 "$enforce_full" KAPDH_ENV=production SHIM_DB_MIGRATIONS=3 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
# Penolakan konfigurasi SEBELUM migrasi: tidak ada migrate/roles.sql kedua/seed.
run production-pra-migrasi-menolak 1 "${head}node golive-check --preflight;$" KAPDH_ENV=production \
  SHIM_PREFLIGHT_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
expect_output production-pra-migrasi-menolak "skema tidak diubah"
# Pra-migrasi gagal teknis (skema lama): tidak menahan; gerbang penuh menentukan.
run production-pra-migrasi-galat 0 "$enforce_full" KAPDH_ENV=production SHIM_PREFLIGHT_CODE=3 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-ditolak 1 "$enforce_full" KAPDH_ENV=production SHIM_GATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
expect_output production-ditolak "perbaiki maju"
# Image lebih lama dari skema: berhenti sebelum roles.sql pada semua mode/lingkungan.
run skema-lebih-baru-production 1 "^pg_isready;psql cek-skema;$" KAPDH_ENV=production SHIM_DB_MIGRATIONS=4 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
expect_output skema-lebih-baru-production "1 migrasi yang tidak dikenal image ini"
run skema-lebih-baru-staging 1 "^pg_isready;psql cek-skema;$" KAPDH_ENV=staging SHIM_DB_MIGRATIONS=5 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
# Pengecualian gerbang production wajib beralasan dan disetujui.
run production-laporan-tanpa-alasan 2 - KAPDH_ENV=production RELEASE_GATE=report SHIM_GATE_CODE=1 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-laporan-tanpa-penyetuju 2 - KAPDH_ENV=production RELEASE_GATE=report "$OVERRIDE" \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-inisialisasi 0 "$report_full" KAPDH_ENV=production RELEASE_GATE=report SHIM_GATE_CODE=1 \
  "$OVERRIDE" "$APPROVER" ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
expect_output production-inisialisasi "PENGECUALIAN GERBANG go-live di production"
expect_output production-inisialisasi "alasan: inisialisasi pertama PRD 8.2"
expect_output production-inisialisasi "disetujui: Pemilik Produk"
run staging-laporan 0 "$report_full" KAPDH_ENV=staging SHIM_GATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run staging-enforce 1 "$enforce_full" KAPDH_ENV=staging RELEASE_GATE=enforce SHIM_GATE_CODE=1 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run gerbang-galat-teknis 1 "$report_full" KAPDH_ENV=staging SHIM_GATE_CODE=3 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run migrasi-gagal 1 "${head}node golive-check --preflight;node migrate;$" KAPDH_ENV=production \
  SHIM_MIGRATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run sandi-kosong-tidak-diterapkan 0 "psql role-passwords.sql migrator=set app= worker=;" KAPDH_ENV=production \
  KAPDH_MIGRATOR_DB_PASSWORD=abc KAPDH_APP_DB_PASSWORD= ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"

if [ "$failures" -ne 0 ]; then
  echo "$failures skenario gagal."
  exit 1
fi
echo "Semua skenario job rilis lulus."
