# infra — image, deployment, job rilis, Compose cadangan

Artefak operasi KAPDH Apps R1.0 (PRD 5.3, 5.5, 7.1, 8.2, 8.3, 9.2, 9.3; D7, D9, D10, D12, D13, D16). Jalur utama:
**image dibangun CI → job rilis → Coolify** di satu VPS (4 vCPU / 8 GB / 100 GB, D7) dengan Traefik sebagai TLS.
Jalur cadangan saat panel Coolify tidak tersedia: **Compose cadangan** (`compose.production.yml`). Runbook:

- `docs/runbooks/rilis-dan-gerbang-go-live.md` — rilis staging/production, inisialisasi production (PRD 8.2), gerbang
  go-live (PRD 9.2, 9.3), bukti tanda tangan.
- `docs/runbooks/compose-cadangan.md` — menjalankan stack tanpa panel Coolify, termasuk Traefik cadangan.
- `docs/adr/0002-job-rilis-dan-gerbang-go-live.md` — alasan desain job rilis dan gerbang.

## Isi folder

| Berkas                                            | Fungsi                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile.api`                                  | Target `api` (runtime API, non-root uid 1000, `HEALTHCHECK` `/api/v1/health`, memuat CLI bootstrap, gerbang go-live, ledger, dan `@kapdh/database` `dist/bin` + `migrations/`) dan target `release` (runtime + psql 17 + `db/*.sql` + `scripts/release-job.sh`). `pnpm deploy --legacy` (pnpm 10 menolak deploy tanpa `inject-workspace-packages`, `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`). |
| `Dockerfile.worker`                               | Runtime worker (non-root, `HEALTHCHECK` `/healthz` port 3001, `pnpm deploy --legacy`).                                                                                                                                                                                                                                                                                                       |
| `Dockerfile.web`                                  | Situs publik Astro di nginx non-root port 8080; build arg `PUBLIC_API_URL`.                                                                                                                                                                                                                                                                                                                  |
| `Dockerfile.admin`                                | Web admin Vite di nginx non-root port 8080; build arg `VITE_API_BASE_URL`; CSP dirender dari origin API lalu gerbang CSP hasil build.                                                                                                                                                                                                                                                        |
| `nginx-main.conf`                                 | Konteks utama nginx web/admin: non-root (pid/temp di `/tmp`), log JSON tanpa query/IP (N-14).                                                                                                                                                                                                                                                                                                |
| `nginx-web.conf`                                  | Server situs publik: CSP ketat, cache, shell `/kta/<nomor>`, `/healthz`.                                                                                                                                                                                                                                                                                                                     |
| `nginx-admin.conf`                                | Server web admin (D3-07): CSP `script-src/style-src 'self'`, `frame-ancestors 'none'`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer` (alur `/invite#t=`), `index.html` no-store, `/assets/` immutable, fallback SPA `try_files`.                                                                                                                                                     |
| `db/roles.sql`                                    | Role dan grant (`kapdh_migrator`, `kapdh_app`, `kapdh_worker`, `kapdh_audit_purge`).                                                                                                                                                                                                                                                                                                         |
| `db/role-passwords.sql`                           | Sandi role LOGIN dari env lewat `\getenv` psql (tidak di argumen proses).                                                                                                                                                                                                                                                                                                                    |
| `scripts/release-job.sh`                          | Entry image rilis: tunggu DB → `roles.sql` → sandi role → migrasi (`kapdh_migrator`, advisory lock) → `roles.sql` → seed referensi → gerbang go-live.                                                                                                                                                                                                                                        |
| `scripts/run-release.sh`                          | Menjalankan image rilis di VPS (jalur Coolify) dengan berkas env `/etc/kapdh/<lingkungan>/release.env`.                                                                                                                                                                                                                                                                                      |
| `compose.production.yml`                          | Compose cadangan production: postgres 17, redis 7, api, worker, web, admin, job `release` (profile).                                                                                                                                                                                                                                                                                         |
| `compose.staging.yml`                             | Overlay staging (D12): project, NODE_ENV, volume dan batas sumber daya sendiri.                                                                                                                                                                                                                                                                                                              |
| `compose.proxy.yml`, `traefik/`                   | Traefik cadangan tanpa socket Docker; rute dirender dari env (`traefik/render-dynamic.sh`).                                                                                                                                                                                                                                                                                                  |
| `docker-compose.yml`                              | Dev lokal (PostgreSQL 17, Redis 7, Mailpit; port hanya 127.0.0.1).                                                                                                                                                                                                                                                                                                                           |
| `.env.production.example`, `.env.staging.example` | Seluruh variabel `packages/config` + variabel Compose, tanpa secret.                                                                                                                                                                                                                                                                                                                         |
| `ci/github-actions-ci.yml`                        | Lint/typecheck/test/build/format + jalur PostgreSQL 17 (`test:pg`).                                                                                                                                                                                                                                                                                                                          |
| `ci/github-actions-images.yml`                    | Validasi statis, build semua image, dry-run entry, `nginx -t`, uji asap header, stack Compose lengkap, publish GHCR, promosi tag.                                                                                                                                                                                                                                                            |
| `scripts/validate-infra.mjs`                      | Validasi statis tanpa Docker (YAML, digest, isolasi jaringan, env lengkap, least privilege, non-root).                                                                                                                                                                                                                                                                                       |
| `scripts/release-job.test.sh`                     | Uji kering `release-job.sh` dengan shim psql/node (urutan, mode gerbang, kode keluar).                                                                                                                                                                                                                                                                                                       |
| `scripts/smoke-static.sh`                         | Uji asap header/cache/fallback kontainer web dan admin.                                                                                                                                                                                                                                                                                                                                      |
| `scripts/ci-stack-smoke.sh`                       | Stack Compose production lengkap di CI (job rilis nyata, healthcheck, gerbang, DB/Redis privat).                                                                                                                                                                                                                                                                                             |
| `scripts/staging-smoke.sh`                        | Dari luar VPS: HTTPS/redirect, TLS >= 1.2, header, `/health/ready`, upgrade WSS, port DB/Redis tertutup.                                                                                                                                                                                                                                                                                     |
| `scripts/admin-csp.mjs`                           | Render CSP admin dan gerbang CSP hasil build admin.                                                                                                                                                                                                                                                                                                                                          |

## Image dan tag

| Image           | Dockerfile / target          | Port                    | User        | Catatan                                            |
| --------------- | ---------------------------- | ----------------------- | ----------- | -------------------------------------------------- |
| `kapdh-api`     | `Dockerfile.api` / `api`     | 3000                    | node (1000) | Sama untuk staging dan production.                 |
| `kapdh-release` | `Dockerfile.api` / `release` | –                       | node        | Job sekali jalan; `ENTRYPOINT` = `release-job.sh`. |
| `kapdh-worker`  | `Dockerfile.worker`          | 3001 (health, internal) | node        | Sama untuk staging dan production.                 |
| `kapdh-web`     | `Dockerfile.web`             | 8080                    | nginx (101) | URL API dibakukan saat build → varian `-staging`.  |
| `kapdh-admin`   | `Dockerfile.admin`           | 8080                    | nginx (101) | URL API dibakukan saat build → varian `-staging`.  |

Push `main` yang lolos CI menerbitkan `ghcr.io/<org>/kapdh-<image>:sha-<commit12>` (web/admin juga
`sha-<commit12>-staging`) dan dideploy ke staging. Tag `vX.Y.Z` yang disetujui gerbang rilis memberi tag versi pada
**digest yang sama** (`docker buildx imagetools create`), tanpa build ulang (PRD 5.5). Semua base image dipin digest
(Node 24.19.0/Alpine 3.24, nginx 1.30.5, PostgreSQL 17.11, Redis 7.4.11, Traefik 3.7.13; PRD 7.1).

## Job rilis (PRD 5.5) dan gerbang go-live (PRD 9.2, 9.3)

Satu job per rilis per lingkungan, **sebelum** API dan worker baru dijalankan; migrasi tidak pernah berjalan saat
startup replica. Urutan dan env ada di kepala `scripts/release-job.sh`. Mode gerbang:

- `enforce` (bawaan production): job gagal (kode 1) bila `golive:check` menolak → image tidak boleh dipromosikan.
- `report` (bawaan staging): laporan dicetak, job lanjut. Di production hanya untuk **inisialisasi pertama** sebelum
  bootstrap Super Admin dan konfigurasi pengurus; go-live wajib lulus mode `enforce`.

`golive:check` (`node dist/cli/golive-check.js`, `pnpm --filter @kapdh/api golive:check`) hanya membaca database
(transaksi read only) dan menolak bila: skema tertinggal dari journal image; kunci `app_settings` belum tersimpan atau
tidak valid; nominal iuran kosong/Rp0 atau berbeda dari D4 tanpa jejak perubahan pengurus; tidak ada metode bayar
aktif yang dibuat lewat web admin (atau metode contoh); kurang dari 2 Super Admin aktif ber-TOTP; kurang dari 2 pengurus
ber-TOTP dengan `payments.read` + `payments.decide`; halaman kebijakan privasi, ketentuan, ketentuan komunitas dan
bantuan belum terbit, masih kerangka DRAF, atau `app_settings.legal` tidak sinkron; master profesi/keahlian belum
diaktifkan; WhatsApp dukungan kosong; atau ada fixture dev (`seed.dev`, `DEV_IDS`, email `.test`, judul `[Contoh]`).
Kode keluar: 0 lulus, 1 ditolak, 2 argumen salah, 3 galat teknis. Jalankan dengan role `kapdh_migrator` (atau
`kapdh_app`; versi skema lalu tercatat "tidak terbaca"); role `kapdh_worker` tidak dapat membaca `mfa_totp` → kode 3.
Bukti uji: `apps/api/test/core/golive-gate.e2e.test.ts` (PGlite), `apps/api/test/pg/golive-gate.pg.test.ts` (satu uji per
kondisi, PostgreSQL 17), `apps/api/test/pg/critical-9-2.pg.test.ts` skenario 10, `apps/api/test/pg/release-job.pg.test.ts`.

## Jaringan, port, sumber daya

- Hanya Traefik mempublikasikan 80/443. PostgreSQL dan Redis hanya di jaringan `data` (`internal: true`, tanpa port host,
  tanpa egress); API/worker/job rilis yang tersambung (N-07, PRD 5.3). Worker `/healthz` tidak dirutekan.
- Batas Compose untuk VPS 4 vCPU / 8 GB: postgres 2 GB, redis 384 MB (maxmemory 256 MB, `noeviction` untuk BullMQ),
  api 1 GB (heap 768 MB), worker 768 MB (heap 512 MB), web/admin 64 MB, Traefik 256 MB. Staging lebih kecil. Angka awal;
  diukur ulang dengan uji beban N-01..N-04 (PRD 10.2).
- Firewall VPS: hanya 80/443 publik; SSH 22 dari IP tepercaya/VPN dengan key; port panel Coolify (8000, 6001, 6002)
  tidak dibuka langsung (panel di subdomain sendiri dengan 2FA). Periksa dengan `scripts/staging-smoke.sh`.

## Verifikasi lokal tanpa Docker

```bash
pnpm install && pnpm --filter @kapdh/config build
node infra/scripts/validate-infra.mjs          # compose/env/Dockerfile/Traefik
sh infra/scripts/release-job.test.sh           # alur job rilis dengan shim
pnpm --filter @kapdh/api test test/core/golive-gate.e2e.test.ts
pnpm --filter @kapdh/api test:pg test/pg/golive-gate.pg.test.ts test/pg/release-job.pg.test.ts
pnpm --filter @kapdh/admin test src/nginx-config.test.ts
```

Build image, `nginx -t`, uji asap header dan stack Compose hanya berjalan di CI/mesin dengan Docker
(`ci/github-actions-images.yml`). Hal yang wajib dibuktikan di staging nyata tercantum di runbook rilis.
