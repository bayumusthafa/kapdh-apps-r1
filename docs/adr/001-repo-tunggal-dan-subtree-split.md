# ADR-001: Satu repository selama build, `git subtree split` untuk repo Flutter saat rilis

- Status: Diterima (diterapkan sejak Fase A)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 7.2, N-13; ARCHITECTURE §1, §6; BUILD_PLAN fase A
- Bukti di kode: `kapdh-mobile/pubspec.yaml` (dependensi `kapdh_api` lewat `path`),
  `kapdh-platform/packages/contracts/scripts/release-dart-sdk.mjs`, skrip root `pnpm contracts:release-sdk`

## Konteks

PRD 7.2 menetapkan backend dan web dalam satu monorepo, sedangkan Flutter berada di repository tersendiri yang memakai
SDK Dart bertag versi dari `packages/contracts`. Selama build R1.0, kontrak OpenAPI, SDK Dart terbangkit, API dan
aplikasi Flutter berubah bersamaan dalam satu irisan vertikal (PRD 7.3). Bila Flutter sudah dipisah sejak awal, setiap
perubahan kontrak memerlukan rilis SDK, tag, dan pembaruan dependensi di repo lain sebelum layar dapat diuji, dan
pekerjaan paralel tidak dapat memverifikasi kontrak terhadap klien dalam satu worktree.

## Keputusan

1. Selama build ada **satu** repository git `KAPDHAPPS` (cabang `main`) berisi `docs/`, `kapdh-platform/` dan
   `kapdh-mobile/`.
2. `kapdh-mobile` memakai SDK lewat dependensi path
   (`kapdh_api: path: ../kapdh-platform/packages/contracts/dart/kapdh_api`). Kode SDK di `lib/src/**` dibangkitkan
   (`pnpm contracts:gen`) dan tidak di-commit.
3. Saat rilis:
   - `pnpm contracts:release-sdk -- --dry-run`, lalu `pnpm contracts:release-sdk` (dari `kapdh-platform/`) membuat
     commit rilis terpisah yang memuat `lib/src` terbangkit dan tag beranotasi `contracts-v<versi>`; versi
     `packages/contracts/package.json` wajib sama dengan `dart/kapdh_api/pubspec.yaml`. Tag lalu di-push.
   - `git subtree split -P kapdh-mobile -b mobile-release` menghasilkan riwayat khusus Flutter yang di-push ke repo
     Flutter terpisah.
   - Di repo Flutter, dependensi path diganti dependensi git bertag:
     `kapdh_api: git: {url: <repo KAPDHAPPS>, path: kapdh-platform/packages/contracts/dart/kapdh_api, ref: contracts-vX.Y.Z}`.

## Alternatif yang dipertimbangkan

- **Repo Flutter terpisah sejak awal** (PRD 7.2 apa adanya): ditolak untuk masa build karena biaya koordinasi kontrak
  dan tidak ada verifikasi lintas klien dalam satu commit.
- **Registry pub privat**: diizinkan PRD 7.2, tetapi menambah infrastruktur yang belum ada; dependensi git bertag
  cukup untuk R1.0.

## Konsekuensi

- Satu commit dapat mengubah kontrak, API, admin dan Flutter sekaligus, dan `flutter analyze` memverifikasi SDK
  terbaru.
- Klon baru `kapdh-mobile` wajib menjalankan `pnpm install && pnpm build` (atau `pnpm contracts:gen`) di
  `kapdh-platform` sebelum `flutter pub get`.
- Pemisahan repo menjadi langkah rilis manual yang harus tercatat (tag SDK, hash subtree) di paket bukti go-live
  (`docs/runbooks/go-live.md`).
- URL repo git untuk dependensi SDK ditetapkan saat repo Flutter dibuat; belum ada di kode.
