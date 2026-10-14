# Daftar periksa UAT KAPDH Apps R1.0 (U-01 sampai U-13)

Rujukan: PRD 9.1 (kelompok UAT), 9.2 (skenario kritis), 9.3 (gerbang), 3 (AC), 2.4 (N-01..N-16), 8.2-8.3; D7, D8.
Bukti otomatis per AC/N/U: [`docs/qa/traceability.md`](traceability.md) (audit Fase D). Daftar ini adalah bukti
**manual** di staging yang menyerupai target (PRD 9.3); bukti mode mock atau tangkapan layar saja tidak dihitung lulus
untuk AC (PRD 7.3). Smoke test production (`docs/runbooks/go-live.md` 3.1) memakai sebagian langkah di sini.

## Cara memakai

- Isi kolom **Hasil** dengan `Lulus`, `Gagal`, `Terblokir`, atau `Tidak diuji`; **Bukti** dengan nama berkas
  tangkapan layar/rekaman, `request_id` dari respons galat/log, atau ID audit; **Penguji, tanggal**.
- Kegagalan dicatat sebagai bug dengan ID dan tingkat (kritis/tinggi/sedang/rendah). Bug kritis/tinggi pada
  identitas, uang, kuota, data privat, atau akses admin memblokir go-live (PRD 9.3).
- Data staging sintetis; data pribadi nyata tidak disalin ke staging (PRD 5.3). Email uji memakai kotak surat yang
  dikendalikan tim QA (bukan `.test`, karena OTP harus diterima).
- Satu kelompok U lulus bila semua barisnya Lulus atau ada pengecualian minor yang disetujui PP dengan owner dan
  jadwal (PRD 9.3).

### Informasi sesi

| Hal | Nilai |
| --- | ----- |
| Lingkungan | `https://staging-api.kapdh.or.id`, `https://staging-admin.kapdh.or.id`, `https://staging.kapdh.or.id` |
| Tag rilis / image (digest) | |
| Build Android / iOS (versi wajib >= `min_app_version` staging) | |
| `min_app_version` staging (Pengaturan) | |
| SDK kontrak | `contracts-v` |
| Perangkat (D7: Android 8.0+, iOS 15+) | minimal 1 Android lama (API 26-28), 1 Android baru, 1 iPhone iOS 15/16, 1 iPhone terbaru |
| Peramban (dua versi terakhir) | Chrome, Edge, Firefox, Safari desktop |

Sebelum langkah mobile mana pun: versi build (`pubspec.yaml` `version`, dikirim sebagai `X-App-Version`) harus >=
`min_app_version` lingkungan. Seed referensi mengisi `1.0.0`, sedangkan pubspec saat ini `0.1.0+1`, sehingga semua
mutasi dari build itu ditolak 426 `UPGRADE_REQUIRED`. Pakai build `1.0.0+n` atau lebih, atau (staging saja) samakan
`min_app_version` dengan versi build lewat Pengaturan dan catat nilainya di tabel ini. U-13 13.7 menguji penolakan ini
secara sengaja.

### Peran dan akun uji

| Kode | Peran | Cara dibuat |
| ---- | ----- | ----------- |
| AG-U | Anggota unverified (belum bayar) | Registrasi di aplikasi + OTP |
| AG-A, AG-B | Anggota aktif (verified) | Registrasi + iuran disetujui AP |
| AG-E | Anggota expiring (sisa <= 30 hari) | Lampiran A |
| AG-X | Anggota expired | Lampiran A |
| SA, SA2 | Super Admin | Bootstrap CLI + undangan (`production-init.md` langkah 3) |
| AP, AP2 | Admin pembayaran (`payments.read`, `payments.decide`) | Undangan SA; AP2 ditautkan ke akun alumni AG-B (konflik kepentingan) |
| AK | Admin konten (`content.manage`) | Undangan SA |
| AE | Admin event (`events.manage`, `events.checkin`) | Undangan SA |
| CI | Petugas check-in (`events.checkin` saja) | Undangan SA |
| MD | Moderator (`moderation.read`, `moderation.resolve`, `members.read`) | Undangan SA. `members.read` diperlukan untuk suspend/unsuspend dari Detail anggota (`adminSuspendMember`/`adminUnsuspendMember` meminta ketiga izin); tanpa itu hanya jalur laporan (6.9) yang tersedia |
| AU | Auditor (`audit.read`, `audit.export`) | Undangan SA |
| PUB | Pemeriksa KTA publik (tanpa akun) | Peramban/ponsel lain |
| PI | Pengelola infra | - |

## Ringkasan

