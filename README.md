# KAPDH Apps

Platform digital **Keluarga Alumni Pondok Pesantren Darel Hikmah (KAPDH)**: aplikasi anggota Android/iOS, web admin
pengurus, situs publik `kapdh.or.id`, serta API dan worker di belakangnya. Rilis R1.0 memuat seluruh F-01 sampai F-17
dan target N-01 sampai N-16 dari PRD v3.5 (`docs/PRD_KAPDH_Apps_v3.5.pdf`, salinan teks
`docs/reference/PRD_v3.5.txt`). Dibangun dari nol tanpa Supabase/Vercel atau backend-as-a-service lain (D14); Firebase
hanya dipakai untuk push FCM.

| Bagian | Untuk siapa | Domain production (D12) |
| ------ | ----------- | ----------------------- |
| Aplikasi anggota (Flutter, `kapdh-mobile/`) | Alumni: registrasi + OTP, iuran, KTA digital + QR (offline 7 hari), beranda/berita, event + tiket, direktori, chat, notifikasi, hapus akun | Google Play, App Store (`id.or.kapdh.app`) |
| Web admin (React, `kapdh-platform/apps/admin`) | Pengurus: verifikasi pembayaran, anggota, konten, event + check-in, moderasi, admin + izin, audit, notifikasi, pengaturan | `admin.kapdh.or.id` |
| Situs publik (Astro, `kapdh-platform/apps/web`) | Umum: beranda, verifikasi KTA `/kta/<nomor>#t=...`, hapus akun `/delete-account`, halaman legal, kontak, unduh | `kapdh.or.id` |
| API (NestJS + Fastify, `kapdh-platform/apps/api`) | REST `/api/v1` + Socket.IO `/realtime` | `api.kapdh.or.id` |
| Worker (`kapdh-platform/apps/worker`) | Outbox, email/push, pengingat, expiry, ekspor, cleanup, penghapusan akun | internal |

## Peta repository

```
KAPDHAPPS/                         satu repo selama build (ADR-001); kapdh-mobile dipisah saat rilis
  README.md                        dokumen ini
  LICENSE                          lisensi proprietary KAPDH (seluruh hak dilindungi)
  THIRD_PARTY_NOTICES.md           font, ikon, dan kode pihak ketiga di repo beserta lisensinya
  .github/                         workflow GitHub Actions (ci, deploy-staging, release, mobile-android) + action lokal
  docs/
    PRD_KAPDH_Apps_v3.5.pdf        sumber kebenaran produk
    ARCHITECTURE.md                kontrak rekayasa (mengikat untuk kontributor dan agen AI)
    BUILD_PLAN.md                  fase build dan peta kepemilikan path
    adr/                           catatan keputusan arsitektur 001-024
    runbooks/                      production-init, go-live (+ rollback), rilis-dan-gerbang-go-live, ci-cd,
                                   compose-cadangan, backup-restore, restore-backup, monitoring, incident-response,
                                   load-test, storage-migration, app-store-submission, alumni-account-disabled,
                                   push-fcm
    qa/                            traceability.md (bukti otomatis per AC/N/U), uat-checklist.md (UAT manual),
                                   device-matrix.md (D7), templat bukti restore-drills/, availability/, load/
    handoff/                       laporan serah terima per fase/irisan (fakta, keputusan, isu terbuka)
    reference/                     teks PRD, guideline KAPDH (PNG), prototipe layar (HTML)
  kapdh-platform/                  monorepo pnpm 10 + turbo (Node 24)
    apps/api                       NestJS 11 + Fastify, Socket.IO, modul domain, prosesor job
    apps/worker                    runtime worker (memuat modul job API lewat @kapdh/api/worker)
    apps/admin                     React 19 + Vite 8 + TanStack + Tailwind 4
    apps/web                       Astro static
    packages/contracts             OpenAPI 3.1 per domain, skema event realtime, tipe TS, generator SDK Dart
    packages/database              skema Drizzle (skema app), migrasi SQL, CLI migrasi, seed
    packages/shared                katalog galat → UI, rute per status, aturan sandi
    packages/config                validasi environment API/worker
    packages/storage               StorageDriver (disk lokal, S3-compatible)
    packages/design-tokens         token Guidelines KAPDH → CSS Tailwind + Dart
    infra/                         Dockerfile api(+release)/worker/web/admin, nginx, compose dev/production/staging/
                                   proxy, roles.sql, job rilis + gerbang go-live, skrip CI (ci/), backup/,
                                   monitoring/, loadtest/ (infra/README.md)
  kapdh-mobile/                    Flutter 3.47 (Android/iOS), SDK `kapdh_api` lewat path dependency
```

