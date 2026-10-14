import type { Db } from "../core/db/types.js";
import type { CliOutput } from "./bootstrap-admin-command.js";
import { type GateOptions, type GateReport, runGoLiveGate } from "./golive-gate.js";

/** Kode keluar perintah gerbang go-live (dipakai infra/scripts/release-job.sh). */
export const GOLIVE_EXIT = {
  /** Semua pemeriksaan lulus. */
  passed: 0,
  /** Gerbang menolak: konfigurasi production belum disahkan (PRD 9.2, 9.3). */
  refused: 1,
  /** Argumen salah. */
  usage: 2,
  /** Galat teknis (database tidak terjangkau, skema belum ada): bukan keputusan gerbang. */
  error: 3,
} as const;

export const GOLIVE_USAGE = [
  "Pakai: golive:check [--json] [--preflight] [--allow-schema-ahead]",
  "  DATABASE_URL          URL postgres:// (disarankan role kapdh_migrator agar versi skema ikut diperiksa).",
  "  --json                cetak laporan JSON (arsip bukti gerbang) alih-alih teks.",
  "  --preflight           fase pra-migrasi job rilis: tanpa pemeriksaan schema/settings; dilewati bila skema",
  "                        aplikasi belum ada (inisialisasi pertama).",
  "  --allow-schema-ahead  skema lebih baru dari image dicatat sebagai peringatan (bukti rollback image, baca saja).",
  "Kode keluar: 0 lulus, 1 ditolak, 2 argumen salah, 3 galat teknis.",
].join("\n");

const FLAGS = new Set(["--json", "--preflight", "--allow-schema-ahead"]);

export interface GoLiveCheckDeps {
  db: Db;
  now: Date;
  stdout: CliOutput;
  stderr: CliOutput;
}

/** Laporan teks berbahasa Indonesia untuk operator dan bukti gerbang (PRD 9.3). */
export function formatGateReport(report: GateReport): string {
  const preflight = report.phase === "preflight";
  const lines = [
    `Gerbang go-live KAPDH (PRD 9.2, 9.3; U-12)${preflight ? " — pra-migrasi" : ""} — ${report.checkedAt}`,
    `Database ${report.database.name} sebagai role ${report.database.role}.`,
    "",
  ];
  for (const c of report.checks) {
    lines.push(`[${c.ok ? "LULUS" : "GAGAL"}] ${c.title} (${c.ref})`);
    for (const problem of c.problems) lines.push(`    ✗ ${problem}`);
    for (const detail of c.details) lines.push(`    · ${detail}`);
  }
  if (report.notes.length > 0) {
    lines.push("", "Catatan (tidak memblokir):");
    for (const note of report.notes) lines.push(`    · ${note}`);
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  let verdict: string;
  if (preflight)
    verdict = report.ok
      ? "HASIL PRA-MIGRASI: LULUS. Gerbang penuh tetap dijalankan setelah migrasi dan seed referensi."
      : `HASIL PRA-MIGRASI: DITOLAK (${failed} pemeriksaan gagal). Skema belum diubah; perbaiki konfigurasi lalu ulangi job rilis.`;
  else
    verdict = report.ok
      ? "HASIL: LULUS. Lampirkan laporan ini pada bukti gerbang; bendahara, pengurus dan QA tetap wajib menandatangani (PRD 9.3)."
      : `HASIL: DITOLAK (${failed} pemeriksaan gagal). Jangan go-live atau mempromosikan image ke production sebelum diperbaiki.`;
  lines.push("", verdict, "");
  return lines.join("\n");
}

/**
 * Perintah gerbang go-live (PRD 9.2 skenario konfigurasi belum disahkan, PRD 9.3), dipisah dari entry
 * `golive-check.ts` agar dapat diuji tanpa proses baru. Mengembalikan kode keluar {@link GOLIVE_EXIT}.
 * Galat teknis hanya dicetak nama tipe dan kode SQLSTATE (pesan dapat memuat parameter kueri, N-14).
 */
export async function runGoLiveCheckCommand(args: readonly string[], deps: GoLiveCheckDeps): Promise<number> {
  const unknown = args.filter((a) => !FLAGS.has(a));
  if (unknown.length > 0) {
    deps.stderr.write(`Argumen tidak dikenal: ${unknown.join(" ")}\n${GOLIVE_USAGE}\n`);
    return GOLIVE_EXIT.usage;
  }
  const options: GateOptions = {
    now: deps.now,
    phase: args.includes("--preflight") ? "preflight" : "full",
    allowSchemaAhead: args.includes("--allow-schema-ahead"),
  };
  let report: GateReport;
  try {
    report = await runGoLiveGate(deps.db, options);
  } catch (e) {
    const err = e as { name?: string; code?: string; cause?: { code?: string } };
    const code = err?.cause?.code ?? err?.code;
    deps.stderr.write(
      `Gerbang go-live tidak dapat dijalankan: galat ${err?.name ?? "tidak dikenal"}${code ? ` (${code})` : ""}. ` +
        "Periksa DATABASE_URL dan pastikan job migrasi sudah berjalan.\n",
    );
    return GOLIVE_EXIT.error;
  }
  deps.stdout.write(
    args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatGateReport(report),
  );
  return report.ok ? GOLIVE_EXIT.passed : GOLIVE_EXIT.refused;
}
