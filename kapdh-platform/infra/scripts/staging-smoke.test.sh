#!/bin/sh
# Uji kering infra/scripts/staging-smoke.sh tanpa jaringan: curl, openssl dan nc diganti shim, sehingga penilaian port
# dengan dua pembanding teruji (go-live.md 2.4): jaringan normal, port aplikasi yang bocor, jaringan yang menerima semua
# port, 443 yang tidak terjangkau (host/nc/jaringan pemeriksa bermasalah), nc tidak ada, mode ketat
# KAPDH_REQUIRE_PORTS, port kontrol khusus, dan nilai yang tidak sah. Dijalankan CI (ubuntu: /bin/sh = dash) dan dapat
# dijalankan lokal:
#   sh infra/scripts/staging-smoke.test.sh
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
smoke="$here/staging-smoke.sh"
shell="$(command -v sh)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$work/bin" "$work/bin-tanpa-nc"

# curl: jawaban sehat untuk semua pemeriksaan HTTP/WSS; WSS hanya 101 untuk Origin admin.
cat >"$work/bin/curl" <<'EOF'
#!/bin/sh
out=/dev/null
hdr=""
url=""
origin=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) out="$arg" ;;
    -D) hdr="$arg" ;;
    -H) case "$arg" in Origin:*) origin="${arg#Origin: }" ;; esac ;;
  esac
  case "$arg" in http://* | https://*) url="$arg" ;; esac
  prev="$arg"
done
code=200
body="ok"
headers="Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff"
case "$url" in
  *socket.io*)
    if [ "$origin" = "https://$SHIM_ADMIN" ]; then code=101; else code=403; fi
    ;;
  http://*)
    code=301
    headers="Location: https://${url#http://}"
    ;;
  */health/ready) body='{"status":"ok","checks":{}}' ;;
esac
if [ -n "$hdr" ]; then printf 'HTTP/1.1 %s\n%s\n' "$code" "$headers" >"$hdr"; fi
printf '%s' "$body" >"$out"
printf '%s' "$code"
EOF

# openssl: TLS 1.2 diterima, TLS 1.0/1.1 ditolak; rand menghasilkan kunci WebSocket tetap.
cat >"$work/bin/openssl" <<'EOF'
#!/bin/sh
if [ "$1" = "rand" ]; then
  echo "dGhlIHNhbXBsZSBub25jZQ=="
  exit 0
fi
for arg in "$@"; do
  case "$arg" in -tls1 | -tls1_1) exit 1 ;; esac
done
exit 0
EOF

# nc -z: port yang "terbuka" diatur SHIM_NC_OPEN (daftar dipisah spasi, atau "all"); setiap pemanggilan dicatat utuh
# (opsi, host, port) agar pembanding dan port aplikasi terbukti memakai host dan opsi yang sama.
cat >"$work/bin/nc" <<'EOF'
#!/bin/sh
port=""
for arg in "$@"; do port="$arg"; done
echo "nc $*" >>"$SHIM_LOG"
case " ${SHIM_NC_OPEN:-} " in
  *" all "* | *" $port "*) exit 0 ;;
esac
exit 1
EOF
chmod +x "$work/bin/curl" "$work/bin/openssl" "$work/bin/nc"

# PATH tanpa nc: shim curl/openssl ditambah pembungkus ke alat yang dipakai skrip (bukan symlink, agar jalan juga di
# Git Bash), sehingga `command -v nc` gagal walau runner punya nc.
cp "$work/bin/curl" "$work/bin/openssl" "$work/bin-tanpa-nc/"
for tool in mktemp rm grep head cut sed cat; do
  printf '#!/bin/sh\nexec %s "$@"\n' "$(command -v "$tool")" >"$work/bin-tanpa-nc/$tool"
  chmod +x "$work/bin-tanpa-nc/$tool"
done

passed=0
failed=0
ok() {
  passed=$((passed + 1))
  echo "lulus  $1"
}
ko() {
  failed=$((failed + 1))
  echo "GAGAL  $1"
  sed 's/^/       | /' "$work/out"
}

