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

Rujukan desain (prinsip dan daftar periksa UI/UX) yang dipakai:

| Rujukan | Yang diambil |
| --- | --- |
| Gaya dan daftar periksa UI/UX | Gaya untuk aplikasi komunitas/keanggotaan dan organisasi keagamaan: **Soft UI Evolution + Accessible & Ethical** (bayangan lembut berlapis, radius 8-12, animasi 200-300 ms, cincin fokus 2-3 px, kontras teks minimal 4,5:1). Ditambah *Pre-Delivery Checklist*: target sentuh 48 dp, umpan balik tekan tanpa pergeseran tata letak, isi gulir tidak tertutup bilah tetap, warna bukan satu-satunya penanda. |
| Desain UI Flutter | Radius komponen seragam (12-16), kedalaman halus alih-alih desain terlalu datar, hierarki tebal-tipis judul vs isi, waktu animasi (tap 100-150 ms, transisi 250-350 ms, `easeOutCubic`), skala spasi 8. |
| UX Flutter | Tiap keadaan (memuat, kosong, galat) punya tampilan yang jelas, mikro-interaksi tombol, aksesibilitas wajib (Semantics, kontras, skala teks). |

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
| `--color-disabled-bg` / `-text` | `#DCDCE0` / `#6B6B6B` | `#E1E5DE` / `#5E665C` (4,66:1) | `KapdhColors.disabledBg`, `disabledText`: **sudah di tokens.json dan Flutter** |
| `--color-focus-ring` | `#E6D312` | `#2D7A28` (5,4:1) | `KapdhColors.focusRing`: **sudah di tokens.json dan Flutter** (KapdhFocusTheme, garis fokus 3 px tombol, `DarkSurfaceFocus`) |
| `--color-focus-ring-on-dark` | | `#E6D312` (baru) | `KapdhColors.focusRingOnDark`: **sudah di tokens.json dan Flutter** |
| `--color-card-border` | | `#E6EBE3` (baru) | token baru `cardBorder` |
| `--r-sm` / `--r-md` / `--r-lg` / `--r-xl` | 6 / 10 / 14 / 20 | 8 / 12 / 16 / 24 | `tokens.json` `radius` -> `KapdhRadius` |
| `--r-12`, `--r-16` (literal) | 12, 16 | sama dengan `--r-md`, `--r-lg` | hapus literal 12/16 di Dart, pakai `KapdhRadius.md/lg` |
| `--shadow-xs/sm/md/lg`, `--shadow-kta`, `--shadow-primary-btn`, `--shadow-bar-top`, `--ring-focus-field` | | baru | token baru `shadow.*` -> `KapdhShadows` (`List<BoxShadow>`) |
| `--dur-press/fast/base/slow`, `--ease-standard`, `--ease-out` | | 100 / 150 / 250 / 350 ms; `cubic-bezier(.2,0,0,1)` / `(.215,.61,.355,1)` | token `motion.*` + `easing.*` -> `KapdhMotion` (`Duration`, `KapdhMotion.easeStandard` / `easeOut` sebagai `Cubic`) |
| `--fw-heading` | | 700 | `KapdhTheme`: `displaySmall`, `headlineSmall`, `titleLarge` jadi `w700` |

## Perubahan komponen (`css/components.css`)

