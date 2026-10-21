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
| Push | Capability Push Notifications (`aps-environment`) + kunci APNs di Firebase production; `POST_NOTIFICATIONS` Android 13+ sudah dideklarasikan | Entitlement iOS belum ada |
| Deep link | `kapdh://app/...` sudah; HTTPS `https://kapdh.or.id/app/...` butuh `assetlinks.json` dan `apple-app-site-association` di `/.well-known/` serta Associated Domains iOS | Belum: berkas tidak ada di `apps/web/public`, dan `infra/nginx-web.conf` menolak semua path berawalan titik (`location ~ /\.` → 404), sehingga verifikasi App Links/Universal Links gagal sampai nginx mengecualikan `/.well-known/` |
| Font | Poppins dibundel sebagai font aset (`kapdh-mobile/assets/fonts/poppins`, ARCHITECTURE §8.1); aplikasi tidak menghubungi server font pihak ketiga | Ada |
| Konfigurasi build | `flutter build appbundle` / `flutter build ipa` dengan `--dart-define-from-file=<berkas production dari secret CI>` yang memuat `KAPDH_ENV=production`, `API_BASE_URL=https://api.kapdh.or.id/api/v1`, `PUSH_ENABLED=true` dan `FIREBASE_*` | `config/production.json` di repo sengaja kosong untuk Firebase |
| Versi | `pubspec.yaml` `version: x.y.z+n`; `min_app_version` di web admin sama dengan versi rilis pertama | `1.0.0+1` saat ini (sama dengan `min_app_version` seed); naikkan `+n` setiap unggahan |

Listing (keduanya):

- Nama: "KAPDH" atau nama resmi yang disahkan PP; kategori Social Networking / Sosial (atau Lifestyle).
- URL kebijakan privasi: `https://kapdh.or.id/kebijakan-privasi`; URL dukungan: `https://kapdh.or.id/kontak`;
  email dukungan dan kontak moderasi: `bantuan@kapdh.or.id`.
- Rating usia: aplikasi memiliki komunikasi antarpengguna (chat) dan konten buatan pengguna; jawab kuesioner
  (Apple: "Unrestricted Web Access" tidak; "User Generated Content" ya. IARC Google: interaksi pengguna ya, berbagi
  lokasi tidak, pembelian digital tidak).
- Sign in with Apple tidak diwajibkan: aplikasi tidak menawarkan login pihak ketiga, hanya email + sandi akun
  organisasi.

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

- Login anggota hanya email + sandi (tanpa OTP saat login; diverifikasi pada uji coba lokal 14 Oktober 2026), jadi
  reviewer dapat masuk tanpa akses kotak surat.
- Simpan kredensial di password manager organisasi; isi di App Store Connect (App Review Information → Sign-in
  required) dan Play Console (App content → App access). Ganti sandi setelah review selesai.
- Selama review: Demo A/C/D tampil di direktori (`show_in_directory` bawaan aktif) agar reviewer dapat memulai chat;
  pastikan ada minimal satu event `open` (gratis lebih mudah diuji) dan satu berita terbit. Event khusus review
  diberi judul netral dan ditutup/dibatalkan setelah review (pembatalan memberi notifikasi peserta).
- Bukti transfer yang diunggah reviewer dari Demo B ditolak BD dengan catatan "akun demo reviewer" (bukan disetujui).
- Periksa harian bahwa akun demo tidak tersuspensi, tidak kedaluwarsa, dan belum dihapus.

## 4. Pemetaan formulir privasi dari model data

Sumber: skema `kapdh-platform/packages/database/src/schema/*.ts`, kontrak `RegisterRequest` (auth.yaml), izin
`AndroidManifest.xml` (INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS) dan `Info.plist`
(`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`). Semua data dipakai untuk **fungsi aplikasi**; tidak ada
iklan, analitik pihak ketiga, atau pelacakan lintas aplikasi. NIK/Nomor KTP tidak pernah dikumpulkan (N-09).

