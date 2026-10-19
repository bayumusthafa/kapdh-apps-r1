# Kebijakan keamanan

KAPDH Apps milik Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH). Kami berterima kasih atas laporan celah
keamanan yang disampaikan secara privat dan bertanggung jawab. Ringkasan Bahasa Inggris ada di bagian akhir; bila
berbeda, naskah Bahasa Indonesia yang berlaku.

## Cakupan

Termasuk:

- aplikasi anggota KAPDH untuk Android dan iOS (`id.or.kapdh.app`, kode di `kapdh-mobile/`);
- API `api.kapdh.or.id` (REST `/api/v1` dan Socket.IO `/realtime`) beserta worker di belakangnya;
- web admin pengurus `admin.kapdh.or.id`;
- situs publik `kapdh.or.id`, termasuk verifikasi KTA dan halaman hapus akun;
- konfigurasi build dan deploy di repo ini: Dockerfile, nginx, Compose, skrip infra, dan workflow GitHub Actions.

Di luar cakupan:

- layanan pihak ketiga yang kami pakai (mis. Google Play, App Store, Firebase, GitHub, penyedia server dan email);
  laporkan celahnya langsung ke penyedia tersebut;
- lingkungan staging (`staging.kapdh.or.id`, `staging-admin.kapdh.or.id`, `staging-api.kapdh.or.id`) dan panel
  pengelola server: jangan diuji; bila celah yang sama ada di production, laporkan untuk layanan production;
- temuan pemindai otomatis tanpa skenario serangan dan dampak yang dapat direproduksi;
- konten atau perilaku anggota (spam, pelecehan di chat): laporkan lewat fitur laporan di aplikasi sesuai Ketentuan
  Komunitas;
- pertanyaan akun, iuran, atau bantuan umum: hubungi `bantuan@kapdh.or.id` tanpa awalan `[KEAMANAN]`.

## Versi yang didukung

| Komponen                                                 | Didukung                                                 |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Aplikasi Android dan iOS                                 | rilis terbaru di Google Play dan App Store               |
| API, web admin, situs publik                             | layanan production yang sedang berjalan (domain di atas) |
| Versi aplikasi lama, staging, build non-production, fork | tidak didukung                                           |

Perbaikan dirilis sebagai versi baru. Bila perlu, pengguna versi lama diwajibkan memperbarui aplikasi lewat
pengaturan versi minimum.

## Cara melapor

Jangan melapor lewat issue, pull request, diskusi, atau media sosial publik.

1. **GitHub Private Vulnerability Reporting** (diutamakan): buka tab **Security** di repo ini, lalu **Report a
   vulnerability**. Laporan hanya terlihat oleh Anda dan pengelola repo. Bila tombol itu belum tersedia, pakai email.
2. **Email** ke [bantuan@kapdh.or.id](mailto:bantuan@kapdh.or.id), kanal bantuan resmi KAPDH, dengan subjek diawali
   `[KEAMANAN]`, mis. `[KEAMANAN] Berkas privat dapat diunduh tanpa login`. Jangan melampirkan kredensial, token, atau
   data sensitif lain di email; cukup sebutkan bahwa bukti itu ada, lalu kami sepakati cara pengirimannya.

<!--
  Perlu dikonfirmasi pengurus KAPDH sebelum repo dipublikasikan: (1) bantuan@kapdh.or.id tetap kanal laporan
  keamanan atau diganti alamat khusus, dan petugas yang memantaunya meneruskan email berawalan [KEAMANAN] ke
  pengembang dan pengelola infra; (2) Private Vulnerability Reporting diaktifkan pemilik repo setelah repo publik
  dibuat. Ubah juga ringkasan Bahasa Inggris bila salah satunya berubah.
-->

Isi laporan:

- deskripsi celah dan komponen yang terdampak (aplikasi, API, web admin, situs publik, atau infrastruktur);
- langkah reproduksi, termasuk permintaan dan respons HTTP atau bukti konsep minimal bila ada;
- dampak: apa yang dapat dilakukan penyerang dan data apa yang terpapar;
- versi aplikasi, perangkat dan sistem operasi, atau URL dan endpoint, serta waktu pengujian;
- kontak untuk tindak lanjut, dan apakah Anda bersedia disebut namanya.

Jangan mencantumkan data pribadi pihak lain (nama, email, nomor telepon, nomor KTA, isi chat, bukti bayar). Pakai
akun Anda sendiri sebagai contoh atau samarkan datanya.

