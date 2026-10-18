# Audit UI/UX Mockup KAPDH v2 — 18 Oktober 2026

Catatan kerja untuk implementasi lanjutan. Audit dilakukan pada mockup yang **berjalan live** di
`http://localhost:5178/` (52 layar), bukan dengan membaca dokumen lama. Semua angka di bawah diukur
dari DOM dan CSS terkompilasi, bukan perkiraan.

## Status (diperbarui 18 Oktober 2026)

- **P0-1 dan P0-2 selesai** lewat `tokens.json` -> `build.mjs` (bukan edit langsung `kapdh_tokens.dart`; CI
  membandingkannya dengan `cmp`). `disabled-bg` ikut ke `#E1E5DE` karena `#5E665C` di `#DCDCE0` hanya 4,35:1.
  Cincin fokus Flutter: `lib/app/theme/kapdh_focus.dart` (`KapdhFocusTheme`, `DarkSurfaceFocus`), garis 3 px tombol
  Material dan `KapdhButton`.
- P2-3 `.tag-chip--input` 40 dp sudah diperbaiki sebelumnya (commit `5959651`, target 48).
- **P2-2 dan P2-3 selesai di mockup** (belum di Flutter): mode gelap untuk 52 layar (`:root[data-theme="dark"]`,
  audit 10.218 teks 0 gagal), pratinjau teks 200 % dan tablet 800 x 1280, token ikon `--ic-xs`…`--ic-xl`.
  Tombol Tema / Teks / Perangkat di strip kepala (`js/theme.js`). Rincian, kontras dan temuan 200 % di
  `kapdh-mobile/mockup-html/REDESAIN.md` bagian *Mode gelap, teks 200 %, tablet dan token ikon*.
- **P1-1, P1-2, P2-1, P2-2 dan P2-3 selesai di Flutter** (18 Oktober 2026): token v2 di `tokens.json`
  (termasuk palet gelap, bayangan, gerak, ukuran ikon), `KapdhPalette` + `KapdhTheme.dark()` + `ThemeMode.system`,
  judul w700, Beranda v2, pita mesh seragam, teks 200 % dan tablet. Rincian: `kapdh-mobile/mockup-html/REDESAIN.md`
  bagian *Implementasi Flutter*. Kontrak profil berulang menyusul.
- Proyek tidak punya uji golden; perubahan warna/radius tertangkap uji widget.

## Konteks branch

| Hal | Nilai |
| --- | --- |
| Worktree | `.claude/worktrees/flutter-ui-ux-skills-cc4d37` |
| Branch | `claude/flutter-ui-ux-skills-cc4d37` |
| Basis | `main` = `89db9f4` (mockup "apa adanya", **belum ada v2 sama sekali**) |
| Commit v2 | 10 commit di depan `main`, puncaknya `5959651` |
| Server mockup | `node kapdh-mobile/mockup-html/tools/serve.mjs` → port 5178 |
| Dokumen desain | `kapdh-mobile/mockup-html/REDESAIN.md` |

Seluruh nilai v2 (`#F5F7F3`, `#2D7A28`, radius 8/12/16/24, ikon Phosphor) **hanya ada di branch ini**.
`main` masih memakai `#FBFAFF`, radius 6/10/14/20, dan Material Icons.

## Yang sudah benar — jangan diubah

Diukur pada 7 layar perwakilan (Beranda, Masuk, KTA, Event, Jejaring, Akun, App Shell).

| Aspek | Hasil ukur |
| --- | --- |
| Satu keluarga ikon | 315 ikon Phosphor di Beranda, **0 Material** di area konten. Sisa `signal_cellular_alt`/`wifi`/`battery_full` hanya status bar sistem Android dan memang sengaja tidak dipetakan |
| Duotone benar-benar render | `mask-image` aktif + `background: rgb(26,75,23)`; bukan kotak kosong |
| Kontras teks utama | muted `#5E665C` = **5,52:1** di latar; fokus `#2D7A28` = **4,96:1**; emas `#E6D312` di hijau `#1A4B17` = **6,64:1** |
| Teks di bawah 11 px | **0** temuan di 7 layar |
| Gulir horizontal | **0** di semua layar |
| Target sentuh < 44 px | **0** di area aplikasi (setelah chrome dokumentasi dikecualikan) |
| Gradien header | Kontras putih di semua titik henti gradien: 6,66–15,82:1 — aman |

