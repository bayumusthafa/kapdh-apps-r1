/**
 * CLI gerbang go-live production (PRD 9.2 "production dideploy dengan konfigurasi yang belum disahkan (nominal kosong,
 * fixture dev, atau tanpa Super Admin ber-TOTP); gerbang menolak go-live", PRD 9.3, U-12). Hanya membaca database.
 *
 *   DATABASE_URL=postgres://kapdh_migrator:...@db:5432/kapdh node dist/cli/golive-check.js [--json]
 *   pnpm --filter @kapdh/api golive:check
 *
 * Dijalankan job rilis (infra/scripts/release-job.sh) setelah migrasi dan seed referensi; kode keluar bukan nol
 * menggagalkan job sehingga image tidak dipromosikan. Rincian: docs/runbooks/rilis-dan-gerbang-go-live.md.
 */
import { createDb } from "@kapdh/database";
import type { Db } from "../core/db/types.js";
import { GOLIVE_EXIT, runGoLiveCheckCommand } from "./golive-check-command.js";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    process.stderr.write("Gagal: DATABASE_URL wajib diisi dengan URL postgres://.\n");
    return GOLIVE_EXIT.usage;
  }
  const { db, sql } = createDb(url, { max: 1, applicationName: "kapdh-golive-check" });
  try {
    return await runGoLiveCheckCommand(process.argv.slice(2), {
      db: db as unknown as Db,
      now: new Date(),
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Hanya tipe galat; pesan dapat memuat URL atau parameter SQL (N-14).
    process.stderr.write(`Gagal: galat ${(e as Error)?.name ?? "tidak dikenal"}\n`);
    process.exitCode = GOLIVE_EXIT.error;
  },
);
