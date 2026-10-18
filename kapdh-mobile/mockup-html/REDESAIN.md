# Redesain v2: peningkatan UI/UX mockup

Usulan redesain pertama di atas mockup "apa adanya" (commit `89db9f4`). Semua perubahan ada di `css/tokens.css`,
`css/components.css` dan dua aturan di `css/pages/` (`event.css`, `jejaring.css`). HTML layar tidak diubah, jadi
teks, urutan elemen dan keadaan per layar tetap sama dengan aplikasi. Warna merek (hijau `#1A4B17`, emas `#E6D312`),
font Poppins dan ukuran komponen Material 3 juga tetap.

Bandingkan dengan versi lama:

```bash
git diff 89db9f4 -- kapdh-mobile/mockup-html/css
```

Di CSS, nilai yang berubah diberi tanda `[v2]` dan komentar `dulu ...`, yaitu nilai yang dipakai aplikasi sekarang.

## Dasar keputusan

Tiga skill yang dipasang di `.claude/skills/`:

| Skill | Yang diambil |
| --- | --- |
| `ui-ux-pro-max` | Gaya untuk aplikasi komunitas/keanggotaan dan organisasi keagamaan: **Soft UI Evolution + Accessible & Ethical** (bayangan lembut berlapis, radius 8-12, animasi 200-300 ms, cincin fokus 2-3 px, kontras teks minimal 4,5:1). Ditambah *Pre-Delivery Checklist* di `references/pro-rules.md`: target sentuh 48 dp, umpan balik tekan tanpa pergeseran tata letak, isi gulir tidak tertutup bilah tetap, warna bukan satu-satunya penanda. |
| `flutter-ui-design` | Radius komponen seragam (12-16), kedalaman halus alih-alih desain terlalu datar, hierarki tebal-tipis judul vs isi, waktu animasi (tap 100-150 ms, transisi 250-350 ms, `easeOutCubic`), skala spasi 8. |
| `flutter-ui-ux` | Tiap keadaan (memuat, kosong, galat) punya tampilan yang jelas, mikro-interaksi tombol, aksesibilitas wajib (Semantics, kontras, skala teks). |

Catatan: skrip pencarian `ui-ux-pro-max` butuh Python, yang belum terpasang di mesin ini. Datanya dibaca langsung dari
CSV di `data/` (`products.csv` baris *Membership/Community*, `ui-reasoning.csv`, `styles.csv` *Soft UI Evolution*,
`stacks/flutter.csv`).

## Temuan audit pada versi lama

Kontras diukur dengan rumus WCAG 2.2.

| # | Temuan | Ukuran | Prioritas |
| --- | --- | --- | --- |
| 1 | Cincin fokus emas `#E6D312` di permukaan terang hampir tak terlihat | 1,5:1 (WCAG 1.4.11 minta 3:1) | Kritis (aksesibilitas) |
| 2 | Kotak OTP aktif ditandai garis emas, nyaris sama dengan kotak kosong | 1,5:1 di putih | Kritis |
| 3 | Kartu putih di latar `#FBFAFF` hanya dibedakan garis divider tipis | 1,04:1 (garis 1,23:1) | Tinggi |
| 4 | Latar `#FBFAFF` (lila bawaan Material 3) tidak senada dengan merek hijau | | Sedang |
| 5 | Lingkaran ikon akses cepat `green50` di kartu putih nyaris tak terlihat | 1,08:1 | Sedang |
| 6 | Titik carousel nonaktif `#C9C9C9` terlalu pucat | 1,66:1 | Sedang |
| 7 | Navigasi bawah dan bilah aksi bawah tidak punya pemisah dari isi yang digulir | | Sedang |
| 8 | Radius tersebar: 2, 4, 6, 8, 10, 12, 14, 16, 20 | | Sedang |
| 9 | Tidak ada umpan balik hover/tekan di mockup; skeleton hanya berdenyut | | Sedang |
| 10 | Judul dialog 24 w600 di dialog selebar 280: judul berbahasa Indonesia sering 3 baris | | Rendah |
| 11 | Judul bagian (w600) kurang tegas dibanding isi (w400-w600) | | Rendah |