## Aturan pengujian beritikad baik

- Pakai hanya akun Anda sendiri. Jangan mengakses, mengubah, atau menghapus data anggota, pengurus, atau pihak lain.
- Bila menemukan data pribadi orang lain, hentikan pengujian, jangan menyimpan, menyalin, atau membagikannya, dan
  segera laporkan dengan menyebut jenis data dan lokasinya saja. Hapus salinan yang terlanjur tersimpan.
- Bila menemukan rahasia (kunci, token, sandi) di repo atau layanan, jangan memakainya; cukup laporkan lokasinya.
- Jangan melakukan serangan penolakan layanan (DoS), uji beban, atau otomatisasi berintensitas tinggi, dan jangan
  mengirim spam, termasuk permintaan OTP, email, notifikasi, atau konten palsu yang membebani pengurus.
- Jangan melakukan rekayasa sosial (phishing, menyamar, menelepon) terhadap pengurus, admin, atau anggota.
- Jangan melakukan uji fisik terhadap kantor, perangkat, atau server.
- Berhenti setelah celah terbukti: jangan memasang akses tersembunyi, menaikkan hak akses lebih jauh, atau berpindah
  ke sistem lain.
- Laporkan secepatnya, dan jangan mengungkapkan celah kepada publik atau pihak lain sebelum perbaikan dirilis. Kami
  akan menyepakati waktu pengungkapan bersama Anda.

Selama Anda mematuhi aturan ini, kami menganggap pengujian Anda dilakukan dengan itikad baik. Kebijakan ini tidak
memberi lisensi atas kode di repo ini (lihat `LICENSE`).

<!--
  Pernyataan itikad baik di atas bukan pelepasan tuntutan hukum. Bentuk perlindungan hukum bagi pelapor (safe
  harbor) yang lebih tegas memerlukan keputusan pengurus KAPDH dan penasihat hukumnya.
-->

## Tanggapan kami

<!--
  Angka target dan komitmen di bagian ini serta di ringkasan Bahasa Inggris adalah usulan tim pengembang dan perlu
  dikonfirmasi pengurus KAPDH sebelum repo dipublikasikan.
-->

Angka berikut adalah target yang kami upayakan, bukan jaminan. Hari kerja berarti Senin sampai Jumat di luar hari
libur nasional Indonesia.

- Konfirmasi laporan diterima: dalam 5 hari kerja.
- Penilaian awal (valid atau tidak, tingkat keparahan, rencana tindak lanjut): dalam 10 hari kerja sejak laporan
  diterima.
- Pembaruan status berkala sampai perbaikan dirilis. Waktu perbaikan bergantung pada tingkat keparahan.
- Setelah perbaikan dirilis, kami memberi tahu Anda dan menyebut nama Anda sebagai pelapor bila Anda bersedia.
- Laporan yang menyangkut kebocoran data pribadi ditangani sesuai Kebijakan Privasi KAPDH dan Undang-Undang Nomor 27
  Tahun 2022 tentang Pelindungan Data Pribadi.

## Tanpa bug bounty

KAPDH tidak menjalankan program bug bounty berbayar dan tidak memberi imbalan uang atas laporan.

## English summary

KAPDH Apps is owned by Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH). The Indonesian text above
prevails.

- **Scope:** the KAPDH member app for Android and iOS, the API and worker (`api.kapdh.or.id`), the admin web
  (`admin.kapdh.or.id`), the public website (`kapdh.or.id`), and the build and deployment configuration in this
  repository. Third-party services and staging environments are out of scope.
- **Supported versions:** the latest app release on Google Play and the App Store, and the production services.
- **How to report:** privately, never in a public issue. Use GitHub Private Vulnerability Reporting
  (**Security** tab > **Report a vulnerability**) once it is enabled, or email
  [bantuan@kapdh.or.id](mailto:bantuan@kapdh.or.id) with a subject starting with `[KEAMANAN]`. Include a
  description, steps to reproduce, impact, and the app version or URL. Do not include other people's personal data.
- **Good-faith testing:** use only your own account; do not access, modify, or delete other people's data; no denial
  of service, spam, social engineering of board members or members, or physical testing; if you encounter personal
  data, stop and report it. Report promptly and allow time for a fix before any disclosure.
- **Response targets (not guarantees):** acknowledgement within 5 business days, initial assessment within 10
  business days.
- **No bug bounty:** there is no paid bug bounty program.
