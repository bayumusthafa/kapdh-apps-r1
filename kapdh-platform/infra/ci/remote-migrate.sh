#!/bin/sh
# Job migrasi deployment tunggal yang dipanggil CI sebelum image baru dideploy (PRD 5.5 "migrasi skema dijalankan
# oleh job deployment tunggal dengan lock, bukan setiap startup replica"; PRD 8.2 langkah 2; ARCHITECTURE §10).
#
# Dipasang pengelola infra di VPS sebagai /usr/local/bin/kapdh-ci-migrate (pemilik root, mode 0755) dan dikunci
# sebagai forced command. Lingkungan DIIKAT DI SISI SERVER oleh argumen forced command, satu user Unix dan satu kunci
# per lingkungan (docs/runbooks/ci-cd.md bagian 5):
#   ~kapdh-ci-staging/.ssh/authorized_keys:
#     restrict,command="/usr/local/bin/kapdh-ci-migrate staging" ssh-ed25519 AAAA... github-actions-kapdh-staging
#   ~kapdh-ci-production/.ssh/authorized_keys:
#     restrict,command="/usr/local/bin/kapdh-ci-migrate production" ssh-ed25519 AAAA... github-actions-kapdh-production
# CI (.github/workflows/_deploy.yml) mengirim perintah (tanpa stdin):
#   migrate staging    ghcr.io/<owner>/kapdh-api@sha256:<64 hex>
#   migrate production ghcr.io/<owner>/kapdh-api@sha256:<64 hex> vX.Y.Z[-rc.N]
# Lingkungan pada perintah klien wajib sama dengan lingkungan yang diikat forced command: kunci staging tidak pernah
# dapat memigrasi production. Pengelola infra dapat menjalankan manual dengan argumen yang sama:
#   kapdh-ci-migrate production migrate production ghcr.io/<owner>/kapdh-api@sha256:<digest> v1.2.0
#
# Urutan (docs/handoff/phase-a-schema.md "Ops order"; sama dengan job rilis infra/scripts/release-job.sh di jalur
# Compose cadangan, docs/adr/023-job-rilis-dan-gerbang-go-live.md):
#   [production, atau bila KAPDH_BACKUP_DIR diisi] dump pg_dump -Fc sebelum migrasi (gagal = berhenti, PRD 5.5/8.4)
#   -> roles.sql -> [mode enforce] gerbang go-live pra-migrasi (`golive-check.js --preflight`; ditolak = skema tidak
#   diubah) -> migrate.js sebagai kapdh_migrator (advisory lock MIGRATION_LOCK_KEY, semua migrasi tertunda dalam satu
#   transaksi) -> roles.sql lagi (grant objek baru) -> seed referensi idempoten (PRD 8.2 langkah 4; nilai pengurus tidak
#   ditimpa, fixture ditolak) -> gerbang go-live penuh (PRD 9.2 #9, 9.3). Gerbang dijalankan dari image API yang sama
#   sebagai kapdh_migrator dengan `--allow-schema-ahead` (deploy ulang tag lama = rollback image; skema lebih baru
#   dicatat sebagai peringatan, PRD 8.4). Mode `enforce` (bawaan production) menggagalkan job pada penolakan sehingga
#   CI tidak men-deploy image; mode `report` (bawaan staging) hanya mencetak laporan.
# Image lebih lama dari skema (database memuat migrasi yang tidak ada di journal image; aksi `deploy-tag` release.yml =
# rollback image): roles.sql, migrasi dan seed referensi image itu DILEWATI dengan peringatan, hanya gerbang go-live
# (pra-migrasi bila enforce, lalu penuh `--allow-schema-ahead`) yang dijalankan. roles.sql lama melakukan REVOKE/GRANT
# ulang atas semua tabel dan hanya mengenal pembatasan versinya, sehingga menjalankannya pada skema baru akan melonggarkan
# hak tabel yang dibatasi rilis baru (PRD 5.1 least privilege); roles.sql rilis terbaru tetap berlaku. Job rilis manual
# (release-job.sh) menolak keadaan ini sama sekali.
# roles.sql DIAMBIL DARI IMAGE API yang dipin digest (/app/db/roles.sql, infra/Dockerfile.api), bukan dari klien:
# SQL yang dijalankan sebagai pemilik database hanya berasal dari artefak CI yang sama dengan kode migrasi.
# Production hanya menerima digest yang sama dengan image bertag rilis vX.Y.Z di registry (dibuat release.yml).
#
# Konfigurasi: $CONFIG_DIR/<lingkungan>.env (pemilik user CI lingkungan itu, mode 0400), berisi:
#   KAPDH_ENVIRONMENT=<staging|production>          (wajib sama dengan lingkungan forced command)
#   KAPDH_DOCKER_NETWORK=<jaringan Docker tempat PostgreSQL lingkungan itu dapat dijangkau>
#   KAPDH_API_REPOSITORY=ghcr.io/<owner>/kapdh-api    (hanya repositori ini yang boleh dijalankan)
#   KAPDH_PSQL_IMAGE=postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
#   KAPDH_MIGRATOR_DATABASE_URL=postgres://kapdh_migrator:<sandi>@<host>:5432/<db>
#   KAPDH_ADMIN_DATABASE_URL=postgres://<superuser/pemilik database>:<sandi>@<host>:5432/<db>
#   KAPDH_BACKUP_DIR=/var/backups/kapdh/premigrate   (wajib production; direktori mode 0700 milik user CI)
#   KAPDH_BACKUP_KEEP=3                               (opsional; jumlah dump pra-migrasi yang disimpan)
#   KAPDH_BACKUP_MAX_AGE_DAYS=7                       (opsional; dump lebih tua dihapus, data pribadi D2)
#   KAPDH_BACKUP_OFFSITE_HOOK=/usr/local/bin/...      (opsional; salin dump terenkripsi ke luar VPS, gagal = berhenti)
#   KAPDH_RELEASE_GATE=enforce|report                 (opsional; bawaan enforce di production, report di staging)
#   KAPDH_RELEASE_GATE_REASON=<alasan>                (wajib bila production + report: pengecualian gerbang, mis.
#                                                      "inisialisasi pertama PRD 8.2"; dicetak ke log CI sebagai bukti)
#   KAPDH_RELEASE_GATE_APPROVER=<nama>                (wajib bila production + report: penyetuju, D9)
# Mode gerbang hanya dari berkas konfigurasi server (pengelola infra), tidak pernah dari perintah klien CI. Nama tanpa
# awalan KAPDH_ (RELEASE_GATE, RELEASE_GATE_REASON, RELEASE_GATE_APPROVER) milik job rilis manual
# (infra/scripts/run-release.sh, /etc/kapdh/<lingkungan>/release.env) dan DITOLAK di sini dengan pesan jelas agar
# pengecualian yang ditulis dengan nama itu tidak diam-diam diabaikan.
# URL database tidak pernah dicetak dan tidak muncul di argumen proses (diteruskan lewat environment docker -e NAMA).
set -eu

