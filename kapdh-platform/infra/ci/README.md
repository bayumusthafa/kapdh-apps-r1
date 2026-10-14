# infra/ci — skrip pendukung CI/CD

Workflow GitHub Actions ada di akar repo, `.github/workflows/` (bukan di folder ini). Template lama
`infra/ci/github-actions-ci.yml` sudah dihapus dan digantikan workflow berikut (temuan audit D2-09):

| Workflow                               | Pemicu                                    | Isi                                                                                                              |
| -------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`             | pull request ke main, push main, manual   | Gerbang N-16 dan N-13: build, typecheck, lint, format, uji, jalur PG17, kontrak, SDK Dart, Flutter, audit, image |
| `.github/workflows/deploy-staging.yml` | CI sukses pada push main, manual          | Build + push + pindai image GHCR, job migrasi, kanal `:staging`, Coolify, uji asap commit (bukti rilis)          |
| `.github/workflows/release.yml`        | tag `v*`, tag `contracts-v*`, manual      | Promosi digest sama, Release draf, deploy production bergerbang; deploy ulang tag (rollback); rilis SDK kontrak  |
| `.github/workflows/_deploy.yml`        | dipanggil dua workflow di atas            | Satu lingkungan: migrasi -> retag kanal -> Coolify -> uji asap                                                   |
| `.github/workflows/mobile-android.yml` | manual, perubahan Android/pubspec di main | APK debug kapdh-mobile (opsional)                                                                                |

Penjelasan lengkap, daftar secrets dan prosedur rilis: [`docs/runbooks/ci-cd.md`](../../../docs/runbooks/ci-cd.md).
Keputusan desain: [`docs/adr/ADR-010-pipeline-ci-cd.md`](../../../docs/adr/ADR-010-pipeline-ci-cd.md).

## Isi folder

| Berkas                 | Fungsi                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `images.json`          | Katalog image: Dockerfile, build arg per lingkungan, uji asap image. Satu-satunya tempat daftar image.          |
| `images.mjs`           | Matriks build (`matrix --mode ci\|publish`), referensi promosi (`refs`), validasi katalog (`validate`).         |
| `check-workflows.mjs`  | Pemeriksaan statis workflow (pin SHA, permissions, timeout, injeksi skrip, needs, versi Node vs Dockerfile).    |
| `coolify-deploy.mjs`   | Memicu deploy Coolify lewat URL rahasia dan menunggu setiap deployment selesai.                                 |
| `smoke.mjs`            | Uji asap HTTP sesudah deploy: `/health/ready`, header keamanan, commit image yang berjalan (`--expect-commit`). |
| `vuln-gate.mjs`        | Gerbang kerentanan pnpm audit, OSV `pubspec.lock` dan grype image: ambang tinggi/kritis + allowlist.            |
| `vuln-allowlist.json`  | Kerentanan yang diterima sementara setelah ditinjau (pemilik, alasan, kedaluwarsa <= 90 hari).                  |
| `staging-evidence.mjs` | Bukti staging untuk rilis: run `deploy-staging.yml` sukses dari main untuk commit itu (bukan status commit).    |
| `release-manifest.mjs` | Manifest rilis (digest image, versi kontrak, migrasi terakhir) untuk GitHub Release.                            |
| `remote-migrate.sh`    | Forced command SSH di VPS, terikat satu lingkungan: dump pra-migrasi -> `roles.sql` dari image -> `migrate.js`. |
| `test/*.test.mjs`      | Uji unit skrip di atas (`node --test 'infra/ci/test/*.test.mjs'`).                                              |

Semua skrip `.mjs` tanpa dependensi npm, kecuali `check-workflows.mjs` yang memakai paket `yaml` dari
`@kapdh/contracts` (jalankan setelah `pnpm install`). Pin versi alat CI ada di `.github/actions/install-tool`,
versi Node di `.github/actions/setup-platform`, versi Flutter di `.github/actions/setup-flutter`.

## Menjalankan lokal (dari `kapdh-platform/`)

```bash
node infra/ci/check-workflows.mjs
node infra/ci/images.mjs validate
node --test 'infra/ci/test/*.test.mjs'
COOLIFY_DEPLOY_URL='https://coolify.contoh/api/v1/deploy?uuid=a,b' COOLIFY_API_TOKEN=x \
  node infra/ci/coolify-deploy.mjs --dry-run
```

`remote-migrate.sh` adalah skrip POSIX `sh` untuk VPS; diperiksa `shellcheck` oleh job `workflows` di CI dan diuji
`test/remote-migrate.test.mjs` dengan `docker` palsu (butuh `sh` POSIX: dash di CI, Git Bash di Windows).
