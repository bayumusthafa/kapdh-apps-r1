#!/bin/sh
# Job migrasi deployment tunggal yang dipanggil CI sebelum image baru dideploy (PRD 5.5 "migrasi skema dijalankan
# oleh job deployment tunggal dengan lock, bukan setiap startup replica"; PRD 8.2 langkah 2; ARCHITECTURE §10).
#
# Dipasang pengelola infra di VPS sebagai /usr/local/bin/kapdh-ci-migrate (pemilik root, mode 0755) dan dikunci
# sebagai forced command di ~deploy/.ssh/authorized_keys, satu kunci per lingkungan:
#   restrict,command="/usr/local/bin/kapdh-ci-migrate" ssh-ed25519 AAAA... github-actions-kapdh-staging
# CI (.github/workflows/_deploy.yml) menjalankan:
#   ssh deploy@<host> "migrate <staging|production> ghcr.io/<owner>/kapdh-api@sha256:<64 hex>" < infra/db/roles.sql
# Pengelola infra juga dapat menjalankannya manual dengan argumen yang sama (runbook docs/runbooks/ci-cd.md).
#
# Urutan (docs/handoff/phase-a-schema.md "Ops order"): roles.sql -> migrate.js sebagai kapdh_migrator (advisory lock
# MIGRATION_LOCK_KEY, semua migrasi tertunda dalam satu transaksi) -> roles.sql lagi (grant objek baru). Tidak ada
# seed: data referensi production dijalankan terpisah dan sekali (PRD 8.2 langkah 4).
#
# Konfigurasi per lingkungan: /etc/kapdh/ci-migrate/<env>.env (pemilik user deploy, mode 0400), berisi:
#   KAPDH_DOCKER_NETWORK=<jaringan Docker tempat PostgreSQL lingkungan itu dapat dijangkau>
#   KAPDH_API_REPOSITORY=ghcr.io/<owner>/kapdh-api    (hanya repositori ini yang boleh dijalankan)
#   KAPDH_PSQL_IMAGE=postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24
#   KAPDH_MIGRATOR_DATABASE_URL=postgres://kapdh_migrator:<sandi>@<host>:5432/<db>
#   KAPDH_ADMIN_DATABASE_URL=postgres://<pemilik database>:<sandi>@<host>:5432/<db>
# URL database tidak pernah dicetak dan tidak muncul di argumen proses (diteruskan lewat environment docker -e NAMA).
set -eu

log() {
  printf '%s kapdh-ci-migrate: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "GAGAL: $*" >&2
  exit 1
}

# Perintah dari SSH forced command dipecah per spasi tanpa ekspansi glob; setiap kata divalidasi pola ketat.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  set -f
  # shellcheck disable=SC2086 # pemecahan kata disengaja (lihat komentar di atas)
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi

[ "$#" -eq 3 ] || die "pemakaian: migrate <staging|production> <repositori-api>@sha256:<digest>"
[ "$1" = "migrate" ] || die "perintah tidak dikenal; hanya 'migrate' yang diizinkan"
ENV_NAME=$2
IMAGE=$3
case "$ENV_NAME" in
  staging | production) ;;
  *) die "lingkungan harus staging atau production" ;;
esac

# KAPDH_CI_MIGRATE_CONFIG_DIR hanya untuk uji lokal skrip; forced command SSH tidak meneruskan env klien.
CONFIG="${KAPDH_CI_MIGRATE_CONFIG_DIR:-/etc/kapdh/ci-migrate}/${ENV_NAME}.env"
[ -r "$CONFIG" ] || die "konfigurasi $CONFIG tidak ada atau tidak terbaca"
# shellcheck source=/dev/null # berkas milik pengelola infra di server
. "$CONFIG"
: "${KAPDH_DOCKER_NETWORK:?wajib di $CONFIG}"
: "${KAPDH_API_REPOSITORY:?wajib di $CONFIG}"
: "${KAPDH_PSQL_IMAGE:?wajib di $CONFIG}"
: "${KAPDH_MIGRATOR_DATABASE_URL:?wajib di $CONFIG}"
: "${KAPDH_ADMIN_DATABASE_URL:?wajib di $CONFIG}"

# Hanya image API dari repositori yang diizinkan, dirujuk dengan digest (image yang sama dengan yang dideploy).
DIGEST=${IMAGE#"${KAPDH_API_REPOSITORY}@sha256:"}
[ "$DIGEST" != "$IMAGE" ] || die "image harus ${KAPDH_API_REPOSITORY}@sha256:<digest>"
case "$DIGEST" in
  "" | *[!0-9a-f]*) die "digest image tidak valid" ;;
esac
[ "${#DIGEST}" -eq 64 ] || die "digest image harus 64 karakter heksadesimal"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM
chmod 0755 "$WORK"
ROLES="$WORK/roles.sql"
# roles.sql dikirim CI lewat stdin dari commit yang sama dengan image (batas 1 MiB).
dd bs=1024 count=1024 of="$ROLES" 2>/dev/null
[ -s "$ROLES" ] || die "roles.sql tidak diterima di stdin"
grep -q 'kapdh_migrator' "$ROLES" || die "stdin bukan infra/db/roles.sql"
chmod 0444 "$ROLES"

apply_roles() {
  # shellcheck disable=SC2016 # $ADMIN_DATABASE_URL sengaja diekspansi oleh sh di dalam kontainer, bukan di host
  ADMIN_DATABASE_URL=$KAPDH_ADMIN_DATABASE_URL docker run --rm --network "$KAPDH_DOCKER_NETWORK" \
    -e ADMIN_DATABASE_URL -v "$ROLES:/kapdh/roles.sql:ro" "$KAPDH_PSQL_IMAGE" \
    sh -c 'exec psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f /kapdh/roles.sql'
}

log "lingkungan $ENV_NAME, image ${KAPDH_API_REPOSITORY}@sha256:$(printf '%.12s' "$DIGEST")"
docker pull --quiet "$IMAGE" >/dev/null || die "docker pull image API gagal (login ghcr.io di server?)"
docker pull --quiet "$KAPDH_PSQL_IMAGE" >/dev/null || die "docker pull image psql gagal"

log "1/3 roles.sql (sebelum migrasi)"
apply_roles || die "roles.sql sebelum migrasi gagal"

log "2/3 migrasi skema sebagai kapdh_migrator (advisory lock)"
DATABASE_URL=$KAPDH_MIGRATOR_DATABASE_URL docker run --rm --network "$KAPDH_DOCKER_NETWORK" \
  -e DATABASE_URL -e NODE_ENV=production "$IMAGE" \
  node node_modules/@kapdh/database/dist/bin/migrate.js || die "migrasi gagal; image baru JANGAN dideploy"

log "3/3 roles.sql (grant objek skema terbaru)"
apply_roles || die "roles.sql sesudah migrasi gagal"

log "selesai"
