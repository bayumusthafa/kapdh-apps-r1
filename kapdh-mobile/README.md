# KAPDH Mobile

Aplikasi anggota KAPDH Apps untuk Android dan iOS (Flutter, Riverpod, go_router, Dio). PRD v3.5.

## Isi Tahap 0

- Tema KAPDH dari Guidelines (`lib/app/theme`, disalin dari `packages/design-tokens` di kapdh-platform).
- Router dengan pengalihan berdasarkan `effective_status` dari server (`lib/app/redirect.dart`, PRD 2.2).
- Klien API dengan refresh token satu jalur (`lib/core/api/api_client.dart`, AC F02-3) dan galat baku.
- Layar irisan Auth: login, daftar (Data Diri tanpa Nomor KTP, hitung tahun otomatis, penghitung byte sandi), OTP.
- Layar lain masih penanda, dibangun pada irisan berikutnya (Iuran, KTA, Konten).

## Menjalankan

```bash
flutter create . --org id.or.kapdh --platforms android,ios   # sekali, membuat folder android/ dan ios/
flutter pub get
flutter analyze && flutter test
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```

`10.0.2.2` adalah alamat komputer dari emulator Android. Untuk perangkat fisik, pakai IP komputer di jaringan lokal.

## Catatan

- Kode ini belum dikompilasi: Flutter SDK tidak tersedia di lingkungan pembuatnya. Jalankan `flutter analyze` lebih
  dulu dan sesuaikan versi paket di `pubspec.yaml` dengan `flutter pub outdated` bila ada yang tidak cocok.
- Klien API saat ini ditulis tangan untuk endpoint Auth. Setelah `kapdh_api` (dart-dio dari OpenAPI) dipublikasikan,
  ganti `AuthApi` dengan klien terbangkit.
- Token disimpan di secure storage; logout menghapus token. Cache KTA offline (maks 7 hari) ditambahkan pada irisan KTA.