Rekomendasi gaya dari skill `ui-ux-pro-max` untuk produk *Membership/Community* adalah
**Soft UI Evolution + Accessible & Ethical** — dan itulah yang sudah dipakai. Output warna/font
otomatis dari skill tersebut (ungu `#7C3AED`, Cormorant Garamond) **harus diabaikan**: itu template
generik yang tidak cocok. Hijau `#1A4B17` + emas `#E6D312` + Poppins sudah tepat.

## Koreksi: tiga klaim yang tidak terbukti

Tiga temuan dari audit sebelumnya **gugur setelah diverifikasi ulang**. Jangan dikerjakan.

**1. "`Lihat semua` target sentuh hanya 32 px" — SALAH.**
`<a>` memang 117 × 32 px, tetapi `.section-title__more::before { inset: -8px 0 }` memperluas area
klik. Uji hit-test pada titik −7 px dan +7 px di luar kotak elemen tetap mengenai `<a>`; tinggi
efektif terukur **48 px**. `REDESAIN.md` sudah akurat di sini.

**2. "`icon-map-phosphor.json` kehilangan 4 ikon duotone" — SALAH.**
Keempatnya (`bell-simple-ringing-duotone`, `identification-card-duotone`,
`newspaper-clipping-duotone`, `ticket-duotone`) ada di `tools/icon-list-phosphor.txt`, dan
`build-icons-phosphor.mjs` menggabungkan `Object.values(map)` dengan `extra`. Menjalankan ulang
skrip tidak akan menghilangkannya.

**3. "`ic-s26` adalah drift ukuran ikon" — SALAH.**
13 pemakaian `ic-s26`, **semuanya** tombol kembali di `.sheet-title-row` (sheet pembayaran). Itu
konteks yang sah, bukan nilai acak. `ic-s30` dan `ic-s20` masing-masing hanya 1 pemakaian di
`components.html` (halaman spesimen), bukan di layar aplikasi.

## Temuan yang terbukti — kerjakan ini

### P0-1. Kontras teks nonaktif 3,68:1

`--color-disabled-text: #6E766C` di atas `--color-disabled-bg: #E1E5DE` = **3,68:1**.
Nilai v2 justru menggeser dari `#6B6B6B` (3,9:1) ke `#6E766C` — makin pucat.

Terdampak: tombol "Masuk" nonaktif, "Memeriksa…", "Coba lagi dalam 4:59", "Perpanjang".

Catatan kejujuran: WCAG 1.4.3 **mengecualikan** komponen nonaktif, jadi ini bukan pelanggaran.
Tapi checklist `ui-ux-pro-max` meminta 4,5:1 dan secara praktis teksnya tidak terbaca.

**Perbaikan** — ubah di dua tempat:

```
kapdh-mobile/mockup-html/css/tokens.css
  --color-disabled-text: #5E665C;   /* 4,66:1 — samakan dengan --color-text-muted */

kapdh-mobile/lib/app/theme/kapdh_tokens.dart  (lihat P1-1 soal duplikasi file)
  static const disabledText = Color(0xFF5E665C);
```

Verifikasi: rasio `#5E665C` pada `#E1E5DE` = 4,66:1.

### P0-2. Cincin fokus v2 tidak terpasang di Flutter

`--color-focus-ring` di mockup sudah `#2D7A28` (5,4:1), tetapi:

- `KapdhColors.focusRing` di Dart masih `Color(0xFFE6D312)` — emas, 1,5:1 di permukaan terang.
- `focusRing` **tidak dipakai sama sekali** di `kapdh_theme.dart`; hanya dideklarasikan.

Artinya perbaikan WCAG 1.4.11 yang paling penting di v2 belum sampai ke aplikasi.

**Perbaikan:**

```dart
// kapdh_tokens.dart
static const focusRing = Color(0xFF2D7A28);
static const focusRingOnDark = Color(0xFFE6D312);  // token baru
```

Lalu pasang di `KapdhTheme.light()`:

```dart
focusColor: KapdhColors.focusRing,
```

Untuk permukaan gelap (header hijau, kartu KTA, snackbar) pakai `focusRingOnDark`.

### P1-1. Token Flutter menyimpang dari mockup v2

`tokens.json` **belum pernah** diperbarui ke nilai v2. Ini sudah tercatat di `REDESAIN.md`
bagian *Belum dikerjakan*, dan terbukti saat diukur:

| Token | Mockup v2 | Flutter (`kapdh_tokens.dart`) |
| --- | --- | --- |
| `background` / `neutral50` | `#F5F7F3` | `#FBFAFF` |
| `textMuted` | `#5E665C` | `#6B6B6B` |
| `divider` | `#E1E6DE` | `#E3E3E6` |
| `disabledBg` | `#E1E5DE` | `#DCDCE0` |
| `disabledText` | `#6E766C` | `#6B6B6B` |
| `focusRing` | `#2D7A28` | `#E6D312` |
| `radius.sm` | 8 | 6 |
| `radius.md` | 12 | 10 |
| `radius.lg` | 16 | 14 |
| `radius.xl` | 24 | 20 |

`border`, `neutral200`, `neutral300`, `neutral500`, `neutral600`, `neutral700` sudah sama.

**Penting — file Dart terduplikasi.** `kapdh_tokens.dart` ada di **dua** lokasi dengan isi identik,
dan `kapdh-mobile/pubspec.yaml` **tidak** mendeklarasikan dependensi ke package `design-tokens`:

```
kapdh-platform/packages/design-tokens/flutter/lib/kapdh_tokens.dart   ← sumber, dibangkitkan build.mjs
kapdh-mobile/lib/app/theme/kapdh_tokens.dart                          ← salinan manual
```

Keduanya harus diubah bersamaan, atau lebih baik: jadikan `design-tokens` sebagai path dependency
agar tidak ada salinan yang bisa menyimpang.

**Alur pembaruan:**

1. Ubah `kapdh-platform/packages/design-tokens/tokens.json`:
   - `color.neutral.50` → `#F5F7F3`
   - `color.semantic.background` → `#F5F7F3`
   - `color.semantic.text-muted` → `#5E665C`
   - `color.semantic.divider` → `#E1E6DE`
   - `color.semantic.disabled-bg` → `#E1E5DE`
   - `color.semantic.disabled-text` → `#5E665C` (setelah P0-1)
   - `color.semantic.focus-ring` → `#2D7A28`
   - `radius.sm/md/lg/xl` → `8 / 12 / 16 / 24`
2. Tambah token baru yang belum ada di `tokens.json`:
   - `color.semantic.focus-ring-on-dark` = `#E6D312`
   - `color.semantic.card-border` = `#E6EBE3`
3. Jalankan generator: `node kapdh-platform/packages/design-tokens/build.mjs`
   (catatan: `README.md` masih menyebut `build.py` — dokumentasi usang, yang ada `build.mjs`).
4. Salin hasil ke `kapdh-mobile/lib/app/theme/kapdh_tokens.dart`.
5. Perbarui uji golden Flutter — banyak snapshot akan berubah warna dan radius.

### P1-2. Token bayangan dan gerak belum ada di `tokens.json`

Mockup v2 mendefinisikan 7 bayangan dan 4 durasi; `tokens.json` hanya punya `shadow.card` dan
`shadow.raised`. Belum ada padanan `KapdhShadows` / `KapdhMotion` di Dart sama sekali.