# Satu-satunya lokasi konfigurasi. Uji lokal (infra/ci/test/remote-migrate.test.mjs) mengganti baris ini pada salinan
# skrip; tidak ada variabel environment yang dapat mengalihkannya.
CONFIG_DIR=/etc/kapdh/ci-migrate

log() {
  printf '%s kapdh-ci-migrate: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "GAGAL: $*" >&2
  exit 1
}

valid_env() {
  case "$1" in
    staging | production) return 0 ;;
    *) return 1 ;;
  esac
}

# Lingkungan yang diikat server: argumen pertama dari forced command (atau dari pengelola infra saat manual).
[ "$#" -ge 1 ] || die "lingkungan forced command tidak diisi (command=\"/usr/local/bin/kapdh-ci-migrate <lingkungan>\")"
BOUND_ENV=$1
shift
valid_env "$BOUND_ENV" || die "lingkungan forced command harus staging atau production"

# Perintah klien: lewat SSH dari SSH_ORIGINAL_COMMAND (dipecah per spasi tanpa ekspansi glob), atau argumen sisa
# saat dijalankan manual. Setiap kata divalidasi pola ketat di bawah.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  [ "$#" -eq 0 ] || die "argumen tambahan tidak diizinkan pada forced command"
  set -f
  # shellcheck disable=SC2086 # pemecahan kata disengaja (lihat komentar di atas)
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi

