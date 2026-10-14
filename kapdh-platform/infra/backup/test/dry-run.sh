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
# Git Bash: path /tmp/... milik MSYS tidak dikenal Node (alat tiruan) -> pakai bentuk C:/... untuk semua path kerja.
if command -v cygpath >/dev/null 2>&1; then ROOT=$(cygpath -m "$ROOT"); fi
# Izin berkas POSIX (chmod 600) tidak berlaku di Git Bash/NTFS; skenario yang memeriksanya hanya di Linux/macOS.
POSIX_PERMS=1
case $(uname -s 2>/dev/null || echo unknown) in MINGW* | MSYS* | CYGWIN*) POSIX_PERMS=0 ;; esac
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
# Sandi role LOGIN di host restore (ROLE_PASSWORDS_SQL, 0600): tidak boleh muncul di log/bukti restore.
ROLE_SECRET=sandi-role-uji-JANGAN-TERCATAT
printf "ALTER ROLE kapdh_app PASSWORD '%s';\nALTER ROLE kapdh_worker PASSWORD '%s';\n" "$ROLE_SECRET" "$ROLE_SECRET" \
  >"$FIXTURE/role-passwords.sql"
chmod 600 "$FIXTURE/role-passwords.sql"
cp "$FIXTURE/role-passwords.sql" "$FIXTURE/role-passwords-terbuka.sql"
chmod 644 "$FIXTURE/role-passwords-terbuka.sql"

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
# Worker dibaca dari kontainer lewat filter label (docker tiruan di stubs): tag + digest registri.
CONTAINER_WORKER=label=com.docker.compose.service=worker
# Batas tunggu pendek agar bug sesi snapshot terlihat cepat (produksi: 120/600 detik).
SNAPSHOT_TIMEOUT_S=20
STATS_TIMEOUT_S=30
export PATH FAKE_TOOLS FAKE_STATE_DIR FAKE_RCLONE_ROOT FAKE_STATS FAKE_RESTORED_STATS RESTIC_REPOSITORY \
  RESTIC_PASSWORD_FILE KAPDH_BACKUP_ENV KAPDH_BACKUP_SECRETS KAPDH_ENV LEDGER_RCLONE_REMOTE IMAGE_API \
  CONTAINER_WORKER SNAPSHOT_TIMEOUT_S STATS_TIMEOUT_S
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
  expect "manifest memuat versi alat dan image (IMAGE_API; worker dari kontainer berlabel sebagai tag@digest)" \
    test "$(json_get "$MANIFEST" 'j.tools.restic+"|"+j.tools.rclone+"|"+j.tools.pg_dump+"|"+j.images.api+"|"+j.images.worker+"|"+j.images.web')" = \
    "0.18.0|v1.69.1|17.6|ghcr.io/kapdh/api:v1.0.0@sha256:0123abcd|ghcr.io/kapdh/worker:v1.0.0@sha256:feedbeef|null"
fi
expect "pg_dump dipanggil dengan --snapshot (snapshot bersama statistik)" grep -q '^pg_dump .*--snapshot=' "$FAKE_STATE_DIR/calls.log"
expect "retensi dump: restic forget --tag kapdh-db --keep-within 30d per (host,paths)" \
  grep -q '^restic forget --host kapdh-production --tag kapdh-db --group-by host,paths --keep-within 30d$' "$FAKE_STATE_DIR/calls.log"
expect "prune terpisah dengan --max-unused 0 (D2: pack campuran ikut dikemas ulang)" \
  grep -q '^restic prune --max-unused 0$' "$FAKE_STATE_DIR/calls.log"
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
if BUCKET_NONCURRENT_DAYS=7 "$BACKUP_DIR/backup.sh" >"$ROOT/backup-5.log" 2>&1; then
  fail "retensi 30 + versi lama bucket 7 hari ditolak (D2)"
else
  expect "retensi 30 + versi lama bucket 7 hari ditolak (D2)" \
    grep -q 'RETENTION_DAYS + BUCKET_NONCURRENT_DAYS maksimal 30' "$ROOT/backup-5.log"
fi
if RESTIC_PRUNE=0 "$BACKUP_DIR/backup.sh" >"$ROOT/backup-6.log" 2>&1; then fail "production tanpa prune ditolak (D2)"; else
  expect "production tanpa prune ditolak (D2)" grep -q 'RESTIC_PRUNE=1 wajib di production' "$ROOT/backup-6.log"
fi

