/**
 * Role operasi backup dan monitoring pada PostgreSQL 17 nyata (infra/db/roles.sql; PRD 5.5, N-06, N-09, N-14):
 *   - kapdh_backup: membaca seluruh data (pg_read_all_data) termasuk journal migrasi, TIDAK dapat menulis, dan dapat
 *     mengekspor snapshot yang diimpor koneksi kedua seperti `pg_dump --snapshot` di infra/backup/backup.sh, sehingga
 *     statistik manifest (infra/backup/sql/stats.sql) persis sama dengan isi dump;
 *   - kapdh_monitor: infra/monitoring/sql/app-health.sql berjalan dengan hak kolom saja; payload outbox dan data
 *     pribadi tidak terbaca.
 * pg_dump/restic sungguhan tidak tersedia di mesin build: dibuktikan restore drill staging (runbook backup-restore).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAs, createPgTestDatabase, insertUser, type PgTestDatabase, pgError } from "./support.js";

const INFRA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra");
const statsSql = readFileSync(join(INFRA, "backup", "sql", "stats.sql"), "utf8");
const appHealthSql = readFileSync(join(INFRA, "monitoring", "sql", "app-health.sql"), "utf8");

let tdb: PgTestDatabase;
beforeAll(async () => {
  tdb = await createPgTestDatabase("backup_roles", 4);
});
afterAll(async () => {
  await tdb.drop();
});

describe("kapdh_backup (PRD 5.5, N-06)", () => {
  it("snapshot yang diekspor sesi statistik diimpor koneksi kedua (pg_dump --snapshot): baris yang commit sesudahnya tidak terlihat; statistik = isi snapshot", async () => {
    await insertUser(tdb.sql);
    const exporter = connectAs(tdb, "kapdh_backup", 1);
    const importer = connectAs(tdb, "kapdh_backup", 1);
    try {
      let statsUsers = -1;
      let importedUsers = -1;
      await exporter.sql.begin("isolation level repeatable read read only", async (tx) => {
        const [snapshot] = await tx<{ id: string }[]>`select pg_export_snapshot() as id`;
        const [row] = await tx.unsafe<{ stats: string }[]>(`select (${statsSql})::text as stats`);
        const stats = JSON.parse(row!.stats) as {
          captured_at: string;
          schema: { applied: number; last_created_at: number };
          invariant: { users: number; paid_total: string };
        };
        statsUsers = stats.invariant.users;
        expect(stats.schema.applied).toBeGreaterThanOrEqual(8);
        expect(stats.invariant.paid_total).toMatch(/^\d+\.\d{2}$/);
        // Penulisan sesudah snapshot (layanan tetap berjalan selama backup).
        await insertUser(tdb.sql);
        await importer.sql.begin("isolation level repeatable read read only", async (tx2) => {
          await tx2.unsafe(`set transaction snapshot '${snapshot!.id}'`);
          const [count] = await tx2<{ n: number }[]>`select count(*)::int as n from app.users`;
          importedUsers = count!.n;
        });
      });
      expect(importedUsers).toBe(statsUsers);
      const [after] = await tdb.sql<{ n: number }[]>`select count(*)::int as n from app.users`;
      expect(after!.n).toBe(statsUsers + 1);
    } finally {
      await exporter.sql.end({ timeout: 5 });
      await importer.sql.end({ timeout: 5 });
    }
  });

  it("membaca seluruh data termasuk journal migrasi dan secret terenkripsi (dump lengkap), tetapi tidak dapat menulis apa pun", async () => {
    const backup = connectAs(tdb, "kapdh_backup", 1);
    try {
      await backup.sql`select count(*) from app.mfa_totp`;
      await backup.sql`select count(*) from app.audit_logs`;
      await backup.sql`select count(*) from drizzle.__drizzle_migrations`;
      await backup.sql`select last_value from app.membership_no_seq`;
      const insert = await backup.sql`insert into app.users (id, email, password_hash, status, kind)
        values (gen_random_uuid(), 'x@contoh.test', 'h', 'active', 'alumni')`.then(
        () => null,
        (e: unknown) => pgError(e),
      );
      expect(insert?.code).toBe("42501");
      const update = await backup.sql`update app.app_settings set version = version`.then(
        () => null,
        (e: unknown) => pgError(e),
      );
      expect(update?.code).toBe("42501");
      const ddl = await backup.sql`create table app.backup_tidak_boleh (x int)`.then(
        () => null,
        (e: unknown) => pgError(e),
      );
      expect(ddl?.code).toBe("42501");
    } finally {
      await backup.sql.end({ timeout: 5 });
    }
  });
});

describe("kapdh_monitor (PRD 5.5, N-14)", () => {
  it("app-health.sql berjalan dengan hak kolom; payload outbox, email dan secret tidak terbaca", async () => {
    const monitor = connectAs(tdb, "kapdh_monitor", 1);
    try {
      const results = await monitor.sql.unsafe<{ "?column?": string }[]>(appHealthSql);
      const lines = results.map((r) => Object.values(r)[0] as string);
      expect(lines.map((l) => l.split("=")[0])).toEqual([
        "outbox_oldest_pending_seconds",
        "outbox_dead",
        "push_provider_errors_1h",
        "email_provider_errors_1h",
        "deliveries_sent_1h",
        "deletions_failed",
        "deletions_overdue",
        "deletions_offsite_ledger_failed",
        "payments_review_oldest_hours",
      ]);
      expect(lines.every((l) => /^[a-z_0-9]+=\d+$/.test(l))).toBe(true);
      for (const query of [
        "select payload from app.outbox_events limit 1",
        "select email from app.users limit 1",
        "select amount from app.payments limit 1",
        "select ledger from app.account_deletions limit 1",
        "select secret_encrypted from app.mfa_totp limit 1",
      ]) {
        const denied = await monitor.sql.unsafe(query).then(
          () => null,
          (e: unknown) => pgError(e),
        );
        expect(denied?.code, query).toBe("42501");
      }
    } finally {
      await monitor.sql.end({ timeout: 5 });
    }
  });
});