| Komponen | Perubahan v2 | Widget Dart |
| --- | --- | --- |
| Semua elemen yang dapat diketuk | State layer 8 % (hover) / 12 % (tekan) sebagai bayangan inset: mengikuti radius, tata letak tidak bergeser. Transisi 100-150 ms. Tanpa transisi bila *reduce motion*. | `InkWell` / `overlayColor`; tema `splashFactory: InkRipple` dan `animationDuration: KapdhMotion.fast` pada tombol; `NoSplash` bila *reduce motion* (`app.dart`) |
| Cincin fokus | Hijau `#2D7A28` di permukaan terang, emas di header hijau, kartu KTA, kotak nominal, snackbar | `KapdhFocusTheme` (tema tombol + `DarkSurfaceFocus`), `KapdhFocusRing` untuk kontrol `InkWell` kustom (tombol kaca, kartu KTA, ubin, kartu, banner), `KapdhFocusTheme.ringedSide` untuk tombol yang menimpa `side`, `KapdhSnackBarAction` |
| `.card`, `.summary-card`, `.status-action-card`, `.qris-card`, `.support-card`, `.account-section__card`, `.quick-access` | Garis `--color-card-border` + `--shadow-sm` | `CardTheme` (elevation 0 + `shape`), `TappableCard`, `SummaryCard`, `StatusActionCard`, `QrisImageCard`, `SupportContactCard`, `AccountSection`, `QuickAccessRow` |
| `.btn--primary` | Bayangan hijau `--shadow-primary-btn`; hilang saat nonaktif/sibuk | `KapdhButton` (`lib/design/kapdh_button.dart`) |
| `.input` | Fokus: garis 2 px primary + halo 4 px, ikon awalan ikut hijau; galat: halo merah | `KapdhTextField` (halo lewat `AnimatedContainer` + `BoxShadow` saat `Focus`) |
| `.otp__box` | Terisi: garis primary + isi `green50`. Aktif: garis primary + halo + kursor berkedip (dulu garis emas) | `OtpBoxes` (`lib/design/otp_boxes.dart`; kursor berkedip lewat `Timer`, statis bila *reduce motion*) |
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
| `.bottom-nav` | Garis rambut + bayangan ke atas `--shadow-bar-top`; indikator beranimasi 250 ms | `AppShell` (dekorasi bilah + `NavigationBar.animationDuration: KapdhMotion.base`, nol bila *reduce motion*) |
| `.snackbar` | Radius 12, margin 16 / 12, `--shadow-lg` | `SnackBarTheme` (`shape`, `insetPadding`) |
| `.dialog` | Radius 24, `--shadow-lg`, judul 20 w700 | `DialogTheme` (`shape`, `titleTextStyle`) |
| `.sheet` | `--shadow-lg`, judul w700 | `BottomSheetTheme` |
| `.popup-menu`, `.dropdown-menu` | Putih, garis rambut, radius 12, `--shadow-md` (dulu `surfaceContainer`, radius 4) | `PopupMenuThemeData`, `DropdownMenuThemeData`, `MenuThemeData`. `KapdhDropdownField` (menu `DropdownButtonFormField`) mendapat warna, radius 12 dan bayangan, tanpa garis rambut: rute menu bawaan tidak menerima garis tepi |
| `.fab-small` | `--shadow-md` | `FloatingActionButtonThemeData` (warna, radius 12) + `DecoratedBox` `shadowMd` di FAB ruang chat |
| `.ev-bar` (event), `.jj-profile-bottom` (jejaring) | `--shadow-bar-top` sebagai pemisah dari isi yang digulir | `lib/features/events/event_detail_screen.dart`, `lib/features/network/member_profile_screen.dart` |

Etalase `components.html` punya bagian baru **Radius, kedalaman dan interaksi (v2)** untuk mencoba state layer dan
fokus keyboard.

## Beranda v2: adaptasi desain `NewDesign/home.html`

Sumber: prototipe Tailwind `Unduhan/NewDesign/home.html` (16 keadaan, sama dengan `beranda/home.html`). Bahasa visualnya
diambil, lalu disesuaikan dengan aturan mockup dan rujukan desain. Keputusan pemilik: isi akses cepat tetap sesuai
aplikasi, tab KTA menjadi tombol tengah yang menonjol di semua layar, dan font tetap Poppins.

| Bagian | Diambil dari desain baru | Disesuaikan (alasan) | Widget Dart |
| --- | --- | --- | --- |
| Header | Gradasi "mesh" zamrud + cahaya emas, cincin dekoratif, sudut bawah membulat, bayangan hijau, tombol kaca persegi membulat, lencana emas bercincin | Logo KAPDH tetap ada (dalam bingkai kaca bercincin emas), bukan avatar inisial. Tombol lonceng 48 x 48 (desain 40, di bawah target 48 dp). Tombol Cari dan pil angkatan tidak diambil karena fiturnya belum ada di `HomeHeader` | `HomeHeader` |
| Navigasi bawah | Tab KTA jadi tombol tengah 56 bergradasi, naik di atas bilah | Label tetap "KTA" (teks Dart). Terpilih = cincin emas. Kolom tab tetap 72 x 64. Berlaku di 7 halaman ber-AppShell | `AppShell` |
| Banner | Titik di dalam banner (aktif emas), judul tebal | Subjudul dan tombol CTA tidak diambil karena data banner hanya berisi gambar, judul dan tautan. Gradasi kiri tidak dipakai agar ilustrasi banner tidak tertutup | `BannerCarousel` |
| Akses cepat | Kartu putih bergaris rambut + `shadowSm`, padding 15/3/13; ikon lingkaran 56 bergradasi (lihat *Akses cepat di atas banner*) | Isi: Pesan (anggota aktif) atau KTA (tidak aktif/kedaluwarsa), Notifikasi, Tiket Saya, Berita. Teks detail tetap 11 px (desain 9 px, terlalu kecil) | `QuickAccessRow` |
| Judul bagian | "Lihat semua" jadi pil tonal + chevron | Area sentuh tetap 48. Subjudul bagian tidak diambil (teks baru) | `HomeSectionTitle` |
| Kartu event | Sampul 80 x 80, ikon meta hijau, footer bergaris: status di kiri, harga di kanan | Berlaku juga di daftar Event (widget yang sama) | `EventCard` |
| Berita | Kartu pertama hero (kategori dan tanggal/suka di atas gambar), sisanya baris ringkas 80 x 80 | Hanya di Beranda; halaman Berita tetap `PostCard` biasa | `PostCard` varian hero/compact |
| Pengingat KTA | Tombol "Perpanjang" berwarna isi | Warna `warning` #8A5A00 dengan teks putih (5,9:1). Amber desain 2,1:1, gagal kontras | `_RenewalReminder` |
| Memuat | Skeleton mengikuti bentuk Beranda | Shimmer v2 bernada hijau, statis bila *reduce motion* | `LoadingSkeleton` (varian Beranda) |
| Beranda terkunci | StatusHero + tombol aksi dalam satu kartu | Judul "Akses Tersedia" tidak ditambahkan (teks baru) | `_GatedHome` |
| Keadaan kosong/galat | Ikon dalam persegi membulat | `EmptyState`/`ErrorState` di semua layar ikut berubah | `states.dart` |

