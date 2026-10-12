-- Penjaga Super Admin aktif terakhir (AC F16-2, PRD 6.2, 9.2): pemeriksaan jumlah biasa tanpa locking tidak cukup
-- pada READ COMMITTED. Desain:
-- 1. Trigger statement BEFORE UPDATE OF role, status OR DELETE mengambil pg_advisory_xact_lock sebelum statement
--    mengunci baris apa pun. Demosi bersamaan menjadi berurutan dengan urutan kunci global yang sama sehingga
--    tidak terjadi deadlock antara dua demosi.
-- 2. Trigger baris: bila Super Admin aktif akan berhenti menjadi Super Admin aktif (status/role berubah atau baris
--    dihapus), Super Admin aktif lain dikunci FOR NO KEY UPDATE (kunci keluarga FOR UPDATE yang menahan
--    UPDATE/DELETE bersamaan, tetapi tidak bentrok dengan kunci KEY SHARE dari FK) lalu dihitung dengan snapshot
--    baru; bila tidak ada yang tersisa, transaksi ditolak dengan check_violation `admins_last_super_admin_chk`.
-- Transaksi kedua menunggu lock sampai transaksi pertama selesai, lalu melihat hasil commit-nya.
CREATE FUNCTION app.admins_serialize_super_admin_changes() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Kunci transaksi tetap khusus penjaga Super Admin (berbeda dari kunci job migrasi).
  PERFORM pg_advisory_xact_lock(4711000518);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.admins_guard_last_super_admin() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining integer;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM app.admins WHERE role = 'super_admin' AND status = 'active') THEN
      RAISE EXCEPTION 'Tabel app.admins tidak dapat dikosongkan selama ada Super Admin aktif'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'admins_last_super_admin_chk',
              SCHEMA = 'app',
              TABLE = 'admins';
    END IF;
    RETURN NULL;
  END IF;

  -- Baris lama bukan Super Admin aktif: tidak mengurangi jumlah Super Admin aktif.
  IF OLD.role <> 'super_admin' OR OLD.status <> 'active' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- Tetap Super Admin aktif setelah UPDATE.
  IF TG_OP = 'UPDATE' AND NEW.role = 'super_admin' AND NEW.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO remaining
  FROM (
    SELECT a.id
    FROM app.admins a
    WHERE a.role = 'super_admin' AND a.status = 'active' AND a.id <> OLD.id
    ORDER BY a.id
    FOR NO KEY UPDATE
  ) AS locked_super_admins;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'Super Admin aktif terakhir tidak dapat dinonaktifkan, diturunkan, atau dihapus'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'admins_last_super_admin_chk',
            SCHEMA = 'app',
            TABLE = 'admins',
            HINT = 'Aktifkan Super Admin lain terlebih dahulu (AC F16-2).';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admins_serialize_super_admin_changes BEFORE UPDATE OF role, status OR DELETE ON app.admins
  FOR EACH STATEMENT EXECUTE FUNCTION app.admins_serialize_super_admin_changes();
--> statement-breakpoint
CREATE TRIGGER admins_guard_last_super_admin BEFORE UPDATE OF role, status OR DELETE ON app.admins
  FOR EACH ROW EXECUTE FUNCTION app.admins_guard_last_super_admin();
--> statement-breakpoint
CREATE TRIGGER admins_guard_truncate BEFORE TRUNCATE ON app.admins
  FOR EACH STATEMENT EXECUTE FUNCTION app.admins_guard_last_super_admin();
