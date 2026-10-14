-- Role dan grant database KAPDH (PRD 6.4 "DB grants serta transaksi domain menguatkan batas service", F-17,
-- PRD 5.1 "worker memakai least privilege", ARCHITECTURE §5).
--
-- Berkas ini dijalankan PENGELOLA INFRA, bukan oleh migrasi. Idempoten; aman diulang.
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/roles.sql
-- dengan koneksi superuser/pemilik database ke database KAPDH (production dan staging masing-masing).
--   1. Sebelum migrasi pertama: membuat role dan hak tingkat database.
--   2. Setelah SETIAP job migrasi (`pnpm --filter @kapdh/database migrate`): menerapkan ulang grant objek skema
--      `app`, termasuk pencabutan hak ubah/hapus pada tabel append-only.
-- Sandi role LOGIN diatur terpisah dari secrets manager (ALTER ROLE ... PASSWORD ...) dan tidak pernah di-commit.
--
-- Role:
--   kapdh_migrator    pemilik objek skema; dipakai hanya oleh job migrasi deployment tunggal (PRD 5.5).
--   kapdh_app         API. DML pada tabel app, tanpa UPDATE/DELETE/TRUNCATE pada audit_logs dan payment_events.
--   kapdh_worker      worker. Seperti kapdh_app, tanpa akses mfa_totp (secret TOTP) dan tanpa sequence nomor anggota.
--   kapdh_audit_purge NOLOGIN. Pembersihan/anonimisasi resmi audit dan histori payment (D2, F-17, AC F14-4).
--                     kapdh_worker (job account.deletion dan retensi, ARCHITECTURE §4.8) adalah anggota dengan
--                     INHERIT FALSE, SET TRUE: worker TIDAK mewarisi hak ini secara implisit dan wajib menjalankan
--                     `SET LOCAL ROLE kapdh_audit_purge` hanya untuk langkah anonimisasi, lalu kembali ke role worker.
--                     Trigger app.forbid_mutation() hanya mengizinkan UPDATE/DELETE bila current_user =
--                     kapdh_audit_purge. kapdh_app (API) tidak pernah menjadi anggota.
--   kapdh_backup      backup harian (infra/backup/backup.sh, PRD 5.5): pg_read_all_data (baca seluruh data untuk pg_dump
--                     dan statistik manifest), tanpa hak tulis apa pun. Sandi hanya di berkas secret host backup.
--   kapdh_monitor     pemeriksa kesehatan (infra/monitoring/check-app.sh): SELECT HANYA pada kolom status/waktu
--                     outbox, pengiriman notifikasi, penghapusan akun dan payment; tanpa payload atau data pribadi.

-- ------------------------------------------------------------------ Bagian 1: role (tingkat cluster)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_backup') THEN
    CREATE ROLE kapdh_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_monitor') THEN
    CREATE ROLE kapdh_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- PostgreSQL 14+: baca semua tabel/sequence/skema tanpa grant per objek (termasuk objek migrasi berikutnya).
  GRANT pg_read_all_data TO kapdh_backup;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_migrator') THEN
    CREATE ROLE kapdh_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_app') THEN
    CREATE ROLE kapdh_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_worker') THEN
    CREATE ROLE kapdh_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_audit_purge') THEN
    CREATE ROLE kapdh_audit_purge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  -- Jalur purge/anonimisasi resmi (F-17 "identitas aktor pada audit dianonimkan sesuai D2", AC F14-4): worker boleh
  -- SET ROLE eksplisit tetapi tidak mewarisi hak (sintaks PostgreSQL 16+; production PostgreSQL 17).
  GRANT kapdh_audit_purge TO kapdh_worker WITH INHERIT FALSE, SET TRUE;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'kapdh_audit_purge'::regrole AND m.member = 'kapdh_app'::regrole
  ) THEN
    REVOKE kapdh_audit_purge FROM kapdh_app;
  END IF;
END
$$;

-- ------------------------------------------------------------------ Bagian 2: database saat ini
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO kapdh_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO kapdh_app, kapdh_worker, kapdh_audit_purge, kapdh_backup, kapdh_monitor', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ------------------------------------------------------------------ Bagian 3: objek skema app (setelah migrasi)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    RAISE NOTICE 'Skema app belum ada; jalankan migrasi lalu ulangi berkas ini untuk menerapkan grant objek.';
    RETURN;
  END IF;

  REVOKE ALL ON SCHEMA app FROM PUBLIC;
  GRANT USAGE ON SCHEMA app TO kapdh_app, kapdh_worker, kapdh_audit_purge, kapdh_monitor;

  -- Mulai dari nol agar hak yang dicabut di versi berkas sebelumnya tidak tertinggal.
  REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, kapdh_app, kapdh_worker, kapdh_audit_purge, kapdh_monitor;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, kapdh_app, kapdh_worker, kapdh_audit_purge;

  -- API dan worker: DML biasa (tanpa TRUNCATE, REFERENCES, TRIGGER).
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO kapdh_app, kapdh_worker;

  -- Append-only (F-17, PRD 6.2): application role hanya boleh menambah dan membaca.
  REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_logs, app.payment_events FROM kapdh_app, kapdh_worker;

  -- Worker tidak memerlukan secret TOTP/backup code (least privilege, PRD 5.1). Kaskade FK dari penghapusan akun
  -- dijalankan sebagai pemilik tabel sehingga tetap berfungsi.
  REVOKE ALL ON app.mfa_totp FROM kapdh_worker;

  -- Nomor urut anggota dialokasikan API saat verifikasi OTP (nextval membutuhkan USAGE).
  GRANT USAGE ON SEQUENCE app.membership_no_seq TO kapdh_app;

  -- Pembersihan/anonimisasi resmi audit (D2); trigger tetap menolak TRUNCATE.
  GRANT SELECT, UPDATE, DELETE ON app.audit_logs, app.payment_events TO kapdh_audit_purge;

  -- Pemeriksa kesehatan (infra/monitoring/sql/app-health.sql): hanya kolom status/waktu, tanpa payload, alamat, token
  -- atau isi apa pun (N-09, N-14). REVOKE ALL di atas juga mencabut hak kolom versi sebelumnya.
  GRANT SELECT (status, created_at) ON app.outbox_events TO kapdh_monitor;
  GRANT SELECT (channel, status, error_class, updated_at) ON app.notification_deliveries TO kapdh_monitor;
  GRANT SELECT (status, deadline_at, last_error) ON app.account_deletions TO kapdh_monitor;
  GRANT SELECT (status, submitted_at) ON app.payments TO kapdh_monitor;

  -- Objek yang dibuat migrasi berikutnya oleh kapdh_migrator langsung dapat dipakai API/worker. Pencabutan
  -- khusus (append-only, mfa_totp) diterapkan ulang dengan menjalankan berkas ini setelah migrasi.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kapdh_migrator')
     AND pg_has_role(current_user, 'kapdh_migrator', 'MEMBER') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE kapdh_migrator IN SCHEMA app
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kapdh_app, kapdh_worker;
    ALTER DEFAULT PRIVILEGES FOR ROLE kapdh_migrator IN SCHEMA app
      GRANT USAGE ON SEQUENCES TO kapdh_app;
  END IF;

  -- Tabel bookkeeping migrasi Drizzle hanya untuk kapdh_migrator.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, kapdh_app, kapdh_worker, kapdh_audit_purge;
  END IF;
END
$$;
