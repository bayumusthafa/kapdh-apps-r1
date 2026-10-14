#!/bin/sh
# Menjalankan job rilis (image kapdh-release) di VPS untuk lingkungan yang dikelola Coolify, SEBELUM resource API dan
# worker di-redeploy dengan tag yang sama (PRD 5.5: migrasi oleh job deployment tunggal, bukan startup replica).
# Untuk Compose cadangan gunakan `docker compose ... --profile release run --rm release` (compose-cadangan.md).
#
#   sudo sh infra/scripts/run-release.sh production ghcr.io/<org>/kapdh-release:v1.0.0
#   sudo sh infra/scripts/run-release.sh staging    ghcr.io/<org>/kapdh-release:sha-abc1234
#
# Berkas env job (root:root 600, tidak pernah di repo): /etc/kapdh/<lingkungan>/release.env berisi ADMIN_DATABASE_URL,
# MIGRATOR_DATABASE_URL, KAPDH_*_DB_PASSWORD (opsional) dan RELEASE_GATE (opsional). Host database di URL adalah nama
# kontainer/alias PostgreSQL Coolify pada jaringan KAPDH_DOCKER_NETWORK (bawaan `coolify`).
set -eu

env_name="${1:-}"
image="${2:-}"
case "$env_name" in
  production | staging) ;;
  *)
    echo "Pakai: run-release.sh production|staging <image kapdh-release dengan tag/digest>" >&2
    exit 2
    ;;
esac
[ -n "$image" ] || { echo "Image kapdh-release wajib diisi." >&2; exit 2; }
case "$image" in
  *:latest | *:latest@*) echo "Tag latest ditolak: gunakan tag rilis atau digest (PRD 5.5)." >&2; exit 2 ;;
esac

env_file="${KAPDH_RELEASE_ENV_FILE:-/etc/kapdh/$env_name/release.env}"
network="${KAPDH_DOCKER_NETWORK:-coolify}"
[ -r "$env_file" ] || { echo "Berkas env $env_file tidak dapat dibaca." >&2; exit 2; }

# Berkas env berisi secret: wajib hanya dapat dibaca pemiliknya.
perm="$(stat -c '%a' "$env_file" 2>/dev/null || echo "?")"
case "$perm" in
  600 | 400) ;;
  *) echo "Izin $env_file = $perm; wajib 600 atau 400 (chmod 600)." >&2; exit 2 ;;
esac

# RELEASE_GATE dari pemanggil (mis. `RELEASE_GATE=enforce sh run-release.sh production ...` saat gerbang go-live)
# menimpa nilai di berkas env.
gate_arg=""
if [ -n "${RELEASE_GATE:-}" ]; then
  case "$RELEASE_GATE" in
    enforce | report) gate_arg="RELEASE_GATE=$RELEASE_GATE" ;;
    *) echo "RELEASE_GATE harus enforce atau report." >&2; exit 2 ;;
  esac
fi

echo "[run-release] $env_name: $image pada jaringan $network${gate_arg:+ ($gate_arg)}"
docker pull "$image"
# --rm: job sekali jalan; --env-file: secret tidak muncul di argumen proses atau riwayat shell.
if [ -n "$gate_arg" ]; then
  docker run --rm --network "$network" --env-file "$env_file" -e "KAPDH_ENV=$env_name" -e "$gate_arg" \
    --security-opt no-new-privileges:true --cap-drop ALL --memory 512m \
    --name "kapdh-release-$env_name" "$image"
else
  docker run --rm --network "$network" --env-file "$env_file" -e "KAPDH_ENV=$env_name" \
    --security-opt no-new-privileges:true --cap-drop ALL --memory 512m \
    --name "kapdh-release-$env_name" "$image"
fi
echo "[run-release] selesai. Lanjutkan redeploy resource API dan worker di Coolify dengan tag yang sama."
