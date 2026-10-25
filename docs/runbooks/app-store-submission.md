# Runbook: Pengajuan ke App Store dan Google Play

Rujukan: PRD 3.13, 3.14, 3.12, 8.2 langkah 6, 8.3 langkah 4-5, 9.3, 10.1 (D10, D13, D16), 10.2; [R1] Apple 5.1.1(v),
[R2] Google Play account deletion, [R6] Apple App Review Guidelines (1.2 UGC, 3.1 pembayaran), [R7] Google Play
Payments. Keputusan teknis: ADR-015 (fallback iOS), ADR-016 (konfigurasi build), ADR-013 (identitas), ADR-014 (ledger).

> Kebijakan toko berubah. PRD 11.2 mewajibkan ketentuan diperiksa kembali saat aplikasi diajukan; nomor pasal di
> bawah mengikuti rujukan PRD (diperiksa 11 Oktober 2026). Penilaian ini bukan jaminan hasil review (D13).

## 1. Akun, identitas aplikasi, dan prasyarat build

| Hal | Nilai | Status di repo (`main` 14 Oktober 2026, setelah hardening API Fase D) |
| --- | ----- | ------------------------------- |
| Akun | Apple Developer Program (USD 99/tahun) dan Google Play Console (USD 25 sekali) atas nama organisasi dengan D-U-N-S (D10) | Di luar repo; PP |
| ID aplikasi | `id.or.kapdh.app` (Android `applicationId`, iOS `PRODUCT_BUNDLE_IDENTIFIER`) | Ada |
| OS minimum | Android 8.0 (`minSdk = 26`), iOS 15.0 (D7) | Ada |
| Signing Android | `android/key.properties` + keystore (tidak di-commit); aktifkan Play App Signing | Belum; tanpa berkas itu (atau kunci suntikan Android Studio) build AAB rilis (`bundle*Release`, `package*ReleaseBundle`, `sign*ReleaseBundle`) gagal dengan pesan yang merujuk `kapdh-mobile/docs/BUILD.md` 3.1, sedangkan APK rilis untuk uji internal tetap ditandatangani kunci debug |
| Signing iOS | Sertifikat distribusi, provisioning profile App Store, tim Apple | Belum |
| Push | Capability Push Notifications (`aps-environment`) + kunci APNs di proyek Firebase yang dipakai build; `POST_NOTIFICATIONS` Android 13+ sudah dideklarasikan | Sebagian (22 Oktober 2026): `kapdh-mobile/ios/Runner/Runner.entitlements` memuat `aps-environment` dan `applinks:kapdh.or.id`. Sisa: Team ID dipilih di Xcode (Signing & Capabilities → Team, tersimpan sebagai `DEVELOPMENT_TEAM`); kunci APNs `.p8` diunggah **sebelum** build iOS apa pun dibagikan, termasuk TestFlight, ke proyek Firebase yang dipakai build itu: `kapdh-prod` untuk build production, proyek Firebase staging untuk build staging di TestFlight (ADR-016); `.p8` yang sama boleh diunggah ke keduanya (`push-fcm.md` bagian 8) |
| Deep link | `kapdh://app/...` sudah; HTTPS `https://kapdh.or.id/app/...` butuh `assetlinks.json` dan `apple-app-site-association` di `/.well-known/` serta Associated Domains iOS | Sebagian (22 Oktober 2026): intent-filter App Links Android (`autoVerify`, path `/app` dan awalan `/app/`) dan entitlement `applinks:kapdh.or.id` ada; `infra/nginx-web.conf` mengecualikan hanya dua path persis `/.well-known/assetlinks.json` dan `/.well-known/apple-app-site-association` dari penolakan path berawalan titik; build situs (`apps/web/scripts/write-app-links.mjs`) menulis kedua berkas dari `apps/web/app-links.json` hanya bila nilainya terisi (selain itu 404); halaman cadangan `/app` (`apps/web/src/pages/app/index.astro`). Sisa: sidik SHA-256 Play App Signing dan Team ID ke `app-links.json` lewat PR yang ditinjau, lalu verifikasi (di bawah tabel). Tautan dari server R1.0 tetap `kapdh://` (kontrak C2) |
| Font | Poppins dibundel sebagai font aset (`kapdh-mobile/assets/fonts/poppins`, ARCHITECTURE §8.1); aplikasi tidak menghubungi server font pihak ketiga | Ada |
| Konfigurasi build | `flutter build appbundle` / `flutter build ipa` dengan `--dart-define-from-file=<berkas production dari secret CI>` yang memuat `KAPDH_ENV=production`, `API_BASE_URL=https://api.kapdh.or.id/api/v1`, `PUSH_ENABLED=true` dan `FIREBASE_*` | `config/production.json` di repo sengaja kosong untuk Firebase |
| Versi | `pubspec.yaml` `version: x.y.z+n`; `min_app_version` di web admin sama dengan versi rilis pertama | `1.0.0+1` saat ini (sama dengan `min_app_version` seed); naikkan `+n` setiap unggahan |

Tautan HTTPS `https://kapdh.or.id/app/...` (baris Deep link). Sampai langkah di bawah selesai, tautan https membuka
halaman cadangan `/app` di peramban (tombol "Buka di aplikasi KAPDH" ke `kapdh://app/...` dan tautan toko). Tautan yang
dikirim server R1.0 tetap `kapdh://` (kontrak C2); tautan https baru dapat dipakai setelah domain terverifikasi.

1. Ambil SHA-256 **App signing key certificate** di Play Console → Setup → App integrity (bukan kunci debug; sidik
   upload key hanya bila build di luar Play juga harus terverifikasi) dan Team ID di Apple Developer → Membership
   details. Isi `android.sha256_cert_fingerprints` dan `ios.app_id_prefix` di `kapdh-platform/apps/web/app-links.json`
   lewat PR yang ditinjau. Format ada di `$comment` berkas itu; nilai tidak sah atau berbentuk contoh menggagalkan
   build. Team ID yang sama dipilih di Xcode (baris Push).
2. Uji asap `infra/scripts/smoke-static.sh web` berjalan di CI terhadap image yang baru dibangun (kedua berkas terbit
   atau 404 sesuai `app-links.json`, dan keadaan terbit juga diuji dengan fixture
   `infra/ci/test/fixtures/app-links.uji.json`), bukan terhadap situs live. Setelah web production di-deploy, periksa
   situs live:

   ```sh
   curl -sI https://kapdh.or.id/.well-known/assetlinks.json              # sidik terisi: 200 dan content-type: application/json; masih kosong: 404
   curl -sI https://kapdh.or.id/.well-known/apple-app-site-association   # Team ID terisi: 200 dan content-type: application/json; masih kosong: 404
   ```

   Kode 301/302 atau `text/html` berarti berkas tidak dilayani apa adanya, dan verifikasi Android/iOS gagal. Uji asap
   yang sama juga dapat diarahkan ke situs live (skrip hanya menyambung URL dasar dengan path, jadi https didukung):
   dari `kapdh-platform/` pada checkout tag yang di-deploy (ekspektasi dibaca dari `apps/web/app-links.json` checkout
   itu; butuh curl dan node), jalankan `sh infra/scripts/smoke-static.sh web https://kapdh.or.id`. Skrip itu juga
   mengirim satu `POST /` yang harus ditolak 405. Cara ini belum pernah dijalankan terhadap situs live; bila
   pemeriksaan header lain gagal karena proxy di depan nginx, yang menentukan untuk langkah ini adalah baris
   `/.well-known/...`. Lalu periksa salinan pihak Google dan Apple:

   ```sh
   curl -fsS 'https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://kapdh.or.id&relation=delegate_permission/common.handle_all_urls'   # statements memuat packageName id.or.kapdh.app dan sidik dari langkah 1
   curl -fsS https://app-site-association.cdn-apple.com/a/v1/kapdh.or.id   # isi sama dengan https://kapdh.or.id/.well-known/apple-app-site-association
   ```

   Salinan CDN Apple diperbarui berkala, jadi perubahan baru bisa belum tampil di sana. Ulangi perintah kedua sampai
   isinya sama sebelum menguji Universal Links di iPhone (pasang ulang aplikasi setelahnya).
3. Di ponsel Android 12+ dengan aplikasi yang dipasang dari Play (jalur pengujian internal cukup):

   ```sh
   adb shell pm verify-app-links --re-verify id.or.kapdh.app
   adb shell pm get-app-links id.or.kapdh.app   # kapdh.or.id: verified
   ```

Listing (keduanya):

- Nama: "KAPDH" atau nama resmi yang disahkan PP; kategori Sosial (Google Play) dan Social Networking (App Store).
  Kategori Sosial di Google Play mewajibkan deklarasi Child safety standards (bagian 9.4).
- URL kebijakan privasi: `https://kapdh.or.id/kebijakan-privasi`; URL dukungan: `https://kapdh.or.id/kontak`;
  email dukungan dan kontak moderasi: `bantuan@kapdh.or.id`.
