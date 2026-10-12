# @kapdh/contracts

Kontrak API KAPDH Apps (OpenAPI 3.1) untuk domain P0 dan P1: auth, me/membership, payments,
files, content, notifications, account deletion, public, serta admin auth, pembayaran dan biaya.

- `openapi/openapi.yaml`: sumber kontrak. Ubah kontrak di sini lebih dulu, lalu bangkitkan klien.
- `pnpm lint`: validasi dengan Redocly.
- `pnpm generate`: tipe TypeScript ke `src/generated/api.ts` (dipakai web admin dan situs publik).
- `pnpm generate:dart`: klien Dart (dart-dio) ke `generated/dart`, butuh Java 11+. Hasilnya
  dipublikasikan ke repository Flutter sebagai paket `kapdh_api` bertag versi (PRD 7.2).

Perubahan yang memutus versi klien yang masih didukung harus gagal di CI (N-13).
