#!/bin/sh
# Uji asap lingkungan yang sudah dideploy, dijalankan DARI LUAR VPS (laptop operator/CI), bukan di dalam jaringan
# Docker (N-07, PRD 5.1, 5.3; temuan audit D2-07): HTTPS dan pengalihan HTTP, TLS >= 1.2, header keamanan web/admin,
# kesiapan API, upgrade WebSocket Socket.IO (WSS) dan port PostgreSQL/Redis/aplikasi TERTUTUP dari internet.
# Butuh curl dan openssl; nc opsional (pemeriksaan port dilewati dengan peringatan bila tidak ada).
#
#   KAPDH_WEB=staging.kapdh.or.id KAPDH_ADMIN=staging-admin.kapdh.or.id KAPDH_API=staging-api.kapdh.or.id \
#     KAPDH_VPS_HOST=<ip publik VPS> sh infra/scripts/staging-smoke.sh
#
# KAPDH_EXPECT_HSTS=true mewajibkan header HSTS 1 tahun + includeSubDomains di ketiga domain (setelah HSTS diaktifkan,
# runbook rilis bagian 7); bawaan false hanya mencetak keadaannya.
#
# Nilai TLS (grade) diperiksa terpisah lewat SSL Labs (https://www.ssllabs.com/ssltest/) untuk ketiga domain.
set -eu

web="${KAPDH_WEB:?KAPDH_WEB wajib (mis. staging.kapdh.or.id)}"
admin="${KAPDH_ADMIN:?KAPDH_ADMIN wajib}"
api="${KAPDH_API:?KAPDH_API wajib}"
vps="${KAPDH_VPS_HOST:-$api}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM
failures=0

pass() { echo "lulus  $1"; }
bad() {
  echo "GAGAL  $1"
  failures=$((failures + 1))
}

status() {
  # status <url> [opsi curl...]: kode HTTP, header ke $work/h, isi ke $work/b.
  url="$1"
  shift
  curl -sS -o "$work/b" -D "$work/h" -w '%{http_code}' --max-time 15 "$@" "$url" || echo "000"
}

header() {
  grep -i "^$1:" "$work/h" | head -n 1 | cut -d: -f2- | sed 's/^ *//; s/\r$//'
}

for host in "$web" "$admin" "$api"; do
  # HTTPS dengan sertifikat yang dipercaya (curl memverifikasi rantai dan nama host).
  path="/"
  [ "$host" = "$api" ] && path="/api/v1/health"
  code="$(status "https://$host$path")"
  if [ "$code" = "200" ]; then pass "$host HTTPS $path 200"; else bad "$host HTTPS $path → $code"; fi

  code="$(status "http://$host$path")"
  location="$(header Location)"
  case "$code:$location" in
    301:https://* | 308:https://*) pass "$host HTTP dialihkan permanen ke HTTPS" ;;
    *) bad "$host HTTP → $code $location (harus 301/308 ke https)" ;;
  esac

  if echo | openssl s_client -connect "$host:443" -servername "$host" -tls1_2 >/dev/null 2>&1; then
    pass "$host TLS 1.2 diterima"
  else
    bad "$host TLS 1.2 ditolak"
  fi
  for old in tls1 tls1_1; do
    if echo | openssl s_client -connect "$host:443" -servername "$host" "-$old" >/dev/null 2>&1; then
      bad "$host masih menerima $old (minimal TLS 1.2, N-07)"
    else
      pass "$host menolak $old"
    fi
  done
done

for host in "$web" "$admin"; do
  status "https://$host/" >/dev/null
  csp="$(header Content-Security-Policy)"
  case "$csp" in *"frame-ancestors 'none'"*) pass "$host CSP frame-ancestors 'none'" ;; *) bad "$host CSP: '$csp'" ;; esac
  if [ "$(header X-Frame-Options)" = "DENY" ]; then pass "$host X-Frame-Options DENY"; else bad "$host X-Frame-Options"; fi
  if [ "$(header Referrer-Policy)" = "no-referrer" ]; then pass "$host Referrer-Policy"; else bad "$host Referrer-Policy"; fi
done

# HSTS (N-07): hanya diwajibkan setelah diaktifkan untuk SELURUH subdomain (runbook rilis bagian 7). Web dan admin
# memperoleh header dari middleware proxy (Coolify/Traefik), API dari helmet (HSTS_ENABLED=true).
expect_hsts="${KAPDH_EXPECT_HSTS:-false}"
for host in "$web" "$admin" "$api"; do
  path="/"
  [ "$host" = "$api" ] && path="/api/v1/health"
  status "https://$host$path" >/dev/null
  hsts="$(header Strict-Transport-Security)"
  if [ "$expect_hsts" = "true" ]; then
    case "$hsts" in
      *max-age=31536000*includeSubDomains* | *max-age=31536000*includesubdomains*) pass "$host HSTS: $hsts" ;;
      *) bad "$host HSTS '$hsts' (harus max-age=31536000; includeSubDomains)" ;;
    esac
  else
    echo "info   $host HSTS belum diwajibkan (KAPDH_EXPECT_HSTS=false): '${hsts:-tidak ada}'"
  fi
done

code="$(status "https://$api/api/v1/health/ready")"
if [ "$code" = "200" ] && grep -q '"status":"ok"' "$work/b"; then
  pass "API /health/ready ok (DB, Redis, storage)"
else
  bad "API /health/ready → $code $(cat "$work/b" 2>/dev/null | head -c 300)"
fi
if [ "$(header X-Content-Type-Options)" = "nosniff" ]; then pass "API nosniff (helmet)"; else bad "API nosniff"; fi

# WSS: handshake upgrade Socket.IO (ARCHITECTURE §4.9; transport websocket saja, Origin web admin diizinkan).
key="$(openssl rand -base64 16)"
code="$(curl -sS -o /dev/null -w '%{http_code}' --http1.1 --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $key" -H "Origin: https://$admin" \
  "https://$api/socket.io/?EIO=4&transport=websocket" || true)"
if [ "$code" = "101" ]; then pass "WSS /socket.io/ upgrade 101"; else bad "WSS /socket.io/ upgrade → $code (harus 101)"; fi
code="$(curl -sS -o /dev/null -w '%{http_code}' --http1.1 --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $key" -H "Origin: https://evil.example" \
  "https://$api/socket.io/?EIO=4&transport=websocket" || true)"
if [ "$code" != "101" ]; then pass "WSS menolak Origin asing ($code)"; else bad "WSS menerima Origin asing"; fi

# Port privat tertutup dari internet (PRD 5.3: hanya 80/443; SSH dibatasi IP/VPN).
if command -v nc >/dev/null 2>&1; then
  for port in 5432 6379 3000 3001 8080 8000 6001 6002; do
    if nc -z -w 3 "$vps" "$port" >/dev/null 2>&1; then
      bad "port $port TERBUKA di $vps (harus tertutup firewall)"
    else
      pass "port $port tertutup di $vps"
    fi
  done
else
  echo "PERINGATAN: nc tidak ada; periksa manual bahwa 5432, 6379, 3000, 3001, 8080, 8000, 6001, 6002 tertutup."
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures pemeriksaan gagal."
  exit 1
fi
echo "Uji asap lingkungan lulus. Lanjutkan dengan SSL Labs untuk grade TLS."