- Rating usia: aplikasi memiliki komunikasi antarpengguna (chat) dan konten buatan pengguna; jawab kuesioner
  (Apple: "Unrestricted Web Access" tidak; "User Generated Content" ya. IARC Google: lembar jawaban lengkap di
  bagian 9.2). Target audiens Google Play: hanya 18 tahun ke atas (bagian 9.3).
- Sign in with Apple tidak diwajibkan: aplikasi tidak menawarkan login pihak ketiga, hanya email + sandi akun
  organisasi.

Aset dan teks listing Google Play ada di `docs/toko/play/` (`README.md` di sana memuat hasil verifikasi dan cara
membuat ulang). Status 25 Oktober 2026: **draf, wajib disahkan PP sebelum diunggah**. Aplikasi hanya berbahasa
Indonesia, jadi listing dibuat untuk bahasa default Indonesia (id) saja.

| Butir Play Console | Berkas di `docs/toko/play/` | Hasil pemeriksaan `sumber/cek.mjs` | Status |
| ------------------ | --------------------------- | ---------------------------------- | ------ |
| App name (maks 30) | `teks/judul.txt`: "KAPDH" | 5 karakter | Dipilih PP 25 Oktober 2026 |
| Short description (maks 80) | `teks/deskripsi-singkat.txt` | 70 karakter | Draf |
| Full description (maks 4.000) | `teks/deskripsi-lengkap.txt`: nama badan hukum, fitur di `main`, syarat 18+, iuran diverifikasi pengurus, tautan kebijakan privasi dan hapus akun | 2.306 karakter | Draf |
| App icon (PNG 32-bit, 512 x 512, maks 1.024 KB) | `ikon-512.png`, diturunkan dari ikon iOS 1024 | 512 x 512, RGBA alfa penuh, sRGB, 186 KB | Siap, menunggu PP |
| Feature graphic (JPEG/PNG 24-bit tanpa alfa, 1024 x 500) | `feature-graphic-1024x500.jpg`, teks alternatif `teks/alt-feature-graphic.txt` | 1024 x 500, RGB sRGB, tanpa alfa, 92 KB; elemen penting di area aman | Siap, menunggu PP |
| Phone screenshots (2-8; rekomendasi Play minimal 4 gambar 9:16 >= 1080 x 1920) | `tangkapan/01-beranda` sampai `06-pesan`, dibuat `sumber/ambil-tangkapan.sh` sesuai `tangkapan-layar.md` | Belum ada | Belum: butuh build rilis, akun demo aktif, dan data tanpa "[Contoh]" (bagian 3) |
| Category dan tags | App, Social; 5 tag usulan di `listing.md` | | Draf |

Teks listing, teks feature graphic, dan teks alternatif lolos pola D13 bagian 2 dan pola klaim metadata Play
(peringkat, harga, promosi) pada 25 Oktober 2026. Tangkapan di `docs/panduan/sumber/gambar/mobile` (720 x 1602,
rasio lebih dari 2:1, dari mockup HTML) tidak dipakai untuk toko. Jalankan `node docs/toko/play/sumber/cek.mjs
--wajib-tangkapan` setelah aset terakhir diubah dan sebelum diunggah.

## 2. Positioning iuran (D13)

D13: iuran adalah kewajiban keanggotaan organisasi di dunia nyata; tiket adalah layanan acara yang dihadiri secara
langsung. Keduanya dibayar lewat transfer manual ke rekening organisasi di luar sistem pembayaran toko.

Aturan teks (aplikasi, listing, catatan reviewer, tangkapan layar):

- Pakai "iuran keanggotaan", "iuran pendaftaran", "iuran perpanjangan", "KTA (Kartu Tanda Anggota)", "tiket acara".
- **Jangan** pakai "upgrade", "premium", "langganan", "buka fitur", "berlangganan", "pro", "terkunci", "membuka
  (kembali) fitur", "mengaktifkan fitur", atau harga yang dibandingkan dengan fitur. Status keanggotaan ditulis sebagai
  status organisasi ("anggota aktif", "keanggotaan diperbarui pengurus setelah iuran organisasi diverifikasi"), bukan
  sebagai kunci fitur aplikasi.
- Jelaskan bahwa status anggota diverifikasi pengurus organisasi dari bukti transfer (bukan pembelian otomatis), dan
  bahwa direktori, chat, dan reservasi event adalah layanan bagi anggota organisasi yang terverifikasi (PRD 2.2).
- Risiko yang tersisa (D13): Apple 3.1.1 dapat menilai bahwa pembayaran membuka fitur di aplikasi. Rencana cadangan
  ada di bagian 6.

**Status teks aplikasi: sesuai sejak 21 Oktober 2026 (teks disahkan PP).** Temuan 14 Oktober 2026 menunjukkan teks
aplikasi mengaitkan iuran/perpanjangan dengan "membuka" atau "mengaktifkan" fitur aplikasi, persis pemicu 3.1.1 yang hendak
dihindari mitigasi D13 butir 1. Semua teks itu kini ditulis sebagai status keanggotaan organisasi:

| Tempat (`kapdh-mobile/lib/`) | Teks lama | Teks sekarang |
| ------------------------------ | --------- | ------------- |
| `app/app_shell.dart` tooltip/semantik tab, `features/account/widgets/account_section.dart` semantik menu | "`<menu>`, terkunci" | "`<menu>`, khusus anggota aktif" |
| `app/app_shell.dart` judul lembar | "`<tab>` terkunci" | "`<tab>` khusus anggota aktif" (sama dengan `MemberOnlyNotice`) |
| `app/app_shell.dart`, `features/home/shared/member_gate.dart` (unverified) | "... terbuka setelah KTA aktif. Selesaikan iuran pendaftaran agar pengurus dapat memverifikasi keanggotaan Anda." | "... adalah layanan untuk anggota terverifikasi. Status keanggotaan diperbarui pengurus setelah iuran pendaftaran organisasi diverifikasi." |
| `app/app_shell.dart`, `features/home/shared/member_gate.dart` (expired) | "... hanya untuk anggota aktif. Perpanjang KTA untuk membuka kembali fitur ini / membukanya kembali." | "... adalah layanan untuk anggota aktif. Masa keanggotaan Anda berakhir; hubungi pengurus atau perpanjang keanggotaan organisasi." |
| `features/home/home_screen.dart` (unverified) | "Setelah KTA aktif, berita, event dan jejaring alumni terbuka di Beranda." | "Berita, event dan jejaring alumni adalah layanan untuk anggota terverifikasi." |
| `features/home/home_screen.dart` (expired) | "Perpanjang KTA untuk kembali membuka berita, event, jejaring dan chat." | "Berita, event, jejaring dan chat adalah layanan untuk anggota aktif. Hubungi pengurus atau perpanjang keanggotaan organisasi." |
| `features/chat/chat_room_screen.dart` | "Perpanjang KTA untuk membuka kembali percakapan." | "Percakapan adalah layanan untuk anggota aktif; hubungi pengurus atau perpanjang keanggotaan organisasi." |
| `features/kta/kta_presentation.dart` (aktif) | "Seluruh fitur alumni aktif ..." | "Keanggotaan organisasi aktif ..." |
| `features/kta/kta_presentation.dart` (tidak aktif) | "Selesaikan iuran pendaftaran untuk mengaktifkan KTA dan fitur alumni." | "Selesaikan iuran pendaftaran. KTA berlaku setelah pengurus memverifikasi iuran organisasi Anda." |
| `features/kta/kta_presentation.dart` (expired) | "Masa aktif ... Perpanjang untuk mengaktifkan kembali KTA dan fitur alumni." | "Masa keanggotaan ... berakhir. Hubungi pengurus atau perpanjang keanggotaan organisasi." |
| `features/kta/kta_screen.dart` judul daftar layanan | "Terbuka setelah KTA aktif" | "Layanan untuk anggota terverifikasi" |

Ikon gembok pada tab dan lembar penjelasan tetap dipakai sebagai penanda visual; tinjau ulang bila reviewer mempersoalkannya.
Uji widget yang memeriksa teks ini ikut diperbarui.

Pemeriksaan sebelum setiap submit (dari root repo; hasil yang diharapkan: kosong, atau hanya baris yang sudah ditinjau
PP dan dicatat bukan soal akses berbayar):

```sh
grep -rniE "'[^']*(terkunci|terbuka setelah KTA|membuka (kembali )?fitur|membuka kembali percakapan|membukanya kembali|kembali membuka|fitur alumni|mengaktifkan (kembali )?KTA|upgrade|premium|langganan)[^']*'" \
  kapdh-mobile/lib --include='*.dart' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//'
```

Pada 14 Oktober 2026 perintah ini (tanpa pola "terbuka setelah KTA") mengembalikan 13 baris; pada 21 Oktober 2026,
setelah perbaikan, hasilnya kosong. Pola ini hanya menangkap literal string berkutip tunggal; tinjau juga tangkapan
layar toko dan teks listing secara manual.