| UAT | Cakupan (PRD 9.1) | Status otomatis (`traceability.md`) | Status UAT | Pemblokir terbuka |
| --- | ----------------- | ----------------------------------- | ---------- | ----------------- |
| U-01 Identitas | F-01, F-02, F-16; N-07, N-08 | partial (N-07 di luar jalur uji) | | |
| U-02 Iuran | F-03, F-04, F-07 | covered | | |
| U-03 Kartu | F-05, F-06 | covered | | |
| U-04 Konten | F-08, F-15 | covered | | |
| U-05 Event | F-09 | covered | | |
| U-06 Jejaring | F-10, F-12 | covered | | |
| U-07 Chat | F-11, F-12; N-02 | partial (latensi N-02 belum diukur) | | |
| U-08 Notifikasi | F-13 | covered | | |
| U-09 Data pribadi | F-14; N-09, N-10, N-15 | partial per `traceability.md` (D2-01); sejak hardening Fase D readiness menahan API sampai ledger diterapkan (ADR-014), drill restore staging belum | | |
| U-10 Pengurus | F-15, F-16, F-17 | covered | | |
| U-11 Operasi | N-01..N-06; N-14 | partial (tanpa beban, restore, alert; alat backup belum di `main`) | | |
| U-12 Inisialisasi produksi | PRD 8.2, 8.3 | partial (tanpa gerbang otomatis, D2-02) | | |
| U-13 Klien | N-03, N-11, N-12, N-13 | partial (tanpa matriks perangkat/a11y) | | |

---

## U-01 Identitas (F-01, F-02, F-16; N-07, N-08)

Bukti yang diminta PRD 9.1: OTP expiry/replay/rate limit; refresh reuse; MFA; idle; reset; izin dan Super Admin
terakhir.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 1.1 | AG-U | Aplikasi → Daftar: isi data diri (tanpa field NIK/KTP), setujui privasi + ketentuan, kirim | Satu akun `pending_otp`; layar OTP menampilkan email tujuan, masa berlaku 10 menit, "n dari 5"; kode tidak ada di respons (AC F01-1) | | | |
| 1.2 | AG-U | Kirim tombol Daftar dua kali cepat / matikan jaringan lalu ulangi | Tidak ada akun ganda; verifikasi berlanjut di akun yang sama (AC F01-4) | | | |
| 1.3 | AG-U | Masukkan kode salah 5 kali | Challenge tidak berlaku; UI menawarkan kode baru setelah cooldown (AC F01-3) | | | |
| 1.4 | AG-U | Minta kirim ulang sebelum 60 detik; lalu setelah 60 detik; masukkan kode lama | Sebelum 60 detik ditolak dengan hitung mundur; kode lama ditolak setelah kirim ulang (AC F01-3, PRD 2.5) | | | |
| 1.5 | AG-U | Tunggu 10 menit, masukkan kode | Ditolak kedaluwarsa (AC F01-3) | | | |
| 1.6 | AG-U | Masukkan kode benar | Akun aktif, nomor anggota AA.SS.JK.N tampil di KTA berlabel "Tidak Aktif", lanjut ke Biaya KTA (AC F01-2, F05-1) | | | |
| 1.7 | AG-U | Kirim OTP > 5 kali dalam satu jam ke email yang sama | 429 dengan waktu tunggu (PRD 2.5) | | | |
| 1.8 | AG-A | Login di dua perangkat; Akun → Sesi: cabut satu sesi | Perangkat tercabut diminta login ulang (AC F02-3, F02-6) | | | |
| 1.9 | AG-A | Akun → Keluar dari semua perangkat saat chat terbuka di perangkat lain | HTTP dan socket lama tidak dapat mengakses fitur terlindungi (AC F02-6) | | | |
| 1.10 | AG-A | Lupa sandi → OTP → sandi baru | Seluruh sesi dicabut; login dengan sandi baru berhasil (AC F02-4) | | | |
| 1.11 | PUB | Lupa sandi dengan email tidak terdaftar | Respons dan alur sama dengan email terdaftar; tidak ada email (PRD 2.5, ADR-012) | | | |
| 1.12 | AG-A | Ganti sandi tanpa sandi lama yang benar | Ditolak (AC F02-4) | | | |
| 1.13 | SA | Web admin: login sandi benar lalu panggil halaman admin sebelum TOTP (buka URL langsung) | Tetap di `/login/mfa`; API admin menolak (AC F02-2) | | | |
| 1.14 | SA | Login dengan backup code; pakai backup code yang sama lagi | Pertama berhasil, kedua ditolak (F-02) | | | |
| 1.15 | AP | Diam 28 menit (hanya polling dasbor) | Peringatan idle muncul ~2 menit sebelum; setelah 30 menit sesi berakhir dan request berikutnya ditolak (AC F02-5) | | | |
| 1.16 | SA | Manajemen Admin → undang admin baru dengan izin `payments.read`; penerima menyelesaikan undangan + TOTP | Reautentikasi diminta; audit `admin.invited` tercatat; admin aktif hanya setelah TOTP (AC F16-1) | | | |
| 1.17 | SA | Cabut izin `payments.decide` dari AP saat AP membuka antrean | Request AP berikutnya ditolak 403 tanpa menunggu token habis (AC F16-3) | | | |
| 1.18 | SA, SA2 | Pada staging dengan tepat dua Super Admin: keduanya saling menurunkan peran bersamaan (dua peramban) | Tepat satu berhasil; minimal satu Super Admin tersisa (AC F16-2, PRD 9.2) | | | |
| 1.19 | SA | Detail anggota AG-A → reset sandi | Sesi AG-A dicabut, notifikasi keamanan, email kode + tautan `kapdh://app/forgot/otp?...`; pengurus tidak melihat sandi (AC F16-4) | | | |
| 1.20 | PI | Jalankan blok gerbang transport `go-live.md` 2.4 dengan host staging (`staging.kapdh.or.id`, `staging-admin.kapdh.or.id`, `staging-api.kapdh.or.id`); pindai port 5432/6379 dari luar | Semua host HTTPS dengan header sesuai tabel 2.4 (CSP + `frame-ancestors 'none'`/`X-Frame-Options` di situs publik dan admin, HSTS setelah diaktifkan); WSS `101`; DB/Redis tertutup (N-07) | | | |

