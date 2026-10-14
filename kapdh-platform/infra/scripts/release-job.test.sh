#!/bin/sh
# Uji kering infra/scripts/release-job.sh tanpa database: psql, pg_isready dan node diganti shim yang mencatat
# pemanggilan, sehingga urutan langkah, mode gerbang, kode keluar dan penanganan sandi kosong teruji. Dijalankan CI
# (ubuntu: /bin/sh = dash, sekaligus memeriksa sintaks POSIX) dan dapat dijalankan lokal:
#   sh infra/scripts/release-job.test.sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
job="$here/release-job.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

mkdir -p "$work/bin" "$work/app/node_modules/@kapdh/database/dist/bin" "$work/app/dist/cli" "$work/db"
: >"$work/db/roles.sql"
: >"$work/db/role-passwords.sql"

cat >"$work/bin/psql" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    */roles.sql) echo "psql roles.sql" >>"$SHIM_LOG" ;;
    */role-passwords.sql)
      echo "psql role-passwords.sql migrator=${KAPDH_MIGRATOR_DB_PASSWORD+set} app=${KAPDH_APP_DB_PASSWORD+set} worker=${KAPDH_WORKER_DB_PASSWORD+set}" >>"$SHIM_LOG"
      ;;
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
  */golive-check.js) echo "node golive-check" >>"$SHIM_LOG"; exit "${SHIM_GATE_CODE:-0}" ;;
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

full="^pg_isready;psql roles.sql;psql role-passwords.sql[^;]*;node migrate;psql roles.sql;node seed-reference;node golive-check;$"

run tanpa-env 2 - ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run migrator-superuser 2 - KAPDH_ENV=production ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$ADMIN_URL"
run mode-salah 2 - KAPDH_ENV=production RELEASE_GATE=skip ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-lulus 0 "$full" KAPDH_ENV=production ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-ditolak 1 "$full" KAPDH_ENV=production SHIM_GATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run production-inisialisasi 0 "$full" KAPDH_ENV=production RELEASE_GATE=report SHIM_GATE_CODE=1 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run staging-laporan 0 "$full" KAPDH_ENV=staging SHIM_GATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run staging-enforce 1 "$full" KAPDH_ENV=staging RELEASE_GATE=enforce SHIM_GATE_CODE=1 \
  ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run gerbang-galat-teknis 1 "$full" KAPDH_ENV=staging SHIM_GATE_CODE=3 ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run migrasi-gagal 1 "^pg_isready;psql roles.sql;psql role-passwords.sql[^;]*;node migrate;$" KAPDH_ENV=production \
  SHIM_MIGRATE_CODE=1 ADMIN_DATABASE_URL="$ADMIN_URL" MIGRATOR_DATABASE_URL="$MIGRATOR_URL"
run sandi-kosong-tidak-diterapkan 0 "psql role-passwords.sql migrator=set app= worker=;" KAPDH_ENV=production \
  KAPDH_MIGRATOR_DB_PASSWORD=abc KAPDH_APP_DB_PASSWORD= ADMIN_DATABASE_URL="$ADMIN_URL" \
  MIGRATOR_DATABASE_URL="$MIGRATOR_URL"

if grep -q "PERINGATAN: gerbang go-live mode laporan di production" "$work/production-inisialisasi.out"; then
  echo "lulus peringatan-mode-laporan-production"
else
  echo "GAGAL peringatan-mode-laporan-production: peringatan tidak tercetak"
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures skenario gagal."
  exit 1
fi
echo "Semua skenario job rilis lulus."
