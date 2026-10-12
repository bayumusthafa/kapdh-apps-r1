-- Penjaga Super Admin terakhir yang masih DAPAT DIPAKAI (AC F16-2, PRD 6.2 "jaga Super Admin terakhir", PRD 3.14
-- "akun admin terakhir memerlukan serah kewenangan", PRD 9.2). Dapat dipakai = admins.role 'super_admin' DAN
-- admins.status 'active' DAN akun login users.status 'active' (adminLogin mensyaratkan akun aktif). Perubahan yang dapat
-- mengurangi himpunan itu wajib menyisakan minimal satu Super Admin lain yang dapat dipakai, bila tidak ditolak dengan
-- check_violation (23514) constraint `admins_last_super_admin_chk`:
--   - admins: UPDATE role/status/user_id atau DELETE (termasuk kaskade dari DELETE users), TRUNCATE;
--   - users : UPDATE status dari 'active' ke nilai lain atau DELETE akun berjenis admin yang aktif.
--
-- Konkurensi (READ COMMITTED, isolasi aplikasi):
-- 1. Trigger baris berjalan setelah statement mengunci baris target. Bila baris LAMA menunjukkan kemungkinan
--    pengurangan, trigger mengambil pg_advisory_xact_lock(4711000518) SEBELUM membaca fakta lain. Semua pengurangan
--    berurutan pada satu kunci global yang ditahan sampai commit; penghitung menunggu pengurangan yang belum commit.
-- 2. Setelah kunci diperoleh, status akun, baris admin, dan jumlah sisa dibaca dengan snapshot statement baru (fungsi
--    VOLATILE pada READ COMMITTED) sehingga hasil commit transaksi sebelumnya terlihat. Tidak ada row lock tambahan,
--    jadi pola layanan "SELECT ... FOR UPDATE baris sendiri lalu UPDATE" (ARCHITECTURE §2.11) tidak menimbulkan
--    deadlock dan pihak yang kalah selalu menerima 23514, bukan 40P01.
-- 3. Penambahan (promosi, aktivasi) tidak memerlukan kunci; penambahan yang belum commit tidak dihitung (konservatif).
-- 4. REPEATABLE READ/SERIALIZABLE memakai snapshot transaksi tetap sehingga hitungan dapat basi; pengurangan pada isolasi
--    itu ditolak eksplisit (feature_not_supported, 0A000) alih-alih berisiko meloloskan dua demosi.
-- Dalam satu transaksi yang mengubah admins dan users milik admin yang sama, ubah baris admins lebih dahulu.
CREATE FUNCTION app.super_admin_guard_lock() RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Perubahan yang dapat mengurangi Super Admin wajib berjalan pada isolasi READ COMMITTED'
      USING ERRCODE = 'feature_not_supported',
            HINT = 'Penjaga Super Admin terakhir menghitung ulang dengan snapshot statement baru setelah kunci (AC F16-2).';
  END IF;
  PERFORM pg_advisory_xact_lock(4711000518);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.usable_super_admins_except(p_admin_id uuid, p_user_id uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM app.admins a
  JOIN app.users u ON u.id = a.user_id
  WHERE a.role = 'super_admin'
    AND a.status = 'active'
    AND u.status = 'active'
    AND a.id IS DISTINCT FROM p_admin_id
    AND a.user_id IS DISTINCT FROM p_user_id;
  RETURN remaining;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.raise_last_super_admin(p_table text) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Super Admin terakhir yang dapat login tidak dapat dinonaktifkan, diturunkan, atau dihapus'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'admins_last_super_admin_chk',
          SCHEMA = 'app',
          TABLE = p_table,
          HINT = 'Aktifkan Super Admin lain dan serahkan kewenangan terlebih dahulu (AC F16-2, PRD 3.14).';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.admins_guard_last_super_admin() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_account_active boolean;
  new_account_active boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM app.admins WHERE role = 'super_admin' AND status = 'active') THEN
      PERFORM app.raise_last_super_admin('admins');
    END IF;
    RETURN NULL;
  END IF;

  -- Baris lama bukan Super Admin aktif: perubahan ini tidak mengurangi himpunan.
  IF OLD.role <> 'super_admin' OR OLD.status <> 'active' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- Tetap Super Admin aktif dengan akun login yang sama.
  IF TG_OP = 'UPDATE' AND NEW.role = 'super_admin' AND NEW.status = 'active' AND NEW.user_id = OLD.user_id THEN
    RETURN NEW;
  END IF;

  PERFORM app.super_admin_guard_lock();

  -- Akun login lama tidak aktif (atau sudah dihapus dalam transaksi ini, kaskade F-14): baris ini memang tidak dapat
  -- dipakai sehingga perubahannya tidak mengurangi himpunan.
  SELECT u.status = 'active' INTO old_account_active FROM app.users u WHERE u.id = OLD.user_id;
  IF NOT coalesce(old_account_active, false) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- Dipindah ke akun login lain yang aktif: tetap dapat dipakai.
  IF TG_OP = 'UPDATE' AND NEW.role = 'super_admin' AND NEW.status = 'active' THEN
    SELECT u.status = 'active' INTO new_account_active FROM app.users u WHERE u.id = NEW.user_id;
    IF coalesce(new_account_active, false) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF app.usable_super_admins_except(OLD.id, NULL) = 0 THEN
    PERFORM app.raise_last_super_admin('admins');
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.users_guard_last_super_admin() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Hanya akun admin aktif yang berhenti aktif atau dihapus yang dapat mengurangi himpunan. kind tidak dapat diubah
  -- dan admins.user_id selalu akun berjenis admin (migrasi 0004), jadi akun alumni tidak pernah mengambil kunci.
  IF OLD.kind <> 'admin' OR OLD.status <> 'active' OR (TG_OP = 'UPDATE' AND NEW.status = 'active') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM app.super_admin_guard_lock();

  IF EXISTS (
    SELECT 1 FROM app.admins a WHERE a.user_id = OLD.id AND a.role = 'super_admin' AND a.status = 'active'
  ) THEN
    IF app.usable_super_admins_except(NULL, OLD.id) = 0 THEN
      PERFORM app.raise_last_super_admin('users');
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admins_guard_last_super_admin BEFORE UPDATE OF role, status, user_id OR DELETE ON app.admins
  FOR EACH ROW EXECUTE FUNCTION app.admins_guard_last_super_admin();
--> statement-breakpoint
CREATE TRIGGER admins_guard_truncate BEFORE TRUNCATE ON app.admins
  FOR EACH STATEMENT EXECUTE FUNCTION app.admins_guard_last_super_admin();
--> statement-breakpoint
CREATE TRIGGER users_guard_last_super_admin BEFORE UPDATE OF status OR DELETE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_guard_last_super_admin();
