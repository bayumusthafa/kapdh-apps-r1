/* kapdh:public-file */
-- Satu berkas publik (avatar/banner) yang siap, untuk uji akses berkas lewat API (GET /api/v1/files/public/{id}).
select id
from app.files
where status = 'ready' and visibility = 'public' and storage_driver = 'local'
order by created_at desc
limit 1;