## Dokumen yang perlu dibaca

| Kebutuhan | Dokumen |
| --------- | ------- |
| Memahami produk dan AC | PRD bagian 1-4; `docs/reference/PRD_v3.5.txt` |
| Aturan rekayasa, struktur kode, pola API | `docs/ARCHITECTURE.md` |
| Alasan keputusan teknis | `docs/adr/README.md` |
| Menjalankan dan mengembangkan platform | `kapdh-platform/README.md`, README per paket (`apps/worker`, `packages/{database,contracts,design-tokens}`) |
| Menjalankan dan mengembangkan aplikasi | `kapdh-mobile/README.md` |
| Inisialisasi production, go-live, rollback | `docs/runbooks/production-init.md`, `docs/runbooks/go-live.md`, `docs/runbooks/rilis-dan-gerbang-go-live.md` |
| CI/CD, image, deploy staging/production, Compose cadangan | `docs/runbooks/ci-cd.md`, `docs/runbooks/compose-cadangan.md`, `kapdh-platform/infra/README.md` |
| Backup, restore drill, monitoring, insiden, uji beban | `docs/runbooks/backup-restore.md`, `monitoring.md`, `incident-response.md`, `load-test.md`, `storage-migration.md` |
| Restore backup tanpa menghidupkan akun terhapus; status akun `disabled` | `docs/runbooks/restore-backup.md`, `docs/runbooks/alumni-account-disabled.md` (Bahasa Inggris, dari hardening Fase D) |
| Pengajuan toko aplikasi | `docs/runbooks/app-store-submission.md` |
| Push FCM production (Firebase, kunci akun layanan, uji mandiri `push-selftest`, rotasi) | `docs/runbooks/push-fcm.md` |
| Bukti penerimaan | `docs/qa/traceability.md`, `docs/qa/uat-checklist.md` |

## Prasyarat

- Node 24 (`kapdh-platform/.nvmrc`) dan pnpm 10.28 (`corepack enable`; versi dikunci `packageManager`).
- Flutter 3.47.2 / Dart 3.13.2 untuk `kapdh-mobile`. Di Windows + Git Bash: `export PATH="/c/flutter/flutter/bin:$PATH"`
  lalu pakai `flutter.bat` dan `dart.bat`.
- Opsional: PostgreSQL 17 lokal (jalur C) atau Docker Desktop (jalur D). Redis dan SMTP opsional di development
  (rate limit, antrean, dan realtime memakai memori; OTP dicetak ke log API bila `SMTP_URL` kosong).

## Mulai cepat

### A. Tanpa Docker: build dan semua lajur uji (Windows/Linux)

Tidak butuh layanan apa pun: uji bawaan memakai PGlite (PostgreSQL WASM) dan lajur konkurensi memakai biner
PostgreSQL 17.6 dari paket npm `embedded-postgres` (ADR-003).

```bash
cd kapdh-platform
corepack enable
pnpm install
pnpm build              # juga membangkitkan tipe TS dan SDK Dart dari kontrak
pnpm test               # unit + e2e API pada PGlite, admin, web, worker, paket
pnpm test:pg            # PostgreSQL 17 nyata (api + worker), koneksi bersamaan, role kapdh_app/kapdh_worker
pnpm typecheck && pnpm lint && pnpm format:check && pnpm contracts:lint

cd ../kapdh-mobile
flutter pub get         # Windows Git Bash: flutter.bat pub get
flutter analyze
flutter test
```

