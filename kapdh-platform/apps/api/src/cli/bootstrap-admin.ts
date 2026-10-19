/**
 * CLI bootstrap Super Admin pertama (PRD 8.2 langkah 3, F-16). Dijalankan sekali di server, TIDAK PERNAH lewat HTTP
 * (tidak ada rute API yang memanggilnya):
 *
 *   pnpm --filter @kapdh/api admin:bootstrap --email admin@kapdh.or.id --name "Fikri Ramadhan"
 *   (atau: node dist/cli/bootstrap-admin.js --email ... --name ...)
 *
 * Menolak berjalan bila Super Admin aktif yang dapat login sudah ada. Bila belum, membuat Super Admin berstatus
 * `invited` dengan sandi awal acak yang tidak dapat dipakai, lalu mencetak SATU tautan undangan
 * `${ADMIN_ORIGIN}/invite#t=<token>` (72 jam, sekali pakai). Pemilik membuka tautan itu, mengganti sandi awal dan
 * mendaftarkan TOTP; akun aktif setelah kode autentikator pertama dikonfirmasi (alur undangan admin-auth yang sama
 * dengan admin lain). Eksekusi diaudit `admin.bootstrap` (aktor system).
 */
import "reflect-metadata";
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { createDb } from "@kapdh/database";
import { resolve } from "node:path";
import type { Db } from "../core/db/types.js";
import { runBootstrapAdminCommand } from "./bootstrap-admin-command.js";

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  const { db, sql: client } = createDb(env.DATABASE_URL, { max: 1, applicationName: "kapdh-cli-bootstrap" });
  try {
    return await runBootstrapAdminCommand(process.argv.slice(2), {
      db: db as unknown as Db,
      env,
      now: new Date(),
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Pesan galat konfigurasi aman dicetak; galat lain hanya tipenya (bisa memuat parameter SQL/URL database, N-14).
    const message =
      e instanceof EnvValidationError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    process.stderr.write(`Gagal: ${message}\n`);
    process.exitCode = 1;
  },
);
