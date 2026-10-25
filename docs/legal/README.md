# Naskah halaman informasi dan legal KAPDH

Folder ini memuat naskah final lima halaman yang diterbitkan pemilik melalui editor web admin. Naskah mengacu pada
UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP) dan disusun untuk memenuhi persyaratan Google Play
dan Apple App Store. Setiap pernyataan tentang cara kerja aplikasi sudah dicocokkan dengan kode R1.0 per
15 Oktober 2026, uraian data profil dengan profil berulang (migrasi 0009-0010) per 21 Oktober 2026, dan target
penanganan laporan dengan keputusan PP K5 per 25 Oktober 2026.

- **Tanggal berlaku:** setiap halaman memuat baris "Berlaku sejak ..." sendiri. Kebijakan Privasi, Ketentuan Layanan,
  Ketentuan Komunitas, dan Bantuan adalah revisi profil berulang yang belum terbit; Ketentuan Komunitas dan Bantuan
  juga memuat perubahan prioritas laporan K5. Tanggalnya masih berupa penanda `[tanggal terbit]` (lihat Revisi profil
  berulang di bawah). Tentang berlaku sejak 18 Oktober 2026; bila diterbitkan pada tanggal lain, ubah baris itu
  menjadi tanggal terbit sebenarnya sebelum menekan Terbitkan.
- **Pratinjau dan cara menyalin:** buka `pratinjau.html` di peramban. Halaman itu memuat kelima naskah, tombol
  "Salin isi" per halaman, kolom tanggal terbit revisi, dan langkah penerbitan.

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
5. Pada hari yang sama, perbarui salinan statis di situs publik (bagian Setelah menerbitkan).

## Setelah menerbitkan: salinan statis di situs publik

Situs publik menanam naskah tayang kelima halaman ke HTML saat build agar terbaca tanpa JavaScript (URL kebijakan
privasi di Google Play dan App Store wajib berisi naskah; `docs/runbooks/app-store-submission.md` bagian 7). Sumbernya
`kapdh-platform/apps/web/src/published-pages/<slug>.json`, salinan respons `GET /public/pages/{slug}` production,
bukan berkas di folder ini. Saat JavaScript aktif situs tetap menampilkan versi terbaru dari API, tetapi pembaca tanpa
JavaScript (termasuk perayap review toko) melihat salinan itu sampai situs dibangun ulang. Setiap kali naskah terbit:

1. Dari `kapdh-platform/`, jalankan `pnpm --filter @kapdh/web pages:sync`. Skrip menulis ulang salinan dari API
   production dan menolak naskah yang memuat `[tanggal terbit]` atau kerangka DRAF; bila ditolak, perbaiki naskah di
   web admin dan terbitkan ulang.
2. Tinjau diff salinan, commit lewat PR, lalu build dan deploy image web seperti rilis biasa. Build gagal bila halaman
   hasil build tidak memuat seluruh teks salinan.
3. Pastikan `pnpm --filter @kapdh/web pages:check` lulus dan `curl` di `app-store-submission.md` bagian 7 memuat
   naskah pada URL production.

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

## Revisi profil berulang (terbit bersama rilis aplikasi)

Revisi ini menyesuaikan uraian data profil dengan profil berulang (`docs/runbooks/rilis-dan-gerbang-go-live.md`
bagian 5.5, `kapdh-platform/packages/contracts/CHANGELOG.md`): profesi paling banyak 5 (dari master atau ketik sendiri;
yang pertama menjadi profesi utama di KTA), riwayat pendidikan paling banyak 10 entri (institusi, jurusan, strata
D3/S1/S2/S3/Lainnya, tahun tamat; kota tidak lagi diisi), dan paling banyak 10 tautan media sosial untuk sembilan
platform yang hanya tampil ke sesama anggota bila Tampilkan media sosial (`show_social`) aktif.

