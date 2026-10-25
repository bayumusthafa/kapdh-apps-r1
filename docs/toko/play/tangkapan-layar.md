# Rencana tangkapan layar ponsel Google Play

Status 25 Oktober 2026: **rencana dan skrip siap, gambar belum diambil.** Pengambilan menunggu build rilis, akun demo,
dan data bersih (di bawah). Hasilnya juga draf yang wajib disahkan PP sebelum diunggah.

## Syarat Play

Sumber: Play Console Help "Add preview assets to showcase your app" (diperiksa 25 Oktober 2026).

- 2-8 gambar per jenis perangkat; JPEG atau PNG 24-bit **tanpa alfa**.
- Setiap sisi 320-3840 px, sisi panjang paling banyak 2x sisi pendek.
- Agar layak tampil di rekomendasi dan promosi: minimal 4 gambar potret **9:16, minimal 1080 x 1920 px**.
- Tunjukkan tampilan aplikasi yang sebenarnya, utamakan UI di tiga gambar pertama, status bar bersih (tanpa ikon
  notifikasi; baterai dan sinyal penuh), tanpa klaim peringkat, harga, promosi, atau ajakan "unduh sekarang". Setiap
  gambar diberi teks alternatif maksimal 140 karakter.

Tangkapan di `docs/panduan/sumber/gambar/mobile` **tidak dapat dipakai**: ukurannya 720 x 1602 (rasio 2,225:1, lebih
dari 2:1) dan dibuat dari mockup HTML, bukan dari aplikasi.

## Target: 6 gambar PNG 1080 x 1920

| No | Berkas | Layar | Deep link | Yang harus tampak |
| -- | ------ | ----- | --------- | ----------------- |
| 1 | `01-beranda.png` | Beranda | `kapdh://app/home` | Banner peluncuran (Banner 1 di slide pertama), pintasan, Berita Terbaru, Event Mendatang |
| 2 | `02-kta.png` | KTA | `kapdh://app/kta` | KTA Aktif akun demo; **kode QR diburamkan otomatis** |
| 3 | `03-event.png` | Detail event | `kapdh://app/events/<EVENT_ID>` | Event berstatus buka: jadwal, lokasi, Kuota Peserta, tombol Daftar Sekarang |
| 4 | `04-berita.png` | Detail berita | `kapdh://app/news/kapdh-apps-resmi-hadir` | Berita 1 konten peluncuran beserta gambarnya |
| 5 | `05-jejaring.png` | Jejaring | `kapdh://app/network` | Direktori dengan minimal 4 persona demo lengkap (angkatan, kota, profesi) |
| 6 | `06-pesan.png` | Percakapan | `kapdh://app/chat/<CHAT_ROOM_ID>` | Percakapan Demo A dengan Demo C: teks sopan, satu foto, balasan, reaksi |

Urutan menaruh UI utama (Beranda, KTA, event) di tiga gambar pertama. Teks alternatif ada di
`teks/alt-tangkapan.txt`. Gambar tanpa bingkai perangkat atau teks tambahan; bila PP kelak ingin tagline di atas
gambar, batasnya 20% tinggi gambar dan teksnya diperiksa `cek.mjs`.

## Data dan akun

Gambar toko bersifat publik, jadi tidak boleh memuat data alumni sungguhan tanpa persetujuan tertulis.

- **Lingkungan.** Pakai staging yang disiapkan seperti production (`docs/runbooks/staging-setup.md`, inisialisasi
  seperti `production-init.md`) **tanpa** seed pengembangan `kapdh-platform/packages/database/seeds/dev.ts`, karena
  seed itu menandai semua datanya "[Contoh]". Production hanya boleh dipakai bila setiap orang yang tampil di
  Jejaring, daftar peserta, dan pesan adalah akun demo.
- **Akun.** Demo A (aktif) untuk mengambil gambar, Demo C (aktif) sebagai lawan bicara, dan 3-4 persona demo aktif
  lain dengan nama fiktif yang disetujui PP (dicek tidak sama dengan alumni sungguhan), profil lengkap, dan
  `Tampil di direktori` aktif. Foto profil: ilustrasi atau tanpa foto, bukan foto orang sungguhan. Privasi profil
  Demo A: nomor telepon dan email tidak ditampilkan.
- **Konten.** Terbitkan konten peluncuran dari `docs/konten/konten-peluncuran.md` (Berita 1-3, Banner 1-3, Event 1-3)
  dengan gambar di `docs/konten/gambar/`. Untuk layar event pilih Event 1 atau Event 2 yang masih buka pendaftarannya.

## Yang tidak boleh tampak

