# @kapdh/database

Skema Drizzle untuk PostgreSQL 17 (skema `app`). Isi awal mencakup tabel yang dibutuhkan irisan Auth dan Iuran:
identitas (users, otp_codes, sessions, mfa_totp, admins, admin_permissions), keanggotaan (alumni, membership_events,
sequence `membership_no_seq`), pembayaran (payment_methods, payments, payment_events, fee_settings), dan platform
(files, audit_logs, outbox_events, idempotency_keys). Tabel konten, event, chat dan notifikasi ditambahkan pada irisan berikutnya.

- `pnpm db:generate` membuat migrasi SQL di `migrations/` dari skema.
- `pnpm db:migrate` menjalankan migrasi; di staging/production dijalankan oleh satu job deployment dengan lock (PRD 5.5).
- Nilai awal biaya (Rp50.000, Rp10.000, Rp10.000) diisi oleh seed produksi, bukan migrasi (PRD 8.2).
