/**
 * Gerbang go-live pada PostgreSQL 17 nyata, satu uji per kondisi (PRD 9.2 "production dideploy dengan konfigurasi yang
 * belum disahkan (nominal kosong, fixture dev, atau tanpa Super Admin ber-TOTP); gerbang menolak go-live", PRD 9.3,
 * 8.2 langkah 2-4, 2.3, 10.2; U-12; temuan audit D2-02 dan D4-01). Setiap uji memakai database klon sendiri yang diisi
 * seed referensi production lalu konfigurasi tersahkan (test/support/golive.ts), kemudian merusak SATU kondisi.
 */
import {
  adminPermissions,
  appSettings,
  masterProfessions,
  pages,
  paymentMethods,
  users,
} from "@kapdh/database";
import { seedDev } from "@kapdh/database/seeds/dev";
import { seedReference } from "@kapdh/database/seeds/reference";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "../../src/cli/golive-check-command.js";
import { type GateCheckId, type GateReport, runGoLiveGate } from "../../src/cli/golive-gate.js";
import type { Db } from "../../src/core/db/types.js";
import {
  approveProductionConfig,
  type GoLiveAdmin,
  insertAuditedPaymentMethod,
  insertGateAdmin,
} from "../support/golive.js";
import { connectAs, createPgTestDatabase, type PgTestDatabase } from "./support.js";

interface GateDb {
  tdb: PgTestDatabase;
  db: Db;
}

/** Database baru: migrasi (template) + seed referensi production; konfigurasi tersahkan bila `approved`. */
async function withDatabase(
  label: string,
  approved: boolean,
  fn: (ctx: GateDb & { superAdmins: GoLiveAdmin[] }) => Promise<void>,
): Promise<void> {
  const tdb = await createPgTestDatabase(`golive_${label}`, 4);
  try {
    const db = tdb.db as unknown as Db;
    await seedReference(tdb.db);
    const superAdmins = approved ? (await approveProductionConfig(db)).superAdmins : [];
    await fn({ tdb, db, superAdmins });
  } finally {
    await tdb.drop();
  }
}

function failed(report: GateReport): GateCheckId[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.id);
}

function problems(report: GateReport, id: GateCheckId): string[] {
  return report.checks.find((c) => c.id === id)?.problems ?? [];
}

