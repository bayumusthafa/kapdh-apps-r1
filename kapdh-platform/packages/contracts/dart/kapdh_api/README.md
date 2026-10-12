# kapdh_api

SDK Dart KAPDH Apps yang dibangkitkan dari kontrak OpenAPI dan skema event realtime `packages/contracts`
(PRD 5.2, N-13).

- Ditulis tangan dan di-commit: `pubspec.yaml`, `analysis_options.yaml`, `lib/kapdh_api.dart`, `test/`.
- Dibangkitkan dan di-gitignore: `lib/src/**`. Jalankan `pnpm contracts:gen` di `kapdh-platform` (setelah pull atau
  setelah kontrak berubah). Jangan menyunting `lib/src` dengan tangan.

Verifikasi (dari `kapdh-platform`): `pnpm contracts:test-dart`, atau manual dari direktori ini dengan PATH berisi
`C:\flutter\flutter\bin`:

```
dart.bat pub get
dart.bat analyze --fatal-infos
dart.bat test
```

## Catatan pemakaian

- Interceptor aplikasi yang mengirim ulang request (mis. refresh token saat 401) wajib memakai
  `dio.fetch(retryableRequest(error.requestOptions))`: body multipart (`FormData`) yang sudah terkirim tidak dapat
  dikirim lagi tanpa diklon.
- `ApiException.kind`: `network` hanya untuk koneksi/timeout/galat I/O (tampilkan offline, jangan hapus token);
  `unexpected` untuk galat pemrograman/interceptor atau sertifikat ditolak (bukan offline; catat `cause`).
- Event Socket.IO didekode dengan `RealtimeEvent.fromJson(data)`; abaikan `UnknownRealtimeEvent`.

## Rilis

Repo Flutter terpisah (ADR-001) memakai dependensi git ke tag `contracts-vX.Y.Z` yang dibuat
`pnpm contracts:release-sdk`; tag itu menunjuk commit rilis yang berisi `lib/src` terbangkit (branch tidak pernah
berisi kode terbangkit). Lihat bagian "Rilis SDK" di `packages/contracts/README.md`.

Konvensi lengkap ada di `packages/contracts/README.md`; perubahan per versi di `packages/contracts/CHANGELOG.md`.
