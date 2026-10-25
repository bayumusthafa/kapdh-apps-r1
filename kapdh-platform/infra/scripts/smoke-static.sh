#!/bin/sh
# Uji asap kontainer nginx situs publik dan web admin (N-07; temuan audit D2-07/D3-07): header keamanan, cache,
# fallback SPA/KTA, metode yang ditolak. Dijalankan CI terhadap image yang baru dibangun, atau operator terhadap
# kontainer lokal. Butuh curl.
#
#   sh infra/scripts/smoke-static.sh web   http://127.0.0.1:18080
#   sh infra/scripts/smoke-static.sh admin http://127.0.0.1:18081
#
# Berkas asosiasi tautan aplikasi web (/.well-known/assetlinks.json, /.well-known/apple-app-site-association) wajib ada
# atau wajib 404 sesuai apps/web/app-links.json (atau KAPDH_APP_LINKS_CONFIG) yang dibaca dengan node: sidik sertifikat
# Android tidak kosong -> assetlinks.json; app_id_prefix Apple terisi -> apple-app-site-association. Berkas yang
# diterbitkan wajib JSON sah berbentuk berkas asosiasi dan, bila ekspektasi berasal dari konfigurasi, sama byte demi
# byte dengan render apps/web/scripts/app-links.mjs dari konfigurasi itu. Di tempat tanpa node atau tanpa repo
# (kontainer curl di ci-stack-smoke.sh) ekspektasinya dihitung di host lalu diteruskan sebagai env, dan isi berkas
# hanya diperiksa bentuknya:
#
#   env $(sh infra/scripts/smoke-static.sh app-links-env) sh infra/scripts/smoke-static.sh web <url dasar>
#
# CI menguji cabang diterbitkan dengan konfigurasi uji (job compose-stack, infra/ci/test/fixtures/app-links.uji.json):
#
#   KAPDH_APP_LINKS_CONFIG=<konfigurasi> KAPDH_EXPECT_ASSETLINKS=1 KAPDH_EXPECT_AASA=1 \
#     sh infra/scripts/smoke-static.sh web <url dasar>
set -eu

kind="${1:-}"
base="${2:-}"
here="$(dirname "$0")"
# Konfigurasi sumber ekspektasi berkas asosiasi dan modul render-nya (relatif terhadap skrip ini).
app_links_config="${KAPDH_APP_LINKS_CONFIG:-$here/../../apps/web/app-links.json}"
app_links_renderer="$here/../../apps/web/scripts/app-links.mjs"

# Cetak "<assetlinks 1|0> <aasa 1|0>" dari $app_links_config.
app_links_expect() {
  if ! command -v node >/dev/null 2>&1 || [ ! -f "$app_links_config" ]; then
    echo "Tidak dapat membaca $app_links_config dengan node; isi KAPDH_EXPECT_ASSETLINKS dan KAPDH_EXPECT_AASA (1/0)." >&2
    exit 2
  fi
  node -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const fingerprints = c.android && c.android.sha256_cert_fingerprints;
    const prefix = c.ios && c.ios.app_id_prefix;
    const android = Array.isArray(fingerprints) && fingerprints.length > 0 ? 1 : 0;
    const ios = typeof prefix === "string" && prefix !== "" ? 1 : 0;
    console.log(android + " " + ios);
  ' "$app_links_config"
}

if [ "$kind" = "app-links-env" ]; then
  expectation="$(app_links_expect)"
  echo "KAPDH_EXPECT_ASSETLINKS=${expectation% *} KAPDH_EXPECT_AASA=${expectation#* }"
  exit 0
fi
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

