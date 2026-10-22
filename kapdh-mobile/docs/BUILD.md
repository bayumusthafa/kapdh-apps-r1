# Build dan rilis kapdh-mobile

Panduan build lokal, CI dan toko aplikasi untuk aplikasi anggota KAPDH (Android/iOS). Rujukan: PRD 5.3 (lingkungan
terpisah), 7.1, 8.2 langkah 5-6, 8.3, 8.4; D7 (Android 8.0+, iOS 15+), D10 (FCM/APNs, akun toko organisasi), D13, D16
(uji terbatas, rilis bertahap, akun demo reviewer); N-13 (versi aplikasi minimum). Pipeline platform:
`docs/runbooks/ci-cd.md` di akar repo.

## 1. Prasyarat

| Alat | Versi | Catatan |
| --- | --- | --- |
| Flutter / Dart | 3.47.2 / 3.13.2 | Dipin; `pubspec.lock` dikunci untuk versi ini. CI: `.github/actions/setup-flutter`. |
| JDK | 21 (Temurin) | Untuk build Android (Gradle 9, AGP 9). Mesin build Windows: Temurin 21 lewat `flutter config --jdk-dir`; APK debug/profile sudah dibangun dan dijalankan di emulator Android 15 pada Phase D (`../../docs/qa/device-matrix.md`). Build rilis bertanda tangan (bagian 3.2) hanya di mesin tepercaya yang memegang kunci unggah; IPA hanya di macOS + Xcode (belum dibangun). |
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
  `--dart-define-from-file=/tmp/kapdh-build.json`; hapus berkas sementara sesudahnya. Tanpa `jq` (mesin Windows),
  gabungkan dengan Node; berkas kedua menimpa kunci yang sama:
  `node -e "const f=require('fs');const [a,b,o]=process.argv.slice(1);f.writeFileSync(o,JSON.stringify({...JSON.parse(f.readFileSync(a,'utf8')),...JSON.parse(f.readFileSync(b,'utf8'))},null,2))" config/production.json /aman/firebase-production.json /aman/kapdh-build.json`.
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

`android/app/build.gradle.kts` memakai berkas ini bila ada. Tanpa berkas itu:

- **AAB rilis ditolak.** Graf task yang memuat `bundle*Release` (`flutter build appbundle --release`,
  `gradlew bundleRelease`) atau task AGP penghasil AAB `package*ReleaseBundle` / `sign*ReleaseBundle` (juga ikut di graf
  setiap task turunan AAB) gagal sebelum task apa pun berjalan dengan `GradleException` "Build AAB rilis (...)
  dihentikan: android/key.properties tidak ditemukan ..." yang merujuk bagian ini. Penjaga memakai
  `gradle.taskGraph.whenReady` (aman untuk configuration cache). Jalur yang dijaga itulah satu-satunya jalur Gradle
  penghasil AAB rilis, sehingga AAB rilis bertanda tangan kunci debug tidak dibuat tanpa kunci unggah.
- **Pengecualian:** 'Generate Signed Bundle / APK' di Android Studio menyuntikkan kunci rilis lewat properti
  `-Pandroid.injected.signing.store.file` (dan `android.injected.signing.*` lain) tanpa `key.properties`. AGP
  menandatangani dengan kunci itu, jadi penjaga tidak menghentikannya. Pastikan yang dipilih di wizard adalah kunci
  unggah, bukan `debug.keystore`.
- **APK rilis tetap dapat dibangun** (`flutter build apk --release`) dan ditandatangani kunci debug. APK seperti itu
  hanya untuk uji internal di perangkat sendiri (pasang manual), TIDAK untuk toko aplikasi.
- Build debug/profile dan workflow APK debug di CI (bagian 3.3) tidak terpengaruh.

Pemeriksaan penanda tangan artefak: `<android-sdk>/build-tools/<versi>/apksigner verify --print-certs <apk>` untuk APK
(minSdk 26 sehingga APK hanya memakai skema v2 dan `keytool -printcert -jarfile` menjawab "Not a signed jar file"), atau
`keytool -printcert -jarfile <aab>` untuk AAB. DN `CN=Android Debug` berarti kunci debug.

### 3.2 Build rilis

```bash
flutter build appbundle --release --dart-define-from-file=<berkas gabungan production> \
  --obfuscate --split-debug-info=build/symbols/<versi>
```

