#!/bin/sh
# Uji asap kontainer nginx situs publik dan web admin (N-07; temuan audit D2-07/D3-07): header keamanan, cache,
# fallback SPA/KTA, metode yang ditolak. Dijalankan CI terhadap image yang baru dibangun, atau operator terhadap
# kontainer lokal. Butuh curl.
#
#   sh infra/scripts/smoke-static.sh web   http://127.0.0.1:18080
#   sh infra/scripts/smoke-static.sh admin http://127.0.0.1:18081
set -eu

kind="${1:-}"
base="${2:-}"
[ -n "$kind" ] && [ -n "$base" ] || { echo "Pakai: smoke-static.sh web|admin <url dasar>" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM
failures=0

# fetch <metode> <path>: header ke $work/h, isi ke $work/b, kode status ke stdout.
fetch() {
  curl -sS -o "$work/b" -D "$work/h" -X "$1" -w '%{http_code}' --max-time 10 "$base$2"
}

header() {
  # Nilai header (tanpa membedakan huruf besar) dari respons terakhir.
  grep -i "^$1:" "$work/h" | head -n 1 | cut -d: -f2- | sed 's/^ *//; s/\r$//'
}

expect() {
  if [ "$2" = "$3" ]; then
    echo "lulus  $1"
  else
    echo "GAGAL  $1: diharapkan '$3', ditemukan '$2'"
    failures=$((failures + 1))
  fi
}

expect_contains() {
  case "$2" in
    *"$3"*) echo "lulus  $1" ;;
    *)
      echo "GAGAL  $1: '$2' tidak memuat '$3'"
      failures=$((failures + 1))
      ;;
  esac
}

security_headers() {
  csp="$(header Content-Security-Policy)"
  expect_contains "$1 CSP frame-ancestors 'none'" "$csp" "frame-ancestors 'none'"
  expect_contains "$1 CSP script-src 'self'" "$csp" "script-src 'self'"
  case "$csp" in *unsafe-*) expect "$1 CSP tanpa unsafe-*" "ada" "tidak ada" ;; *) echo "lulus  $1 CSP tanpa unsafe-*" ;; esac
  expect "$1 X-Frame-Options" "$(header X-Frame-Options)" "DENY"
  expect "$1 Referrer-Policy" "$(header Referrer-Policy)" "no-referrer"
  expect "$1 X-Content-Type-Options" "$(header X-Content-Type-Options)" "nosniff"
  case "$(header Server)" in *[0-9]*) expect "$1 Server tanpa versi" "$(header Server)" "nginx" ;; *) echo "lulus  $1 Server tanpa versi" ;; esac
}

expect "healthz" "$(fetch GET /healthz)" "200"
expect "beranda" "$(fetch GET /)" "200"
security_headers "beranda"
expect "POST ditolak" "$(fetch POST /)" "405"
expect "berkas tersembunyi" "$(fetch GET /.env)" "404"

case "$kind" in
  web)
    fetch GET / >/dev/null
    expect "web Cache-Control beranda" "$(header Cache-Control)" "no-cache"
    asset="$(grep -o '/_astro/[A-Za-z0-9_.-]*\.css' "$work/b" | head -n 1 || true)"
    expect "KTA shell /kta/<nomor>" "$(fetch GET /kta/25.01.01.1)" "200"
    expect "KTA no-store" "$(header Cache-Control)" "no-store"
    expect "KTA noindex" "$(header X-Robots-Tag)" "noindex, nofollow"
    expect "halaman tidak ada" "$(fetch GET /tidak-ada-sama-sekali)" "404"
    expect "halaman tidak ada no-store" "$(header Cache-Control)" "no-store"
    # Rolling deploy: aset hash yang belum ada di kontainer ini → 404 yang TIDAK pernah disimpan immutable.
    expect "aset /_astro/ hilang 404" "$(fetch GET /_astro/tidak-ada.js)" "404"
    expect "aset /_astro/ hilang no-store" "$(header Cache-Control)" "no-store"
    if [ -n "$asset" ]; then
      expect "aset Astro" "$(fetch GET "$asset")" "200"
      expect "aset Astro immutable" "$(header Cache-Control)" "public, max-age=31536000, immutable"
    else
      expect "aset /_astro/*.css ditemukan di beranda" "tidak" "ya"
    fi
    ;;
  admin)
    fetch GET / >/dev/null
    expect "admin index no-store" "$(header Cache-Control)" "no-store"
    expect "admin noindex" "$(header X-Robots-Tag)" "noindex, nofollow"
    expect_contains "admin CSP img-src data:" "$(header Content-Security-Policy)" "img-src 'self' data: blob:"
    expect "rute SPA /members/<id>" "$(fetch GET /members/0192a000-0000-7000-8000-000000000102)" "200"
    expect "rute SPA no-store" "$(header Cache-Control)" "no-store"
    expect_contains "rute SPA berisi shell" "$(cat "$work/b")" '<div id="root"></div>'
    expect "rute /invite" "$(fetch GET /invite)" "200"
    expect "aset hilang 404 (bukan shell)" "$(fetch GET /assets/tidak-ada.js)" "404"
    # Rolling deploy Coolify: 404 aset hash baru dari kontainer lama tidak boleh tersimpan immutable 1 tahun.
    expect "aset hilang no-store (bukan immutable)" "$(header Cache-Control)" "no-store"
    expect "POST rute SPA ditolak" "$(fetch POST /members)" "405"
    expect "405 no-store" "$(header Cache-Control)" "no-store"
    asset="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$work/b" 2>/dev/null | head -n 1 || true)"
    if [ -z "$asset" ]; then
      fetch GET / >/dev/null
      asset="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$work/b" | head -n 1 || true)"
    fi
    if [ -n "$asset" ]; then
      expect "aset Vite" "$(fetch GET "$asset")" "200"
      expect "aset immutable" "$(header Cache-Control)" "public, max-age=31536000, immutable"
    else
      expect "aset Vite ditemukan di index.html" "tidak" "ya"
    fi
    ;;
  *)
    echo "Jenis tidak dikenal: $kind" >&2
    exit 2
    ;;
esac

if [ "$failures" -ne 0 ]; then
  echo "$failures pemeriksaan gagal."
  exit 1
fi
echo "Uji asap $kind lulus."