Yang perlu ditambahkan:

```css
--shadow-xs:           0 1px 2px rgba(14,40,12,.06)
--shadow-sm:           0 1px 2px rgba(14,40,12,.04), 0 2px 8px rgba(14,40,12,.06)
--shadow-md:           0 2px 4px rgba(14,40,12,.05), 0 8px 20px rgba(14,40,12,.08)
--shadow-lg:           0 4px 8px rgba(14,40,12,.08), 0 16px 40px rgba(14,40,12,.18)
--shadow-kta:          0 4px 8px rgba(2,7,2,.14), 0 14px 32px rgba(14,40,12,.28)
--shadow-primary-btn:  0 1px 2px rgba(14,40,12,.16), 0 4px 12px rgba(26,75,23,.24)
--shadow-bar-top:      0 -1px 0 var(--color-divider), 0 -6px 20px rgba(14,40,12,.06)

--dur-press: 100ms    --dur-fast: 150ms
--dur-base:  250ms    --dur-slow: 350ms
--ease-standard: cubic-bezier(.2,0,0,1)        /* Easing.standard */
--ease-out:      cubic-bezier(.215,.61,.355,1) /* Curves.easeOutCubic */
```

Di Dart menjadi `KapdhShadows` (`List<BoxShadow>`) dan `KapdhMotion` (`Duration`, `Curves`).

### P2-1. Judul Flutter masih w600, mockup v2 w700

`--fw-heading: 700` di mockup, tapi `kapdh_theme.dart` baris 59:

```dart
: _poppins(fontSize: size, fontWeight: FontWeight.w600, color: KapdhColors.text, height: 1.25);
```

Cabang `useTelegraf` sudah `w700`, cabang Poppins masih `w600`. Perlu disamakan jadi `w700` untuk
`displaySmall`, `headlineSmall`, `titleLarge`.

Risiko: teks judul berbahasa Indonesia bisa pindah baris. Uji ulang setelah diubah.

### P2-2. Mode gelap belum ada

`KapdhTheme.light()` adalah satu-satunya tema. `kapdh-mobile/lib/app/app.dart` hanya memasang
`theme:` tanpa `darkTheme:` dan `themeMode:`. Skill `flutter-ai-ui-skill` menandai ini **High**.

Ini pekerjaan besar (1–2 hari), bukan tambalan. Butuh:

- `KapdhTheme.dark()` dengan `Brightness.dark`
- Token permukaan gelap (`surfaceDark` sudah ada = `#0E280C`, tapi belum ada set lengkap)
- `darkTheme` + `themeMode: ThemeMode.system` di `app.dart`
- Audit ulang kontras seluruh layar pada latar gelap
- Uji ulang 52 layar mockup dengan varian gelap (mockup belum punya)

Saran: kerjakan setelah P0 dan P1 selesai dan sudah masuk `main`.

### P2-3. Sisa dari `REDESAIN.md` yang masih terbuka

- **Skala teks 200 %** dan layar lebar/tablet belum dimockup (frame hanya 360 dp).
- **`.tag-chip--input`** target 40 dp, di bawah 48; perlu `materialTapTargetSize: padded` di Dart.
- **Ukuran ikon literal**: CSS mendefinisikan 16 kelas (`ic-s10` … `ic-s64`) dengan 17 nilai
  `--ic-size` berbeda. Kandidat token `icon.sm/md/lg` = 16/20/24. Prioritas rendah — pemakaian
  nyata di layar aplikasi hanya 16, 26, 28.

## Ikon: tetap Phosphor, jangan pindah

Alasan terukur: lisensi MIT tanpa atribusi, 6 bobot dalam satu keluarga, duotone satu warna
sehingga hijau merek tetap dominan, dan sudah 4.544 pemakaian di mockup + 444 di 96 berkas Flutter
(ADR-027).