## U-02 Iuran (F-03, F-04, F-07)

Bukti: approve/reject/resubmit; bukti versi sebelumnya; double approval; periode kalender; suspend tidak terhapus.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 2.1 | AG-U | Biaya KTA → pilih metode → buat instruksi | Nominal dari server (registrasi + KTA sesuai `fees`), rekening tujuan, `payment_id` tetap (AC F03-1) | | | |
| 2.2 | AG-U | Unggah bukti (gambar), lalu ganti dengan PDF | `proof_version` naik, histori tercatat, tidak ada payment baru (AC F03-2) | | | |
| 2.3 | AP | Verifikasi Pembayaran → Menunggu → buka payment → tolak dengan alasan kosong/spasi | Validasi gagal (AC F04-2) | | | |
| 2.4 | AP | Tolak dengan alasan valid | AG-U melihat alasan; status perlu perbaikan (AC F04-2) | | | |
| 2.5 | AG-U | Perbaiki bukti | Payment yang sama kembali pending, versi baru, alasan lama di histori (AC F03-3) | | | |
| 2.6 | AP, AP2 | Buka payment yang sama di dua peramban; AG-U mengganti bukti; AP menyetujui dari layar lama | Ditolak konflik versi bukti sampai membaca versi baru (AC F04-4, PRD 9.2) | | | |
| 2.7 | AP, SA | Setujui payment yang sama hampir bersamaan dari dua akun | Satu berhasil, yang lain konflik dengan status terbaru; satu periode (AC F04-3, PRD 9.2) | | | |
| 2.8 | AG-U | Setelah disetujui: buka KTA | KTA Aktif, periode 12 bulan kalender dari waktu persetujuan (WIB), nomor tetap (AC F05-1, F07-1, PRD 2.1) | | | |
| 2.9 | AG-U | Coba ganti bukti pada payment paid | Ditolak (AC F03-4) | | | |
| 2.10 | AP2 | Buka payment milik AG-B (akun alumni AP2) | Tidak dapat memutus, ditandai konflik kepentingan (PRD 2.3) | | | |
| 2.11 | BD/SA | Ubah nominal `fees` setelah AG-B membuat instruksi; AP memutus payment AG-B | Nominal snapshot lama tetap (AC F03-5, F15-3) | | | |
| 2.12 | AG-E | Perpanjangan → bayar → disetujui | Periode baru mulai dari `expires_at` lama; sisa masa tidak hilang (AC F07-1) | | | |
| 2.13 | AG-X | Perpanjangan → bayar → disetujui | Periode dari waktu persetujuan; akses aktif kembali (AC F07-2) | | | |
| 2.14 | MD, AP | MD: Manajemen Users → Data Alumni → detail AG-A → "Batasi akun" (butuh `members.read` + `moderation.read` + `moderation.resolve`); AG-A punya renewal pending; AP menyetujui | Periode boleh diperbarui, status tetap suspended (AC F07-4, PRD 2.2) | | | |
| 2.15 | AP | Notifikasi push/email dimatikan atau provider gagal (staging: SMTP salah sementara) lalu putuskan | Keputusan tetap tersimpan, inbox tersedia, worker mengulang tanpa perpanjangan ganda (AC F04-5) | | | |
| 2.16 | AP | Payment paid → Penyesuaian → buat koreksi | Paid tidak berubah; penyesuaian tercatat terpisah dengan audit (PRD 3.4, ARCHITECTURE §2 butir 13) | | | |

## U-03 Kartu (F-05, F-06)

