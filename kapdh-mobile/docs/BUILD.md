# Build dan rilis kapdh-mobile

Panduan build lokal, CI dan toko aplikasi untuk aplikasi anggota KAPDH (Android/iOS). Rujukan: PRD 5.3 (lingkungan
terpisah), 7.1, 8.2 langkah 5-6, 8.3, 8.4; D7 (Android 8.0+, iOS 15+), D10 (FCM/APNs, akun toko organisasi), D13, D16
(uji terbatas, rilis bertahap, akun demo reviewer); N-13 (versi aplikasi minimum). Pipeline platform:
`docs/runbooks/ci-cd.md` di akar repo.

## 1. Prasyarat

| Alat | Versi | Catatan |
| --- | --- | --- |
| Flutter / Dart | 3.47.2 / 3.13.2 | Dipin; `pubspec.lock` dikunci untuk versi ini. CI: `.github/actions/setup-flutter`. |
| JDK | 21 (Temurin) | Untuk build Android (Gradle 9, AGP 9). Tidak ada di mesin build Windows; build Android dilakukan CI atau mesin lain. |
| Android SDK | sesuai `flutter.compileSdkVersion` | minSdk 26 (Android 8.0, D7). |
| Xcode + CocoaPods | versi yang didukung Flutter 3.47 | Hanya macOS. Deployment target iOS 15.0 (D7). |
| SDK `kapdh_api` | dibangkitkan | `cd ../kapdh-platform && pnpm install && pnpm contracts:gen`, lalu `flutter pub get`. |

## 2. Lingkungan: staging dan production lewat `--dart-define-from-file`

Lingkungan dipilih saat build, bukan dengan flavor Gradle/Xcode: satu ID aplikasi `id.or.kapdh.app` (Android
`applicationId` dan iOS bundle identifier) dan perintah yang sama di kedua platform.

| Berkas | `KAPDH_ENV` | `API_BASE_URL` | Dipakai untuk |
| --- | --- | --- | --- |
| `config/development.json` | development | `http://10.0.2.2:3000/api/v1` | emulator, hanya build debug |
| `config/staging.json` | staging | `https://staging-api.kapdh.or.id/api/v1` | pengurus/QA, track internal |
| `config/production.json` | production | `https://api.kapdh.or.id/api/v1` | toko aplikasi, TestFlight/closed testing D16 |

```bash
flutter run --dart-define-from-file=config/development.json
flutter build apk --debug --dart-define-from-file=config/staging.json
flutter build appbundle --release --dart-define-from-file=config/production.json
```

- Build rilis yang tidak menyebut staging/production dengan API https berhenti di layar "Aplikasi belum dapat
  dijalankan" (`ApiConfig.resolve`), tidak pernah diam-diam memakai API pengembangan (N-07).
- Berkas `config/*.json` di repo TIDAK memuat nilai rahasia atau nilai Firebase. Nilai Firebase lingkungan
  diberikan saat build (bagian 5) dengan menggabungkan berkas sementara di luar repo, misalnya:
  `jq -s add config/production.json /aman/firebase-production.json > /tmp/kapdh-build.json` lalu
  `--dart-define-from-file=/tmp/kapdh-build.json`; hapus berkas sementara sesudahnya.
- Karena ID aplikasi sama, build staging dan production tidak dapat terpasang berdampingan di satu perangkat. Bila
  kelak diperlukan, akhiran ID per lingkungan memerlukan ADR (proyek Firebase, listing dan App Links terpisah).

## 3. Android

### 3.1 Kunci unggah dan `android/key.properties` (tidak pernah di-commit)

Gunakan Play App Signing: Google memegang kunci penandatanganan aplikasi, organisasi memegang **kunci unggah**.

```bash
keytool -genkeypair -v -keystore kapdh-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

Simpan keystore dan sandinya di password manager organisasi dengan satu salinan cadangan terpisah (pola D9), bukan di
repo, drive bersama atau chat. `android/key.properties` (diabaikan `.gitignore`, begitu juga `*.jks`/`*.keystore`):

```properties
storePassword=<dari password manager>
keyPassword=<dari password manager>
keyAlias=upload
storeFile=/path/absolut/di/luar/repo/kapdh-upload.jks
```

`android/app/build.gradle.kts` memakai berkas ini bila ada. Tanpa berkas itu build rilis ditandatangani kunci debug
dan TIDAK boleh diunggah (Play menolaknya).

### 3.2 Build rilis

```bash
flutter build appbundle --release --dart-define-from-file=<berkas gabungan production> \
  --obfuscate --split-debug-info=build/symbols/<versi>
```

- Versi dari `pubspec.yaml` `version: X.Y.Z+N`: `N` (versionCode) naik setiap unggahan; `X.Y.Z` wajib >=
  `info.x-kapdh-min-app-version` kontrak (saat ini `1.0.0`) dan >= `app_settings.min_app_version` production; versi
  di bawahnya ditolak API dengan 426 UPGRADE_REQUIRED (PRD 4.5). `pubspec.yaml` saat ini `0.1.0+1` dan harus
  dinaikkan sebelum rilis toko.
- Simpan `build/symbols/<versi>` bersama artefak rilis (di luar repo) untuk membaca stack trace.
- App Links: `https://kapdh.or.id/.well-known/assetlinks.json` memuat SHA-256 kunci penandatanganan dari Play Console.
- Ikon notifikasi monokrom dan ikon tema Android 13: lihat "Tindak lanjut rilis" di `README.md`.

