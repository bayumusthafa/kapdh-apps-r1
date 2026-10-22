# Panduan Penggunaan dan Presentasi Peluncuran KAPDH Apps

Folder ini berisi dokumen untuk anggota, pengurus, dan acara peluncuran KAPDH Apps rilis 1.0 (Oktober 2026).

| Berkas | Isi |
| ------ | --- |
| `Panduan-Penggunaan-KAPDH-Apps.pdf` | Panduan lengkap A4, 17 bab dalam 4 bagian: aplikasi anggota, web admin pengurus, situs kapdh.or.id, serta tanya jawab dan pemecahan masalah. Berisi daftar isi bernomor halaman dan tangkapan layar. |
| `Presentasi-Peluncuran-KAPDH-Apps.pptx` | Presentasi peluncuran 16:9, 19 slide, lengkap dengan catatan pembicara di setiap slide. Kode QR pada slide ajakan mengarah ke `https://kapdh.or.id/unduh`. |
| `sumber/konten/` | Naskah per bab (`b01.json` ... `b17.json`) dan naskah presentasi (`presentasi.json`). Ubah naskah di sini, lalu bangun ulang. |
| `sumber/gambar/` | Tangkapan layar aplikasi (`mobile/`, dari `kapdh-mobile/mockup-html` dengan teks yang disamakan dengan aplikasi), web admin mode mock (`admin/`), dan situs publik (`web/`). Semua nama, nomor KTA, dan nominal adalah data contoh. |
| `sumber/alat/` | Skrip pembangun PDF dan PPTX, skrip pemotret layar, dan pemeriksa naskah. |

## Catatan isi

- Teks dan angka di panduan dicocokkan dengan kode aplikasi, web admin, API, dan situs pada commit `d1c57d1`
  (termasuk profil berulang: profesi jamak, riwayat pendidikan, media sosial dinamis).
- Teks status keanggotaan mengikuti aturan D13 (`docs/runbooks/app-store-submission.md` bagian 2): iuran ditulis
  sebagai status keanggotaan organisasi, bukan pembuka fitur aplikasi. Pemeriksaan teks D13 juga berlaku untuk naskah
  di `sumber/konten/`.
- Mockup HTML di `kapdh-mobile/mockup-html` masih memuat beberapa teks lama sebelum D13. Tangkapan layar panduan
  dipotret dengan penggantian teks (`shot-mobile.mjs --fix`), jadi gambar di panduan sudah memakai teks aplikasi
  sekarang. Mockup-nya sendiri belum diperbarui.
- Tarif iuran tidak dicantumkan karena ditetapkan pengurus di **Pengaturan** dan dapat berubah.
- Font PDF: Poppins (tertanam). Font presentasi: Segoe UI (tema PowerPoint). Bila Poppins terpasang di komputer
  presentasi, font tema dapat diganti lewat **Desain > Varian > Font**.

## Membangun ulang

Butuh Node 24 dan Google Chrome. PowerPoint (Windows) hanya untuk pemeriksaan visual slide.

```bash
cd docs/panduan/sumber/alat
npm install
node validate.mjs ../konten/b02.json        # periksa satu naskah (struktur, panjang teks, gambar)
node build-pdf.mjs                           # -> docs/panduan/Panduan-Penggunaan-KAPDH-Apps.pdf
node build-pptx.mjs                          # -> docs/panduan/Presentasi-Peluncuran-KAPDH-Apps.pptx
```

- `build-pdf.mjs --png <folder>` juga menyimpan pratinjau setiap halaman sebagai PNG. `--only b02,b03` membangun
  sebagian bab untuk uji tata letak.
- Pratinjau slide (Windows + PowerPoint):
  `powershell -File export-slides.ps1 -Pptx ..\..\Presentasi-Peluncuran-KAPDH-Apps.pptx -OutDir <folder>`.
- Chrome dicari di lokasi bawaan. Lokasi lain dapat diatur lewat variabel lingkungan `CHROME_PATH`.

Format naskah, gaya bahasa, dan batas panjang teks dijelaskan di `sumber/alat/PEDOMAN-KONTEN.md`.

### Memotret ulang layar

```bash
node list-frames.mjs beranda/home.html                         # daftar keadaan (frame) pada satu halaman mockup
node shot-mobile.mjs kta/kta.html 1 b04-kta-aktif \
  --fix '[["Seluruh fitur alumni aktif.","Keanggotaan organisasi aktif."]]'
node shot-admin.mjs payments b10-antrean                       # web admin mode mock di http://localhost:5199
node shot-web.mjs /kta/ b16-verifikasi                          # situs publik (astro dev) di http://localhost:4399
```

Web admin mode mock dijalankan dengan `npx vite --mode mock --port 5199` dari `kapdh-platform/apps/admin`, dan situs
publik dengan `npx astro dev --port 4399` dari `kapdh-platform/apps/web`. Akun mode mock tercantum di README utama.
