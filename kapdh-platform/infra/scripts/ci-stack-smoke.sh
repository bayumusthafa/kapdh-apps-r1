#!/bin/sh
# Uji asap stack Compose production lengkap di CI (Linux + Docker), memakai image yang baru dibangun dengan tag
# kapdh-ci/kapdh-<layanan>:ci (infra/ci/github-actions-images.yml). Membuktikan tanpa VPS: `docker compose config`
# untuk production dan staging, job rilis (roles.sql via psql → migrasi kapdh_migrator → seed → gerbang mode laporan),
# healthcheck semua kontainer, header web/admin, kesiapan API, gerbang go-live menolak database baru (PRD 9.2), dan
# PostgreSQL/Redis tidak terjangkau dari jaringan edge (N-07). Secret dibuat acak per run dan dibuang di akhir.
#
#   sh infra/scripts/ci-stack-smoke.sh
set -eu

cd "$(dirname "$0")/../.."
work="$(mktemp -d)"
env_file="$work/production.env"
project_files="-f infra/compose.production.yml"
CURL_IMAGE="curlimages/curl:8.21.0@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13"

compose() {
  # shellcheck disable=SC2086
  docker compose --env-file "$env_file" $project_files "$@"
}

cleanup() {
  compose logs --no-color >"$work/compose.log" 2>&1 || true
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    compose --profile release down -v --remove-orphans >/dev/null 2>&1 || true
    docker network rm kapdh-edge >/dev/null 2>&1 || true
  fi
  if [ -n "${CI_ARTIFACT_DIR:-}" ]; then cp "$work/compose.log" "$CI_ARTIFACT_DIR/" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$*"; }
die() {
  printf 'GAGAL: %s\n' "$*" >&2
  exit 1
}

step "env production acak dari infra/.env.production.example"
hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
while IFS= read -r line; do
  case "$line" in
    '#'* | '') echo "$line" ;;
    *ganti-dengan*)
      key="${line%%=*}"
      case "$key" in
        SMTP_URL) echo "SMTP_URL=smtp://smtp.invalid:25" ;;
        QR_SIGNING_KEYS) echo "QR_SIGNING_KEYS=ci-prod-1:$(hex)" ;;
        FCM_PROJECT_ID) echo "FCM_PROJECT_ID=kapdh-ci" ;;
        KAPDH_REGISTRY) echo "KAPDH_REGISTRY=kapdh-ci" ;;
        KAPDH_IMAGE_TAG) echo "KAPDH_IMAGE_TAG=ci" ;;
        *) echo "$key=$(hex)" ;;
      esac
      ;;
    FCM_SERVICE_ACCOUNT_JSON=*)
      echo "FCM_SERVICE_ACCOUNT_JSON='{\"client_email\":\"ci@kapdh-ci.iam.gserviceaccount.com\",\"private_key\":\"bukan-kunci-nyata\"}'"
      ;;
    RELEASE_GATE=*) echo "RELEASE_GATE=report" ;;
    KAPDH_FILES_DIR=*) echo "KAPDH_FILES_DIR=$work/files" ;;
    *) echo "$line" ;;
  esac
done <infra/.env.production.example >"$env_file"
# Direktori berkas host (bind): di VPS milik uid 1000 mode 750; di runner CI cukup dapat ditulis uid 1000.
mkdir -p "$work/files"
chmod 0777 "$work/files"
if grep -v '^#' "$env_file" | grep -q "ganti-dengan"; then die "placeholder tersisa di env uji"; fi

step "docker compose config (production dan overlay staging)"
compose config -q
docker compose --env-file "$env_file" -f infra/compose.production.yml -f infra/compose.staging.yml config -q
ACME_EMAIL=ci@kapdh.or.id docker compose -f infra/compose.proxy.yml config -q

docker network create kapdh-edge >/dev/null 2>&1 || true

step "job rilis (mode laporan: database baru belum disahkan)"
compose --profile release run --rm release >"$work/release.out" 2>&1 || {
  cat "$work/release.out"
  die "job rilis gagal"
}
cat "$work/release.out"
grep -q "7/7 gerbang go-live" "$work/release.out" || die "job rilis tidak mencapai gerbang"
grep -q "gerbang menolak, tetapi mode laporan" "$work/release.out" || die "gerbang seharusnya menolak database baru"

step "job rilis kedua idempoten (tidak ada migrasi baru)"
compose --profile release run --rm release >"$work/release2.out" 2>&1 || {
  cat "$work/release2.out"
  die "job rilis kedua gagal"
}
grep -q "Diterapkan: 0" "$work/release2.out" || die "job rilis kedua seharusnya tidak menerapkan migrasi"

step "gerbang go-live mode enforce menolak (PRD 9.2)"
set +e
compose --profile release run --rm -e RELEASE_GATE=enforce release >"$work/gate.out" 2>&1
gate_code=$?
set -e
[ "$gate_code" -eq 1 ] || {
  cat "$work/gate.out"
  die "gerbang enforce seharusnya keluar 1, ditemukan $gate_code"
}
grep -q "Super Admin aktif ber-TOTP: 0 dari minimal 2" "$work/gate.out" || die "alasan penolakan Super Admin tidak tercetak"

step "stack naik dan sehat"
compose up -d
deadline=$(($(date +%s) + 240))
for service in postgres redis api worker web admin; do
  while :; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}tanpa-healthcheck{{end}}' \
      "kapdh-production-$service-1" 2>/dev/null || echo "tidak-ada")"
    [ "$state" = "healthy" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || {
      compose logs --no-color "$service" | tail -n 80
      die "$service tidak sehat ($state)"
    }
    sleep 3
  done
  echo "sehat  $service"
done

in_edge() {
  docker run --rm --network kapdh-edge --entrypoint sh -v "$PWD/infra/scripts:/s:ro" "$CURL_IMAGE" -c "$1"
}

step "kesiapan API (DB, Redis, storage) dari jaringan edge"
in_edge 'curl -fsS http://kapdh-production-api-1:3000/api/v1/health/ready' | tee "$work/ready.json"
grep -q '"status":"ok"' "$work/ready.json" || die "API belum siap"

step "uji asap header web dan admin"
in_edge 'sh /s/smoke-static.sh web http://kapdh-production-web-1:8080'
in_edge 'sh /s/smoke-static.sh admin http://kapdh-production-admin-1:8080'

step "nginx -t di kontainer berjalan (non-root)"
docker exec kapdh-production-web-1 nginx -t
docker exec kapdh-production-admin-1 nginx -t

step "PostgreSQL dan Redis tidak terjangkau dari jaringan edge maupun host (N-07)"
if in_edge 'curl -s --connect-timeout 3 telnet://kapdh-production-postgres-1:5432 </dev/null' >/dev/null 2>&1; then
  die "PostgreSQL terjangkau dari jaringan edge"
fi
if in_edge 'curl -s --connect-timeout 3 telnet://kapdh-production-redis-1:6379 </dev/null' >/dev/null 2>&1; then
  die "Redis terjangkau dari jaringan edge"
fi
if compose port postgres 5432 >/dev/null 2>&1 || compose port redis 6379 >/dev/null 2>&1; then
  die "PostgreSQL/Redis mempublikasikan port ke host"
fi
echo "lulus  DB/Redis privat"

step "selesai: stack Compose cadangan lulus uji asap"