Tidak diambil karena melanggar aturan mockup atau rujukan desain: Tailwind, Lucide dan foto Unsplash dari CDN,
JavaScript pengganti keadaan, teks 9-10 px, teks `slate-400` (2,6:1 di putih), modal KTA (di aplikasi tab KTA membuka
layar KTA), toast, dan data nyata pada contoh (mockup memakai "Ahmad Fauzi").

## Ikon Phosphor untuk akses cepat dan navigasi bawah

Dipilih dari perbandingan di [`ikon.html`](ikon.html) (Phosphor, Solar, Hugeicons, Fluent; Material sebagai acuan).
Phosphor termasuk set ikon yang direkomendasikan rujukan desain UI/UX, berlisensi MIT tanpa atribusi wajib, dan
menyediakan gaya regular, fill dan duotone dalam satu keluarga.

| Tempat | Gaya | Material lama -> Phosphor | Dart |
| --- | --- | --- | --- |
| Akses cepat Pesan (anggota aktif; menggantikan KTA) | Fill bergradasi | `chat_bubble_outline` -> `chat-circle-dots-fill` | `KapdhIcons.chatBubble` |
| Akses cepat KTA (KTA tidak aktif/kedaluwarsa) | Fill bergradasi | `badge_outlined` -> `identification-card-fill` | `KapdhIcons.badge` |
| Akses cepat Notifikasi | Fill bergradasi | `notifications_outlined` -> `bell-simple-ringing-fill` | `KapdhIcons.notificationsActive` |
| Akses cepat Tiket Saya | Fill bergradasi | `confirmation_number_outlined` -> `ticket-fill` | `KapdhIcons.confirmationNumber` |
| Akses cepat Berita | Fill bergradasi | `article_outlined` -> `newspaper-clipping-fill` | `KapdhIcons.newspaper` |
| Tab Beranda | Regular / Fill | `home_outlined` / `home` -> `house-simple` / `house-simple-fill` | `KapdhIcons.homeOutlined / KapdhIcons.home` |
| Tab Event | Regular / Fill | `event_outlined` / `event` -> `calendar-dots` / `calendar-dots-fill` | `KapdhIcons.eventOutlined / KapdhIcons.event` |
| Tab KTA (tengah) | Fill | `badge_outlined` / `badge` -> `identification-card-fill` | `KapdhIcons.badgeOutlined / KapdhIcons.badge` |
| Tab Jejaring | Regular / Fill | `school_outlined` / `school` -> `graduation-cap` / `graduation-cap-fill` | `KapdhIcons.schoolOutlined / KapdhIcons.school` |
| Tab Akun | Regular / Fill | `person_outline` / `person` -> `user-circle` / `user-circle-fill` | `KapdhIcons.personOutline / KapdhIcons.person` |
| Gembok tab terkunci | Fill | `lock` -> `lock-simple-fill` | `KapdhIcons.lock` |

Pembaruan audit: Phosphor kini dipakai untuk SEMUA ikon (lihat bagian Audit di bawah). Di Flutter font Phosphor dibundel
langsung (`assets/fonts/phosphor`), bukan lewat paket `phosphor_flutter` yang tidak kompatibel dengan Flutter 3.47;
nama Dart di tabel ini menjadi `KapdhIcons.<namaMaterial>` dan duotone memakai `DuotoneIcon` (ADR-027).

