-- Penjaga identitas dan nomor anggota (PRD 2.3, F-16, PRD 3.5, AC F05-6; PRD 6.4 "constraint DB menguatkan batas
-- service").
--
-- 1. users.kind tidak dapat diubah: akun admin dan akun alumni pribadi adalah identitas login terpisah (PRD 2.3).
CREATE FUNCTION app.users_kind_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Jenis akun (kind) tidak dapat diubah'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'users_kind_immutable_chk',
            SCHEMA = 'app',
            TABLE = 'users',
            HINT = 'Identitas admin dan alumni memakai akun terpisah (PRD 2.3, F-16).';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_kind_immutable BEFORE UPDATE OF kind ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_kind_immutable();
--> statement-breakpoint
-- 2. Jenis akun yang dirujuk: alumni.user_id dan admins.linked_alumni_user_id wajib akun `alumni`, admins.user_id wajib
--    akun `admin`. Cek konflik kepentingan pembayaran bergantung pada tautan alumni yang benar-benar akun alumni
--    (ARCHITECTURE §3.3). Karena kind tidak dapat diubah, pemeriksaan saat INSERT/UPDATE kolom rujukan cukup dan tidak
--    memerlukan kunci. Akun yang tidak ada ditolak oleh FK; fungsi ini hanya menolak jenis yang salah.
CREATE FUNCTION app.assert_user_kind(p_user_id uuid, p_expected text, p_table text, p_constraint text) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  actual text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  SELECT u.kind INTO actual FROM app.users u WHERE u.id = p_user_id;
  IF FOUND AND actual <> p_expected THEN
    RAISE EXCEPTION 'Baris %.% wajib merujuk akun berjenis %, bukan %', 'app', p_table, p_expected, actual
      USING ERRCODE = 'check_violation',
            CONSTRAINT = p_constraint,
            SCHEMA = 'app',
            TABLE = p_table;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.alumni_check_user_kind() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM app.assert_user_kind(NEW.user_id, 'alumni', 'alumni', 'alumni_user_kind_chk');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER alumni_check_user_kind BEFORE INSERT OR UPDATE OF user_id ON app.alumni
  FOR EACH ROW EXECUTE FUNCTION app.alumni_check_user_kind();
--> statement-breakpoint
CREATE FUNCTION app.admins_check_user_kind() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM app.assert_user_kind(NEW.user_id, 'admin', 'admins', 'admins_user_kind_chk');
  PERFORM app.assert_user_kind(NEW.linked_alumni_user_id, 'alumni', 'admins', 'admins_linked_alumni_kind_chk');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admins_check_user_kind BEFORE INSERT OR UPDATE OF user_id, linked_alumni_user_id ON app.admins
  FOR EACH ROW EXECUTE FUNCTION app.admins_check_user_kind();
--> statement-breakpoint
-- 3. Nomor urut N anggota (PRD 3.5 "N dibuat sekali, unik global, tidak didaur ulang"; PRD 6.4; AC F05-6):
--    - pengisian pertama (INSERT bernilai atau UPDATE dari NULL) wajib sama dengan currval(app.membership_no_seq) sesi
--      ini, yaitu nilai yang baru saja diambil dengan nextval. Sequence tidak pernah mengulang nilai, jadi N anggota
--      yang telah dihapus (kaskade F-14) tidak dapat dipasang ke anggota lain;
--    - setelah terisi, N tidak dapat diubah atau dikosongkan. Koreksi admin hanya menghitung ulang prefix AA.SS.JK.
--    Alokasi: `nextval` lalu INSERT/UPDATE baris alumni tersebut dalam sesi/transaksi yang sama, tanpa nextval lain di
--    antaranya. Role tanpa hak sequence (kapdh_worker) tidak dapat mengalokasikan N.
CREATE FUNCTION app.alumni_guard_member_seq() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  drawn bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.member_seq IS NOT NULL THEN
    IF NEW.member_seq IS DISTINCT FROM OLD.member_seq THEN
      RAISE EXCEPTION 'Nomor urut anggota (N) tidak dapat diubah setelah dialokasikan'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'alumni_member_seq_immutable_chk',
              SCHEMA = 'app',
              TABLE = 'alumni',
              HINT = 'Koreksi admin hanya menghitung ulang prefix AA.SS.JK dan mempertahankan N (AC F05-6).';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.member_seq IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    drawn := currval('app.membership_no_seq');
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    drawn := NULL;
  END;
  IF drawn IS DISTINCT FROM NEW.member_seq THEN
    RAISE EXCEPTION 'Nomor urut anggota (N) wajib berasal dari nextval(app.membership_no_seq) pada sesi ini'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'alumni_member_seq_source_chk',
            SCHEMA = 'app',
            TABLE = 'alumni',
            HINT = 'N tidak pernah diketik atau didaur ulang (PRD 3.5).';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER alumni_guard_member_seq BEFORE INSERT OR UPDATE OF member_seq ON app.alumni
  FOR EACH ROW EXECUTE FUNCTION app.alumni_guard_member_seq();
