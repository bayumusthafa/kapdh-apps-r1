/**
 * CLI operator untuk akun alumni `disabled` (PRD 2.2 "disabled: pemulihan yang disetujui"; F-14). Tidak ada rute HTTP;
 * dijalankan pengelola infra atas permintaan pengurus yang berwenang, mengikuti runbook
 * docs/runbooks/alumni-account-disabled.md:
 *
 *   pnpm --filter @kapdh/api account:status -- --action disable --email <email> --reason "<alasan>" --approved-by "<nama>"
 *   (atau: node dist/modules/account/account-status.cli.js --action enable|delete ...)
 *
 * `disable` active -> disabled (sesi dicabut), `enable` disabled -> active (pemulihan yang disetujui), `delete`
 * disabled -> deletion_pending (permintaan penghapusan dari kanal bantuan setelah identitas pemilik diverifikasi; job
 * account.deletion yang sama dengan F-14). Memakai env worker (koneksi kapdh_worker). Setiap tindakan diaudit.
 */
import "reflect-metadata";
import { resolve } from "node:path";
import { EnvValidationError, loadDevelopmentEnvFile, loadWorkerEnv } from "@kapdh/config";
import { v7 as uuidv7 } from "uuid";
import { runAsSystem } from "../../core/context/request-context.js";
import { createWorkerContext, createWorkerDeps } from "../../worker.js";
import { runAccountStatusCommand } from "./account-status-command.js";
import { AccountStatusService } from "./account-status.service.js";

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadWorkerEnv();
  const runtime = createWorkerDeps(env);
  const worker = await createWorkerContext(runtime.deps);
  try {
    const service = worker.app.get(AccountStatusService);
    return await runAsSystem(
      () =>
        runAccountStatusCommand(process.argv.slice(2), {
          service,
          stdout: process.stdout,
          stderr: process.stderr,
        }),
      { jobId: `account-status:${uuidv7()}`, source: "cli" },
    );
  } finally {
    await worker.close();
    await runtime.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    // Hanya pesan konfigurasi yang aman dicetak; galat lain hanya tipenya (N-14).
    const message =
      e instanceof EnvValidationError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    process.stderr.write(`Gagal: ${message}\n`);
    process.exit(1);
  });