## Perubahan token (`css/tokens.css`)

| Token CSS | Dulu | v2 | Ke Flutter |
| --- | --- | --- | --- |
| `--color-background`, `--color-neutral-50` | `#FBFAFF` | `#F5F7F3` | `tokens.json` `color.semantic.background`, `color.neutral.50` -> `KapdhColors.background` |
| `--color-text-muted` | `#6B6B6B` | `#5E665C` (5,5:1 di latar, 6,0:1 di putih) | `color.semantic.text-muted` -> `KapdhColors.textMuted` |
| `--color-divider` | `#E3E3E6` | `#E1E6DE` | `KapdhColors.divider` |
| `--color-disabled-bg` / `-text` | `#DCDCE0` / `#6B6B6B` | `#E1E5DE` / `#6E766C` | `KapdhColors.disabledBg`, `disabledText` |
| `--color-focus-ring` | `#E6D312` | `#2D7A28` (5,4:1) | `KapdhColors.focusRing` |
| `--color-focus-ring-on-dark` | | `#E6D312` (baru) | token baru `focusRingOnDark` |
| `--color-card-border` | | `#E6EBE3` (baru) | token baru `cardBorder` |
| `--r-sm` / `--r-md` / `--r-lg` / `--r-xl` | 6 / 10 / 14 / 20 | 8 / 12 / 16 / 24 | `tokens.json` `radius` -> `KapdhRadius` |
| `--r-12`, `--r-16` (literal) | 12, 16 | sama dengan `--r-md`, `--r-lg` | hapus literal 12/16 di Dart, pakai `KapdhRadius.md/lg` |
| `--shadow-xs/sm/md/lg`, `--shadow-kta`, `--shadow-primary-btn`, `--shadow-bar-top`, `--ring-focus-field` | | baru | token baru `shadow.*` -> `KapdhShadows` (`List<BoxShadow>`) |
| `--dur-press/fast/base/slow`, `--ease-standard`, `--ease-out` | | 100 / 150 / 250 / 350 ms | token baru `motion.*` -> `KapdhMotion` (`Duration`, `Curves.easeOutCubic`) |
| `--fw-heading` | | 700 | `KapdhTheme`: `displaySmall`, `headlineSmall`, `titleLarge` jadi `w700` |

## Perubahan komponen (`css/components.css`)

