# Sumber gambar konten peluncuran

Kesembilan gambar di folder induk dibuat oleh `generate.mjs`: setiap gambar disusun sebagai SVG lalu dirender dengan
sharp ke JPG sRGB (kualitas 82, progresif, tanpa EXIF). Skrip juga memeriksa ukuran, format, batas 1 MB, dan area aman
(margin 64 px berita, y 40-460 banner, x 255-1345 event), lalu menulis pratinjau potongan seperti di aplikasi.

Path di skrip (sharp dari store pnpm, folder keluaran dan pratinjau) bersifat absolut untuk mesin build ini; sesuaikan
sebelum dijalankan di tempat lain. Arahan visual tiap gambar ada di `docs/konten/konten-peluncuran.md` (baris
"Aset gambar").
