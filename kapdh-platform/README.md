# KAPDH Platform

Monorepo KAPDH Apps sesuai PRD v3.5: API, worker, web admin, situs publik, dan paket bersama.
Aplikasi anggota Flutter ada di repository terpisah (`../kapdh-mobile`).

| Path                     | Isi                                                      | Status Tahap 0                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`               | NestJS 11 + Fastify, `/api/v1`                           | Auth F-01/F-02 tersambung PostgreSQL: registrasi + OTP email, nomor KTA, login, refresh berotasi, logout, admin TOTP + backup code, idle 30 menit, rate limit   |
| `apps/admin`             | React 19, Vite 8, TanStack Router/Query, Tailwind 4      | Design system (src/components/ui), semua rute ARCHITECTURE §7 berpenjaga izin, login/TOTP ke API nyata, idle 30 menit; area lain dan pembayaran masih mode mock |
| `apps/web`               | Astro static untuk kapdh.or.id                           | Beranda, `/kta/{nomor}` (token dari fragmen `#t=`), `/delete-account`, halaman legal                                                                            |
| `apps/worker`            | Worker outbox dan job                                    | Kerangka                                                                                                                                                        |
| `packages/contracts`     | OpenAPI 3.1 dan tipe TS terbangkit                       | Domain P0/P1                                                                                                                                                    |
| `packages/database`      | Skema Drizzle dan migrasi SQL                            | Identitas, keanggotaan, pembayaran, berkas, audit, outbox, idempotensi                                                                                          |
| `packages/shared`        | Kode galat ke perilaku UI, rute per status, aturan sandi | Siap                                                                                                                                                            |
| `packages/config`        | Validasi environment                                     | Siap                                                                                                                                                            |
| `packages/design-tokens` | Token dari Guidelines KAPDH (CSS dan Dart)               | Siap                                                                                                                                                            |

## Menjalankan di lokal

Butuh Node 24 (`.nvmrc`), pnpm 10 (`corepack enable`), dan Docker Desktop.

```bash
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d   # PostgreSQL 17, Redis, Mailpit
pnpm --filter @kapdh/database db:migrate          # dengan DATABASE_URL dari .env
pnpm build && pnpm test
pnpm --filter @kapdh/api dev                      # http://localhost:3000/api/v1/health
pnpm --filter @kapdh/admin dev:mock               # http://localhost:5173 tanpa backend
pnpm --filter @kapdh/web dev                      # http://localhost:4321
```

Akun tiruan web admin (hanya mode mock): `admin@kapdh.test`, sandi `Kapdh#2026`, kode TOTP `123456`, backup code `A1B2C3D4E5`. Admin undangan tanpa TOTP: `baru@kapdh.test` (sandi sama, diarahkan ke /login/enroll).

### Super Admin pertama

```bash
pnpm --filter @kapdh/api build
pnpm --filter @kapdh/api admin:bootstrap --email bayu@kapdh.or.id --name "Bayu Musthafa"
```

Perintah mencetak **sekali** sandi awal, secret TOTP (dan URI `otpauth://` untuk dipindai), serta 8 backup code.
Simpan di password manager. Perintah menolak berjalan bila Super Admin aktif sudah ada.

### Environment baru (irisan Auth)

| Variabel            | Isi                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------- |
| `TOTP_ENC_KEY`      | 64 karakter hex (32 byte) untuk mengenkripsi secret TOTP admin (AES-256-GCM)          |
| `BCRYPT_COST`       | Default 12                                                                            |
| `SMTP_URL`          | Wajib di staging dan production; kosong di development berarti OTP dicetak ke log API |
| `VITE_API_BASE_URL` | Web admin produksi: `https://api.kapdh.or.id/api/v1`; lokal memakai proxy Vite        |

## CI

Workflow GitHub Actions ada di `infra/ci/github-actions-ci.yml`. Saat repository dibuat di GitHub, salin ke
`.github/workflows/ci.yml` (folder `.github` tidak bisa ditulis langsung dari sesi ini).

## Aturan kerja (PRD 7.2 dan 7.3)

- Ubah kontrak di `packages/contracts/openapi/domains/<domain>.yaml` (komponen bersama di `root.yaml`) lebih dulu,
  lalu `pnpm contracts:lint` dan `pnpm contracts:gen` (lihat `packages/contracts/README.md`).
- Satu tugas = satu irisan vertikal (endpoint, aturan domain, migrasi, UI, error state, uji) dengan ID F/N/AC.
- Frontend tidak mengimpor `@kapdh/database`, kode worker, atau secrets (dijaga ESLint).
- Mode mock hanya untuk mengembangkan UI; tidak dihitung sebagai bukti lulus acceptance criteria.
- Permintaan latar (polling) mengirim header `X-Background-Request: 1` agar tidak memperpanjang idle timeout admin.

## Verifikasi terakhir

`pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (109 uji), `pnpm format:check` dan `pnpm contracts:lint` lulus.
Uji integrasi API berjalan pada PGlite (PostgreSQL WASM) dengan semua migrasi, dan `test/contract.e2e.test.ts`
memvalidasi respons nyata terhadap skema OpenAPI. Uji asap tambahan: migrasi di PostgreSQL 16 asli, bootstrap admin,
lalu web admin di Chromium (login, TOTP, reload memulihkan sesi, keluar mencabut sesi) dan registrasi alumni lewat API.
SDK Dart `kapdh_api` dibangkitkan tanpa Java oleh `pnpm contracts:gen` (generator Node) ke
`packages/contracts/dart/kapdh_api/lib/src` dan dipakai kapdh-mobile lewat dependensi path.