### 3.3 APK debug di CI

`.github/workflows/mobile-android.yml` membangun `flutter build apk --debug` (JDK 21, Android SDK lewat
`android-actions/setup-android`, Flutter terpin) secara manual (pilih `config/<lingkungan>.json`) atau otomatis bila
`android/**` atau `pubspec.*` berubah di main, lalu menyimpan APK 7 hari. APK debug ditandatangani kunci debug dan
hanya untuk pemeriksaan internal. Workflow ini opsional, bukan bagian status wajib "CI lulus"; uji Flutter wajib
(`flutter analyze`, `dart format`, `flutter test`) berjalan di `ci.yml`.

Penandatanganan rilis di CI belum dibuat untuk R1.0 (build rilis dari mesin tepercaya). Bila ditambahkan: environment
GitHub `mobile-release` dengan reviewer, secrets `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`,
`ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` yang ditulis ke `$RUNNER_TEMP` dan `android/key.properties`
hanya selama job, lalu dihapus.

## 4. iOS (macOS + Xcode)

- Bundle identifier `id.or.kapdh.app`, iOS 15.0 (D7), akun Apple Developer Program atas nama organisasi dengan
  D-U-N-S (D10). Team ID diatur di Xcode (Signing & Capabilities); sertifikat dan profil tidak di-commit.
- Capability: Push Notifications (entitlement `aps-environment` production untuk Release), Background Modes >
  Remote notifications (sudah ada di `Info.plist`), Associated Domains `applinks:kapdh.or.id` untuk Universal Links
  dengan `apple-app-site-association` di kapdh.or.id. Berkas `Runner.entitlements` belum ada di repo dan dibuat saat
  capability diaktifkan.
- Kunci APNs (`.p8`) diunggah ke proyek Firebase lingkungan yang sesuai; kunci disimpan di password manager.
- Build: `flutter build ipa --release --dart-define-from-file=<berkas gabungan production> --obfuscate
  --split-debug-info=build/symbols/<versi>`, unggah lewat Xcode Organizer atau Transporter, uji lewat TestFlight
  (D16), rilis bertahap (phased release, PRD 8.3).
- Isi kepatuhan ekspor (`ITSAppUsesNonExemptEncryption`) saat unggahan pertama: aplikasi hanya memakai enkripsi
  standar sistem (HTTPS); konfirmasi oleh pemilik produk.
- Tidak ada runner macOS di CI saat ini; build iOS dilakukan di Mac tepercaya.

## 5. Firebase (hanya FCM)

- Firebase dipakai HANYA untuk push FCM/APNs (ARCHITECTURE §2 butir 4). Proyek Firebase staging dan production
  terpisah (PRD 5.3).
- Aplikasi membaca opsi Firebase dari `--dart-define` (`PushConfig`): `PUSH_ENABLED=true`, `FIREBASE_PROJECT_ID`,
  `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`. Tanpa nilai
  itu, atau bila inisialisasi gagal, aplikasi berjalan tanpa push (AC F13-2).
- `google-services.json` dan `GoogleService-Info.plist` TIDAK dipakai (tanpa plugin Gradle google-services) dan
  diabaikan git (`android/app/google-services.json`, `android/app/src/*/google-services.json`,
  `ios/Runner/GoogleService-Info.plist`). Bila kelak plugin membutuhkannya, berkas hanya ditaruh di path tersebut
  saat build dari penyimpanan rahasia, tidak pernah di-commit.
- Kredensial server FCM (`FCM_SERVICE_ACCOUNT_JSON`) hanya di environment API/worker, tidak di aplikasi.

## 6. Daftar periksa rilis toko (PRD 8.2 langkah 6, 8.3, D16)

1. Tag kontrak `contracts-vX.Y.Z` sudah ada dan build memakai SDK dari kontrak itu (N-13). Ini juga berlaku untuk
   build pertama yang dibagikan ke penguji (D16): sejak tag itu, CI membandingkan setiap perubahan kontrak HTTP dan
   event realtime dengannya. Rilis backend (`release.yml`) gagal bila tag `contracts-v*` belum ada.
2. Backend production aktif dan lulus smoke test (reviewer memerlukan layanan yang berfungsi).
3. Versi `pubspec.yaml` >= versi aplikasi minimum; build memakai konfigurasi production, push production aktif,
   simbol obfuscation diarsipkan.
4. URL kebijakan privasi, `/delete-account`, formulir keamanan data, kontak moderasi, catatan reviewer tentang iuran
   organisasi (D13) dan akun demo reviewer aktif dan belum bayar (D16).
5. Uji terbatas 2-3 minggu (TestFlight/closed testing), lalu staged rollout/phased release.
6. Naikkan `app_settings.min_app_version` hanya setelah versi baru dapat diunduh di kedua toko (PRD 8.4).
