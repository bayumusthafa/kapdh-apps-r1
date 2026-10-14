#!/bin/sh
# Uji kering skrip backup/restore KAPDH dengan alat tiruan (psql, pg_dump, pg_restore, restic, rclone di
# infra/backup/test/stubs). Membuktikan alur skrip: urutan langkah, snapshot DB bersama pg_dump + statistik, manifest
# JSON valid, retensi, penolakan kondisi berbahaya, ledger luar VPS diteruskan ke CLI ledger-reapply, verifikasi.
# TIDAK membuktikan perilaku PostgreSQL/restic/rclone sungguhan: itu wajib dibuktikan restore drill di staging
# (docs/runbooks/backup-restore.md). SQL diuji pada PGlite: apps/api/test/ops/backup-sql.test.ts.
#
#   sh infra/backup/test/dry-run.sh [folder-kerja]
#
# Prasyarat: sh POSIX, node >= 20, coreutils (sha256sum, date -d), find, sed, grep. Keluar 0 bila semua skenario lulus.
set -eu

TEST_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BACKUP_DIR=$(dirname "$TEST_DIR")
ROOT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/kapdh-dry-run.XXXXXX")}
mkdir -p "$ROOT"
# Git Bash: jangan ubah argumen bergaya path (id:/path) saat memanggil node.
MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL

