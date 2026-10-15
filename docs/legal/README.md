# Naskah halaman informasi dan legal KAPDH

Folder ini memuat naskah final lima halaman yang diterbitkan pemilik melalui editor web admin. Naskah mengacu pada
UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP) dan disusun untuk memenuhi persyaratan Google Play
dan Apple App Store. Setiap pernyataan tentang cara kerja aplikasi sudah dicocokkan dengan kode R1.0 per
15 Oktober 2026.

- **Tanggal berlaku:** 15 Oktober 2026. Bila diterbitkan pada tanggal lain, ubah baris "Berlaku sejak 15 Oktober
  2026." di kelima halaman menjadi tanggal terbit sebenarnya sebelum menekan Terbitkan.
- **Pratinjau dan cara menyalin:** buka `pratinjau.html` di peramban. Halaman itu memuat kelima naskah, tombol
  "Salin isi" per halaman, dan langkah penerbitan.

## Daftar halaman

| Judul di web admin  | Slug                  | Berkas                     | Alamat publik                              |
| ------------------- | --------------------- | -------------------------- | ------------------------------------------ |
| Kebijakan Privasi   | `kebijakan-privasi`   | `kebijakan-privasi.html`   | https://kapdh.or.id/kebijakan-privasi      |
| Ketentuan Layanan   | `ketentuan`           | `ketentuan.html`           | https://kapdh.or.id/ketentuan              |
| Ketentuan Komunitas | `ketentuan-komunitas` | `ketentuan-komunitas.html` | https://kapdh.or.id/ketentuan-komunitas    |
| Bantuan             | `bantuan`             | `bantuan.html`             | https://kapdh.or.id/bantuan                |
| Tentang KAPDH       | `tentang`             | `tentang.html`             | https://kapdh.or.id/tentang                |

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
   masih dialihkan (308) ke situs lama di Vercel, termasuk `/delete-account` yang membuka formulir hapus akun
   aplikasi lama. Semua tautan di naskah memakai `https://kapdh.or.id/...` (sanitizer tidak menerima tautan relatif).
   Pindahkan `kapdh.or.id` dan `www.kapdh.or.id` ke situs baru di VPS, hapus pengalihan di Vercel, lalu pastikan
   `/delete-account`, `/kontak`, `/unduh`, `/kebijakan-privasi`, `/ketentuan`, `/ketentuan-komunitas`, `/bantuan`,
   dan `/tentang` membuka halaman baru. Baru setelah itu isi URL hapus akun di Play Console. Bila naskah terpaksa
   terbit lebih dulu, pilih alamat sementara `baru.kapdh.or.id` di `pratinjau.html`, lalu terbitkan ulang dengan
   alamat kapdh.or.id setelah domain dipindah.
2. **Nasib data aplikasi lama "KAPDH Alumni" sudah diputuskan** sebelum domain dipindah. Aplikasi lama menyimpan
   data alumni (termasuk NIK bila pernah diisi), dan halaman kebijakan privasi serta hapus akunnya akan hilang saat
   domain dipindah. Pilihannya: dihentikan dan datanya dihapus dengan pemberitahuan kepada penggunanya, atau tetap
   berjalan di subdomain terpisah lengkap dengan kebijakan privasi dan halaman hapus akun yang berfungsi. Naskah baru
   sengaja belum menyebut aplikasi lama; tambahkan paragraf di Kebijakan Privasi bagian 5 hanya setelah prosesnya
   benar-benar ada.
3. **Bucket deletion ledger di luar VPS sudah dikonfigurasi** (`DELETION_LEDGER_S3_*`). Tanpa bucket ini worker
   production menolak berjalan dan penghapusan akun tertunda, sehingga janji "penghapusan selesai paling lambat 7 hari
   kalender" tidak terpenuhi.
4. **Backup harian sudah berjalan** ke object storage di luar VPS (Cloudflare R2 atau Backblaze B2, belum dipilih),
   dengan rotasi 30 hari, dan **satu uji restore sudah berhasil** (ADR-018 masih mencatat belum ada restore drill).
   Kebijakan Privasi bagian 8, 10, dan 11.5 serta Bantuan menyebut cadangan harian terenkripsi yang dihapus paling lama
   30 hari.
5. **Ketentuan pemrosesan data (DPA) dengan setiap pemroses sudah ada dan diperiksa:** PT Cloud Hosting Indonesia
   (IDCloudHost, pemilik IP VPS menurut data APNIC), Resend, Google Firebase (setujui Data Processing and Security
   Terms di konsol Firebase), Cloudflare, Amazon Web Services (penerima email masuk kapdh.or.id menurut catatan MX),
   dan penyedia object storage yang dipilih. Kebijakan Privasi bagian 8 menyatakan para pemroses terikat ketentuan
   pemrosesan data dengan pelindungan yang sama atau setara (syarat Apple 5.1.1).
6. **Identitas organisasi dikonfirmasi:** nama badan hukum "Perkumpulan Keluarga Alumni Pesantren Darel Hikmah"
   sesuai SK AHU, lokasi pesantren (Pekanbaru, Riau), visi, misi, dan semboyan di halaman Tentang (bersumber dari
   situs lama, belum ada di PRD), serta nama akun developer Google Play dan Apple yang persis sama dengan nama badan
   hukum.
