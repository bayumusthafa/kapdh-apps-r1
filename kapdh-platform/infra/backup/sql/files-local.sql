/* kapdh:files-local */
-- Berkas driver local yang belum dihapus: `object_key sha256 status` per baris (key hanya [a-z0-9._/-], tanpa nama
-- atau email pengguna, PRD 5.4). verify-restore.sh memeriksa keberadaan objek `ready` di FILES_ROOT, mencocokkan sha256
-- pada sampel, dan menghitung objek yatim (objek tanpa baris).
select object_key || ' ' || sha256 || ' ' || status
from app.files
where storage_driver = 'local' and status <> 'deleted'
order by object_key;