PASSED=0
FAILED=0
pass() {
  PASSED=$((PASSED + 1))
  printf 'LULUS  %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'GAGAL  %s\n' "$1"
}
expect() {
  # expect <deskripsi> <perintah...>
  _desc=$1
  shift
  if "$@"; then pass "$_desc"; else fail "$_desc"; fi
}
native() {
  # Path untuk node: Git Bash (MSYS) -> C:/..., selain itu apa adanya.
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
json_get() {
  # json_get <berkas> <ekspresi JS atas objek j>
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(String(v));' "$(native "$1")" "$2"
}

# ------------------------------------------------------------------------------------------------- fixture
FIXTURE=$ROOT/fixture
rm -rf "$FIXTURE"
mkdir -p "$FIXTURE"
FILES_SRC=$FIXTURE/files
mkdir -p "$FILES_SRC/avatar/2026/10" "$FILES_SRC/payment_proof/2026/10" "$FILES_SRC/.tmp" \
  "$FILES_SRC/ledger/account-deletions/2026/10"
printf 'avatar-a' >"$FILES_SRC/avatar/2026/10/0192f0d2-7c1e-7d5a-9a51-000000000001"
printf 'bukti-b' >"$FILES_SRC/payment_proof/2026/10/0192f0d2-7c1e-7d5a-9a51-000000000002"
printf 'setengah' >"$FILES_SRC/.tmp/0192f0d2.part"
cat >"$FILES_SRC/ledger/account-deletions/2026/10/del-2026-aaaa1111.json" <<'EOF'
{
  "v": 1,
  "kind": "kapdh.account_deletion",
  "deletion_id": "0192f0d2-7c1e-7d5a-9a51-00000000a001",
  "request_number": "DEL-2026-AAAA1111",
  "user_id": "0192f0d2-7c1e-7d5a-9a51-00000000b001",
  "source": "app",
  "requested_at": "2026-10-01T02:00:00.000Z",
  "state": "completed",
  "completed_at": "2026-10-01T03:00:00.000Z",
  "object_keys": [
    "avatar/2026/10/0192f0d2-7c1e-7d5a-9a51-00000000c001"
  ],
  "written_at": "2026-10-01T03:00:00.000Z"
}
EOF
BUCKET=$FIXTURE/rclone/kapdh-prod-deletion-ledger
mkdir -p "$BUCKET/account-deletions/2026/10/del-2026-bbbb2222" "$BUCKET/lain"
cat >"$BUCKET/account-deletions/2026/10/del-2026-bbbb2222/requested-0192f0d2-7c1e-7d5a-9a51-00000000d001.json" <<'EOF'
{"v":1,"kind":"kapdh.account_deletion","deletion_id":"0192f0d2-7c1e-7d5a-9a51-00000000a002","request_number":"DEL-2026-BBBB2222","user_id":"0192f0d2-7c1e-7d5a-9a51-00000000b002","source":"web","requested_at":"2026-10-14T01:00:00.000Z","state":"requested","completed_at":null,"object_keys":[],"written_at":"2026-10-14T01:00:00.000Z"}
EOF
cat >"$BUCKET/account-deletions/2026/10/del-2026-bbbb2222/completed-0192f0d2-7c1e-7d5a-9a51-00000000d002.json" <<'EOF'
{
  "v": 1,
  "kind": "kapdh.account_deletion",
  "deletion_id": "0192f0d2-7c1e-7d5a-9a51-00000000a002",
  "request_number": "DEL-2026-BBBB2222",
  "user_id": "0192f0d2-7c1e-7d5a-9a51-00000000b002",
  "source": "web",
  "requested_at": "2026-10-14T01:00:00.000Z",
  "state": "completed",
  "completed_at": "2026-10-14T01:10:00.000Z",
  "object_keys": [
    "avatar/2026/10/0192f0d2-7c1e-7d5a-9a51-00000000c002",
    "payment_proof/2026/10/0192f0d2-7c1e-7d5a-9a51-00000000c003"
  ],
  "written_at": "2026-10-14T01:10:00.000Z"
}
EOF
printf 'bukan ledger' >"$BUCKET/lain/x.json"
# Bentuk keluaran json_build_object PostgreSQL (spasi di sekitar titik dua).
cat >"$FIXTURE/stats.json" <<'EOF'
{"captured_at" : "2026-10-14T19:00:00Z", "schema" : {"applied" : 8, "last_created_at" : 1791858084534}, "invariant" : {"users" : 120, "admins_active" : 4, "super_admins_active" : 2, "payments" : 300, "payments_paid" : 250, "paid_total" : "15000000.00", "paid_registration" : "6000000.00", "paid_renewal" : "1000000.00", "paid_ticket" : "8000000.00", "adjustments" : 3, "adjustments_completed_total" : "100000.00", "tickets" : 90, "events" : 5, "rooms" : 40}, "info" : {"users_active" : 110, "users_deleted" : 2, "alumni" : 105, "tickets_paid" : 80, "messages" : 5000, "membership_events" : 260, "payment_events" : 700, "payments_pending" : 20, "files_ready" : 2, "files_ready_local" : 2, "audit_logs" : 4000, "outbox_pending" : 3, "outbox_dead" : 0, "account_deletions_open" : 0, "account_deletions_completed" : 2}, "latest" : {"payment_created_at" : "2026-10-14T18:59:00+00:00", "message_created_at" : "2026-10-14T18:59:30+00:00", "audit_created_at" : null}}
EOF
# Waktu snapshot = sekarang (umur backup saat restore tidak negatif).
CAPTURED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sed "s/2026-10-14T19:00:00Z/$CAPTURED/" "$FIXTURE/stats.json" >"$FIXTURE/stats.tmp" && mv "$FIXTURE/stats.tmp" "$FIXTURE/stats.json"
sed 's/"paid_total" : "15000000.00"/"paid_total" : "14990000.00"/' "$FIXTURE/stats.json" >"$FIXTURE/stats-bad.json"
printf 'kata-sandi-restic-uji\n' >"$FIXTURE/restic-password"
chmod 600 "$FIXTURE/restic-password"

# CLI ledger-reapply tiruan: mencatat argumen dan memastikan setiap --dir ada dan berisi entri.
cat >"$FIXTURE/fake-ledger-reapply.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$@" >"$FAKE_STATE_DIR/ledger-reapply.args"
[ "${FAKE_LEDGER_REAPPLY_FAIL:-0}" = 1 ] && { echo "Gagal                : 1 DEL-2026-BBBB2222"; exit 1; }
while [ $# -gt 0 ]; do
  [ "$1" = --dir ] || { echo "argumen tidak dikenal $1" >&2; exit 2; }
  [ -d "$2" ] || { echo "folder ledger $2 tidak ada" >&2; exit 2; }
  shift 2
done
echo "Entri ledger         : 2"
echo "Gagal                : 0"
EOF
chmod +x "$FIXTURE/fake-ledger-reapply.sh"
chmod +x "$TEST_DIR/stubs/"* "$BACKUP_DIR/backup.sh" "$BACKUP_DIR/restore.sh" "$BACKUP_DIR/verify-restore.sh"

# ------------------------------------------------------------------------------------------------- env bersama
PATH=$TEST_DIR/stubs:$PATH
FAKE_TOOLS=$TEST_DIR/fake-tools.mjs
FAKE_STATE_DIR=$ROOT/state
FAKE_RCLONE_ROOT=$FIXTURE/rclone
FAKE_STATS=$FIXTURE/stats.json
FAKE_RESTORED_STATS=$FIXTURE/stats.json
RESTIC_REPOSITORY=$ROOT/repo
RESTIC_PASSWORD_FILE=$FIXTURE/restic-password
KAPDH_BACKUP_ENV=$ROOT/tidak-ada.env
KAPDH_BACKUP_SECRETS=$ROOT/tidak-ada.secrets.env
KAPDH_ENV=production
LEDGER_RCLONE_REMOTE=kapdhledger:kapdh-prod-deletion-ledger
IMAGE_API=ghcr.io/kapdh/api:v1.0.0@sha256:0123abcd
# Batas tunggu pendek agar bug sesi snapshot terlihat cepat (produksi: 120/600 detik).
SNAPSHOT_TIMEOUT_S=20
STATS_TIMEOUT_S=30
export PATH FAKE_TOOLS FAKE_STATE_DIR FAKE_RCLONE_ROOT FAKE_STATS FAKE_RESTORED_STATS RESTIC_REPOSITORY \
  RESTIC_PASSWORD_FILE KAPDH_BACKUP_ENV KAPDH_BACKUP_SECRETS KAPDH_ENV LEDGER_RCLONE_REMOTE IMAGE_API \
  SNAPSHOT_TIMEOUT_S STATS_TIMEOUT_S
rm -rf "$RESTIC_REPOSITORY" "$FAKE_STATE_DIR"

db_snapshot_manifest() {
  # Manifest dari snapshot kapdh-db terbaru di repositori tiruan.
  _id=$(node -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];const s=fs.readdirSync(p.join(d,"snapshots")).map(f=>JSON.parse(fs.readFileSync(p.join(d,"snapshots",f),"utf8"))).filter(x=>x.tags.includes("kapdh-db")).sort((a,b)=>a.time.localeCompare(b.time));process.stdout.write(s.length?s[s.length-1].id:"")' "$(native "$RESTIC_REPOSITORY")")
  [ -n "$_id" ] && printf '%s/data/%s/manifest.json' "$RESTIC_REPOSITORY" "$_id"
}
count_db_snapshots() {
  node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.argv[1],"snapshots");process.stdout.write(String(fs.existsSync(d)?fs.readdirSync(d).map(f=>JSON.parse(fs.readFileSync(p.join(d,f),"utf8"))).filter(x=>x.tags.includes("kapdh-db")).length:0))' "$(native "$RESTIC_REPOSITORY")"
}

# ======================================================================================== 1. backup berhasil
WORK_DIR=$ROOT/backup-work
FILES_ROOT=$FILES_SRC
export WORK_DIR FILES_ROOT
if "$BACKUP_DIR/backup.sh" >"$ROOT/backup-1.log" 2>&1; then pass "backup.sh production keluar 0"; else
  fail "backup.sh production keluar 0 (lihat $ROOT/backup-1.log)"
  cat "$ROOT/backup-1.log"
fi
MANIFEST=$(db_snapshot_manifest || true)
expect "manifest ada di snapshot kapdh-db" test -f "$MANIFEST"
if [ -f "$MANIFEST" ]; then
  expect "manifest JSON valid dan berjenis kapdh.backup_manifest" \
    test "$(json_get "$MANIFEST" 'j.kind+"/"+j.version')" = "kapdh.backup_manifest/1"
  DUMP=$(dirname "$MANIFEST")/db.dump
  expect "sha256 dump di manifest cocok dengan dump di repositori" \
    test "$(json_get "$MANIFEST" 'j.database.db_dump_sha256')" = "$(sha256sum "$DUMP" | cut -d ' ' -f 1)"
  expect "statistik DB di manifest berasal dari snapshot (captured_at, total uang)" \
    test "$(json_get "$MANIFEST" 'j.database.db_snapshot_captured_at+"|"+j.database.stats.invariant.paid_total')" = \
    "$CAPTURED|15000000.00"
  FSNAP=$(json_get "$MANIFEST" 'j.files.files_snapshot_id')
  expect "snapshot berkas di manifest ada di repositori" test -f "$RESTIC_REPOSITORY/snapshots/$FSNAP.json"
  expect "berkas sementara .tmp dikecualikan; 3 berkas (2 objek + 1 ledger lokal)" \
    test "$(json_get "$MANIFEST" 'j.files.files_total+"/"+j.files.files_local_ledger_entries')" = "3/1"
  expect "manifest memuat 2 objek ledger luar VPS dengan sha256 (hanya account-deletions/**)" \
    test "$(json_get "$MANIFEST" 'j.deletion_ledger.objects.length+"/"+j.deletion_ledger.objects.every(o=>/^account-deletions\//.test(o.key)&&/^[0-9a-f]{64}$/.test(o.sha256))')" = "2/true"
  expect "manifest memuat versi alat dan image" \
    test "$(json_get "$MANIFEST" 'j.tools.restic+"|"+j.tools.rclone+"|"+j.tools.pg_dump+"|"+j.images.api+"|"+j.images.worker')" = \
    "0.18.0|v1.69.1|17.6|ghcr.io/kapdh/api:v1.0.0@sha256:0123abcd|null"
fi
expect "pg_dump dipanggil dengan --snapshot (snapshot bersama statistik)" grep -q '^pg_dump .*--snapshot=' "$FAKE_STATE_DIR/calls.log"
expect "retensi restic forget --keep-within 30d --prune per (host,paths)" \
  grep -q '^restic forget --host kapdh-production --tag kapdh --group-by host,paths --keep-within 30d --prune' "$FAKE_STATE_DIR/calls.log"
expect "stage berisi dump (data pribadi) dihapus setelah unggah" test ! -e "$WORK_DIR/stage"
expect "lock dilepas" test ! -e "$WORK_DIR/.backup.lock"
expect "status keberhasilan terakhir ditulis" grep -q '^db_snapshot=' "$WORK_DIR/status/last-success"

# ======================================================================================== 2. backup gagal
BEFORE=$(count_db_snapshots)
if FAKE_PG_DUMP_FAIL=1 "$BACKUP_DIR/backup.sh" >"$ROOT/backup-2.log" 2>&1; then fail "pg_dump gagal -> backup.sh keluar bukan nol"; else pass "pg_dump gagal -> backup.sh keluar bukan nol"; fi
expect "pg_dump gagal -> tidak ada snapshot kapdh-db baru" test "$(count_db_snapshots)" = "$BEFORE"
expect "pg_dump gagal -> stage dihapus dan lock dilepas" test ! -e "$WORK_DIR/stage" -a ! -e "$WORK_DIR/.backup.lock"
if LEDGER_RCLONE_REMOTE='' "$BACKUP_DIR/backup.sh" >"$ROOT/backup-3.log" 2>&1; then fail "production tanpa LEDGER_RCLONE_REMOTE ditolak"; else
  expect "production tanpa LEDGER_RCLONE_REMOTE ditolak (AC F14-6)" grep -q 'LEDGER_RCLONE_REMOTE wajib' "$ROOT/backup-3.log"
fi
if RETENTION_DAYS=45 "$BACKUP_DIR/backup.sh" >"$ROOT/backup-4.log" 2>&1; then fail "retensi > 30 hari ditolak (D2)"; else
  expect "retensi > 30 hari ditolak (D2)" grep -q 'RETENTION_DAYS maksimal 30' "$ROOT/backup-4.log"
fi

# ======================================================================================== 3. restore berhasil
restore_env() {
  WORK_DIR=$ROOT/restore-work-$1
  FILES_ROOT=$ROOT/restore-files-$1
  FAKE_FILES_ROOT=$FILES_ROOT
  FAKE_STATE_DIR=$ROOT/state-restore-$1
  LEDGER_REAPPLY_CMD=$FIXTURE/fake-ledger-reapply.sh
  export WORK_DIR FILES_ROOT FAKE_FILES_ROOT FAKE_STATE_DIR LEDGER_REAPPLY_CMD
  rm -rf "$WORK_DIR" "$FILES_ROOT" "$FAKE_STATE_DIR"
}
restore_env ok
EVID=$ROOT/evidence-ok
if "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$EVID" >"$ROOT/restore-ok.log" 2>&1; then
  pass "restore.sh drill keluar 0"
else
  fail "restore.sh drill keluar 0 (lihat $ROOT/restore-ok.log)"
  cat "$ROOT/restore-ok.log"
fi
expect "roles.sql dijalankan sebelum dan sesudah pg_restore" test "$(wc -l <"$FAKE_STATE_DIR/roles-applied" | tr -d ' ')" -ge 2
expect "berkas pulihan sesuai snapshot (objek + ledger lokal, tanpa .tmp)" \
  test -f "$FILES_ROOT/avatar/2026/10/0192f0d2-7c1e-7d5a-9a51-000000000001" -a ! -e "$FILES_ROOT/.tmp"
expect "CLI ledger-reapply menerima 3 folder (bucket terbaru, salinan backup, ledger berkas)" \
  test "$(grep -c '^--dir$' "$FAKE_STATE_DIR/ledger-reapply.args")" = 3
expect "ledger bucket terbaru diteruskan (offsite-now)" grep -q 'offsite-now$' "$FAKE_STATE_DIR/ledger-reapply.args"
expect "verifikasi memeriksa 2 akun ledger unik (bucket terbaru + ledger berkas)" \
  test "$(grep -c . "$FAKE_STATE_DIR/ledger-user-ids")" -eq 2
expect "lease outbox dilepas sebelum verifikasi" test -f "$FAKE_STATE_DIR/outbox-released"
expect "laporan verifikasi ada dan tanpa FAIL" sh -c "test -s '$EVID/verify-report.txt' && ! grep -q '^FAIL' '$EVID/verify-report.txt'"
expect "laporan memeriksa total uang (paid_total)" grep -q '^PASS paid_total' "$EVID/verify-report.txt"
expect "ringkasan bukti memuat durasi restore dan umur backup" \
  sh -c "grep -q '^restore_seconds=' '$EVID/summary.txt' && grep -q '^backup_age_at_start_seconds=[0-9]' '$EVID/summary.txt'"
expect "folder sementara restore (dump) dihapus" sh -c "! find '$WORK_DIR/tmp' -name db.dump 2>/dev/null | grep -q ."

# ======================================================================================== 4. restore ditolak/gagal
restore_env dirty
mkdir -p "$FILES_ROOT" && printf x >"$FILES_ROOT/sisa"
if "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-dirty" >"$ROOT/restore-dirty.log" 2>&1; then
  fail "FILES_ROOT tidak kosong ditolak"
else
  expect "FILES_ROOT tidak kosong ditolak" grep -q 'tidak kosong' "$ROOT/restore-dirty.log"
fi
restore_env staging
if "$BACKUP_DIR/restore.sh" --target-kind staging --yes >"$ROOT/restore-staging.log" 2>&1; then fail "target staging ditolak (PRD 5.3)"; else
  expect "target staging ditolak (PRD 5.3)" grep -q 'staging tidak boleh' "$ROOT/restore-staging.log"
fi
restore_env reapply
if FAKE_LEDGER_REAPPLY_FAIL=1 "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-reapply" >"$ROOT/restore-reapply.log" 2>&1; then
  fail "ledger-reapply gagal -> restore gagal"
else
  expect "ledger-reapply gagal -> restore gagal, layanan tidak dibuka" grep -q 'JANGAN buka layanan' "$ROOT/restore-reapply.log"
fi
restore_env ledger
if FAKE_LEDGER_NOT_DELETED=1 "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-ledger" >"$ROOT/restore-ledger.log" 2>&1; then
  fail "akun ledger belum deleted -> verifikasi gagal"
else
  expect "akun ledger belum deleted -> verifikasi FAIL (AC F14-6)" grep -q '^FAIL ledger.akun_terhapus' "$ROOT/evidence-ledger/verify-report.txt"
fi
restore_env money
if FAKE_RESTORED_STATS=$FIXTURE/stats-bad.json "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-money" >"$ROOT/restore-money.log" 2>&1; then
  fail "total uang berbeda -> verifikasi gagal"
else
  expect "total uang berbeda -> verifikasi FAIL paid_total" grep -q '^FAIL paid_total' "$ROOT/evidence-money/verify-report.txt"
fi
restore_env missing
if RESTIC_HOST=kapdh-tidak-ada "$BACKUP_DIR/restore.sh" --target-kind drill --yes >"$ROOT/restore-missing.log" 2>&1; then fail "snapshot tidak ditemukan ditolak"; else
  expect "snapshot tidak ditemukan ditolak" grep -q 'ditemukan 0 snapshot' "$ROOT/restore-missing.log"
fi
restore_env tamper
if [ -n "${MANIFEST:-}" ] && [ -f "$MANIFEST" ]; then
  printf 'rusak' >>"$(dirname "$MANIFEST")/db.dump"
  if "$BACKUP_DIR/restore.sh" --target-kind drill --yes >"$ROOT/restore-tamper.log" 2>&1; then fail "dump rusak ditolak (sha256)"; else
    expect "dump rusak ditolak (sha256 tidak cocok dengan manifest)" grep -q 'sha256 dump tidak cocok' "$ROOT/restore-tamper.log"
  fi
fi

printf '\n%s lulus, %s gagal (folder: %s)\n' "$PASSED" "$FAILED" "$ROOT"
[ "$FAILED" -eq 0 ]
