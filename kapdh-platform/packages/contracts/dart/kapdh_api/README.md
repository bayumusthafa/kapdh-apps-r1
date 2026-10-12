# kapdh_api

SDK Dart KAPDH Apps yang dibangkitkan dari kontrak OpenAPI `packages/contracts` (PRD 5.2, N-13).

- Ditulis tangan dan di-commit: `pubspec.yaml`, `analysis_options.yaml`, `lib/kapdh_api.dart`, `test/`.
- Dibangkitkan dan di-gitignore: `lib/src/**`. Jalankan `pnpm contracts:gen` di `kapdh-platform` (setelah pull atau
  setelah kontrak berubah). Jangan menyunting `lib/src` dengan tangan.

Verifikasi (dari direktori ini, PATH berisi `C:\flutter\flutter\bin`):

```
dart.bat pub get
dart.bat analyze
dart.bat test
```

Pemakaian ringkas ada di dokumentasi `lib/kapdh_api.dart`; konvensi lengkap di `packages/contracts/README.md`.
