# Naskah halaman informasi dan legal KAPDH

Folder ini memuat naskah final lima halaman yang diterbitkan pemilik melalui editor web admin. Naskah mengacu pada
UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP) dan disusun untuk memenuhi persyaratan Google Play
dan Apple App Store. Setiap pernyataan tentang cara kerja aplikasi sudah dicocokkan dengan kode R1.0 per
15 Oktober 2026.

- **Tanggal berlaku:** setiap halaman memuat baris "Berlaku sejak ..." sendiri (Kebijakan Privasi 16 Oktober 2026,
  Tentang 18 Oktober 2026, lainnya 15 Oktober 2026). Bila diterbitkan pada tanggal lain, ubah baris itu menjadi tanggal
  terbit sebenarnya sebelum menekan Terbitkan.
- **Pratinjau dan cara menyalin:** buka `pratinjau.html` di peramban. Halaman itu memuat kelima naskah, tombol
  "Salin isi" per halaman, dan langkah penerbitan.

## Daftar halaman

| Judul di web admin  | Slug                  | Berkas                     | Alamat publik                           |
| ------------------- | --------------------- | -------------------------- | --------------------------------------- |
| Kebijakan Privasi   | `kebijakan-privasi`   | `kebijakan-privasi.html`   | https://kapdh.or.id/kebijakan-privasi   |
| Ketentuan Layanan   | `ketentuan`           | `ketentuan.html`           | https://kapdh.or.id/ketentuan           |
| Ketentuan Komunitas | `ketentuan-komunitas` | `ketentuan-komunitas.html` | https://kapdh.or.id/ketentuan-komunitas |
| Bantuan             | `bantuan`             | `bantuan.html`             | https://kapdh.or.id/bantuan             |
| Tentang KAPDH       | `tentang`             | `tentang.html`             | https://kapdh.or.id/tentang             |

Isi berkas hanya memakai tag yang diterima sanitizer web admin (`p`, `br`, `h2`, `h3`, `strong`, `em`,
`blockquote`, `ul`, `ol`, `li`, `a` dengan tautan `https:` atau `mailto:`). Judul halaman diisi terpisah di kolom
Judul, jadi tidak ada di dalam isi. Naskah sudah diuji lewat sanitizer server: seluruh teks dan tautan tetap utuh,
dan tidak ada yang memuat penanda kerangka DRAF yang ditolak gerbang go-live.

## Cara menerbitkan (ringkas)

1. Web admin, menu **Berita, Banner & Halaman**, tab **Halaman**, buka halaman sesuai slug.
2. Salin isi dari `pratinjau.html`, kosongkan editor, tempel, periksa judul.
3. **Simpan draf**, lalu **Terbitkan versi baru**.
4. Ulangi untuk kelima halaman, lalu periksa hasilnya di situs dan di aplikasi.

## Aturan perubahan di kemudian hari

- Setiap perubahan naskah **selalu** diterbitkan ulang melalui web admin dengan cara yang sama. Jangan mengubah teks
  di tempat lain. Perbarui juga berkas di folder ini agar tetap sama dengan versi yang tayang.
- Menerbitkan Kebijakan Privasi, Ketentuan Layanan, atau Ketentuan Komunitas menaikkan nomor versi legal secara
  otomatis, dan teks yang diterbitkan dicatat utuh di jejak audit. Pendaftar baru selalu menyetujui versi terbaru;
  bila versi berubah saat seseorang sedang mendaftar, aplikasi meminta ia membaca ulang dan mencentang kembali.
- **Anggota yang sudah terdaftar belum diminta menyetujui ulang.** Aplikasi R1.0 belum memiliki layar persetujuan
  ulang, sehingga naskah ditulis apa adanya: perubahan diumumkan lebih dahulu, dan anggota yang tidak setuju dapat
  menghapus akun. Bila kelak ada perubahan yang menurut hukum memerlukan persetujuan baru (misalnya tujuan pemrosesan
  baru berbasis persetujuan), layar persetujuan ulang harus dibuat lebih dahulu.
- Bila pengaturan berikut diubah di web admin, terbitkan ulang halaman yang menyebutnya: batas pembatalan tiket
  `self_cancel_days` (naskah menyebut H-3: Ketentuan Layanan bagian 6 dan Bantuan), serta kontak dukungan.

## Syarat sebelum terbit

Butir berikut harus benar pada saat naskah diterbitkan. Bila belum, sebagian kalimat naskah menjadi tidak benar.