Deskripsi listing (draf, Bahasa Indonesia; disahkan PP):

> KAPDH adalah aplikasi resmi Keluarga Alumni Pondok Pesantren Darel Hikmah. Alumni dapat mendaftar keanggotaan,
> menyimpan Kartu Tanda Anggota (KTA) digital yang dapat diverifikasi lewat QR, membaca kabar organisasi, mendaftar
> acara alumni, dan terhubung dengan sesama anggota lewat direktori dan pesan. Iuran keanggotaan organisasi dan tiket
> acara dibayar melalui transfer ke rekening resmi organisasi dan diverifikasi pengurus.

## 3. Akun demo reviewer (D16; PRD 8.2 langkah 6)

D16: akun demo reviewer **aktif** dan **belum bayar**. Akun dibuat lewat alur resmi di production (tidak ada fixture di
production, PRD 7.3), memakai email yang dikendalikan organisasi, dan dicatat sebagai "data uji" yang dikecualikan
dari metrik (PRD 8.3 langkah 3).

| Akun | Status | Kegunaan bagi reviewer | Cara menyiapkan |
| ---- | ------ | ---------------------- | --------------- |
| Demo A | aktif (verified) | KTA + QR, beranda, berita, event + reservasi tiket, direktori, chat, notifikasi, pengaturan, hapus akun (layar konfirmasi) | Registrasi di aplikasi → OTP email → Biaya KTA → instruksi iuran → bukti transfer nyata dari rekening organisasi → BD menyetujui di web admin (catat sebagai data uji) |
| Demo B | belum bayar (unverified) | Alur iuran: rincian biaya, instruksi transfer, unggah bukti, status menunggu | Registrasi + OTP saja; berhenti di langkah Biaya KTA |
| Demo C | aktif | Lawan bicara chat Demo A; uji laporkan/blokir | Seperti Demo A |
| Demo D (opsional) | aktif | Uji hapus akun sampai selesai tanpa merusak Demo A | Seperti Demo A; siapkan pengganti setelah dihapus |

- Reviewer wajib menerima akun aktif terverifikasi (Demo A dan C) **selain** Demo B. Akun belum bayar tidak dapat
  membuka berita, event, direktori, maupun chat (`kapdh-mobile/lib/features/home/shared/member_gate.dart:9-16`,
  `kapdh-mobile/lib/app/app_shell.dart:66-72`), sehingga fitur UGC yang diperiksa toko tidak terjangkau. Rincian di
  bagian 9.1.
- Login anggota hanya email + sandi (tanpa OTP saat login; diverifikasi pada uji coba lokal 14 Oktober 2026), jadi
  reviewer dapat masuk tanpa akses kotak surat.
- Simpan kredensial di password manager organisasi; isi di App Store Connect (App Review Information → Sign-in
  required) dan Play Console (App content → App access). Ganti sandi setelah review selesai.
- Selama review: Demo A/C/D tampil di direktori (`show_in_directory` bawaan aktif) agar reviewer dapat memulai chat;
  pastikan ada minimal satu event `open` (gratis lebih mudah diuji) dan satu berita terbit. Event khusus review
  diberi judul netral dan ditutup/dibatalkan setelah review (pembatalan memberi notifikasi peserta).
- Bukti transfer yang diunggah reviewer dari Demo B ditolak BD dengan catatan "akun demo reviewer" (bukan disetujui).
- Periksa harian bahwa akun demo tidak tersuspensi, tidak kedaluwarsa, dan belum dihapus.

## 4. Formulir privasi: lembar Data safety Google Play (dan App Privacy Apple)

Sumber jawaban: kode `main` `7ce1ed8` (diperiksa 25 Oktober 2026) dan naskah kebijakan privasi. Nomor baris di bagian 4,
9 dan 10 mengikuti commit itu; periksa ulang bila berkasnya berubah sebelum formulir diisi. `KP` dan `KK` merujuk berkas
di `docs/legal`. Naskah yang tayang di situs adalah salinan di `kapdh-platform/apps/web/src/published-pages/` (bagian
7), dan per 25 Oktober 2026 salinan itu memuat butir yang sama untuk semua jawaban di sini (rekening refund, kota
domisili, kata kunci pencarian, pengenal instalasi, agama, usia 18+, Perlindungan anak). Bila naskah baru terbit,
cocokkan ulang lembar ini dengan naskah tayang. Singkatan rujukan:

| Singkatan | Path |
| --------- | ---- |
| `schema/` | `kapdh-platform/packages/database/src/schema/` |
| `api/` | `kapdh-platform/apps/api/src/` |
| `mobile/` | `kapdh-mobile/lib/` |
| `contracts/` | `kapdh-platform/packages/contracts/openapi/domains/` |
| `KP` | `docs/legal/kebijakan-privasi.html` (terbit di `https://kapdh.or.id/kebijakan-privasi`) |
| `KK` | `docs/legal/ketentuan-komunitas.html` (terbit di `https://kapdh.or.id/ketentuan-komunitas`) |

Aturan pengisian yang berlaku untuk semua baris:

- **Collected**: data dikirim dari perangkat ke server KAPDH atau ke SDK di aplikasi. Data yang hanya diproses
  sesaat tetap diisi di formulir (Google), tetapi diberi tanda ephemeral.
- **Shared: tidak** untuk semua jenis data. Penerima di KP:194-200 (IDCloudHost, Resend dan AWS, Google FCM,
  penyimpanan cadangan) adalah penyedia layanan yang memproses atas nama KAPDH. Pengungkapan kepada pihak berwenang
  (KP:201) adalah kewajiban hukum. Tampilan profil kepada sesama anggota di Jejaring (KP:158-167) bukan transfer ke
  organisasi pihak ketiga. Ketiganya dikecualikan dari "sharing" menurut Google.
- **Ephemeral: tidak**, kecuali kata kunci pencarian. Semua jenis data lain disimpan di basis data.
- **Wajib/opsional**: "Wajib" bila ada satu data dalam jenis itu yang wajib atau terkirim otomatis. Google hanya
  menerima "Opsional" bila semua pengguna dapat menolak memberikannya.
- **Tujuan** memakai label formulir Google: App functionality, Account management, Developer communications, dan
  Fraud prevention, security, and compliance. Tidak ada Analytics, Advertising or marketing, maupun Personalization:
  KP:26, KP:124, KP:154, dan `kapdh-mobile/pubspec.yaml:27-63` (tanpa SDK iklan, analitik, atau crash).

### 4.1 Lembar per jenis data