# run <nama> <port terbuka> [VAR=nilai...]: menjalankan staging-smoke.sh dengan shim dan environment bersih (env -i,
# seperti release-job.test.sh), sehingga variabel KAPDH_* milik pemanggil tidak ikut; kode keluar ke $work/code.
# RUN_PATH (bawaan $work/bin:$PATH) dapat diganti untuk skenario tanpa nc.
run() {
  name="$1"
  open="$2"
  shift 2
  : >"$work/log"
  set +e
  env -i PATH="${RUN_PATH:-$work/bin:$PATH}" SHIM_LOG="$work/log" SHIM_NC_OPEN="$open" SHIM_ADMIN=admin.uji.invalid \
    KAPDH_WEB=web.uji.invalid KAPDH_ADMIN=admin.uji.invalid KAPDH_API=api.uji.invalid KAPDH_VPS_HOST=192.0.2.10 \
    "$@" "$shell" "$smoke" >"$work/out" 2>&1
  echo "$?" >"$work/code"
  set -e
  echo "== $name (keluar $(cat "$work/code"))"
}
expect_code() {
  if [ "$(cat "$work/code")" = "$1" ]; then ok "kode keluar $1"; else ko "kode keluar $(cat "$work/code"), harus $1"; fi
}
expect_out() {
  if grep -qF -- "$1" "$work/out"; then ok "keluaran memuat '$1'"; else ko "keluaran tidak memuat '$1'"; fi
}
expect_no_out() {
  if grep -qF -- "$1" "$work/out"; then ko "keluaran memuat '$1'"; else ok "keluaran tanpa '$1'"; fi
}
expect_log() {
  got="$(tr '\n' '|' <"$work/log")"
  if [ "$got" = "$1" ]; then ok "pemanggilan nc: $1"; else ko "pemanggilan nc '$got', harus '$1'"; fi
}

h="nc -z -w 3 192.0.2.10"
pembanding="$h 443|$h 9999|"
semua_port="$pembanding$h 5432|$h 6379|$h 3000|$h 3001|$h 8080|$h 8000|$h 6001|$h 6002|"

run "jaringan normal: 443 terjangkau, port kontrol dan semua port tertutup" "443"
expect_code 0
expect_out "lulus  pembanding port: 192.0.2.10:443 terjangkau, port kontrol 9999 tidak (port dinilai dari jaringan ini)"
expect_out "lulus  port 5432 tertutup di 192.0.2.10"
expect_out "lulus  port 6002 tertutup di 192.0.2.10"
expect_no_out "GAGAL"
expect_no_out "PERINGATAN"
expect_out "Uji asap lingkungan lulus. Lanjutkan"
expect_log "$semua_port"

run "port aplikasi bocor: 5432 dan 8080 terbuka" "443 5432 8080"
expect_code 1
expect_out "GAGAL  port 5432 TERBUKA di 192.0.2.10 (harus tertutup firewall)"
expect_out "GAGAL  port 8080 TERBUKA di 192.0.2.10 (harus tertutup firewall)"
expect_out "lulus  port 6379 tertutup di 192.0.2.10"
expect_out "2 pemeriksaan gagal."
expect_log "$semua_port"

run "jaringan menerima semua port: port tidak dinilai" "all"
expect_code 0
expect_out "PERINGATAN: port kontrol 9999 (tidak dipakai) ikut tersambung di 192.0.2.10"
expect_out "docs/runbooks/go-live.md 2.4"
expect_no_out "GAGAL"
expect_no_out "TERBUKA"
expect_no_out "tertutup di 192.0.2.10"
expect_out "kecuali port yang belum terbukti"
expect_log "$pembanding"

run "443 tidak terjangkau (host salah, nc tanpa -z, egress diblokir): port tidak dinilai" ""
expect_code 0
expect_out "PERINGATAN: nc tidak dapat menjangkau 192.0.2.10:443"
expect_no_out "tertutup di 192.0.2.10"
expect_no_out "pembanding port"
expect_out "kecuali port yang belum terbukti"
expect_log "$h 443|"

run "mode ketat, port belum terbukti" "all" KAPDH_REQUIRE_PORTS=true
expect_code 3
expect_out "TIDAK LENGKAP: port belum terbukti"
expect_no_out "Uji asap lingkungan lulus"

run "mode ketat, port terbukti" "443" KAPDH_REQUIRE_PORTS=true
expect_code 0
expect_out "Uji asap lingkungan lulus. Lanjutkan"

RUN_PATH="$work/bin-tanpa-nc"
run "nc tidak ada" ""
RUN_PATH=""
expect_code 0
expect_out "PERINGATAN: nc tidak ada"
expect_no_out "tertutup di 192.0.2.10"
expect_out "kecuali port yang belum terbukti"
expect_log ""

run "port kontrol khusus" "443" KAPDH_PORT_CONTROL=7777
expect_code 0
expect_out "port kontrol 7777 tidak (port dinilai dari jaringan ini)"
expect_log "$h 443|$h 7777|$h 5432|$h 6379|$h 3000|$h 3001|$h 8080|$h 8000|$h 6001|$h 6002|"

for nilai in abc 0 70000 123456 5432 443 0443; do
  run "port kontrol tidak sah: $nilai" "443" KAPDH_PORT_CONTROL="$nilai"
  expect_code 2
  expect_out "KAPDH_PORT_CONTROL"
  expect_log ""
done

run "KAPDH_REQUIRE_PORTS tidak sah" "443" KAPDH_REQUIRE_PORTS=ya
expect_code 2
expect_out "KAPDH_REQUIRE_PORTS harus true atau false"
expect_log ""

echo "$passed lulus, $failed gagal"
[ "$failed" -eq 0 ]
