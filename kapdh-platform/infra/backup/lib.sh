# shellcheck shell=sh
# Pustaka bersama skrip backup, restore dan verifikasi KAPDH (POSIX sh; PRD 5.5, N-06, D9).
# Disertakan dengan `. "$KAPDH_BACKUP_DIR/lib.sh"`; tidak dijalankan langsung.
#
# Aturan untuk semua skrip:
#   * `set -eu`, tanpa bashism, tanpa `set -x` (secret dapat ikut tercetak).
#   * Tidak pernah mencetak secret, URL koneksi bersandi, atau data pribadi; log hanya langkah, angka dan id.
#   * Nilai yang masuk manifest JSON hanya dari himpunan karakter aman (json_safe), selain JSON statistik yang
#     dibangkitkan PostgreSQL sendiri.

KAPDH_SCRIPT=${KAPDH_SCRIPT:-kapdh-backup}

# Log ke stderr; bila KAPDH_LOG_FILE diisi (restore/verifikasi: bukti drill) juga ditambahkan ke berkas itu.
log() {
  _line="$(date -u +%Y-%m-%dT%H:%M:%SZ) [$KAPDH_SCRIPT] $*"
  printf '%s\n' "$_line" >&2
  if [ -n "${KAPDH_LOG_FILE:-}" ]; then printf '%s\n' "$_line" >>"$KAPDH_LOG_FILE"; fi
  return 0
}

die() {
  log "GAGAL: $*"
  exit 1
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

now_epoch() {
  date -u +%s
}

require_cmd() {
  for _cmd in "$@"; do
    command -v "$_cmd" >/dev/null 2>&1 || die "perintah '$_cmd' tidak ditemukan di PATH"
  done
}

# Wajib terisi (nama variabel); tidak pernah mencetak nilainya.
require_var() {
  for _name in "$@"; do
    eval "_value=\${$_name:-}"
    [ -n "$_value" ] || die "variabel $_name wajib diisi (lihat infra/backup/backup.env.example)"
  done
}

# Memuat berkas konfigurasi KEY=VALUE bila ada (dipakai cron; systemd memakai EnvironmentFile). Berkas yang dapat
# ditulis grup/lainnya ditolak karena isinya dieksekusi shell; berkas secret yang dapat dibaca lainnya ditolak.
load_env_file() {
  _file=$1
  _kind=${2:-config}
  [ -f "$_file" ] || return 0
  if [ -n "$(find "$_file" -prune -perm -022 2>/dev/null)" ]; then
    die "berkas $_file dapat ditulis grup/lainnya; perbaiki dengan chmod 600/640"
  fi
  if [ "$_kind" = "secret" ] && [ -n "$(find "$_file" -prune -perm -004 2>/dev/null)" ]; then
    die "berkas secret $_file dapat dibaca semua pengguna; perbaiki dengan chmod 600"
  fi
  # set -a: semua variabel di berkas diekspor sehingga terlihat restic, rclone dan klien PostgreSQL.
  set -a
  # shellcheck disable=SC1090
  . "$_file"
  set +a
}

# Konfigurasi: variabel lingkungan (systemd EnvironmentFile) atau berkas KEY=VALUE (cron). Restore memakai berkas
# terpisah di host restore (KAPDH_BACKUP_ENV=/etc/kapdh/restore.env).
load_config() {
  load_env_file "${KAPDH_BACKUP_ENV:-/etc/kapdh/backup.env}" config
  load_env_file "${KAPDH_BACKUP_SECRETS:-/etc/kapdh/backup.secrets.env}" secret
}

# Menjalankan biner klien PostgreSQL (psql, pg_dump, pg_restore) langsung atau lewat PG_EXEC, misalnya
# PG_EXEC="docker exec -i -e PGUSER -e PGPASSWORD -e PGDATABASE <kontainer-postgres>" agar versi klien sama dengan
# server (PostgreSQL 17). Koneksi memakai variabel libpq standar (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSFILE).
pg() {
  if [ -n "${PG_EXEC:-}" ]; then
    # shellcheck disable=SC2086 # PG_EXEC sengaja dipecah menjadi argumen
    $PG_EXEC "$@"
  else
    "$@"
  fi
}

# psql non-interaktif: tanpa psqlrc, tanpa header, berhenti pada galat pertama.
psql_q() {
  pg psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"
}

# Nilai aman untuk manifest JSON (id, hash, waktu ISO, referensi image, host); kosong menjadi null.
json_safe() {
  case $1 in
    '') printf 'null' ;;
    *[!A-Za-z0-9._:@/+=-]*) die "nilai '$2' memuat karakter yang tidak diizinkan untuk manifest" ;;
    *) printf '"%s"' "$1" ;;
  esac
}

json_int() {
  case $1 in
    '' | *[!0-9]*) die "nilai '$2' bukan bilangan bulat" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Membaca nilai string/angka sederhana dari manifest yang ditulis backup.sh (satu kunci per baris). Hanya karakter aman
# yang dikembalikan; manifest tidak pernah di-source sebagai kode.
manifest_get() {
  # Pembatas `#` karena kelas karakter memuat `/` (portabel untuk sed non-GNU).
  sed -n "s#^[[:space:]]*\"$2\": \"\{0,1\}\([A-Za-z0-9._:@/+=-]*\)\"\{0,1\},\{0,1\}\$#\1#p" "$1" | head -n 1
}