describe("PRD 9.2/9.3: gerbang go-live pada PostgreSQL 17 (satu kondisi per uji)", () => {
  it("konfigurasi tersahkan lengkap → lulus; perintah keluar 0", async () => {
    await withDatabase("ok", true, async ({ db }) => {
      const report = await runGoLiveGate(db);
      expect(failed(report)).toEqual([]);
      expect(report.ok).toBe(true);
      const out: string[] = [];
      const code = await runGoLiveCheckCommand([], {
        db,
        now: new Date(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => out.push(t) },
      });
      expect(code, out.join("")).toBe(GOLIVE_EXIT.passed);
    });
  });

  it("PRD 9.2 nominal kosong: baris app_settings fees tidak ada (versi 0, API diam-diam memakai bawaan) → ditolak", async () => {
    await withDatabase("fees_missing", true, async ({ db }) => {
      await db.delete(appSettings).where(eq(appSettings.key, "fees"));
      const report = await runGoLiveGate(db);
      expect(failed(report).sort()).toEqual(["fees", "settings"]);
      expect(problems(report, "fees")[0]).toContain("Nominal kosong");
      expect(problems(report, "settings")[0]).toContain("fees");
    });
  });

  it("PRD 9.2 nominal kosong: biaya Rp0 → ditolak walau diubah lewat web admin", async () => {
    await withDatabase("fees_zero", true, async ({ db, superAdmins }) => {
      await db
        .update(appSettings)
        .set({
          value: { registration_fee: "50000.00", card_fee: "0.00", renewal_fee: "0.00" },
          version: sql`${appSettings.version} + 1`,
          updatedByAdminId: superAdmins[0]!.adminId,
        })
        .where(eq(appSettings.key, "fees"));
      const report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["fees"]);
      expect(problems(report, "fees")).toEqual([
        "Pembuatan KTA bernilai Rp0 (nominal kosong).",
        "Perpanjangan per tahun bernilai Rp0 (nominal kosong).",
      ]);
    });
  });

  it("PRD 9.3: nominal di luar D4 tanpa jejak pengurus (diubah langsung di database) → ditolak; lewat web admin → lulus", async () => {
    await withDatabase("fees_unapproved", true, async ({ db, superAdmins }) => {
      await db
        .update(appSettings)
        .set({
          value: { registration_fee: "75000.00", card_fee: "10000.00", renewal_fee: "15000.00" },
          version: sql`${appSettings.version} + 1`,
        })
        .where(eq(appSettings.key, "fees"));
      let report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["fees"]);
      expect(problems(report, "fees")[0]).toContain("tidak tercatat diubah pengurus");

      // SettingsService.update mengisi updated_by_admin_id untuk perubahan pengurus (audit settings.updated).
      await db
        .update(appSettings)
        .set({ updatedByAdminId: superAdmins[0]!.adminId })
        .where(eq(appSettings.key, "fees"));
      report = await runGoLiveGate(db);
      expect(failed(report)).toEqual([]);
      expect(report.checks.find((c) => c.id === "fees")?.details).toContain(
        "Registrasi alumni baru: Rp75.000",
      );
    });
  });

  it("PRD 9.2 fixture dev: seed:dev pernah dijalankan → ditolak dengan setiap penanda fixture", async () => {
    await withDatabase("fixtures_seed", true, async ({ tdb, db }) => {
      await seedDev(tdb.db);
      const report = await runGoLiveGate(db);
      expect(failed(report)).toContain("dev_fixtures");
      const found = problems(report, "dev_fixtures").join("\n");
      expect(found).toContain("eksekusi seed:dev (audit seed.dev)");
      expect(found).toContain("id tetap seed dev (DEV_IDS)");
      expect(found).toContain("domain email uji");
      expect(found).toContain("alumni bernama [Contoh]");
      expect(found).toContain("berita berjudul [Contoh]");
      expect(found).toContain("event berjudul [Contoh]");
      expect(found).toContain("metode bayar contoh");
      // Metode "[Bank Contoh]" juga bukan rekening organisasi.
      expect(problems(report, "payment_methods").join("\n")).toContain("[Bank Contoh]");
    });
  });

  it("PRD 9.2 fixture dev: satu akun aktif ber-email .test → ditolak; pendaftar pending_otp tidak menahan rilis", async () => {
    await withDatabase("fixtures_email", true, async ({ db }) => {
      await db.insert(users).values({
        id: uuidv7(),
        email: "pendaftar@contoh.test",
        passwordHash: "hash-uji",
        status: "pending_otp",
        kind: "alumni",
      });
      expect(failed(await runGoLiveGate(db))).toEqual([]);

      await db.insert(users).values({
        id: uuidv7(),
        email: "contoh9@kapdh.test",
        passwordHash: "hash-uji",
        status: "active",
        kind: "alumni",
        emailVerifiedAt: new Date(),
      });
      const report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["dev_fixtures"]);
      expect(problems(report, "dev_fixtures")).toEqual([
        "Fixture dev terdeteksi: 1 akun dengan domain email uji (.test/.example/.invalid/.localhost).",
      ]);
      // Hanya hitungan; email akun tidak pernah dicetak.
      expect(JSON.stringify(report)).not.toContain("contoh9@kapdh.test");
    });
  });

  it("PRD 9.2 tanpa Super Admin ber-TOTP: satu aktif ber-TOTP + satu tanpa TOTP + satu undangan → ditolak (1 dari 2)", async () => {
    await withDatabase("super_admin", false, async ({ db }) => {
      const owner = await insertGateAdmin(db, { displayName: "Bayu Musthafa" });
      await insertGateAdmin(db, { displayName: "Tanpa TOTP", totpVerified: false });
      await insertGateAdmin(db, { displayName: "Undangan", status: "invited" });
      await insertAuditedPaymentMethod(db, owner);
      const report = await runGoLiveGate(db);
      expect(failed(report)).toContain("super_admins");
      const superCheck = report.checks.find((c) => c.id === "super_admins")!;
      expect(superCheck.problems[0]).toContain("Super Admin aktif ber-TOTP: 1 dari minimal 2");
      expect(superCheck.details).toContain("Tanpa TOTP: TANPA TOTP");
      expect(superCheck.details).toContain(
        "1 Super Admin masih menunggu aktivasi undangan (belum dihitung).",
      );
    });
  });

  it("PRD 8.2: Super Admin yang akun users-nya dinonaktifkan tidak dihitung", async () => {
    await withDatabase("super_admin_disabled", true, async ({ db, superAdmins }) => {
      await insertGateAdmin(db, { displayName: "Super Admin Tiga" });
      // Penjaga Super Admin terakhir (migrasi 0002) tetap mengizinkan karena dua Super Admin lain masih dapat login.
      await db.update(users).set({ status: "disabled" }).where(eq(users.id, superAdmins[0]!.userId));
      await db.update(users).set({ status: "disabled" }).where(eq(users.id, superAdmins[1]!.userId));
      const report = await runGoLiveGate(db);
      expect(failed(report).sort()).toEqual(["payment_deciders", "super_admins"]);
    });
  });

  it("PRD 2.3: pengurus pemutus pembayaran butuh payments.read + payments.decide; minimal dua", async () => {
    await withDatabase("deciders", false, async ({ db }) => {
      const owner = await insertGateAdmin(db, { displayName: "Super Admin Satu" });
      const treasurer = await insertGateAdmin(db, {
        role: "admin",
        displayName: "Bendahara",
        permissions: ["payments.decide"],
      });
      await insertAuditedPaymentMethod(db, owner);
      let report = await runGoLiveGate(db);
      expect(failed(report)).toContain("payment_deciders");
      expect(problems(report, "payment_deciders")[0]).toContain("Hanya 1 pengurus");

      await db.insert(adminPermissions).values({ adminId: treasurer.adminId, permission: "payments.read" });
      report = await runGoLiveGate(db);
      expect(failed(report)).not.toContain("payment_deciders");
      // Super Admin kedua tetap wajib (PRD 8.2 langkah 3).
      expect(failed(report)).toContain("super_admins");
    });
  });

  it("PRD 8.2 langkah 4: halaman legal belum terbit, masih kerangka DRAF, atau app_settings legal tidak sinkron → ditolak", async () => {
    await withDatabase("legal", true, async ({ db }) => {
      await db
        .update(pages)
        .set({ publishedBodyHtml: sql`${pages.bodyHtml}` })
        .where(eq(pages.slug, "ketentuan"));
      await db
        .update(pages)
        .set({ publishedTitle: null, publishedBodyHtml: null, publishedVersion: null, publishedAt: null })
        .where(eq(pages.slug, "bantuan"));
      await db
        .update(appSettings)
        .set({ value: { privacy_version: "1", terms_version: "1", community_version: null } })
        .where(eq(appSettings.key, "legal"));
      const report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["legal_pages"]);
      expect(problems(report, "legal_pages")).toEqual([
        "Halaman ketentuan versi 1 masih kerangka DRAF seed referensi.",
        "app_settings legal.community_version (kosong) tidak sama dengan versi tayang ketentuan-komunitas (1); registrasi memakai versi persetujuan yang salah.",
        "Halaman bantuan belum diterbitkan.",
      ]);
    });
  });

  it("PRD 8.2 langkah 4: master usulan belum diaktifkan dan WhatsApp dukungan kosong → ditolak", async () => {
    await withDatabase("masters", true, async ({ db }) => {
      await db.update(masterProfessions).set({ active: false });
      await db
        .update(appSettings)
        .set({ value: { email: "bantuan@kapdh.or.id", whatsapp: null } })
        .where(eq(appSettings.key, "support"));
      const report = await runGoLiveGate(db);
      expect(failed(report).sort()).toEqual(["masters", "support_contact"]);
      expect(problems(report, "masters")).toEqual([
        "Belum ada master profesi aktif (daftar usulan seed masih nonaktif).",
      ]);
    });
  });

  it("D13/PRD 9.3: metode bayar tanpa jejak web admin, nomor nol, atau tidak ada yang aktif → ditolak", async () => {
    await withDatabase("methods", true, async ({ db }) => {
      const direct = uuidv7();
      await db.insert(paymentMethods).values({
        id: direct,
        kind: "bank",
        provider: "Bank Langsung",
        accountNumber: "9988776655",
        accountHolder: "KAPDH",
      });
      let report = await runGoLiveGate(db);
      expect(problems(report, "payment_methods")).toEqual([
        'Metode "Bank Langsung" tidak tercatat dibuat lewat web admin (audit payment_method.created tidak ada).',
      ]);

      await db.update(paymentMethods).set({ active: false });
      report = await runGoLiveGate(db);
      expect(problems(report, "payment_methods")).toEqual([
        "Tidak ada metode bayar aktif; anggota tidak dapat membayar iuran (D13).",
      ]);
    });
  });

  it("PRD 5.5: skema tertinggal dari journal image → ditolak", async () => {
    await withDatabase("schema", true, async ({ tdb, db }) => {
      await tdb.sql.unsafe(
        "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
      );
      const report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["schema"]);
      expect(problems(report, "schema")[0]).toContain("1 migrasi belum diterapkan");
    });
  });

  it("role production: kapdh_app dapat menjalankan gerbang (versi skema dicatat tidak terbaca); kapdh_worker → galat teknis 3", async () => {
    await withDatabase("roles", true, async ({ tdb }) => {
      const app = connectAs(tdb, "kapdh_app", 1);
      const worker = connectAs(tdb, "kapdh_worker", 1);
      try {
        const report = await runGoLiveGate(app.db as unknown as Db);
        expect(failed(report)).toEqual([]);
        expect(report.database.role).toBe("kapdh_app");
        expect(report.checks.find((c) => c.id === "schema")?.details[0]).toContain(
          "tidak dapat dibaca role ini",
        );

        // Worker tidak memiliki hak atas mfa_totp (roles.sql): gerbang gagal secara teknis, bukan "lulus".
        const err: string[] = [];
        const code = await runGoLiveCheckCommand([], {
          db: worker.db as unknown as Db,
          now: new Date(),
          stdout: { write: () => undefined },
          stderr: { write: (t: string) => err.push(t) },
        });
        expect(code).toBe(GOLIVE_EXIT.error);
        expect(err.join("")).toContain("42501");
      } finally {
        await app.sql.end({ timeout: 5 });
        await worker.sql.end({ timeout: 5 });
      }
    });
  });
});