- Versi dari `pubspec.yaml` `version: X.Y.Z+N`: `N` (versionCode) naik setiap unggahan; `X.Y.Z` wajib >=
  `info.x-kapdh-min-app-version` kontrak (saat ini `1.0.0`) dan >= `app_settings.min_app_version` production; versi
  di bawahnya ditolak API dengan 426 UPGRADE_REQUIRED (PRD 4.5). `pubspec.yaml` saat ini `1.0.0+1` (sama dengan
  `min_app_version` seed); naikkan `N` untuk setiap unggahan berikutnya.
- Simpan `build/symbols/<versi>` bersama artefak rilis (di luar repo) untuk membaca stack trace.
- App Links (`https://kapdh.or.id/app` dan `/app/<rute>`, intent-filter `autoVerify` di `AndroidManifest.xml`, dijaga
  `test/platform/app_links_config_test.dart`) baru terverifikasi setelah
  `https://kapdh.or.id/.well-known/assetlinks.json` memuat SHA-256 **kunci penandatanganan aplikasi** Play App Signing
  (Play Console > Setup > App integrity > App signing key certificate), bukan kunci unggah. Berkas itu diterbitkan
  dari `kapdh-platform/apps/web/app-links.json` (`android.sha256_cert_fingerprints`); selama kosong berkas 404. Sidik
  baru tampil setelah AAB pertama diunggah ke Play Console (jalur pengujian internal cukup), bukan sekadar setelah
  aplikasi dibuat; AAB rilis itu butuh `android/key.properties` (bagian 3.1). Jangan menerbitkan nilai contoh.
  Pemeriksaan di perangkat Android 12+ setelah memasang build dari Play:

  ```bash
  adb shell pm verify-app-links --re-verify id.or.kapdh.app
  adb shell pm get-app-links id.or.kapdh.app   # kapdh.or.id harus berstatus verified
  ```

  Status selain `verified` berarti berkas tidak terjangkau atau sidiknya tidak cocok, dan tautan dibuka di peramban.
  APK bertanda tangan kunci debug (bagian 3.4) tidak lolos verifikasi ini.
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

### 3.4 APK uji internal dengan push (kunci debug)

Untuk uji push di ponsel pengurus sebelum kunci unggah ada: gabungkan `config/production.json` dengan nilai Firebase
production di luar repo (bagian 2), lalu `flutter build apk --release --dart-define-from-file=<berkas gabungan>`.
Salin `build/app/outputs/flutter-apk/app-release.apk` ke folder aman di luar repo, catat SHA-256-nya, dan pasang manual
(izinkan "Instal aplikasi tidak dikenal"). APK ini bertanda tangan kunci debug: Play menolaknya, dan versi Play kelak
tidak dapat dipasang di atasnya tanpa menghapus aplikasi lebih dulu (tanda tangan berbeda). Versi build harus >=
`min_app_version` production agar login dan pendaftaran token push tidak ditolak 426.

## 4. iOS (macOS + Xcode)

- Bundle identifier `id.or.kapdh.app`, iOS 15.0 (D7), akun Apple Developer Program atas nama organisasi dengan
  D-U-N-S (D10). Sertifikat dan profil tidak di-commit.
- Entitlement ada di repo: `ios/Runner/Runner.entitlements`, dipasang lewat `CODE_SIGN_ENTITLEMENTS` di konfigurasi
  Debug, Release dan Profile target Runner saja (dijaga `test/platform/app_links_config_test.dart`):
  - `aps-environment` `development`, nilai bawaan Xcode saat capability Push Notifications ditambahkan. Ekspor App
    Store/TestFlight menandatangani ulang dengan profil distribusi sehingga artefak berisi `production`. Jangan
    mengubahnya menjadi `production` di repo: build pengembangan di iPhone gagal ditandatangani.
  - Associated Domains `applinks:kapdh.or.id` untuk Universal Links `https://kapdh.or.id/app/<rute>`. Hanya domain
    apex: `www.kapdh.or.id` dialihkan 301 ke apex sehingga tidak dapat diklaim. Tanpa domain staging dan tanpa
    `?mode=developer`.
  - Background Modes > Remote notifications sudah ada di `Info.plist`.
- Memilih Team: buka `ios/Runner.xcworkspace` di Xcode, target Runner > Signing & Capabilities, aktifkan
  "Automatically manage signing" lalu pilih Team organisasi. Xcode menulis `DEVELOPMENT_TEAM` (Team ID 10 karakter)
  ke konfigurasi target Runner di `project.pbxproj`. Team ID bukan rahasia (ikut terbit di
  `apple-app-site-association`) sehingga perubahan itu boleh di-commit; uji konfigurasi menolak nilai contoh. Kedua
  capability tampil dari berkas entitlement di atas, dan signing otomatis mengaktifkannya pada App ID
  `id.or.kapdh.app`.
