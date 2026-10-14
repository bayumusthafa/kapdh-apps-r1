-- Ringkasan isi database KAPDH untuk manifest backup dan verifikasi restore (PRD 5.5 "memeriksa login/MFA, anggota,
-- total uang, tiket, chat, berkas dan penghapusan terdahulu"; N-06; AC F14-6).
--
-- Berkas ini berisi SATU ekspresi SQL bertipe json (tanpa titik koma, tanpa SELECT). Dipakai:
--   * backup.sh        : di DALAM transaksi REPEATABLE READ yang snapshot-nya diekspor ke pg_dump, sehingga angka
--                        persis sama dengan isi dump (bukan perkiraan);
--   * verify-restore.sh: pada database hasil restore, lalu dibandingkan dengan manifest.
-- Hanya angka, total uang, waktu dan versi skema: TANPA data pribadi (N-09, N-14).
--
-- Kelompok:
--   invariant : TIDAK berubah oleh penerapan ulang deletion ledger (AC F14-4: jumlah, status paid dan nominal tetap;
--               akun dianonimkan, bukan dihapus barisnya). Restore wajib sama persis dengan manifest.
--   info      : dapat berubah sah karena ledger diterapkan ulang (profil dihapus, tiket hangus, pesan sistem,
--               berkas dihapus, audit baru) atau karena outbox diproses; dilaporkan sebagai selisih, tidak digagalkan.
--   latest    : waktu data terbaru, dipakai mengukur RPO aktual (docs/runbooks/backup-restore.md).
json_build_object(
  'captured_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'schema', (
    select json_build_object('applied', count(*), 'last_created_at', coalesce(max(created_at), 0))
    from drizzle.__drizzle_migrations
  ),
  'invariant', json_build_object(
    'users', (select count(*) from app.users),
    'admins_active', (select count(*) from app.admins where status = 'active'),
    'super_admins_active', (
      select count(*) from app.admins a join app.users u on u.id = a.user_id
      where a.role = 'super_admin' and a.status = 'active' and u.status = 'active'
    ),
    'payments', (select count(*) from app.payments),
    'payments_paid', (select count(*) from app.payments where status = 'paid'),
    'paid_total', (
      select coalesce(sum(amount), 0)::numeric(14,2)::text from app.payments where status = 'paid'
    ),
    'paid_registration', (
      select coalesce(sum(amount), 0)::numeric(14,2)::text from app.payments
      where status = 'paid' and type = 'registration'
    ),
    'paid_renewal', (
      select coalesce(sum(amount), 0)::numeric(14,2)::text from app.payments
      where status = 'paid' and type = 'renewal'
    ),
    'paid_ticket', (
      select coalesce(sum(amount), 0)::numeric(14,2)::text from app.payments
      where status = 'paid' and type = 'ticket'
    ),
    'adjustments', (select count(*) from app.payment_adjustments),
    'adjustments_completed_total', (
      select coalesce(sum(amount), 0)::numeric(14,2)::text from app.payment_adjustments where status = 'completed'
    ),
    'tickets', (select count(*) from app.tickets),
    'events', (select count(*) from app.events),
    'rooms', (select count(*) from app.rooms)
  ),
  'info', json_build_object(
    'users_active', (select count(*) from app.users where status = 'active'),
    'users_deleted', (select count(*) from app.users where status = 'deleted'),
    'alumni', (select count(*) from app.alumni),
    'tickets_paid', (select count(*) from app.tickets where status = 'paid'),
    'messages', (select count(*) from app.messages),
    'membership_events', (select count(*) from app.membership_events),
    'payment_events', (select count(*) from app.payment_events),
    'payments_pending', (select count(*) from app.payments where status = 'pending'),
    'files_ready', (select count(*) from app.files where status = 'ready'),
    'files_ready_local', (select count(*) from app.files where status = 'ready' and storage_driver = 'local'),
    'audit_logs', (select count(*) from app.audit_logs),
    'outbox_pending', (select count(*) from app.outbox_events where status in ('pending', 'failed')),
    'outbox_dead', (select count(*) from app.outbox_events where status = 'dead'),
    'account_deletions_open', (
      select count(*) from app.account_deletions where status in ('pending', 'processing', 'failed')
    ),
    'account_deletions_completed', (select count(*) from app.account_deletions where status = 'completed')
  ),
  'latest', json_build_object(
    'payment_created_at', (select max(created_at) from app.payments),
    'message_created_at', (select max(created_at) from app.messages),
    'audit_created_at', (select max(created_at) from app.audit_logs)
  )
)