Bukti: cache 7 hari, logout/expiry, signature tamper, status online terkini, data minimum, API down.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 3.1 | AG-A | Buka KTA online | Foto (bila ada), nama, angkatan "KAPDH NN", profesi, kota, nomor, QR, masa berlaku, status, waktu sinkron (PRD 3.5) | | | |
| 3.2 | AG-A | Mode pesawat, buka KTA | Kartu tampil berlabel Offline + waktu sinkron (AC F05-2) | | | |
| 3.3 | AG-A | Logout lalu buka aplikasi offline | Kartu tidak tampil; diminta sinkron/login (AC F05-3) | | | |
| 3.4 | PUB | Pindai QR AG-A | `/kta/<nomor>` menampilkan Aktif + waktu periksa; tanpa email/telepon/alamat/alasan (AC F06-1) | | | |
| 3.5 | PUB | Pindai QR AG-E | Aktif dengan tanggal habis (AC F06-1) | | | |
| 3.6 | PUB | Pindai QR AG-U, AG-X, akun suspended, nomor yang tidak ada / akun dihapus | Masing-masing Tidak aktif / Kedaluwarsa / Tidak ditemukan tanpa alasan privat (AC F06-2) | | | |
| 3.7 | PUB | Ubah satu karakter token di fragmen `#t=` | "QR tidak valid atau perlu diperbarui"; tidak pernah Aktif (AC F06-3) | | | |
| 3.8 | MD | Suspend AG-A dari Detail anggota (izin seperti 2.14) atau lewat keputusan laporan; AG-A online lagi dengan kartu offline | Kartu tidak lagi tampil aktif; verifikasi publik Tidak aktif (AC F05-4, F12-4) | | | |
| 3.9 | SA | Detail anggota → koreksi kelas keluar sehingga SS berubah | Nomor berubah prefiks, N tetap, audit nomor lama/baru, QR lama "perlu diperbarui" (AC F05-6) | | | |
| 3.10 | PUB | Matikan jaringan setelah halaman `/kta` terbuka, pindai | "Tidak dapat memverifikasi" + coba lagi, bukan Tidak ditemukan (AC F06-4) | | | |

## U-04 Konten (F-08, F-15)

Bukti: draft/jadwal/arsip, sanitize, banner, like idempoten, CRUD berizin.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 4.1 | AK | Manajemen Konten → Berita: buat draft, jadwalkan 5 menit lagi, arsipkan berita lain | Beranda/berita anggota hanya menampilkan published yang waktunya tiba (AC F08-1) | | | |
| 4.2 | AK | Tunggu jadwal (job `content.announce` per menit) | Terbit sekali; berita yang diarsip tidak hidup lagi (AC F15-5) | | | |
| 4.3 | AK | Tempel HTML dengan `<script>`, `onerror`, iframe | Disanitasi; tautan luar diberi indikasi (PRD 3.8) | | | |
| 4.4 | AK | Banner dengan jendela tanggal lewat / target event yang dibatalkan | Banner tidak tampil; target tidak tersedia ditangani dengan pesan jelas (AC F08-2) | | | |
| 4.5 | AG-A | Ketuk like berulang cepat, dan dari dua perangkat | Maksimal satu like, penghitung konsisten (AC F08-3) | | | |
| 4.6 | AG-A | Beranda offline / tanpa berita | Coba lagi atau keadaan kosong; cache lama diberi waktu (AC F08-4) | | | |
| 4.7 | AP | Buka `/content` dan panggil API konten | Menu tidak tampil, API menolak 403 (AC F15-1) | | | |
| 4.8 | AK, AK2 | Dua admin menyunting berita yang sama; simpan yang lama belakangan | Konflik versi, tawaran muat ulang (AC F15-4) | | | |
| 4.9 | AK | Tab Halaman: ubah draf `bantuan` lalu terbitkan | Situs `https://staging.kapdh.or.id/bantuan` dan aplikasi menampilkan versi terbit; draf tidak bocor (F-08) | | | |

## U-05 Event (F-09)

Bukti: race kuota, satu tiket per anggota/event, hold expiry, review, gratis, QR tiket, double scan, cancel/refund.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 5.1 | AE | Buat event berbayar kuota 2, pendaftaran tutup 20 menit lagi; event gratis kuota 5 | Tersimpan, audit (F-09, F-17) | | | |
| 5.2 | AG-A, AG-B, AG-E | Reservasi kursi event kuota 2 hampir bersamaan | Hanya 2 tiket; yang ketiga "habis" (AC F09-1, PRD 9.2) | | | |
| 5.3 | AG-A | Ketuk Reservasi dua kali / dari dua perangkat | Satu tiket aktif (PRD 9.2) | | | |
| 5.4 | AG-B | Jangan unggah bukti sampai pendaftaran tutup | Tiket expired, kursi dilepas sekali; bukti sesudahnya ditolak (AC F09-2) | | | |
| 5.5 | AG-A | Unggah bukti sebelum batas; AP menolak | Payment rejected, tiket cancelled, hold dilepas; reservasi ulang membuat tiket baru (AC F09-4) | | | |
| 5.6 | AG-A | Reservasi event gratis | Tiket langsung paid, total 0, tanpa payment, QR terbit (AC F09-3) | | | |
| 5.7 | CI | Check-in (`/events/checkin`) memindai tiket paid dalam jendela; pindai lagi | Pertama berhasil (aktor + waktu); kedua "Sudah check-in" (AC F09-5) | | | |
| 5.8 | CI | Pindai QR event lain, tiket pending/expired/cancelled, di luar jendela | Ditolak dengan alasan yang jelas (AC F09-6) | | | |
| 5.9 | AE | Kurangi kuota di bawah held+paid; hapus event bertiket | Ditolak; tersedia pembatalan (AC F15-2) | | | |
| 5.10 | AE | Batalkan event berbayar bertiket | QR tidak berlaku, notifikasi peserta, penyesuaian refund penuh tercatat untuk BD (7 hari kerja) (AC F09-7, D6) | | | |
| 5.11 | AG-A | Batalkan tiket sendiri > H-3 dan <= H-3 | > H-3 refund penuh; <= H-3 tanpa refund (D6) | | | |
| 5.12 | AG-X | Tiket paid sebelum expired | Tetap dapat dilihat dan dipakai check-in; tidak membuka chat/direktori (PRD 2.2) | | | |

