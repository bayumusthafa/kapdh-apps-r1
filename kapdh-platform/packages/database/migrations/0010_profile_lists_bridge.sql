-- Profil berulang (kontrak Profile.professions/education/social_links): isi awal daftar dari kolom lama, batas daftar,
-- dan jembatan untuk penulis lama. Pola expand: kolom lama (social_*, last_education_*) dan alumni_professions (satu
-- baris) TIDAK diubah. API baru menulis daftar lalu memproyeksikannya ke kolom lama dengan
-- app.alumni_project_legacy_profile, sehingga image API sebelum 0009 tetap membaca data yang benar bila di-rollback.
-- Penulis lama (image sebelum 0009 selama jendela deploy atau setelah rollback) hanya mengubah kolom lama; trigger
-- jembatan menerapkan perubahan itu ke daftar (tulisan yang tidak muat karena daftar penuh ditolak), lalu constraint
-- trigger DEFERRED memproyeksikan ulang kolom lama dari daftar saat commit. API baru menyetel
-- set_config('kapdh.profile_lists', 'api', true) di transaksinya sehingga jembatan dan proyeksi ulang diam untuk
-- tulisannya sendiri.
CREATE FUNCTION app.profile_lists_api_writer() RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('kapdh.profile_lists', true), '') = 'api'
$$;
--> statement-breakpoint
-- Batas baris per alumni (TG_ARGV[0]; sama dengan MAX_ALUMNI_* di schema/membership.ts). Baris alumni dikunci FOR NO
-- KEY UPDATE sebelum menghitung (pola 0003) sehingga dua transaksi bersamaan tidak sama-sama lolos batas.
CREATE FUNCTION app.alumni_list_limit() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  max_rows integer := TG_ARGV[0]::integer;
  total integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.alumni_user_id = OLD.alumni_user_id THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM 1 FROM app.alumni WHERE user_id = NEW.alumni_user_id FOR NO KEY UPDATE;
  EXECUTE format('SELECT count(*) FROM %I.%I WHERE alumni_user_id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME)
    INTO total
    USING NEW.alumni_user_id;
  IF total >= max_rows THEN
    RAISE EXCEPTION 'Alumni hanya dapat memiliki maksimal % baris %', max_rows, TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = TG_TABLE_NAME || '_limit_chk',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Isi awal: profesi lama (paling banyak satu, tertaut master) menjadi entri pertama.
INSERT INTO app.alumni_profession_entries (alumni_user_id, position, profession_id, created_at)
SELECT alumni_user_id, 0, profession_id, created_at
FROM app.alumni_professions;
--> statement-breakpoint
-- Isi awal: "Lulusan Terakhir" menjadi satu riwayat pendidikan (institusi saja). Kota lama tetap di kolomnya.
INSERT INTO app.alumni_education (alumni_user_id, position, institution)
SELECT user_id, 0, btrim(left(btrim(last_education_institution), 120))
FROM app.alumni
WHERE btrim(coalesce(last_education_institution, '')) <> '';
--> statement-breakpoint
-- Isi awal: empat kolom sosial lama menjadi tautan berurutan Instagram, X, Facebook, LinkedIn.
INSERT INTO app.alumni_social_links (alumni_user_id, position, platform, value)
SELECT a.user_id, (row_number() OVER (PARTITION BY a.user_id ORDER BY v.ord) - 1)::smallint, v.platform, v.value
FROM app.alumni a
CROSS JOIN LATERAL (
  VALUES
    (1, 'instagram', a.social_instagram),
    (2, 'x', a.social_x),
    (3, 'facebook', a.social_facebook),
    (4, 'linkedin', a.social_linkedin)
) AS v (ord, platform, value)
WHERE char_length(v.value) BETWEEN 1 AND 200;
--> statement-breakpoint
CREATE TRIGGER alumni_profession_entries_limit BEFORE INSERT OR UPDATE OF alumni_user_id ON app.alumni_profession_entries
  FOR EACH ROW EXECUTE FUNCTION app.alumni_list_limit('5');
--> statement-breakpoint
CREATE TRIGGER alumni_education_limit BEFORE INSERT OR UPDATE OF alumni_user_id ON app.alumni_education
  FOR EACH ROW EXECUTE FUNCTION app.alumni_list_limit('10');
--> statement-breakpoint
CREATE TRIGGER alumni_social_links_limit BEFORE INSERT OR UPDATE OF alumni_user_id ON app.alumni_social_links
  FOR EACH ROW EXECUTE FUNCTION app.alumni_list_limit('10');
--> statement-breakpoint
-- Kolom lama social_<platform> = tautan pertama platform itu. Nilai baru mengganti tautan pertama (tautan lain
-- bernilai sama dibuang agar tidak ganda) atau ditambahkan di akhir; null menghapus tautan pertama. Mengembalikan
-- false bila nilai tidak dapat disimpan karena daftar sudah penuh (10); pemanggil menolak tulisan itu. Nilai di luar
-- aturan kontrak (lebih dari 200 karakter) diabaikan.
CREATE FUNCTION app.alumni_apply_legacy_social(p_user uuid, p_platform text, p_value text) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v text := nullif(btrim(coalesce(p_value, '')), '');
  first_pos smallint;
  next_pos smallint;
  total integer;
BEGIN
  IF char_length(v) > 200 THEN
    RETURN true;
  END IF;
  SELECT position INTO first_pos
  FROM app.alumni_social_links
  WHERE alumni_user_id = p_user AND platform = p_platform
  ORDER BY position
  LIMIT 1;
  IF v IS NULL THEN
    DELETE FROM app.alumni_social_links WHERE alumni_user_id = p_user AND position = first_pos;
    RETURN true;
  END IF;
  IF first_pos IS NOT NULL THEN
    DELETE FROM app.alumni_social_links
    WHERE alumni_user_id = p_user AND platform = p_platform AND position <> first_pos AND lower(value) = lower(v);
    UPDATE app.alumni_social_links
    SET value = v
    WHERE alumni_user_id = p_user AND position = first_pos AND value IS DISTINCT FROM v;
    RETURN true;
  END IF;
  SELECT count(*), coalesce(max(position) + 1, 0) INTO total, next_pos
  FROM app.alumni_social_links
  WHERE alumni_user_id = p_user;
  IF total >= 10 THEN
    RETURN false;
  END IF;
  INSERT INTO app.alumni_social_links (alumni_user_id, position, platform, value)
  VALUES (p_user, next_pos, p_platform, v);
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Kolom lama last_education_institution = institusi entri pendidikan teratas. Nilai baru mengganti institusi entri
-- teratas (strata, jurusan dan tahun tetap) atau membuat entri pertama; null menghapus entri teratas.
CREATE FUNCTION app.alumni_apply_legacy_education(p_user uuid, p_institution text) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v text := nullif(btrim(left(btrim(coalesce(p_institution, '')), 120)), '');
  top_pos smallint;
BEGIN
  SELECT position INTO top_pos
  FROM app.alumni_education
  WHERE alumni_user_id = p_user
  ORDER BY position
  LIMIT 1;
  IF v IS NULL THEN
    DELETE FROM app.alumni_education WHERE alumni_user_id = p_user AND position = top_pos;
  ELSIF top_pos IS NULL THEN
    INSERT INTO app.alumni_education (alumni_user_id, position, institution) VALUES (p_user, 0, v);
  ELSE
    UPDATE app.alumni_education
    SET institution = v
    WHERE alumni_user_id = p_user AND position = top_pos AND institution IS DISTINCT FROM v;
  END IF;
END;
$$;
--> statement-breakpoint
-- alumni_professions lama = profesi pertama yang tertaut master. Profesi yang dilepas dihapus dari daftar; profesi
-- baru menjadi profesi utama (paling depan): entri yang sudah ada dipindah ke depan, entri baru menggantikan ketikan
-- sendiri berlabel sama. Mengembalikan false bila profesi baru tidak dapat ditambahkan karena daftar sudah penuh (5).
CREATE FUNCTION app.alumni_apply_legacy_profession(p_user uuid, p_removed uuid, p_added uuid) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  front smallint;
  total integer;
BEGIN
  IF p_removed IS NOT NULL AND p_removed IS DISTINCT FROM p_added THEN
    DELETE FROM app.alumni_profession_entries WHERE alumni_user_id = p_user AND profession_id = p_removed;
  END IF;
  IF p_added IS NULL THEN
    RETURN true;
  END IF;
  SELECT coalesce(min(position), 1) - 1 INTO front
  FROM app.alumni_profession_entries
  WHERE alumni_user_id = p_user;
  IF EXISTS (
    SELECT 1 FROM app.alumni_profession_entries WHERE alumni_user_id = p_user AND profession_id = p_added
  ) THEN
    UPDATE app.alumni_profession_entries
    SET position = front
    WHERE alumni_user_id = p_user AND profession_id = p_added AND position > front + 1;
    RETURN true;
  END IF;
  DELETE FROM app.alumni_profession_entries e
  USING app.master_professions m
  WHERE e.alumni_user_id = p_user AND m.id = p_added AND e.label IS NOT NULL AND lower(e.label) = lower(m.label);
  SELECT count(*), coalesce(min(position), 1) - 1 INTO total, front
  FROM app.alumni_profession_entries
  WHERE alumni_user_id = p_user;
  IF total >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO app.alumni_profession_entries (alumni_user_id, position, profession_id)
  VALUES (p_user, front, p_added);
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Jembatan baris penulis lama: perubahan kolom lama langsung diterapkan ke daftar. Tulisan yang tidak muat karena
-- daftar penuh ditolak (check_violation, `*_limit_chk`) agar tidak tersimpan di kolom tetapi hilang dari daftar.
CREATE FUNCTION app.alumni_legacy_profile_bridge() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  platform text;
  before_value text;
  after_value text;
BEGIN
  IF app.profile_lists_api_writer() THEN
    RETURN NULL;
  END IF;
  FOREACH platform IN ARRAY ARRAY['instagram', 'x', 'facebook', 'linkedin'] LOOP
    after_value := CASE platform
      WHEN 'instagram' THEN NEW.social_instagram
      WHEN 'x' THEN NEW.social_x
      WHEN 'facebook' THEN NEW.social_facebook
      ELSE NEW.social_linkedin
    END;
    IF TG_OP = 'INSERT' THEN
      CONTINUE WHEN after_value IS NULL;
    ELSE
      before_value := CASE platform
        WHEN 'instagram' THEN OLD.social_instagram
        WHEN 'x' THEN OLD.social_x
        WHEN 'facebook' THEN OLD.social_facebook
        ELSE OLD.social_linkedin
      END;
      CONTINUE WHEN after_value IS NOT DISTINCT FROM before_value;
    END IF;
    IF NOT app.alumni_apply_legacy_social(NEW.user_id, platform, after_value) THEN
      RAISE EXCEPTION 'Daftar tautan sosial alumni sudah penuh (maksimal 10)'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'alumni_social_links_limit_chk',
              SCHEMA = 'app',
              TABLE = 'alumni_social_links';
    END IF;
  END LOOP;
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_education_institution IS NOT NULL THEN
      PERFORM app.alumni_apply_legacy_education(NEW.user_id, NEW.last_education_institution);
    END IF;
  ELSIF NEW.last_education_institution IS DISTINCT FROM OLD.last_education_institution THEN
    PERFORM app.alumni_apply_legacy_education(NEW.user_id, NEW.last_education_institution);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER alumni_legacy_profile_bridge
  AFTER INSERT OR UPDATE OF social_instagram, social_x, social_facebook, social_linkedin, last_education_institution
  ON app.alumni
  FOR EACH ROW EXECUTE FUNCTION app.alumni_legacy_profile_bridge();
--> statement-breakpoint
CREATE FUNCTION app.alumni_professions_legacy_bridge() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  applied boolean := true;
BEGIN
  IF app.profile_lists_api_writer() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    applied := app.alumni_apply_legacy_profession(NEW.alumni_user_id, NULL, NEW.profession_id);
  ELSIF TG_OP = 'DELETE' THEN
    applied := app.alumni_apply_legacy_profession(OLD.alumni_user_id, OLD.profession_id, NULL);
  ELSIF OLD.alumni_user_id = NEW.alumni_user_id THEN
    applied := app.alumni_apply_legacy_profession(NEW.alumni_user_id, OLD.profession_id, NEW.profession_id);
  ELSE
    PERFORM app.alumni_apply_legacy_profession(OLD.alumni_user_id, OLD.profession_id, NULL);
    applied := app.alumni_apply_legacy_profession(NEW.alumni_user_id, NULL, NEW.profession_id);
  END IF;
  IF NOT applied THEN
    RAISE EXCEPTION 'Daftar profesi alumni sudah penuh (maksimal 5)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'alumni_profession_entries_limit_chk',
            SCHEMA = 'app',
            TABLE = 'alumni_profession_entries';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER alumni_professions_legacy_bridge AFTER INSERT OR UPDATE OR DELETE ON app.alumni_professions
  FOR EACH ROW EXECUTE FUNCTION app.alumni_professions_legacy_bridge();
--> statement-breakpoint
-- Proyeksi daftar ke kolom lama (dipanggil API baru setelah menulis daftar, dengan penanda 'api' aktif):
-- social_<platform> = tautan pertama platform itu, last_education_institution = institusi entri teratas
-- (last_education_city dikosongkan bila institusi itu berganti), alumni_professions = profesi pertama bertaut master.
CREATE FUNCTION app.alumni_project_legacy_profile(p_user uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  primary_profession uuid;
BEGIN
  UPDATE app.alumni a
  SET social_instagram = s.instagram,
      social_x = s.x,
      social_facebook = s.facebook,
      social_linkedin = s.linkedin,
      last_education_institution = s.institution,
      last_education_city = CASE
        WHEN s.institution IS NOT DISTINCT FROM a.last_education_institution THEN a.last_education_city
      END
  FROM (
    SELECT
      (SELECT value FROM app.alumni_social_links
        WHERE alumni_user_id = p_user AND platform = 'instagram' ORDER BY position LIMIT 1) AS instagram,
      (SELECT value FROM app.alumni_social_links
        WHERE alumni_user_id = p_user AND platform = 'x' ORDER BY position LIMIT 1) AS x,
      (SELECT value FROM app.alumni_social_links
        WHERE alumni_user_id = p_user AND platform = 'facebook' ORDER BY position LIMIT 1) AS facebook,
      (SELECT value FROM app.alumni_social_links
        WHERE alumni_user_id = p_user AND platform = 'linkedin' ORDER BY position LIMIT 1) AS linkedin,
      (SELECT institution FROM app.alumni_education
        WHERE alumni_user_id = p_user ORDER BY position LIMIT 1) AS institution
  ) AS s
  WHERE a.user_id = p_user
    AND (a.social_instagram, a.social_x, a.social_facebook, a.social_linkedin, a.last_education_institution)
      IS DISTINCT FROM (s.instagram, s.x, s.facebook, s.linkedin, s.institution);
  SELECT profession_id INTO primary_profession
  FROM app.alumni_profession_entries
  WHERE alumni_user_id = p_user AND profession_id IS NOT NULL
  ORDER BY position
  LIMIT 1;
  DELETE FROM app.alumni_professions
  WHERE alumni_user_id = p_user AND profession_id IS DISTINCT FROM primary_profession;
  IF primary_profession IS NOT NULL THEN
    INSERT INTO app.alumni_professions (alumni_user_id, profession_id)
    VALUES (p_user, primary_profession)
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;
--> statement-breakpoint
-- Proyeksi ulang untuk penulis lama saat commit (constraint trigger DEFERRED): kolom lama dan alumni_professions
-- mengikuti daftar setelah semua tulisan transaksi itu selesai, tanpa mengganggu hapus-lalu-sisip replaceProfession
-- image lama. Diam untuk transaksi API baru, yang sudah memproyeksikan sendiri.
CREATE FUNCTION app.alumni_legacy_reproject() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous text;
BEGIN
  IF app.profile_lists_api_writer() THEN
    RETURN NULL;
  END IF;
  previous := current_setting('kapdh.profile_lists', true);
  PERFORM set_config('kapdh.profile_lists', 'api', true);
  PERFORM app.alumni_project_legacy_profile(NEW.user_id);
  PERFORM set_config('kapdh.profile_lists', coalesce(previous, ''), true);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.alumni_professions_legacy_reproject() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous text;
  target uuid;
BEGIN
  IF app.profile_lists_api_writer() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    target := OLD.alumni_user_id;
  ELSE
    target := NEW.alumni_user_id;
  END IF;
  previous := current_setting('kapdh.profile_lists', true);
  PERFORM set_config('kapdh.profile_lists', 'api', true);
  PERFORM app.alumni_project_legacy_profile(target);
  PERFORM set_config('kapdh.profile_lists', coalesce(previous, ''), true);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER alumni_legacy_reproject
  AFTER INSERT OR UPDATE OF social_instagram, social_x, social_facebook, social_linkedin, last_education_institution
  ON app.alumni
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.alumni_legacy_reproject();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER alumni_professions_legacy_reproject
  AFTER INSERT OR UPDATE OR DELETE ON app.alumni_professions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.alumni_professions_legacy_reproject();