[ "$#" -eq 3 ] || [ "$#" -eq 4 ] ||
  die "pemakaian: migrate <staging|production> <repositori-api>@sha256:<digest> [vX.Y.Z]"
[ "$1" = "migrate" ] || die "perintah tidak dikenal; hanya 'migrate' yang diizinkan"
ENV_NAME=$2
IMAGE=$3
RELEASE_TAG=${4:-}
valid_env "$ENV_NAME" || die "lingkungan harus staging atau production"
[ "$ENV_NAME" = "$BOUND_ENV" ] ||
  die "kunci ini terikat ke lingkungan $BOUND_ENV; permintaan untuk $ENV_NAME ditolak"

if [ -n "$RELEASE_TAG" ]; then
  case "$RELEASE_TAG" in
    *[!0-9A-Za-z.-]*) die "tag rilis tidak valid" ;;
  esac
  printf '%s\n' "$RELEASE_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' ||
    die "tag rilis harus vX.Y.Z atau vX.Y.Z-rc.N"
fi
[ "$ENV_NAME" != "production" ] || [ -n "$RELEASE_TAG" ] ||
  die "production hanya menerima image rilis: sertakan tag vX.Y.Z (release.yml)"

CONFIG="$CONFIG_DIR/$BOUND_ENV.env"
[ -r "$CONFIG" ] || die "konfigurasi $CONFIG tidak ada atau tidak terbaca"
# shellcheck source=/dev/null # berkas milik pengelola infra di server
. "$CONFIG"
: "${KAPDH_ENVIRONMENT:?wajib di $CONFIG}"
: "${KAPDH_DOCKER_NETWORK:?wajib di $CONFIG}"
: "${KAPDH_API_REPOSITORY:?wajib di $CONFIG}"
: "${KAPDH_PSQL_IMAGE:?wajib di $CONFIG}"
: "${KAPDH_MIGRATOR_DATABASE_URL:?wajib di $CONFIG}"
: "${KAPDH_ADMIN_DATABASE_URL:?wajib di $CONFIG}"
[ "$KAPDH_ENVIRONMENT" = "$BOUND_ENV" ] ||
  die "$CONFIG menyatakan KAPDH_ENVIRONMENT=$KAPDH_ENVIRONMENT, bukan $BOUND_ENV (berkas tertukar?)"
case "$KAPDH_PSQL_IMAGE" in
  *@sha256:*) ;;
  *) die "KAPDH_PSQL_IMAGE wajib dipin @sha256:<digest> (PRD 7.1)" ;;
esac
BACKUP_DIR=${KAPDH_BACKUP_DIR:-}
BACKUP_KEEP=${KAPDH_BACKUP_KEEP:-3}
BACKUP_MAX_AGE_DAYS=${KAPDH_BACKUP_MAX_AGE_DAYS:-7}
BACKUP_HOOK=${KAPDH_BACKUP_OFFSITE_HOOK:-}
[ "$ENV_NAME" != "production" ] || [ -n "$BACKUP_DIR" ] ||
  die "KAPDH_BACKUP_DIR wajib untuk production: migrasi tidak berjalan tanpa dump pra-migrasi (PRD 5.5, 8.4)"
case "$BACKUP_KEEP" in
  "" | *[!0-9]* | 0) die "KAPDH_BACKUP_KEEP harus bilangan bulat >= 1" ;;
