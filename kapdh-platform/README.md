# KAPDH Platform

Monorepo KAPDH Apps sesuai PRD v3.5: API, worker, web admin, situs publik, dan paket bersama (pnpm 10 + turbo,
Node 24). Aplikasi anggota Flutter ada di `../kapdh-mobile` (dipisah ke repo sendiri saat rilis, ADR-001). Gambaran
seluruh repo, jalur mulai cepat tanpa Docker/dengan Docker, dan aturan kontribusi: `../README.md`.

| Path                     | Isi                                                                                                                                                                                          | Keadaan R1.0                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`               | NestJS 11 + Fastify, REST `/api/v1`, Socket.IO `/realtime`, 14 modul domain, prosesor job                                                                                                    | F-01..F-17 lengkap; uji PGlite + PostgreSQL 17 (`docs/qa/traceability.md`)                                                                                       |
| `apps/worker`            | Runtime outbox, BullMQ/inline, penjadwal dengan leader, `/healthz` (`apps/worker/README.md`)                                                                                                 | Lengkap; jalur BullMQ belum diuji terhadap Redis nyata                                                                                                           |
| `apps/admin`             | React 19, Vite 8, TanStack Router/Query/Table, Tailwind 4                                                                                                                                    | Semua area ARCHITECTURE §7 tersambung API nyata; mode mock untuk pengembangan/uji                                                                                |
| `apps/web`               | Astro static `kapdh.or.id`: beranda, `/kta/<nomor>#t=`, `/delete-account`, halaman legal, kontak, unduh                                                                                      | Lengkap; gerbang CSP saat build                                                                                                                                  |
| `packages/contracts`     | OpenAPI 3.1 (24 domain), skema event realtime, tipe TS, SDK Dart `kapdh_api` (ADR-002)                                                                                                       | Versi 0.2.0                                                                                                                                                      |
| `packages/database`      | Skema Drizzle (skema `app`), migrasi `0000`-`0007`, CLI migrasi, seed (`packages/database/README.md`)                                                                                        | Lengkap                                                                                                                                                          |
| `packages/shared`        | Katalog galat → UI, rute per status, aturan sandi                                                                                                                                            | Lengkap                                                                                                                                                          |
| `packages/config`        | Validasi environment API/worker (aturan production)                                                                                                                                          | Lengkap                                                                                                                                                          |
| `packages/storage`       | StorageDriver disk lokal dan S3-compatible, baca-cadangan selama perpindahan local → S3 (ADR-022)                                                                                            | Lengkap                                                                                                                                                          |
| `packages/design-tokens` | Token Guidelines KAPDH → CSS dan Dart                                                                                                                                                        | Lengkap                                                                                                                                                          |
| `infra/`                 | `Dockerfile.{api,worker,web,admin}` (+ target `release`), nginx, compose dev/production/staging/proxy, job rilis + gerbang, `ci/`, `backup/`, `monitoring/`, `loadtest/` (`infra/README.md`) | Divalidasi statis dan uji kering (`validate-infra.mjs`, `infra/ci/test`, dry-run); build image, `nginx -t` dan stack Compose hanya di CI (belum pernah berjalan) |

## Menjalankan di lokal

Ringkas (rincian dan varian Docker/tanpa Docker di `../README.md`):

```bash
corepack enable
pnpm install
pnpm build
pnpm test                 # PGlite, tanpa layanan eksternal
pnpm test:pg              # PostgreSQL 17.6 embedded (api + worker)
```

Stack lengkap butuh PostgreSQL 17 (native atau `docker compose -f infra/docker-compose.yml up -d`):

```bash
cp .env.example .env                                   # kosongkan REDIS_URL/SMTP_URL bila tanpa Redis/Mailpit
# STORAGE_LOCAL_ROOT absolut: API (apps/api) dan worker (apps/worker) harus memakai folder berkas yang sama
sed -i "s|^STORAGE_LOCAL_ROOT=.*|STORAGE_LOCAL_ROOT=$(pwd)/.data/files|" .env   # Git Bash: $(pwd -W)
export DATABASE_URL=postgres://kapdh:kapdh-dev-only@localhost:5432/kapdh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql
pnpm --filter @kapdh/database migrate                  # CLI database membaca DATABASE_URL dari environment, bukan .env
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql
NODE_ENV=development pnpm --filter @kapdh/database seed:dev
pnpm --filter @kapdh/api dev                           # http://localhost:3000/api/v1/health
pnpm --filter @kapdh/worker start                      # http://localhost:3001/healthz
pnpm --filter @kapdh/admin dev                         # http://localhost:5173 (proxy /api → :3000)
pnpm --filter @kapdh/admin dev:mock                    # tanpa backend
pnpm --filter @kapdh/web dev                           # http://localhost:4321
```