| Komponen | Perubahan v2 | Widget Dart |
| --- | --- | --- |
| Semua elemen yang dapat diketuk | State layer 8 % (hover) / 12 % (tekan) sebagai bayangan inset: mengikuti radius, tata letak tidak bergeser. Transisi 100-150 ms. Tanpa transisi bila *reduce motion*. | Sudah ada lewat `InkWell` / `overlayColor`; sesuaikan `splashFactory`/durasi bila perlu |
| Cincin fokus | Hijau `#2D7A28` di permukaan terang, emas di header hijau, kartu KTA, kotak nominal, snackbar | `FocusTheme`/`focusColor` per permukaan |
| `.card`, `.summary-card`, `.status-action-card`, `.qris-card`, `.support-card`, `.account-section__card`, `.quick-access` | Garis `--color-card-border` + `--shadow-sm` | `CardTheme` (elevation 0 + `shape`), `TappableCard`, `SummaryCard`, `StatusActionCard`, `QrisImageCard`, `SupportContactCard`, `AccountSection`, `QuickAccessRow` |
| `.btn--primary` | Bayangan hijau `--shadow-primary-btn`; hilang saat nonaktif/sibuk | `KapdhButton` (`lib/design/kapdh_button.dart`) |
| `.input` | Fokus: garis 2 px primary + halo 4 px, ikon awalan ikut hijau; galat: halo merah | `KapdhTextField` (halo lewat `AnimatedContainer` + `BoxShadow` saat `Focus`) |
| `.otp__box` | Terisi: garis primary + isi `green50`. Aktif: garis primary + halo + kursor berkedip (dulu garis emas) | `OtpBoxes` (`lib/design/otp_boxes.dart`) |
| `.choice-chip` | Garis rambut pada chip tidak terpilih; chip primary terpilih dengan `--shadow-xs` | `chipTheme.side`, `ChoiceChip` Berita |
| `.quick-access__icon` | Kotak membulat 14 berlatar `green100` (dulu lingkaran `green50`) | `QuickAccessRow` (`home/widgets/home_widgets.dart`) |
| `.section-empty` | Garis putus-putus `neutral300`: "belum ada isi" dibedakan dari kartu | `SectionEmpty` (perlu `CustomPaint` garis putus) |
| `.section-title__title`, `.section-header__title` | 17 w700 / 14 w700 (dulu 16 w600 / 14 w600) | `HomeSectionTitle`, `SectionHeader` |
| `.dots__dot` | Nonaktif `neutral500` (3,1:1 di latar), lebar beranimasi 250 ms | `BannerCarousel` |
| `.banner-tile` | `--shadow-sm` | `BannerCarousel` `_BannerTile` |
| `.kta-card`, `.kta-mini` | `--shadow-kta`: kartu terasa seperti kartu fisik | `KtaCard`, `KtaMiniCard` |
| `.info-box` | Garis 1 px bernada 20 %; ukuran luar tetap | `InfoBox` (`lib/design/info_box.dart`) |
| `.state__icon` | Lingkaran `green100` (dulu `green50`) | `EmptyState` (`lib/design/states.dart`) |
| `.skeleton*` | Kilau (shimmer) 1,4 s bernada hijau menggantikan denyut opasitas; statis bila *reduce motion* | `LoadingSkeleton` |
| `.bottom-nav` | Garis rambut + bayangan ke atas `--shadow-bar-top`; indikator beranimasi 250 ms | `AppShell` `NavigationBarTheme` (`shadowColor`, `elevation`) |
| `.snackbar` | Radius 12, margin 16 / 12, `--shadow-lg` | `SnackBarTheme` (`shape`, `insetPadding`) |
| `.dialog` | Radius 24, `--shadow-lg`, judul 20 w700 | `DialogTheme` (`shape`, `titleTextStyle`) |
| `.sheet` | `--shadow-lg`, judul w700 | `BottomSheetTheme` |
| `.popup-menu`, `.dropdown-menu` | Putih, garis rambut, radius 12, `--shadow-md` (dulu `surfaceContainer`, radius 4) | `PopupMenuThemeData`, `DropdownMenuThemeData` |
| `.fab-small` | `--shadow-md` | `FloatingActionButtonThemeData` |
| `.ev-bar` (event), `.jj-profile-bottom` (jejaring) | `--shadow-bar-top` sebagai pemisah dari isi yang digulir | `lib/features/events/event_detail_screen.dart`, `lib/features/network/member_profile_screen.dart` |

Etalase `components.html` punya bagian baru **Radius, kedalaman dan interaksi (v2)** untuk mencoba state layer dan
fokus keyboard.

## Beranda v2: adaptasi desain `NewDesign/home.html`

Sumber: prototipe Tailwind `Unduhan/NewDesign/home.html` (16 keadaan, sama dengan `beranda/home.html`). Bahasa visualnya
diambil, lalu disesuaikan dengan aturan mockup dan skill. Keputusan pemilik: isi akses cepat tetap sesuai aplikasi,
tab KTA menjadi tombol tengah yang menonjol di semua layar, dan font tetap Poppins.

