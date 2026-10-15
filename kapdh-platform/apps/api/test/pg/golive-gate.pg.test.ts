/**
 * Gerbang go-live pada PostgreSQL 17 nyata, satu uji per kondisi (PRD 9.2 "production dideploy dengan konfigurasi yang
 * belum disahkan (nominal kosong, fixture dev, atau tanpa Super Admin ber-TOTP); gerbang menolak go-live", PRD 9.3,
 * 8.2 langkah 2-4, 2.3, 10.2; U-12; temuan audit D2-02 dan D4-01). Setiap uji memakai database klon sendiri yang diisi
 * seed referensi production lalu konfigurasi tersahkan (test/support/golive.ts), kemudian merusak SATU kondisi.
 * Termasuk: penanda yang dapat dipalsukan anggota (nama saat registrasi) tidak menahan rilis, skema lebih baru dari image
 * (rollback), dan fase pra-migrasi job rilis.
 */
import "reflect-metadata";
import {
  adminPermissions,
  appSettings,
  masterProfessions,
  MIGRATIONS_FOLDER,
  pages,
  paymentMethods,
  posts,
  runMigrations,
  users,
} from "@kapdh/database";
import { seedDev } from "@kapdh/database/seeds/dev";
import { seedReference } from "@kapdh/database/seeds/reference";
import { eq, sql } from "drizzle-orm";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap.js";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "../../src/cli/golive-check-command.js";
import { type GateCheckId, type GateReport, runGoLiveGate } from "../../src/cli/golive-gate.js";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import type { Db } from "../../src/core/db/types.js";
import {
  approveProductionConfig,
  type GoLiveAdmin,
  insertAuditedPaymentMethod,
  insertGateAdmin,
  QRIS_TEST_SHA256,
  seedQrisMethod,
} from "../support/golive.js";
import { FakePush, TestClock, testEnv } from "../support/test-app.js";
import {
  connectAs,
  createEmptyPgDatabase,
  createPgTestDatabase,
  PG_CONSENT_VERSION,
  type PgTestDatabase,
} from "./support.js";

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

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};