# association_body <path>: isi respons terakhir ($work/b) wajib JSON sah berbentuk berkas asosiasi (relation
# delegate_permission/common.handle_all_urls untuk assetlinks.json, applinks.details untuk apple-app-site-association)
# dan, bila $body_config terisi, sama byte demi byte dengan render $app_links_renderer dari konfigurasi itu. Mencetak
# baris lulus/GAGAL; keluar bukan nol bila ada yang gagal. Butuh node. Path diteruskan ke node tanpa "/" awal (kunci
# renderAppLinkFiles, dan tidak diubah konversi path MSYS saat dicoba di Git Bash Windows).
association_body() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const [file, bodyFile, renderer, config] = process.argv.slice(1);
    const path = "/" + file;
    const body = readFileSync(bodyFile);
    let failed = false;
    const report = (ok, label, detail) => {
      console.log(ok ? "lulus  " + path + " " + label : "GAGAL  " + path + " " + label + ": " + detail);
      failed ||= !ok;
    };
    let doc;
    let parsed = false;
    try {
      doc = JSON.parse(body.toString("utf8"));
      parsed = true;
    } catch (error) {
      report(false, "isi JSON", error.message);
    }
    if (parsed) {
      report(true, "isi JSON");
      const aasa = path.endsWith("/apple-app-site-association");
      const shaped = aasa
        ? Array.isArray(doc?.applinks?.details) && doc.applinks.details.length > 0
        : Array.isArray(doc) &&
          doc.length > 0 &&
          doc.every((s) => Array.isArray(s?.relation) && s.relation.includes("delegate_permission/common.handle_all_urls"));
      report(
        shaped,
        aasa ? "isi applinks.details" : "isi relation delegate_permission/common.handle_all_urls",
        "bentuk berkas asosiasi tidak dikenali",
      );
    }
    if (config) {
      const { renderAppLinkFiles } = await import(pathToFileURL(resolve(renderer)).href);
      const expected = renderAppLinkFiles(JSON.parse(readFileSync(config, "utf8"))).get(file);
      report(
        expected !== undefined && Buffer.from(expected, "utf8").equals(body),
        "isi sama dengan render " + config,
        expected === undefined
          ? "konfigurasi tidak menerbitkan berkas ini"
          : "berbeda (" + body.length + " byte diterima, " + Buffer.byteLength(expected, "utf8") + " byte diharapkan)",
      );
    }
    process.exitCode = failed ? 1 : 0;
  ' "${1#/}" "$work/b" "$app_links_renderer" "$body_config"
}

