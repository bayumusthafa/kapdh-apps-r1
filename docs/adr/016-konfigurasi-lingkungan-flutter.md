# ADR-016: Lingkungan Flutter dipilih lewat `--dart-define-from-file`; push dikonfigurasi saat build tanpa berkas Firebase

- Status: Diterima (Fase B, mobile-foundation)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 5.3 (staging dan production terpisah, termasuk proyek push), 3.13; AC F13-2; N-07; D7, D10, D12;
  ARCHITECTURE §2 butir 4, §8
- Bukti di kode: `kapdh-mobile/config/{development,staging,production}.json`,
  `kapdh-mobile/lib/core/config/{api_config.dart,push_config.dart}`, `kapdh-mobile/README.md`,
  `kapdh-mobile/android/app/build.gradle.kts` (`applicationId = "id.or.kapdh.app"`, `minSdk = 26`),
  `kapdh-mobile/ios/Runner.xcodeproj` (`PRODUCT_BUNDLE_IDENTIFIER = id.or.kapdh.app`, iOS 15.0)

## Konteks

PRD 5.3 memisahkan staging dan production termasuk domain dan proyek push. Flavor Gradle/Xcode menggandakan
konfigurasi native, ID aplikasi, dan berkas `google-services.json`/`GoogleService-Info.plist` per lingkungan, yang
mudah tertukar dan cenderung ter-commit. Build rilis yang tanpa sengaja mengarah ke API pengembangan (HTTP) akan tampak
"offline" selamanya karena cleartext diblokir di rilis (N-07).

## Keputusan

1. Satu ID aplikasi `id.or.kapdh.app` untuk Android dan iOS. Lingkungan dipilih saat build dengan
   `--dart-define-from-file=config/<lingkungan>.json` yang memuat `KAPDH_ENV`, `API_BASE_URL` (berakhiran `/api/v1`),
   `PUSH_ENABLED`, dan `FIREBASE_*`.
2. `ApiConfig.resolve`: build rilis wajib `KAPDH_ENV` staging/production dan API https; bila tidak, aplikasi berhenti di
   layar "Aplikasi belum dapat dijalankan" (`ConfigErrorApp`). HTTP lokal hanya untuk build debug ke
   `10.0.2.2`/`localhost`.
3. Push opsional saat runtime: `PUSH_ENABLED=true` plus `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`,
   `FIREBASE_API_KEY`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID` diisi CI dari secret; Firebase diinisialisasi
   dari nilai itu (tanpa `google-services.json`). Tanpa nilai, atau bila inisialisasi gagal, aplikasi berjalan tanpa
   push dan inbox tetap tersedia (AC F13-2). Firebase hanya untuk FCM, bukan Auth/Firestore.

## Alternatif yang dipertimbangkan

- **Flavor Gradle + skema Xcode per lingkungan**: ditolak; dua ID aplikasi dan berkas native per lingkungan.
- **Berkas konfigurasi Firebase di repo**: ditolak; nilai per lingkungan dan risiko tertukar antara staging/production.

## Konsekuensi

- Staging dan production berbagi ID aplikasi: build staging (TestFlight/closed testing) dan production tidak dapat
  terpasang berdampingan pada satu perangkat; distribusi uji terbatas (D16) memakai jalur testing toko dengan build
  staging atau production sesuai rencana rilis.
- `config/staging.json` dan `config/production.json` di repo memuat `PUSH_ENABLED=false` dan nilai Firebase kosong;
  CI wajib menyuntikkan nilai sebenarnya dari secret saat build rilis.
- Android: rilis membutuhkan `android/key.properties` (tidak di-commit). iOS: entitlement Push Notifications dan
  Associated Domains belum ada di proyek (lihat `kapdh-mobile/README.md` Tindak lanjut rilis).
