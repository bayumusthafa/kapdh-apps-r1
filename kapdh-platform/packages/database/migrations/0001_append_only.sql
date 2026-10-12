-- Audit dan histori payment bersifat append-only bagi application role (F-17, PRD 6.2). Trigger ini berlaku untuk
-- semua role, termasuk pemilik tabel, kecuali role kapdh_audit_purge yang dipakai eksplisit (SET ROLE) untuk
-- pembersihan/anonimisasi resmi sesuai D2. Grant role app/worker juga tidak memberi UPDATE/DELETE/TRUNCATE
-- (infra/db/roles.sql); trigger tetap menjaga bila grant keliru. Koreksi dicatat sebagai baris baru.
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND current_user = 'kapdh_audit_purge' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- insufficient_privilege (42501), bukan restrict_violation: PostgreSQL 18 memakai 23001 untuk FK ON DELETE
  -- RESTRICT sehingga kode itu tidak dapat membedakan pelanggaran append-only.
  RAISE EXCEPTION 'Tabel %.% bersifat append-only: % tidak diizinkan', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME,
          HINT = 'Catat koreksi sebagai baris baru; pembersihan resmi hanya melalui role kapdh_audit_purge.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON app.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON app.payment_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON app.payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
