-- Pembatalan darurat migrasi 0009_profile_lists + 0010_profile_lists_bridge (profil berulang). BUKAN jalur rollback
-- biasa: rollback image API/worker ke versi sebelum 0009 tidak membutuhkan skrip ini, karena kolom lama dan
-- alumni_professions tetap terisi benar (proyeksi API baru + trigger jembatan). Jalankan hanya atas keputusan pemilik
-- produk, SETELAH API dan worker berjalan dengan image sebelum 0009, sebagai pemilik objek (kapdh_migrator) dalam satu
-- transaksi (psql -1), dengan image rilis yang memuat berkas ini (docs/runbooks/rilis-dan-gerbang-go-live.md 5.5).
--
-- Data yang HILANG: isi yang hanya ada di daftar baru, yaitu profesi selain profesi pertama yang tertaut master
-- (termasuk ketikan sendiri), jurusan/strata/tahun tamat dan riwayat pendidikan selain entri teratas, serta tautan
-- sosial selain tautan pertama Instagram/X/Facebook/LinkedIn. Kolom lama (social_*, last_education_*) dan
-- alumni_professions tidak disentuh. Bila 0009-0010 diterapkan lagi kelak, daftar diisi ulang dari kolom lama.
--
-- Batas tunggu kunci: DROP TRIGGER pada app.alumni/app.alumni_professions meminta ACCESS EXCLUSIVE; selama antre,
-- permintaan itu menahan baca dan tulis profil. Bila transaksi lama tidak selesai dalam 15 detik, skrip gagal (55P03)
-- tanpa perubahan apa pun (satu transaksi) dan dapat diulang saat tulisan profil sepi.
SET LOCAL lock_timeout = '15s';
DROP TRIGGER IF EXISTS alumni_legacy_reproject ON app.alumni;
DROP TRIGGER IF EXISTS alumni_professions_legacy_reproject ON app.alumni_professions;
DROP TRIGGER IF EXISTS alumni_legacy_profile_bridge ON app.alumni;
DROP TRIGGER IF EXISTS alumni_professions_legacy_bridge ON app.alumni_professions;
DROP FUNCTION IF EXISTS app.alumni_legacy_reproject();
DROP FUNCTION IF EXISTS app.alumni_professions_legacy_reproject();
DROP FUNCTION IF EXISTS app.alumni_project_legacy_profile(uuid);
DROP FUNCTION IF EXISTS app.alumni_professions_legacy_bridge();
DROP FUNCTION IF EXISTS app.alumni_legacy_profile_bridge();
DROP FUNCTION IF EXISTS app.alumni_apply_legacy_profession(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS app.alumni_apply_legacy_education(uuid, text);
DROP FUNCTION IF EXISTS app.alumni_apply_legacy_social(uuid, text, text);
DROP TABLE IF EXISTS app.alumni_social_links;
DROP TABLE IF EXISTS app.alumni_education;
DROP TABLE IF EXISTS app.alumni_profession_entries;
DROP FUNCTION IF EXISTS app.alumni_list_limit();
DROP FUNCTION IF EXISTS app.profile_lists_api_writer();
-- Catatan journal migrator Drizzle (created_at = `when` journal 0009 dan 0010) agar cek versi skema image lama lulus.
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (1792591532605, 1792591540265);