esac
case "$BACKUP_MAX_AGE_DAYS" in
  "" | *[!0-9]*) die "KAPDH_BACKUP_MAX_AGE_DAYS harus bilangan bulat" ;;
esac
# Gerbang go-live (PRD 9.2 #9, 9.3): kebijakan sama dengan RELEASE_GATE job rilis (infra/scripts/release-job.sh), tetapi
# dengan nama KAPDH_RELEASE_GATE*. Nama job rilis manual ditolak (bukan diabaikan) agar salah nama terlihat di log CI.
for legacy in RELEASE_GATE RELEASE_GATE_REASON RELEASE_GATE_APPROVER; do
  eval "legacy_value=\${$legacy:-}"
  [ -z "$legacy_value" ] ||
    die "$legacy tidak berlaku untuk job migrasi CI; tulis KAPDH_$legacy di $CONFIG (docs/runbooks/ci-cd.md bagian 5)"
done
GATE_MODE=${KAPDH_RELEASE_GATE:-}
if [ -z "$GATE_MODE" ]; then
  if [ "$ENV_NAME" = "production" ]; then GATE_MODE=enforce; else GATE_MODE=report; fi
fi
case "$GATE_MODE" in
  enforce | report) ;;
  *) die "KAPDH_RELEASE_GATE harus enforce atau report" ;;
esac
GATE_REASON=${KAPDH_RELEASE_GATE_REASON:-}
GATE_APPROVER=${KAPDH_RELEASE_GATE_APPROVER:-}
if [ "$ENV_NAME" = "production" ] && [ "$GATE_MODE" = "report" ]; then
  [ -n "$GATE_REASON" ] && [ -n "$GATE_APPROVER" ] ||
    die "KAPDH_RELEASE_GATE=report di production wajib disertai KAPDH_RELEASE_GATE_REASON dan KAPDH_RELEASE_GATE_APPROVER"
fi

# Hanya image API dari repositori yang diizinkan, dirujuk dengan digest (image yang sama dengan yang dideploy).
DIGEST=${IMAGE#"${KAPDH_API_REPOSITORY}@sha256:"}
[ "$DIGEST" != "$IMAGE" ] || die "image harus ${KAPDH_API_REPOSITORY}@sha256:<digest>"
case "$DIGEST" in
  "" | *[!0-9a-f]*) die "digest image tidak valid" ;;
esac
[ "${#DIGEST}" -eq 64 ] || die "digest image harus 64 karakter heksadesimal"
SHORT=$(printf '%.12s' "$DIGEST")