# ======================================================================================== 2b. retensi berpasangan
# Repo tiruan diberi: pasangan dump+berkas berumur 40 hari (backup_id X), snapshot berkas dari run gagal 1 hari lalu
# tanpa dump (Y), dan snapshot berkas tanpa tag backup_id. Sesudah backup berikutnya: dump X dilupakan kebijakan
# keep-within, berkas X dan Y dilupakan berpasangan, snapshot tanpa tag dibiarkan (peringatan), backup run 1 tetap ada.
inject_snapshots() {
  node -e '
const fs=require("fs"),p=require("path"),c=require("crypto");
const dir=p.join(process.argv[1],"snapshots");
const all=fs.readdirSync(dir).map(f=>JSON.parse(fs.readFileSync(p.join(dir,f),"utf8"))).sort((a,b)=>a.time.localeCompare(b.time));
const db=all.filter(s=>s.tags.includes("kapdh-db")).pop(), files=all.filter(s=>s.tags.includes("kapdh-files")).pop();
const bid=(d)=>"kapdh-production-"+d.toISOString().replace(/[-:]/g,"").replace(/\.\d+Z$/,"Z");
const add=(base,ageDays,tag,role)=>{const id=c.randomBytes(32).toString("hex");const t=new Date(Date.now()-ageDays*86400000);
  const s={...base,time:t.toISOString(),tags:["kapdh",role,"env-production",...(tag?[tag]:[])],id,short_id:id.slice(0,8)};
  fs.writeFileSync(p.join(dir,id+".json"),JSON.stringify(s));return id;};
const x=bid(new Date(Date.now()-40*86400000)), y=bid(new Date(Date.now()-86400000));
const out={dbX:add(db,40,x,"kapdh-db"),filesX:add(files,40.01,x,"kapdh-files"),filesY:add(files,1,y,"kapdh-files"),filesNoTag:add(files,2,null,"kapdh-files"),db1:db.id,files1:files.id};
process.stdout.write(Object.entries(out).map(([k,v])=>k+"="+v).join("\n")+"\n");' "$(native "$RESTIC_REPOSITORY")"
}
inject_snapshots >"$ROOT/injected.env"
inj() { sed -n "s/^$1=//p" "$ROOT/injected.env"; }
rm -f "$FAKE_STATE_DIR/forgotten"
if "$BACKUP_DIR/backup.sh" >"$ROOT/backup-retention.log" 2>&1; then pass "backup dengan snapshot lama keluar 0"; else
  fail "backup dengan snapshot lama keluar 0 (lihat $ROOT/backup-retention.log)"
  cat "$ROOT/backup-retention.log"
fi
expect "dump berumur 40 hari dilupakan kebijakan keep-within" grep -q "^$(inj dbX) " "$FAKE_STATE_DIR/forgotten"
expect "snapshot berkas pasangannya ikut dilupakan (berpasangan, bukan per waktu grup)" \
  grep -q "^$(inj filesX) " "$FAKE_STATE_DIR/forgotten"
expect "snapshot berkas run gagal tanpa dump dilupakan" grep -q "^$(inj filesY) " "$FAKE_STATE_DIR/forgotten"
expect "snapshot berkas tanpa tag backup_id tidak disentuh dan diberi peringatan" \
  sh -c "! grep -q '^$(inj filesNoTag) ' '$FAKE_STATE_DIR/forgotten' && grep -q 'tanpa tag backup_id' '$ROOT/backup-retention.log'"
expect "pasangan backup run 1 tetap ada" \
  test -f "$RESTIC_REPOSITORY/snapshots/$(inj db1).json" -a -f "$RESTIC_REPOSITORY/snapshots/$(inj files1).json"

# ======================================================================================== 2c. versi image wajib
rm -f "$WORK_DIR/status/last-success"
BEFORE=$(count_db_snapshots)
if IMAGE_API='' "$BACKUP_DIR/backup.sh" >"$ROOT/backup-images.log" 2>&1; then
  fail "production tanpa images.api -> run gagal"
else
  pass "production tanpa images.api -> run gagal (keluar bukan nol, heartbeat down)"
fi
AFTER=$(count_db_snapshots)
expect "production tanpa images.api -> backup TETAP tersimpan (snapshot dump baru, status last-success)" \
  test "$AFTER" -gt "$BEFORE" -a -s "$WORK_DIR/status/last-success"
expect "production tanpa images.api -> pesan menyebut backup tersimpan dan bidang yang kosong" \
  grep -q 'TERSIMPAN.*images.api kosong' "$ROOT/backup-images.log"