# association <path> <1|0>: berkas asosiasi tautan aplikasi yang diharapkan dilayani apa adanya (200, Content-Type
# persis application/json, tanpa pengalihan, isi JSON yang sesuai); yang tidak diharapkan wajib 404.
association() {
  if [ "$2" = "1" ]; then
    expect "$1 diterbitkan" "$(fetch GET "$1")" "200"
    expect "$1 Content-Type" "$(header Content-Type)" "application/json"
    expect "$1 tanpa pengalihan" "$(header Location)" ""
    expect "$1 cache 1 jam" "$(header Cache-Control)" "public, max-age=3600"
    if command -v node >/dev/null 2>&1; then
      association_body "$1" || failures=$((failures + 1))
    else
      # Tanpa node (kontainer curl ci-stack-smoke.sh) JSON tidak di-parse: cukup karakter pertama dan kunci wajib.
      case "$1" in
        */apple-app-site-association) key='"applinks"' ;;
        *) key='"delegate_permission/common.handle_all_urls"' ;;
      esac
      first="$(head -n 1 "$work/b" | cut -c 1)"
      case "$first" in
        "[" | "{") echo "lulus  $1 isi diawali [ atau { (tanpa node)" ;;
        *) expect "$1 isi diawali [ atau { (tanpa node)" "$first" "[ atau {" ;;
      esac
      expect_contains "$1 isi memuat $key (tanpa node)" "$(cat "$work/b")" "$key"
    fi
  else
    expect "$1 tidak diterbitkan" "$(fetch GET "$1")" "404"
  fi
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
    # Halaman informasi/legal memuat naskah tayang di HTML, terbaca tanpa JavaScript (URL kebijakan privasi Google
    # Play/App Store), bukan kerangka yang menunggu skrip (apps/web/scripts/assert-published-pages.mjs).
    for slug in kebijakan-privasi ketentuan ketentuan-komunitas bantuan tentang; do
      expect "/$slug" "$(fetch GET "/$slug")" "200"
      expect_contains "/$slug naskah tanpa JavaScript" "$(cat "$work/b")" 'data-state="static"'
      expect_contains "/$slug baris berlaku" "$(cat "$work/b")" "Berlaku sejak "
    done
    # Rolling deploy: aset hash yang belum ada di kontainer ini → 404 yang TIDAK pernah disimpan immutable.
    expect "aset /_astro/ hilang 404" "$(fetch GET /_astro/tidak-ada.js)" "404"
    expect "aset /_astro/ hilang no-store" "$(header Cache-Control)" "no-store"
    if [ -n "$asset" ]; then
      expect "aset Astro" "$(fetch GET "$asset")" "200"
      expect "aset Astro immutable" "$(header Cache-Control)" "public, max-age=31536000, immutable"
    else
      expect "aset /_astro/*.css ditemukan di beranda" "tidak" "ya"
    fi
    # Path bertitik tetap 404; hanya dua berkas asosiasi tautan aplikasi yang dikecualikan (infra/nginx-web.conf).
    expect "/.well-known/ 404" "$(fetch GET /.well-known/)" "404"
    expect "/.well-known/acme-challenge/x 404" "$(fetch GET /.well-known/acme-challenge/x)" "404"
    expect "/.git/config 404" "$(fetch GET /.git/config)" "404"
    expect "/app/.env 404" "$(fetch GET /app/.env)" "404"
    # Halaman cadangan tautan aplikasi /app dan /app/<rute>; /apply bukan bagian darinya.
    expect "tautan aplikasi /app" "$(fetch GET /app)" "200"
    expect "tautan aplikasi /app no-store" "$(header Cache-Control)" "no-store"
    expect "tautan aplikasi /app noindex" "$(header X-Robots-Tag)" "noindex, nofollow"
    expect "tautan aplikasi /app/payments/x" "$(fetch GET /app/payments/x)" "200"
    expect_contains "tautan aplikasi /app/payments/x HTML" "$(header Content-Type)" "text/html"
    expect_contains "tautan aplikasi berisi tombol buka aplikasi" "$(cat "$work/b")" 'id="app-open"'
    # /app tidak ditutup robots.txt (aturan prefiks ikut menutup /apply); halaman hasil build wajib membawa noindex.
    expect_contains "tautan aplikasi meta robots noindex" "$(cat "$work/b")" '<meta name="robots" content="noindex, nofollow">'
    expect "/apply bukan tautan aplikasi" "$(fetch GET /apply)" "404"
    # Isi berkas dibandingkan dengan render konfigurasi hanya bila ekspektasi berasal dari konfigurasi: yang diberikan
    # lewat KAPDH_APP_LINKS_CONFIG, atau apps/web/app-links.json bila KAPDH_EXPECT_* tidak diisi.
    body_config="${KAPDH_APP_LINKS_CONFIG:-}"
    if [ -z "${KAPDH_EXPECT_ASSETLINKS:-}" ] || [ -z "${KAPDH_EXPECT_AASA:-}" ]; then
      expectation="$(app_links_expect)"
      KAPDH_EXPECT_ASSETLINKS="${expectation% *}"
      KAPDH_EXPECT_AASA="${expectation#* }"
      body_config="$app_links_config"
    fi
    for flag in "$KAPDH_EXPECT_ASSETLINKS" "$KAPDH_EXPECT_AASA"; do
      case "$flag" in
        0 | 1) ;;
        *)
          echo "KAPDH_EXPECT_ASSETLINKS dan KAPDH_EXPECT_AASA harus 1 atau 0" >&2
          exit 2
          ;;
      esac
    done
    association /.well-known/assetlinks.json "$KAPDH_EXPECT_ASSETLINKS"
    association /.well-known/apple-app-site-association "$KAPDH_EXPECT_AASA"
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