| Larangan | Penjaga |
| -------- | ------- |
| Data contoh "[Contoh]" | `olah-tangkapan.mjs` menolak bila teks layar memuatnya |
| QR yang dapat dipindai (KTA, tiket) | QR KTA dicari dari label semantik `QR verifikasi KTA` lalu diburamkan; layar KTA ditolak bila QR tidak ditemukan. Layar tiket tidak diambil |
| Layar gembok, "khusus anggota aktif", atau status belum aktif | Ditolak otomatis; Demo A harus aktif |
| Instruksi pembayaran (rekening, QRIS, tujuan pembayaran, bukti transfer) | Ditolak otomatis; jangan ambil layar iuran atau pembayaran |
| Kata D13 | Ditolak otomatis (pola yang sama dengan `cek.mjs`) |
| Banner DEBUG, notifikasi sistem, tema gelap | Skrip menolak build debug/profile, menyalakan demo mode status bar, dan memaksa tema terang |
| Email atau nomor telepon pribadi | Periksa manual (privasi profil Demo A dan persona) |

Penjaga otomatis membaca teks dari pohon aksesibilitas (`uiautomator dump`). Teks di dalam gambar (misalnya banner)
tidak terbaca, jadi tetap tinjau setiap gambar dengan mata.

## Langkah

1. Siapkan data dan akun di atas.
2. Bangun APK rilis yang mengarah ke lingkungan itu (Flutter di mesin ini: `C:\flutter\flutter\bin`). Build untuk
   tangkapan tidak diunggah, jadi tanda tangan kunci debug tidak masalah, tetapi harus mode rilis:

   ```sh
   cd kapdh-mobile
   flutter build apk --release --dart-define-from-file=<berkas konfigurasi lingkungan>
   ```

3. Nyalakan emulator dengan jendela agar dapat login (AVD `Pixel_8`, 1080 x 2400, 420 dpi; skrip sendiri yang
   mengubah layar ke 1080 x 1920), lalu pasang APK:

   ```sh
   emulator -avd Pixel_8 -no-audio -no-snapshot-save
   adb install -r build/app/outputs/flutter-apk/app-release.apk
   ```

4. Buka aplikasi, masuk dengan Demo A (sandi diketik operator dari password manager organisasi), jawab izin
   notifikasi, dan tunggu KTA tersinkron. Pastikan tidak ada dialog atau snackbar yang tertinggal.
5. Ambil semua layar dari akar repo (butuh `pnpm install` di `kapdh-platform` untuk sharp):

   ```sh
   EVENT_ID=<id event> BERITA_SLUG=kapdh-apps-resmi-hadir bash docs/toko/play/sumber/ambil-tangkapan.sh
   ```

   `EVENT_ID` diambil dari alamat halaman event di web admin. Tanpa `CHAT_ROOM_ID`, skrip membuka tab Jejaring lalu
   menunggu Enter setelah percakapan Demo C dibuka dengan tangan. `MANUAL=1` memberi jeda yang sama di setiap layar
   (misalnya untuk menggulir). Ulangi satu layar saja dengan menyebut namanya, misalnya `... ambil-tangkapan.sh kta`.
6. Tinjau keenam gambar di `docs/toko/play/tangkapan/`, lalu jalankan pemeriksaan akhir:

   ```sh
   node docs/toko/play/sumber/cek.mjs --wajib-tangkapan
   ```

7. Setelah disahkan PP, commit gambar ke `docs/toko/play/tangkapan/` dan unggah ke Play Console (Main store listing →
   Phone screenshots) sesuai urutan nomor, dengan teks alternatif dari `teks/alt-tangkapan.txt`.

## Yang dilakukan skrip

`sumber/ambil-tangkapan.sh` memeriksa perangkat dan paket (menolak build debuggable), mengubah layar ke 1080 x 1920
dengan density 420, memaksa tema terang dan skala huruf 1.0, menyalakan demo mode status bar (jam 09.00, Wi-Fi dan
baterai penuh, ikon seluler dan notifikasi disembunyikan), lalu untuk setiap layar membangunkan layar, membuka deep
link, menunggu `JEDA` detik, mengambil `screencap`, dan membaca `uiautomator dump`. `sumber/olah-tangkapan.mjs`
mengubah hasil RGBA menjadi PNG 24-bit sRGB, memburamkan kotak QR, menjalankan penjaga di atas, dan menolak gambar
yang hampir polos (layar tidur). Semua pengaturan perangkat dikembalikan saat skrip selesai atau gagal.

Uji 25 Oktober 2026 di emulator Pixel_8 (Android 15) dengan APK rilis 7ce1ed8 tanpa login: deep link, ukuran 1080 x
1920, demo mode, keluaran PNG 3 kanal, penolakan layar KTA tanpa QR, lewati layar pesan tanpa terminal interaktif,
dan pemulihan pengaturan berjalan. Pemburaman QR dan penolakan "[Contoh]", instruksi rekening, dan teks gembok diuji
dengan dump UI tiruan; penolakan gambar polos diuji dengan gambar hitam 1080 x 1920. Pengambilan dengan akun demo yang
sudah login belum dilakukan.