Revisi ini juga memuat keputusan PP K5 (25 Oktober 2026, Opsi A di `docs/runbooks/app-store-submission.md`
bagian 9.4): laporan kategori Konten seksual, termasuk konten seksual yang melibatkan anak, menjadi mendesak dengan
target 24 jam seperti Ancaman kekerasan atau keselamatan. Kategori lain dan banding tetap 2 hari kerja. Server
menghitungnya lewat `priorityFor` di `kapdh-platform/apps/api/src/modules/moderation/due-at.ts` (PR #40).

- **Bagian yang berubah:** Kebijakan Privasi 4.2, 4.3 (profesi utama di KTA), 7.1, dan 11.3; Ketentuan Layanan 11
  (riwayat pendidikan); Ketentuan Komunitas 1 (riwayat pendidikan, profesi ketikan sendiri); Bantuan bagian Mengubah
  profil, Profesi atau keahlian tidak ada dalam daftar, Data yang hanya dapat dikoreksi pengurus, Privasi profil, Apa
  yang dapat dilihat anggota lain, Apa isi KTA digital, dan Data yang dihapus. Bantuan juga diselaraskan dengan kode
  pada bagian Siapa yang dapat saya kirimi pesan? (percakapan langsung baru hanya dari profil anggota yang tampil di
  direktori) dan Akun saya dibatasi (halaman pembatasan tidak memuat Laporan saya; laporan dibuka dari notifikasinya),
  begitu pula Ketentuan Komunitas 9 Pembatasan akun. Perubahan K5: Ketentuan Komunitas bagian 7 Memilih kategori
  (Konten seksual mencakup segala konten seksual yang melibatkan atau membahayakan anak dan ditangani dengan
  prioritas) dan bagian 8 Target waktu penanganan (Konten seksual paling lambat 24 jam), serta paragraf target
  penanganan laporan di Bantuan bagian Melaporkan pengguna, pesan, atau grup. Tentang tidak berubah.
- **Kapan terbit:** pada hari build aplikasi mobile pertama yang memakai daftar baru dirilis ke pengguna, setelah API
  dan web admin rilis 0009-0010 berjalan di production, dan setelah image API yang memuat `priorityFor` sexual =
  urgent (PR #40) berjalan di production (Syarat sebelum terbit butir 8). Jangan lebih awal: aplikasi 1.0.0 hanya
  menampilkan satu profesi, satu pendidikan, dan empat media sosial, dan sebelum API K5 berjalan laporan Konten
  seksual masih mendapat target 2 hari kerja. Jangan ditunda: build baru mengumpulkan jurusan, strata, tahun
  tamat, profesi ketikan sendiri, dan lima platform baru yang tidak disebut naskah sebelumnya. Urutannya: deploy image
  API K5, lalu distribusikan build mobile yang membawa petunjuk 24 jam untuk Konten seksual, lalu terbitkan naskah.
- **Umumkan lebih dahulu.** Revisi menambah jenis data profil opsional, dan Kebijakan Privasi bagian 19 menjanjikan
  pengumuman melalui aplikasi dan situs sebelum perubahan seperti ini berlaku (misalnya berita singkat beberapa hari
  sebelum rilis). Persetujuan ulang tidak diperlukan menurut aturan perubahan di atas: data baru bersifat opsional
  dengan dasar persetujuan yang diberikan saat mengisinya, dan tujuan pemrosesan tidak berubah.
- **Tanggal dan versi:** isi kolom Tanggal terbit revisi di `pratinjau.html` (Salin isi dan Pilih isi menolak selama
  kosong), atau ganti `[tanggal terbit]` di editor sebelum menekan Terbitkan. Terbitkan keempat halaman pada hari yang
  sama. Penerbitan menaikkan `privacy_version`, `terms_version`, dan
  `community_version` secara otomatis, dan gerbang go-live `legal_pages` tetap harus lulus. Pada hari yang sama,
  perbarui salinan statis situs publik dan deploy ulang image web (bagian Setelah menerbitkan).
- **Kota pendidikan lama:** Kebijakan Privasi 4.2 dan Bantuan menyebutnya karena `last_education_city` dari aplikasi
  1.0.0 masih tersimpan di data production dan dikirim ke aplikasi lama selama masa transisi (dikosongkan saat
  institusi pendidikan teratas berganti). Setelah field lama dihapus dari kontrak dan skema (bagian 5.5 langkah 7),
  hapus kalimat tentang kota pendidikan lama dan versi aplikasi sebelumnya, lalu terbitkan ulang.
- Naskah yang tayang sebelum revisi ini (Kebijakan Privasi 16 Oktober 2026, lainnya 15 Oktober 2026) tersimpan di
  riwayat git folder ini dan di jejak audit `page.published`.
- Per 25 Oktober 2026 yang tayang adalah Kebijakan Privasi v4, Ketentuan Layanan v4, Ketentuan Komunitas v2,
  Bantuan v6, dan Tentang v3 (salinannya di `kapdh-platform/apps/web/src/published-pages/`). Ketentuan Layanan v4 dan
  Bantuan v6 (terbit 21 Oktober 2026, "Berlaku sejak 21 Oktober 2026") tidak sama persis dengan berkas mana pun di
  riwayat folder ini; Ketentuan Layanan v4 bagian 11 sudah memakai "riwayat pendidikan" dari revisi ini.

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
8. **API dengan prioritas laporan K5 sudah berjalan di production.** Ketentuan Komunitas bagian 7 dan 8 serta Bantuan
   (Melaporkan pengguna, pesan, atau grup) menyatakan laporan Konten seksual ditangani paling lambat 24 jam. Janji itu
   baru benar setelah image API yang memuat `priorityFor` sexual = urgent (PR #40) berjalan di production; sebelum
   itu laporan baru kategori ini masih berprioritas normal dengan target 2 hari kerja. Karena itu, naskah revisi baru
   boleh diterbitkan setelah image API tersebut berjalan, dan build aplikasi mobile yang membawa petunjuk baru pada
   kategori Konten seksual ("Ditangani paling lambat 24 jam") juga hanya didistribusikan setelah API itu berjalan.
   Laporan Konten seksual yang dibuat sebelum deploy tetap berprioritas normal (prioritas tidak dihitung ulang), jadi
   tangani laporan seperti itu yang masih aktif tanpa menunggu targetnya.

Syarat tambahan dan daftar butir terbuka lainnya dikelola pengurus secara internal.
