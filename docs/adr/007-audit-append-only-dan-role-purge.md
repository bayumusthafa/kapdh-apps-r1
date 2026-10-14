# ADR-007: Audit dan histori payment append-only lewat trigger + grant; anonimisasi hanya lewat role `kapdh_audit_purge`

- Status: Diterima (Fase A)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.17, 5.1, 6.2, 6.4; F-14, F-17; AC F14-4, F17-1..F17-4; D2; ARCHITECTURE §4.2, §5
- Bukti di kode: `kapdh-platform/packages/database/migrations/0001_append_only.sql`, `infra/db/roles.sql`,
  `apps/api/src/core/audit/*`, `apps/api/src/modules/account/deletion-steps.ts` (`set local role kapdh_audit_purge`),
  uji `apps/api/test/pg/append-only.pg.test.ts`

## Konteks

F-17 mewajibkan audit yang tidak dapat diubah aplikasi (append-only) untuk setiap perubahan penting, ditulis dalam
transaksi yang sama (AC F17-1). D2 juga mewajibkan identitas aktor dianonimkan ketika akun dihapus (AC F14-4), jadi
"tidak pernah diubah" tidak bisa mutlak. Larangan yang hanya ada di kode aplikasi mudah dilewati oleh bug atau oleh
proses yang disusupi.

## Keputusan

1. Baris audit ditulis **aplikasi** (`AuditService.write(tx, entry)`) di transaksi bisnis yang sama, dengan sanitasi
   kunci rahasia dan batas ukuran. PRD 6.4 menyebut kemungkinan audit oleh trigger database; itu tidak dipakai karena
   trigger tidak mengetahui aktor, request_id, dan alasan bisnis.
2. `audit_logs` dan `payment_events` dilindungi dua lapis:
   - trigger `app.forbid_mutation()` BEFORE UPDATE/DELETE (baris) dan TRUNCATE (statement) yang menolak dengan
     SQLSTATE `42501` kecuali `current_user = kapdh_audit_purge`;
   - grant: `kapdh_app` dan `kapdh_worker` hanya SELECT/INSERT pada kedua tabel (`infra/db/roles.sql`).
3. Role NOLOGIN `kapdh_audit_purge` memegang SELECT/UPDATE/DELETE pada kedua tabel. `kapdh_worker` menjadi anggotanya
   dengan `INHERIT FALSE, SET TRUE` (sintaks PostgreSQL 16+): hak hanya aktif setelah
   `SET LOCAL ROLE kapdh_audit_purge` di dalam transaksi langkah anonimisasi job `account.deletion` (dan CLI
   `account:ledger-reapply`). `kapdh_app` (API) tidak pernah menjadi anggota.
4. `roles.sql` dijalankan pengelola infra sebelum migrasi pertama dan **setelah setiap migrasi** untuk menerapkan ulang
   pencabutan khusus.

## Alternatif yang dipertimbangkan

- **Login purge terpisah** (koneksi khusus dengan sandi sendiri): pemisahan lebih ketat, tetapi menambah secret dan pool
  di worker. Dicatat sebagai opsi; `roles.sql` ditulis agar perubahan itu mudah.
- **Hanya trigger tanpa grant**, atau **hanya grant tanpa trigger**: ditolak; dua lapis menahan kesalahan konfigurasi
  salah satunya.

## Konsekuensi

- Trade-off yang diterima: proses worker yang disusupi dapat `SET ROLE kapdh_audit_purge` lalu mengubah audit. Mitigasi:
  worker tidak menerima secret JWT/OTP/TOTP/QR, tidak dirutekan publik, dan perubahan audit oleh purge hanya terjadi di
  jalur penghapusan yang sendiri diaudit.
- Development dan uji tetap membutuhkan role ini; job penghapusan gagal dengan pesan "Role kapdh_audit_purge belum ada;
  jalankan infra/db/roles.sql" bila `roles.sql` belum diterapkan (lihat README root, jalur lokal).
- Production wajib PostgreSQL 16 atau lebih baru (rencana 17).
