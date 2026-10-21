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
# Port dinilai dengan dua pembanding. 443 (Traefik) harus terjangkau: bila tidak, host, nc atau jaringan operator yang
# bermasalah, dan "tertutup" tidak bermakna. Port kontrol yang tidak dipakai di VPS (KAPDH_PORT_CONTROL, bawaan 9999)
# harus tidak terjangkau: VPN berbasis TUN atau perangkat jaringan di jalur dapat menerima koneksi ke port apa pun, dan
# bila port kontrol ikut tersambung, hasil `nc -z` bukan bukti. Bila salah satu pembanding tidak terpenuhi, port tidak
# dinilai (PERINGATAN) dan dibuktikan dengan prosedur docs/runbooks/go-live.md 2.4. "Tertutup" berarti tidak terjangkau
# dari jaringan pemeriksa. KAPDH_REQUIRE_PORTS=true (untuk bukti) membuat port yang belum terbukti keluar 3.
#
# Nilai TLS (grade) diperiksa terpisah lewat SSL Labs (https://www.ssllabs.com/ssltest/) untuk ketiga domain.
set -eu

web="${KAPDH_WEB:?KAPDH_WEB wajib (mis. staging.kapdh.or.id)}"
admin="${KAPDH_ADMIN:?KAPDH_ADMIN wajib}"
api="${KAPDH_API:?KAPDH_API wajib}"
vps="${KAPDH_VPS_HOST:-$api}"
# Port privat yang wajib tertutup dari internet; 22 tidak diperiksa (dibatasi IP/VPN, runbook staging 2.4).
ports="5432 6379 3000 3001 8080 8000 6001 6002"
control="${KAPDH_PORT_CONTROL:-9999}"
case "$control" in
  *[!0-9]* | ??????*)
    echo "KAPDH_PORT_CONTROL harus nomor port 1-65535, bukan '$control'" >&2
    exit 2
    ;;
esac
# Nol di depan dibuang (0443 = 443) agar perbandingan daftar port di bawah tidak terkecoh.
while :; do
  case "$control" in
    0?*) control="${control#0}" ;;
    *) break ;;
  esac
done
if [ "$control" -lt 1 ] || [ "$control" -gt 65535 ]; then
  echo "KAPDH_PORT_CONTROL harus nomor port 1-65535, bukan '${KAPDH_PORT_CONTROL:-}'" >&2
  exit 2
fi
case " $ports 22 80 443 " in
  *" $control "*)
    echo "KAPDH_PORT_CONTROL $control dipakai atau diperiksa; pilih port yang tidak dipakai di VPS" >&2
    exit 2
    ;;
esac
require_ports="${KAPDH_REQUIRE_PORTS:-false}"
case "$require_ports" in
  true | false) ;;
  *)
    echo "KAPDH_REQUIRE_PORTS harus true atau false, bukan '$require_ports'" >&2
    exit 2
    ;;
esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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

# Port privat tertutup dari internet (PRD 5.3: hanya 80/443; SSH dibatasi IP/VPN). Pembanding diperiksa lebih dulu:
# 443 harus terjangkau (host, nc dan jaringan berfungsi) dan port kontrol harus tidak terjangkau (jaringan di jalur
# tidak menerima semua port). Selain itu, `nc -z` tidak dapat membedakan port terbuka dari tertutup.
ports_proven=false
prosedur="docs/runbooks/go-live.md 2.4 (nmap -sV dengan port kontrol dari jaringan lain, lalu ss, docker ps dan iptables -S DOCKER-USER di VPS)"
if ! command -v nc >/dev/null 2>&1; then
  echo "PERINGATAN: nc tidak ada; port $ports belum terbukti tertutup. Buktikan dengan prosedur $prosedur."
elif ! nc -z -w 3 "$vps" 443 >/dev/null 2>&1; then
  echo "PERINGATAN: nc tidak dapat menjangkau $vps:443 (host salah, nc tanpa -z, atau jaringan pemeriksa memblokir),"
  echo "           jadi port $ports tidak dinilai. Buktikan dengan prosedur $prosedur."
elif nc -z -w 3 "$vps" "$control" >/dev/null 2>&1; then
  echo "PERINGATAN: port kontrol $control (tidak dipakai) ikut tersambung di $vps: jaringan di jalur menerima semua"
  echo "           port, jadi hasil nc bukan bukti dan port $ports tidak dinilai. Buktikan dengan prosedur $prosedur."
else
  pass "pembanding port: $vps:443 terjangkau, port kontrol $control tidak (port dinilai dari jaringan ini)"
  ports_proven=true
  for port in $ports; do
    if nc -z -w 3 "$vps" "$port" >/dev/null 2>&1; then
      bad "port $port TERBUKA di $vps (harus tertutup firewall)"
    else
      pass "port $port tertutup di $vps"
    fi
  done
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures pemeriksaan gagal."
  exit 1
fi
if [ "$ports_proven" = "true" ]; then
  echo "Uji asap lingkungan lulus. Lanjutkan dengan SSL Labs untuk grade TLS."
elif [ "$require_ports" = "true" ]; then
  echo "Uji asap lingkungan TIDAK LENGKAP: port belum terbukti (lihat PERINGATAN) dan KAPDH_REQUIRE_PORTS=true."
  exit 3
else
  echo "Uji asap lingkungan lulus, kecuali port yang belum terbukti (lihat PERINGATAN). Lanjutkan dengan SSL Labs untuk grade TLS."
fi
