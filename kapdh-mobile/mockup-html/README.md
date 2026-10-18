# Mockup HTML aplikasi KAPDH

Tiruan statis (HTML + CSS) dari tampilan aplikasi Flutter `kapdh-mobile` **apa adanya saat ini**, satu halaman per layar.

> **Redesain v2 (usulan) sudah diterapkan** pada token dan komponen bersama: latar, teks redup, radius, bayangan,
> cincin fokus, state layer tekan, motion dan skeleton. Struktur layar dan teks tetap sama dengan aplikasi. Rincian,
> alasan dan pemetaan ke Dart: [`REDESAIN.md`](REDESAIN.md). Tampilan apa adanya: commit `89db9f4`.
Tujuannya memberi desainer bahan yang bisa diubah langsung di browser untuk merancang tampilan baru, lalu hasilnya
diterjemahkan kembali ke token dan widget Flutter.

Folder ini berada di dalam `kapdh-mobile/` tetapi di luar `lib/`, `assets/` dan `test/`, sehingga tidak ikut dibangun
Flutter dan tidak masuk aset aplikasi.

## Cara membuka

- **Paling mudah:** klik dua kali `index.html` atau `components.html`, buka dengan **Chrome atau Edge**.
- **Lewat http (disarankan untuk semua browser):** dari folder ini jalankan

  ```bash
  node tools/serve.mjs        # lalu buka http://localhost:5178/
  ```

  Firefox membatasi font dari folder induk pada `file://`, sehingga halaman di dalam subfolder grup bisa tampil
  dengan font sistem bila dibuka langsung. Lewat http semuanya normal, termasuk `<use>` ke sprite `assets/icons.svg`.
- Tidak ada langkah build, framework, CDN, atau JavaScript. Semua font dan gambar lokal.

## Struktur

```text
mockup-html/
  index.html              DIBANGKITKAN: galeri semua halaman per grup + tabel cakupan layar Flutter
  components.html         etalase setiap komponen bersama + nama kelas + widget Dart sumbernya + galeri ikon
  _template.html          kerangka halaman layar (salin ke <grup>/<slug>.html)
  css/
    tokens.css            token desain (warna, tipografi, spasi, radius, bayangan, ukuran) + @font-face Poppins
    components.css        komponen bersama; mengimpor icons.css
    icons.css             DIBANGKITKAN: kelas ikon .ic-<nama Flutter> (mask SVG)
    pages/<grup>.css      gaya khusus satu grup layar (satu berkas per grup)
  <grup>/<slug>.html      halaman layar, mis. auth/login.html, beranda/home.html
  fonts/                  Poppins woff2 (400, 500, 600, 700, 400 italic; latin + latin-ext) + OFL-Poppins.txt
  assets/
    logo-kapdh.png        salinan kapdh-mobile/assets/logo-kapdh.png (aset yang dirender aplikasi)
    icons.svg             DIBANGKITKAN: sprite <symbol id="<nama Flutter>"> untuk desainer
    LICENSE-material-icons.txt
    sample/               gambar contoh banner, berita, event (dari docs/konten/gambar)
  tools/
    build-index.mjs       pembangkit index.html dari strip kepala halaman + pemeriksa cakupan *_screen.dart
    build-icons.mjs       pembangkit icons.css + icons.svg + galeri ikon dari font ikon Flutter SDK
    icon-list.txt         daftar ikon yang dibangkitkan (nama Flutter Icons.<nama>)
    serve.mjs             server statis kecil tanpa dependensi
```

Grup (folder = berkas `css/pages/<grup>.css`):

| Folder | Isi | Dart |
| --- | --- | --- |
| `auth/` | masuk, daftar, OTP, lupa password, biaya KTA awal, splash, wajib update, pemeliharaan, 404, galat konfigurasi, portal Dibatasi dan status penghapusan | `lib/features/auth`, `system`, `onboarding`, `status` |
| `beranda/` | navigasi bawah (AppShell), Beranda, Berita, Notifikasi, halaman legal | `lib/app/app_shell.dart`, `lib/features/home`, `news`, `notifications`, `legal` |
| `event/` | daftar/detail event, konfirmasi pendaftaran, Tiket Saya, detail tiket | `lib/features/events`, `tickets` |
| `kta/` | KTA digital, riwayat/buat/status pembayaran, perpanjangan | `lib/features/kta`, `payments` |
| `jejaring/` | direktori, tab Pesan, profil alumni, lembar laporan, chat, info/undangan/grup baru, pemilih alumni | `lib/features/network`, `chat` |
| `akun/` | Akun dan semua layar pengaturannya | `lib/features/account` |

