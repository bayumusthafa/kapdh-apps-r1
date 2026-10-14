# ADR-008: Penjaga Super Admin terakhir di database (trigger + advisory lock)

- Status: Diterima (Fase A, ditulis ulang pada perbaikan Fase A)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.16, 8.2 langkah 3, 9.2 (skenario Super Admin), 10.2; AC F16-2; D1; ARCHITECTURE §2 butir 11
- Bukti di kode: `kapdh-platform/packages/database/migrations/0002_last_super_admin.sql`,
  `apps/api/src/core/db/locks.ts` (`ADVISORY_LOCK_KEYS.lastSuperAdmin = 4711000518`), uji
  `apps/api/test/pg/last-super-admin.pg.test.ts`, `apps/api/test/pg/admin-governance.pg.test.ts`

## Konteks

PRD 9.2: "Pengurus mencoba menonaktifkan dua Super Admin bersamaan hingga tidak tersisa; transaksi mencegah keadaan
tanpa pengurus utama." Pemeriksaan di layanan ("hitung Super Admin aktif lalu ubah") rawan balapan: dua transaksi
masing-masing melihat dua Super Admin dan sama-sama mendemosi. Selain demosi, Super Admin juga dapat "hilang" lewat
penonaktifan akun `users`, penghapusan baris, atau perubahan `user_id`.

## Keputusan

1. Definisi Super Admin yang dihitung: `admins.role = 'super_admin'` **dan** `admins.status = 'active'` **dan**
   `users.status = 'active'` (dapat login). Definisi yang sama dipakai CLI bootstrap untuk menolak berjalan.
2. Trigger pada `admins` (UPDATE OF role/status/user_id, DELETE, TRUNCATE) dan `users` (UPDATE OF status, DELETE untuk
   akun admin) mengambil `pg_advisory_xact_lock(4711000518)` bila baris lama mungkin mengurangi himpunan, lalu menghitung
   ulang dengan snapshot statement baru. Bila hasilnya nol, transaksi gagal `23514` dengan constraint
   `admins_last_super_admin_chk`.
3. Penjaga hanya sah pada isolasi READ COMMITTED (isolasi aplikasi). Pengurangan pada REPEATABLE READ/SERIALIZABLE
   ditolak `0A000` agar snapshot lama tidak melemahkan penjaga.
4. Urutan kunci layanan: bila satu transaksi mengubah `admins` dan `users` milik admin yang sama, ubah `admins` dahulu;
   pola `SELECT ... FOR UPDATE` lalu `UPDATE` pada baris admin aman dari deadlock.

## Alternatif yang dipertimbangkan

- **Pemeriksaan di layanan dengan `SELECT ... FOR UPDATE` atas semua Super Admin**: ditolak; tidak menutup jalur lain
  (penonaktifan `users`, DELETE langsung) dan rawan deadlock.
- **Isolasi SERIALIZABLE untuk operasi admin**: ditolak; seluruh aplikasi berjalan READ COMMITTED dan retry
  serialisasi menambah kompleksitas di semua jalur.

## Konsekuensi

- Invarian dijaga database terlepas dari jalur kode (API, CLI, SQL manual pengelola).
- Bootstrap tidak dapat dipakai untuk membuat Super Admin pertama kedua kalinya setelah ada Super Admin aktif; Super
  Admin kedua dibuat lewat undangan web admin (`docs/runbooks/production-init.md` langkah 3).
- PRD 8.2 mewajibkan minimal dua Super Admin aktif sebelum go-live; penjaga ini hanya mencegah nol, bukan menjamin dua.
  Jumlah dua diperiksa di gerbang go-live (`docs/runbooks/go-live.md`).
