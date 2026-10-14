/* kapdh:compare-stats */
-- Membandingkan statistik manifest (:'expected') dengan statistik database hasil restore (:'actual'); keduanya keluaran
-- sql/stats.sql. Satu baris per kunci: kelompok|kunci|nilai_manifest|nilai_restore. verify-restore.sh menggagalkan
-- selisih pada kelompok `invariant` (jumlah dan total uang wajib sama, PRD 5.5, PRD 9.2 "total keuangan tetap
-- cocok") dan `schema` (kecuali migrasi sengaja dijalankan), serta melaporkan selisih `info`.
-- Dijalankan: psql -v expected=<json> -v actual=<json> -f sql/compare-stats.sql
with e as (select :'expected'::json as j), a as (select :'actual'::json as j)
select g.grp || '|' || k.key || '|' || coalesce((select j from e) -> g.grp ->> k.key, '') || '|'
  || coalesce((select j from a) -> g.grp ->> k.key, '')
from (values ('schema'), ('invariant'), ('info')) as g(grp)
cross join lateral json_object_keys((select j from e) -> g.grp) as k(key)
order by g.grp, k.key;
