# @kapdh/design-tokens

Token desain KAPDH Apps yang diturunkan dari **Guidelines KAPDH Platform v1.0** (PRD v3.5, D15). Satu sumber (`tokens.json`) dibangkitkan menjadi tema Tailwind 4 untuk web admin dan konstanta Dart untuk Flutter. Lokasi target di monorepo: `packages/design-tokens`.

## Isi

| File                            | Fungsi                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `tokens.json`                   | Sumber tunggal: warna, gradien, font, ukuran, spasi, radius, bayangan, status keanggotaan |
| `build.py`                      | Pembangkit; jalankan setiap kali `tokens.json` berubah                                    |
| `css/kapdh-theme.css`           | Hasil: blok `@theme` Tailwind 4, badge status, fokus keyboard                             |
| `flutter/lib/kapdh_tokens.dart` | Hasil: `KapdhColors`, `KapdhSpace`, `KapdhRadius`, `KapdhMembershipStatus`, dll.          |
| `flutter/lib/kapdh_theme.dart`  | Ditulis manual: `ThemeData` Material 3 dan widget `KapdhStatusBadge`                      |

```bash
python3 build.py
```

## Pemakaian

**Web admin (React + Tailwind 4)**

```css
@import "tailwindcss";
@import "@kapdh/design-tokens/css/kapdh-theme.css";
```

Lalu pakai kelas seperti `bg-primary text-on-primary`, `bg-surface-brand`, `text-text-muted`, `rounded-md`, `font-heading`, `badge-verified`.

**Flutter**

```yaml
dependencies:
  google_fonts: ^6.2.1
```

```dart
MaterialApp(theme: KapdhTheme.light(), ...);
KapdhStatusBadge(KapdhMembershipStatus.verified);
```

## Palet

| Peran                        | Nilai     | Catatan                                                                                                 |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| Primary (tombol, ikon aktif) | `#1A4B17` | Kontras teks putih 10,2:1                                                                               |
| Hijau merek                  | `#215E1E` | Header, aksen                                                                                           |
| Hijau gelap                  | `#0E280C` | Latar gelap, kartu KTA                                                                                  |
| Emas                         | `#E6D312` | **Hanya di atas latar hijau/gelap** (10,3:1). Di atas putih kontrasnya 1,5:1, jangan dipakai untuk teks |
| Krem                         | `#FCF8F5` | Latar halaman merek                                                                                     |
| Latar aplikasi               | `#FBFAFF` | Sesuai mockup                                                                                           |

## Penyesuaian dari mockup (aksesibilitas, N-11)

- **Border input** memakai `#8A8F87` (3,3:1), bukan abu-abu muda `#C9C9C9` seperti di mockup (1,7:1), supaya batas field terlihat jelas sesuai WCAG 1.4.11.
- **Status keanggotaan** selalu tampil sebagai badge berisi ikon dan label (KTA Aktif, Segera Berakhir, KTA Tidak Aktif, Menunggu Verifikasi, Dibatasi), sesuai PRD 4.5: status tidak dibedakan dengan warna saja.
- **Fokus keyboard** memakai cincin emas 3 px agar terlihat di latar terang maupun hijau.

## Font

- **Poppins** (isi, gratis, Google Fonts).
- **Telegraf** (judul) adalah font berbayar dari Pangram Pangram. Pakai hanya setelah lisensi aplikasi/web dimiliki; set `KapdhTheme.useTelegraf = true` dan bundel file font. Tanpa lisensi, judul memakai Poppins SemiBold.