`pnpm test:pg` mencetak `TypeError: done is not a function` dari `embedded-postgres` setelah ringkasan; kode keluar
tetap 0 (diketahui, ADR-003).

### B. Antarmuka tanpa backend

```bash
cd kapdh-platform
pnpm --filter @kapdh/admin dev:mock    # http://localhost:5173, server tiruan dalam peramban
pnpm --filter @kapdh/web dev           # http://localhost:4321 (bagian yang memanggil API menampilkan "tidak terjangkau")
```

Akun mode mock web admin: `admin@kapdh.test` / `Kapdh#2026`, TOTP `123456`, backup code `A1B2C3D4E5`; admin undangan
tanpa TOTP `baru@kapdh.test`. Bukti mode mock tidak dihitung sebagai bukti AC (PRD 7.3).

### C. Stack lengkap lokal tanpa Docker (PostgreSQL 17 terpasang)

Pasang PostgreSQL 17 (Windows: installer EDB, menyertakan `psql`; Linux: paket `postgresql-17` dari repositori PGDG).
Untuk pengembangan, satu role superuser `kapdh` cukup (sama dengan compose); pemisahan role production diuji oleh
`pnpm test:pg`.

```bash
psql -U postgres -c "create role kapdh login superuser password 'kapdh-dev-only'"
psql -U postgres -c "create database kapdh owner kapdh"

cd kapdh-platform
cp .env.example .env
# Di .env: kosongkan REDIS_URL= dan SMTP_URL= bila Redis/Mailpit tidak berjalan (OTP dan email undangan admin tercetak di log).
# STORAGE_LOCAL_ROOT wajib absolut agar API, worker dan CLI memakai folder berkas yang sama (lihat catatan di bawah).
sed -i "s|^STORAGE_LOCAL_ROOT=.*|STORAGE_LOCAL_ROOT=$(pwd)/.data/files|" .env   # Git Bash di Windows: $(pwd -W)
export DATABASE_URL=postgres://kapdh:kapdh-dev-only@localhost:5432/kapdh     # PowerShell: $env:DATABASE_URL="..."
pnpm install && pnpm build
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql                # role kapdh_audit_purge dkk. (ADR-007)
pnpm --filter @kapdh/database migrate                                       # CLI database TIDAK membaca .env
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql                # wajib lagi setelah setiap migrasi
NODE_ENV=development pnpm --filter @kapdh/database seed:dev                  # referensi + fixture [Contoh]

pnpm --filter @kapdh/api dev                 # http://localhost:3000/api/v1/health (membaca kapdh-platform/.env)
pnpm --filter @kapdh/worker start            # terminal lain; health http://localhost:3001/healthz
pnpm --filter @kapdh/api admin:bootstrap --email admin@kapdh.test --name "Admin Lokal"
pnpm --filter @kapdh/admin dev               # http://localhost:5173, proxy /api ke :3000
pnpm --filter @kapdh/web dev                 # http://localhost:4321

cd ../kapdh-mobile
flutter run --dart-define-from-file=config/development.json   # emulator Android → http://10.0.2.2:3000/api/v1
```

- CLI bootstrap mencetak tautan `http://localhost:5173/invite#t=...`: buka, ganti sandi, daftarkan TOTP di aplikasi
  autentikator, simpan backup code (ADR-013).
- Akun anggota fixture: `contoh1@kapdh.test` (belum bayar), `contoh2@kapdh.test` (aktif), `contoh3@kapdh.test`
  (menunggu verifikasi), sandi `Kapdh#Dev2026`. `seed:dev` menolak `NODE_ENV=production`.
