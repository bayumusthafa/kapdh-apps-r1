# Pemberitahuan pihak ketiga

Repositori KAPDH Apps berlisensi proprietary (`LICENSE`). Komponen di bawah milik pihak ketiga, dibundel atau disalin
ke repositori ini, dan tetap tunduk pada lisensinya masing-masing: `LICENSE` KAPDH tidak berlaku untuknya dan tidak
membatasi hak yang diberikan lisensi tersebut. Perbarui berkas ini setiap kali aset pihak ketiga ditambah, diganti,
atau dihapus (pemeriksaan terakhir: Oktober 2026, terhadap berkas `*.ttf`, `*.otf`, `*.woff`, `*.woff2`, berkas
lisensi, kode salinan, dan aset yang tertanam di berkas HTML bundel di repositori).

## Ringkasan

| Komponen | Lokasi di repositori | Lisensi | Hak cipta / pencipta |
| -------- | -------------------- | ------- | -------------------- |
| [Phosphor Icons 2.1 (font)](#phosphor-icons) | `kapdh-mobile/assets/fonts/phosphor/*.ttf` | MIT | Copyright (c) 2020-2021 Phosphor Icons |
| [Phosphor Icons (SVG)](#phosphor-icons) | `kapdh-mobile/mockup-html/css/icons-phosphor.css`, `kapdh-mobile/mockup-html/ikon.html` | MIT | Copyright (c) 2023 Phosphor Icons |
| [Poppins](#poppins) | `kapdh-mobile/assets/fonts/poppins/*.ttf`, `kapdh-mobile/mockup-html/fonts/*.woff2`, tertanam di `docs/Prototipe KAPDH Apps.html` | SIL OFL 1.1 | Copyright 2020 The Poppins Project Authors |
| [Material Icons](#material-icons) | `kapdh-mobile/mockup-html/css/icons.css`, `kapdh-mobile/mockup-html/assets/icons.svg`, galeri di `kapdh-mobile/mockup-html/components.html` | CC BY 4.0 | Google |
| [Solar Icons](#solar-icons) | `kapdh-mobile/mockup-html/ikon.html` | CC BY 4.0 | 480 Design |
| [Hugeicons Free](#hugeicons-free) | `kapdh-mobile/mockup-html/ikon.html` | MIT | Copyright (c) 2025 Hugeicons |
| [Fluent UI System Icons](#fluent-ui-system-icons) | `kapdh-mobile/mockup-html/ikon.html` | MIT | Copyright (c) 2020 Microsoft Corporation |
| [CSS dasar TipTap](#css-dasar-tiptap) | `kapdh-platform/apps/admin/src/components/ui/tiptap-base.css` | MIT | Copyright (c) 2025, Tiptap GmbH |
| [React dan ReactDOM 18.3.1](#prototipe-satu-berkas) | tertanam di `docs/Prototipe KAPDH Apps.html` | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| [Kode pemuat alat ekspor prototipe](#prototipe-satu-berkas) | tertanam di `docs/Prototipe KAPDH Apps.html` | tidak tercantum | pembuat alat ekspor (bukan KAPDH) |

## Phosphor Icons

- Sumber: https://phosphoricons.com, https://github.com/phosphor-icons/core.
- Font aplikasi Flutter: `Phosphor-Regular.ttf`, `Phosphor-Fill.ttf`, `Phosphor-Duotone.ttf` (Phosphor 2.1) di
  `kapdh-mobile/assets/fonts/phosphor/`, didaftarkan di `kapdh-mobile/pubspec.yaml` dan ikut dibundel ke aplikasi
  (ADR-027). Teks lisensi: `kapdh-mobile/assets/fonts/phosphor/LICENSE`, ikut dibundel sebagai aset dan tampil di
  aplikasi pada Akun > Lisensi sumber terbuka (entri "Phosphor Icons", didaftarkan
  `kapdh-mobile/lib/app/app_licenses.dart`).
- Mockup HTML: SVG dari set Iconify `ph`, dibangkitkan `kapdh-mobile/mockup-html/tools/build-icons-phosphor.mjs`
  menjadi `css/icons-phosphor.css`, dan SVG pembanding di `ikon.html`. Teks lisensi:
  `kapdh-mobile/mockup-html/assets/LICENSE-phosphor.txt`.
- Lisensi: MIT ([teks di bawah](#teks-lisensi-mit)).

## Poppins

- Hak cipta: Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins).
- Lisensi: SIL Open Font License 1.1 (https://openfontlicense.org). Teks lengkap:
  `kapdh-mobile/mockup-html/fonts/OFL-Poppins.txt` dan `kapdh-mobile/assets/licenses/Poppins-OFL.txt` (dibundel di
  aplikasi).
- Pemakaian:
  - Mockup HTML: sepuluh berkas woff2 (latin dan latin-ext; bobot 400, 500, 600, 700, dan 400 italic) disalin tanpa
    perubahan dari paket npm `@fontsource/poppins` 5.3.0, berdampingan dengan `OFL-Poppins.txt`.
  - Situs publik dan web admin: paket npm `@fontsource/poppins` 5.3.0 (`kapdh-platform/apps/web`,
    `kapdh-platform/apps/admin`). Font tidak disimpan di repositori, tetapi ikut dibundel ke hasil build; paketnya
    menyertakan teks OFL.
  - Aplikasi Flutter: lima berkas TTF Poppins 4.004 (Regular, Italic, Medium, SemiBold, Bold) di
    `kapdh-mobile/assets/fonts/poppins/`, disalin tanpa perubahan dari repositori Google Fonts
    (https://github.com/google/fonts, folder `ofl/poppins`) dan dibundel sebagai font aset (`KapdhTheme`). Teks OFL
    (`kapdh-mobile/assets/licenses/Poppins-OFL.txt`, isi `OFL-Poppins.txt` dengan baris hak cipta per berkas font
    diringkas menjadi satu) dibundel sebagai aset dan tampil di aplikasi pada Akun > Lisensi sumber terbuka (entri
    "Poppins", didaftarkan `kapdh-mobile/lib/app/app_licenses.dart`).
  - Prototipe satu berkas `docs/Prototipe KAPDH Apps.html`: woff2 Poppins dari Google Fonts (bobot 400, 500, 600,
    700) tertanam di dalam bundelnya (lihat [Prototipe satu berkas](#prototipe-satu-berkas)).

## Material Icons

- Pencipta: Google. Katalog ikon: https://fonts.google.com/icons.
- Sumber salinan: font `materialicons-regular.otf` yang dibundel SDK Flutter
  (`<FLUTTER_ROOT>/bin/cache/artifacts/material_fonts/`).
- Lisensi: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/.
  Teks lengkap `kapdh-mobile/mockup-html/assets/LICENSE-material-icons.txt` identik dengan
  `materialicons_license.txt` di folder font SDK Flutter (diperiksa pada Flutter 3.47.2).
- Lokasi: `kapdh-mobile/mockup-html/css/icons.css` (kelas `.ic-*`), `kapdh-mobile/mockup-html/assets/icons.svg`, dan
  galeri ikon di `kapdh-mobile/mockup-html/components.html`; dipakai halaman mockup (termasuk `ikon.html`).
- Perubahan: `kapdh-mobile/mockup-html/tools/build-icons.mjs` mengonversi glyph font menjadi path SVG pada viewBox
  24x24 (diskalakan, sumbu y dibalik, koordinat dibulatkan dua desimal); warna mengikuti `currentColor`; hanya ikon
  di `tools/icon-list.txt` yang diambil. Header `css/icons.css` dan `assets/icons.svg` memuat atribusi dan catatan
  perubahan yang sama; galeri di `components.html` hanya memakai kelas dari `css/icons.css`.
- Penafian: materi berlisensi CC BY 4.0 disediakan pemberi lisensi sebagaimana adanya, tanpa jaminan (Section 5
  naskah lisensi).
- Catatan: repositori `google/material-design-icons` di GitHub menerbitkan ikon yang sama dengan Apache License 2.0.
  Salinan di repositori ini berasal dari SDK Flutter yang menyertakan naskah CC BY 4.0, sehingga atribusi mengikuti
  naskah itu.
- Aplikasi Flutter menyetel `uses-material-design: true`, sehingga build dapat menyertakan font Material Icons dari
  SDK; font itu tidak disimpan di repositori.

## Ikon pembanding di `ikon.html`

`kapdh-mobile/mockup-html/ikon.html` membandingkan empat set ikon untuk akses cepat dan navigasi bawah. SVG-nya
diambil sekali dari Iconify API (https://api.iconify.design) lalu ditanam di halaman itu. Atribusi yang sama tercantum
di bagian "Atribusi" halaman tersebut. Phosphor dijelaskan di [atas](#phosphor-icons).

### Solar Icons

- Pencipta: 480 Design. Sumber: Solar Icons Set di Figma Community
  (https://www.figma.com/community/file/1166831539721848736), lewat set Iconify `solar`
  (https://icon-sets.iconify.design/solar/).
- Lisensi: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
  (naskah yang sama dengan `kapdh-mobile/mockup-html/assets/LICENSE-material-icons.txt`).
- Perubahan: warna asli diganti `currentColor` sehingga ikon tampil dalam warna token KAPDH, dan SVG ditanam langsung
  di HTML.
- Penafian: disediakan pemberi lisensi sebagaimana adanya, tanpa jaminan (Section 5 naskah lisensi).

### Hugeicons Free

- Sumber: https://hugeicons.com, https://github.com/hugeicons/hugeicons (set Iconify `hugeicons`; hanya gaya gratis
  Stroke Rounded).
- Lisensi: MIT, Copyright (c) 2025 Hugeicons, https://github.com/hugeicons/hugeicons/blob/main/LICENSE.md
  ([teks di bawah](#teks-lisensi-mit)).

### Fluent UI System Icons

- Sumber: https://github.com/microsoft/fluentui-system-icons (set Iconify `fluent`).
- Lisensi: MIT, Copyright (c) 2020 Microsoft Corporation,
  https://github.com/microsoft/fluentui-system-icons/blob/main/LICENSE ([teks di bawah](#teks-lisensi-mit)).

## CSS dasar TipTap

- Lokasi: `kapdh-platform/apps/admin/src/components/ui/tiptap-base.css`.
- Sumber: `src/style.ts` paket `@tiptap/core` 3.31.4, https://github.com/ueberdosis/tiptap.
- Lisensi: MIT, Copyright (c) 2025, Tiptap GmbH. Teks lengkap ada di awal berkas sebagai komentar `/*! ... */`
  sehingga tetap ada di CSS hasil build web admin.
- Perubahan: satu komentar sumber dibuang; aturan CSS tidak diubah.

## Prototipe satu berkas

`docs/Prototipe KAPDH Apps.html` adalah ekspor satu berkas dari alat pembuat prototipe. Setiap layar di dalamnya
(bundel terkompresi base64) menanam salinan komponen berikut:

- React 18.3.1 dan ReactDOM 18.3.1 (`react.production.min.js`, `react-dom.production.min.js`, aslinya dari
  https://cdn.jsdelivr.net/npm/react@18.3.1/ dan https://cdn.jsdelivr.net/npm/react-dom@18.3.1/). Lisensi: MIT,
  Copyright (c) Facebook, Inc. and its affiliates, https://github.com/facebook/react/blob/v18.3.1/LICENSE
  ([teks di bawah](#teks-lisensi-mit)). Komentar `@license` asli tetap ada di skrip yang tertanam.
- Poppins woff2 dari Google Fonts: SIL OFL 1.1 (lihat [Poppins](#poppins)).
- Kode pemuat dan runtime bawaan alat ekspor itu (bukan buatan KAPDH). Berkas tidak mencantumkan lisensinya, sehingga
  tidak ada izin pakai ulang yang dapat disimpulkan dari repositori ini.

Isi layar, teks, dan logo di prototipe itu tetap milik KAPDH (`LICENSE`).

## Tidak dibundel

- Telegraf (font heading Guidelines KAPDH) adalah font komersial dan tidak ada di repositori. `KapdhTheme.useTelegraf`
  (`kapdh-mobile/lib/app/theme/kapdh_theme.dart`) tetap `false` sampai lisensinya dimiliki.

## Dependensi paket

Dependensi yang dipasang lewat pnpm (`kapdh-platform/pnpm-lock.yaml`) dan pub (`kapdh-mobile/pubspec.lock`), misalnya
React, paket `@tiptap/*`, `lucide-react`, dan `@fontsource/poppins`, tidak disalin ke repositori ini
(kecuali salinan yang disebut di atas, mis. React 18.3.1 di prototipe satu berkas) dan tunduk pada lisensinya
masing-masing. Daftarnya dapat dihimpun dengan `pnpm licenses list` dari `kapdh-platform/`;
Flutter menghimpun lisensi paket pub ke berkas `NOTICES` di hasil build aplikasi; aplikasi menampilkannya bersama
lisensi Phosphor dan Poppins di Akun > Lisensi sumber terbuka.

## Teks lisensi MIT

Berlaku untuk Phosphor Icons, Hugeicons Free, Fluent UI System Icons, CSS dasar TipTap, serta React dan ReactDOM di
prototipe satu berkas. Setiap komponen memakai baris hak ciptanya sendiri (lihat bagian masing-masing); teks izinnya
sama.

```text
MIT License

Copyright (c) 2020-2021 Phosphor Icons (font Flutter)
Copyright (c) 2023 Phosphor Icons (SVG mockup)
Copyright (c) 2025 Hugeicons
Copyright (c) 2020 Microsoft Corporation
Copyright (c) 2025, Tiptap GmbH
Copyright (c) Facebook, Inc. and its affiliates (React dan ReactDOM 18.3.1)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
