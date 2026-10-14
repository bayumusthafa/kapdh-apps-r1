/**
 * CLI dataset sintetis uji beban STAGING (PRD 2.4 kondisi uji N-01/N-02/N-04, PRD 5.3; docs/runbooks/load-test.md).
 * Dijalankan pengelola infra di kontainer API staging, dengan env API (DATABASE_URL kapdh_app, BCRYPT_COST,
 * TOTP_ENC_KEY):
 *
 *   node dist/cli/loadtest-seed.js --confirm-database kapdh --out /tmp/kapdh-loadtest.json
 *   (atau: pnpm --filter @kapdh/api loadtest:seed -- --confirm-database ... --out ...)
 *
 * Prasyarat sekali di database staging (sebagai pemilik; JANGAN di production): ALTER DATABASE kapdh SET
 * kapdh.environment = 'staging'. Menolak NODE_ENV=production sebelum membuka koneksi, nama database yang tidak cocok,
 * dan database tanpa penanda itu (nama database staging dan production sama-sama `kapdh`). Berkas kredensial (sandi
 * akun uji dan secret TOTP admin uji) ditulis 0600 dan dipakai infra/loadtest/*.mjs; hapus setelah uji dan reset
 * database staging.
 */
import "reflect-metadata";
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { createDb } from "@kapdh/database";
import { resolve } from "node:path";
import type { Db } from "../core/db/types.js";
import { runLoadtestSeedCommand } from "./loadtest-seed-command.js";

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  if (env.NODE_ENV === "production") {
    process.stderr.write("Ditolak: dataset uji beban tidak pernah dibuat di production (PRD 5.3, 8.2).\n");
    return 1;
  }
  const { db, sql: client } = createDb(env.DATABASE_URL, {
    max: 1,
    applicationName: "kapdh-cli-loadtest-seed",
  });
  try {
    return await runLoadtestSeedCommand(process.argv.slice(2), {
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
    const message =
      e instanceof EnvValidationError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    process.stderr.write(`Gagal: ${message}\n`);
    process.exitCode = 1;
  },
);
