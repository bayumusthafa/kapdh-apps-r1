# ADR-005: Tabel di luar inventaris PRD: `admin_permissions`, `categories` (dan `otp_decoys`)

- Status: Diterima (Fase A; `otp_decoys` ditambahkan Fase C)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 2.3, 2.5, 3.8, 3.16, 6.1-6.3; Guidelines KAPDH v1.0 hal. 14 ("Manajemen Kategori"); ARCHITECTURE §5.3
- Bukti di kode: `kapdh-platform/packages/database/src/schema/{identity.ts,content.ts}`,
  `packages/database/migrations/0000_init.sql`, `0007_auth_otp_decoys.sql`

## Konteks

PRD 6 mendaftar 37 tabel. Dua kebutuhan PRD tidak punya tempat yang baik di daftar itu:

- Izin pengurus (PRD 2.3, 3.16) bersifat himpunan 15 izin per admin yang dievaluasi dari database setiap request
  (AC F15-1, F16-3). Menyimpannya sebagai array/JSON di `admins` menyulitkan CHECK per nilai, audit perubahan per izin,
  dan kueri "siapa yang memegang `payments.decide`" (PRD 10.2: minimal dua pengurus pembayaran).
- Guideline hal. 14 meminta "Manajemen Kategori" untuk berita dan event, sedangkan PRD tidak punya tabel kategori.

Pada Fase C, alur non-enumerasi (PRD 2.5) membutuhkan keadaan challenge pengganti tanpa membuat akun (ADR-012).

## Keputusan

1. `admin_permissions (admin_id, permission, granted_by_admin_id, created_at)`: satu baris per izin, CHECK atas 15 nilai
   enum `Permission`. `super_admin` tidak memerlukan baris (memiliki semua izin). Kolom `admins.permissions_version`
   menandai perubahan himpunan izin.
2. `categories (kind post|event, ...)`: satu tabel untuk kategori berita dan event. Kategori berita dikelola di
   `/content` (tab Kategori), kategori event dikelola di area Event web admin (keputusan integrasi Fase C).
3. `otp_decoys`: keadaan challenge pengganti (HMAC email, email tersamar, percobaan, kedaluwarsa), tanpa kode dan tanpa
   email mentah; migrasi `0007_auth_otp_decoys`.
4. `fee_settings` dari PRD tidak dibuat (ADR-006). Jumlah tabel skema `app` saat ini: 37 tabel PRD - `fee_settings` +
   `admin_permissions` + `categories` + `otp_decoys`.

## Alternatif yang dipertimbangkan

- `admins.permissions text[]`: ditolak (tidak ada FK/CHECK per nilai, audit per izin sulit, kunci baris admin untuk
  setiap perubahan izin).
- Kategori sebagai string bebas di `posts`/`events`: ditolak; tidak dapat dikelola, diganti nama, atau dinonaktifkan.
- Challenge pengganti di Redis: ditolak; Redis bukan sumber kebenaran (PRD 5.1) dan opsional di development.

## Konsekuensi

- Pemeriksaan izin adalah join kecil per request; perubahan izin langsung berlaku tanpa menunggu token kedaluwarsa
  (AC F16-3).
- Model data untuk formulir privasi toko aplikasi (`docs/runbooks/app-store-submission.md`) mencakup tabel ini; tidak
  ada data pribadi di `admin_permissions`/`categories`, dan `otp_decoys` hanya menyimpan HMAC serta bentuk tersamar.
- `packages/database/README.md` masih menyebut "39 tabel" (sebelum `otp_decoys`); angka itu perlu diperbarui pemilik
  paket database.