## U-06 Jejaring (F-10, F-12)

Bukti: search/filter/paging, hidden fields tidak pada payload, block dua arah, report/unsuspend.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 6.1 | AG-A | Jejaring → Alumni: cari nama, angkatan, kota; filter profesi/keahlian; gulir beberapa halaman | Hasil sesuai filter, tanpa duplikat antarhalaman (AC F10-1) | | | |
| 6.2 | AG-B | Akun → Privasi: telepon disembunyikan; AG-A membuka profil AG-B (inspeksi respons API dengan proxy/DevTools di staging) | Telepon tidak ada di payload, bukan hanya disamarkan (AC F10-2) | | | |
| 6.3 | AG-U, AG-X | Buka Jejaring / panggil API direktori | Ditolak `MEMBERSHIP_REQUIRED` (AC F10-3) | | | |
| 6.4 | SA | Nonaktifkan master profesi yang dipakai AG-A | Profil AG-A tetap menampilkan label; pilihan baru tidak tersedia (AC F10-4) | | | |
| 6.5 | AG-A | Ubah profil dengan mengganti ID ke milik AG-B (alat proxy) | Ditolak; tidak ada field berubah (AC F10-5) | | | |
| 6.6 | AG-A | Blokir AG-B; AG-B mencoba kirim pesan langsung | Ditolak walaupun room sudah ada (AC F12-1) | | | |
| 6.7 | AG-A | Laporkan profil AG-B | Laporan tercatat, dapat dipantau di Akun → Laporan; AG-B tidak melihatnya (AC F12-2) | | | |
| 6.8 | MD | `/moderation`: klaim laporan, putuskan warn | Alasan, aktor, waktu, bukti tercatat; tanggal keanggotaan tidak berubah (AC F12-3) | | | |
| 6.9 | MD | Suspend AG-B lewat laporan | Sesi dan akses komunitas dicabut, hilang dari direktori, KTA publik Tidak aktif (AC F12-4) | | | |
| 6.10 | AG-B | Portal pembatasan → ajukan banding | Banding masuk antrean moderasi (PRD 3.12) | | | |
| 6.11 | MD | Unsuspend AG-B (masa aktif sudah habis pada data uji) | Status dihitung ulang: expired, bukan verified (AC F12-5) | | | |

## U-07 Chat (F-11, F-12; N-02)

Bukti: room unik, socket auth, retry/reconnect, order pesan, unread, file privat, pencabutan hak.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 7.1 | AG-A, AG-B | Keduanya memulai chat langsung satu sama lain bersamaan | Satu room (AC F11-1) | | | |
| 7.2 | AG-A | Kirim pesan dengan jaringan lambat, ulangi saat tidak ada ack | Server ack setelah commit; tidak ada duplikat (AC F11-2) | | | |
| 7.3 | AG-B | Matikan jaringan, AG-A kirim 5 pesan, nyalakan lagi | Semua pesan muncul berurutan tanpa duplikat (AC F11-3, N-02) | | | |
| 7.4 | AG-A | Ukur waktu kirim → tampil di AG-B online (20 pesan, stopwatch/log) | Dicatat; target p95 <= 2 detik dikonfirmasi di laporan beban U-11 (N-02) | | | |
| 7.5 | AG-A | Buat grup, undang AG-B dan AG-E; AG-B menerima | Anggota baru hanya melihat pesan sejak bergabung (PRD 3.11) | | | |
| 7.6 | AG-A | Admin grup terakhir keluar saat ada anggota lain | Wajib memindahkan peran admin (AC F11-5) | | | |
| 7.7 | AG-X | Kirim pesan / buka grup | Ditolak; socket berhenti menerima event room (AC F11-6) | | | |
| 7.8 | AG-E | Masa habis saat socket tersambung (data uji: `expires_at` beberapa menit lagi) | Dikeluarkan dari room pada waktu habis (AC F11-6) | | | |
| 7.9 | AG-A | Kirim gambar chat; salin URL gambar ke akun AG-C bukan anggota room | Akun lain 404/ditolak; URL kedaluwarsa <= 10 menit (AC F11-4, PRD 5.4) | | | |
| 7.10 | AG-A | Kirim pesan berisi `javascript:alert(1)` atau karakter kendali | Ditolak validasi (filter dasar PRD 3.12) | | | |
| 7.11 | AG-B | Unread badge, tandai terbaca di dua perangkat | Unread konsisten; read cursor tidak mundur (PRD 3.11) | | | |
| 7.12 | AG-A | Laporkan pesan; MD hapus pesan lewat keputusan | Pesan menjadi placeholder bagi anggota room (PRD 3.12) | | | |