Pengguna Diblokir dan Laporan Saya (kode di `network/`, diekspor ulang oleh `account/`) dimockup di `akun/` dan
`jejaring/`; strip kepalanya saling menautkan. Saat redesain, jadikan satu sebagai acuan.

**Indeks dibangkitkan.** Setelah menambah halaman atau mengubah judul, rute, atau keadaan di strip kepala, jalankan
`node tools/build-index.mjs`. Skrip itu juga melaporkan `*_screen.dart` yang belum punya halaman (folder grup baru
didaftarkan di `GROUPS` dalam skrip).

## Konvensi halaman layar

1. **Satu berkas per layar**: `<grup>/<slug-layar>.html`, mulai dari `_template.html`. Setiap halaman menautkan
   kembali ke `../index.html` dan memuat tepat tiga stylesheet: `../css/tokens.css`, `../css/components.css`,
   `../css/pages/<grup>.css`.
2. **Strip kepala di luar ponsel** (`.page-header`): nama layar, path Dart, rute, daftar keadaan yang ditampilkan,
   catatan opsional.
3. **Frame ponsel** `.device` berukuran 360 x 800 px CSS (= dp), status bar Android 24 dp (`.statusbar`, pakai
   `.statusbar--on-dark` di atas header hijau) dan pegangan navigasi gestur 20 dp (`.sysnav`). Layar yang bergulir
   ditampilkan sebagai frame viewport ditambah frame `.device--tall` setinggi seluruh isi. Frame "digulir" memakai utilitas
   bersama `.scroll-viewport` (area ListView yang memotong isi), `.scroll-offset` dengan `style="--scroll:240px"`
   (posisi tengah) atau `.scroll-end` (digulir sampai akhir), tanpa JavaScript.
4. **Keadaan = frame terpisah berlabel** (`.frame` + `.frame__label`), berdampingan: utama, kosong, galat, memuat
   (skeleton), nonaktif/terkunci, dialog, bottom sheet, snackbar. Tidak ada JavaScript untuk berganti keadaan.
5. **Teks disalin persis dari Dart** (label, judul, pesan kosong/galat, tombol). Data contoh fiktif dan netral:
   nama "Ahmad Fauzi", "Siti Rahmah", angkatan "KAPDH 12", nomor anggota format `AA.SS.JK.N` seperti `12.01.01.7`,
   nominal seperti `Rp150.000`. Jangan memakai nama atau nomor rekening nyata. QR selalu glyph tiruan `.qr-glyph`
   yang tidak dapat dipindai.
6. **Ikon**: `<span class="ic ic-<nama> ic-s20" aria-hidden="true"></span>`, `<nama>` sama dengan `Icons.<nama>` di
   Dart (mis. `ic-home_outlined`). Ukuran `.ic-s10` sampai `.ic-s64` atau `style="--ic-size:18px"`; warna mengikuti
   `color`. Glyph diambil dari font ikon Flutter, jadi bentuknya identik.
7. **CSS bersama tidak diubah dari grup layar.** Gaya khusus masuk `css/pages/<grup>.css` dan sebaiknya memakai
   variabel dari `tokens.css`. Bila butuh komponen atau token baru yang dipakai lintas grup, tulis usulannya di
   catatan halaman/grup; perubahan bersama dilakukan terpusat. Ikon baru: tambah nama ke `tools/icon-list.txt` lalu
   `node tools/build-icons.mjs` (dilakukan terpusat).
8. **HTML semantik dan aksesibel**: `lang="id"`, satu `<main class="frames">` per halaman; di dalam ponsel pakai
   `header`, `nav`, `section`, `button`, `label`, bukan `<main>` kedua. Ikon dekoratif `aria-hidden="true"`, tombol
   ikon diberi `aria-label` sesuai tooltip Dart.

## Pemetaan token ke Dart

Sumber tunggal token adalah `kapdh-platform/packages/design-tokens/tokens.json`. `build.mjs` membangkitkan
`flutter/lib/kapdh_tokens.dart`, yang disalin ke `kapdh-mobile/lib/app/theme/kapdh_tokens.dart` (CI membandingkan
keduanya dengan `cmp`). `tokens.css` di sini memetakan nama yang sama:

