# Aset listing Google Play: KAPDH (`id.or.kapdh.app`)

Status: **draf 25 Oktober 2026. Semua teks dan gambar wajib disahkan PP sebelum diunggah ke Play Console.** Ringkasan
dan statusnya juga dicatat di `docs/runbooks/app-store-submission.md` bagian 1.

| Berkas | Isi | Status |
| ------ | --- | ------ |
| `ikon-512.png` | Ikon hi-res 512 x 512 | Siap, menunggu PP |
| `feature-graphic-1024x500.jpg` | Feature graphic 1024 x 500 | Siap, menunggu PP |
| `teks/` | Judul, deskripsi singkat, deskripsi lengkap, teks alternatif | Draf, lihat `listing.md` |
| `listing.md` | Hitungan karakter, alasan isi, pemeriksaan D13, kategori dan tag | Draf |
| `tangkapan-layar.md` | Rencana dan prosedur 6 tangkapan layar 1080 x 1920 | Rencana; gambar belum diambil |
| `tangkapan/` | Hasil tangkapan layar (dibuat skrip) | Belum ada |
| `sumber/` | `generate.mjs`, `cek.mjs`, `ambil-tangkapan.sh`, `olah-tangkapan.mjs` | |

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