| Kategori → jenis data (Google) | Data di KAPDH | Bukti | Collected / shared | Ephemeral | Wajib? | Tujuan | Apple App Privacy |
| ------------------------------ | ------------- | ----- | ------------------ | --------- | ------ | ------ | ----------------- |
| Location → Approximate location | Kota domisili yang diketik pengguna (bukan lokasi perangkat). Dipakai di KTA, kartu Jejaring, dan filter kota | `schema/membership.ts:95`; `api/modules/network/directory.query.ts:92-93`; KP:49, KP:64, KP:161 | **Keputusan PP K1** (bagian 10). Usulan: collected, tidak dibagikan | Tidak | Opsional | App functionality | Konsisten dengan K1: Location → Coarse Location bila K1 = ya, Other Data bila tidak |
| Location → Precise location | Tidak dikumpulkan. Tidak ada izin lokasi; EXIF/GPS dibuang saat gambar di-encode ulang | `kapdh-mobile/android/app/src/main/AndroidManifest.xml:3-6`; `api/core/files/inspect.ts:125-131`; KP:301, KP:383 | Tidak | – | – | – | Precise Location: tidak |
| Personal info → Name | Nama lengkap | `schema/membership.ts:90`; `contracts/auth.yaml:755` (field wajib registrasi); KP:38 | Ya / tidak | Tidak | Wajib | App functionality, Account management | Contact Info → Name |
| Personal info → Email address | Email login. Dipakai untuk OTP, email transaksional, dan pemberitahuan keamanan; tampil di Jejaring hanya bila `show_email` aktif | `schema/identity.ts:64`; `schema/membership.ts:104`; `contracts/auth.yaml:755`; KP:38, KP:307 | Ya / tidak | Tidak | Wajib | App functionality, Account management, Developer communications | Contact Info → Email Address |
| Personal info → User IDs | ID akun (UUID) dan nomor anggota AA.SS.JK.N | `schema/identity.ts:60`; `schema/membership.ts:115`; KP:63 | Ya / tidak | Tidak | Wajib (otomatis) | App functionality, Account management | Identifiers → User ID |
| Personal info → Phone number | Nomor telepon; tampil hanya bila `show_phone` aktif | `schema/membership.ts:96`, `:105`; KP:50 | Ya / tidak | Tidak | Opsional | App functionality | Contact Info → Phone Number |
| Personal info → Political or religious beliefs | Tidak ada field agama. Keanggotaan perkumpulan alumni pesantren dapat menunjukkan latar pendidikan keagamaan | KP:124, KP:368 | **Keputusan PP K2** (bagian 10) | – | – | – | Konsisten dengan K2: Sensitive Info |
| Personal info → Other info | Wajib: jenis kelamin, angkatan, kelas masuk, kelas keluar. Opsional: bio, profesi, keahlian, riwayat pendidikan, tautan media sosial (dan kota bila K1 = tidak) | `schema/membership.ts:91-94`, `:97`, `:188`, `:230`, `:268`, `:303`; `contracts/auth.yaml:755`; KP:38-39, KP:51-55 | Ya / tidak | Tidak | Wajib | App functionality | Other Data (dan User Content → Other User Content untuk bio) |
| Financial info → User payment info | **Baru.** Rekening tujuan refund: nama bank atau e-wallet, nomor rekening, nama pemilik. Diisi anggota saat ada refund; dikosongkan saat refund selesai, dibatalkan, atau akun dihapus; tidak pernah diaudit atau dilog | `mobile/features/payments/payments_repository.dart:143-147`; `mobile/features/payments/widgets/adjustment_card.dart:47-76`; `api/modules/payments/member-payments.service.ts:116-120`, `:457-481`; `schema/payments.ts:201-202`, `:237-240`; `api/modules/payments/admin-adjustments.service.ts:350`, `:422`; `api/modules/account/deletion-steps.ts:1238`; KP:74, KP:236 | Ya / tidak | Tidak (disimpan sampai refund selesai) | Opsional (hanya bila ada refund) | App functionality | Financial Info → Payment Info |
| Financial info → Purchase history | Riwayat iuran dan tiket: jenis, nominal, status, metode tujuan organisasi | `schema/payments.ts:88`, `:158`; `schema/events.ts:91`; KP:71, KP:78 | Ya / tidak | Tidak | Wajib (otomatis) | App functionality | Purchases → Purchase History |
| Financial info → Other financial info | Isi bukti transfer (nama dan nomor rekening pengirim) dan catatan transfer | `schema/payments.ts:102`, `:104`; KP:72-73, KP:367 | Ya / tidak | Tidak | Wajib (iuran dibayar dengan bukti di aplikasi) | App functionality | Financial Info → Other Financial Info |
| Messages → Other in-app messages | Pesan chat, balasan, reaksi; salinan pesan dalam bukti laporan | `schema/community.ts:155`, `:191`, `:214`; KP:86-89, KP:97 | Ya / tidak | Tidak | Opsional | App functionality | User Content → Emails or Text Messages |
| Photos and videos → Photos | Foto profil, gambar chat, foto grup, bukti transfer berbentuk gambar. Video tidak dikumpulkan | `schema/platform.ts:10-19`; `schema/community.ts:79`, `:166`; `mobile/features/account/avatar_image.dart:29-30`; `mobile/features/chat/chat_image_picker.dart:38-39`; `mobile/features/chat/new_group_screen.dart:67`; `mobile/features/payments/proof_file.dart:162-176`; KP:48, KP:72, KP:86-87 | Ya / tidak | Tidak | Opsional (bukti boleh PDF) | App functionality | User Content → Photos or Videos |
| Files and docs → Files and docs | Bukti transfer berbentuk PDF | `mobile/features/payments/proof_file.dart:191`; KP:72 | Ya / tidak | Tidak | Opsional (bukti boleh gambar) | App functionality | Financial Info → Other Financial Info |
| App activity → App interactions | Penanda baca, status bisukan, preferensi notifikasi, waktu aktivitas sesi | `schema/community.ts:127-131`; `schema/notifications.ts:65`; KP:88, KP:105, KP:111 | Ya / tidak | Tidak | Wajib (otomatis) | App functionality | Usage Data → Product Interaction |
| App activity → In-app search history | **Baru.** Kata kunci dan kota yang diketik di pencarian Jejaring dan pemilih anggota chat, serta kata kunci pencarian event. Dikirim sebagai query string, dipakai untuk satu permintaan, tidak disimpan di basis data, tidak dicatat di log, dan tidak disimpan di perangkat | `mobile/features/network/network_repository.dart:21-31`; `mobile/features/chat/member_picker.dart:87-100`; `mobile/features/events/events_repository.dart:23-38`; `api/modules/network/directory.service.ts:193-206`; `api/modules/events/member-events.service.ts:48`; `api/core/logging/logger.ts:113-121`; KP:81 | Ya / tidak | **Ya** | Opsional | App functionality | Tidak perlu dideklarasikan (diproses seketika, tidak disimpan) |
| App activity → Other user-generated content | Laporan dan banding, nama grup | `schema/community.ts:78`, `:214`; KP:87, KP:97-100 | Ya / tidak | Tidak | Opsional | App functionality; Fraud prevention, security, and compliance | User Content → Other User Content |
| App activity → Other actions | Suka berita, reaksi pesan, daftar blokir, reservasi tiket | `schema/content.ts:92`; `schema/community.ts:50`, `:191`; `schema/events.ts:91`; KP:78, KP:93, KP:99 | Ya / tidak | Tidak | Opsional | App functionality | Usage Data → Product Interaction |
| Device or other IDs | **Diperluas.** Token FCM dan Firebase Installation ID (dibuat SDK FCM, diterima Google sebagai pemroses), platform dan versi aplikasi pada token dan sesi, serta nama perangkat generik | `schema/notifications.ts:89-99`; `schema/identity.ts:167-169`; `mobile/core/push/push_service.dart:140-144`, `:348`; `mobile/core/push/push_platform.dart:98-118`, `:152-169`; `mobile/bootstrap.dart:56`; KP:106, KP:111, KP:197 | Ya / tidak | Tidak | Wajib (lihat catatan K8) | App functionality, Developer communications (notifikasi berita dan event) | Identifiers → Device ID |

Catatan Device or other IDs (K8): pada build dengan `PUSH_ENABLED=true`, `Firebase.initializeApp` dijalankan saat
aplikasi dibuka (`mobile/bootstrap.dart:56` → `mobile/core/push/push_platform.dart:98-118`), dan auto-init FCM tidak
dimatikan di `AndroidManifest.xml` maupun `Info.plist`. Karena itu SDK dapat membuat token dan Installation ID sebelum
login, walaupun server KAPDH baru menyimpan token setelah login dan selama izin notifikasi tidak ditolak
(`mobile/core/push/push_service.dart:348`).
Jenis data ini aman dideklarasikan **Wajib**. DEV memastikan perilaku SDK pada build rilis. Selanjutnya PP memilih:
mematikan auto-init (perubahan kode) atau menyesuaikan kalimat KP:106 ("hanya dibuat ... setelah Anda masuk").

### 4.2 Tidak dideklarasikan, beserta alasannya

- Lokasi presisi, kontak, kalender, file audio, kesehatan dan kebugaran, riwayat penelusuran web, aplikasi
  terpasang, SMS/MMS, email di luar aplikasi, video, ras dan etnis, orientasi seksual, alamat pos, serta skor kredit:
  tidak ada izin, SDK, atau field untuk data ini (`kapdh-mobile/android/app/src/main/AndroidManifest.xml:3-6`,
  `kapdh-mobile/pubspec.yaml:27-63`, KP:124, KP:383).
- App info and performance (crash logs, diagnostics): belum ada SDK pelaporan galat di aplikasi (KP:124;
  `kapdh-mobile/README.md` bagian Tindak lanjut rilis). Bila GlitchTip ditambahkan, tambahkan "Crash logs" dan
  "Diagnostics" di Google, serta "Crash Data" di Apple.
- Alamat IP: hanya dipakai untuk membatasi percobaan berulang, disimpan sementara dalam bentuk hash, tidak dicatat di
  basis data maupun log, dan tidak dipakai untuk menyimpulkan lokasi (`api/core/rate-limit/rate-limit.service.ts:13`,
  `api/core/logging/logger.ts:121`, KP:112). Bila suatu saat dipakai untuk menyimpulkan lokasi, Google mewajibkan
  deklarasi Approximate location.
- Status daring dan indikator mengetik: dikirim sesaat ke peserta percakapan dan tidak disimpan (KP:90).

### 4.3 Jawaban tingkat formulir