WORK=$(mktemp -d)
CID=""
cleanup() {
  if [ -n "$CID" ]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
chmod 0755 "$WORK"
ROLES="$WORK/roles.sql"

log "lingkungan $ENV_NAME, image ${KAPDH_API_REPOSITORY}@sha256:$SHORT${RELEASE_TAG:+ (rilis $RELEASE_TAG)}"
docker pull --quiet "$IMAGE" >/dev/null || die "docker pull image API gagal (login ghcr.io di server?)"
docker pull --quiet "$KAPDH_PSQL_IMAGE" >/dev/null || die "docker pull image psql gagal"

# Tag rilis harus menunjuk image yang sama (ID image identik) dengan digest yang diminta.
if [ -n "$RELEASE_TAG" ]; then
  docker pull --quiet "$KAPDH_API_REPOSITORY:$RELEASE_TAG" >/dev/null ||
    die "image rilis $KAPDH_API_REPOSITORY:$RELEASE_TAG tidak ada di registry"
  by_digest=$(docker image inspect --format '{{.Id}}' "$IMAGE") || die "docker image inspect digest gagal"
  by_tag=$(docker image inspect --format '{{.Id}}' "$KAPDH_API_REPOSITORY:$RELEASE_TAG") ||
    die "docker image inspect tag rilis gagal"
  if [ -z "$by_digest" ] || [ "$by_digest" != "$by_tag" ]; then
    die "digest $SHORT bukan image rilis $RELEASE_TAG; production hanya menjalankan image rilis"
  fi
fi

# roles.sql dan journal migrasi dari image API yang sama (tanpa menjalankan kode image: docker create + docker cp).
JOURNAL="$WORK/_journal.json"
CID=$(docker create "$IMAGE") || die "docker create image API gagal"
docker cp "$CID:/app/db/roles.sql" "$ROLES" >/dev/null || die "image API tidak memuat /app/db/roles.sql"
docker cp "$CID:/app/node_modules/@kapdh/database/migrations/meta/_journal.json" "$JOURNAL" >/dev/null ||
  die "image API tidak memuat journal migrasi (node_modules/@kapdh/database/migrations/meta/_journal.json)"
docker rm -f "$CID" >/dev/null 2>&1 || true
CID=""
[ -s "$ROLES" ] || die "roles.sql di image kosong"
grep -q 'kapdh_migrator' "$ROLES" || die "/app/db/roles.sql di image bukan infra/db/roles.sql"
chmod 0444 "$ROLES"
IMAGE_MIGRATIONS=$(grep -o '"tag"' "$JOURNAL" | wc -l | tr -d ' ')
[ "$IMAGE_MIGRATIONS" -gt 0 ] || die "journal migrasi image kosong"

apply_roles() {
  # shellcheck disable=SC2016 # $ADMIN_DATABASE_URL sengaja diekspansi oleh sh di dalam kontainer, bukan di host
  ADMIN_DATABASE_URL=$KAPDH_ADMIN_DATABASE_URL docker run --rm --network "$KAPDH_DOCKER_NETWORK" \
    -e ADMIN_DATABASE_URL -v "$ROLES:/kapdh/roles.sql:ro" "$KAPDH_PSQL_IMAGE" \
    sh -c 'exec psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f /kapdh/roles.sql'
}

# Jumlah migrasi tercatat di database (0 bila tabel drizzle belum ada), baca saja. SQL diteruskan lewat environment
# agar kutipannya tidak ikut diurai shell di dalam kontainer.
db_migrations() {
  # shellcheck disable=SC2016 # diekspansi oleh sh di dalam kontainer
  ADMIN_DATABASE_URL=$KAPDH_ADMIN_DATABASE_URL \
    SQL_HAS_TABLE="select to_regclass('drizzle.__drizzle_migrations') is not null" \
    SQL_COUNT="select count(*) from drizzle.__drizzle_migrations" \
    docker run --rm --network "$KAPDH_DOCKER_NETWORK" -e ADMIN_DATABASE_URL -e SQL_HAS_TABLE -e SQL_COUNT \
    "$KAPDH_PSQL_IMAGE" sh -c 'q() { psql "$ADMIN_DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; };
      has=$(q "$SQL_HAS_TABLE") || exit 1; if [ "$has" = t ]; then q "$SQL_COUNT"; else echo 0; fi'
}

# Dump pra-migrasi (format custom pg_dump). Dibuat di host dengan umask 077 (berisi data pribadi; D2, N-09), diverifikasi
# dapat dibaca pg_restore, dicatat di manifest, lalu (opsional) disalin ke luar VPS oleh hook. Pemulihan:
# docs/runbooks/ci-cd.md bagian 9 dan docs/runbooks/restore-backup.md (deletion ledger wajib diterapkan ulang).
backup_before_migration() {
  [ -d "$BACKUP_DIR" ] || die "KAPDH_BACKUP_DIR $BACKUP_DIR tidak ada"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dump="$BACKUP_DIR/kapdh-$ENV_NAME-premigrate-$stamp-$SHORT.dump"
  (
    umask 077
    # shellcheck disable=SC2016 # diekspansi di dalam kontainer
    ADMIN_DATABASE_URL=$KAPDH_ADMIN_DATABASE_URL docker run --rm --network "$KAPDH_DOCKER_NETWORK" \
      -e ADMIN_DATABASE_URL "$KAPDH_PSQL_IMAGE" \
      sh -c 'exec pg_dump --format=custom --compress=6 --dbname="$ADMIN_DATABASE_URL"' >"$dump.partial"
  ) || {
    rm -f "$dump.partial"
    die "pg_dump pra-migrasi gagal; migrasi TIDAK dijalankan"
  }
  [ -s "$dump.partial" ] || {
    rm -f "$dump.partial"
    die "dump pra-migrasi kosong; migrasi TIDAK dijalankan"
  }
  docker run --rm -i --network none "$KAPDH_PSQL_IMAGE" pg_restore --list <"$dump.partial" >/dev/null || {
    rm -f "$dump.partial"
    die "dump pra-migrasi tidak dapat dibaca pg_restore; migrasi TIDAK dijalankan"
  }
  mv "$dump.partial" "$dump"
  sum=$(sha256sum "$dump" | cut -d ' ' -f 1)
  bytes=$(wc -c <"$dump" | tr -d ' ')
  (
    umask 077
    printf '{"time":"%s","environment":"%s","file":"%s","sha256":"%s","bytes":%s,"api_digest":"sha256:%s","release":"%s"}\n' \
      "$stamp" "$ENV_NAME" "${dump##*/}" "$sum" "$bytes" "$DIGEST" "$RELEASE_TAG" >>"$BACKUP_DIR/premigrate-manifest.jsonl"
  )
  log "dump pra-migrasi ${dump##*/} ($bytes byte, sha256 $(printf '%.12s' "$sum"))"
  if [ -n "$BACKUP_HOOK" ]; then
    "$BACKUP_HOOK" "$dump" || die "hook salinan luar VPS gagal; migrasi TIDAK dijalankan"
    log "dump pra-migrasi disalin ke luar VPS (hook)"
  fi
  # Rotasi: nama berstempel waktu lebar tetap sehingga urutan glob = urutan waktu (terlama dulu).
  set -- "$BACKUP_DIR"/kapdh-"$ENV_NAME"-premigrate-*.dump
  excess=$(($# - BACKUP_KEEP))
  while [ "$excess" -gt 0 ]; do
    rm -f -- "$1"
    shift
    excess=$((excess - 1))
  done
  if [ "$BACKUP_MAX_AGE_DAYS" -gt 0 ]; then
    find "$BACKUP_DIR" -type f -name "kapdh-$ENV_NAME-premigrate-*.dump" -mtime +"$BACKUP_MAX_AGE_DAYS" -exec rm -f {} +
  fi
}

run_in_image() {
  # Perintah node di image API yang sama (digest), sebagai kapdh_migrator; URL hanya lewat environment.
  DATABASE_URL=$KAPDH_MIGRATOR_DATABASE_URL docker run --rm --network "$KAPDH_DOCKER_NETWORK" \
    -e DATABASE_URL -e NODE_ENV=production "$IMAGE" "$@"
}

log "mode gerbang go-live $GATE_MODE"
if [ "$ENV_NAME" = "production" ] && [ "$GATE_MODE" = "report" ]; then
  log "PERINGATAN: PENGECUALIAN GERBANG go-live di production (mode laporan; PRD 9.2, 9.3)."
  log "PERINGATAN: alasan: $GATE_REASON"
  log "PERINGATAN: disetujui: $GATE_APPROVER"
  log "PERINGATAN: catat di log insiden/paket bukti; pemeriksaan merah wajib punya pemilik dan tenggat."
fi

if [ -n "$BACKUP_DIR" ]; then
  log "0/6 dump database sebelum migrasi"
  backup_before_migration
fi

# Versi skema dibanding journal image (sama dengan langkah 2 release-job.sh). Image lebih lama dari skema = rollback
# image (deploy-tag): skema, hak dan data referensi rilis terbaru dibiarkan; hanya gerbang go-live yang dijalankan.
DB_MIGRATIONS=$(db_migrations) || die "versi skema database tidak dapat dibaca"
case "$DB_MIGRATIONS" in
  "" | *[!0-9]*) die "jumlah migrasi tercatat tidak valid" ;;
esac
log "versi skema: migrasi tercatat $DB_MIGRATIONS, journal image $IMAGE_MIGRATIONS"
SCHEMA_AHEAD=false
if [ "$DB_MIGRATIONS" -gt "$IMAGE_MIGRATIONS" ]; then
  SCHEMA_AHEAD=true
  log "PERINGATAN: database memuat $((DB_MIGRATIONS - IMAGE_MIGRATIONS)) migrasi yang tidak dikenal image ini (image lebih"
  log "PERINGATAN: lama dari skema: rollback image). roles.sql, migrasi dan seed referensi image ini DILEWATI agar hak"
  log "PERINGATAN: tabel dan data referensi rilis terbaru tidak ditimpa versi lama (PRD 5.1, 5.5, 8.4); hanya gerbang"
  log "PERINGATAN: go-live yang dijalankan. Pastikan migrasi baru kompatibel mundur (docs/runbooks/ci-cd.md bagian 9)."
fi

if [ "$SCHEMA_AHEAD" = true ]; then
  log "1/6 roles.sql DILEWATI (skema lebih baru dari image; roles.sql rilis terbaru tetap berlaku)"
else
  log "1/6 roles.sql (sebelum migrasi)"
  apply_roles || die "roles.sql sebelum migrasi gagal"
fi

if [ "$GATE_MODE" = "enforce" ]; then
  log "2/6 gerbang go-live pra-migrasi (konfigurasi pengurus; skema belum diubah)"
  set +e
  run_in_image node dist/cli/golive-check.js --preflight
  preflight_code=$?
  set -e
  case "$preflight_code" in
    0) log "pra-migrasi LULUS" ;;
    1) die "gerbang go-live pra-migrasi MENOLAK konfigurasi; migrasi TIDAK dijalankan dan image JANGAN dideploy (PRD 9.2, 9.3)" ;;
    *)
      log "PERINGATAN: pra-migrasi tidak dapat dijalankan (kode $preflight_code; mis. skema lama belum memuat kolom yang"
      log "PERINGATAN: dibaca gerbang image baru). Gerbang penuh setelah migrasi tetap menentukan."
      ;;
  esac