| Permukaan | Bobot | Alasan |
| --- | --- | --- |
| Ubin akses cepat | Duotone | Aksen visual, satu warna → merek tetap dominan |
| Navigasi bawah (pasif) | Regular | Bobot garis konsisten dengan teks |
| Navigasi bawah (aktif) | Fill | Beda bentuk, bukan cuma warna (WCAG 1.4.1) |
| Body / list / appbar | Regular | Netral, tidak bersaing dengan judul |
| Status konfirmasi | Fill | Bobot lebih tegas untuk makna "selesai" |

**Tolak Solar Bold Duotone.** Lebih mewah secara visual, tetapi menambah kewajiban atribusi
CC BY 4.0 ("Solar by 480 Design") di seluruh aplikasi. Tidak sepadan untuk keuntungan sekecil itu.

Implementasi Flutter sudah benar: font dibundel langsung di `kapdh-mobile/assets/fonts/phosphor/`
(`Phosphor-Regular.ttf`, `-Fill.ttf`, `-Duotone.ttf`) karena `phosphor_flutter` 2.1.0 tidak
kompatibel dengan Flutter 3.47. Duotone lewat `DuotoneIcon` di `lib/design/duotone_icon.dart`,
dengan `secondaryOpacity` bawaan 20 % — sama seperti mockup.

## Urutan kerja yang disarankan

| # | Item | Berkas utama | Estimasi |
| --- | --- | --- | --- |
| 1 | `disabledText` → `#5E665C` | `tokens.css`, `kapdh_tokens.dart` | 5 menit |
| 2 | `focusRing` → `#2D7A28` + pasang di tema | `kapdh_tokens.dart`, `kapdh_theme.dart` | 15 menit |
| 3 | Sinkron 10 token warna + 4 radius ke `tokens.json`, jalankan `build.mjs` | `tokens.json` | 30 menit |
| 4 | Hapus duplikasi `kapdh_tokens.dart` (jadikan path dependency) | `pubspec.yaml` | 30 menit |
| 5 | Tambah token shadow + motion | `tokens.json`, `build.mjs` | 1 jam |
| 6 | Judul Poppins → w700, uji ulang line-break | `kapdh_theme.dart` | 15 menit |
| 7 | Perbarui golden test setelah 1–6 | `test/` | 1 jam |
| 8 | Mode gelap | `kapdh_theme.dart`, `app.dart` | 1–2 hari |

Item 1–2 bisa langsung dikerjakan. Item 3–4 sebaiknya satu commit karena saling bergantung.
Item 7 wajib sebelum merge ke `main` — tanpa itu, perubahan warna dan radius akan lolos tanpa
terdeteksi.

## Cara memverifikasi ulang

```bash
# 1. Jalankan mockup
cd kapdh-mobile/mockup-html
node tools/serve.mjs        # http://localhost:5178

# 2. Cek kontras teks nonaktif (harus >= 4,5:1)
#    buka DevTools console di layar Masuk, lalu:
#    getComputedStyle(document.documentElement).getPropertyValue('--color-disabled-text')

# 3. Bandingkan token mockup vs Flutter
grep -E "color-(background|text-muted|disabled-text|focus-ring)" \
  kapdh-mobile/mockup-html/css/tokens.css
grep -E "(background|textMuted|disabledText|focusRing) = Color" \
  kapdh-mobile/lib/app/theme/kapdh_tokens.dart

# 4. Pastikan tidak ada ikon Material tersisa di layar
#    (status bar sistem dikecualikan)
```

## Rujukan

- `kapdh-mobile/mockup-html/REDESAIN.md` — catatan redesain v2 lengkap (token, komponen, adaptasi Beranda)
- `docs/adr/027-ikon-phosphor-satu-keluarga.md` — keputusan satu keluarga ikon
- `kapdh-platform/packages/design-tokens/README.md` — alur generator token
- `kapdh-mobile/mockup-html/ikon.html` — perbandingan Phosphor / Solar / Hugeicons / Fluent