| Data | Tabel/kolom | Wajib? | Apple (App Privacy) | Google (Data safety) | Catatan |
| ---- | ----------- | ------ | ------------------- | -------------------- | ------- |
| Nama lengkap | `alumni.full_name` | wajib | Contact Info → Name | Personal info → Name | Tampil di KTA, direktori (sesuai privasi), verifikasi KTA publik |
| Email | `users.email` | wajib | Contact Info → Email Address | Personal info → Email address | Login, OTP, notifikasi email; tampil di direktori hanya bila `show_email` |
| Nomor telepon | `alumni.phone` | opsional | Contact Info → Phone Number | Personal info → Phone number | Tampil hanya bila `show_phone` |
| Jenis kelamin, angkatan, kelas masuk/keluar | `alumni.gender`, `cohort`, `class_in`, `class_out` | wajib | Other Data (atau User Content → Other) | Personal info → Other info | Membentuk nomor anggota AA.SS.JK.N |
| Kota, pendidikan terakhir, bio, media sosial, profesi, keahlian | `alumni.city`, `last_education_*`, `bio`, `social_*`, `alumni_professions`, `alumni_skills` | opsional | Other Data / Other User Content | Personal info → Other info | Kota diketik pengguna, bukan lokasi perangkat |
| Foto profil | `files` purpose `avatar` | opsional | User Content → Photos or Videos | Photos and videos → Photos | EXIF dibuang dan gambar di-encode ulang di server |
| Bukti transfer | `files` purpose `payment_proof` (gambar atau PDF) | wajib untuk membayar di aplikasi | Financial Info → Other Financial Info; User Content → Photos | Financial info → Other financial info; Photos; Files and docs | Privat; dilihat pengurus pembayaran; dihapus saat akun dihapus (D2) |
| Riwayat iuran/tiket | `payments`, `payment_events`, `tickets` | otomatis | Purchases → Purchase History | Financial info → Purchase history | Pembayaran di luar aplikasi; catatan keuangan tersisa anonim setelah akun dihapus (D2) |
| Pesan chat dan gambar chat | `messages`, `files` purpose `chat_image` | opsional (fitur) | User Content → Emails or Text Messages; Photos | Messages → Other in-app messages; Photos | Isi chat tidak pernah ada di log/audit/push lock-screen |
| Laporan dan banding | `reports` | opsional | User Content → Other User Content | App activity → Other user-generated content | Bukti diminimalkan (PRD 3.12) |
| Aktivitas di aplikasi | `post_likes`, reservasi tiket, read cursor, preferensi notifikasi, blokir | otomatis | Usage Data → Product Interaction | App activity → App interactions | Tidak dipakai untuk analitik |
| ID akun | `users.id` (UUID) | otomatis | Identifiers → User ID | Personal info → User IDs | |
| Token push, platform, versi aplikasi, nama perangkat | `device_tokens`, `sessions.platform/app_version/device_name` | otomatis (push opsional) | Identifiers → Device ID | Device or other IDs | Token dicabut saat logout/ganti akun |

Tidak dikumpulkan: lokasi (tidak ada izin lokasi), kontak, kesehatan, riwayat penelusuran web, riwayat pencarian
(kata kunci direktori tidak disimpan dan query string tidak dicatat di log), audio, data diagnostik/crash (belum ada
SDK error tracking di aplikasi; bila GlitchTip ditambahkan, tambahkan "Crash Data"/"Crash logs"). Alamat IP diproses
untuk rate limit dan tidak dicatat di log aplikasi API.

Jawaban umum:

- Data ditautkan ke identitas pengguna: **ya** (semua baris di atas). Pelacakan (Apple ATT/"Tracking"): **tidak**.
- Data dibagikan ke pihak ketiga (Google): **tidak**; pemroses atas nama organisasi: Firebase Cloud Messaging (token
  push), provider email transaksional D10 (alamat dan isi email), penyimpanan backup di luar VPS (terenkripsi).
- Dienkripsi saat transit: **ya** (HTTPS/WSS, N-07). Pengguna dapat meminta penghapusan: **ya** (bagian 7).
- Keputusan PP/hukum sebelum submit: keanggotaan pada asosiasi alumni pesantren dapat dianggap mengindikasikan
  keyakinan agama (Apple "Sensitive Info", Google "Religious beliefs"). Aplikasi tidak mengumpulkan field agama;
  putuskan apakah kategori ini dideklarasikan dan catat alasannya.
- Kebijakan privasi (`kebijakan-privasi`) wajib memuat daftar di atas, pemroses, retensi D2, cara penghapusan, dan
  kontak.

## 5. Templat catatan reviewer

Isi di App Store Connect (App Review Information → Notes) dan Play Console (App access → instructions). Bahasa
Inggris untuk reviewer; versi Indonesia disimpan di paket bukti.