Akun mode mock web admin: `admin@kapdh.test`, sandi `Kapdh#2026`, TOTP `123456`, backup code `A1B2C3D4E5`. Admin
undangan tanpa TOTP: `baru@kapdh.test` (sandi sama, diarahkan ke `/login/enroll`). Akun anggota `seed:dev`:
`contoh1@kapdh.test`, `contoh2@kapdh.test`, `contoh3@kapdh.test`, sandi `Kapdh#Dev2026`.

### Super Admin pertama

```bash
pnpm --filter @kapdh/api build
pnpm --filter @kapdh/api admin:bootstrap --email bayu@kapdh.or.id --name "Bayu Musthafa"
# image production: node dist/cli/bootstrap-admin.js --email ... --name ...
```

Perintah (PRD 8.2 langkah 3; tidak ada jalur HTTP) membuat Super Admin berstatus `invited` dengan sandi awal acak
yang tidak dapat dipakai, lalu mencetak **satu** tautan undangan `${ADMIN_ORIGIN}/invite#t=<token>` (72 jam, sekali
pakai). Buka tautan, ganti sandi awal, daftarkan TOTP, simpan 10 backup code yang tampil sekali; akun aktif setelah
kode pertama dikonfirmasi. Kode keluar: 0 berhasil, 1 ditolak (Super Admin aktif yang dapat login sudah ada, email
dipakai admin lain), 2 argumen salah. Menjalankan ulang untuk email yang sama sebelum aktivasi menerbitkan tautan baru;
email lain sebelum aktivasi membuat undangan Super Admin tambahan, jadi jalankan sekali dengan email yang benar.
Super Admin berikutnya diundang dari web admin (Manajemen Admin). Prosedur production lengkap:
`../docs/runbooks/production-init.md`.

### CLI operasional lain

| Perintah                                                                                                             | Kegunaan                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @kapdh/database migrate` / `node node_modules/@kapdh/database/dist/bin/migrate.js` (image)            | Job migrasi tunggal dengan advisory lock (PRD 5.5); login `kapdh_migrator`                                                                                                                                 |
| `pnpm --filter @kapdh/database seed:reference` / `.../dist/bin/seed-reference.js`                                    | Seed referensi aman production (idempoten, tanpa fixture)                                                                                                                                                  |
| `pnpm --filter @kapdh/database seed:dev`                                                                             | Fixture `[Contoh]` untuk dev/staging; menolak `NODE_ENV=production`                                                                                                                                        |
| `pnpm --filter @kapdh/api account:ledger-reapply --dir <folder>` / `node dist/modules/account/ledger-reapply.cli.js` | Terapkan ulang deletion ledger setelah restore, sebelum layanan dibuka (AC F14-6, ADR-014/019, `../docs/runbooks/restore-backup.md`); `--dir` boleh diulang (salinan bucket luar VPS + backup); env worker |
| `pnpm --filter @kapdh/api golive:check [--preflight] [--json]` / `node dist/cli/golive-check.js`                     | Gerbang go-live baca-saja (PRD 9.2 #9, 9.3; ADR-023): 0 lulus, 1 ditolak, 2 argumen, 3 galat teknis                                                                                                        |
| `pnpm --filter @kapdh/api loadtest:seed`                                                                             | Dataset sintetis uji beban di staging (ADR-020, `../docs/runbooks/load-test.md`); menolak database production                                                                                              |
| `pnpm --filter @kapdh/api account:status -- --action disable --email <e> --reason "<r>" --approved-by "<n>"`         | Status akun alumni `disabled` (`disable`/`enable`/`delete`), diaudit (`../docs/runbooks/alumni-account-disabled.md`); env worker                                                                           |
| `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql`                                                | Role dan grant; sebelum migrasi pertama dan setelah setiap migrasi (ADR-007)                                                                                                                               |

## Environment

Skema dan aturan: `packages/config/src/index.ts`; contoh berkomentar: `.env.example`. Ringkas:

- Bersama API dan worker: `NODE_ENV`, `DATABASE_URL`, `REDIS_URL` (wajib production), `LOG_LEVEL`, `PUBLIC_WEB_URL`,
  `API_PUBLIC_URL` (https di staging/production), `ADMIN_ORIGIN`, `SMTP_URL` (wajib staging/production), `MAIL_FROM`,
  `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT`, `S3_*`, `STORAGE_FALLBACK_LOCAL_ROOT` (hanya selama perpindahan ke S3),
  `FILE_URL_SECRET`, `FCM_PROJECT_ID` + `FCM_SERVICE_ACCOUNT_JSON` (wajib production), `SENTRY_DSN`,
  `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (GlitchTip, opsional, proyek terpisah per layanan). `KAPDH_COMMIT` dibakar CI
  ke image (bukan env runtime).
- Khusus API: `PORT`, `TRUST_PROXY_HOPS`, `HSTS_ENABLED`, `JWT_ACCESS_SECRET`, `JWT_ISSUER`, `QR_SIGNING_KEYS`,
  `OTP_HMAC_SECRET`, `TOTP_ENC_KEY` (64 hex), `BCRYPT_COST` (>= 10 di production).