Di mockup ikon ini memakai kelas `.ph-<nama>` dari `css/icons-phosphor.css`, dibangkitkan oleh
`tools/build-icons-phosphor.mjs` dari `tools/icon-list-phosphor.txt`. Cara pakainya sama dengan ikon Material: duotone
tetap dua nada karena mask memakai alfa. Sejak audit, ikon app bar, field dan kartu juga Phosphor; Material Icons hanya
tersisa di ikon status bar sistem Android dan di halaman perbandingan (`ikon.html`, galeri `components.html`). 

## Audit standar desain Flutter (18 Oktober 2026)

Seluruh mockup diaudit otomatis di browser (52 halaman, sekitar 10.800 teks, semua kontrol) dan manual terhadap
daftar periksa desain UI Flutter, alur UX Flutter dan *Pre-Delivery Checklist* rujukan desain UI/UX. Tujuh temuan
diperbaiki di mockup DAN aplikasi Flutter:

| # | Temuan | Perbaikan |
| --- | --- | --- |
| 1 | Teks KTA ringkas 10 px dan 9 px (di bawah labelSmall Material 11) | Semua teks kartu minimal 11 px; label tanpa letter-spacing agar tetap satu baris (rasio kartu tetap 1,49) |
| 2 | Dua keluarga ikon dalam satu layar (Phosphor + Material) | Semua ikon aplikasi Phosphor lewat `KapdhIcons` (ADR-027); 444 pemakaian di 96 berkas Flutter dan 4.037 ikon mockup dari satu pemetaan |
| 3 | Tab KTA tengah terpilih hanya cincin emas (1,5:1 di bilah putih) | Terpilih: isi emas, ikon gelap, cincin primary 2 px (11:1), label w700 |
| 4 | Radius 18 di luar skala | Tombol KTA tengah radius 16 |
| 5 | Pil belum dibaca percakapan dibisukan 3,3:1 | `neutral700` (9,3:1) |
| 6 | Chip reaksi chat 32 dp tanpa target 48 | Padding vertikal 8 ikut menerima ketukan (target 48) |
| 7 | Hapus chip filter/undangan/pilihan hanya ikon 16-18 px (area ketuk terukur 32 x 40) | Seluruh chip menghapus (`onPressed`), kepadatan standar, baris pemilih padding 4 agar chip setinggi 48 |

Hasil audit ulang: 0 ikon Material di dalam layar (kecuali status bar sistem), tidak ada teks di bawah 11 px,
radius hanya 8/12/16/24 (+ badge 9, segmen 20), tidak ada kontras teks gagal selain teks di atas foto/gradasi yang
memang berscrim. Target sentuh di bawah 48 yang tersisa adalah tautan di dalam paragraf berita (pengecualian WCAG
2.5.8) dan komponen Material yang targetnya diperluas margin (ChoiceChip, SegmentedButton, TabBar).

Saat audit ini mode gelap belum ada; kini sudah dimockup (bagian *Mode gelap, teks 200 %, tablet dan token ikon*).
Pemindahan usulan v2 lain (token warna, header Beranda, tombol KTA tengah) ke Flutter tercatat di *Belum dikerjakan*.

## Mode gelap, teks 200 %, tablet dan token ikon (P2, 18 Oktober 2026)

Usulan mockup saja; Flutter belum. Semua 52 layar bisa dilihat dalam tiap mode lewat tombol di strip kepala
(`js/theme.js`) atau parameter URL `?theme=dark`, `?ts=2`, `?device=tablet`.

**Mode gelap** (`:root[data-theme="dark"]` di `css/tokens.css`). Varian tonal yang lebih terang dan tidak jenuh,
bukan warna dibalik. Permukaan bertingkat: latar `#0F1A0E` < permukaan `#172416` < permukaan terangkat `#1D2C1B`
(dialog, sheet, menu). Primary menjadi `#8BD47E` dengan teks `#0E280C` di atasnya (pola Material 3 gelap). Pita
hijau merek (header Beranda, Welcome, kartu KTA) tidak berubah. Agar warna ikut berganti, nilai literal di CSS diganti
token semantik baru: `--color-tint`, `--color-tint-strong`, `--color-surface-raised`, `--color-icon-accent`,
`--color-on-surface-disabled`, `--color-statusbar`, `--color-sysnav`, `--color-skeleton`, `--color-on-danger`.

| Pasangan (gelap) | Kontras |
| --- | --- |
| Teks di latar/permukaan | 13,5–14,9 : 1 |
| Teks redup | 6,5–8,0 : 1 |
| Primary sebagai teks | 9,1 : 1 |
| Teks status (sukses, peringatan, bahaya, info) | 7,1–8,7 : 1 |
| Garis field | 3,9 : 1 |
| Cincin fokus emas `#E6D312` | 10,5 : 1 |