1. **Domain kapdh.or.id sudah mengarah ke situs baru.** Saat diperiksa 15 Oktober 2026, `https://kapdh.or.id/...`
   masih dialihkan (308) ke situs lama di Vercel. Semua tautan di naskah memakai `https://kapdh.or.id/...` (sanitizer
   tidak menerima tautan relatif). Pindahkan `kapdh.or.id` dan `www.kapdh.or.id` ke situs baru di VPS, hapus
   pengalihan di Vercel, lalu pastikan `/delete-account`, `/kontak`, `/unduh`, `/kebijakan-privasi`, `/ketentuan`,
   `/ketentuan-komunitas`, `/bantuan`, dan `/tentang` membuka halaman baru. Baru setelah itu isi URL hapus akun di
   Play Console. Bila naskah terpaksa terbit lebih dulu, pilih alamat sementara `baru.kapdh.or.id` di
   `pratinjau.html`, lalu terbitkan ulang dengan alamat kapdh.or.id setelah domain dipindah.

   **Terpenuhi 21 Oktober 2026.** `kapdh.or.id` dan `admin.kapdh.or.id` dilayani VPS; `www` dan `baru` dialihkan
   permanen ke `kapdh.or.id`, `admin-baru` ke `admin.kapdh.or.id`. Kedelapan halaman di atas membuka situs baru, dan
   naskah yang terbit tidak menautkan `baru.kapdh.or.id` maupun situs lama (`docs/qa/transport/2026-10/README.md`).
   Naskah yang berlaku diterbitkan 15-18 Oktober 2026, sebelum syarat ini terpenuhi. Tautannya sudah memakai
   `https://kapdh.or.id/...`, jadi tidak perlu terbit ulang karena butir ini, tetapi sampai 21 Oktober tautan itu masih
   menuju situs lama. Langkah berikutnya: isi URL hapus akun di Play Console dengan
   `https://kapdh.or.id/delete-account`.
2. **Bucket deletion ledger di luar VPS sudah dikonfigurasi** (`DELETION_LEDGER_S3_*`). Tanpa bucket ini worker
   production menolak berjalan dan penghapusan akun tertunda, sehingga janji "penghapusan selesai paling lambat 7 hari
   kalender" tidak terpenuhi.
3. **Backup harian sudah berjalan** ke object storage di luar VPS (IDCloudHost IS3 di Indonesia, bucket
   kapdh-prod-backup; berjalan sejak 15 Oktober 2026), dengan rotasi 30 hari, dan **satu uji restore sudah berhasil**
   (ADR-018 masih mencatat belum ada restore drill). Kebijakan Privasi bagian 8, 10, dan 11.5 serta Bantuan menyebut
   cadangan harian terenkripsi yang dihapus paling lama 30 hari.
4. **Identitas organisasi dikonfirmasi:** nama badan hukum "Perkumpulan Keluarga Alumni Pesantren Darel Hikmah"
   sesuai SK AHU-0002732.AH.01.07.TAHUN 2023 (11 April 2023) dan akta Nomor 01 (27 Maret 2023), lokasi pesantren
   (Pekanbaru, Riau), serta nama akun developer Google Play dan Apple yang persis sama dengan nama badan hukum. Di
   halaman Tentang (revisi 18 Oktober 2026): misi dijabarkan dari Anggaran Dasar Pasal 3 dan 4; visi adalah rumusan
   baru yang wajib disahkan pengurus; semboyan berasal dari situs lama (tidak ada di AD). Dikonfirmasi pemilik
   18 Oktober 2026: KAPDH tidak menyelenggarakan pendidikan formal (sekolah atau madrasah), semboyan adalah semboyan
   resmi, butir misi lama di luar AD dihapus, rumusan visi disetujui, dan seluruh pendiri adalah alumni.
5. **Batas usia 18 tahun disetujui pemilik.** Aplikasi tidak menanyakan usia dan tidak dapat mencatat persetujuan
   orang tua atau wali, sehingga naskah menetapkan layanan hanya untuk usia 18 tahun ke atas (pernyataan usia melalui
   persetujuan Ketentuan Layanan). Disarankan menambahkan kalimat usia pada centang pendaftaran di aplikasi dan
   memilih rating usia toko yang konsisten. Bila pemilik ingin menerima alumni di bawah 18 tahun, alur persetujuan wali
   yang tercatat harus dibangun lebih dahulu dan naskah diubah.
6. **Ada petugas yang memantau bantuan@kapdh.or.id** untuk permintaan terkait data pribadi, termasuk akhir pekan dan
   hari libur, karena tenggat UU PDP 3 x 24 jam dihitung dalam jam. Halaman lain menyatakan pertanyaan umum dijawab
   pada hari kerja, sedangkan permintaan data pribadi mengikuti jangka waktu Kebijakan Privasi.
7. **Nomor WhatsApp dukungan diisi** di pengaturan aplikasi. Naskah merujuk ke "nomor WhatsApp dukungan yang
   tercantum di aplikasi dan di halaman Kontak".

Syarat tambahan dan daftar butir terbuka lainnya dikelola pengurus secara internal.
