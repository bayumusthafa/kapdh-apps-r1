# ADR-027: Phosphor sebagai satu-satunya keluarga ikon aplikasi

- Status: Diterima (permintaan pemilik produk, 18 Oktober 2026).
- Tanggal dicatat: 18 Oktober 2026
- Diputuskan oleh: pemilik produk (Bayu Musthafa)
- Rujukan: PRD 7.1 (dependensi), 7.3 (komponen di `lib/design`), N-11 (aksesibilitas); redesain v2
  (`kapdh-mobile/mockup-html/REDESAIN.md`)
- Bukti di kode:
  - Font: `kapdh-mobile/assets/fonts/phosphor/{Phosphor-Regular,Phosphor-Fill,Phosphor-Duotone}.ttf` + `LICENSE` (MIT),
    keluarga font `PhosphorRegular`, `PhosphorFill`, `PhosphorDuotone` di `kapdh-mobile/pubspec.yaml`; codepoint di
    `kapdh-mobile/mockup-html/tools/phosphor-codepoints.json`.
  - Pemetaan tunggal: `kapdh-mobile/mockup-html/tools/icon-map-phosphor.json` (nama `Icons.<nama>` Material ke nama
    Phosphor), dibangkitkan oleh `mockup-html/tools/build-icons-phosphor.mjs` menjadi
    `kapdh-mobile/lib/design/kapdh_icons.dart` (`KapdhIcons`) dan `mockup-html/css/icons-phosphor.css` (`.ph-*`).
  - Pemakaian: semua `Icons.*` di `kapdh-mobile/lib` dan `test` diganti `KapdhIcons.*`; ubin akses cepat memakai
    duotone lewat `DuotoneIcon` (`lib/design/duotone_icon.dart`; `lib/features/home/widgets/home_widgets.dart`,
    `home_screen.dart`).
  - Lisensi aset mockup: `kapdh-mobile/mockup-html/assets/LICENSE-phosphor.txt`.

## Konteks

Atas permintaan pemilik, menu cepat dan navigasi bawah memakai ikon Phosphor (duotone untuk menu cepat,
regular/fill untuk navigasi; perbandingan di `mockup-html/ikon.html`). Akibatnya satu layar mencampur dua keluarga
ikon: Phosphor di menu dan navigasi, Material Icons di app bar, kartu dan field. Audit desain dengan skill
ui-ux-pro-max (`references/pro-rules.md`: "All icons come from a consistent icon family and style", "Filled vs
Outline discipline", "Stroke consistency") menandai campuran ini sebagai pelanggaran.

## Keputusan

1. Semua ikon aplikasi memakai Phosphor 2.1. Ikon status bar Android di mockup tetap Material karena digambar sistem,
   bukan aplikasi.
2. Font Phosphor dibundel langsung sebagai aset (MIT), TANPA paket `phosphor_flutter`: versi terakhirnya (2.1.0, Mei
   2024) meng-extend `IconData` yang `final` sejak Flutter 3.4x sehingga seluruh uji gagal dikompilasi di Flutter
   3.47.2 (`flutter analyze` tidak menangkapnya karena galat ada di dalam paket). `KapdhIcons` berisi `IconData`
   biasa (`fontFamily: PhosphorRegular/PhosphorFill`) sehingga tetap const dan dipangkas `--tree-shake-icons`.
3. Akses ke ikon lewat `KapdhIcons` di design system (PRD 7.3); fitur tidak memakai `Icons.*` atau
   `IconData` Phosphor langsung. Nama `KapdhIcons` mengikuti nama Material lama dalam camelCase agar riwayat mudah
   ditelusuri.
4. Varian outlined Material dipetakan ke bobot regular, varian terisi ke bobot fill; duotone hanya untuk ubin akses
   cepat dan digambar dengan `DuotoneIcon` (lapisan kedua 20 %).
5. Pemetaan disimpan di satu berkas JSON yang menjadi sumber mockup dan aplikasi. Menambah ikon: tambah baris lalu
   jalankan `node tools/build-icons-phosphor.mjs` dari `mockup-html`, kemudian `dart format lib/design/kapdh_icons.dart`.

## Alternatif yang dipertimbangkan

- **Kembali ke Material Icons di menu dan navigasi**: tidak mencampur keluarga, tetapi membatalkan pilihan pemilik.
- **Material Symbols Rounded** (variabel fill/weight): satu keluarga dengan duotone tiruan; ditolak karena pemilik
  sudah memilih tampilan Phosphor dan paket Flutter-nya membawa font variabel besar.
- **Paket `phosphor_flutter`**: dicoba lebih dulu; tidak kompatibel dengan Flutter 3.47 (lihat butir 2) dan tidak
  dirawat sejak 2024.
- **Solar (480 Design)**: kandidat kedua di `ikon.html`; lisensi CC BY 4.0 mewajibkan atribusi dan paket Flutter-nya
  pihak ketiga.

## Konsekuensi

- Tidak ada dependensi baru; bertambah tiga font aset (sekitar 1,5 MB sebelum dipangkas) berlisensi MIT. Tidak ada
  perubahan perilaku atau izin.
- Bentuk ikon berubah di seluruh aplikasi; uji widget yang mencocokkan ikon kini memakai `KapdhIcons`. Uji golden
  (bila ada) perlu dibangkitkan ulang.
- Ikon baru wajib ditambahkan lewat pemetaan agar mockup dan aplikasi tetap sama.
