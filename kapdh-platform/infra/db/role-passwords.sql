-- Sandi role LOGIN KAPDH dari environment proses psql (PRD 5.3: secret dari pengelola secrets, tidak di source,
-- image layer, atau log). Dijalankan job rilis (infra/scripts/release-job.sh) SETELAH roles.sql bagian role dan
-- hanya untuk variabel yang terisi; tanpa variabel, berkas ini tidak mengubah apa pun. Idempoten.
--
--   KAPDH_MIGRATOR_DB_PASSWORD=... KAPDH_APP_DB_PASSWORD=... KAPDH_WORKER_DB_PASSWORD=... \
--     psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/db/role-passwords.sql
--
-- Nilai dibaca dengan \getenv (psql 15+), bukan argumen -v, sehingga tidak tampil di daftar proses. Sandi dikirim ke
-- server sebagai literal; PostgreSQL 17 menyimpannya sebagai SCRAM-SHA-256 (password_encryption bawaan). Jangan aktifkan
-- log_statement=all/ddl saat job ini berjalan. Gunakan sandi heksadesimal (`openssl rand -hex 32`) agar aman dipakai
-- di URL koneksi tanpa percent-encoding.
\set ON_ERROR_STOP on
\set QUIET on

\getenv kapdh_migrator_pw KAPDH_MIGRATOR_DB_PASSWORD
\getenv kapdh_app_pw KAPDH_APP_DB_PASSWORD
\getenv kapdh_worker_pw KAPDH_WORKER_DB_PASSWORD
-- Role backup harian dan pemeriksa kesehatan (roles.sql; infra/backup, infra/monitoring). Opsional.
\getenv kapdh_backup_pw KAPDH_BACKUP_DB_PASSWORD
\getenv kapdh_monitor_pw KAPDH_MONITOR_DB_PASSWORD

\if :{?kapdh_migrator_pw}
ALTER ROLE kapdh_migrator PASSWORD :'kapdh_migrator_pw';
\echo 'role-passwords: sandi kapdh_migrator diterapkan'
\endif
\if :{?kapdh_app_pw}
ALTER ROLE kapdh_app PASSWORD :'kapdh_app_pw';
\echo 'role-passwords: sandi kapdh_app diterapkan'
\endif
\if :{?kapdh_worker_pw}
ALTER ROLE kapdh_worker PASSWORD :'kapdh_worker_pw';
\echo 'role-passwords: sandi kapdh_worker diterapkan'
\endif
\if :{?kapdh_backup_pw}
ALTER ROLE kapdh_backup PASSWORD :'kapdh_backup_pw';
\echo 'role-passwords: sandi kapdh_backup diterapkan'
\endif
\if :{?kapdh_monitor_pw}
ALTER ROLE kapdh_monitor PASSWORD :'kapdh_monitor_pw';
\echo 'role-passwords: sandi kapdh_monitor diterapkan'
\endif