| Pertanyaan (Google Data safety) | Jawaban | Bukti |
| ------------------------------- | ------- | ----- |
| Apakah aplikasi mengumpulkan atau membagikan jenis data yang wajib diungkapkan? | Ya | Bagian 4.1 |
| Apakah semua data pengguna dienkripsi saat transit? | Ya | HTTPS/WSS (N-07); manifest tanpa `usesCleartextTraffic` dan target SDK 36 sehingga cleartext diblokir (`kapdh-mobile/android/app/src/main/AndroidManifest.xml:12-18`; audit APK 25 Oktober 2026); KP:297 |
| Metode pembuatan akun | Username (email) dan kata sandi; tanpa login pihak ketiga | `contracts/auth.yaml:755`; bagian 1 (Sign in with Apple tidak diwajibkan) |
| URL hapus akun | `https://kapdh.or.id/delete-account` | `kapdh-platform/apps/web/src/pages/delete-account.astro`; di aplikasi: Akun → Hapus akun (`mobile/features/account/account_screen.dart:301-306`, rute `mobile/app/routes.dart:58`); KP:253-255 |
| Hapus sebagian data tanpa menghapus akun | Ya: data profil opsional dan pesan sendiri dapat dihapus di aplikasi; permintaan lain lewat `bantuan@kapdh.or.id` | KP:46, KP:238, KP:330 |
| Tinjauan keamanan independen | Tidak | – |
| Data dibagikan ke pihak ketiga | Tidak (lihat aturan Shared di atas) | KP:192-203 |

Jawaban umum Apple dan hukum:

- Data ditautkan ke identitas pengguna: **ya** (semua baris yang dikumpulkan). Pelacakan (Apple ATT/"Tracking"):
  **tidak**.
- Pemroses atas nama organisasi: Firebase Cloud Messaging (token push dan Installation ID), provider email
  transaksional D10 (alamat dan isi email), penyimpanan backup di luar VPS (terenkripsi). Dicantumkan di KP:194-200.
- Pengguna dapat meminta penghapusan: **ya** (bagian 7).
- Kategori agama (Google "Political or religious beliefs", Apple "Sensitive Info"): keputusan PP K2 di bagian 10.
  Apa pun keputusannya, Google dan Apple wajib dijawab sama, dan alasannya dicatat di paket bukti.
- Kebijakan privasi wajib memuat daftar di atas, pemroses, retensi D2, cara penghapusan, dan kontak. Bila K1 atau K2
  dijawab "dideklarasikan", periksa bahwa KP tidak bertentangan (mis. KP:124 menyebut agama tidak dikumpulkan).
- Build pertama yang memakai daftar profil berulang: revisi naskah legal dan Bantuan (`docs/legal/README.md`, Revisi
  profil berulang) terbit pada hari build itu dirilis ke pengguna (`rilis-dan-gerbang-go-live.md` bagian 5.5
  langkah 8). Baris profil di lembar ini tetap pada kategori formulir yang sama, jadi Data safety dan App Privacy tidak
  perlu diubah untuk daftar baru.

## 5. Templat catatan reviewer

Isi di App Store Connect (App Review Information → Notes) dan Play Console (App access → instructions). Bahasa
Inggris untuk reviewer; versi Indonesia disimpan di paket bukti.

```text
KAPDH is the official member app of Keluarga Alumni Pondok Pesantren Darel Hikmah (KAPDH), an alumni association
of an Indonesian boarding school. Only alumni can register. The backend at api.kapdh.or.id is live.

Demo accounts (email / password):
- Active member: <demo-a-email> / <password>   (membership card, news, events, directory, chat, notifications)
- Second active member: <demo-c-email> / <password>   (use to test chat, report and block with the first account)
- Unpaid member: <demo-b-email> / <password>   (shows the membership dues flow)
Login needs only email and password. No one-time code is needed for these accounts.
Please use an active member account to review news, events, the member directory and chat. These are services for
verified members of the association; the unpaid account is not yet a verified member and shows only the dues flow.

Membership dues and event tickets:
- Dues are the yearly membership fee of the real-world association (registration Rp50,000 + member card Rp10,000,
  renewal Rp10,000 per year). Members pay by bank transfer to the association's account outside the app and upload
  the transfer receipt; the association's treasurer verifies it manually and then records the person as an active
  member of the association.
- The member directory, member chat and event registration are services of the association for its verified
  members, in the same way as a physical member card. They follow the membership status kept by the association;
  the app itself does not sell digital content, credits or subscriptions.
- Event tickets are for in-person alumni events and are paid the same way.
- The app does not offer in-app purchases or any payment processing.

User-generated content (Guideline 1.2):
- Only verified members can chat. Every profile, message and group can be reported (Report) and any user can be
  blocked (Block). Messages with unsafe links or hidden control characters are rejected by the server.
  Community guidelines: https://kapdh.or.id/ketentuan-komunitas
- Reports are reviewed by the association's moderators in a separate web portal; urgent reports (threats) within
  24 hours, others within 2 business days. Moderators can remove messages and restrict accounts.
- Contact: bantuan@kapdh.or.id

Account deletion (Guideline 5.1.1(v)):
- In the app: Akun > Hapus akun. The user confirms with the password; the request number and status are shown.
- On the web without the app: https://kapdh.or.id/delete-account
- Financial, ticket, report and audit records are kept in anonymised form, as stated on the screen and in the
  privacy policy.

Permissions: the camera and photo library are used only when the user chooses to take or pick a picture: a transfer
receipt, a profile photo, a photo in a chat, or a group photo. A transfer receipt can also be a PDF file. On Android
the app requests no camera or storage permission; it uses the system camera app and photo picker. Notifications are
used for payment, membership, event, news and chat updates.
```

Sebelum dikirim: ganti placeholder, pastikan nominal sama dengan `app_settings.fees` production, dan bahwa teks tidak
menyebut fitur yang belum ada di build. Catatan ini hanya jujur selama teks aplikasi memenuhi bagian 2 (sesuai sejak
21 Oktober 2026); jalankan ulang perintah `grep` bagian 2 pada commit build yang diajukan. Kalimat izin mengikuti
pemakaian kamera dan galeri di aplikasi: bukti transfer (`kapdh-mobile/lib/features/payments/proof_file.dart:162-191`),
foto profil (`kapdh-mobile/lib/features/account/avatar_image.dart:29-30`), foto chat
(`kapdh-mobile/lib/features/chat/chat_room_screen.dart:183-202`), dan foto grup
(`kapdh-mobile/lib/features/chat/new_group_screen.dart:67`, `kapdh-mobile/lib/features/chat/chat_info_screen.dart:96`).
Android tanpa izin `CAMERA` maupun `READ_MEDIA_*` (`kapdh-mobile/android/app/src/main/AndroidManifest.xml:3-6`; audit
APK 25 Oktober 2026).

## 6. Rencana cadangan iOS (D13, ADR-015)

Pemicu: Apple menolak build dengan alasan 3.1.1 (pembayaran membuka fitur) dan banding/penjelasan tidak diterima.

Prasyarat (cek semua sebelum mengaktifkan):

