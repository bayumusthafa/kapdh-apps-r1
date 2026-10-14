# KAPDH Mobile

Aplikasi anggota KAPDH Apps untuk Android dan iOS (Flutter 3.47, Riverpod 3, go_router 16, Dio 5 + SDK terbangkit
`kapdh_api`). PRD v3.5; aturan rekayasa di `docs/ARCHITECTURE.md` §8; gambaran seluruh repo di `../README.md`.
Seluruh fitur anggota R1.0 sudah ada; bukti uji per AC di `../docs/qa/traceability.md`.

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
- Build RILIS wajib menyebut `KAPDH_ENV` staging atau production dan API https. Build rilis yang lupa
  `--dart-define-from-file` (atau memakai development/http) berhenti di layar "Aplikasi belum dapat dijalankan"
  (`ApiConfig.resolve`, `ConfigErrorApp`), bukan diam-diam mengarah ke API pengembangan.
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
    api/        Dio + interceptor (jam server dari header Date; X-App-Version, X-App-Platform, X-Request-Id; auth +
                refresh; sinyal galat), RefreshCoordinator (satu refresh untuk HTTP, socket dan push),
                IdempotencyStore, ErrorPresenter
    config/     ApiConfig, PushConfig, ServerClock (perkiraan jam server; stempel server tidak dibandingkan dengan jam
                perangkat)
    app_gate/   GET /public/config: wajib update (semver) dan maintenance
    session/    SessionController (unknown, anonymous, authenticated, offlineLastKnown), AuthRepository, MeRepository
    cache/      KtaCacheStore (aturan offline 7 hari, AC F05-2..F05-4), KtaAvatarCache dan HomeCacheStore (dihapus saat
                logout/ganti akun)
    storage/    TokenStore (satu nilai JSON atomik), SecureStore
    realtime/   RealtimeClient Socket.IO /realtime (backoff, deduplikasi event_id, RealtimeEvent.fromJson),
                connection_transitions (satu sumber deteksi tersambung ulang)
    push/       PushService + FirebasePushPlatform (izin, PUT /devices, notifikasi latar depan, ketukan → router)
    format/     Rupiah dari Money string, WIB/WITA/WIT, waktu relatif, hitung mundur
    deep_link/  normalisasi kapdh://app/... dan https://kapdh.or.id/app/...
    ui/         kunci navigator/messenger global, dialog reautentikasi, kontak dukungan, back_navigation (tombol kembali
                app bar dan sistem menjalankan ulang matriks redirect)
    validation/ aturan sandi (8-72 byte UTF-8, PRD 2.5)
  design/       design system (prototipe layar 1 sampai 7, guideline hal. 4 sampai 8); impor lewat design.dart
  features/<f>/ layar, controller, repositori per fitur:
                system (splash, wajib update, maintenance, galat konfigurasi), auth (login, daftar, OTP, koreksi email,
                lupa sandi), onboarding (Biaya KTA), payments (instruksi, bukti, status, riwayat, perpanjangan),
                kta (kartu + QR + offline), home, news, events (detail, reservasi), tickets, network (direktori,
                profil, blokir, laporan), chat (direct, grup, undangan, info), notifications (inbox, ketukan push),
                account (profil, privasi, preferensi notifikasi, sesi, sandi, diblokir, laporan saya, hapus akun),
                legal, membership (aturan tahun akademik), status (portal pembatasan + banding, status penghapusan)
