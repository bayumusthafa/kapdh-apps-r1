/**
 * Urutan job rilis production (infra/scripts/release-job.sh; PRD 5.5, 8.2 langkah 2-4) pada PostgreSQL 17 nyata dengan
 * role production, bukan superuser: roles.sql (sebelum migrasi) → gerbang pra-migrasi (dilewati pada database kosong)
 * → migrasi sebagai LOGIN kapdh_migrator →
 * roles.sql (sesudah migrasi) → seed referensi sebagai kapdh_migrator → gerbang go-live sebagai kapdh_migrator.
 * Template jalur PG lain dimigrasi superuser; berkas ini membuktikan migrasi dan grant juga berjalan bila pemilik objek
 * adalah kapdh_migrator seperti di VPS. psql sendiri tidak dipakai di sini (tidak ada di mesin build); roles.sql
 * dijalankan lewat `sql.file()` postgres-js seperti global-setup.
 */
import { createDb, MIGRATIONS_FOLDER, runMigrations } from "@kapdh/database";
import { seedReference } from "@kapdh/database/seeds/reference";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import { runGoLiveGate } from "../../src/cli/golive-gate.js";
import type { Db } from "../../src/core/db/types.js";
import { approveProductionConfig } from "../support/golive.js";
import { connectAs, createEmptyPgDatabase, pgError } from "./support.js";

const ROLES_SQL = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../infra/db/roles.sql");
const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: unknown[];
};

describe("PRD 5.5/8.2: job rilis dengan role production pada PostgreSQL 17", () => {
  it("roles.sql → migrasi sebagai kapdh_migrator → roles.sql → seed → gerbang; ulangan idempoten; grant API/worker benar", async () => {
    const config = inject("kapdhPg");
    const tdb = await createEmptyPgDatabase("release_job", 2);
    const superuser = tdb.sql;
    // Sandi acak untuk LOGIN migrator di cluster uji sekali pakai (production: dari secrets manager, PRD 5.3).
    const password = randomBytes(12).toString("hex");
    const migratorUrl = `postgres://kapdh_migrator:${password}@${config.host}:${config.port}/${tdb.name}`;
    const migrator = createDb(migratorUrl, { max: 2, applicationName: "kapdh-pg-test-release" });
    const app = connectAs(tdb, "kapdh_app", 1);
    const worker = connectAs(tdb, "kapdh_worker", 1);
    try {
      // 1. Sebelum migrasi pertama: role dan hak tingkat database.
      await superuser.file(ROLES_SQL);
      await superuser.unsafe(`alter role kapdh_migrator password '${password}'`);
      // 1b. Gerbang pra-migrasi (mode enforce) pada database kosong: skema aplikasi belum ada → dilewati, lulus.
      const preflight = await runGoLiveGate(migrator.db as unknown as Db, { phase: "preflight" });
      expect(preflight).toMatchObject({ ok: true, phase: "preflight", checks: [] });
      expect(preflight.database.role).toBe("kapdh_migrator");
      expect(preflight.notes[0]).toContain("Skema aplikasi belum ada");
      // 2. Migrasi oleh pemilik skema non-superuser.
      expect((await runMigrations({ url: migratorUrl })).applied).toBe(JOURNAL.entries.length);
      // 3. Grant objek (append-only, mfa_totp, sequence) diterapkan ulang setelah migrasi.
      await superuser.file(ROLES_SQL);
      // 4. Seed referensi production sebagai migrator.
      const seeded = await seedReference(migrator.db);
      expect(seeded.settings_inserted).toBe(10);

      const owners = await superuser<{ owner: string }[]>`
        select distinct tableowner as owner from pg_tables where schemaname = 'app'`;
      expect(owners.map((r) => r.owner)).toEqual(["kapdh_migrator"]);

      // 5. Gerbang sebagai migrator: versi skema terbaca; database baru belum disahkan → ditolak.
      let report = await runGoLiveGate(migrator.db as unknown as Db);
      expect(report.database.role).toBe("kapdh_migrator");
      const schema = report.checks.find((c) => c.id === "schema")!;
      expect(schema.ok).toBe(true);
      expect(schema.details).toEqual([
        `Migrasi tercatat ${JOURNAL.entries.length}, journal image ${JOURNAL.entries.length}.`,
      ]);
      expect(report.ok).toBe(false);

      // Ulangan job rilis (deploy berikutnya): tidak ada migrasi baru, seed tidak menimpa, grant tetap.
      expect((await runMigrations({ url: migratorUrl })).applied).toBe(0);
      await superuser.file(ROLES_SQL);
      expect((await seedReference(migrator.db)).settings_inserted).toBe(0);

      // Konfigurasi disahkan pengurus (di production lewat web admin) → gerbang lulus.
      await approveProductionConfig(migrator.db as unknown as Db);
      report = await runGoLiveGate(migrator.db as unknown as Db);
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);

      // API (kapdh_app): DML biasa, audit append-only, tanpa akses bookkeeping migrasi.
      const [settings] = await app.sql<{ n: number }[]>`select count(*)::int as n from app.app_settings`;
      expect(settings?.n).toBe(10);
      const appUpdate = await app.sql`update app.audit_logs set reason = 'x'`.catch((e: unknown) => e);
      expect(pgError(appUpdate).code).toBe("42501");
      const appDrizzle = await app.sql`select count(*) from drizzle.__drizzle_migrations`.catch(
        (e: unknown) => e,
      );
      expect(pgError(appDrizzle).code).toBe("42501");
      // Worker (kapdh_worker): tanpa secret TOTP (least privilege, PRD 5.1).
      const workerTotp = await worker.sql`select count(*) from app.mfa_totp`.catch((e: unknown) => e);
      expect(pgError(workerTotp).code).toBe("42501");
      const [outbox] = await worker.sql<{ n: number }[]>`select count(*)::int as n from app.outbox_events`;
      expect(outbox?.n).toBe(0);
    } finally {
      await app.sql.end({ timeout: 5 });
      await worker.sql.end({ timeout: 5 });
      await migrator.sql.end({ timeout: 5 });
      await tdb.drop();
    }
  });
});
