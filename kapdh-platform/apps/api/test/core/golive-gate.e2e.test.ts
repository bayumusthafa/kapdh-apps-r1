/**
 * Gerbang go-live (PRD 9.2 skenario "production dideploy dengan konfigurasi yang belum disahkan; gerbang menolak
 * go-live", PRD 9.3, U-12; temuan audit D2-02/D4-01) pada jalur bawaan PGlite: perintah CLI, format laporan dan kode
 * keluar. Bukti per kondisi di PostgreSQL 17 nyata ada di test/pg/golive-gate.pg.test.ts.
 */
import type { PGlite } from "@electric-sql/pglite";
import { appSettings, files, paymentMethods } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "../../src/cli/golive-check-command.js";
import {
  formatRupiah,
  type GateReport,
  maskAccountNumber,
  qrImageFingerprint,
  runGoLiveGate,
} from "../../src/cli/golive-gate.js";
import type { Db } from "../../src/core/db/types.js";
import {
  approveProductionConfig,
  insertAuditedPaymentMethod,
  QRIS_TEST_SHA256,
  seedQrisMethod,
} from "../support/golive.js";
import { createTestDatabase } from "../support/test-app.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function run(db: Db, args: string[] = []) {
  const io = capture();
  const code = await runGoLiveCheckCommand(args, {
    db,
    now: new Date("2026-10-14T03:00:00Z"),
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return { code, out: io.out(), err: io.err() };
}

const failedIds = (report: GateReport) => report.checks.filter((c) => !c.ok).map((c) => c.id);

describe("PRD 9.2/9.3, U-12: gerbang go-live (golive:check)", () => {
  let pg: PGlite;
  let db: Db;

  beforeEach(async () => {
    // Template uji = migrasi + seed referensi production, persis keadaan setelah job rilis pertama (PRD 8.2 butir 2, 4).
    ({ pg, db } = await createTestDatabase());
  });
  afterEach(async () => {
    await pg.close();
  });

  it("PRD 9.2: database production baru (hanya seed referensi) DITOLAK dengan kode 1 dan alasan per pemeriksaan", async () => {
    const report = await runGoLiveGate(db);
    expect(report.ok).toBe(false);
    expect(failedIds(report).sort()).toEqual(
      [
        "legal_pages",
        "masters",
        "payment_deciders",
        "payment_methods",
        "super_admins",
        "support_contact",
      ].sort(),
    );
    // Nominal D4 dari seed referensi tersahkan PRD; tidak ada fixture dev; skema mutakhir.
    for (const id of ["schema", "settings", "fees", "dev_fixtures"])
      expect(report.checks.find((c) => c.id === id)?.ok, id).toBe(true);

    const result = await run(db);
    expect(result.code).toBe(GOLIVE_EXIT.refused);
    expect(result.err).toBe("");
    expect(result.out).toContain("[GAGAL] Minimal 2 Super Admin aktif dengan TOTP terverifikasi");
    expect(result.out).toContain("Super Admin aktif ber-TOTP: 0 dari minimal 2");
    expect(result.out).toContain("Halaman kebijakan-privasi belum diterbitkan.");
    expect(result.out).toContain("Tidak ada metode bayar aktif");
    expect(result.out).toContain("HASIL: DITOLAK (6 pemeriksaan gagal)");
  });

  it("PRD 9.3: konfigurasi tersahkan → LULUS kode 0; laporan memuat nominal D4 dan rekening tersamar tanpa email", async () => {
    await approveProductionConfig(db);
    const result = await run(db);
    expect(result.code, result.out).toBe(GOLIVE_EXIT.passed);
    expect(result.out).toContain("Registrasi alumni baru: Rp50.000");
    expect(result.out).toContain("Pembuatan KTA: Rp10.000");
    expect(result.out).toContain("Perpanjangan per tahun: Rp10.000");
    expect(result.out).toContain("nilai awal D4 dari seed referensi");
    expect(result.out).toContain("Bank Syariah Indonesia (bank) ****6789 a.n. Keluarga Alumni PDH");
    expect(result.out).not.toContain("7123456789");
    // Email akun pengurus tidak pernah dicetak (hanya nama tampilan); email dukungan organisasi boleh.
    expect(result.out).not.toContain("pengurus-");
    expect(result.out).toContain("HASIL: LULUS");
    expect(result.out).not.toContain("[GAGAL]");
  });

  it("--json mencetak laporan terstruktur untuk arsip bukti gerbang", async () => {
    await approveProductionConfig(db);
    await db
      .update(appSettings)
      .set({ value: { registration_fee: "0.00", card_fee: "10000.00", renewal_fee: "10000.00" } })
      .where(eq(appSettings.key, "fees"));
    const result = await run(db, ["--json"]);
    expect(result.code).toBe(GOLIVE_EXIT.refused);
    const report = JSON.parse(result.out) as GateReport;
    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(["fees"]);
    expect(report.checks.find((c) => c.id === "fees")?.problems).toContain(
      "Registrasi alumni baru bernilai Rp0 (nominal kosong).",
    );
  });

  it("job rilis --preflight: tanpa schema/settings, laporan pra-migrasi; --json memuat fase", async () => {
    let result = await run(db, ["--preflight"]);
    expect(result.code).toBe(GOLIVE_EXIT.refused);
    expect(result.out).toContain("— pra-migrasi —");
    expect(result.out).not.toContain("Skema database pada versi rilis");
    expect(result.out).not.toContain("Seluruh app_settings tersimpan");
    expect(result.out).toContain("HASIL PRA-MIGRASI: DITOLAK (6 pemeriksaan gagal). Skema belum diubah");

    await approveProductionConfig(db);
    result = await run(db, ["--preflight", "--json"]);
    expect(result.code, result.out).toBe(GOLIVE_EXIT.passed);
    const report = JSON.parse(result.out) as GateReport;
    expect(report.phase).toBe("preflight");
    expect(report.checks.map((c) => c.id)).not.toContain("schema");
    expect(report.checks.map((c) => c.id)).not.toContain("settings");
    expect((await run(db)).out).toContain("HASIL: LULUS");
  });

  it("argumen tidak dikenal → kode 2; galat database → kode 3 tanpa pesan mentah", async () => {
    const usage = await run(db, ["--report"]);
    expect(usage.code).toBe(GOLIVE_EXIT.usage);
    expect(usage.err).toContain("Pakai: golive:check");
    expect(usage.out).toBe("");

    const broken = {
      execute: () =>
        Promise.reject(Object.assign(new Error("koneksi postgres://rahasia@db ditolak"), { code: "28P01" })),
    } as unknown as Db;
    const failed = await run(broken);
    expect(failed.code).toBe(GOLIVE_EXIT.error);
    expect(failed.err).toContain("(28P01)");
    expect(failed.err).not.toContain("rahasia");
    expect(failed.out).toBe("");
  });

  it("ADR-026: metode QRIS bergambar lulus; laporan memuat NMID tersamar dan sidik jari gambar untuk ditandatangani", async () => {
    const { superAdmins } = await approveProductionConfig(db);
    await seedQrisMethod(db, superAdmins[0]!);
    const result = await run(db);
    expect(result.code, result.out).toBe(GOLIVE_EXIT.passed);
    expect(result.out).toContain(
      `QRIS (qris) ****0607 a.n. KAPDH Pusat; gambar 1024x1024 px, sha256 ${QRIS_TEST_SHA256.slice(0, 12)}…`,
    );
    expect(result.out).toContain("termasuk sidik jari gambar QRIS");
    expect(result.out).not.toContain("ID1020304050607");
    expect(result.out).not.toContain(QRIS_TEST_SHA256);
  });

  it("ADR-026: metode lama bernama QRIS tanpa gambar (bank/e-wallet) ditolak di fase penuh DAN pra-migrasi", async () => {
    const { superAdmins } = await approveProductionConfig(db);
    const legacy = await insertAuditedPaymentMethod(db, superAdmins[0]!, {
      kind: "ewallet",
      provider: "QRIS KAPDH",
      accountNumber: "ID1020304050607",
    });
    const problem =
      'Metode "QRIS KAPDH" bernama QRIS tetapi berjenis ewallet tanpa gambar QR. Nonaktifkan metode ini lalu buat ' +
      "ulang sebagai metode QRIS dengan gambar QRIS statis resmi lewat web admin (ADR-026).";
    for (const phase of ["full", "preflight"] as const) {
      const report = await runGoLiveGate(db, { phase });
      expect(failedIds(report), phase).toEqual(["payment_methods"]);
      expect(report.checks.find((c) => c.id === "payment_methods")?.problems).toEqual([problem]);
    }
    // Nama yang hanya memuat kata lain (bukan kata utuh QRIS) tidak ditandai.
    await insertAuditedPaymentMethod(db, superAdmins[0]!, { provider: "Bank Qrisindo" });
    await db.update(paymentMethods).set({ active: false }).where(eq(paymentMethods.id, legacy));
    expect((await runGoLiveGate(db)).ok).toBe(true);
    expect((await runGoLiveGate(db, { phase: "preflight" })).ok).toBe(true);
  });

  it("ADR-026: gambar QRIS tidak siap (dibuang, privat, atau bukan payment_qr) ditolak fase penuh; pra-migrasi tidak membaca kolom 0008", async () => {
    const { superAdmins } = await approveProductionConfig(db);
    const { fileId } = await seedQrisMethod(db, superAdmins[0]!);
    const problem =
      'Metode QRIS "QRIS" tidak memiliki gambar QR yang siap ditampilkan (berkas payment_qr publik berstatus ' +
      "ready). Unggah ulang gambar QRIS lewat web admin.";
    await db.update(files).set({ status: "deleted", deletedAt: new Date() }).where(eq(files.id, fileId));
    let report = await runGoLiveGate(db);
    expect(failedIds(report)).toEqual(["payment_methods"]);
    expect(report.checks.find((c) => c.id === "payment_methods")?.problems).toEqual([problem]);
    // Pra-migrasi: gambar baru diperiksa gerbang penuh (kolom qr_image_file_id belum tentu ada).
    report = await runGoLiveGate(db, { phase: "preflight" });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "payment_methods")?.details).toContain(
      "QRIS (qris) ****0607 a.n. KAPDH Pusat; gambar QRIS diperiksa pada gerbang penuh setelah migrasi",
    );

    await db
      .update(files)
      .set({ status: "ready", deletedAt: null, visibility: "private" })
      .where(eq(files.id, fileId));
    expect(failedIds(await runGoLiveGate(db))).toEqual(["payment_methods"]);
    await db.update(files).set({ visibility: "public", purpose: "event_cover" }).where(eq(files.id, fileId));
    expect(failedIds(await runGoLiveGate(db))).toEqual(["payment_methods"]);
    await db.update(files).set({ purpose: "payment_qr" }).where(eq(files.id, fileId));
    expect((await runGoLiveGate(db)).ok).toBe(true);
  });

  it("format nominal Rupiah dan penyamaran nomor rekening (ARCHITECTURE §2.5, N-14)", () => {
    expect(qrImageFingerprint({ width: 800, height: 600, sha256: "f".repeat(64) })).toBe(
      `gambar 800x600 px, sha256 ${"f".repeat(12)}…`,
    );
    expect(formatRupiah("50000.00")).toBe("Rp50.000");
    expect(formatRupiah("1250000.50")).toBe("Rp1.250.000,50");
    expect(formatRupiah("0.00")).toBe("Rp0");
    expect(maskAccountNumber("712 345 6789")).toBe("****6789");
    expect(maskAccountNumber("123")).toBe("****");
  });
});
