/**
 * Gerbang go-live (PRD 9.2 skenario "production dideploy dengan konfigurasi yang belum disahkan; gerbang menolak
 * go-live", PRD 9.3, U-12; temuan audit D2-02/D4-01) pada jalur bawaan PGlite: perintah CLI, format laporan dan kode
 * keluar. Bukti per kondisi di PostgreSQL 17 nyata ada di test/pg/golive-gate.pg.test.ts.
 */
import type { PGlite } from "@electric-sql/pglite";
import { appSettings } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "../../src/cli/golive-check-command.js";
import {
  formatRupiah,
  type GateReport,
  maskAccountNumber,
  runGoLiveGate,
} from "../../src/cli/golive-gate.js";
import type { Db } from "../../src/core/db/types.js";
import { approveProductionConfig } from "../support/golive.js";
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

  it("format nominal Rupiah dan penyamaran nomor rekening (ARCHITECTURE §2.5, N-14)", () => {
    expect(formatRupiah("50000.00")).toBe("Rp50.000");
    expect(formatRupiah("1250000.50")).toBe("Rp1.250.000,50");
    expect(formatRupiah("0.00")).toBe("Rp0");
    expect(maskAccountNumber("712 345 6789")).toBe("****6789");
    expect(maskAccountNumber("123")).toBe("****");
  });
});