Audit otomatis 52 halaman dalam mode gelap: 10.218 teks, 0 gagal (setelah 9 pola diperbaiki: teks putih di pita
gelap memakai `--color-text-on-dark`, kutipan di gelembung sendiri `rgba(255,255,255,.92)` 5,45:1 di kedua mode).

**Teks 200 %** (WCAG 1.4.4). Semua ukuran huruf layar menjadi `calc(Npx * var(--ts, 1))` (84 nilai + token
`--fs-*`); ikon, jarak dan tinggi komponen tidak ikut, sama seperti `MediaQuery.textScaler`. Skala dibuat linear
sebagai kasus terburuk; Android 14 menskalakan huruf besar secara nonlinier. Status bar sistem tidak ikut. Temuan dan
usulan:

| Temuan pada 200 % | Usulan (di mockup) | Flutter nanti |
| --- | --- | --- |
| 5 label navigasi bawah bertabrakan | Skala label dibatasi 1,3 | `MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3)` di `NavigationBar` |
| 4 label akses cepat Beranda bertabrakan | Ubin menjadi 2 x 2 bila skala > 1,3 | Ambang `--text-scale-stack` seperti `StatusActionCard` |
| Judul kartu event/berita, nama header, pratinjau chat terpotong | Dibiarkan: sesuai `maxLines` + elipsis di Dart | Pastikan teks lengkap ada di layar detail |
| Label stepper pendaftaran meluap ("Pembayaran" lebih lebar dari kolomnya) | Bila skala > 1,3 hanya label langkah aktif yang tampil, satu baris selebar stepper; langkah lain tetap dibacakan | `KapdhStepper`: cabang `textScaler.scale(12) > 12 * 1.3`; `Semantics` "Langkah n dari 4: ..." tetap |
| Email/token panjang meluap (OTP, profil anggota, tautan bantuan, galat konfigurasi) | Kata yang lebih panjang dari barisnya dipecah (`overflow-wrap: break-word`), email di baris ikon `min-width: 0` | Perilaku bawaan `Text`; di `Row` bungkus dengan `Flexible` |
| Tombol teks panjang meluap ("Buka peta lokasi (tautan luar)", "Isi rekening tujuan refund") | Label boleh pindah baris | `TextButton` tanpa `maxLines: 1`, tidak di `Row` tanpa `Flexible` |
| "24 suka" meluap di samping chip kategori berita | Baris atas kartu menjadi `Wrap` | `Wrap` sebagai ganti `Row` |
| Judul banner menumpuk gambar | Skala judul dibatasi 1,3 | `MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3)` di keterangan banner |
| Petunjuk field panjang terpotong ("Masukkan Passw…") | Diterima: label di atas field sudah lengkap, petunjuk hanya contoh | Tetap `hintMaxLines` 1 |

Tab Jejaring, kategori Event dan strip chip penerima memang bisa digeser ke samping (`overflow-x: auto` di mockup),
jadi tab yang keluar layar bukan luapan. Keyboard sistem tiruan dan status bar tidak ikut skala teks aplikasi, dan
keyboard mengikuti tema gelap (token `--color-keyboard*`, warna Gboard gelap).

Frame ber-tinggi tetap memotong isi; untuk melihat seluruh isi pada 200 % pakai frame "Gulir penuh".

**Tablet** (`:root[data-device="tablet"]`). Frame 800 x 1280 dp (kelas lebar *medium* Material 3). Isi
`.screen__body` dibatasi `--content-max-w` 600 px di tengah; app bar, header, navigasi bawah dan latar tetap selebar
layar. Di Flutter: `Center` + `ConstrainedBox(maxWidth: 600)` di tiap layar. Navigasi bawah selebar 800 dp masih
terasa renggang; pada lebar >= 840 dp sebaiknya pindah ke `NavigationRail` (belum dimockup).