/** Salinan folder migrasi yang journal-nya berhenti di `lastTag` (database rilis sebelumnya). */
function migrationsUpTo(lastTag: string): { dir: string; count: number } {
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`Tag migrasi tidak ada di journal: ${lastTag}`);
  const entries = journal.entries.slice(0, cut + 1);
  const dir = mkdtempSync(join(tmpdir(), "kapdh-migrations-"));
  mkdirSync(join(dir, "meta"));
  for (const e of entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return { dir, count: entries.length };
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
      expect(found).toContain("berita berjudul [Contoh]");
      expect(found).toContain("event berjudul [Contoh]");
      expect(found).toContain("metode bayar contoh");
      // Nama alumni diisi anggota sendiri: hanya catatan, bukan alasan penolakan.
      expect(found).not.toContain("alumni");
      const details = report.checks.find((c) => c.id === "dev_fixtures")!.details.join("\n");
      expect(details).toMatch(/Catatan \(tidak memblokir\): \d+ akun anggota bernama \[Contoh\]/);
      // Hanya akun fixture (.test, DEV_IDS): belum ada data nyata, reset terkendali masih diizinkan PRD 8.4.
      expect(details).toContain("Belum ada akun anggota nyata");
      expect(details).not.toContain("JANGAN reset");
      // Metode "[Bank Contoh]" juga bukan rekening organisasi.
      expect(problems(report, "payment_methods").join("\n")).toContain("[Bank Contoh]");
    });
  });

  it("PRD 2.5/8.4: pendaftar anonim bernama [Contoh] (POST /auth/register, pending_otp) dan anggota terverifikasi bernama [Contoh] tidak menahan rilis; konten pengurus [Contoh] menolak tanpa saran reset", async () => {
    await withDatabase("fixtures_member_names", true, async ({ tdb, db, superAdmins }) => {
      const api = connectAs(tdb, "kapdh_app", 4);
      const mailer = new MemoryMailer();
      const app = await createApp(
        {
          env: testEnv,
          db: api.db as unknown as Db,
          mailer,
          clock: new TestClock(),
          push: new FakePush(),
          redis: null,
        },
        { logger: false },
      );
      try {
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        const register = (fullName: string, email: string) =>
          app.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              full_name: fullName,
              gender: "male",
              email,
              password: "Kapdh#2026",
              cohort: 20,
              class_in: 1,
              class_out: 6,
              accept_policy_version: PG_CONSENT_VERSION,
            },
          });

        // Siapa pun dapat mendaftar dengan nama dan email bebas lalu tidak pernah memverifikasi OTP.
        const anonymous = await register("[Contoh] Pendaftar Iseng", "iseng@contoh.test");
        expect(anonymous.statusCode, anonymous.body).toBe(201);
        const [pending] = await tdb.sql<{ status: string; full_name: string }[]>`
          select u.status, a.full_name from app.users u join app.alumni a on a.user_id = u.id
          where u.email = 'iseng@contoh.test'`;
        expect(pending).toEqual({ status: "pending_otp", full_name: "[Contoh] Pendaftar Iseng" });
        let report = await runGoLiveGate(db);
        expect(failed(report)).toEqual([]);

        // Anggota nyata yang lolos OTP boleh menamai dirinya "[Contoh] ...": dicatat, tidak menolak.
        const email = "budi.anggota@kapdh-uji.id";
        const member = await register("[Contoh] Budi Anggota", email);
        expect(member.statusCode, member.body).toBe(201);
        const verify = await app.inject({
          method: "POST",
          url: "/api/v1/auth/otp/verify",
          payload: { challenge_id: member.json().challenge_id, code: mailer.last(email)! },
        });
        expect(verify.statusCode, verify.body).toBe(200);
        report = await runGoLiveGate(db);
        expect(failed(report)).toEqual([]);
        expect(report.checks.find((c) => c.id === "dev_fixtures")?.details).toContain(
          "Catatan (tidak memblokir): 1 akun anggota bernama [Contoh]; nama diisi anggota sendiri, tinjau bila perlu.",
        );

        // Konten pengurus berjudul [Contoh] tetap menolak; ada data nyata → saran tanpa reset (PRD 8.4).
        await db.insert(posts).values({
          id: uuidv7(),
          slug: "contoh-berita-uji-pengurus",
          title: "[Contoh] Berita uji pengurus",
          bodyHtml: "<p>uji</p>",
          authorAdminId: superAdmins[0]!.adminId,
        });
        report = await runGoLiveGate(db);
        expect(failed(report)).toEqual(["dev_fixtures"]);
        expect(problems(report, "dev_fixtures")).toEqual([
          "Fixture dev terdeteksi: 1 berita berjudul [Contoh].",
        ]);
        const details = report.checks.find((c) => c.id === "dev_fixtures")!.details.join("\n");
        expect(details).toContain("Sudah ada 1 akun anggota nyata: JANGAN reset");
        expect(details).not.toContain("Belum ada akun anggota nyata");
        // Tanpa data pribadi: email dan nama anggota tidak pernah dicetak.
        expect(JSON.stringify(report)).not.toContain(email);
        expect(JSON.stringify(report)).not.toContain("Budi Anggota");
      } finally {
        await app.close();
        await api.sql.end({ timeout: 5 });
      }
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

  it("PRD 5.5/8.4: skema lebih baru dari image → ditolak; --allow-schema-ahead (bukti rollback, baca saja) → peringatan", async () => {
    await withDatabase("schema_ahead", true, async ({ tdb, db }) => {
      await tdb.sql.unsafe(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ('migrasi-rilis-berikutnya', 9999999999999)",
      );
      let report = await runGoLiveGate(db);
      expect(failed(report)).toEqual(["schema"]);
      expect(problems(report, "schema")[0]).toContain("1 migrasi yang tidak dikenal image ini");
      expect(problems(report, "schema")[0]).toContain("runbook rilis bagian 6");

      report = await runGoLiveGate(db, { allowSchemaAhead: true });
      expect(failed(report)).toEqual([]);
      expect(report.checks.find((c) => c.id === "schema")?.details.join("\n")).toContain(
        "PERINGATAN: Database memuat 1 migrasi yang tidak dikenal image ini",
      );
      const out: string[] = [];
      const code = await runGoLiveCheckCommand(["--allow-schema-ahead"], {
        db,
        now: new Date(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => out.push(t) },
      });
      expect(code, out.join("")).toBe(GOLIVE_EXIT.passed);
    });
  });

  it("job rilis fase pra-migrasi: tanpa schema/settings; konfigurasi belum disahkan → ditolak SEBELUM migrasi", async () => {
    await withDatabase("preflight", false, async ({ tdb, db }) => {
      // Rilis baru: satu migrasi dan satu kunci app_settings belum diterapkan job ini (keadaan sebelum langkah 6-8).
      await tdb.sql.unsafe(
        "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
      );
      await db.delete(appSettings).where(eq(appSettings.key, "store_links"));
      const full = await runGoLiveGate(db);
      expect(failed(full)).toEqual(expect.arrayContaining(["schema", "settings", "super_admins"]));

      let report = await runGoLiveGate(db, { phase: "preflight" });
      expect(report.phase).toBe("preflight");
      expect(report.checks.map((c) => c.id)).not.toContain("schema");
      expect(report.checks.map((c) => c.id)).not.toContain("settings");
      expect(failed(report)).toContain("super_admins");
      const out: string[] = [];
      const code = await runGoLiveCheckCommand(["--preflight"], {
        db,
        now: new Date(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => out.push(t) },
      });
      expect(code).toBe(GOLIVE_EXIT.refused);
      expect(out.join("")).toContain("HASIL PRA-MIGRASI: DITOLAK");
      expect(out.join("")).toContain("Skema belum diubah");

      // Konfigurasi disahkan: pra-migrasi lulus walau skema/settings menunggu langkah migrasi dan seed.
      await approveProductionConfig(db);
      report = await runGoLiveGate(db, { phase: "preflight" });
      expect(failed(report)).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  it("ADR-026: metode QRIS bergambar lulus dengan sidik jari; gambar dibuang → ditolak; metode lama bernama QRIS → ditolak", async () => {
    await withDatabase("qris", true, async ({ db, superAdmins }) => {
      const { fileId } = await seedQrisMethod(db, superAdmins[0]!);
      let report = await runGoLiveGate(db);
      expect(failed(report)).toEqual([]);
      expect(report.checks.find((c) => c.id === "payment_methods")?.details).toContain(
        `QRIS (qris) ****0607 a.n. KAPDH Pusat; gambar 1024x1024 px, sha256 ${QRIS_TEST_SHA256.slice(0, 12)}…`,
      );
      await db.execute(sql`update app.files set status = 'deleted', deleted_at = now() where id = ${fileId}`);
      report = await runGoLiveGate(db);
      expect(problems(report, "payment_methods")).toEqual([
        'Metode QRIS "QRIS" tidak memiliki gambar QR yang siap ditampilkan (berkas payment_qr publik berstatus ' +
          "ready). Unggah ulang gambar QRIS lewat web admin.",
      ]);
      await db.execute(sql`update app.files set status = 'ready', deleted_at = null where id = ${fileId}`);
      await insertAuditedPaymentMethod(db, superAdmins[0]!, { kind: "ewallet", provider: "QRIS Lama" });
      report = await runGoLiveGate(db);
      expect(problems(report, "payment_methods")).toEqual([
        'Metode "QRIS Lama" bernama QRIS tetapi berjenis ewallet tanpa gambar QR. Nonaktifkan metode ini lalu buat ' +
          "ulang sebagai metode QRIS dengan gambar QRIS statis resmi lewat web admin (ADR-026).",
      ]);
    });
  });

  it("ADR-026: gerbang pra-migrasi image baru berjalan di skema 0007 (tanpa enum qris/kolom gambar); metode lama bernama QRIS ditolak SEBELUM migrasi 0008", async () => {
    const tdb = await createEmptyPgDatabase("golive_preflight_0007");
    try {
      const upTo0007 = migrationsUpTo("0007_auth_otp_decoys");
      try {
        await runMigrations({ url: tdb.url, migrationsFolder: upTo0007.dir });
      } finally {
        rmSync(upTo0007.dir, { recursive: true, force: true });
      }
      const db = tdb.db as unknown as Db;
      await seedReference(tdb.db);
      // Insert Drizzle payment_methods memuat kolom 0008, sehingga metode lama ditulis dengan SQL mentah.
      const { superAdmins } = await approveProductionConfig(db, { paymentMethod: false });
      const actor = superAdmins[0]!;
      const insertLegacy = async (kind: string, provider: string, accountNumber: string) => {
        const methodId = uuidv7();
        await tdb.sql`
          insert into app.payment_methods (id, kind, provider, account_number, account_holder, active, sort_order)
          values (${methodId}, ${kind}::app.payment_method_kind, ${provider}, ${accountNumber}, 'KAPDH', true, 1)`;
        await tdb.sql`
          insert into app.audit_logs (id, actor_user_id, actor_admin_id, effective_role, action, entity_type, entity_id,
                                      request_id)
          values (${uuidv7()}, ${actor.userId}, ${actor.adminId}, 'super_admin', 'payment_method.created',
                  'payment_method', ${methodId}, ${`uji-${uuidv7()}`})`;
        return methodId;
      };
      const legacy = await insertLegacy("ewallet", "QRIS", "ID1020304050607");
      await insertLegacy("bank", "Bank Syariah Indonesia", "7123456789");

      let report = await runGoLiveGate(db, { phase: "preflight" });
      expect(report.phase).toBe("preflight");
      expect(failed(report)).toEqual(["payment_methods"]);
      expect(problems(report, "payment_methods")[0]).toContain(
        'Metode "QRIS" bernama QRIS tetapi berjenis ewallet',
      );
      const out: string[] = [];
      const code = await runGoLiveCheckCommand(["--preflight"], {
        db,
        now: new Date(),
        stdout: { write: (t: string) => out.push(t) },
        stderr: { write: (t: string) => out.push(t) },
      });
      expect(code, out.join("")).toBe(GOLIVE_EXIT.refused);

      // Langkah rollout 1: nonaktifkan metode lama lewat web admin, lalu pra-migrasi lulus dan migrasi 0008 berjalan.
      await tdb.sql`update app.payment_methods set active = false where id = ${legacy}`;
      report = await runGoLiveGate(db, { phase: "preflight" });
      expect(report.ok).toBe(true);
      expect((await runMigrations({ url: tdb.url })).applied).toBe(journal.entries.length - upTo0007.count);
      report = await runGoLiveGate(db);
      expect(failed(report)).toEqual([]);
      // Bendahara membuat metode QRIS bergambar setelah migrasi: gerbang penuh tetap lulus dengan sidik jari.
      await seedQrisMethod(db, actor);
      report = await runGoLiveGate(db);
      expect(failed(report)).toEqual([]);
      expect(report.checks.find((c) => c.id === "payment_methods")?.details.join(" | ")).toContain(
        "gambar 1024x1024 px",
      );
    } finally {
      await tdb.drop();
    }
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