# Objek JSON satu baris dari manifest (mis. statistik database).
manifest_get_object() {
  sed -n "s/^[[:space:]]*\"$2\": \({.*}\),\{0,1\}\$/\1/p" "$1" | head -n 1
}

sha256_of() {
  sha256sum "$1" | cut -d ' ' -f 1
}

bytes_of() {
  wc -c <"$1" | tr -d ' '
}

# Heartbeat ke pemantau di luar VPS: status up/down, pesan singkat, durasi (detik). Kegagalan push hanya dicatat agar
# monitor "tidak ada heartbeat" yang memicu alert (docs/runbooks/monitoring.md). Dua gaya URL:
# - Uptime Kuma (monitor Push, URL memuat `/api/push/`): status lewat query. URL salinan Kuma berbentuk
#   `.../api/push/<token>?status=up&msg=OK&ping=`; query bawaan itu dibuang lebih dahulu. Bila tidak, `status` terkirim
#   dua kali, Kuma membacanya sebagai larik dan SETIAP heartbeat tercatat DOWN.
# - Layanan ping (Healthchecks.io `https://hc-ping.com/<uuid>`, heartbeat Better Stack, dll.): sukses = permintaan ke
#   URL, gagal = URL + `/fail`; pesan dikirim sebagai badan (log check). Query `status=down` tidak dikenal layanan ini dan
#   akan tercatat SUKSES, jadi gaya ini wajib dibedakan.
kuma_push() {
  _url=${1%%\?*}
  _status=$2
  _msg=$3
  _ping=${4:-}
  [ -n "$_url" ] || return 0
  command -v curl >/dev/null 2>&1 || {
    log "curl tidak ada; heartbeat pemantau dilewati"
    return 0
  }
  case $_url in
    */api/push/*)
      curl -fsS -o /dev/null -m 15 --retry 2 --get \
        --data-urlencode "status=$_status" \
        --data-urlencode "msg=$_msg" \
        --data-urlencode "ping=$_ping" \
        "$_url" || log "heartbeat Uptime Kuma gagal dikirim (status=$_status)"
      ;;
    *)
      _url=${_url%/}
      [ "$_status" = up ] || _url="$_url/fail"
      curl -fsS -o /dev/null -m 15 --retry 2 --data-raw "$_msg" "$_url" ||
        log "heartbeat layanan ping gagal dikirim (status=$_status)"
      ;;
  esac
}

# Lock sederhana berbasis mkdir (atomik, POSIX). Lock basi (PID tidak hidup) dibersihkan.
acquire_lock() {
  _lock=$1
  if mkdir "$_lock" 2>/dev/null; then
    echo $$ >"$_lock/pid"
    return 0
  fi
  _pid=$(cat "$_lock/pid" 2>/dev/null || true)
  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
    die "proses lain (PID $_pid) masih berjalan; lock $_lock"
  fi
  log "lock basi dari PID ${_pid:-?} dibersihkan"
  rm -rf "$_lock"
  mkdir "$_lock" || die "tidak dapat membuat lock $_lock"
  echo $$ >"$_lock/pid"
}

release_lock() {
  [ -n "${1:-}" ] && rm -rf "$1"
  return 0
}

# Id snapshot restic dari keluaran `restic backup --json` (baris ringkasan).
restic_summary_field() {
  sed -n "s/.*\"message_type\":\"summary\".*\"$2\":\"\{0,1\}\([0-9a-f.]*\)\"\{0,1\}[,}].*/\1/p" "$1" | tail -n 1
}

# Id snapshot dari keluaran `restic snapshots --json` (larik), satu per baris; tanpa jq.
restic_ids() {
  tr ',' '\n' <"$1" | sed -n 's/^[[:space:]{[]*"id":"\([0-9a-f]\{64\}\)".*/\1/p'
}

restic_first_id() {
  restic_ids "$1" | head -n 1
}

# Pasangan `<id-snapshot> <backup_id>` dari keluaran `restic snapshots --json` (tanpa jq). backup_id adalah tag
# kapdh-<env>-<yyyymmdd>T<hhmmss>Z yang diberikan backup.sh ke snapshot berkas DAN snapshot dump satu run; snapshot
# tanpa tag itu menghasilkan `<id> ` (backup_id kosong). Urutan kunci JSON restic: time ... tags ... id.
restic_backup_pairs() {
  tr ',' '\n' <"$1" | sed -n \
    -e 's/^[[:space:]{[]*"time":.*/T/p' \
    -e 's/^.*"\(kapdh-[a-z0-9-]*-[0-9]\{8\}T[0-9]\{6\}Z\)".*$/B \1/p' \
    -e 's/^[[:space:]{[]*"id":"\([0-9a-f]\{64\}\)".*/I \1/p' |
    {
      _bid=''
      while read -r _kind _value; do
        case $_kind in
          T) _bid='' ;;
          B) _bid=$_value ;;
          I) printf '%s %s\n' "$_value" "$_bid" ;;
        esac
      done
    }
}

restic_first_time() {
  tr ',' '\n' <"$1" | sed -n 's/^[[:space:]{[]*"time":"\([0-9T:.+Z-]*\)".*/\1/p' | head -n 1
}
