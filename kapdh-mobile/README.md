# KAPDH Mobile

Aplikasi anggota KAPDH Apps untuk Android dan iOS (Flutter 3.47, Riverpod 3, go_router 16, Dio 5 + SDK terbangkit
`kapdh_api`). PRD v3.5; aturan rekayasa di `docs/ARCHITECTURE.md` §8.

## Menyiapkan

SDK Dart dibangkitkan dari kontrak OpenAPI dan tidak di-commit. Jalankan sekali setelah pull:

```bash
cd ../kapdh-platform && pnpm install && pnpm build && pnpm contracts:gen
cd ../kapdh-mobile && flutter pub get
flutter analyze && flutter test
```

Di mesin build Windows (Git Bash): `export PATH="/c/flutter/flutter/bin:$PATH"` lalu pakai `flutter.bat`.

## Lingkungan (flavor)

Lingkungan dipilih saat build lewat `--dart-define-from-file`, bukan flavor Gradle/Xcode, sehingga satu ID aplikasi
(`id.or.kapdh.app`) dan perintah yang sama dipakai di kedua platform:

| Berkas                     | `KAPDH_ENV`   | API                                       |
| -------------------------- | ------------- | ----------------------------------------- |
| `config/development.json`  | development   | `http://10.0.2.2:3000/api/v1` (emulator)  |
| `config/staging.json`      | staging       | `https://staging-api.kapdh.or.id/api/v1`  |
| `config/production.json`   | production    | `https://api.kapdh.or.id/api/v1`          |

```bash
flutter run --dart-define-from-file=config/development.json
flutter build appbundle --dart-define-from-file=config/staging.json
```

- `API_BASE_URL` wajib berakhiran `/api/v1`; staging/production wajib HTTPS (N-07). HTTP lokal hanya diizinkan build
  debug ke `10.0.2.2`/`localhost` (`android/app/src/debug/res/xml/network_security_config.xml`).
- Push opsional: `PUSH_ENABLED=true` plus `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_API_KEY`,
  `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID` (diisi CI, proyek Firebase terpisah per lingkungan, PRD 5.3). Tanpa
  itu, atau bila inisialisasi Firebase gagal, aplikasi berjalan tanpa push (AC F13-2). Berkas
  `google-services.json`/`GoogleService-Info.plist` tidak dipakai dan tidak di-commit.

## Struktur

```
lib/
  main.dart, bootstrap.dart   inisialisasi (format tanggal id + zona waktu, package_info, ProviderScope)
  app/                        app.dart, router.dart (SEMUA rute §8.4), redirect.dart (matriks PRD 2.2, fungsi murni),
                              app_shell.dart (tab Beranda/Event/KTA/Jejaring/Akun), app_services.dart (push+realtime
                              terikat sesi), routes.dart, theme/
  core/
    api/        Dio + interceptor (X-App-Version, X-App-Platform, X-Request-Id; auth + refresh; sinyal galat),
                RefreshCoordinator (satu refresh untuk HTTP, socket dan push), IdempotencyStore, ErrorPresenter
    app_gate/   GET /public/config: wajib update (semver) dan maintenance
    session/    SessionController (unknown, anonymous, authenticated, offlineLastKnown), AuthRepository, MeRepository
    cache/      KtaCacheStore (aturan offline 7 hari, AC F05-2..F05-4)
    storage/    TokenStore (satu nilai JSON atomik), SecureStore
    realtime/   RealtimeClient Socket.IO /realtime (backoff, deduplikasi event_id, RealtimeEvent.fromJson)
    push/       PushService + FirebasePushPlatform (izin, PUT /devices, notifikasi latar depan, ketukan → router)
    format/     Rupiah dari Money string, WIB/WITA/WIT, waktu relatif, hitung mundur
    deep_link/  normalisasi kapdh://app/... dan https://kapdh.or.id/app/...
    ui/         kunci navigator/messenger global, dialog reautentikasi, kontak dukungan
  design/       design system (prototipe layar 1 sampai 7, guideline hal. 4 sampai 8); impor lewat design.dart
  features/<f>/ layar per fitur. Nyata: system (splash, wajib update, maintenance), auth (login, daftar, OTP),
                status (portal pembatasan, status penghapusan). Lainnya penanda "Sedang dibangun" (fase C).
```

Aturan yang wajib diikuti fitur:

- Panggil API hanya lewat `kapdhApiProvider` (SDK terbangkit) atau repositori di atasnya; galat selalu `ApiException`.
  Tampilkan galat lewat `errorPresenterProvider` (katalog `ErrorUiAction`) atau field_errors di field form.
- Mutasi dengan Idempotency-Key memakai `idempotencyStoreProvider.run(intent, body, (key) => ...)`.
- Navigasi status ditentukan router; layar tidak menghitung effective_status. Tambah rute baru di `routes.dart`,
  `router.dart` dan matriks `redirect.dart` beserta ujinya.
- Teks pengguna dan komentar berbahasa Indonesia dengan rujukan PRD; status selalu label + ikon (`StatusBadge`).

## Uji

`flutter test` menjalankan uji unit dan widget tanpa jaringan (`test/support/fakes.dart`: adapter HTTP palsu, jam uji,
secure storage memori; `test/support/app_harness.dart`: aplikasi lengkap dari splash). Font runtime dimatikan di
`test/flutter_test_config.dart`.

## Tindak lanjut rilis

- Bundel TTF Poppins sebagai aset dan matikan `GoogleFonts.config.allowRuntimeFetching` (saat ini Poppins diunduh
  saat runtime dengan font sistem sebagai cadangan; ARCHITECTURE §8.1).
- Android: kunci rilis (`android/key.properties`), `assetlinks.json` di kapdh.or.id untuk App Links, ikon notifikasi
  monokrom.
- iOS: tim Apple, entitlement Push Notifications (`aps-environment`) dan Associated Domains `applinks:kapdh.or.id`
  untuk Universal Links; kunci APNs di proyek Firebase.
- Tidak ada build APK/IPA di mesin pengembang ini (tanpa Java/Xcode); verifikasi build dilakukan CI.
