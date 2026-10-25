# Aset listing Google Play: KAPDH (`id.or.kapdh.app`)

Status: **ikon, feature graphic, teks, kategori dan tag disahkan PP 25 Oktober 2026** (bagian Pengesahan PP di
bawah). Tangkapan layar belum diambil dan wajib disahkan PP setelah dibuat. Ringkasan dan statusnya juga dicatat di
`docs/runbooks/app-store-submission.md` bagian 1.

| Berkas | Isi | Status |
| ------ | --- | ------ |
| `ikon-512.png` | Ikon hi-res 512 x 512 | Disahkan PP 25 Oktober 2026 |
| `feature-graphic-1024x500.jpg` | Feature graphic 1024 x 500 | Disahkan PP 25 Oktober 2026 |
| `teks/` | Judul, deskripsi singkat, deskripsi lengkap, teks alternatif | Disahkan PP 25 Oktober 2026, kecuali `alt-tangkapan.txt` (menunggu tangkapan layar) |
| `listing.md` | Hitungan karakter, alasan isi, pemeriksaan D13, kategori dan tag | Disahkan PP 25 Oktober 2026 |
| `tangkapan-layar.md` | Rencana dan prosedur 6 tangkapan layar 1080 x 1920 | Rencana; gambar belum diambil |
| `tangkapan/` | Hasil tangkapan layar (dibuat skrip) | Belum ada |
| `sumber/` | `generate.mjs`, `cek.mjs`, `ambil-tangkapan.sh`, `olah-tangkapan.mjs` | |

## Pengesahan PP

Disahkan pemilik produk (PP) pada 25 Oktober 2026: ikon, feature graphic, judul, deskripsi singkat, deskripsi
lengkap, teks alternatif feature graphic, serta kategori dan tag di `listing.md`. Pengesahan berlaku untuk isi berkas
dengan sidik SHA-256 di bawah. Bila berkas diubah, sidiknya berubah dan berkas itu wajib disahkan ulang sebelum
diunggah. Tangkapan layar dan `teks/alt-tangkapan.txt` belum termasuk; keduanya disahkan setelah gambar diambil.

| Berkas | SHA-256 |
| ------ | ------- |
| `ikon-512.png` | `0d36ece7dd51e175c01cd0c5fa865471f7f865a2c0f98f8aaf59fffe35abdbbd` |
| `feature-graphic-1024x500.jpg` | `109a367bcd4502c7094b4a81970872b992020d2d5f151f3875b22dfa4a2f2c57` |
| `teks/judul.txt` | `e6d8a167b1de2b428f6afaa0ed93a5c71ae89a4bdde1de12b13700fad2f8ce22` |
| `teks/deskripsi-singkat.txt` | `6be02bab56f95c1625746db28fadb5744faa2f71dd686f1a99de121fd2ce56a1` |
| `teks/deskripsi-lengkap.txt` | `18580d76befb952a7952ae8e81f5b2b686d8efed7b1b4ee08a9e6e2c091412a8` |
| `teks/alt-feature-graphic.txt` | `3cbd5f82bb0be9208dc42f04652e110276ce9aa56cb3cf8f155d07b1a625e253` |

Periksa sebelum mengunggah (dari root repo): `sha256sum docs/toko/play/ikon-512.png ...` harus sama dengan tabel ini.

## Hasil verifikasi

`node docs/toko/play/sumber/cek.mjs` (25 Oktober 2026). Batas dari Play Console Help "Add preview assets to showcase
your app".