# Manifest acuan uji restore = backup terbaru.
MANIFEST=$(db_snapshot_manifest || true)

# ======================================================================================== 3. restore berhasil
restore_env() {
  WORK_DIR=$ROOT/restore-work-$1
  FILES_ROOT=$ROOT/restore-files-$1
  FAKE_FILES_ROOT=$FILES_ROOT
  FAKE_STATE_DIR=$ROOT/state-restore-$1
  LEDGER_REAPPLY_CMD=$FIXTURE/fake-ledger-reapply.sh
  # CLI tiruan berjalan sebagai pengguna uji ini (pada host restore sungguhan: root, chown ke 1000:1000).
  FILES_OWNER="$(id -u):$(id -g)"
  export WORK_DIR FILES_ROOT FAKE_FILES_ROOT FAKE_STATE_DIR LEDGER_REAPPLY_CMD FILES_OWNER
  rm -rf "$WORK_DIR" "$FILES_ROOT" "$FAKE_STATE_DIR"
}
restore_env ok
EVID=$ROOT/evidence-ok
ROLE_PASSWORDS_SQL=''
[ "$POSIX_PERMS" = 1 ] && ROLE_PASSWORDS_SQL=$FIXTURE/role-passwords.sql
export ROLE_PASSWORDS_SQL
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
expect "salinan ledger (id dan object key) disimpan di folder bukti untuk verifikasi sesudah layanan menyala" \
  sh -c "test -d '$EVID/ledger/offsite-now/account-deletions' -a -d '$EVID/ledger/files-backup' && grep -q '^ledger_copy_dir=' '$EVID/summary.txt'"
expect "CLI ledger-reapply membaca salinan dari folder bukti" grep -q "^$EVID/ledger/offsite-now$" "$FAKE_STATE_DIR/ledger-reapply.args"

# Verifikasi ulang sesudah API/worker pulihan menyala (runbook bagian 7 langkah 6): lease worker baru bukan kegagalan.
if FAKE_OUTBOX_LEASED=2 "$BACKUP_DIR/verify-restore.sh" --manifest "$EVID/manifest.json" --files-root "$FILES_ROOT" \
  --ledger-dir "$EVID/ledger" --post-start >"$ROOT/verify-post.log" 2>&1; then
  pass "verify-restore.sh --post-start keluar 0 dengan worker memegang lease"
else
  fail "verify-restore.sh --post-start keluar 0 dengan worker memegang lease (lihat $ROOT/verify-post.log)"
  cat "$ROOT/verify-post.log"
fi
POST_REPORT=$(find "$EVID" -maxdepth 1 -name 'verify-report-post-start-*.txt' | head -n 1)
expect "--post-start: laporan bawaan ditulis di folder bukti (samping manifest), laporan restore tidak tertimpa" \
  sh -c "test -n '$POST_REPORT' && test -s '$POST_REPORT' && grep -q '^PASS paid_total' '$EVID/verify-report.txt'"
expect "--post-start: lease outbox INFO, ledger tetap memeriksa 2 akun dari salinan bukti" \
  sh -c "grep -q '^INFO outbox.lease' '$POST_REPORT' && grep -q '2 akun pada ledger' '$POST_REPORT' && ! grep -q '^FAIL' '$POST_REPORT'"
if FAKE_OUTBOX_LEASED=2 "$BACKUP_DIR/verify-restore.sh" --manifest "$EVID/manifest.json" --files-root "$FILES_ROOT" \
  --post-start --report "$ROOT/verify-post-noledger.txt" >"$ROOT/verify-post-noledger.log" 2>&1; then
  fail "--post-start tanpa --ledger-dir ditolak"
else
  expect "--post-start tanpa --ledger-dir -> FAIL (pemeriksaan ledger tidak boleh lulus kosong)" \
    grep -q '^FAIL ledger.folder' "$ROOT/verify-post-noledger.txt"
fi
if FAKE_OUTBOX_LEASED=2 "$BACKUP_DIR/verify-restore.sh" --manifest "$EVID/manifest.json" --files-root "$FILES_ROOT" \
  --ledger-dir "$EVID/ledger" --report "$ROOT/verify-pre-leased.txt" >"$ROOT/verify-pre-leased.log" 2>&1; then
  fail "tanpa --post-start, lease outbox yang tersisa tetap FAIL"
