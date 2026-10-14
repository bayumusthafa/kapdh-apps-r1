/* kapdh:release-outbox */
-- Replay outbox setelah restore (PRD 5.1, 5.5, 8.4): Redis dibangun ulang dari state durable, jadi event yang
-- tercatat diklaim instance lama (lease `locked_until`) dilepas agar worker baru langsung mengklaimnya; event
-- `pending`/`failed` diproses ulang dengan dedup key dan handler idempoten (tidak menggandakan uang, periode, kursi
-- atau notifikasi). Event `dead` TIDAK dihidupkan otomatis: periksa last_error lalu putuskan (runbook).
-- Dijalankan SEBELUM worker dinyalakan, sebagai pemilik/superuser database pulihan.
update app.outbox_events
set locked_until = null
where status in ('pending', 'failed') and locked_until is not null;

/* kapdh:outbox-counts */
select 'outbox_' || status || '=' || count(*)
from app.outbox_events
group by status
order by status;