- Tanpa `roles.sql`, job penghapusan akun gagal dengan "Role kapdh_audit_purge belum ada".
- `STORAGE_LOCAL_ROOT` relatif (bawaan `.env.example`: `./.data/files`) diselesaikan dari folder kerja proses
  (`packages/storage`). `pnpm --filter` menjalankan API di `apps/api` dan worker di `apps/worker`, sehingga keduanya
  menulis ke folder berbeda: berkas ekspor audit buatan worker tidak ditemukan API, dan job penghapusan tidak
  menghapus berkas unggahan API. Karena itu path dibuat absolut dengan perintah `sed` di atas (Linux `$(pwd)`, Git
  Bash `$(pwd -W)` agar Node menerima `C:/...`; PowerShell: tulis path absolut secara manual). Perintah `sed` diuji
  di Git Bash pada salinan `.env.example`.
- Urutan migrasi → `roles.sql` → seed, CLI bootstrap, health API/worker, dan worker tanpa Redis diuji pada 14 Oktober
  2026 terhadap PostgreSQL 17.6 sementara (biner `embedded-postgres`) dengan role terpisah; varian superuser `kapdh`
  dan instalasi PostgreSQL native belum diuji di mesin build.

### D. Dengan Docker Compose

`infra/docker-compose.yml` menjalankan PostgreSQL 17, Redis 7, dan Mailpit (email lokal di http://localhost:8025).
Belum diuji di mesin build (tanpa Docker).

```bash
cd kapdh-platform
cp .env.example .env
sed -i "s|^STORAGE_LOCAL_ROOT=.*|STORAGE_LOCAL_ROOT=$(pwd)/.data/files|" .env   # path absolut (jalur C); Git Bash: $(pwd -W)
docker compose -f infra/docker-compose.yml up -d
export DATABASE_URL=postgres://kapdh:kapdh-dev-only@localhost:5432/kapdh
pnpm install && pnpm build
docker compose -f infra/docker-compose.yml exec -T postgres psql -U kapdh -d kapdh -v ON_ERROR_STOP=1 -f - < infra/db/roles.sql
pnpm --filter @kapdh/database migrate
docker compose -f infra/docker-compose.yml exec -T postgres psql -U kapdh -d kapdh -v ON_ERROR_STOP=1 -f - < infra/db/roles.sql
NODE_ENV=development pnpm --filter @kapdh/database seed:dev
pnpm dev                                     # turbo: api (watch), admin (mode nyata), web
pnpm --filter @kapdh/worker start            # terminal lain
```

## Perintah per aplikasi

Jalankan dari `kapdh-platform/` kecuali disebut lain.

| Paket | Perintah |
| ----- | -------- |
| Root | `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:pg`, `pnpm test:live`, `pnpm format`, `pnpm format:check`, `pnpm dev`, `pnpm tokens:gen` |
| Kontrak | `pnpm contracts:bundle`, `pnpm contracts:lint`, `pnpm contracts:gen`, `pnpm contracts:test-dart` (butuh Dart), `pnpm contracts:breaking` (gerbang N-13, butuh oasdiff), `pnpm contracts:release-sdk [-- --dry-run]` |
| `@kapdh/api` | `dev`, `build`, `start`, `test`, `test:pg`, `typecheck`, `lint`, `admin:bootstrap --email <e> --name "<n>"`, `golive:check [--preflight] [--json]` (gerbang go-live, ADR-023), `account:ledger-reapply --dir <folder> [--dir ...]`, `account:status -- --action <disable/enable/delete> --email <e> --reason "<r>" --approved-by "<n>"`, `loadtest:seed` (dataset sintetis staging; menolak production) (semua CLI menjalankan `dist/`, jadi build dulu) |
| `@kapdh/worker` | `build`, `start`, `test`, `test:pg`, `typecheck`, `lint` |
| `@kapdh/admin` | `dev`, `dev:mock`, `build` (butuh `VITE_API_BASE_URL` untuk production), `test`, `test:live` (klien admin terhadap API nyata yang dibangun lokal, D2-14), `typecheck`, `lint` |
| Infra (tanpa Docker) | `node infra/scripts/validate-infra.mjs`, `node infra/ci/check-workflows.mjs`, `node --test 'infra/ci/test/*.test.mjs'`, `sh infra/scripts/release-job.test.sh`, `sh infra/backup/test/dry-run.sh`, `sh infra/monitoring/test/dry-run.sh` |
| `@kapdh/web` | `dev`, `build` (env build `PUBLIC_API_URL`; gerbang CSP `scripts/assert-csp-safe.mjs`), `preview`, `test`, `typecheck`, `lint` |
| `@kapdh/database` | `migrate`, `seed:reference`, `seed:dev`, `db:generate`, `db:generate:custom --name=<x>`, `db:check`, `test` (CLI butuh `DATABASE_URL` di environment) |
| `kapdh-mobile` | `flutter pub get`, `flutter analyze`, `flutter test`, `flutter run --dart-define-from-file=config/<lingkungan>.json` (juga `flutter build appbundle` / `flutter build ipa`), `dart format --output=none --set-exit-if-changed lib test` |

Format perintah paket: `pnpm --filter <paket> <skrip>`.

## Lajur uji dan bukti

| Lajur | Perintah | Isi | Bukti AC? |
| ----- | -------- | --- | --------- |
| API PGlite | `pnpm --filter @kapdh/api test` | e2e per endpoint, validasi kontrak (`expectOperation`), authz negatif | Ya |
| API PostgreSQL 17 | `pnpm --filter @kapdh/api test:pg` | skenario PRD 9.2, kunci/race, role nyata, migrasi + seed | Ya |
| Worker | `pnpm --filter @kapdh/worker test` / `test:pg` | dispatcher, lease, leader, BullMQ vs server RESP tiruan | Ya (runtime) |
| Paket | `pnpm test` | database, shared, config, storage, kontrak | Ya (unit) |
| Admin | `pnpm --filter @kapdh/admin test` | Vitest + Testing Library pada server tiruan (respons tiruan divalidasi terhadap kontrak) | Perilaku klien saja |
| Admin live | `pnpm test:live` | web admin terhadap API nyata (build lokal, PGlite): login + TOTP, konflik keputusan, catat iuran D13, idle | Ya (klausul UI, D2-14) |
| Web | `pnpm --filter @kapdh/web test` | Vitest + jsdom | Perilaku klien saja |
| Mobile | `flutter test` | unit + widget, HTTP palsu | Perilaku klien saja |
| Mobile perangkat | `integration_test/critical_flows_test.dart` (`kapdh-mobile/README.md`) | smoke alur kritis + p95 N-03 di perangkat matriks D7 | Ya untuk N-03/N-12 bila dijalankan di perangkat (`docs/qa/device-matrix.md`) |
| Infra | perintah baris "Infra" di atas; CI juga build image + stack Compose (`.github/workflows/ci.yml`) | statis + uji kering dengan alat palsu | Konfigurasi saja; staging nyata wajib |
| UAT staging | `docs/qa/uat-checklist.md` | manual per peran | Ya (PRD 9.3) |

Status terakhir per AC/N/U: `docs/qa/traceability.md`.

## Variabel environment

- Skema dan aturan validasi API/worker: `kapdh-platform/packages/config/src/index.ts`; contoh berkomentar:
  `kapdh-platform/.env.example`. Berkas `.env` hanya dibaca saat `NODE_ENV=development`.
- Nilai staging/production dan aturan wajibnya: `docs/runbooks/production-init.md` bagian 1.4; contoh lengkap per
  lingkungan (tanpa secret) yang divalidasi `validate-infra.mjs`: `kapdh-platform/infra/.env.{production,staging}.example`.
- Build-time: `PUBLIC_API_URL` (situs publik), `VITE_API_BASE_URL` (web admin, juga origin CSP admin), `KAPDH_COMMIT`
  (dibakar CI ke image, dilaporkan `GET /api/v1/health` dan `/version.json`; tidak diisi di env runtime).
- Aplikasi Flutter: `kapdh-mobile/config/{development,staging,production}.json` (`KAPDH_ENV`, `API_BASE_URL`,
  `PUSH_ENABLED`, `FIREBASE_*`; ADR-016).
- Versi minimum aplikasi, maintenance, tautan toko, kontak bantuan, nominal iuran, dan instruksi bayar per platform
  diatur di `app_settings` lewat web admin, bukan env.

## Aturan kontribusi (ringkas dari ARCHITECTURE §2 dan §11)

1. Baca `docs/ARCHITECTURE.md`, `docs/BUILD_PLAN.md`, dan bagian PRD untuk irisan Anda sebelum menulis kode. PRD
   menang atas perilaku produk; ARCHITECTURE menang atas kode yang ada.
2. Satu tugas = satu irisan vertikal (kontrak → endpoint → aturan domain → migrasi → UI → error state → uji) dengan ID
   F/N/AC di nama uji dan laporan. Ubah kontrak di `packages/contracts/openapi/domains/<domain>.yaml` lebih dulu.
3. Hanya ubah path milik tugas Anda (peta kepemilikan di BUILD_PLAN). Perubahan file bersama (core, skema, `root.yaml`,
   `app.module.ts`, router, pubspec, lockfile) dibuat seminimal mungkin dan dilaporkan sebagai `shared_changes`.
4. Jangan menyunting atau meng-commit berkas terbangkit (`dist/`, `src/generated/`, `dart/kapdh_api/lib/src/`).
5. Sebelum selesai jalankan verifikasi area Anda (`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
   `pnpm test:pg`, `pnpm format:check`, `pnpm contracts:lint`; mobile `flutter analyze`, `flutter test`). Laporkan
   persis yang lulus dan yang tidak; jangan pernah mengklaim lulus yang tidak diamati.
6. Pesan commit `feat(<area>): ... (F-xx, AC ...)` / `fix(...)` / `docs: ...`; agen AI mengakhiri pesan commit dengan
   baris `Co-Authored-By` sesuai ARCHITECTURE §11.
7. Aturan yang tidak dapat ditawar: aturan bisnis di server; tidak ada NIK/Nomor KTP di mana pun; tidak mencatat
   sandi, OTP, token, secret TOTP, isi chat, bukti bayar, atau token push; uang `numeric(14,2)`/string `Money`; waktu
   dari Clock dan disimpan UTC; UUID v7 dibuat aplikasi; JSON snake_case; teks pengguna dan komentar Bahasa Indonesia
   dengan rujukan PRD; status tidak hanya warna; transisi penting atomik dengan audit + outbox di transaksi yang sama;
   `paid` tidak pernah diubah (koreksi lewat penyesuaian); MFA production tidak dimatikan; aksesibilitas N-11.
8. Upgrade mayor framework/runtime memerlukan ADR (PRD 7.1).

## Lisensi dan merek

- Hak Cipta (c) 2026 Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH). Seluruh hak dilindungi
  (`LICENSE`, proprietary). Kode dan dokumen boleh dilihat bila repositori dipublikasikan, tetapi memakai, menyalin,
  mengubah, mendistribusikan, atau membuat karya turunan memerlukan izin tertulis pengurus KAPDH.
- Nama dan logo KAPDH, ikon aplikasi, nama Pondok Pesantren Darel Hikmah, dan pedoman merek
  (`docs/reference/Guidelines_KAPDH_v1.0.txt`, `docs/reference/guidelines/`) tidak dilisensikan.
- Font, ikon, dan kode pihak ketiga yang dibundel atau disalin ke repo tetap tunduk pada lisensinya masing-masing;
  daftarnya ada di `THIRD_PARTY_NOTICES.md`. Perbarui berkas itu setiap kali aset pihak ketiga ditambah atau diganti.
- Catatan: naskah `LICENSE` (Bahasa Indonesia dengan terjemahan Bahasa Inggris) disusun tim pengembang dan belum
  ditinjau secara hukum. Pengurus KAPDH dan/atau penasihat hukumnya perlu meninjaunya sebelum repositori
  dipublikasikan.