7. **Batas usia 18 tahun disetujui pemilik.** Aplikasi tidak menanyakan usia dan tidak dapat mencatat persetujuan
   orang tua atau wali, sehingga naskah menetapkan layanan hanya untuk usia 18 tahun ke atas (pernyataan usia melalui
   persetujuan Ketentuan Layanan). Disarankan menambahkan kalimat usia pada centang pendaftaran di aplikasi dan
   memilih rating usia toko yang konsisten. Bila pemilik ingin menerima alumni di bawah 18 tahun, alur persetujuan wali
   yang tercatat harus dibangun lebih dahulu dan naskah diubah.
8. **Akun yang menyetujui naskah DRAF diperiksa.** Production sudah membuka pendaftaran dengan versi legal 1 (teks
   DRAF). Bila hanya ada akun uji, hapus akun tersebut. Buat akun demo untuk reviewer toko **setelah** naskah final
   terbit.
9. **Ada petugas yang memantau bantuan@kapdh.or.id** untuk permintaan terkait data pribadi, termasuk akhir pekan dan
   hari libur, karena tenggat UU PDP 3 x 24 jam dihitung dalam jam. Halaman lain menyatakan pertanyaan umum dijawab
   pada hari kerja, sedangkan permintaan data pribadi mengikuti jangka waktu Kebijakan Privasi.
10. **Dokumen internal tersedia** (tidak dipublikasikan): penilaian dampak pelindungan data (DPIA) untuk bukti
    pembayaran, analisis kepentingan yang sah untuk keamanan, audit, dan moderasi, serta catatan aktivitas
    pemrosesan. Kebijakan Privasi menawarkan penjelasan pertimbangan kepentingan yang sah atas permintaan.
11. **Nomor WhatsApp dukungan diisi** di pengaturan aplikasi. Naskah merujuk ke "nomor WhatsApp dukungan yang
    tercantum di aplikasi dan di halaman Kontak".

## Butir terbuka lain

Butir berikut tidak membuat naskah keliru, tetapi perlu keputusan pemilik atau perubahan aplikasi. Bila salah satunya
diselesaikan, naskah terkait perlu diterbitkan ulang.

- **Font Poppins diunduh dari Google Fonts saat aplikasi berjalan.** Naskah mengungkapkannya dengan jujur (Kebijakan
  Privasi bagian 8, 9, 10, dan 17), tetapi pengiriman alamat IP ke Google ini tidak punya perjanjian pemrosesan. Sangat
  disarankan membundel Poppins sebagai aset sebelum rilis. Setelah dibundel, hapus butir Google Fonts di bagian 8,
  butir unduhan huruf di bagian 9 (daftar dan pelindungan), serta kata "huruf" pada bagian 10 dan 17, lalu terbitkan
  ulang. Selaraskan formulir Data safety dan App Privacy.
- **Email akun aktif belum dapat diganti** (tidak ada alur di aplikasi, web admin, maupun CLI). Naskah menyatakannya
  apa adanya. Disarankan membuat alur ganti email terverifikasi. Teks aplikasi di
  `kapdh-mobile/lib/features/account/profile_edit_screen.dart` ("email diubah lewat alur verifikasi email")
  bertentangan dengan naskah dan perlu diperbaiki.
- **Pendaftaran yang tidak pernah diverifikasi disimpan tanpa batas** (tidak ada job pembersih akun `pending_otp`).
  Disarankan job yang menghapusnya setelah 30 hari, lalu tambahkan masa itu di Kebijakan Privasi bagian 10.
- **Pihak yang dilaporkan tidak diberi tahu** saat kontennya dihapus atau dilaporkan. Permenkominfo 5/2020 Pasal 10
  ayat (4) mewajibkan pemberitahuan aduan kepada pengunggah. Putuskan bersama penasihat hukum; bila diterapkan, ubah
  Ketentuan Komunitas bagian 8.
- **Apple 1.2:** filter otomatis saat ini hanya menolak karakter tersembunyi dan tautan berbahaya, dan target laporan
  non-ancaman 2 hari kerja. Pertimbangkan filter kata kasar, cabul, dan SARA serta target 24 jam, atau siapkan catatan
  reviewer yang menjelaskan proses moderasi.
- **Teks izin iOS** (`Info.plist`, kamera dan galeri) baru menyebut bukti transfer dan foto profil. Tambahkan foto
  grup dan gambar chat agar sesuai Kebijakan Privasi bagian 18.
- **Notifikasi push** belum aktif di konfigurasi build yang ada di repo (`PUSH_ENABLED=false`, entitlement APNs belum
  ada). Naskah sudah ditulis "bila tersedia", sehingga tetap benar sebelum dan sesudah push diaktifkan.
- **Hari kerja** di naskah berarti Senin sampai Jumat WIB, sama dengan perhitungan sistem (belum ada kalender libur
  nasional). Bila pemilik ingin hari libur dikecualikan, kalender libur harus ditambahkan ke kode lebih dahulu.
- **Pelacakan galat (GlitchTip)** bila diaktifkan hanya menerima data teknis tanpa data pribadi, sebagaimana tertulis
  di Kebijakan Privasi bagian 4.11. Pertahankan daftar putih field yang ada.
- **Teks aplikasi tentang iuran** yang masih memakai istilah "terkunci" atau "membuka fitur" tercatat sebagai pemblokir
  submit di `docs/runbooks/app-store-submission.md` bagian 2. Naskah halaman sudah memakai rumusan status keanggotaan.
- **Bantuan di iOS** memuat langkah pembayaran transfer. Bila reviewer Apple mempermasalahkannya, pertimbangkan versi
  Bantuan yang lebih ringkas untuk bagian iuran.