## U-08 Notifikasi (F-13)

Bukti: inbox/outbox, preferensi, deep link, gagal provider, token ganti akun, pengingat dedup.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 8.1 | AP, AG-U | Putuskan payment AG-U | Satu notifikasi inbox; push + email sesuai preferensi; retry tidak menggandakan inbox (AC F13-1) | | | |
| 8.2 | AG-A | Tolak izin push OS; matikan kategori Berita | Aplikasi tetap berfungsi; inbox tetap berisi (AC F13-2) | | | |
| 8.3 | AG-A | Ketuk push pembayaran setelah logout / setelah disuspend | Login/otorisasi diperiksa sebelum objek dibuka (AC F13-3) | | | |
| 8.4 | AG-A | Logout dan login sebagai AG-B di perangkat yang sama; picu notifikasi untuk AG-A | Perangkat tidak menerima push AG-A (AC F13-5) | | | |
| 8.5 | AE | Event mulai ~25 jam lagi; tunggu job pengingat (15 menit) | Satu pengingat H-1 per peserta; event diubah/dibatalkan membatalkan jadwal usang (AC F13-6) | | | |
| 8.6 | AG-E | `expires_at` dalam 29 hari; tunggu job per jam | Satu pengingat per periode (AC F07-5) | | | |
| 8.7 | SA | Notifikasi → Pengiriman: lihat kegagalan (staging: token FCM tidak valid), coba ulang | Token UNREGISTERED dinonaktifkan; 429/5xx dicoba ulang dengan backoff (AC F13-4) | | | |
| 8.8 | AG-A | Kunci layar saat menerima push chat | Isi chat, bukti bayar, kontak tidak tampil (PRD 3.13) | | | |

## U-09 Data pribadi (F-14; N-09, N-10, N-15)

Bukti: deletion parsial/retry, anonimisasi snapshot/log, konten user, web request, restore ledger.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 9.1 | AG-A | Akun → Hapus akun: baca pengungkapan (refund tertunda, tiket, data yang tersisa anonim), reautentikasi sandi, konfirmasi | Satu job; akun `deletion_pending`; sesi/socket dicabut; nomor permintaan `DEL-YYYY-...` tampil (AC F14-1, N-15) | | | |
| 9.2 | PUB | `https://staging.kapdh.or.id/delete-account` untuk AG-B: email → OTP → konfirmasi | Permintaan diterima tanpa aplikasi; nomor permintaan tampil (F-14, [R2]) | | | |
| 9.3 | PI | Hentikan worker di tengah job penghapusan, jalankan lagi | Langkah dilanjutkan tanpa menyentuh data pengguna lain (AC F14-2) | | | |
| 9.4 | SA | Setelah selesai: periksa anggota terhapus di web admin dan basis data staging | Kredensial, profil, kontak, token, avatar, unggahan dihapus; pesan chat placeholder; payment/tiket tersisa anonim dengan jumlah tetap; bukti transfer dihapus (AC F14-3, F14-4) | | | |
| 9.5 | AG-A | Hapus akun saat menjadi admin grup terakhir | Grup dialihkan atau ditutup tanpa menunggu anggota lain (AC F14-5) | | | |
| 9.6 | PI | Restore backup sebelum penghapusan ke lingkungan bersih mengikuti `docs/runbooks/restore-backup.md`; hanya database yang dipulihkan, storage tetap terkini; untuk menguji gerbang, nyalakan satu replika API staging sebelum `ledger-reapply` dan amati `GET /api/v1/health/ready` (replika tidak menerima trafik karena healthcheck memakai readiness) → `ledger-reapply` → readiness lagi | Sebelum penerapan ulang: 503 dengan `"deletion_ledger": "fail"`; sesudahnya 200 dengan `"ok"`. Akun terhapus tidak aktif kembali; nomor anggota sesudah titik backup tidak terbit ulang; total keuangan cocok (AC F14-6, PRD 9.2) | | | |
| 9.7 | QA | Cari NIK/KTP di formulir registrasi, ekspor CSV audit, log API/worker | Tidak ada (N-09) | | | |
| 9.8 | AG-A | Unggah gambar > 5 MB, PDF > 10 MB, PDF sebagai avatar, berkas `.jpg` berisi teks, 11 unggahan bukti dalam 24 jam | Semua ditolak `FILE_INVALID`/429 sesuai aturan; EXIF foto dibuang (N-10) | | | |
| 9.9 | AG-B | Registrasi baru: periksa bawaan privasi | Telepon, email, sosial tersembunyi secara bawaan (N-15) | | | |
| 9.10 | AG-A | Ganti ID objek untuk membuka bukti/gambar/profil/audit milik pihak lain | Tidak ada paparan data (PRD 9.2) | | | |