| Bagian | Diambil dari desain baru | Disesuaikan (alasan) | Widget Dart |
| --- | --- | --- | --- |
| Header | Gradasi "mesh" zamrud + cahaya emas, cincin dekoratif, sudut bawah membulat, bayangan hijau, tombol kaca persegi membulat, lencana emas bercincin | Logo KAPDH tetap ada (dalam bingkai kaca bercincin emas), bukan avatar inisial. Tombol lonceng 48 x 48 (desain 40, di bawah target 48 dp). Tombol Cari dan pil angkatan tidak diambil karena fiturnya belum ada di `HomeHeader` | `HomeHeader` |
| Navigasi bawah | Tab KTA jadi tombol tengah 56 bergradasi, naik di atas bilah | Label tetap "KTA" (teks Dart). Terpilih = cincin emas. Kolom tab tetap 72 x 64. Berlaku di 7 halaman ber-AppShell | `AppShell` |
| Banner | Titik di dalam banner (aktif emas), judul tebal | Subjudul dan tombol CTA tidak diambil karena data banner hanya berisi gambar, judul dan tautan. Gradasi kiri tidak dipakai agar ilustrasi banner tidak tertutup | `BannerCarousel` |
| Akses cepat | Ubin 48 radius 16 `green50` bergaris `green100`, padding kartu 16 | Isi tetap KTA, Notifikasi, Tiket Saya, Berita. Teks detail tetap 11 px (desain 9 px, terlalu kecil) | `QuickAccessRow` |
| Judul bagian | "Lihat semua" jadi pil tonal + chevron | Area sentuh tetap 48. Subjudul bagian tidak diambil (teks baru) | `HomeSectionTitle` |
| Kartu event | Sampul 80 x 80, ikon meta hijau, footer bergaris: status di kiri, harga di kanan | Berlaku juga di daftar Event (widget yang sama) | `EventCard` |
| Berita | Kartu pertama hero (kategori dan tanggal/suka di atas gambar), sisanya baris ringkas 80 x 80 | Hanya di Beranda; halaman Berita tetap `PostCard` biasa | `PostCard` varian hero/compact |
| Pengingat KTA | Tombol "Perpanjang" berwarna isi | Warna `warning` #8A5A00 dengan teks putih (5,9:1). Amber desain 2,1:1, gagal kontras | `_RenewalReminder` |
| Memuat | Skeleton mengikuti bentuk Beranda | Shimmer v2 bernada hijau, statis bila *reduce motion* | `LoadingSkeleton` (varian Beranda) |
| Beranda terkunci | StatusHero + tombol aksi dalam satu kartu | Judul "Akses Tersedia" tidak ditambahkan (teks baru) | `_GatedHome` |
| Keadaan kosong/galat | Ikon dalam persegi membulat | `EmptyState`/`ErrorState` di semua layar ikut berubah | `states.dart` |

Tidak diambil karena melanggar aturan mockup atau skill: Tailwind, Lucide dan foto Unsplash dari CDN, JavaScript
pengganti keadaan, teks 9-10 px, teks `slate-400` (2,6:1 di putih), modal KTA (di aplikasi tab KTA membuka layar KTA),
toast, dan data nyata pada contoh (mockup memakai "Ahmad Fauzi").

## Ikon Phosphor untuk akses cepat dan navigasi bawah

Dipilih dari perbandingan di [`ikon.html`](ikon.html) (Phosphor, Solar, Hugeicons, Fluent; Material sebagai acuan).
Phosphor adalah set yang dikurasi skill ui-ux-pro-max, berlisensi MIT tanpa atribusi wajib, dan menyediakan gaya
regular, fill dan duotone dalam satu keluarga.