else
  expect "tanpa --post-start, lease outbox yang tersisa tetap FAIL" grep -q '^FAIL outbox.lease' "$ROOT/verify-pre-leased.txt"
fi
if [ "$POSIX_PERMS" = 1 ]; then
  expect "sandi role (ROLE_PASSWORDS_SQL) diterapkan sesudah roles.sql pertama" \
    test -s "$FAKE_STATE_DIR/role-passwords-applied"
  expect "sandi role tidak tercatat di log maupun folder bukti" \
    sh -c "! grep -rq '$ROLE_SECRET' '$EVID' '$ROOT/restore-ok.log'"
else
  printf 'LEWATI %s\n' "ROLE_PASSWORDS_SQL (izin berkas POSIX tidak tersedia di Git Bash/NTFS; jalankan di Linux)"
fi
ROLE_PASSWORDS_SQL=''
export ROLE_PASSWORDS_SQL

# ======================================================================================== 3b. baseline kosong (PRD 8.2)
restore_env baseline-fail
if FAKE_SUPER_ADMINS=0 "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-baseline-fail" \
  >"$ROOT/restore-baseline-fail.log" 2>&1; then
  fail "nol Super Admin tanpa --baseline-empty -> verifikasi gagal"
else
  expect "nol Super Admin tanpa --baseline-empty -> FAIL super_admin.aktif" \
    grep -q '^FAIL super_admin.aktif' "$ROOT/evidence-baseline-fail/verify-report.txt"
fi
restore_env baseline
if FAKE_SUPER_ADMINS=0 "$BACKUP_DIR/restore.sh" --target-kind drill --yes --baseline-empty \
  --evidence-dir "$ROOT/evidence-baseline" >"$ROOT/restore-baseline.log" 2>&1; then
  pass "--baseline-empty (PRD 8.2 langkah 1, sebelum bootstrap Super Admin) keluar 0"
else
  fail "--baseline-empty (PRD 8.2 langkah 1, sebelum bootstrap Super Admin) keluar 0 (lihat $ROOT/restore-baseline.log)"
  cat "$ROOT/restore-baseline.log"
fi
expect "--baseline-empty: nol Super Admin WARN dan tercatat di ringkasan" \
  sh -c "grep -q '^WARN super_admin.aktif' '$ROOT/evidence-baseline/verify-report.txt' && grep -q '^baseline_empty=1' '$ROOT/evidence-baseline/summary.txt'"

# ======================================================================================== 4. restore ditolak/gagal
if [ "$(id -u)" != 0 ]; then
  restore_env owner
  if FILES_OWNER="$(($(id -u) + 1)):$(id -g)" "$BACKUP_DIR/restore.sh" --target-kind drill --yes \
    --evidence-dir "$ROOT/evidence-owner" >"$ROOT/restore-owner.log" 2>&1; then
    fail "pengguna selain root/FILES_OWNER ditolak"
  else
    expect "pengguna selain root/FILES_OWNER ditolak sebelum mengunduh apa pun" \
      sh -c "grep -q 'jalankan restore.sh sebagai root atau uid' '$ROOT/restore-owner.log' && ! grep -qs '^restic ' '$FAKE_STATE_DIR/calls.log'"
  fi
fi
restore_env dirty
mkdir -p "$FILES_ROOT" && printf x >"$FILES_ROOT/sisa"
if "$BACKUP_DIR/restore.sh" --target-kind drill --yes --evidence-dir "$ROOT/evidence-dirty" >"$ROOT/restore-dirty.log" 2>&1; then
  fail "FILES_ROOT tidak kosong ditolak"
else
  expect "FILES_ROOT tidak kosong ditolak" grep -q 'tidak kosong' "$ROOT/restore-dirty.log"
fi
if [ "$POSIX_PERMS" = 1 ]; then
  restore_env rolepw
  if ROLE_PASSWORDS_SQL=$FIXTURE/role-passwords-terbuka.sql "$BACKUP_DIR/restore.sh" --target-kind drill --yes \
    --evidence-dir "$ROOT/evidence-rolepw" >"$ROOT/restore-rolepw.log" 2>&1; then
    fail "ROLE_PASSWORDS_SQL yang dapat dibaca semua pengguna ditolak"
  else
    expect "ROLE_PASSWORDS_SQL yang dapat dibaca semua pengguna ditolak" \
      grep -q 'ROLE_PASSWORDS_SQL dapat dibaca semua pengguna' "$ROOT/restore-rolepw.log"
  fi
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