- [ ] Web admin yang dirilis memiliki layar pencatatan iuran di luar aplikasi (`POST /admin/payments`,
      `adminRecordPayment`): dialog "Catat iuran" di halaman Pembayaran dan detail anggota (hardening admin Fase D,
      D6-01/D6-02, `apps/admin/src/routes/payments/RecordDuesDialog.tsx`; menolak bila nominal iuran belum disahkan).
      Diuji pada mock (`record.test.tsx`) dan terhadap API nyata (`pnpm test:live`, "D6-01, D6-02, AC F07-5: Catat
      iuran ..."). Latih alurnya di staging sebelum fallback diaktifkan.
- [ ] BD dan pengurus pembayaran memahami alur: anggota iOS membayar lewat instruksi yang dikirim pengurus (WhatsApp
      atau email), pengurus memverifikasi, lalu mencatat iuran dengan bukti yang diterima (kuota 10 bukti per admin
      per hari, ADR-011).
- [ ] Teks bantuan untuk anggota iOS disiapkan (kanal: `support.whatsapp` dan `bantuan@kapdh.or.id`).

Langkah:

1. Web admin → Pengaturan → "Sembunyikan instruksi iuran di" → centang **iOS** → simpan (tanpa reautentikasi sejak
   ADR-025). Audit tercatat; `app_settings.payment_instructions.dues_hidden_platforms = ["ios"]`.
2. Verifikasi dengan akun uji di iPhone: layar Biaya KTA/Perpanjangan tidak menampilkan rekening maupun unggah bukti
   dan menampilkan kontak pengurus; Android tidak berubah; tiket tetap dapat dibayar di kedua platform.
3. Kirim ulang build/banding ke Apple dengan catatan: "On iOS the app does not show payment instructions for
   membership dues; dues are handled by the association outside the app."
4. Operasional: anggota iOS menghubungi pengurus → bayar di luar aplikasi → pengurus mencatat iuran → anggota menerima
   notifikasi dan KTA aktif.
5. Mengembalikan: hapus centang iOS. Payment yang dibuat selama fallback tetap berlaku.

Batasan yang diketahui: anggota iOS yang punya payment iuran `rejected` tidak dapat dicatatkan pengurus (409) karena
hanya pemilik yang dapat mengirim ulang bukti (PRD 4.3); keputusan PP masih terbuka (handoff C3).

## 7. Pemeriksaan kebijakan sebelum submit (PRD 9.3)

| Rujukan | Persyaratan | Bukti di aplikasi/repo | Diperiksa |
| ------- | ----------- | ---------------------- | --------- |
| [R1] Apple 5.1.1(v) | Penghapusan akun di dalam aplikasi beserta data terkait; pengungkapan retensi | Akun → Hapus akun (`/account/delete`, reautentikasi sandi, pengungkapan `GET /me/deletion/disclosure`, nomor permintaan, portal `/deletion-status`); job `account.deletion` + ledger (ADR-014) | |
| [R2] Google Play | Jalur dalam aplikasi + sumber web tanpa memasang aplikasi | `https://kapdh.or.id/delete-account` (OTP email, `POST /public/deletion/{challenge,verify,confirm}`); isi "Delete account URL" di Data safety | |
| [R6] 1.2 UGC | Filter konten tidak pantas, laporan + respons tepat waktu, blokir, kontak | Laporkan pengguna/pesan/grup (`POST /reports`), blokir (`/blocks`), banding (`/appeals`), antrean moderasi web admin (`/moderation`, urgent 24 jam, lainnya 2 hari kerja), tindakan dismiss/warn/suspend + hapus pesan, `ketentuan-komunitas`, kontak `bantuan@kapdh.or.id`. Filter dasar (PRD 3.12, `apps/api/src/modules/chat/content-filter.ts`) menolak karakter kendali, pengubah arah teks, dan tautan `javascript:`/`vbscript:`/`data:` berbahaya pada pesan dan nama grup; **tidak ada** daftar kata kasar atau pemindaian gambar (sengaja, menunggu keputusan pengurus). Chat hanya untuk anggota terverifikasi. Keputusan PP apakah daftar kata ditambahkan sebelum submit | |
| [R6] 1.2 persetujuan ketentuan | Pengguna menyetujui ketentuan yang menyatakan tidak ada toleransi terhadap konten tidak pantas/pengguna kasar | Registrasi wajib menyetujui `kebijakan-privasi` + `ketentuan` (`accept_policy_version`); naskah `ketentuan` wajib memuat pernyataan itu dan merujuk `ketentuan-komunitas` | |
| [R6] 3.1 / [R7] | Pembayaran di luar sistem toko hanya untuk layanan/barang di dunia nyata | Bagian 2; tidak ada IAP atau pemrosesan pembayaran di aplikasi; fallback bagian 6 | |
| D13 mitigasi 1 | Teks aplikasi tidak mengaitkan iuran dengan membuka fitur | Perintah `grep` bagian 2 kosong (atau sisa baris disahkan PP) pada commit build yang diajukan; tangkapan layar toko diperiksa manual. **Lulus sejak 21 Oktober 2026**: `grep` 0 baris (diulang 25 Oktober 2026 pada `7ce1ed8`: 0). Ulangi pada commit build | |
| [R6] 5.1.1 | Kebijakan privasi, izin dengan alasan jelas, data minimum | Bagian 4; teks izin kamera/galeri di `Info.plist` menyebut bukti transfer, foto profil, foto chat, dan foto grup (diperbarui 25 Oktober 2026, bagian 10) | |
| Kebijakan privasi dapat dibaca tanpa JavaScript | URL kebijakan privasi (dan `ketentuan-komunitas` untuk Child safety standards, bagian 9.4) yang diisi di toko menampilkan naskah, bukan hanya kerangka | Naskah tayang kelima halaman informasi/legal ditanam statis saat build dari salinan `apps/web/src/published-pages/` (penjelasan dan pemeriksaan di bawah tabel). **Lulus di kode per 25 Oktober 2026** (gerbang build `assert-published-pages.mjs`, uji `published-pages.test.ts`, uji asap image `smoke-static.sh`); production baru lulus setelah image web dari perubahan ini dideploy, jadi ulangi `curl` di bawah pada URL final | |
| [R6] 2.1 | Aplikasi lengkap dan backend aktif saat review | Production aktif (go-live langkah 4), akun demo bagian 3 | |
| Google Play Data safety | Formulir lengkap dan konsisten dengan kebijakan privasi | Bagian 4; keputusan K1, K2, K8 di bagian 10 | |
| Google Play App content | App access, Ads, Advertising ID, IARC, target audiens, Financial features, Health, Government, News, Child safety standards | Bagian 9; keputusan K3-K7 di bagian 10. Child safety standards butuh URL `ketentuan-komunitas` yang terbaca tanpa JavaScript (baris "Kebijakan privasi dapat dibaca tanpa JavaScript") | |
| Google Play target API | Target SDK sesuai persyaratan Play saat submit | Ditentukan Flutter 3.47 (`flutter.targetSdkVersion`); periksa saat build | |

Kebijakan privasi tanpa JavaScript. Sampai `7ce1ed8`, `apps/web/src/pages/[slug].astro` hanya membangun kerangka: isi
dibaca saat runtime dari `GET /public/pages/{slug}`, dan tanpa JavaScript halaman hanya menampilkan "Aktifkan
JavaScript untuk membaca versi terbaru halaman ini", sehingga perayap review atau pemeriksaan otomatis dapat menilai URL
kebijakan privasi kosong. Dipilih render statis isi terbit saat build, dengan build ulang setiap kali naskah terbit:

- `[slug].astro` menanam naskah TAYANG `/kebijakan-privasi`, `/ketentuan`, `/ketentuan-komunitas`, `/bantuan`, dan
  `/tentang` beserta baris "Versi N · Diterbitkan ..." ke HTML hasil build. Sumbernya salinan
  `apps/web/src/published-pages/<slug>.json`, yaitu respons `GET /public/pages/{slug}` production yang ditarik
  `pnpm --filter @kapdh/web pages:sync` dan di-commit, sehingga build tidak bergantung pada API dan setiap perubahan
  naskah di situs ditinjau lewat PR.
- Sumbernya bukan `docs/legal`: berkas di sana dapat memuat revisi yang belum terbit (penanda `[tanggal terbit]`
  revisi profil berulang), dan naskah yang tayang per 25 Oktober 2026 (Kebijakan Privasi v4, Ketentuan Layanan v4,
  Ketentuan Komunitas v2, Bantuan v6, Tentang v3) tidak sama persis dengan berkas mana pun di riwayat `docs/legal`.
  `pages:sync` dan gerbang build menolak naskah yang memuat `[tanggal terbit]` atau kerangka DRAF seed.
- Isi statis dirender dengan sanitizer yang sama dengan render runtime (`apps/web/src/scripts/sanitize.ts`), tanpa
  skrip atau gaya inline (gerbang CSP tetap lulus), dan bagian Legalitas statis `/tentang` tidak berubah. Saat
  JavaScript aktif halaman tetap membaca API: terbitan berversi lain langsung menggantikan isi statis, sedangkan bila
  API tidak terjangkau isi statis tetap tampil.
- Penjaga: gerbang build `apps/web/scripts/assert-published-pages.mjs` (seluruh teks setiap salinan ada di
  `#info-body` HTML hasil build beserta versinya), uji `apps/web/src/lib/published-pages.test.ts` di lajur `pnpm test`
  web (merender `[slug].astro` dan membaca HTML-nya tanpa menjalankan skrip), dan `infra/scripts/smoke-static.sh web`
  pada image di CI (kelima halaman lewat `curl`).

Konsekuensinya, setiap terbitan naskah di web admin harus disusul salinan baru dan deploy ulang image web
(`docs/legal/README.md`, Setelah menerbitkan); sampai itu terjadi, pembaca tanpa JavaScript melihat versi sebelumnya,
lengkap dengan nomor versi dan tanggal terbitnya. Sebelum submit, dan setiap kali naskah terbit, pastikan salinan sama
dengan yang tayang lalu periksa URL final dengan kalimat yang pasti ada di naskah:

```sh
pnpm --filter @kapdh/web pages:check   # keluar 1 bila salinan berbeda dari naskah tayang
curl -s https://kapdh.or.id/kebijakan-privasi | grep -c "Pengendali data pribadi untuk layanan yang dijelaskan dalam kebijakan ini"   # harus >= 1
```

Pada image `7ce1ed8` hasil `curl` pasti 0. Pada hasil build perubahan ini hasilnya 1 (diperiksa 25 Oktober 2026 pada
`apps/web/dist/kebijakan-privasi/index.html`); URL production baru lulus setelah image web itu dideploy.

## 8. Bila ditolak

1. DEV mencatat ID submission, pasal yang dikutip, dan tangkapan layar penolakan di paket bukti.
2. PP memutuskan: jawab di Resolution Center/Play Console dengan penjelasan (templat bagian 5), perbaiki listing/teks,
   atau aktifkan bagian 6 (iOS) setelah prasyaratnya terpenuhi.
3. Perubahan kode mengikuti alur rilis biasa (`go-live.md` bagian 1); jangan menaikkan `min_app_version` sebelum
   versi perbaikan dapat diunduh.
4. Pengumuman ke alumni tetap menunggu persetujuan toko (PRD 8.3 langkah 4).

## 9. Lembar jawaban App content Google Play

Play Console → Policy → App content. Label di Console dapat berubah; jawaban di bawah mengikuti isinya. Singkatan
path sama dengan bagian 4. Simpan tangkapan layar setiap deklarasi yang dikirim di paket bukti.

| Deklarasi | Jawaban | Bukti |
| --------- | ------- | ----- |
| Privacy policy | `https://kapdh.or.id/kebijakan-privasi` | Naskah KP; URL wajib terbaca tanpa JavaScript (bagian 7: lulus di kode per 25 Oktober 2026, di production setelah image web dideploy) |
| App access | All or some functionality is restricted; instruksi di 9.1 | Bagian 3 dan 9.1 |
| Ads | Tidak, aplikasi tidak memuat iklan | `kapdh-mobile/pubspec.yaml:27-63` tanpa SDK iklan; KP:26, KP:124 |
| Advertising ID | Tidak memakai advertising ID | `kapdh-mobile/android/app/src/main/AndroidManifest.xml:3-6` tanpa `AD_ID`; Firebase hanya `firebase_core` dan `firebase_messaging` (`kapdh-mobile/pubspec.yaml:36-37`), tanpa Analytics; audit APK 25 Oktober 2026 tanpa `AD_ID` pada manifest gabungan. Periksa ulang pada AAB yang diunggah (di bawah tabel) |
| Content rating | Kuesioner IARC, lembar 9.2 | 9.2 |
| Target audience and content | Hanya 18 tahun ke atas, lembar 9.3 | 9.3 |
| Data safety | Lembar bagian 4 | Bagian 4 |
| Government apps | Bukan aplikasi pemerintah | Pengendali data adalah perkumpulan alumni, bukan lembaga pemerintah (KP:5) |
| Financial features | My app doesn't provide any financial features | Iuran dan tiket ditransfer ke rekening organisasi di luar aplikasi. Aplikasi hanya menampilkan instruksi, menerima unggahan bukti, dan menampilkan status (bagian 2; KP:68). Tidak ada IAP, billing, dompet, pinjaman, atau pemrosesan kartu (`kapdh-mobile/pubspec.yaml:27-63`) |
| Health apps | Tidak ada fitur kesehatan | Tidak ada data kesehatan atau kebugaran (KP:124) |
| News apps | Bukan aplikasi berita (usulan). **Keputusan PP K3** | Berita adalah kabar internal organisasi yang ditulis pengurus lewat web admin (`schema/content.ts:49`) dan hanya dibuka anggota aktif (`mobile/features/news/news_list_screen.dart:37`) |
| Child safety standards | Wajib untuk kategori Sosial; lembar 9.4 | 9.4 |

Pemeriksaan `AD_ID` pada AAB rilis sebelum mengisi Advertising ID (hasil yang diharapkan: kosong):

```sh
bundletool dump manifest --bundle app-release.aab | grep -i "AD_ID"
```

### 9.1 App access

Pilih "All or some functionality in my app is restricted", lalu tambahkan satu instruksi untuk setiap akun:

| Instruksi | Akun | Isi |
| --------- | ---- | --- |
| 1 (wajib) | Demo A, anggota aktif terverifikasi | Email dan sandi. Catatan: "Active member. Use this account to review the membership card, news, events and ticket reservation, member directory, chat, report and block." |
| 2 (wajib) | Demo C, anggota aktif kedua | Email dan sandi. Catatan: "Second active member, to chat with, report and block the first account." |
| 3 | Demo B, belum bayar | Email dan sandi. Catatan: "Registered, not yet a verified member of the association. Shows the membership dues flow only; news, events, the directory and chat are services for verified members." |

Reviewer **wajib** menerima akun aktif terverifikasi (Demo A dan C), bukan hanya Demo B. Akun berstatus `unverified`
(belum bayar) tidak dapat membuka berita, event, Jejaring (direktori), maupun chat:

- Tab Event dan Jejaring dikunci untuk status selain aktif (`mobile/app/app_shell.dart:66-72`, lembar penjelasan
  `:249-262`). Matriks rute `unverified` tidak memuat events, network, maupun chat (`mobile/app/redirect.dart:129-139`,
  `:148`, dibandingkan `verified` di `:150-159`).
- Layar berita dan event menampilkan `MemberOnlyNotice`, bukan isinya
  (`mobile/features/home/shared/member_gate.dart:9-16`; `mobile/features/news/news_list_screen.dart:37`;
  `mobile/features/news/news_detail_screen.dart:38`; `mobile/features/events/events_screen.dart:70`). Server juga
  menolak dengan 403 `MEMBERSHIP_REQUIRED` (`member_gate.dart:15-16`).
- Akibatnya, fitur yang diperiksa kebijakan UGC dan Child safety standards (chat, Laporkan, Blokir) hanya dapat dicapai
  lewat Demo A atau C. Tanpa akun aktif, review dapat ditolak karena fungsi tidak dapat diakses.

Login cukup email dan sandi, tanpa OTP (bagian 3). Isi teks instruksi dari templat bagian 5. Selama review, Demo A
dan C harus berstatus aktif, tidak tersuspensi, dan tampil di direktori (bagian 3).

### 9.2 Content rating (kuesioner IARC)

| Topik | Jawaban | Bukti dan alasan |
| ----- | ------- | ---------------- |
| Email kontak rating | Email organisasi yang menerima sertifikat IARC; **keputusan PP K7** | – |
| Kategori | Kategori jejaring sosial/komunikasi dengan konten buatan pengguna; bukan Game, bukan Reference/News, bukan hiburan | Inti aplikasi: keanggotaan, Jejaring, chat (`schema/community.ts:72-214`) |
| Kekerasan | Tidak | Konten resmi aplikasi (berita, event, KTA) dibuat pengurus (`schema/content.ts:49`, `schema/events.ts:25`). Ancaman dan kekerasan dalam UGC dilarang (KK:77-83) |
| Rasa takut / horor | Tidak | Sama dengan baris kekerasan |
| Seksualitas / ketelanjangan | Tidak | UGC seksual dan eksploitasi anak dilarang (KK:61-75) |
| Bahasa kasar / humor kasar | Tidak | Konten resmi tidak memuatnya; pelecehan dan ujaran kebencian dalam UGC dilarang (KK:47-59) |
| Zat terlarang (narkoba, alkohol, rokok) | Tidak | Promosi narkotika dalam UGC dilarang (KK:112) |
| Perjudian (simulasi atau uang nyata) | Tidak | Promosi judi dilarang (KK:111); tidak ada mekanisme taruhan |
| Diskriminasi / kebencian | Tidak | KK:55-59 |
| Pengguna dapat berinteraksi atau bertukar konten (teks, gambar) | **Ya** | Chat langsung dan grup dengan teks dan gambar (`schema/community.ts:72-190`), hanya untuk anggota aktif (`mobile/app/redirect.dart:150-159`); Laporkan dan Blokir (9.4); moderasi (KK:197-212) |
| Berbagi informasi pribadi pengguna dengan pengguna lain | **Ya** | Profil di Jejaring: nama, angkatan, foto, kota, profesi. Email, telepon, dan media sosial tampil hanya bila diaktifkan (KP:159-163; `schema/membership.ts:104-107`) |
| Berbagi lokasi fisik pengguna saat ini | Tidak | Tanpa izin lokasi; EXIF/GPS dibuang; kota diketik (bagian 4.1, baris Location) |
| Pembelian barang digital | Tidak | Tanpa IAP atau billing; iuran dan tiket untuk keanggotaan dan acara di dunia nyata dibayar di luar aplikasi (bagian 2) |
| Akses internet tanpa batas / peramban | Tidak | Tanpa WebView (`kapdh-mobile/pubspec.yaml:27-63`). Tautan luar dibuka di aplikasi luar setelah konfirmasi (`mobile/features/home/shared/links.dart:42-63`, `mobile/core/ui/external_links.dart:8-11`) |

Catat hasil rating per wilayah dan elemen interaktif yang diberikan (diharapkan memuat "Users Interact") di paket bukti.
Rating IARC dihitung dari isi aplikasi dan berdiri sendiri, terpisah dari target audiens 18+ di 9.3. Bila fitur
berubah (mis. pemutar video atau pembelian), kuesioner wajib diisi ulang.

### 9.3 Target audience and content

- Kelompok usia target: **hanya "18 and over"**. Bukti: layanan hanya untuk alumni berusia 18 tahun ke atas, yang
  dinyatakan dengan menyetujui Ketentuan Layanan saat registrasi (`docs/legal/ketentuan.html:19`, `:24`; KP:362-363;
  `docs/legal/bantuan.html:15`; persetujuan `accept_policy_version` wajib di `contracts/auth.yaml:755`).
- Aplikasi tidak meminta tanggal lahir (KP:362). Akun yang diketahui milik anak di bawah 18 tahun dinonaktifkan dan
  dihapus (KP:363).
- Bila ditanya apakah listing dapat menarik perhatian anak secara tidak sengaja, jawab **tidak**: listing ditujukan
  bagi alumni dewasa dan tidak memakai karakter kartun atau elemen gim. Periksa aset listing sebelum menjawab.
- Families Policy dan program Teacher Approved tidak berlaku.

### 9.4 Child safety standards (kategori Sosial)

| Persyaratan | Jawaban | Bukti |
| ----------- | ------- | ----- |
| Standar terbit melawan eksploitasi dan pelecehan seksual anak (CSAE) | `https://kapdh.or.id/ketentuan-komunitas`, bagian "Perlindungan anak" | KK:67-75 (larangan materi eksploitasi seksual anak, grooming, sekstorsi, dan perdagangan anak; penghapusan; pembatasan akun tanpa peringatan; penerusan ke aparat penegak hukum), KK:126-128 (tanpa toleransi), KK:192 (lapor tanpa melampirkan tangkapan layar). Halaman menyebut nama aplikasi "KAPDH" (KK:1) |
| Mekanisme masukan di dalam aplikasi | Ya: Laporkan pesan, anggota, dan grup tanpa keluar dari aplikasi | Pesan: `mobile/features/chat/chat_room_screen.dart:335-337`. Anggota: `mobile/features/network/member_profile_screen.dart:134` dan `mobile/features/chat/chat_info_screen.dart:440`. Grup: `chat_info_screen.dart:471`. Lembar laporan dan kategori: `mobile/features/network/report_sheet.dart:22-31`, `:135`. Status di Akun → Laporan saya (KK:187-188). Kanal tambahan bagi yang tidak dapat memakai fitur laporan: `bantuan@kapdh.or.id` (KK:190-192) |
| Penanganan CSAM | Konten dihapus, akun dibatasi tanpa peringatan, bukti tersimpan otomatis | KK:74-75; tindakan moderator `removeMessage`, warn, dan suspend (`api/modules/moderation/admin-reports.service.ts:78`, `:849-873`, `:894-895`) |
| Kepatuhan pada hukum keselamatan anak | Pengurus meneruskan informasi ke aparat penegak hukum sesuai peraturan | KK:74; prosedur rinci **keputusan PP K6** |
| Titik kontak keselamatan anak | Nama orang dan kontaknya (email; telepon bila diminta). **Keputusan PP K4** | Kontak publik yang ada: `bantuan@kapdh.or.id` (KP:8) |

Prasyarat sebelum deklarasi dikirim:

- URL `ketentuan-komunitas` harus terbaca tanpa JavaScript. Google mensyaratkan halaman standar dapat dibuka publik
  tanpa galat. Naskah tayang (Ketentuan Komunitas v2, salinan
  `kapdh-platform/apps/web/src/published-pages/ketentuan-komunitas.json`) sudah dirender statis di kode per
  25 Oktober 2026 (bagian 7) dan memuat bagian Perlindungan anak. Setelah image web itu dideploy, periksa dengan
  `curl -s https://kapdh.or.id/ketentuan-komunitas | grep -c "Perlindungan anak"` (harus >= 1).
- Yang diisi ke Play adalah URL naskah tayang. `docs/legal/ketentuan-komunitas.html` masih memuat penanda
  `[tanggal terbit]` (KK:2) untuk revisi yang belum terbit; penanda itu tidak tampil di situs.

Celah prioritas laporan (usulan, **belum diterapkan**; dokumen ini tidak mengubah kode). Hanya kategori
`violence_threat` yang urgent dengan target 24 jam. Kategori lain, termasuk "Konten seksual", berprioritas normal
dengan target 2 hari kerja (`api/modules/moderation/due-at.ts:19-22`, dipakai
`api/modules/moderation/reports.service.ts:195`). KK:182 mengarahkan konten yang membahayakan anak ke kategori
ancaman (urgent), tetapi pelapor materi eksploitasi anak kemungkinan besar memilih "Konten seksual"
(`mobile/features/network/report_sheet.dart:26`). Usulan untuk K5:

- **Opsi A (disarankan untuk R1.0):** `priorityFor` juga mengembalikan `urgent` untuk `sexual`. Perbarui
  `due-at.test.ts`, petunjuk kategori di `report_sheet.dart:39`, KK:182 dan KK:206-212, aturan domain kontrak
  admin-moderation, dan PRD 3.12 (v3.2). Tidak menambah kategori, jadi kontrak enum tetap.
- **Opsi B:** kategori baru khusus keselamatan anak (mis. `child_safety`, urgent) di kontrak
  `ModerationReportCategory`, aplikasi, web admin, dan KK. Lebih jelas bagi pelapor, tetapi mengubah kontrak.

## 10. Keputusan pemilik produk (PP) sebelum mengisi App content

Formulir di bagian 4 dan 9 baru dapat dikirim setelah keputusan berikut diambil. Catat keputusan, tanggal, dan
alasannya di paket bukti.

| No | Keputusan | Pilihan | Usulan | Rujukan |
| -- | --------- | ------- | ------ | ------- |
| K1 | Kota domisili dideklarasikan sebagai Location → Approximate location? | (a) Ya, Approximate location, opsional; (b) tidak, cukup Personal info → Other info | (a). Google mendefinisikan Approximate location sebagai lokasi dengan luas >= 3 km², misalnya kota tempat pengguna berada; kota domisili tampil di KTA dan Jejaring | Bagian 4.1; KP:49 |
| K2 | Kategori Political or religious beliefs (Google) dan Sensitive Info (Apple) dideklarasikan? | (a) Tidak, karena tidak ada field agama; (b) ya, karena keanggotaan perkumpulan alumni pesantren dapat menunjukkan latar keagamaan | (a), dengan alasan dicatat: KP:124 menyatakan agama tidak dikumpulkan, dan deklarasi "ya" bertentangan dengan naskah itu. Bila PP/hukum memilih (b), KP:124 dan KP:368 harus direvisi lebih dulu | Bagian 4.1, 4.3 |
| K3 | Deklarasi News apps | (a) Bukan aplikasi berita; (b) aplikasi berita | (a): berita adalah kabar internal organisasi untuk anggota aktif, bukan penerbitan berita umum | Bagian 9 |
| K4 | Titik kontak keselamatan anak (Child safety standards) | Nama orang yang mampu menjelaskan praktik pencegahan CSAM, beserta email (dan telepon bila diminta) | Ketua tim moderasi atau pengurus yang ditunjuk; email boleh `bantuan@kapdh.or.id` bila kotak itu dipantau setiap hari | Bagian 9.4 |
| K5 | Prioritas laporan konten seksual dan eksploitasi anak | Opsi A atau B di 9.4, atau tetap normal | Opsi A sebelum submit (perubahan kode kecil di PR terpisah) | Bagian 9.4; `api/modules/moderation/due-at.ts:19-22` |
| K6 | Prosedur penerusan CSAM ke aparat penegak hukum dan penanganan bukti | Siapa yang meneruskan, ke kanal mana, dalam berapa lama; siapa yang boleh membuka salinan bukti, dan kapan salinan itu dihapus setelah diteruskan (bukti laporan tetap disimpan, KP:240) | Ditetapkan PP bersama penasihat hukum sebelum deklarasi dikirim | KK:74-75; KP:240 |
| K7 | Email kontak kuesioner IARC | Alamat organisasi | Alamat organisasi yang dipantau, bukan email pribadi | Bagian 9.2 |
| K8 | SDK FCM dapat membuat token saat aplikasi dibuka (auto-init aktif), padahal KP:106 menyebut token dibuat setelah login | (a) Matikan auto-init FCM (perubahan kode); (b) revisi kalimat KP:106 | Putuskan setelah DEV memverifikasi perilaku SDK pada build rilis; Data safety tetap mendeklarasikan Device or other IDs sebagai Wajib | Bagian 4.1 (catatan Device or other IDs) |

Tindak lanjut DEV di luar dokumen ini:

- Selesai 25 Oktober 2026: teks izin iOS di `kapdh-mobile/ios/Runner/Info.plist:58-61` kini mengikuti pemakaian di
  aplikasi (Apple 5.1.1). Kamera dipakai untuk bukti transfer, foto profil, dan foto chat
  (`mobile/features/payments/proof_file.dart:162-176`, `mobile/features/account/avatar_image.dart:29-30`,
  `mobile/features/chat/chat_room_screen.dart:183-202`). Galeri dipakai untuk keempatnya, termasuk foto grup
  (`mobile/features/chat/new_group_screen.dart:67`, `mobile/features/chat/chat_info_screen.dart:96`). Bila pemakaian
  kamera atau galeri berubah, perbarui teks ini dan kalimat izin di templat bagian 5.
- Perubahan prioritas laporan (K5) dan auto-init FCM (K8) mengikuti keputusan PP, lewat PR terpisah.
