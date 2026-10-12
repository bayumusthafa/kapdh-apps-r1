-- Maksimal 10 keahlian per alumni (kontrak skill_ids maxItems 10, ARCHITECTURE §5.3). Baris alumni dikunci
-- FOR NO KEY UPDATE sebelum menghitung sehingga dua transaksi bersamaan tidak sama-sama lolos batas; kunci ini
-- tidak bentrok dengan kunci KEY SHARE dari FK. Batas sama dengan MAX_ALUMNI_SKILLS di schema/membership.ts.
CREATE FUNCTION app.alumni_skills_limit() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total integer;
BEGIN
  PERFORM 1 FROM app.alumni WHERE user_id = NEW.alumni_user_id FOR NO KEY UPDATE;
  SELECT count(*) INTO total
  FROM app.alumni_skills
  WHERE alumni_user_id = NEW.alumni_user_id
    AND (TG_OP = 'INSERT' OR skill_id <> OLD.skill_id OR alumni_user_id <> OLD.alumni_user_id);
  IF total >= 10 THEN
    RAISE EXCEPTION 'Alumni hanya dapat memiliki maksimal 10 keahlian'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'alumni_skills_limit_chk',
            SCHEMA = 'app',
            TABLE = 'alumni_skills';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER alumni_skills_limit BEFORE INSERT OR UPDATE OF alumni_user_id ON app.alumni_skills
  FOR EACH ROW EXECUTE FUNCTION app.alumni_skills_limit();