| Tempat | Gaya | Material lama -> Phosphor | Dart (`phosphor_flutter`) |
| --- | --- | --- | --- |
| Akses cepat KTA | Duotone | `badge_outlined` -> `identification-card-duotone` | `PhosphorIcons.identificationCard(PhosphorIconsStyle.duotone)` |
| Akses cepat Notifikasi | Duotone | `notifications_outlined` -> `bell-simple-ringing-duotone` | `PhosphorIcons.bellSimpleRinging(PhosphorIconsStyle.duotone)` |
| Akses cepat Tiket Saya | Duotone | `confirmation_number_outlined` -> `ticket-duotone` | `PhosphorIcons.ticket(PhosphorIconsStyle.duotone)` |
| Akses cepat Berita | Duotone | `article_outlined` -> `newspaper-clipping-duotone` | `PhosphorIcons.newspaperClipping(PhosphorIconsStyle.duotone)` |
| Tab Beranda | Regular / Fill | `home_outlined` / `home` -> `house-simple` / `house-simple-fill` | `PhosphorIcons.houseSimple()` / `(PhosphorIconsStyle.fill)` |
| Tab Event | Regular / Fill | `event_outlined` / `event` -> `calendar-dots` / `calendar-dots-fill` | `PhosphorIcons.calendarDots()` |
| Tab KTA (tengah) | Fill | `badge_outlined` / `badge` -> `identification-card-fill` | `PhosphorIcons.identificationCard(PhosphorIconsStyle.fill)` |
| Tab Jejaring | Regular / Fill | `school_outlined` / `school` -> `graduation-cap` / `graduation-cap-fill` | `PhosphorIcons.graduationCap()` |
| Tab Akun | Regular / Fill | `person_outline` / `person` -> `user-circle` / `user-circle-fill` | `PhosphorIcons.userCircle()` |
| Gembok tab terkunci | Fill | `lock` -> `lock-simple-fill` | `PhosphorIcons.lockSimple(PhosphorIconsStyle.fill)` |

Di mockup ikon ini memakai kelas `.ph-<nama>` dari `css/icons-phosphor.css`, dibangkitkan oleh
`tools/build-icons-phosphor.mjs` dari `tools/icon-list-phosphor.txt`. Cara pakainya sama dengan ikon Material: duotone
tetap dua nada karena mask memakai alfa. Ikon lain (app bar, field, kartu) masih Material Icons. Di Flutter, tambahkan
`phosphor_flutter` ke `pubspec.yaml` dan ganti ikon di `QuickAccessRow` dan `AppShell.tabs`.

## Verifikasi

- Setelah Beranda v2: 51 halaman tanpa gulir horizontal; footer kartu event dan baris berita tidak meluap.
- 51 halaman layar diperiksa otomatis di browser. Tidak ada judul yang pindah baris karena bobot w700, tidak ada
  perubahan tinggi pada 305 snackbar dan kotak info, dan tidak ada gulir horizontal di dalam ponsel.
- Kontras pasangan baru diukur dengan rumus WCAG: teks redup 5,5:1 di latar dan 6,0:1 di putih, cincin fokus 5,4:1
  (terang) dan 6,6:1 (gelap), garis field 3,3:1, titik carousel 3,1:1.

## Belum dikerjakan

- **Mode gelap.** Aplikasi belum punya tema gelap, jadi butir *checklist* mode gelap belum bisa diuji.
- **Skala teks 200 %** dan layar lebar/tablet belum dimockup (aplikasi hanya ponsel, frame 360 dp).
- **Target sentuh `InputChip` compact** (`.tag-chip--input`, target 40 dp) masih di bawah 48 dp; perlu
  `materialTapTargetSize: padded` di Dart.
- **Ukuran ikon** masih memakai banyak nilai literal (`ic-s14` sampai `ic-s34`). Kandidat token `icon.sm/md/lg`
  (16 / 20 / 24).
- Nilai v2 belum masuk `kapdh-platform/packages/design-tokens/tokens.json`. Setelah disetujui, ikuti langkah 3-6 di
  `README.md` bagian *Alur redesain kembali ke Flutter*, lalu perbarui uji golden.