**Latar Splash** (usulan). Mode terang memakai gradasi abu terang `--gradient-splash` (#FAFAFA → #EEEFED →
#E2E4E1, atas ke bawah) sebagai ganti hijau tua; mode gelap tetap hijau tua `surfaceDark`. Karena emas di abu hanya
1,4:1, judul, spinner, ikon masalah dan tombol "Coba lagi" menjadi primary (7,96:1 terang, 8,9:1 gelap), pesan
text-muted (4,65:1), status bar ikon gelap. Halaman galat konfigurasi tetap hijau tua. Flutter nanti: `Scaffold` dengan
`DecoratedBox(gradient)` dan `SystemUiOverlayStyle.dark`; splash native (`flutter_native_splash`) perlu warna
`#FAFAFA` agar transisinya mulus.

**Header Profil Alumni** (usulan, `jejaring/member-profile.html`). Dulu pita hijau bermotif 112 dp yang kosong
(hanya tombol kembali dan menu), lalu avatar 72 dan nama rata kiri di bawahnya. Sekarang pita zamrud 132 dp dengan
bahasa visual header Beranda v2: gradasi 135° green950 → green800 → green700, cahaya emas kanan atas dan hijau kiri
bawah, dua cincin dekoratif tanpa motif (identik dengan Beranda), sudut bawah 24 dan garis emas tipis. Tombol kembali dan menu
menjadi tombol kaca 48 dp, dengan judul "Profil Alumni" di tengah agar pengguna tahu sedang di mana. Avatar membesar
ke 96 dp dengan cincin permukaan 4 dan cincin emas 2, menumpuk tepi pita sejauh 48. Nama dan kontak terpusat di
bawahnya. Judul putih di pita 7,9:1 pada titik henti tercerah (green700); pita memakai palet merek tetap, jadi sama di mode gelap. Lolos teks
200 % dan tablet. Flutter nanti: `BrandHeader(minHeight: 132)` + `Transform.translate(offset: Offset(0, -48))`
untuk avatar.

**Ubah Profil: Profesi & Keahlian, Riwayat Pendidikan dan Media Sosial** (usulan, `akun/profile-edit.html`). Tiga kartu berkepala
(ikon 24 primary, judul 17 w700, deskripsi 12 abu, garis pemisah) sesuai gambar acuan:

- *Profesi & Keahlian*: label, cip terpilih bernada `--color-tint` yang seluruhnya menghapus (pil 36, area ketuk 48),
  pemilih "Pilih atau tambah…" (daftar master atau ketik sendiri) dan helper. Profesi kini boleh lebih dari satu;
  batas keahlian 10 pindah ke helper.
- *Riwayat Pendidikan* menggantikan *Lulusan Terakhir* (Institusi + Kota). Entri berulang "Pendidikan n" dengan tombol
  hapus merah, Universitas/Instansi, Jurusan/Program Studi, Strata (pilihan D3/S1/S2/S3/Lainnya, di acuan teks bebas),
  Tahun Tamat (pilihan, helper "Tahun ijazah terbit.") dan "Tambah Riwayat".

- *Media Sosial* menggantikan 4 field tetap (Instagram, X, Facebook, LinkedIn). Kini baris tautan berulang, maksimal
  10. Tiap baris punya pemilih platform berlogo, tombol hapus, dan field nama pengguna/tautan. Platform yang tersedia:
  Instagram, TikTok, X (Twitter), Facebook, LinkedIn, YouTube, Threads, Telegram, Situs web. Logo dari Phosphor bobot
  regular agar tetap satu keluarga ikon. Helper menyebut batas 10 dan aturan privasi; di bawahnya "Tambah tautan".
  Frame 17 menampilkan menu platform yang terbuka.

Tombol hapus di kedua daftar berulang (Pendidikan, tautan) sama-sama merah (acuan Media Sosial abu) agar satu makna
satu warna. Label tetap tampil di atas field (bukan hanya placeholder seperti acuan) agar sesuai bagian lain dan tetap terbaca saat
terisi. Bagian lain di layar ini masih memakai judul kecil di atas kartu.

Dampak di luar mockup: kontrak profil (C1) perlu `professions: string[]` dan `education: [{institution, major, level,
graduation_year}]` sebagai ganti `profession`, `last_education_institution` dan `last_education_city`, serta `social_links: [{platform, value}]`
(maks. 10) sebagai ganti field Instagram/X/Facebook/LinkedIn. Profil Alumni
(Jejaring) sudah ikut diubah di mockup:

- "Riwayat Pendidikan" berupa daftar ikon toga, institusi, dan "Strata · Jurusan · Tamat tahun", terbaru di atas;
- Profesi bisa lebih dari satu cip;
- "Skill" menjadi "Keahlian";
- "Media Sosial" berupa baris 56 dp berlogo platform, nama platform, nama pengguna primary, dan ikon tautan luar. Lihat juga master profesi/keahlian yang menerima
nilai ketikan sendiri.

**Akses cepat di atas banner, ikon lingkaran** (usulan, sesuai gambar acuan). Menu cepat kini tepat di bawah header
Beranda, sebelum banner, juga di skeleton memuat. Ikon menjadi lingkaran 56 dp:

- latar gradasi lembut `--qa-circle-bg` dengan sorot kiri atas, garis tipis, bayangan halus;
- ikon Phosphor *fill* 28 dp berisi gradasi hijau `--qa-icon` (#4A9441 → green800 → green950), lebih terang di mode gelap;
- label 13 w700;
- jumlah belum dibaca pindah dari teks kecil ke lencana emas di pojok lingkaran. Teks status KTA (keadaan tidak aktif
  atau kedaluwarsa) tetap di bawah label.

Isi menu tetap: Pesan, Notifikasi, Tiket Saya, Berita (KTA ada di tab tengah). Di Flutter: `QuickAccessRow` di atas
`BannerCarousel` dalam `_ActiveHome`; ikon lingkaran `qaCircle` + `ShaderMask` `qaIcon` di atas `Icon(KapdhIcons.*)`
fill (codepoint fill sudah di `phosphor-codepoints.json`) + lencana emas.

**Akses cepat: Pesan menggantikan KTA** (usulan). Untuk anggota aktif, ubin pertama kini "Pesan" (jumlah percakapan
belum dibaca, ke tab Jejaring > Pesan), karena KTA sudah bisa dibuka dari tombol tengah navigasi bawah sehingga ubin KTA
dobel. Pada KTA tidak aktif atau kedaluwarsa ubin KTA tetap (status KTA penting di sana dan Jejaring terkunci). Di
Flutter: `QuickAction` pertama di `_QuickAccess` memakai `KapdhIcons.chatBubble` (`ph:chat-circle-dots-fill`) dengan
lencana dari penghitung chat yang sudah ada (`chatBadgeCountsProvider`) dan membuka tab Jejaring > Pesan.

**Semua pita hijau disamakan** (usulan). Sebelumnya ada empat gaya pita: gradasi datar (Status Akun, Dibatasi,
alur daftar/OTP/lupa password, pembayaran), quatrefoil (Akun), gelombang (Masuk) dan mesh zamrud (Beranda, Profil
Alumni). Sekarang semua `.brand-band` memakai dasar yang sama dengan header Beranda:

- token `--gradient-brand-mesh`: 135° green950 → green800 → green700, cahaya emas kanan atas, cahaya hijau kiri bawah;
- dua cincin dekoratif;
- tombol ikon kaca 48 dp;
- logo pita sapaan dalam bingkai kaca bercincin emas (48 dp, dulu 44).

Hanya layar Masuk yang tetap bermotif (gelombang, atas permintaan desain). Akun dan Profil Alumni tanpa motif dan bersudut
bawah 24, identik dengan header Beranda; kelas `.brand-band--pattern` (quatrefoil) tidak lagi dipakai layar. Sudut bawah 24 dan
bayangan untuk pita yang berdiri sendiri (Beranda, Profil Alumni, Akun); pita yang ditumpuk lembar terang tetap lurus
karena lembarnya sudah membulat. Pengisi status bar layar Masuk mengikuti tepi atas mesh. App bar putih di layar
detail sengaja tidak diubah (pola Material 3). Flutter nanti: `KapdhGradients.brandMesh` dipakai `BrandHeader` dan
`HomeHeader`, cincin sebagai satu `CustomPainter` bersama.

**Token ukuran ikon** (usulan `KapdhIconSize`): `--ic-xs` 14, `--ic-sm` 16, `--ic-btn` 18, `--ic-md` 20,
`--ic-lg` 24 (bawaan), `--ic-xl` 28. Kelas `.ic-s14` sampai `.ic-s28` dan 47 nilai `--ic-size` di komponen kini
memakai token; nilainya sama, jadi tidak ada perubahan visual. Ukuran lain (10, 12, 15, 22, 26, 30–64) tetap literal
karena memang khusus (ilustrasi keadaan kosong, lencana, status bar, ubin akses cepat).

## Verifikasi

- Setelah Beranda v2: 51 halaman tanpa gulir horizontal; footer kartu event dan baris berita tidak meluap.
- 51 halaman layar diperiksa otomatis di browser. Tidak ada judul yang pindah baris karena bobot w700, tidak ada
  perubahan tinggi pada 305 snackbar dan kotak info, dan tidak ada gulir horizontal di dalam ponsel.
- Kontras pasangan baru diukur dengan rumus WCAG: teks redup 5,5:1 di latar dan 6,0:1 di putih, cincin fokus 5,4:1
  (terang) dan 6,6:1 (gelap), garis field 3,3:1, titik carousel 3,1:1.

## Implementasi Flutter (18 Oktober 2026)

Usulan v2 di dokumen ini sudah diterapkan ke `kapdh-mobile` (tanpa perubahan kontrak server):

| Bagian | Di Flutter |
| --- | --- |
| Token | `tokens.json` v2 (latar, teks redup, garis, garis kartu, tint, radius 8/12/16/24, bayangan `elevation`, `motion`, ukuran `icon`, gradasi mesh/splash, palet `dark`) -> `build.mjs` -> `KapdhColors`, `KapdhDarkColors`, `KapdhShadows(Dark)`, `KapdhMotion`, `KapdhIconSize`. Admin dan web ikut mendapat radius dan warna v2 lewat `kapdh-theme.css`. |
| Tema | `KapdhPalette` (ThemeExtension, `context.kc`) untuk terang dan gelap; `KapdhTheme.dark()` + `themeMode: ThemeMode.system`. Judul w700, dialog/lembar radius 24, menu dan snackbar radius 12 bergaris rambut, chip tidak terpilih bergaris, halo fokus field (`KapdhHaloBorder`), tombol teks berfont Poppins. |
| Komponen | Tombol utama berbayangan, OTP aktif bergaris primary + halo + kursor berkedip (statis bila *reduce motion*), kartu bergaris rambut + `shadowSm` (TappableCard, SummaryCard, StatusActionCard, QRIS, kontak, AccountSection, akses cepat), InfoBox bergaris 20 %, keadaan kosong/galat berikon persegi membulat, skeleton berkilau (`KapdhShimmer`), SectionEmpty bergaris putus, bilah aksi bawah berbayangan. |
| Pita hijau | `BrandMeshPainter` di semua `BrandHeader`; `BrandIconButton` (tombol kaca), `BrandLogoFrame`; header Beranda, Akun dan Profil Alumni bersudut bawah 24. Masuk tetap bermotif gelombang. |
| Beranda | Akses cepat di atas banner, ikon fill bergradasi dalam lingkaran 56, Pesan (membuka tab Jejaring > Pesan) menggantikan KTA untuk anggota aktif, lencana emas belum dibaca; tombol KTA tengah menonjol; titik banner di dalam gambar; judul bagian dengan pil "Lihat semua"; kartu event berfooter; berita hero + baris ringkas; skeleton berbentuk Beranda; Beranda terkunci dalam satu kartu; tombol Perpanjang terisi. |
| Layar lain | Splash abu terang (gelap tetap hijau tua; latar peluncuran Android/iOS ikut), Ubah Profil (kartu Profesi & Keahlian dengan cip yang dapat dihapus, Riwayat Pendidikan, Media Sosial berlogo), Profil Alumni (Riwayat Pendidikan, Keahlian, Media Sosial berupa baris). |
| Teks 200 % | Label navigasi dan judul banner dibatasi 1,3; kepala Beranda 1,3 seperti app bar; akses cepat 2 x 2; stepper hanya label aktif; judul bagian membungkus. |
| Tablet | `ContentWidth`: isi selebar 600 di tengah pada layar > 640 (AppScaffold, BrandSheetScaffold, Beranda, Jejaring, Akun, Profil Alumni). |
| Fokus dan gerak | Cincin fokus 3 px di semua kontrol yang dapat diketuk (emas di permukaan hijau), `KapdhMotion` + kurva `easeStandard`/`easeOut` di navigasi bawah, banner, KTA layar penuh dan gulir chat; semuanya diam bila *reduce motion*. Status bar berikon terang di semua pita hijau (`kBrandStatusBarOverlay`); Akun dan Profil Alumni menahan area status bar tetap hijau saat pita tergulir (`BrandStatusBarFill`). |
| Ikon | Phosphor di seluruh layar, termasuk ikon bawaan (tombol kembali/tutup AppBar lewat `actionIconTheme`, hapus cip, menu titik tiga); ukuran ikon komponen inti memakai `KapdhIconSize`. Satu pengecualian: tombol luapan (titik tiga/kembali) toolbar seleksi teks Android ditulis langsung di SDK dan tetap Material; menggantinya butuh `contextMenuBuilder` kustom di setiap field. |

Verifikasi: `flutter analyze` bersih dan seluruh uji widget lolos; pratinjau render (font nyata) Beranda terang,
gelap, teks 200 % dan tablet dibandingkan dengan mockup.

## Belum dikerjakan

- **Kontrak profil berulang** (keputusan pemilik: menyusul). `professions[]`, `education[]`
  (`institution, major, level, graduation_year`) dan `social_links[]` (maks. 10) di OpenAPI, basis data, API, SDK
  Dart, admin dan filter direktori. Sampai itu Ubah Profil/Profil Alumni memakai satu profesi, satu pendidikan
  (institusi + kota) dan empat media sosial tetap; tombol "Tambah Riwayat"/"Tambah tautan" dan Strata/Tahun Tamat belum
  ada di aplikasi.
- **NavigationRail** untuk layar >= 840 dp (tablet melebar): belum dimockup.
- **Peluncuran iOS** memakai warna bernama `LaunchBackground` (terang/gelap) di `LaunchScreen.storyboard`; belum
  dibangun di Mac.