## U-10 Pengurus (F-15, F-16, F-17)

Bukti: setiap izin positif/negatif, version conflict, conflict of interest, ekspor CSV aman.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 10.1 | AP, AK, AE, CI, MD, AU | Masing-masing login dan buka setiap menu | Menu sesuai izin; menu lain tidak tampil dan API menolak 403 (AC F15-1) | | | |
| 10.2 | AP | Dasbor | Hanya bagian pembayaran; tautan "Lihat yang lewat batas" membuka `/payments?stage=awaiting_review&overdue=true` dengan jumlah sama (F-15) | | | |
| 10.3 | SA | Ubah metode bayar, nominal, versi minimum | Reautentikasi; audit before/after; transaksi lama tidak berubah (AC F15-3) | | | |
| 10.4 | SA, SA2 | Ubah pengaturan yang sama dari dua peramban | Konflik versi + muat ulang (AC F15-4) | | | |
| 10.5 | AU | Audit: filter aktor/entitas/waktu, ekspor CSV | Hasil dan ekspor memakai filter sama; berkas kedaluwarsa otomatis (AC F17-4) | | | |
| 10.6 | AU | Buat entitas dengan nilai diawali `=`, `+`, `-`, `@` lalu ekspor | Formula dinetralkan; tanpa kolom privat/secret (AC F17-3) | | | |
| 10.7 | AP | Buka URL berkas ekspor audit / `/audit` | Ditolak walaupun URL diketahui (AC F17-2) | | | |
| 10.8 | SA | Setiap tindakan kritis U-02..U-09 | Satu entri audit berkorelasi `request_id` per perubahan (AC F17-1) | | | |
| 10.9 | AP2 | Putuskan payment akun alumni tertaut | Ditolak (PRD 2.3) | | | |

## U-11 Operasi (N-01..N-06; N-14)

Bukti: laporan load/realtime, backup/restore dan RPO/RTO, observabilitas serta alert. Dijalankan PI di staging dengan
kondisi PRD 2.4 (VPS sasaran, 100 sesi anggota, 5 sesi admin, 5.000 profil, 100.000 pesan).

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 11.1 | PI | Uji beban 10 rps selama 15 menit (baca sederhana, keputusan, reservasi) | p95 <= 500 ms baca, <= 1.000 ms keputusan/reservasi, galat tak terduga < 1 % (N-01) | | | |
| 11.2 | PI | Uji realtime 100 sesi | p95 commit → tampil <= 2 detik; reconnect tanpa kehilangan/duplikasi (N-02) | | | |
| 11.3 | PI | Naikkan beban bertahap sampai target gagal | Titik jenuh dan rencana kapasitas tercatat (N-04, D7) | | | |
| 11.4 | PI | Monitor eksternal aktif 30 hari staging/production | Laporan ketersediaan; target usulan 99,5 % (N-05) | | | |
| 11.5 | PI | Backup harian (alat paket backup-ops Fase E; belum di `main`) → restore ke lingkungan bersih mengikuti `restore-backup.md`, ukur waktu | RPO <= 24 jam dan RTO <= 4 jam terbukti (N-06; melebihi = Gagal); ledger diterapkan sebelum dibuka; pemeriksaan PRD 5.5 (login/MFA, anggota, total uang, tiket, chat, berkas, penghapusan terdahulu) lulus | | | |
| 11.6 | PI | Matikan worker 10 menit lalu nyalakan; matikan Redis 1 menit | Alert terkirim (worker `/healthz`, readiness); outbox diproses ulang sekali (PRD 9.2, 5.1) | | | |
| 11.7 | PI | Ambil `request_id` dari galat aplikasi; telusuri log API, worker, audit | Terhubung dengan `request_id`/`job_id`; tidak ada sandi/OTP/token/isi chat/bukti di log (N-14) | | | |
| 11.8 | PI | Isi disk sampai 60 %/80 % (atau ubah ambang monitor sementara) | Alert warning/critical (PRD 5.4) | | | |

## U-12 Inisialisasi produksi (PRD 8.2, 8.3)