```

Aturan yang wajib diikuti fitur:

- Panggil API hanya lewat `kapdhApiProvider` (SDK terbangkit) atau repositori di atasnya; galat selalu `ApiException`.
  Tampilkan galat lewat `errorPresenterProvider` (katalog `ErrorUiAction`) atau field_errors di field form.
- Mutasi dengan Idempotency-Key memakai `idempotencyStoreProvider.run(intent, body, (key) => ...)`.
- Navigasi status ditentukan router; layar tidak menghitung effective_status. Tambah rute baru di `routes.dart`,
  `router.dart` dan matriks `redirect.dart` beserta ujinya.
- Teks pengguna dan komentar berbahasa Indonesia dengan rujukan PRD; status selalu label + ikon (`StatusBadge`).
- Stempel absolut dari server (`expires_at`, `resend_available_at`, `access_expires_at`) dinilai dengan
  `serverClockProvider` (`ServerClock.now()`), BUKAN jam perangkat; durasi relatif (retry_after_seconds) diukur
  dengan `ServerClock.deviceNow()`. Jam perangkat bisa melenceng berjam-jam (PRD 2.1).
- Pita Offline dan Pemeliharaan tampil otomatis tepat di bawah app bar setiap `AppScaffold` (`AppBannerScope`,
  dipasang di `MaterialApp.builder`). Layar yang memberi `AppScaffold(banner:)` sendiri menggantikan pita global
  (mis. KTA offline dengan waktu sinkron kartu); layar tanpa `AppScaffold` (mis. beranda dengan kepala sapaan)
  menampilkan `AppBannerScope.of(context)` di bawah kepalanya.
- Maintenance (PRD 4.5) adalah mode baca terkendali: rute baca yang diizinkan status tetap terbuka, alur khusus
  mutasi (`isMutationOnlyRoute`: auth, `/payments/new/*`, `/renewal`, `/account/password`, `/account/delete`,
  `/chat/new-group`) diarahkan ke `/maintenance`. Rute baru yang hanya berisi mutasi wajib ditambahkan ke daftar itu.
  Simpan yang ditolak 503 ditampilkan ErrorPresenter sebagai snackbar.
- `BrandSheetScaffold(scrollable: true)` untuk kepala pita yang tinggi (logo/sapaan): pita ikut bergulir sehingga
  teks 200 % dengan keyboard terbuka tidak meluap (N-11); `body` pada mode ini berupa Column, bukan scroll view.

## Uji

`flutter test` menjalankan uji unit dan widget tanpa jaringan (`test/support/fakes.dart`: adapter HTTP palsu, jam uji,
secure storage memori; `test/support/app_harness.dart`: aplikasi lengkap dari splash). Font runtime dimatikan di
`test/flutter_test_config.dart`. Jumlah berkas/uji terakhir yang tercatat: `../docs/qa/traceability.md` bagian 2.

```bash
flutter analyze
flutter test
dart format --output=none --set-exit-if-changed lib test   # lib/app/theme/kapdh_tokens.dart masih dilaporkan (lama)
```

Uji widget memakai HTTP palsu; bukti AC utama ada di API (PRD 7.3). Alur nyata terhadap API staging termasuk UAT
(`../docs/qa/uat-checklist.md`).

## Rilis

1. Naikkan `version` di `pubspec.yaml` (`x.y.z+build`); `min_app_version` di web admin dinaikkan hanya setelah versi
   itu dapat diunduh di toko (PRD 8.4).
2. Build rilis di CI (tidak ada Java/Xcode di mesin pengembang):
   `flutter build appbundle --dart-define-from-file=<production.json dari secret CI>` dan
   `flutter build ipa --dart-define-from-file=<...>`. Berkas memuat `KAPDH_ENV=production`,
   `API_BASE_URL=https://api.kapdh.or.id/api/v1`, `PUSH_ENABLED=true` dan `FIREBASE_*` production (ADR-016).
3. Repo Flutter terpisah (PRD 7.2, ADR-001): pisahkan riwayat folder ini dengan subtree split dari akar repo
   (`-P kapdh-mobile`), lalu ganti dependensi path `kapdh_api` dengan dependensi git bertag `contracts-vX.Y.Z`
   (dibuat `pnpm contracts:release-sdk` di `kapdh-platform`; contoh blok ada di komentar `pubspec.yaml`).
4. Pengajuan toko, akun demo reviewer, formulir privasi, dan rencana cadangan iOS:
   `../docs/runbooks/app-store-submission.md`.

## Tindak lanjut rilis

- Bundel TTF Poppins sebagai aset dan matikan `GoogleFonts.config.allowRuntimeFetching` (saat ini Poppins diunduh
  saat runtime dari server Google dengan font sistem sebagai cadangan; ARCHITECTURE §8.1). Selama belum dibundel,
  permintaan itu harus diungkap di formulir privasi toko.
- Android: kunci rilis (`android/key.properties`), `assetlinks.json` di kapdh.or.id untuk App Links (berkas belum ada
  di `apps/web/public`, dan `infra/nginx-web.conf` saat ini menolak semua path berawalan titik sehingga
  `/.well-known/` harus dikecualikan), ikon notifikasi
  monokrom dan ikon tema monokrom Android 13 (`<monochrome>` pada `mipmap-anydpi-v26/ic_launcher.xml`). Ikon
  peluncur Android/iOS saat ini dibangkitkan dari `assets/logo-kapdh.png` di atas hijau gelap surface-dark
  (`tool/generate_launcher_icons.ps1`); ganti dengan berkas desain resmi bila tersedia.
- iOS: tim Apple, entitlement Push Notifications (`aps-environment`) dan Associated Domains `applinks:kapdh.or.id`
  untuk Universal Links (`apple-app-site-association` di `/.well-known/`); kunci APNs di proyek Firebase.
- Pelaporan galat (GlitchTip, PRD 5.5) belum terpasang (`lib/bootstrap.dart`); bila ditambahkan, perbarui formulir
  privasi toko.
- Predictive back Android belum diaktifkan; bila diaktifkan, jalurnya wajib lewat `RedirectingBackButtonDispatcher`
  (`lib/core/ui/back_navigation.dart`).
- Tidak ada build APK/IPA di mesin pengembang ini (tanpa Java/Xcode); verifikasi build dilakukan CI.
