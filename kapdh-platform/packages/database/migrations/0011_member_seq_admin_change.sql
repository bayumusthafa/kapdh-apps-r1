-- Super Admin dapat mengubah nomor urut anggota (N) dari dashboard (ADR-028, menggantikan sebagian PRD 3.5 "N tidak
-- pernah diketik atau didaur ulang"). Trigger 0004 tetap menolak perubahan N dan N yang tidak berasal dari
-- nextval, kecuali transaksi API jalur Super Admin menyetel set_config('kapdh.member_seq', 'admin', true) tepat
-- sebelum UPDATE. Jalur itu hanya mengganti N lama dengan N lain (tidak pernah mengosongkan) dan keunikan tetap
-- dijaga indeks alumni_member_seq_key. Image API sebelum 0011 tidak menyetel flag sehingga perilakunya tidak berubah.
CREATE FUNCTION app.member_seq_admin_change() RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(current_setting('kapdh.member_seq', true), '') = 'admin'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.alumni_guard_member_seq() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  drawn bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.member_seq IS NOT NULL THEN
    IF NEW.member_seq IS DISTINCT FROM OLD.member_seq THEN
      IF NEW.member_seq IS NOT NULL AND app.member_seq_admin_change() THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Nomor urut anggota (N) tidak dapat diubah setelah dialokasikan'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'alumni_member_seq_immutable_chk',
              SCHEMA = 'app',
              TABLE = 'alumni',
              HINT = 'Koreksi admin hanya menghitung ulang prefix AA.SS.JK; N diubah lewat jalur Super Admin (ADR-028).';
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
            HINT = 'N baru selalu dari sequence; perubahan N oleh Super Admin hanya untuk N yang sudah ada (ADR-028).';
  END IF;
  RETURN NEW;
END;
$$;