- Khusus worker (tanpa secret JWT/OTP/TOTP/QR): `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`,
  `OUTBOX_POLL_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS`, `DELETION_LEDGER_S3_*` (deletion ledger luar VPS, wajib
  production, ADR-019; API tidak menerimanya).
- Build-time: `VITE_API_BASE_URL` (web admin, production `https://api.kapdh.or.id/api/v1`; lokal memakai proxy Vite),
  `PUBLIC_API_URL` (situs publik; default `https://api.kapdh.or.id/api/v1`, dev `http://localhost:3000/api/v1`).
- Nilai production per variabel: `../docs/runbooks/production-init.md` bagian 1.4.

## Endpoint operasional

| Endpoint                                    | Fungsi                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`                        | Liveness API (tanpa dependensi); `commit` = `KAPDH_COMMIT` image (uji asap deploy)                                                                                                                                                              |
| `GET /api/v1/health/ready`                  | Kesiapan: PostgreSQL, Redis (bila dikonfigurasi), storage, `deletion_ledger` (503 sampai ledger diterapkan setelah restore); `outbox_oldest_pending_seconds`; 503 bila dependensi wajib gagal. Healthcheck orkestrator API memakai endpoint ini |
| `GET /api/v1/public/config`                 | Versi minimum, maintenance, tautan toko, kontak, versi legal (dibaca aplikasi saat splash)                                                                                                                                                      |
| Worker `GET /healthz` (port 3001, internal) | DB, antrean, dispatcher, penjadwal; `status` `ok`/`degraded`/`error`/`stopping`                                                                                                                                                                 |

## CI

Workflow GitHub Actions ada di akar repo, `.github/workflows/` (`ci.yml`, `deploy-staging.yml`, `release.yml`,
`mobile-android.yml`); skrip pendukungnya di `infra/ci/` (lihat `infra/ci/README.md`). Proteksi branch main cukup
mewajibkan status "CI lulus". Secrets, environment staging/production, prosedur rilis dan gerbang kontrak N-13
(`pnpm contracts:breaking`): `docs/runbooks/ci-cd.md`.

## Deploy dan go-live

Image dibangun CI (`deploy-staging.yml`, katalog `infra/ci/images.json`), dipromosikan dengan digest yang sama
(`release.yml`) dan dideploy lewat Coolify. Migrasi, grant, seed referensi dan gerbang go-live dijalankan satu job per
rilis dengan urutan yang sama di dua jalur (ADR-023, ADR-024): otomatis lewat SSH forced command
`infra/ci/remote-migrate.sh` (image `kapdh-api`), atau manual/Compose cadangan lewat image `kapdh-release`
(`infra/scripts/release-job.sh`). Lihat `infra/README.md`, `../docs/runbooks/ci-cd.md`,
`../docs/runbooks/rilis-dan-gerbang-go-live.md` dan `../docs/runbooks/compose-cadangan.md`. Gerbang go-live dapat
dijalankan lokal terhadap database mana pun:

```bash
DATABASE_URL=postgres://... pnpm --filter @kapdh/api golive:check   # 0 lulus, 1 ditolak (PRD 9.2, 9.3)
```

## Aturan kerja (PRD 7.2, 7.3; ARCHITECTURE §11)

- Ubah kontrak di `packages/contracts/openapi/domains/<domain>.yaml` (komponen bersama di `root.yaml`) lebih dulu,
  lalu `pnpm contracts:lint` dan `pnpm contracts:gen` (lihat `packages/contracts/README.md`).
- Satu tugas = satu irisan vertikal (endpoint, aturan domain, migrasi, UI, error state, uji) dengan ID F/N/AC.
- Frontend tidak mengimpor `@kapdh/database`, kode worker, atau secrets (dijaga ESLint).
- Mode mock hanya untuk mengembangkan UI; tidak dihitung sebagai bukti lulus acceptance criteria.
- Permintaan latar (polling) web admin mengirim header `X-Background-Request: 1` agar tidak memperpanjang idle timeout.
- Migrasi baru bersifat aditif; jangan menyunting migrasi yang sudah dirilis. Setelah migrasi, `roles.sql` dijalankan
  ulang (lihat `packages/database/README.md`).

## Verifikasi

Perintah: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:pg`, `pnpm test:live`,
`pnpm contracts:lint`, `pnpm contracts:test-dart`, `pnpm format:check`, `pnpm audit --prod`; infra tanpa Docker:
`node infra/scripts/validate-infra.mjs`, `node infra/ci/check-workflows.mjs`, `node --test 'infra/ci/test/*.test.mjs'`,
`sh infra/scripts/release-job.test.sh`, `sh infra/backup/test/dry-run.sh`, `sh infra/monitoring/test/dry-run.sh`.
Hasil terakhir yang tercatat per lajur ada di `../docs/qa/traceability.md` bagian 2 dan
`../docs/handoff/integration-final.md` "Verifikasi akhir".
