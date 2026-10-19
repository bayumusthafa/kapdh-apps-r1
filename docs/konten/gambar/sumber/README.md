# Sumber gambar konten peluncuran

Kesembilan gambar di folder induk dibuat oleh `generate.mjs`: setiap gambar disusun sebagai SVG lalu dirender dengan
sharp ke JPG sRGB (kualitas 82, progresif, tanpa EXIF). Skrip juga memeriksa ukuran, format, batas 1 MB, dan area aman
(margin 64 px berita, y 40-460 banner, x 255-1345 event), lalu menulis pratinjau potongan seperti di aplikasi.

Semua path dihitung dari lokasi skrip, jadi skrip bisa dijalankan dari folder mana pun setelah `pnpm install` di
`kapdh-platform` (sharp diambil dari dependensi `@kapdh/api`). Contoh dari akar repo:

```sh
node docs/konten/gambar/sumber/generate.mjs                  # semua gambar, menimpa JPG di docs/konten/gambar
node docs/konten/gambar/sumber/generate.mjs berita-1 event-2  # sebagian, menurut awalan nama berkas
GAMBAR_KELUARAN=/tmp/gambar node docs/konten/gambar/sumber/generate.mjs  # uji tanpa menimpa gambar ter-commit
```

`GAMBAR_KELUARAN` mengganti folder JPG keluaran (bawaan folder induk). `GAMBAR_KERJA` mengganti folder kerja untuk
`svg/`, `pratinjau/` dan `laporan.json` (bawaan `kapdh-gambar-konten` di folder sementara OS). Arahan visual tiap
gambar ada di `docs/konten/konten-peluncuran.md` (baris "Aset gambar").