- Kunci APNs (`.p8`) WAJIB sudah diunggah ke proyek Firebase yang dipakai build itu (`FIREBASE_PROJECT_ID` di berkas
  `--dart-define-from-file`, bagian 5) SEBELUM build yang membawa entitlement ini dibagikan: `kapdh-prod` untuk build
  production, proyek Firebase staging untuk build staging yang dibagikan lewat TestFlight (ADR-016). Jalur TestFlight
  dapat membawa build staging maupun production, jadi yang menentukan adalah proyek build, bukan jalur distribusinya.
  Berkas `.p8` yang sama boleh diunggah ke kedua proyek (`../../docs/runbooks/push-fcm.md` bagian 8). Tanpa kunci itu
  setiap kiriman ke token iOS ditolak FCM `THIRD_PARTY_AUTH_ERROR` (tercatat `AUTH_ERROR` di riwayat pengiriman web
  admin) dan tidak dicoba ulang. Kunci disimpan di password manager.
- Universal Links baru aktif setelah `https://kapdh.or.id/.well-known/apple-app-site-association` terbit. Berkas itu
  diterbitkan dari `kapdh-platform/apps/web/app-links.json` begitu Team ID diketahui dan diisi di `ios.app_id_prefix`
  (selama kosong berkas 404), dengan path yang sama dengan App Links Android (`/app` dan `/app/*`). iOS tidak
  mengambil berkas langsung dari kapdh.or.id, tetapi dari CDN Apple saat aplikasi dipasang, dan salinan CDN
  diperbarui berkala. Setelah berkas berubah, ulangi
  `curl -fsS https://app-site-association.cdn-apple.com/a/v1/kapdh.or.id` sampai isinya sama dengan berkas yang terbit,
  baru pasang ulang aplikasi untuk menguji (`../../docs/runbooks/app-store-submission.md` bagian 1, langkah 2 tautan
  HTTPS).
- Build: `flutter build ipa --release --dart-define-from-file=<berkas gabungan production> --obfuscate
  --split-debug-info=build/symbols/<versi>`, unggah lewat Xcode Organizer atau Transporter, uji lewat TestFlight
  (D16), rilis bertahap (phased release, PRD 8.3).
- Periksa entitlement artefak setelah ekspor, sebelum diunggah:

  ```bash
  rm -rf /tmp/kapdh-ipa && unzip -q build/ios/ipa/*.ipa -d /tmp/kapdh-ipa
  codesign -d --entitlements :- /tmp/kapdh-ipa/Payload/Runner.app
  ```

  Keluarannya wajib memuat `aps-environment` bernilai `production` dan `com.apple.developer.associated-domains` berisi
  `applinks:kapdh.or.id`. Nilai `development` berarti IPA diekspor dengan profil pengembangan; jangan diunggah.
- Isi kepatuhan ekspor (`ITSAppUsesNonExemptEncryption`) saat unggahan pertama: aplikasi hanya memakai enkripsi
  standar sistem (HTTPS); konfirmasi oleh pemilik produk.
- Tidak ada runner macOS di CI saat ini; build iOS dilakukan di Mac tepercaya.

## 5. Firebase (hanya FCM)

- Firebase dipakai HANYA untuk push FCM/APNs (ARCHITECTURE §2 butir 4). Proyek Firebase staging dan production
  terpisah (PRD 5.3).
- Aplikasi membaca opsi Firebase dari `--dart-define` (`PushConfig`): `PUSH_ENABLED=true`, `FIREBASE_PROJECT_ID`,
  `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID`. Tanpa nilai
  itu, atau bila inisialisasi gagal, aplikasi berjalan tanpa push (AC F13-2).
- Production: nilai di atas disimpan di luar repo, di `C:\kapdh-secure\firebase-production.json` pada PC build
  (berisi enam kunci itu saja). Proyeknya wajib `kapdh-prod`, sama dengan `FCM_PROJECT_ID` server. Token dari build
  dengan proyek lain ditolak FCM (`SENDER_ID_MISMATCH`) lalu dinonaktifkan server. Cara memperoleh setiap nilai, cara
  memeriksa berkas tanpa menampilkan kunci API, dan cara memvalidasi token perangkat dengan `push-selftest`:
  `../../docs/runbooks/push-fcm.md` bagian 2.4-2.5, 5.3, dan 6.
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
