/* kapdh:app-health */
-- Sinyal kesehatan aplikasi untuk alert (PRD 5.5 "umur job/outbox tertua dan kegagalan provider"; N-05, N-14;
-- docs/runbooks/monitoring.md). Dijalankan check-app.sh sebagai role kapdh_monitor (infra/db/roles.sql: SELECT hanya
-- pada kolom status/waktu di bawah, tanpa payload, alamat, token atau data pribadi). Keluaran `nama=angka`.
select 'outbox_oldest_pending_seconds=' || coalesce(floor(extract(epoch from (now() - min(created_at))))::bigint, 0)
from app.outbox_events where status in ('pending', 'failed')
union all
select 'outbox_dead=' || count(*) from app.outbox_events where status = 'dead'
union all
-- Kegagalan PENYEDIA (bukan token/alamat pengguna yang tidak valid) dalam 1 jam terakhir, termasuk yang masih dicoba
-- ulang (status pending, attempt > 0). Kelas: delivery-policy.ts (FCM HTTP v1 dan SMTP).
select 'push_provider_errors_1h=' || count(*) from app.notification_deliveries
where channel = 'push' and updated_at > now() - interval '1 hour'
  and error_class in ('QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL', 'AUTH_ERROR', 'NETWORK', 'SENDER_ID_MISMATCH')
union all
select 'email_provider_errors_1h=' || count(*) from app.notification_deliveries
where channel = 'email' and updated_at > now() - interval '1 hour'
  and error_class in ('timeout', 'network', 'auth_error', 'rejected', 'unknown')
union all
select 'deliveries_sent_1h=' || count(*) from app.notification_deliveries
where status = 'sent' and updated_at > now() - interval '1 hour'
union all
select 'deletions_failed=' || count(*) from app.account_deletions where status = 'failed'
union all
-- F-14: penyelesaian otomatis <= 7 hari kalender.
select 'deletions_overdue=' || count(*) from app.account_deletions
where status <> 'completed' and deadline_at < now()
union all
-- D5-07: penulisan deletion ledger luar VPS gagal (langkah ledger_open/ledger_final).
select 'deletions_offsite_ledger_failed=' || count(*) from app.account_deletions
where status = 'failed' and last_error like 'ledger\_%:OffsiteLedgerWriteError%'
union all
-- Antrean verifikasi pembayaran (PRD 8.3 "pantau antrean pembayaran"; D5 eskalasi 2 hari kerja).
select 'payments_review_oldest_hours=' || coalesce(floor(extract(epoch from (now() - min(submitted_at))) / 3600)::bigint, 0)
from app.payments where status = 'pending' and submitted_at is not null;
