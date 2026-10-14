#!/bin/sh
# Menyusun konfigurasi dinamis Traefik cadangan (file provider) dari environment, dijalankan saat kontainer proxy start
# (infra/compose.proxy.yml). Tanpa socket Docker: rute menunjuk nama kontainer Compose cadangan di jaringan edge
# (kapdh-<lingkungan>-<layanan>-1). Keluaran YAML ke stdout. D12 (domain), N-07 (TLS 1.2+, HSTS terkendali).
#
# Environment:
#   KAPDH_PRODUCTION_DOMAIN_WEB / _ADMIN / _API   domain production (wajib; mis. kapdh.or.id, admin.kapdh.or.id, ...)
#   KAPDH_PRODUCTION_WWW_REDIRECT                 true (bawaan): www.<domain web> dialihkan permanen ke domain web
#   KAPDH_STAGING_DOMAIN_WEB / _ADMIN / _API      domain staging (opsional; ketiganya atau tidak sama sekali)
#   KAPDH_HSTS                                    true hanya setelah SELURUH subdomain siap HTTPS (N-07); bawaan false
set -eu

fail() {
  printf 'render-dynamic: %s\n' "$*" >&2
  exit 2
}

# Hanya huruf kecil, angka, titik, tanda hubung: nilai disisipkan ke aturan Traefik dan YAML.
check_domain() {
  case "$2" in
    '' | *[!a-z0-9.-]* | .* | *. | *..*) fail "$1 bukan nama domain yang valid: '$2'" ;;
  esac
}

regex_escape() {
  printf '%s' "$1" | sed 's/\./\\\\./g'
}

hsts="${KAPDH_HSTS:-false}"
case "$hsts" in true | false) ;; *) fail "KAPDH_HSTS harus true atau false" ;; esac
www="${KAPDH_PRODUCTION_WWW_REDIRECT:-true}"
case "$www" in true | false) ;; *) fail "KAPDH_PRODUCTION_WWW_REDIRECT harus true atau false" ;; esac

prod_web="${KAPDH_PRODUCTION_DOMAIN_WEB:-}"
prod_admin="${KAPDH_PRODUCTION_DOMAIN_ADMIN:-}"
prod_api="${KAPDH_PRODUCTION_DOMAIN_API:-}"
check_domain KAPDH_PRODUCTION_DOMAIN_WEB "$prod_web"
check_domain KAPDH_PRODUCTION_DOMAIN_ADMIN "$prod_admin"
check_domain KAPDH_PRODUCTION_DOMAIN_API "$prod_api"

stg_web="${KAPDH_STAGING_DOMAIN_WEB:-}"
stg_admin="${KAPDH_STAGING_DOMAIN_ADMIN:-}"
stg_api="${KAPDH_STAGING_DOMAIN_API:-}"
staging=false
if [ -n "$stg_web$stg_admin$stg_api" ]; then
  check_domain KAPDH_STAGING_DOMAIN_WEB "$stg_web"
  check_domain KAPDH_STAGING_DOMAIN_ADMIN "$stg_admin"
  check_domain KAPDH_STAGING_DOMAIN_API "$stg_api"
  staging=true
fi

# middlewares <nama tambahan...>: daftar middleware router (HSTS bila aktif).
middlewares() {
  list=""
  for m in "$@"; do list="$list${list:+, }$m"; done
  if [ "$hsts" = "true" ]; then list="$list${list:+, }kapdh-hsts"; fi
  if [ -n "$list" ]; then printf '      middlewares: [%s]\n' "$list"; fi
}

# router <nama> <aturan> [middleware...]
router() {
  name="$1"
  rule="$2"
  shift 2
  printf '    %s:\n' "$name"
  printf '      rule: "%s"\n' "$rule"
  printf '      entryPoints: [websecure]\n'
  printf '      service: %s\n' "$name"
  middlewares "$@"
  printf '      tls:\n        certResolver: le\n'
}

# service <nama> <url> <path healthcheck>
service() {
  printf '    %s:\n' "$1"
  printf '      loadBalancer:\n'
  printf '        passHostHeader: true\n'
  printf '        servers:\n          - url: "%s"\n' "$2"
  printf '        healthCheck:\n          path: %s\n          interval: 15s\n          timeout: 3s\n' "$3"
}

host() {
  # shellcheck disable=SC2016 # backtick literal: sintaks aturan Traefik Host(`domain`), bukan substitusi perintah
  printf 'Host(`%s`)' "$1"
}

printf '# Dihasilkan infra/traefik/render-dynamic.sh saat proxy start. Jangan disunting manual.\n'
printf 'http:\n'
printf '  middlewares:\n'
if [ "$www" = "true" ]; then
  printf '    kapdh-www-to-apex:\n'
  printf '      redirectRegex:\n'
  printf '        regex: "^https?://www\\\\.%s(.*)"\n' "$(regex_escape "$prod_web")"
  # shellcheck disable=SC2016 # ${1} literal = grup tangkap regex Traefik, bukan variabel shell
  printf '        replacement: "https://%s${1}"\n' "$prod_web"
  printf '        permanent: true\n'
fi
# HSTS 1 tahun termasuk subdomain (sama dengan helmet API saat HSTS_ENABLED=true).
printf '    kapdh-hsts:\n'
printf '      headers:\n'
printf '        stsSeconds: 31536000\n'
printf '        stsIncludeSubdomains: true\n'

printf '  routers:\n'
if [ "$www" = "true" ]; then
  router production-web "$(host "$prod_web") || $(host "www.$prod_web")" kapdh-www-to-apex
else
  router production-web "$(host "$prod_web")"
fi
router production-admin "$(host "$prod_admin")"
router production-api "$(host "$prod_api")"
if [ "$staging" = "true" ]; then
  router staging-web "$(host "$stg_web")"
  router staging-admin "$(host "$stg_admin")"
  router staging-api "$(host "$stg_api")"
fi

# API memakai READINESS (/api/v1/health/ready), sama dengan healthcheck Coolify: database pulihan yang belum menjalankan
# ledger-reapply menjawab 503 (deletion_ledger: fail) sehingga Traefik tidak merutekan trafik ke sana (AC F14-6, PRD 9.2
# #8, ADR-014). HEALTHCHECK image tetap liveness (/api/v1/health) agar kontainer tidak di-restart saat dependensi turun.
printf '  services:\n'
service production-web "http://kapdh-production-web-1:8080" /healthz
service production-admin "http://kapdh-production-admin-1:8080" /healthz
service production-api "http://kapdh-production-api-1:3000" /api/v1/health/ready
if [ "$staging" = "true" ]; then
  service staging-web "http://kapdh-staging-web-1:8080" /healthz
  service staging-admin "http://kapdh-staging-admin-1:8080" /healthz
  service staging-api "http://kapdh-staging-api-1:3000" /api/v1/health/ready
fi

printf 'tls:\n'
printf '  options:\n'
printf '    default:\n'
printf '      minVersion: VersionTLS12\n'
printf '      sniStrict: true\n'