| Dart | CSS | Contoh |
| --- | --- | --- |
| `KapdhColors.green800`, `KapdhColors.primary` | `--color-green-800`, `--color-primary` | `#1A4B17` |
| `KapdhColors.textMuted`, `.divider`, `.border` | `--color-text-muted`, `--color-divider`, `--color-border` | |
| `KapdhColors.success` / `successBg` (dst.) | `--color-success` / `--color-success-bg` | |
| `KapdhMembershipStatus.verified` (fg, bg) | `--status-verified-fg`, `--status-verified-bg` | label "KTA Aktif" |
| `KapdhGradients.buttonPrimary`, `KapdhExtraColors.bandGradient` | `--gradient-button-primary`, `--gradient-band` | 180deg |
| `KapdhGradients.ktaCard` | `--gradient-kta-stops` + `--kta-angle` di `.kta-card` | lihat catatan sudut |
| `KapdhExtraColors.*` (`design_constants.dart`) | `--color-muted-on-dark`, `--color-rejection-border`, `--color-qr-placeholder-*` | |
| `KapdhSpace.s1` ... `s16` | `--s1` ... `--s16` | `--s5` = 20 |
| `KapdhRadius.sm/md/lg/xl/pill` | `--r-sm/--r-md/--r-lg/--r-xl/--r-pill` | 6/10/14/20/999 |
| `KapdhFontSize.display` ... `overline` | `--fs-display` ... `--fs-overline` | 32 ... 11 |
| `KapdhSize.*`, `KapdhComponentSize.*` | `--size-*` | tombol utama 52, OTP 56 |
| `ColorScheme.fromSeed(...)` yang tidak ditimpa tema | `--m3-*` | SegmentedButton, ChoiceChip, Switch |

Hal yang perlu diketahui:

- **Teks bawaan Flutter** mewarisi `bodyMedium`: Poppins 14, tinggi baris 1.45, letter-spacing 0.25. `TextStyle`
  di kode hanya mengganti properti yang disebut, jadi `fontSize: 13` tetap 1.45 / 0.25. CSS meniru ini lewat
  `body` dan kelas `.t-*`. Tombol teks (`TextButton`, `KapdhLinkButton`) tidak mewarisi: letter-spacing 0, tinggi
  baris alami Poppins.
- **Ukuran widget Material 3** (TextField 48, Dropdown 52, pencarian 51, NavigationBar, TabBar 48, ListTile 56/72
  dengan padding kiri 16 kanan 24, ChoiceChip 32, Badge, AlertDialog 280 dengan padding 24) diukur dari Flutter
  3.47.2 lewat uji widget pada 360 x 800, bukan ditebak.
- **Gradasi KTA**: Flutter menarik gradasi dari sudut kiri atas ke kanan bawah, sehingga sudut CSS-nya tergantung
  rasio kartu (`90deg + atan(tinggi/lebar)`). `.kta-card` memakai 128deg dan `.kta-mini` 111deg; ubah `--kta-angle`
  bila ukuran kartu berubah.
- **Garis atas navigasi bawah**: `AppShell` memasang `DecoratedBox` bergaris atas, tetapi garis itu tertutup latar
  `NavigationBar` dan tidak terlihat di aplikasi (terverifikasi golden). Mockup mengikuti tampilan nyata (tanpa
  garis).
- Status bar dan inset gestur adalah perkiraan perangkat Android umum; rendering teks browser sedikit berbeda dari
  Skia (lebar huruf dan pemenggalan baris bisa bergeser 1 sampai 2 px).

## Komponen bersama

Daftar lengkap ada di `components.html`. Ringkasan pemetaan ke Dart:

| Kelas | Widget Dart |
| --- | --- |
| `.appbar` | `AppScaffold` (`lib/design/app_scaffold.dart`) |
| `.home-header`, `.greeting__*` | `HomeHeader` (`lib/features/home/widgets/home_widgets.dart`) |
| `.brand-band(--pattern)`, `.brand-sheet`, `.greeting-band`, `.sheet-title-row` | `BrandHeader`, `BrandSheetScaffold`, `GreetingHeader`, `GreetingBand`, `SheetTitleRow`, `AuthSheetTitle` |
| `.bottom-nav`, `.badge--lock` | `AppShell`, `_TabIcon` (`lib/app/app_shell.dart`) |
| `.btn--primary/--solid/--outline` | `KapdhButton`, `.solid`, `.outlined` |
| `.btn-text`, `.btn-link`, `.btn-m3`, `.icon-btn`, `.fab-small` | `TextButton`, `KapdhLinkButton`, `OutlinedButton`/`FilledButton`, `IconButton`, `FloatingActionButton.small` |
| `.field`, `.input`, `.otp`, `.rules` | `KapdhTextField`, `KapdhDropdownField`, `OtpBoxes`, `PasswordRules` |
| `.status-badge--*`, `.status-hero`, `.status-action-card` | `StatusBadge`/`StatusStyles`, `StatusHero`, `StatusActionCard` |
| `.kta-card`, `.kta-qr--locked`, `.kta-mini`, `.qr-glyph` | `KtaCard`, `_QrBox`, `KtaMiniCard` |
| `.summary-card`, `.info-box`, `.amount-box`, `.qris-card`, `.support-card` | `SummaryCard`, `InfoBox`, `AmountCopyBox`, `QrisImageCard`, `SupportContactCard` |
| `.upload-tile`, `.method-card`, `.timeline`, `.stepper` | `UploadTile`, `MethodRadioCard`, `Timeline`, `KapdhStepper` |
| `.event-card`, `.post-card`, `.banner-carousel`, `.quick-access`, `.member-card` | `EventCard`, `PostCard`, `BannerCarousel`, `QuickAccessRow`, `DirectoryMemberCard` |
| `.category-chip`, `.tag-chip`, `.choice-chip`, `.icon-line` | `CategoryChip`, `TagChip`, `ChoiceChip`, `IconLine` |
| `.section-title`, `.section-header`, `.section-empty` | `HomeSectionTitle`, `SectionHeader`, `SectionEmpty` |
| `.account-section__*`, `.menu-tile` | `AccountSection`, `AccountMenuTile` |
| `.state(--error)`, `.skeleton`, `.status-strip` | `EmptyState`, `ErrorState`, `LoadingSkeleton`, `OfflineBanner`, `MaintenanceBanner` |
| `.tabs`, `.underline-tabs`, `.segmented` | `TabBar`, `_CategoryTabs` (events), `SegmentedButton` |
| `.list-tile`, `.switch`, `.checkbox`, `.radio`, `.popup-menu` | `ListTile` dan varian, `Switch`, `Checkbox`, `Radio`, `PopupMenuButton` |
| `.scrim`, `.dialog`, `.sheet`, `.snackbar` | `AlertDialog`, `showModalBottomSheet`, `SnackBar` (tema `KapdhTheme`) |