```text
KAPDH is the official member app of Keluarga Alumni Pondok Pesantren Darel Hikmah (KAPDH), an alumni association
of an Indonesian boarding school. Only alumni can register. The backend at api.kapdh.or.id is live.

Demo accounts (email / password):
- Active member: <demo-a-email> / <password>   (membership card, events, directory, chat, notifications)
- Second active member: <demo-c-email> / <password>   (use to test chat, report and block with the first account)
- Unpaid member: <demo-b-email> / <password>   (shows the membership dues flow)
Login needs only email and password. No one-time code is needed for these accounts.

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

Permissions: camera and photo library are used only to attach a transfer receipt or a profile photo;
notifications are used for payment, membership, event and chat updates.
```

Sebelum dikirim: ganti placeholder, pastikan nominal sama dengan `app_settings.fees` production, dan bahwa teks tidak
menyebut fitur yang belum ada di build. Catatan ini hanya jujur bila teks aplikasi di bagian 2 sudah diperbaiki;
selama build masih menampilkan "terkunci"/"membuka kembali fitur", reviewer melihat kontradiksi dengan catatan ini.

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
| D13 mitigasi 1 | Teks aplikasi tidak mengaitkan iuran dengan membuka fitur | Perintah `grep` bagian 2 kosong (atau sisa baris disahkan PP) pada commit build yang diajukan; tangkapan layar toko diperiksa manual. **Gagal per 14 Oktober 2026 (13 baris)** | |
| [R6] 5.1.1 | Kebijakan privasi, izin dengan alasan jelas, data minimum | Bagian 4; teks izin kamera/galeri di `Info.plist` | |
| Kebijakan privasi dapat dibaca tanpa JavaScript | URL kebijakan privasi yang diisi di kedua toko menampilkan naskah, bukan hanya kerangka | Lihat pemeriksaan di bawah tabel. **Gagal pada `main`**: halaman legal adalah kerangka statis yang memuat isi lewat JavaScript | |
| [R6] 2.1 | Aplikasi lengkap dan backend aktif saat review | Production aktif (go-live langkah 4), akun demo bagian 3 | |
| Google Play Data safety | Formulir lengkap dan konsisten dengan kebijakan privasi | Bagian 4 | |
| Google Play target API | Target SDK sesuai persyaratan Play saat submit | Ditentukan Flutter 3.47 (`flutter.targetSdkVersion`); periksa saat build | |

Kebijakan privasi tanpa JavaScript. `apps/web/src/pages/[slug].astro` hanya membangun kerangka halaman; isi dibaca saat
runtime dari `GET /public/pages/{slug}`, dan tanpa JavaScript halaman hanya menampilkan "Aktifkan JavaScript untuk
membaca versi terbaru halaman ini". Perayap review atau pemeriksaan otomatis yang tidak menjalankan JavaScript dapat
menilai URL kebijakan privasi kosong. Periksa dengan kalimat yang pasti ada di naskah yang disahkan:

```sh
curl -s https://kapdh.or.id/kebijakan-privasi | grep -c "<kalimat dari naskah kebijakan privasi>"   # harus >= 1
```

Pada `main` hasilnya pasti 0: hasil build `apps/web/dist/kebijakan-privasi/index.html` (diperiksa 14 Oktober 2026)
hanya memuat judul, kerangka `#info-body`, dan teks `noscript` di atas. Sebelum submit, pemilik situs publik dan PP memilih salah satu: render statis halaman legal saat
build (build ulang setiap kali naskah terbit), atau salinan statis naskah yang disahkan di URL yang diisi ke toko dan
diperbarui bersama setiap terbitan. Ulangi pemeriksaan pada URL final.

## 8. Bila ditolak

1. DEV mencatat ID submission, pasal yang dikutip, dan tangkapan layar penolakan di paket bukti.
2. PP memutuskan: jawab di Resolution Center/Play Console dengan penjelasan (templat bagian 5), perbaiki listing/teks,
   atau aktifkan bagian 6 (iOS) setelah prasyaratnya terpenuhi.
3. Perubahan kode mengikuti alur rilis biasa (`go-live.md` bagian 1); jangan menaikkan `min_app_version` sebelum
   versi perbaikan dapat diunduh.
4. Pengumuman ke alumni tetap menunggu persetujuan toko (PRD 8.3 langkah 4).
