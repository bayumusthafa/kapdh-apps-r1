/* kapdh:verify-checks */
-- Pemeriksaan konsistensi database hasil restore sebelum layanan dibuka (PRD 5.5, 8.4; AC F14-6). Keluaran
-- `nama=angka` per baris; tanpa data pribadi. Variabel: :'ledger_user_ids' = larik uuid PostgreSQL ('{}' bila kosong)
-- dari seluruh entri deletion ledger yang dipakai restore.
-- Dijalankan: psql -v ledger_user_ids='{...}' -f sql/verify-checks.sql
select 'super_admins_active=' || count(*)
from app.admins a join app.users u on u.id = a.user_id
where a.role = 'super_admin' and a.status = 'active' and u.status = 'active'
union all
select 'ledger_users_present=' || count(*)
from app.users where id = any(:'ledger_user_ids'::uuid[])
union all
-- AC F14-6: setiap akun pada ledger yang ada di database pulihan wajib berstatus deleted.
select 'ledger_users_not_deleted=' || count(*)
from app.users where id = any(:'ledger_user_ids'::uuid[]) and status <> 'deleted'
union all
select 'ledger_users_with_profile=' || count(*)
from app.alumni where user_id = any(:'ledger_user_ids'::uuid[])
union all
-- Permintaan selesai tetapi akunnya tidak deleted berarti penghapusan muncul kembali.
select 'deletions_completed_not_deleted=' || count(*)
from app.account_deletions d join app.users u on u.id = d.user_id
where d.status = 'completed' and u.status <> 'deleted'
union all
select 'deletions_open=' || count(*)
from app.account_deletions where status in ('pending', 'processing', 'failed')
union all
select 'outbox_dead=' || count(*)
from app.outbox_events where status = 'dead'
union all
-- Lease outbox dari instance lama harus sudah dilepas (sql/release-outbox.sql).
select 'outbox_leased=' || count(*)
from app.outbox_events where status in ('pending', 'failed') and locked_until is not null;