## Alur redesain kembali ke Flutter

1. **Iterasi di mockup.** Ubah dulu `css/tokens.css` (warna, tipografi, radius, spasi) untuk perubahan global, lalu
   `css/components.css` untuk bentuk komponen, baru gaya per grup. Karena semua halaman memakai berkas yang sama,
   satu perubahan token langsung terlihat di seluruh layar. Simpan versi lama (git) agar mudah dibandingkan.
2. **Catat keputusan sebagai token, bukan angka lepas.** Setiap nilai baru sebaiknya punya nama token. Nilai yang
   kini masih literal di Dart (mis. radius 12 dan 16, `KapdhExtraColors`, `KapdhComponentSize`) adalah kandidat untuk
   dipindah ke `tokens.json`.
3. **Token ke kode.** Perbarui `kapdh-platform/packages/design-tokens/tokens.json`, jalankan
   `pnpm --filter @kapdh/design-tokens build` (atau `node build.mjs` di paket itu), salin
   `flutter/lib/kapdh_tokens.dart` ke `kapdh-mobile/lib/app/theme/kapdh_tokens.dart` (CI mencocokkan). Admin web
   ikut mendapat `css/kapdh-theme.css` yang sama.
4. **Tema dan komponen.** Perubahan perilaku widget Material (tinggi field, gaya tab, chip, dialog) masuk
   `lib/app/theme/kapdh_theme.dart`; perubahan komponen KAPDH masuk `lib/design/*` (komponen baru ditambahkan di
   sana, bukan di folder fitur, PRD 7.3). Nama kelas CSS di tabel atas menunjukkan widget mana yang perlu disentuh.
5. **Layar.** Tata letak khusus layar (`css/pages/<grup>.css`) diterjemahkan ke `*_screen.dart` di grup yang sama.
   Teks tetap sama kecuali disetujui pemilik; perubahan teks juga harus diperbarui di uji widget yang mencocokkan
   teks.
6. **Verifikasi.** Jalankan `flutter analyze` dan `flutter test`, periksa aksesibilitas (kontras WCAG AA, target
   sentuh 48, teks 200 %), lalu perbarui mockup ini agar kembali mencerminkan aplikasi.

## Membangkitkan ulang ikon

```bash
node tools/build-icons.mjs
```

Membaca `tools/icon-list.txt`, kode titik dari `<FLUTTER_ROOT>/packages/flutter/lib/src/material/icons.dart` dan glyph
dari `<FLUTTER_ROOT>/bin/cache/artifacts/material_fonts/materialicons-regular.otf` (Apache 2.0), lalu menulis
`css/icons.css`, `assets/icons.svg` dan galeri di `components.html`. Variabel lingkungan `FLUTTER_ROOT` (bawaan
`C:/flutter/flutter`) dan `FONTKITTEN` (parser font dari pnpm store `kapdh-platform`) dapat diubah bila path berbeda.

## Lisensi aset

- Poppins: SIL Open Font License 1.1 (`fonts/OFL-Poppins.txt`).
- Material Icons: Apache License 2.0 (`assets/LICENSE-material-icons.txt`).
- Logo dan gambar contoh: milik KAPDH, hanya untuk keperluan desain internal.
