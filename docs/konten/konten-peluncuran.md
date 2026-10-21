# Konten Peluncuran KAPDH Apps: 3 Berita, 3 Banner, 3 Event

Draf konten awal untuk diterbitkan pengurus melalui web admin (admin.kapdh.or.id) saat KAPDH Apps diumumkan
kepada alumni. Disusun 18 Oktober 2026 dan dicocokkan dengan aturan isian di kode R1.0, Ketentuan Layanan, dan
Bantuan (`docs/legal/`). Status: **draf, perlu disahkan pengurus sebelum terbit.**

Daftar isi:

- [Cara memakai berkas ini](#cara-memakai-berkas-ini)
- [Prasyarat sebelum terbit](#prasyarat-sebelum-terbit)
- [Kategori yang perlu dibuat](#kategori-yang-perlu-dibuat)
- [Urutan penerbitan](#urutan-penerbitan)
- [Aturan gambar dan palet warna](#aturan-gambar-dan-palet-warna)
- [A. Berita](#a-berita)
- [B. Banner](#b-banner)
- [C. Event](#c-event)
- [Catatan operasional](#catatan-operasional)

---

## Cara memakai berkas ini

- **`[ISI: ...]`** menandai keputusan yang belum ditetapkan organisasi (tanggal, jam, tempat, harga, kuota,
  pembicara, tautan). Teks dalam kurung **(usulan: ...)** hanya saran. Ganti semua `[ISI: ...]` sebelum menyimpan.
  Jangan terbitkan konten yang masih memuat `[ISI`, karena berita yang terbit langsung dikirim sebagai notifikasi
  ke semua anggota aktif, dan notifikasi itu tidak dapat ditarik atau diulang.
- Nilai yang disalin apa adanya ditulis dalam blok kode. Panjang setiap nilai sudah dihitung terhadap batas isian.
- **Isi berita:** editor web admin adalah editor teks kaya tanpa mode kode HTML. Buka berkas ini dalam tampilan
  pratinjau (VS Code: `Ctrl+Shift+V`, atau tampilan berkas di Git hosting), blok teks di kotak "Isi berita",
  salin, lalu tempel ke kolom **Isi berita**. Subjudul, daftar, huruf tebal, dan tautan ikut terbawa. Jangan ikut
  menyalin baris judul kotak. Sumber HTML di berkas ini hanya memakai tag yang diterima sanitizer (`p`, `h2`,
  `strong`, `em`, `ul`, `ol`, `li`, `a`), dan semua tautannya `https://` atau `mailto:`. Ketiga isi berita sudah
  diuji dengan sanitizer server (`html-sanitizer.ts`): seluruh teks dan tautan tetap utuh. Isi berita sengaja
  **tanpa gambar**: gambar cukup di kolom **Gambar cover**.
- **Deskripsi event** adalah teks polos. Salin isi blok kode apa adanya. Baris baru tetap tampil di aplikasi,
  tetapi tautan di deskripsi tidak dapat diketuk.
- Semua jam ditulis dalam WIB (Asia/Jakarta). Formulir berita dan banner menerima jam WIB, dan event memakai zona
  event (WIB untuk Pekanbaru).
- Jangan menambahkan penanda `[Contoh]` pada judul apa pun. Penanda itu dipakai data uji dan menggagalkan gerbang
  go-live.

## Prasyarat sebelum terbit

Centang semua butir sebelum menerbitkan Berita 1. Bila ada yang belum terpenuhi, sebagian kalimat konten menjadi
tidak benar.

- [ ] **Aplikasi sudah disetujui Google Play dan App Store**, dan Pengaturan > Pengaturan Aplikasi > kartu
      **Tautan toko aplikasi** sudah diisi sehingga halaman `/unduh` menampilkan tombol toko (`production-init.md`
      butir 4.7). Pengumuman kepada alumni menunggu persetujuan toko. Bila baru satu toko yang menyetujui, ubah
      frasa "Android dan iOS" di Berita 1.
- [x] **Domain `kapdh.or.id` sudah mengarah ke situs baru** (`docs/legal/README.md`, Syarat sebelum terbit butir 1).
      Terpenuhi 21 Oktober 2026 (`docs/qa/transport/2026-10/README.md`); konten memakai `https://kapdh.or.id/`.
      `baru.kapdh.or.id` hanya dialihkan dan tidak dipakai di konten.
- [ ] **Kelima halaman informasi sudah terbit** (Kebijakan Privasi, Ketentuan Layanan, Ketentuan Komunitas,
      Bantuan, Tentang KAPDH), karena berita menautkannya.
- [ ] **Tujuan pembayaran resmi aktif** di **Verifikasi Pembayaran > tab Kelola Metode** (izin `settings.manage`):
      rekening bank/dompet digital atas nama KAPDH, dan QRIS bila disediakan (`production-init.md` butir 4.4).
      **Nomor WhatsApp dukungan** sudah diisi di Pengaturan > Pengaturan Aplikasi > kartu **Kontak dukungan** >
      isian **WhatsApp pengurus** (butir 4.5), karena Berita 1 dan Berita 3 merujuk nomor itu.
- [ ] **Batas pembatalan tiket `self_cancel_days` tetap 3 (H-3).** Teks Event 2 dan naskah legal menyebut H-3.
- [ ] **Kategori sudah dibuat** (bagian berikut).
- [ ] Penerbit berita dan banner memiliki izin `content.manage`, dan penerbit event memiliki izin `events.manage`.
      Banner 3 bertujuan event, sehingga pemilih event di formulir banner hanya muncul bagi admin yang juga
      memiliki `events.manage`. Admin lain menempel ID event.

## Kategori yang perlu dibuat

Seed production tidak membuat kategori. Buat kategori sebelum konten agar dapat dipilih. Kategori nonaktif tidak
dapat dipilih.

| Jenis | Tempat membuat | Label | Slug | Urutan tampil | Aktif | Dipakai oleh |
| ----- | -------------- | ----- | ---- | ------------- | ----- | ------------ |
| Berita | Manajemen Konten > Berita, Banner & Halaman > tab Kategori > Tambah Kategori | `Pengumuman` | `pengumuman` | 10 | Ya | Berita 1 |
| Berita | (sama) | `Organisasi` | `organisasi` | 20 | Ya | Berita 2 |
| Berita | (sama) | `Panduan` | `panduan` | 30 | Ya | Berita 3 |
| Event | Manajemen Event & Tiket > Daftar Event > Manajemen Kategori | `Silaturahmi` | `silaturahmi` | 10 | Ya | Event 1, Event 2 |
| Event | (sama) | `Jejaring` | `jejaring` | 20 | Ya | Event 3 |

Di formulir kategori event, isian Label bernama **Nama kategori** dan Urutan tampil bernama **Urutan**. Kategori
event baru langsung aktif; sakelar **Tampil untuk event baru** di daftar kategori menandai status aktifnya.

Banner tidak memiliki kategori sendiri. Kolom Kategori di tabel banner menampilkan kategori berita atau event
tujuannya.

## Urutan penerbitan

H adalah hari pengumuman peluncuran. Setiap berita yang terbit mengirim satu notifikasi ke semua anggota aktif,
sehingga jarak antarberita sengaja dibuat beberapa hari. Menerbitkan event tidak mengirim notifikasi. Karena itu,
event diumumkan lewat Berita 1 dan Banner 3.

| Kapan | Langkah | Alasan |
| ----- | ------- | ------ |
| H-1 | Buat kategori. Unggah setiap gambar dari formulir kontennya sendiri pada saat konten itu dibuat, lalu langsung simpan. Jangan mengunggah gambar untuk berita atau banner yang baru dibuat beberapa hari kemudian. | Unggahan yang tidak dilampirkan dalam 24 jam dihapus. Kuota unggah 10 berkas per jenis per admin per 24 jam. |
| H-1 | Buat **Event 1, 2, 3**, lalu tekan **Terbitkan** pada masing-masing. | Event harus berstatus terbuka sebelum Berita 1 menyebutnya dan sebelum Banner 3 menautkannya. |
| H | Terbitkan **Berita 1**, lalu buat **Banner 1** dengan Mulai tayang = waktu terbit Berita 1. | Banner yang tujuannya belum terbit tetap tampil, tetapi saat diketuk muncul "Konten tujuan sudah tidak tersedia". |
| H+3 | Terbitkan **Berita 3**, lalu buat **Banner 2**. | Panduan iuran dan perpanjangan. |
| H+7 | Terbitkan **Berita 2**, lalu buat **Banner 3**. | Profil organisasi dan pelindungan data. Banner 3 mempromosikan Event 3. |
| H-1 tiap event daring | Terbitkan berita singkat berisi tautan pertemuan (lihat [Catatan operasional](#catatan-operasional)). | Formulir event tidak memiliki isian tautan pertemuan daring. |

## Aturan gambar dan palet warna

### Ukuran dan format

| Pemakaian | Ukuran file yang dibuat | Rasio tampil di aplikasi | Area aman |
| --------- | ----------------------- | ------------------------ | --------- |
| Cover berita | **1600 x 900 px**, JPG | 16:9 di kartu dan detail berita (dipotong dari tengah) | Seluruh bidang terlihat. Beri jarak tepi 64 px. |
| Gambar banner | **1760 x 800 px**, JPG | Tepat 2,2:1 di Beranda: tinggi ubin dihitung dari lebar ubin yang sebenarnya, sehingga gambar 1760 x 800 tampil utuh tanpa potongan kiri-kanan di semua lebar layar. Gradien gelap mulai 45% tinggi (y 360) ke bawah. Judul banner ditulis aplikasi dengan huruf putih, maksimal 2 baris, rata kiri di bagian bawah, dan barisnya dapat membentang hampir selebar banner (kira-kira x 65-1695) | Elemen penting di **bagian atas (y 40-460)**. Kosongkan **pita bawah selebar penuh (y 460-800)** untuk judul, termasuk di sisi kanan. Batas y 460 berlaku untuk layar 345 dp ke atas dengan teks 100%; untuk aset baru, letakkan elemen penting di **y 40-420** (lihat catatan posisi judul banner di bawah). |
| Cover event | **1600 x 900 px**, JPG | 16:9 di detail event. Thumbnail kartu 92 x 76 px (sekitar 1,21:1) hanya menampilkan **x 255-1345**. Thumbnail Tiket Saya 72 x 72 px (1:1) hanya menampilkan **x 350-1250**; thumbnail detail tiket 88 x 72 px menampilkan x 250-1350 | Subjek utama di tengah, di dalam lebar 1090 px. Di Tiket Saya hanya lebar 900 px di tengah yang terlihat, jadi tepi luar subjek yang lebih lebar terpotong di sana. |

Aturan bersama:

- Format **JPG** (atau PNG untuk ilustrasi datar), maksimal **5 MB**. Usahakan di bawah 1 MB (JPG kualitas 80-85,
  sRGB). Server mengenali tipe dari isi berkas, jadi ekstensi harus sesuai format aslinya. Batas atas 12.000 px per
  sisi dan 40 megapiksel. Server tidak mengecilkan gambar.
- Gambar konten bersifat **publik**: jangan memuat data pribadi. Jangan pakai KTA, nama, atau nomor anggota asli,
  kode QR yang dapat dipindai, maupun wajah yang dapat dikenali tanpa izin tertulis yang bersangkutan. Gunakan
  ilustrasi, siluet, atau mockup dengan teks samaran.
- Jangan menulis ulang judul di dalam gambar, karena judul sudah tampil di kartu. Teks di gambar cukup berupa logo
  KAPDH atau satu kata kunci pendek.
- Huruf (bila ada teks): **Poppins** SemiBold/Bold.
- Form banner admin menampilkan petunjuk yang sama: rasio 2,2:1, disarankan 1760 x 800 px, elemen penting di bagian
  atas, dan judul tidak ditulis di gambar (cukup logo atau satu kata kunci) karena tampil otomatis. Gambar berasio
  lain tetap diisi dari tengah (sisi yang berlebih terpotong). Bila terpaksa memakai 16:9 (1600 x 900), sekitar 9,5%
  bagian atas dan bawah terpotong.
- Posisi judul banner bergantung pada lebar layar dan ukuran teks. Ubin selalu tepat 2,2:1 (tinggi sekitar 113 dp di
  layar 320 dp, 130 dp di 360 dp, dan 152 dp di 412 dp), sedangkan tinggi judul tetap: 2 baris sekitar 40 dp ditambah
  jarak bawah 12 dp. Dengan teks 100%, judul 2 baris mulai di sekitar y 480 (360 dp), y 511 (393 dp), dan y 526
  (412 dp). Di ponsel 320 dp judul naik ke sekitar y 433. Dengan teks 130%, judul mulai di sekitar y 407 (360 dp) atau
  y 349 (320 dp). Karena itu, untuk aset baru letakkan elemen penting di y 40-420. Ketiga banner peluncuran tidak perlu
  diubah: di layar 320 dp hanya pita kuning bawah kartu di Banner 2 (sekitar y 435, sisi kanan) yang nyaris tersentuh
  baris judul.
- APK uji push 1.0.0+1 yang pertama menghitung tinggi banner dari lebar layar, bukan lebar ubin, sehingga ubin
  sekitar 1,95:1 dan gambar 2,2:1 terpotong sekitar 5-6% di kiri dan kanan. APK yang dibangun ulang menampilkan
  tepat 2,2:1; ketiga gambar banner tidak perlu diubah.

### Palet merek (packages/design-tokens/tokens.json)

| Token | Hex | Pemakaian di gambar |
| ----- | --- | ------------------- |
| green-950 (surface-dark) | `#0E280C` | Latar gelap utama |
| green-800 (primary) | `#1A4B17` | Hijau utama, bidang besar |
| green-700 | `#215E1E` | Gradasi terang dari hijau utama |
| green-600 | `#2D7A28` | Aksen hijau, garis ilustrasi |
| green-100 | `#E3F0E1` | Latar terang lembut |
| gold-500 (accent) | `#E6D312` | Aksen emas: garis, ornamen, sorotan |
| gold-100 | `#FBF6C9` | Latar emas pucat |
| cream (surface-brand) | `#FCF8F5` | Latar krem |
| Gradien KTA | `linear-gradient(135deg, #020702 0%, #0E280C 45%, #215E1E 100%)` | Latar banner dan kartu KTA |

---

## A. Berita

Menu: **Manajemen Konten > Berita, Banner & Halaman > tab Berita > Buat Konten Baru**. Berita selalu disimpan
sebagai draf lebih dahulu, lalu diterbitkan dari panel **Status & Penerbitan** (pilih **Terbitkan sekarang** atau
**Jadwalkan** dengan jam WIB di masa depan).

Ingat:

- Ringkasan menjadi **isi notifikasi push dan kotak masuk**. Kalimat pertama ringkasan juga harus bermakna, karena
  kartu berita hanya menampilkan 2 baris.
- Ringkasan **tidak** tampil di halaman detail. Isi berita harus lengkap tanpa ringkasan.
- Slug terkunci setelah berita tampil ke anggota. Periksa ejaan judul dan slug sebelum terbit.

### Berita 1: Peluncuran KAPDH Apps dan cara bergabung

**Judul konten** (wajib, 1-200 karakter)

```text
KAPDH Apps Resmi Hadir: Wadah Digital Silaturahmi Alumni Darel Hikmah
```

Panjang: 69 karakter

**Slug tautan** (opsional, pola huruf kecil-angka-tanda hubung)

```text
kapdh-apps-resmi-hadir
```

Panjang: 22 karakter

**Ringkasan** (opsional, maks 300; menjadi isi notifikasi)

```text
Alhamdulillah, aplikasi resmi KAPDH kini dapat digunakan di Android dan iOS. Simak layanan yang tersedia, cara mengajak sahabat alumni bergabung, dan agenda silaturahmi terdekat.
```

Panjang: 178 karakter

**Kategori:** `Pengumuman`

**Gambar cover:** lihat Aset gambar.

**Isi berita** (wajib, maks 200.000 karakter setelah dibersihkan)

<details open>
<summary>Isi berita: salin dari tampilan pratinjau (Berita 1)</summary>
<p>Assalamu'alaikum warahmatullahi wabarakatuh.</p>
<p>Alhamdulillah, KAPDH Apps, aplikasi resmi Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH), kini dapat digunakan di Android dan iOS. Aplikasi ini menjadi wadah digital bagi alumni Pondok Pesantren Darel Hikmah lintas angkatan untuk menjaga silaturahmi, mengikuti kabar organisasi, dan saling terhubung, sejalan dengan semboyan kita: <em>Mengabdi untuk Umat, Menjaga Silaturahmi, Meneladani Akhlak Mulia</em>.</p>
<p>Terima kasih kepada Anda yang telah lebih dahulu bergabung. Mari bersama mengajak sahabat alumni lainnya agar keluarga besar Darel Hikmah semakin erat.</p>
<h2>Layanan di KAPDH Apps</h2>
<ul>
<li><strong>KTA digital berkode QR.</strong> Siapa pun dapat memeriksa keaslian dan status KTA dengan memindai kodenya. Hasil pemeriksaan hanya menampilkan status keanggotaan dan identitas terbatas.</li>
<li><strong>Beranda</strong> berisi berita, pengumuman organisasi, dan kegiatan mendatang.</li>
<li><strong>Event</strong> memuat jadwal, lokasi, kuota, dan biaya kegiatan bila ada. Anggota aktif dapat mendaftar dan menerima tiket digital berkode QR untuk check-in di lokasi acara.</li>
<li><strong>Jejaring</strong> adalah direktori sesama anggota yang dapat dicari berdasarkan nama, angkatan, kelas, kota, profesi, dan keahlian. Anda sendiri yang mengatur data yang tampil melalui Akun &gt; Privasi profil.</li>
<li><strong>Pesan dan Pesan Grup</strong> untuk berkirim teks dan gambar dengan sesama anggota.</li>
<li><strong>Notifikasi</strong>, yaitu kotak masuk resmi untuk pemberitahuan pembayaran, masa keanggotaan, kegiatan, dan keamanan akun.</li>
</ul>
<p>Jejaring, pesan, dan pendaftaran event baru adalah layanan bagi anggota perkumpulan yang keanggotaannya aktif. Status keanggotaan diperbarui pengurus setelah iuran organisasi diverifikasi.</p>
<h2>Siapa yang dapat bergabung</h2>
<p>KAPDH Apps diperuntukkan bagi alumni Pondok Pesantren Darel Hikmah yang telah berusia 18 tahun atau lebih, dari angkatan 1 hingga angkatan terbaru. Termasuk di dalamnya alumni yang menamatkan MTs, Aliyah, atau keduanya, serta mereka yang pernah belajar di Darel Hikmah tetapi tidak menamatkan pendidikannya.</p>
<p>Data anggota tidak dipindahkan secara otomatis dari pendataan sebelumnya. Karena itu, setiap alumni, termasuk anggota lama, perlu mendaftar sendiri melalui aplikasi.</p>
<h2>Langkah bergabung</h2>
<ol>
<li>Pasang aplikasi KAPDH hanya melalui tautan resmi di halaman <a href="https://kapdh.or.id/unduh">Unduh Aplikasi</a>. Aplikasi mendukung Android 8.0 ke atas dan iOS 15 ke atas.</li>
<li>Ketuk <strong>Daftar</strong>, lalu isi nama lengkap, jenis kelamin, email, kata sandi, angkatan, serta kelas masuk dan kelas keluar. Pastikan angkatan dan kelas sudah benar, karena data tersebut dipakai untuk menyusun nomor anggota.</li>
<li>Baca dan setujui Kebijakan Privasi serta Ketentuan Layanan, lalu masukkan kode verifikasi 6 digit yang dikirim ke email Anda.</li>
<li>Tunaikan iuran pendaftaran keanggotaan sesuai instruksi pembayaran di aplikasi, lalu unggah bukti pembayaran.</li>
<li>Setelah pengurus memverifikasi iuran, keanggotaan dan KTA digital Anda aktif selama 12 bulan.</li>
</ol>
<p>KAPDH tidak meminta NIK, nomor KTP, tanggal lahir, maupun alamat rumah saat pendaftaran.</p>
<h2>Agenda terdekat</h2>
<p>Buka tab <strong>Event</strong> untuk melihat rincian dan mendaftar:</p>
<ul>
<li><strong>Peluncuran KAPDH Apps dan Silaturahmi Alumni</strong> (daring, gratis): [ISI: hari, tanggal, jam WIB].</li>
<li><strong>Halal Bihalal dan Silaturahmi Akbar Alumni</strong> di Pekanbaru: [ISI: hari, tanggal, jam WIB].</li>
<li><strong>Temu Jejaring Alumni Lintas Profesi</strong> (daring, gratis): [ISI: hari, tanggal, jam WIB].</li>
</ul>
<p>Setiap anggota memegang satu tiket untuk dirinya sendiri pada setiap kegiatan.</p>
<h2>Jaga keamanan akun</h2>
<ul>
<li>Pengurus KAPDH tidak pernah meminta kata sandi atau kode verifikasi (OTP) Anda. Jangan berikan keduanya kepada siapa pun, termasuk kepada orang yang mengaku sebagai pengurus.</li>
<li>Lakukan pembayaran hanya ke tujuan yang tampil pada instruksi di aplikasi. Jangan mentransfer ke rekening yang dikirimkan melalui pesan pribadi.</li>
<li>Pasang aplikasi hanya dari tautan resmi di halaman Unduh Aplikasi.</li>
</ul>
<h2>Butuh bantuan?</h2>
<p>Panduan penggunaan tersedia di halaman <a href="https://kapdh.or.id/bantuan">Bantuan</a>, yang juga dapat dibuka melalui Akun &gt; Bantuan. Anda juga dapat menghubungi kami melalui <a href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a> atau nomor WhatsApp dukungan yang tercantum di aplikasi.</p>
<p>Wassalamu'alaikum warahmatullahi wabarakatuh.</p>
<p><strong>Pengurus KAPDH</strong></p>
</details>

Panjang sumber HTML: 4.694 karakter

**Status & Penerbitan:** Terbitkan sekarang pada hari H, atau Jadwalkan `[ISI: tanggal dan jam WIB]`
(usulan: pukul 08.00 WIB pada hari pengumuman resmi).

**Aset gambar:** 1600 x 900 px, JPG, sRGB, maksimal 5 MB (target di bawah 1 MB). Latar gradien KTA
(`#020702` ke `#0E280C` ke `#215E1E`, 135 derajat). Di tengah, mockup dua ponsel yang sedikit bertumpuk. Ponsel
depan menampilkan layar Beranda KAPDH Apps dengan isi samaran (banner hijau polos, kartu berita tanpa teks nyata),
dan ponsel belakang menampilkan kartu KTA digital dengan nama "Nama Anggota" serta kotak QR berupa ikon, bukan kode
yang dapat dipindai. Di belakang ponsel, lingkaran cahaya emas `#E6D312` dengan opasitas 30%, dan ornamen geometris
bintang delapan tipis berwarna emas di sudut kanan atas. Logo KAPDH berwarna krem `#FCF8F5` di kiri atas (lebar
sekitar 220 px, jarak tepi 64 px). Tanpa teks lain.
Berkas: `docs/konten/gambar/berita-1-peluncuran.jpg`.

---

### Berita 2: KAPDH sebagai perkumpulan berbadan hukum dan pelindungan data

**Judul konten** (wajib, 1-200 karakter)

```text
Mengenal KAPDH: Perkumpulan Berbadan Hukum dan Komitmen Pelindungan Data Anggota
```

Panjang: 80 karakter

**Slug tautan**

```text
mengenal-kapdh-badan-hukum-dan-pelindungan-data
```

Panjang: 47 karakter

**Ringkasan** (maks 300; menjadi isi notifikasi)

```text
KAPDH adalah perkumpulan alumni berbadan hukum yang disahkan Menteri Hukum dan HAM. Kenali maksud dan tujuan perkumpulan, serta cara KAPDH menjaga data pribadi anggota sesuai UU Pelindungan Data Pribadi.
```

Panjang: 203 karakter

**Kategori:** `Organisasi`

**Gambar cover:** lihat Aset gambar.

**Isi berita**

<details open>
<summary>Isi berita: salin dari tampilan pratinjau (Berita 2)</summary>
<p>KAPDH Apps adalah layanan resmi Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH). Agar setiap anggota mengenal organisasinya dengan baik, berikut penjelasan singkat tentang legalitas perkumpulan, maksud dan tujuannya, serta cara kami menjaga data pribadi Anda.</p>
<h2>Perkumpulan berbadan hukum</h2>
<p>KAPDH adalah perkumpulan berbadan hukum yang didirikan oleh para alumni Pondok Pesantren Darel Hikmah, Pekanbaru, Riau. Pendiriannya sebagai badan hukum didasarkan pada Akta Nomor 01 tanggal 27 Maret 2023 dan disahkan dengan Keputusan Menteri Hukum dan Hak Asasi Manusia Republik Indonesia Nomor AHU-0002732.AH.01.07.TAHUN 2023 tanggal 11 April 2023.</p>
<ul>
<li>KAPDH berasaskan Pancasila dan Undang-Undang Dasar 1945.</li>
<li>KAPDH adalah perkumpulan nirlaba. Seluruh kekayaan perkumpulan, termasuk iuran anggota, dipergunakan untuk mencapai maksud dan tujuan perkumpulan sesuai Anggaran Dasar.</li>
<li>Sebagai badan hukum tersendiri, KAPDH terpisah dari Pondok Pesantren Darel Hikmah, almamater para anggota kami. KAPDH bukan lembaga pendidikan: KAPDH tidak menyelenggarakan sekolah atau madrasah dan tidak menerima santri maupun peserta didik.</li>
</ul>
<h2>Maksud dan tujuan</h2>
<p>Sesuai Anggaran Dasar (Pasal 3 dan Pasal 4), KAPDH hadir untuk:</p>
<ol>
<li>Menghimpun seluruh lulusan atau alumni Pondok Pesantren Darel Hikmah lintas angkatan dalam satu wadah.</li>
<li>Menjadi sarana silaturahmi dan komunikasi antaralumni yang positif dan terarah.</li>
<li>Meningkatkan kreativitas alumni serta mempererat solidaritas dan ukhuwah Islamiah di antara sesama alumni.</li>
<li>Membimbing dan membina anggota, mengembangkan aspirasi mereka, serta memberdayakan seluruh potensi yang mereka miliki.</li>
<li>Turut memajukan almamater sebagai wujud bakti alumni.</li>
</ol>
<p>Visi kami adalah menjadi wadah pemersatu yang solid, berintegritas, dan mandiri bagi seluruh alumni Pondok Pesantren Darel Hikmah, serta berkontribusi nyata bagi almamater, umat, dan bangsa. Semboyan kami: <em>Mengabdi untuk Umat, Menjaga Silaturahmi, Meneladani Akhlak Mulia</em>.</p>
<h2>Mengapa pelindungan data penting</h2>
<p>Jejaring alumni tumbuh dari rasa saling percaya. Karena itu, KAPDH memproses data pribadi anggota dengan mengacu pada Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi. Beberapa komitmen kami:</p>
<ul>
<li><strong>Data secukupnya.</strong> Kami hanya meminta data yang diperlukan untuk keanggotaan dan layanan alumni. Kami tidak meminta NIK atau nomor KTP, tanggal lahir, alamat rumah, maupun lokasi perangkat Anda.</li>
<li><strong>Tanpa jual data dan tanpa iklan.</strong> Kami tidak menjual data pribadi, tidak menampilkan iklan, tidak memakai layanan analitik pihak ketiga, dan tidak melacak Anda lintas aplikasi atau situs.</li>
<li><strong>Anda yang mengatur.</strong> Email, nomor telepon, dan media sosial Anda tersembunyi dari sesama anggota, kecuali Anda sendiri menampilkannya melalui Akun &gt; Privasi profil.</li>
<li><strong>Verifikasi KTA seperlunya.</strong> Pemindaian kode QR KTA hanya menampilkan status keanggotaan dan identitas terbatas, tanpa email, nomor telepon, alamat, atau bukti pembayaran.</li>
<li><strong>Akses pengurus terbatas dan tercatat.</strong> Pengurus mengakses data melalui web admin dengan akun pribadi yang wajib memakai autentikasi dua langkah, hanya sesuai tugasnya, dan tindakan penting tercatat dalam jejak audit.</li>
<li><strong>Hak Anda terjaga.</strong> Anda dapat memperbarui profil di Akun &gt; Ubah profil, meminta akses atau salinan data melalui bantuan@kapdh.or.id, dan menghapus akun kapan saja melalui Akun &gt; Hapus akun.</li>
</ul>
<h2>Peran Anda sebagai anggota</h2>
<ul>
<li>Hormati data pribadi anggota lain yang Anda lihat di aplikasi. Gunakan data itu hanya untuk menjalin silaturahmi, dan jangan menyebarkannya tanpa izin pemiliknya.</li>
<li>Pesan di aplikasi tidak dienkripsi end-to-end. Jangan mengirim kata sandi, kode OTP, data rekening, atau informasi sensitif lainnya melalui pesan.</li>
<li>Pengurus KAPDH tidak pernah meminta kata sandi atau kode verifikasi (OTP) Anda.</li>
</ul>
<p>Penjelasan lengkap tersedia dalam <a href="https://kapdh.or.id/kebijakan-privasi">Kebijakan Privasi</a>, yang juga dapat dibuka di aplikasi melalui Akun &gt; Kebijakan privasi. Profil organisasi selengkapnya ada di halaman <a href="https://kapdh.or.id/tentang">Tentang KAPDH</a>. Untuk pertanyaan atau permintaan terkait data pribadi, hubungi <a href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a>.</p>
</details>

Panjang sumber HTML: 4.514 karakter

**Status & Penerbitan:** Jadwalkan `[ISI: tanggal dan jam WIB]` (usulan: H+7 pukul 08.00 WIB).

**Aset gambar:** 1600 x 900 px, JPG, maksimal 5 MB. Latar krem `#FCF8F5` dengan pola geometris Islami tipis
berwarna `#E3F0E1` di seluruh bidang. Di tengah, logo KAPDH berukuran besar (tinggi sekitar 300 px) di atas
lingkaran hijau `#1A4B17`. Di kanan bawah logo, ikon perisai bergaris emas `#E6D312` dengan simbol gembok sederhana
sebagai lambang pelindungan data. Garis bingkai emas tipis 6 px dengan jarak 48 px dari tepi. Jangan memotret akta
atau SK pengesahan, karena dokumen itu memuat nama dan tanda tangan pejabat. Tanpa teks selain logo.
Berkas: `docs/konten/gambar/berita-2-legalitas.jpg`.

---

### Berita 3: Panduan iuran keanggotaan dan KTA digital

**Judul konten** (wajib, 1-200 karakter)

```text
Panduan Iuran Keanggotaan dan KTA Digital: Pembayaran, Verifikasi, dan Perpanjangan
```

Panjang: 83 karakter

**Slug tautan**

```text
panduan-iuran-keanggotaan-dan-kta-digital
```

Panjang: 41 karakter

**Ringkasan** (maks 300; menjadi isi notifikasi)

```text
Iuran keanggotaan dibayar ke tujuan resmi yang tercantum di aplikasi, lalu diverifikasi pengurus. Simak langkah membayar dan mengunggah bukti, masa berlaku KTA 12 bulan, serta cara memperpanjang keanggotaan.
```

Panjang: 207 karakter

**Kategori:** `Panduan`

**Gambar cover:** lihat Aset gambar.

**Isi berita**

<details open>
<summary>Isi berita: salin dari tampilan pratinjau (Berita 3)</summary>
<p>Iuran KAPDH adalah iuran keanggotaan organisasi untuk mendukung kegiatan perkumpulan. Iuran bukan pembelian aplikasi, konten digital, atau fitur aplikasi, dan aplikasi KAPDH dapat diunduh tanpa biaya. Panduan ini merangkum ketentuan yang berlaku agar Anda dapat menyelesaikan iuran dengan tenang dan dapat membantu sahabat alumni yang baru bergabung.</p>
<h2>Jenis iuran</h2>
<ul>
<li><strong>Iuran pendaftaran</strong> untuk anggota baru, yang mencakup registrasi alumni dan pembuatan KTA digital.</li>
<li><strong>Iuran perpanjangan</strong> KTA setiap tahun.</li>
</ul>
<p>Nominal iuran ditetapkan pengurus dan selalu ditampilkan di aplikasi sebelum Anda membayar. Perubahan nominal hanya berlaku untuk pembayaran baru. KTA fisik tidak termasuk dalam iuran.</p>
<h2>Cara membayar</h2>
<p>Pembayaran dilakukan di luar aplikasi ke tujuan pembayaran resmi yang ditetapkan pengurus dan tercantum pada instruksi pembayaran di aplikasi, yaitu transfer ke rekening bank atau dompet digital atas nama KAPDH, atau QRIS atas nama KAPDH bila disediakan pengurus. Aplikasi tidak memproses pembayaran kartu dan tidak menarik dana dari rekening Anda.</p>
<ol>
<li>Untuk iuran pendaftaran, ikuti langkah <strong>Biaya KTA</strong> dan <strong>Pembayaran</strong> setelah verifikasi email, atau ketuk <strong>Bayar</strong> di tab KTA. Untuk perpanjangan, ketuk <strong>Perpanjang</strong> di tab KTA.</li>
<li>Periksa nominal dan tujuan pembayaran. Tujuan pembayaran masih dapat diganti sebelum bukti pertama dikirim.</li>
<li>Bayar sesuai nominal yang tertera melalui aplikasi bank atau dompet digital Anda.</li>
<li>Kembali ke aplikasi KAPDH, lalu unggah bukti pembayaran berupa foto atau tangkapan layar (JPG, PNG, atau WebP, maksimal 5 MB) atau PDF (maksimal 10 MB). Anda dapat menambahkan catatan untuk pengurus, misalnya nama pengirim atau bank asal.</li>
<li>Ketuk <strong>Kirim bukti pembayaran</strong>. Status pembayaran berubah menjadi Menunggu Verifikasi.</li>
</ol>
<p>Bukti pembayaran hanya dapat dilihat oleh Anda dan pengurus yang berwenang memverifikasi pembayaran. Status dan riwayat pembayaran dapat dilihat di Akun &gt; Riwayat pembayaran.</p>
<h2>Verifikasi oleh pengurus</h2>
<p>Pengurus yang berwenang mencocokkan bukti Anda dengan dana yang benar-benar masuk ke tujuan pembayaran, bukan hanya melihat berkas bukti. Pengurus berupaya memeriksa bukti secepatnya pada hari kerja. Pemeriksaan dapat memakan waktu lebih lama, misalnya pada akhir pekan, hari libur, atau bila dana perlu dicocokkan ulang.</p>
<p>Hasil verifikasi diberitahukan melalui kotak masuk notifikasi, notifikasi push bila tersedia dan Anda mengizinkannya, serta email, kecuali Anda menonaktifkannya di Preferensi notifikasi.</p>
<p>Bila bukti ditolak, baca <strong>Catatan dari pengurus</strong> pada halaman pembayaran, lalu ketuk <strong>Unggah ulang bukti</strong> untuk mengirim bukti baru pada pembayaran yang sama. Bila dana sudah Anda kirim, Anda tidak perlu transfer ulang.</p>
<h2>Masa berlaku KTA digital</h2>
<ul>
<li>KTA digital dibuat dengan status KTA Tidak Aktif setelah email Anda terverifikasi, dan menjadi KTA Aktif setelah pengurus memverifikasi iuran pendaftaran Anda. KTA berstatus Tidak Aktif bukan bukti keanggotaan.</li>
<li>Keanggotaan berlaku 12 bulan kalender sejak iuran pendaftaran diverifikasi pengurus. Tanggal transfer tidak menjadi dasar perhitungan.</li>
<li>Bila sisa masa 30 hari atau kurang, status berubah menjadi Segera Berakhir, dan pengingat dikirim 30 hari sebelum masa berakhir. Tidak ada masa tenggang setelah tanggal berakhir.</li>
<li>Pihak lain dapat memeriksa KTA Anda dengan memindai kode QR-nya. Tunjukkan KTA langsung dari aplikasi, bukan dari tangkapan layar lama, karena kode QR diperbarui setiap kali KTA disinkronkan.</li>
</ul>
<h2>Memperpanjang keanggotaan</h2>
<ul>
<li>Perpanjangan dapat diajukan mulai 30 hari sebelum masa berakhir dan tetap dapat diajukan setelah KTA kedaluwarsa. Buka tab KTA, ketuk <strong>Perpanjang</strong>, periksa iuran perpanjangan, lalu lanjutkan ke pembayaran.</li>
<li>Masa perpanjangan 12 bulan dihitung dari tanggal berakhir yang lama atau tanggal pengurus menyetujui perpanjangan, mana yang lebih akhir. Bila perpanjangan disetujui sebelum KTA kedaluwarsa, masa baru dimulai dari tanggal berakhir yang lama, sehingga sisa masa aktif Anda tidak hilang.</li>
<li>Bila KTA sudah kedaluwarsa saat perpanjangan disetujui, masa baru dihitung sejak tanggal persetujuan tersebut.</li>
<li>Tidak ada perpanjangan otomatis dan tidak ada penagihan berulang. Anda sendiri yang memutuskan kapan memperpanjang keanggotaan.</li>
</ul>
<p>Jejaring, pesan, dan pendaftaran event baru adalah layanan bagi anggota perkumpulan yang keanggotaannya aktif. Status keanggotaan diperbarui pengurus setelah iuran organisasi diverifikasi. Tiket event yang sudah lunas tetap berlaku walaupun keanggotaan berakhir sebelum acara, selama akun tidak dibatasi dan event tidak dibatalkan.</p>
<h2>Waspada penipuan</h2>
<ul>
<li>Lakukan pembayaran hanya ke tujuan yang tampil pada instruksi di aplikasi. Jangan mentransfer ke rekening yang dikirimkan melalui pesan pribadi, walaupun mengatasnamakan pengurus.</li>
<li>Jangan mentransfer ke instruksi pembayaran yang sudah dibatalkan, dan jangan mentransfer ulang untuk pembayaran yang sama.</li>
<li>Mengunggah bukti palsu atau bukti yang diubah dilarang dan dapat berakibat pembatasan akun.</li>
<li>Pengurus KAPDH tidak pernah meminta kata sandi atau kode verifikasi (OTP) Anda.</li>
</ul>
<h2>Bila ada kendala</h2>
<ul>
<li>Bila aplikasi menampilkan pesan <strong>Iuran melalui pengurus</strong>, iuran keanggotaan diselesaikan melalui pengurus. Hubungi pengurus melalui kontak yang tercantum. Status KTA diperbarui setelah pengurus memverifikasi pembayaran Anda.</li>
<li>Iuran yang telah disetujui tidak dikembalikan. Bila terjadi kekeliruan pembayaran, misalnya pembayaran ganda atau kelebihan bayar, hubungi kami dengan menyebutkan email akun, jenis pembayaran, nominal, dan tanggal transfer.</li>
</ul>
<p>Panduan lengkap tersedia di halaman <a href="https://kapdh.or.id/bantuan">Bantuan</a>, yang juga dapat dibuka melalui Akun &gt; Bantuan. Ketentuan iuran diatur dalam <a href="https://kapdh.or.id/ketentuan">Ketentuan Layanan</a> bagian 4. Pertanyaan dapat dikirim ke <a href="mailto:bantuan@kapdh.or.id">bantuan@kapdh.or.id</a> atau nomor WhatsApp dukungan yang tercantum di aplikasi.</p>
</details>

Panjang sumber HTML: 6.391 karakter

**Status & Penerbitan:** Jadwalkan `[ISI: tanggal dan jam WIB]` (usulan: H+3 pukul 08.00 WIB).

**Aset gambar:** 1600 x 900 px, JPG, maksimal 5 MB. Latar hijau muda `#E3F0E1` dengan gradasi ke krem `#FCF8F5`
di kanan. Di tengah, kartu KTA digital ukuran besar (lebar sekitar 760 px, miring 6 derajat) bergradien KTA
(`#020702`, `#0E280C`, `#215E1E`) dengan garis aksen emas `#E6D312`. Kartu memuat logo KAPDH, teks samaran
"NAMA ANGGOTA" dan "XX.XX.X.XXX", lencana status hijau bertuliskan "KTA Aktif" (teks `#1E7A46` di atas `#E8F7F0`),
dan kotak QR berupa ikon bergaya garis, bukan kode yang dapat dipindai. Di kiri kartu, ilustrasi datar ponsel yang
menampilkan ikon unggah dokumen dan tanda centang. Di kanan, ikon kalender kecil berangka "12". Tanpa nominal
iuran, nomor rekening, atau gambar QRIS.
Berkas: `docs/konten/gambar/berita-3-iuran-kta.jpg`.

---

## B. Banner

Menu: **Manajemen Konten > Berita, Banner & Halaman > tab Banner > Buat Banner**. Banner tampil di Beranda selama
**Aktif** dan berada di dalam masa tayang. Beranda hanya dapat dibuka anggota aktif, sehingga banner ditujukan
kepada anggota yang sudah bergabung. Ketiga banner menautkan konten di dalam aplikasi, bukan halaman toko.

Ingat:

- Judul banner ditulis aplikasi di atas gambar (putih, maksimal 2 baris) dan dibacakan pembaca layar. Ketiga judul
  di bawah dibuat 60 karakter atau kurang agar muat 2 baris di ponsel kecil.
- Urutan tampil memakai jarak 10 agar banner baru dapat disisipkan di antaranya.
- Pada formulir, isian **Mulai tayang** wajib dan diketik dalam WIB. **Selesai tayang** harus setelah Mulai tayang.

### Banner 1: Ajak alumni bergabung di KAPDH Apps

**Judul banner** (wajib, 1-120 karakter)

```text
Ajak Sahabat Alumni Bergabung di KAPDH Apps
```

Panjang: 43 karakter

**Gambar banner:** lihat Aset gambar (wajib).

**Tujuan saat banner diketuk:** `Berita`. Pada **Berita tujuan**, ketik judul lalu pilih
"KAPDH Apps Resmi Hadir: Wadah Digital Silaturahmi Alumni Darel Hikmah" (Berita 1).

**Urutan tampil:** `10`

**Mulai tayang:** `[ISI: tanggal dan jam WIB]` (usulan: sama dengan waktu terbit Berita 1)

**Selesai tayang:** `[ISI: tanggal dan jam WIB]` (usulan: 30 hari setelah Mulai tayang, atau dikosongkan bila
tanpa batas)

**Aktif:** Ya

**Aset gambar:** 1760 x 800 px (2,2:1), JPG, maksimal 5 MB. Latar gradien KTA (`#020702` ke `#0E280C` ke
`#215E1E`, 135 derajat). Di sepertiga kanan atas (x 1180-1700, y 40-460), ilustrasi tiga ponsel berdiri berjajar
yang masing-masing menampilkan avatar siluet alumni, dihubungkan garis lengkung emas `#E6D312` sebagai lambang
silaturahmi. Logo KAPDH berwarna krem `#FCF8F5` di kiri atas (x 64, y 64, lebar sekitar 200 px). Pita bawah selebar
penuh (y 460-800) dibiarkan polos gelap untuk judul. Tanpa tombol toko, tanpa tulisan "Unduh", dan tanpa teks lain.
Berkas: `docs/konten/gambar/banner-1-gabung.jpg`.

---

### Banner 2: KTA digital, iuran, dan perpanjangan

**Judul banner** (wajib, 1-120 karakter)

```text
Panduan Iuran dan Perpanjangan KTA Digital
```

Panjang: 42 karakter

**Gambar banner:** lihat Aset gambar (wajib).

**Tujuan saat banner diketuk:** `Berita`. Pada **Berita tujuan**, pilih "Panduan Iuran Keanggotaan dan KTA
Digital: Pembayaran, Verifikasi, dan Perpanjangan" (Berita 3).

**Urutan tampil:** `20`

**Mulai tayang:** `[ISI: tanggal dan jam WIB]` (usulan: sama dengan waktu terbit Berita 3)

**Selesai tayang:** kosongkan (tanpa batas). Panduan ini berlaku sepanjang tahun dan berguna bagi anggota yang
masanya Segera Berakhir.

**Aktif:** Ya

**Aset gambar:** 1760 x 800 px (2,2:1), JPG, maksimal 5 MB. Latar hijau utama `#1A4B17` dengan gradasi ke
`#215E1E` di kanan. Di kanan atas (x 1100-1680, y 40-450), kartu KTA digital miring 8 derajat bergradien KTA dengan
garis aksen emas `#E6D312`, teks samaran "NAMA ANGGOTA", lencana "KTA Aktif", dan ikon QR bergaya garis yang tidak
dapat dipindai. Di belakang kartu, lingkaran emas pucat `#FBF6C9` dengan opasitas 25%. Pita bawah selebar penuh
(y 460-800) dibiarkan polos untuk judul. Tanpa nominal, nomor rekening, atau gambar QRIS.
Berkas: `docs/konten/gambar/banner-2-iuran-kta.jpg`.

---

### Banner 3: Lengkapi profil dan ikuti Temu Jejaring

**Judul banner** (wajib, 1-120 karakter)

```text
Lengkapi Profil dan Ikuti Temu Jejaring Alumni
```

Panjang: 46 karakter

**Gambar banner:** lihat Aset gambar (wajib).

**Tujuan saat banner diketuk:** `Event`. Pada **Event tujuan**, ketik judul lalu pilih "Temu Jejaring Alumni
Lintas Profesi" (Event 3). Admin tanpa izin `events.manage` menempel ID event di **ID event tujuan** (ID tampil di alamat
halaman detail event, `/events/<ID>`).

**Urutan tampil:** `30`

**Mulai tayang:** `[ISI: tanggal dan jam WIB]` (usulan: H+7, setelah Event 3 diterbitkan)

**Selesai tayang:** `[ISI: tanggal dan jam WIB]` (usulan: sama dengan **Tutup daftar** Event 3, dan tidak boleh
melewati **Selesai** Event 3. Setelah event berakhir, banner yang masih tayang menampilkan "Konten tujuan sudah
tidak tersedia".)

**Aktif:** Ya

**Aset gambar:** 1760 x 800 px (2,2:1), JPG, maksimal 5 MB. Latar `#0E280C`. Di setengah kanan atas (x 900-1700,
y 40-450), jaringan enam lingkaran avatar ilustrasi siluet (tanpa wajah nyata) berbingkai hijau `#2D7A28`,
dihubungkan garis emas `#E6D312`. Di dalam atau di samping lingkaran terdapat ikon profesi bergaya garis krem
`#FCF8F5`, misalnya tas kerja, laptop, stetoskop, timbangan, dan daun padi. Pita bawah selebar penuh (y 460-800)
dibiarkan polos untuk judul. Tanpa teks.
Berkas: `docs/konten/gambar/banner-3-jejaring.jpg`.

---

## C. Event

Menu: **Manajemen Event & Tiket > Daftar Event > Buat Event Baru**. Event disimpan sebagai draf yang tidak terlihat
anggota, lalu diterbitkan dengan **Terbitkan**. Tombol ini hanya berhasil bila **Tutup daftar** dan **Selesai**
masih di masa depan.

Aturan jadwal: Mulai < Selesai. Buka daftar < Tutup daftar, dan Tutup daftar paling lambat sama dengan Selesai.
Bila check-in diatur sendiri, Tutup check-in paling lambat sama dengan Selesai.

Yang tidak ada di formulir: tipe tiket, jumlah tiket per pesanan, tiket tamu/rombongan, metode bayar per event,
dan isian tautan pertemuan daring. Satu tiket berlaku untuk satu orang, yaitu anggota pemesan. Ringkasan aturan
pembatalan dan refund ditampilkan otomatis oleh aplikasi di bawah setiap event.

Kartu event di aplikasi memotong nama event setelah 2 baris, dan pada ponsel selebar 360 dp kolom judulnya hanya
sekitar 190 dp. Ketiga nama event di bawah diperkirakan muat 2 baris. Bila nama diubah, usahakan tetap di bawah
45 karakter, lalu periksa kartunya di ponsel setelah terbit.

**Susunan acara** di setiap deskripsi adalah usulan. Sesuaikan dengan rundown yang disepakati panitia sebelum event
diterbitkan.

### Event 1: Peluncuran KAPDH Apps dan Silaturahmi Alumni (daring, gratis)

**Informasi Event**

**Nama event** (wajib, 1-200 karakter)

```text
Peluncuran KAPDH Apps dan Silaturahmi Alumni
```

Panjang: 44 karakter

**Kategori:** `Silaturahmi`

**Deskripsi** (opsional, teks polos, maks 5000)

```text
Alhamdulillah, KAPDH Apps kini hadir sebagai wadah digital silaturahmi alumni Pondok Pesantren Darel Hikmah. Mari rayakan peluncurannya bersama dalam pertemuan daring lintas angkatan.

Susunan acara:
- Pembukaan dan tilawah Al-Qur'an
- Sambutan pengurus KAPDH
- Pengenalan KAPDH Apps: KTA digital, Event, Jejaring, Pesan, dan Notifikasi
- Tanya jawab seputar keanggotaan dan penggunaan aplikasi
- Doa dan penutup

Cara mengikuti:
- Ketuk Daftar Sekarang. Event ini gratis, sehingga tiket langsung terbit di Akun > Tiket saya.
- Acara berlangsung daring melalui [ISI: platform, mis. Zoom atau Google Meet]. Tautan untuk bergabung diumumkan pengurus melalui berita di Beranda aplikasi paling lambat [ISI: waktu] (usulan: H-1 pukul 20.00 WIB).
- Acara daring ini tidak memakai check-in dengan kode QR.
- Tiket berlaku untuk Anda sendiri. Bila berhalangan, batalkan tiket sebelum acara dimulai agar kursi dapat dipakai anggota lain. Event gratis tidak memiliki refund.

Mari jaga adab selama pertemuan sesuai Ketentuan Komunitas KAPDH. Pertanyaan seputar acara dapat dikirim ke bantuan@kapdh.or.id.
```

Panjang: 1094 karakter

**Gambar cover:** lihat Aset gambar.

**Lokasi**

- **Nama lokasi** (maks 200):

  ```text
  Daring melalui [ISI: platform, mis. Zoom atau Google Meet]
  ```

- **Alamat:** kosongkan.
- **Tautan peta:** kosongkan. Isian ini tampil di aplikasi sebagai "Buka peta lokasi (tautan luar)", jadi jangan
  diisi tautan pertemuan.

**Jadwal**

- **Zona waktu event:** WIB (Asia/Jakarta)
- **Mulai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: Sabtu malam, 1-2 pekan setelah H, pukul 20.00 WIB)
- **Selesai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: pukul 21.30 WIB pada hari yang sama)

**Periode Pendaftaran**

- **Buka daftar:** `[ISI]` (usulan: saat event diterbitkan, H-1)
- **Tutup daftar:** `[ISI]` (usulan: 1 jam sebelum Mulai, mis. 19.00 WIB)

**Check-in:** sakelar **Atur jendela check-in sendiri** dibiarkan mati (bawaan: dibuka 2 jam sebelum mulai sampai
event selesai). Petugas tidak perlu memindai tiket untuk acara daring.

**Harga dan Kuota**

- **Harga tiket:** `0` (gratis; tiket langsung lunas tanpa pembayaran)
- **Total tiket (kuota):** `[ISI: angka 1-100000]` (usulan: sama dengan kapasitas peserta ruang pertemuan yang
  dipakai)

**Aset gambar:** 1600 x 900 px, JPG, maksimal 5 MB. Latar gradien `#0E280C` ke `#215E1E`. Di tengah (di dalam
x 255-1345), ponsel tegak dengan layar menampilkan logo KAPDH di atas latar krem `#FCF8F5`, dikelilingi cincin emas
`#E6D312` dan percikan ornamen bintang delapan berwarna emas pucat `#FBF6C9`. Di kiri dan kanan ponsel, siluet
tangan memegang ponsel lain yang menampilkan kotak video pertemuan berisi avatar ilustrasi, sebagai tanda acara
daring. Tanpa teks selain logo.
Berkas: `docs/konten/gambar/event-1-peluncuran.jpg`.

---

### Event 2: Halal Bihalal dan Silaturahmi Akbar Alumni (luring, Pekanbaru)

**Informasi Event**

**Nama event** (wajib, 1-200 karakter)

```text
Halal Bihalal dan Silaturahmi Akbar Alumni
```

Panjang: 42 karakter

Bila acara tidak diadakan pada bulan Syawal, pakai judul `Silaturahmi Akbar Alumni KAPDH` dan hapus kata "Halal
Bihalal" serta acara saling bermaafan dari deskripsi.

**Kategori:** `Silaturahmi`

**Deskripsi** (opsional, teks polos, maks 5000). Pilih **satu** paragraf pembayaran: varian A bila harga tiket
lebih dari 0, varian B bila gratis. Hapus varian yang tidak dipakai beserta judul variannya.

```text
Mari pererat silaturahmi lintas angkatan dalam Halal Bihalal dan Silaturahmi Akbar Alumni Pondok Pesantren Darel Hikmah. Inilah kesempatan untuk bertemu kembali dengan sahabat seangkatan dan keluarga besar alumni, saling bermaafan, serta meneguhkan ukhuwah Islamiah.

Susunan acara:
- Registrasi dan check-in peserta
- Pembukaan dan tilawah Al-Qur'an
- Sambutan pengurus KAPDH
- Tausiyah halal bihalal oleh [ISI: nama penceramah, setelah yang bersangkutan bersedia]
- Saling bermaafan dan ramah tamah
- Doa dan penutup

Tiket dan check-in:
- Setiap tiket berlaku untuk satu orang, yaitu anggota yang mendaftar. Tidak ada tiket rombongan atau tamu, dan tiket tidak dapat dipindahtangankan.
- Tunjukkan kode QR tiket dari Akun > Tiket saya kepada petugas check-in. Satu QR hanya dapat dipindai satu kali, jadi jangan bagikan QR Anda kepada orang lain.
- Untuk mencocokkan identitas, petugas check-in dapat melihat nama, nomor anggota, dan foto pemegang tiket.
- Jadwal check-in tercantum di halaman ini.

[VARIAN A, EVENT BERBAYAR]
Pendaftaran dan pembayaran:
- Ketuk Daftar Sekarang, pilih tujuan pembayaran, lalu ketuk Daftar dan Lanjut Bayar.
- Bayar hanya ke tujuan resmi yang tampil pada instruksi pembayaran di aplikasi, lalu unggah bukti sebelum batas waktu yang tertera. Reservasi tanpa bukti berakhir otomatis dan kursinya dilepas untuk anggota lain.
- Tiket berkode QR terbit setelah pengurus memverifikasi pembayaran Anda.
- Jangan mentransfer ke rekening yang dikirim melalui pesan pribadi, walaupun mengatasnamakan panitia atau pengurus.
- Harga tiket dipakai untuk [ISI: peruntukan, mis. konsumsi dan perlengkapan acara].
- Tiket berbayar yang Anda batalkan sendiri paling lambat H-3, yaitu 72 jam sebelum acara dimulai, mendapat refund penuh. Setelah batas itu, pembatalan masih dapat dilakukan sebelum acara dimulai, tetapi tanpa refund. Refund ditransfer bendahara paling lambat 7 hari kerja. Rinciannya ada di bagian Pembatalan dan refund di halaman ini.

[VARIAN B, EVENT GRATIS]
Pendaftaran:
- Ketuk Daftar Sekarang. Tiket berkode QR langsung terbit tanpa pembayaran.
- Bila berhalangan, batalkan tiket sebelum acara dimulai agar kursi dapat dipakai anggota lain. Event gratis tidak memiliki refund.

Lokasi acara dapat dibuka melalui tautan peta di halaman ini. Pertanyaan seputar acara dapat dikirim ke bantuan@kapdh.or.id.
```

Panjang (dengan kedua varian): 2343 karakter

**Gambar cover:** lihat Aset gambar.

**Lokasi**

- **Nama lokasi** (maks 200): `[ISI: nama tempat]` (usulan: Aula Pondok Pesantren Darel Hikmah, bila disetujui
  pihak pesantren)
- **Alamat** (maks 500): `[ISI: alamat lengkap tempat acara], Pekanbaru, Riau`
- **Tautan peta** (maks 500, wajib diawali https://): `[ISI: tautan Google Maps lokasi, mis. https://maps.app.goo.gl/...]`

**Jadwal**

- **Zona waktu event:** WIB (Asia/Jakarta)
- **Mulai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: Ahad pagi pada bulan Syawal, pukul 08.00 WIB)
- **Selesai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: pukul 12.00 WIB pada hari yang sama)

**Periode Pendaftaran**

- **Buka daftar:** `[ISI]` (usulan: saat event diterbitkan, H-1)
- **Tutup daftar:** `[ISI]` (usulan: 4 hari sebelum Mulai pukul 23.59 WIB, agar bendahara sempat memverifikasi
  bukti sebelum hari acara dan panitia sempat menyiapkan konsumsi)

**Check-in:** sakelar **Atur jendela check-in sendiri** dibiarkan mati (bawaan: dibuka 2 jam sebelum mulai sampai
event selesai). Bila panitia ingin check-in dibuka lebih singkat, nyalakan sakelar lalu isi **Buka check-in**
`[ISI]` dan **Tutup check-in** `[ISI]` (Tutup check-in paling lambat sama dengan Selesai).

**Harga dan Kuota**

- **Harga tiket:** `[ISI: harga]`. Isi `0` bila gratis. Bila berbayar, nominal ditetapkan pengurus, dan formulir
  menerima ketikan Rupiah seperti `50.000` (contoh format, bukan usulan nominal).
- **Total tiket (kuota):** `[ISI: angka 1-100000]` (usulan: kapasitas tempat dikurangi kursi untuk panitia dan
  undangan)

**Aset gambar:** 1600 x 900 px, JPG, maksimal 5 MB. Latar krem `#FCF8F5` dengan pola geometris Islami berwarna
`#E3F0E1`. Di tengah (di dalam x 255-1345), ilustrasi datar dua tangan berjabat dengan lengan baju koko hijau
`#1A4B17` dan `#2D7A28`, dikelilingi rangkaian ketupat dan janur bergaris emas `#E6D312`. Di bawahnya, siluet
sederhana kubah dan atap gedung pertemuan berwarna `#0E280C` dengan opasitas 15%. Tanpa wajah nyata dan tanpa teks.
Bila memakai foto acara alumni sebelumnya, pakai foto yang orang-orangnya tidak dapat dikenali atau yang sudah
mendapat izin, lalu letakkan titik fokusnya di tengah.
Berkas: `docs/konten/gambar/event-2-halal-bihalal.jpg`.

---

### Event 3: Temu Jejaring Alumni Lintas Profesi (daring, gratis)

**Informasi Event**

**Nama event** (wajib, 1-200 karakter)

```text
Temu Jejaring Alumni Lintas Profesi
```

Panjang: 35 karakter

**Kategori:** `Jejaring`

**Deskripsi** (opsional, teks polos, maks 5000)

```text
Temu Jejaring Alumni adalah ruang silaturahmi bagi alumni lintas angkatan untuk saling berbagi pengalaman di bidang profesi masing-masing, sejalan dengan tujuan KAPDH memberdayakan potensi anggota serta mempererat solidaritas dan ukhuwah Islamiah.

Tema: [ISI: tema sesi, mis. "Merintis Karier dan Usaha dari Rantau"]
Alumni yang berbagi: [ISI: nama, angkatan, dan bidang profesi, setelah yang bersangkutan setuju namanya dicantumkan]

Susunan acara:
- Pembukaan
- Sesi berbagi pengalaman dari alumni
- Diskusi dan tanya jawab
- Sesi saling mengenal per bidang profesi
- Penutup

Sebelum acara:
- Lengkapi profesi dan keahlian di Akun > Ubah profil agar sahabat alumni dapat menemukan Anda di Jejaring.
- Atur data yang ingin Anda tampilkan di Akun > Privasi profil. Nomor telepon, email, dan media sosial tetap tersembunyi sampai Anda sendiri menampilkannya.
- Daftar peserta di halaman ini menampilkan nama, angkatan, dan foto peserta terkonfirmasi yang tampil di direktori Jejaring.

Cara mengikuti:
- Ketuk Daftar Sekarang. Event ini gratis, sehingga tiket langsung terbit di Akun > Tiket saya.
- Acara berlangsung daring melalui [ISI: platform, mis. Zoom atau Google Meet]. Tautan untuk bergabung diumumkan pengurus melalui berita di Beranda aplikasi paling lambat [ISI: waktu] (usulan: H-1 pukul 20.00 WIB).
- Acara daring ini tidak memakai check-in dengan kode QR.
- Tiket berlaku untuk Anda sendiri. Bila berhalangan, batalkan tiket sebelum acara dimulai agar kursi dapat dipakai anggota lain. Event gratis tidak memiliki refund.

Setelah acara, silaturahmi dapat dilanjutkan melalui Pesan dan Pesan Grup di tab Jejaring. Acara ini adalah forum berbagi pengalaman, bukan forum promosi atau ajakan investasi. KAPDH bukan pihak dalam kesepakatan atau kerja sama antaranggota, sebagaimana diatur dalam Ketentuan Layanan bagian 14. Pertanyaan seputar acara dapat dikirim ke bantuan@kapdh.or.id.
```

Panjang: 1898 karakter

**Gambar cover:** lihat Aset gambar.

**Lokasi**

- **Nama lokasi** (maks 200):

  ```text
  Daring melalui [ISI: platform, mis. Zoom atau Google Meet]
  ```

- **Alamat:** kosongkan.
- **Tautan peta:** kosongkan (lihat Event 1).

**Jadwal**

- **Zona waktu event:** WIB (Asia/Jakarta)
- **Mulai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: Sabtu atau Ahad malam, 3-4 pekan setelah H, pukul
  20.00 WIB)
- **Selesai:** `[ISI: tanggal]` pukul `[ISI: jam]` (usulan: pukul 21.30 WIB pada hari yang sama)

**Periode Pendaftaran**

- **Buka daftar:** `[ISI]` (usulan: saat event diterbitkan, H-1)
- **Tutup daftar:** `[ISI]` (usulan: 1 jam sebelum Mulai)

**Check-in:** sakelar **Atur jendela check-in sendiri** dibiarkan mati. Petugas tidak perlu memindai tiket untuk
acara daring.

**Harga dan Kuota**

- **Harga tiket:** `0` (gratis)
- **Total tiket (kuota):** `[ISI: angka 1-100000]` (usulan: sama dengan kapasitas peserta ruang pertemuan yang
  dipakai)

**Aset gambar:** 1600 x 900 px, JPG, maksimal 5 MB. Latar `#0E280C` dengan gradasi ke `#1A4B17` di bawah. Di tengah
(di dalam x 255-1345), jaringan tujuh lingkaran avatar ilustrasi siluet (tanpa wajah nyata) berbingkai hijau
`#2D7A28`, dihubungkan garis emas `#E6D312`. Lingkaran pusat sedikit lebih besar dan memuat logo KAPDH. Di sekitar
jaringan terdapat ikon profesi bergaya garis krem `#FCF8F5`: tas kerja, laptop, stetoskop, timbangan, helm proyek,
dan daun padi. Tanpa teks.
Berkas: `docs/konten/gambar/event-3-temu-jejaring.jpg`.

---

## Catatan operasional

1. **Tautan pertemuan untuk Event 1 dan Event 3.** Formulir event tidak memiliki isian tautan daring. Deskripsi
   adalah teks polos yang tautannya tidak dapat diketuk, dan isian Tautan peta tampil sebagai "Buka peta lokasi".
   Karena itu, umumkan tautan melalui berita singkat (kategori Pengumuman) paling lambat H-1 sebelum acara. Isinya
   cukup nama acara, jadwal, dan tautan `https://` ke ruang pertemuan. Berita itu memicu satu notifikasi ke semua
   anggota aktif, sehingga sekaligus menjadi pengingat. Tautannya terlihat oleh semua anggota aktif, bukan hanya
   peserta terdaftar. Bila jumlah peserta perlu dibatasi, gunakan ruang tunggu di platform pertemuan, lalu cocokkan
   nama dengan tab **Peserta & Tiket** pada halaman detail event di web admin.
2. **Event daring harus tetap gratis.** Tiket berbayar hanya untuk acara tatap muka (D13, catatan peninjau toko).
   Event daring berbayar berisiko ditolak toko aplikasi. Catatan untuk peninjau di `app-store-submission.md`
   menyebut tiket event untuk acara tatap muka. Bila Event 1 atau Event 3 masih tampil saat versi aplikasi berikutnya
   diajukan, tambahkan keterangan bahwa event daring selalu gratis dan tanpa pembayaran.
3. **Menerbitkan event tidak mengirim notifikasi.** Promosikan event lewat Berita 1 (agenda), Banner 3, dan berita
   tautan pada catatan 1. Perubahan jadwal atau lokasi setelah terbit memberi notifikasi kepada pemegang tiket dan
   menjadwalkan ulang pengingat H-3 dan H-1.
4. **Event 2 berbayar:** sebelum terbit, pastikan tujuan pembayaran resmi aktif di **Verifikasi Pembayaran > tab
   Kelola Metode**. Anggota memilih salah satu metode aktif itu saat mendaftar. Jangan menulis nomor
   rekening atau QRIS di deskripsi. Bila setelah terbit ada perubahan harga, harga baru hanya berlaku untuk
   reservasi baru.
5. **Rencana cadangan iOS (D13).** Bila Pengaturan > Pengaturan Aplikasi > kartu **Instruksi bayar iuran per
   platform** > "Sembunyikan instruksi iuran di" dicentang untuk iOS, anggota
   iOS tidak melihat instruksi iuran di aplikasi. Berita 3 sudah memuat butir "Iuran melalui pengurus". Tinjau ulang
   Berita 3 dan Banner 2 bersama PP, lalu arsipkan bila diminta peninjau Apple.
6. **Kata yang dihindari** di semua konten (aturan teks D13 dan Ketentuan Layanan): "beli", "langganan", "premium",
   "upgrade", "terkunci", "membuka fitur", dan "mengaktifkan KTA atau fitur". Status keanggotaan ditulis sebagai
   status organisasi. Konten ini sudah diperiksa terhadap daftar tersebut. Satu-satunya kemunculan "pembelian"
   adalah kalimat penegasan dari Ketentuan Layanan bahwa iuran bukan pembelian (Berita 3).
7. **Pembaca berita dan banner adalah anggota aktif.** Beranda, berita, dan banner hanya dapat dibuka anggota aktif
   (verified/expiring). Berita 1 dan Berita 3 ditulis agar anggota dapat membantu sahabat alumni yang belum
   bergabung. Calon anggota memperoleh informasi dari situs (`/unduh`, `/bantuan`, `/tentang`).
8. **Setelah terbit:** periksa tampilan di aplikasi Android dan iOS, yaitu kartu Beranda, detail berita, tautan
   luar (harus meminta konfirmasi), banner (ketuk dan pastikan tujuan terbuka), serta kartu dan detail event
   (cover, jadwal, kotak Pembatalan dan refund).
9. **Bila `self_cancel_days` diubah** dari 3, perbarui varian A deskripsi Event 2 dan terbitkan ulang Ketentuan
   Layanan serta Bantuan.