| Aset | Syarat Play | Hasil |
| ---- | ----------- | ----- |
| Ikon | PNG 32-bit (dengan alfa), 512 x 512, maks 1.024 KB | PNG 512 x 512, 4 kanal (RGBA 32-bit), alfa penuh tanpa piksel transparan, sRGB, 186,3 KB |
| Feature graphic | JPEG atau PNG 24-bit tanpa alfa, 1024 x 500 | JPEG 1024 x 500, 3 kanal (24-bit), sRGB dengan profil ICC, tanpa alfa dan EXIF, 91,5 KB |
| Judul | maks 30 karakter | 5 ("KAPDH", dipilih PP) |
| Deskripsi singkat | maks 80 | 70 |
| Deskripsi lengkap | maks 4.000 (target tugas 1.500-2.500) | 2.292 |
| Teks alternatif | maks 140 | feature graphic 125; tangkapan 60-96 |
| Kata D13 dan klaim | tanpa temuan | tanpa temuan |

## Ikon

Diturunkan dari `kapdh-mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png` (lanczos3),
sumber beresolusi tertinggi; logo resmi di repo hanya 360 x 350. Latar `#0E280C` (surface-dark) sama dengan latar
ikon adaptif Android, jadi ikon toko serupa dengan ikon peluncur. Berkas persegi penuh tanpa sudut membulat karena Play
memasang topeng sudut dan bayangan sendiri. Pratinjau topeng sudut membulat dan lingkaran dibuat di folder kerja
(`ikon-512-topeng.png`): pita logo tetap utuh di kedua topeng.

## Feature graphic

- Latar gradien hijau `#1A4B17` ke `#215E1E` dengan pola bintang delapan emas tipis di sisi kanan, sesuai palet di
  `docs/konten/konten-peluncuran.md`. Tidak memakai hitam atau abu gelap agar tidak menyatu dengan latar Play.
- Kiri: logo pada lencana krem bergaris emas, "KAPDH", "Keluarga Alumni Pesantren Darel Hikmah", garis emas, dan
  tagline **"Wadah digital silaturahmi alumni"** (Poppins). Tanpa kata D13, tanpa klaim peringkat atau harga.
- Kanan: ilustrasi jejaring anggota tanpa wajah dengan lencana profesi, diadaptasi dari banner-3-jejaring. Ilustrasi
  ponsel dari banner-1 tidak dipakai karena panduan Play meminta feature graphic tanpa gambar perangkat.
- Semua elemen penting berada di area aman x 64-960, y 48-452 (diperiksa `generate.mjs` dari kotak tinta tiap
  lapisan): logo dan ilustrasi x 72-940, y 66-427; teks x 72-493, y 92-383.

## Membuat ulang dan memeriksa

Dari akar repo, setelah `pnpm install` di `kapdh-platform` (sharp diambil dari dependensi `@kapdh/api`):

```sh
node docs/toko/play/sumber/generate.mjs       # menulis ikon dan feature graphic, lalu memeriksa keduanya
node docs/toko/play/sumber/cek.mjs            # gambar, teks, dan tangkapan layar bila sudah ada
node docs/toko/play/sumber/cek.mjs --wajib-tangkapan   # sebelum unggah: tangkapan layar juga wajib lengkap
```

`TOKO_KELUARAN` mengganti folder keluaran generator (bawaan folder ini) dan `TOKO_KERJA` mengganti folder pratinjau
(bawaan `kapdh-toko-play` di folder sementara OS). Pratinjau berisi feature graphic dengan garis area aman dan ikon
dengan topeng Play.

## Pengisian di Play Console

| Play Console | Berkas |
| ------------ | ------ |
| Grow users → Store presence → Main store listing → App details | `teks/judul.txt`, `teks/deskripsi-singkat.txt`, `teks/deskripsi-lengkap.txt` |
| Main store listing → Graphics → App icon | `ikon-512.png` |
| Main store listing → Graphics → Feature graphic | `feature-graphic-1024x500.jpg`, teks alternatif `teks/alt-feature-graphic.txt` |
| Main store listing → Graphics → Phone screenshots | `tangkapan/01-*.png` sampai `06-*.png`, teks alternatif `teks/alt-tangkapan.txt` |
| Store settings → App category | App, Social; tag di `listing.md` |
| Store settings → Store listing contact details | Email `bantuan@kapdh.or.id`, situs `https://kapdh.or.id` |