else
  log "2/6 gerbang pra-migrasi dilewati (mode laporan)"
fi

if [ "$SCHEMA_AHEAD" = true ]; then
  log "3/6 migrasi DILEWATI (journal image tidak memuat migrasi baru)"
  log "4/6 roles.sql DILEWATI (skema lebih baru dari image)"
  log "5/6 seed referensi DILEWATI (data referensi rilis terbaru tetap berlaku)"
else
  log "3/6 migrasi skema sebagai kapdh_migrator (advisory lock)"
  run_in_image node node_modules/@kapdh/database/dist/bin/migrate.js || die "migrasi gagal; image baru JANGAN dideploy"

  log "4/6 roles.sql (grant objek skema terbaru)"
  apply_roles || die "roles.sql sesudah migrasi gagal"

  log "5/6 seed referensi (idempoten, tanpa fixture)"
  run_in_image node node_modules/@kapdh/database/dist/bin/seed-reference.js ||
    die "seed referensi gagal; image baru JANGAN dideploy"
fi

log "6/6 gerbang go-live penuh (mode $GATE_MODE)"
set +e
run_in_image node dist/cli/golive-check.js --allow-schema-ahead
gate_code=$?
set -e
case "$gate_code" in
  0) log "gerbang LULUS" ;;
  1)
    if [ "$GATE_MODE" = "enforce" ]; then
      die "gerbang go-live MENOLAK setelah migrasi; image JANGAN dideploy. Skema sudah naik: perbaiki maju, jangan rollback skema (PRD 8.4, 9.2, 9.3)"
    fi
    log "gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live."
    ;;
  *) die "gerbang go-live tidak dapat dijalankan (kode $gate_code); image JANGAN dideploy" ;;
esac

log "selesai"