Bukti: deploy dari nol, bootstrap Super Admin sekali pakai, seed referensi tanpa fixture dev, konfigurasi tersahkan,
akun reviewer toko, restore dari backup pertama.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 12.1 | PI | `production-init.md` langkah 1-2 dari database kosong (gladi staging) | Migrasi tercatat = journal image; seed referensi 10/24/22/5; tanpa fixture (blok SQL A = 0) | | | |
| 12.2 | PI | Jalankan `seed-dev.js` dengan `NODE_ENV=production` | Ditolak, keluar 1 | | | |
| 12.3 | PI, SA | Bootstrap CLI → undangan → ganti sandi → TOTP; jalankan CLI lagi | Super Admin aktif; CLI kedua ditolak "Super Admin aktif sudah ada"; tidak ada rute HTTP bootstrap | | | |
| 12.4 | SA | Super Admin kedua lewat undangan web admin | Blok SQL B >= 2 | | | |
| 12.5 | SA, BD, PP | Langkah 4 (master, legal, nominal, metode, kontak, versi minimum) | Blok SQL `go-live.md` 2.3 memenuhi semua target | | | |
| 12.6 | QA | Registrasi sebelum legal terbit | Ditolak (409) sampai kebijakan privasi + ketentuan terbit | | | |
| 12.7 | PP | Akun demo reviewer (`app-store-submission.md` bagian 3) | Akun aktif dan belum bayar dapat login di build rilis | | | |
| 12.8 | PI | Backup pertama → restore bersih mengikuti `restore-backup.md` | Readiness 200 dengan `"deletion_ledger": "ok"`, login admin + MFA berhasil | | | |
| 12.9 | QA | PRD 9.2 skenario 9: ubah data staging agar satu butir gerbang gagal (mis. metode bayar contoh) | Gerbang `go-live.md` 2.3 menunjukkan butir gagal dan go-live ditolak | | | |

## U-13 Klien (N-03, N-11, N-12, N-13)

Bukti: perangkat/browser sasaran, keyboard/semantics/text scaling, kontrak, deep link, wajib update dan maintenance.

| No | Peran | Langkah | Hasil yang diharapkan | Hasil | Bukti | Penguji, tanggal |
| -- | ----- | ------- | --------------------- | ----- | ----- | ---------------- |
| 13.1 | QA | Alur registrasi → OTP → iuran → KTA di setiap perangkat matriks D7 | Berfungsi; tidak ada tata letak rusak (N-12) | | | |
| 13.2 | QA | Web admin dan situs publik di Chrome, Edge, Firefox, Safari (dua versi terakhir) | Berfungsi (N-12) | | | |
| 13.3 | QA | Profil jaringan 10 Mbps/RTT 100 ms: buka Beranda, KTA, Berita | Konten pertama dapat digunakan p95 <= 3 detik; loading/retry/kosong tersedia (N-03) | | | |
| 13.4 | QA | Aplikasi dengan teks 200 % dan TalkBack/VoiceOver pada registrasi, OTP, unggah bukti, KTA, chat | Tidak terpotong; semua kontrol berlabel; target sentuh 44-48 px (N-11) | | | |
| 13.5 | QA | Web admin hanya keyboard + pembaca layar (NVDA/VoiceOver): login, putuskan payment, check-in | Dapat dioperasikan; fokus terlihat (N-11) | | | |
| 13.6 | QA | Deep link `kapdh://app/payments/<id>` dan `kapdh://app/forgot/otp?challenge_id=...` saat login, logout, beda akun | Rute benar dengan pemeriksaan otorisasi (AC F13-3) | | | |
| 13.7 | SA | Pengaturan → versi minimum di atas versi terpasang | Aplikasi menampilkan wajib update dengan tautan toko; mutasi dari versi lama ditolak `UPGRADE_REQUIRED` | | | |
| 13.8 | SA | Pengaturan → Maintenance aktif dengan pesan dan perkiraan | Aplikasi: mode baca + layar maintenance untuk alur mutasi; situs publik menampilkan banner; admin tetap berfungsi | | | |
| 13.9 | DEV | Bandingkan `dist/openapi.yaml` rilis dengan rilis sebelumnya; build aplikasi versi sebelumnya terhadap API baru | Tidak ada perubahan yang memutus klien yang didukung, atau tercatat di `CHANGELOG.md` dengan rencana (N-13; gerbang otomatis belum ada, D2-12) | | | |

## Lampiran A. Menyiapkan anggota expiring/expired di staging

Hanya di **staging** dengan data sintetis, sebagai persiapan data uji (bukan langkah produk; tidak pernah di
production). Jalankan sebagai superuser di kontainer PostgreSQL staging setelah anggota uji aktif lewat persetujuan
iuran:

```sql
-- AG-E: sisa masa 10 hari (expiring)
update app.alumni set starts_at = now() - interval '11 months 20 days', expires_at = now() + interval '10 days'
 where user_id = (select id from app.users where email = '<email-ag-e>' and kind = 'alumni' and status <> 'deleted');
-- AG-X: masa habis kemarin (expired)
update app.alumni set starts_at = now() - interval '12 months 1 day', expires_at = now() - interval '1 day'
 where user_id = (select id from app.users where email = '<email-ag-x>' and kind = 'alumni' and status <> 'deleted');
```

Catat perubahan ini di laporan UAT; hasil uji yang bergantung padanya (U-02 2.12/2.13, U-03 3.5/3.6, U-07 7.7/7.8)
memakai status yang dihitung server dari `expires_at` (AC F07-3).
