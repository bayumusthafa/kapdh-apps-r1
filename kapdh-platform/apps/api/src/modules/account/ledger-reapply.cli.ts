/**
 * CLI penerapan ulang deletion ledger setelah restore backup (AC F14-6, PRD 5.5, runbook restore). Dijalankan
 * pengelola infra SETELAH database dan berkas dipulihkan dan SEBELUM API/worker dibuka:
 *
 *   node dist/modules/account/ledger-reapply.cli.js --dir /restore/ledger/account-deletions
 *   (atau `pnpm --filter @kapdh/api account:ledger-reapply -- --dir <folder>`)
 *
 * `--dir` menunjuk salinan ledger TERBARU (folder `ledger/account-deletions` di STORAGE_LOCAL_ROOT, hasil sinkron
 * bucket S3, atau salinan ledger pada manifest backup terbaru), bukan ledger dari backup yang dipulihkan. Tanpa
 * `--dir` dan STORAGE_DRIVER=local, folder STORAGE_LOCAL_ROOT/ledger/account-deletions dipakai. Memakai env worker
 * (koneksi kapdh_worker, anggota kapdh_audit_purge untuk anonimisasi audit). Keluar 1 bila ada entri yang gagal:
 * layanan tidak boleh dibuka sampai diselesaikan. Keluaran hanya nomor permintaan dan jumlah (tanpa data pribadi).
 */
import "reflect-metadata";
import { resolve } from "node:path";
import { EnvValidationError, loadDevelopmentEnvFile, loadWorkerEnv } from "@kapdh/config";
import { v7 as uuidv7 } from "uuid";
import { runAsSystem } from "../../core/context/request-context.js";
import { createWorkerContext, createWorkerDeps } from "../../worker.js";
import { LEDGER_PREFIX, readLedgerDirectory } from "./deletion-ledger.js";
import { DeletionLedgerService } from "./deletion-ledger.service.js";

class CliRefusedError extends Error {
  override name = "CliRefusedError";
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadWorkerEnv();
  const dir =
    arg("dir") ??
    (env.STORAGE_DRIVER === "local"
      ? resolve(process.cwd(), env.STORAGE_LOCAL_ROOT, LEDGER_PREFIX)
      : undefined);
  if (!dir) throw new CliRefusedError("Pakai: --dir <folder salinan ledger/account-deletions terbaru>");
  const entries = readLedgerDirectory(dir);
  const runtime = createWorkerDeps(env);
  const worker = await createWorkerContext(runtime.deps);
  try {
    const jobId = `ledger-reapply:${uuidv7()}`;
    const summary = await runAsSystem(() => worker.app.get(DeletionLedgerService).reapply(entries), {
      jobId,
    });
    process.stdout.write(
      [
        `Entri ledger         : ${summary.entries}`,
        `Diterapkan ulang     : ${summary.reapplied.length} ${summary.reapplied.join(", ")}`,
        `Sudah terhapus       : ${summary.alreadyDeleted.length}`,
        `Tidak ada di backup  : ${summary.absent.length}`,
        `Objek berkas dihapus : ${summary.objectsDeleted}`,
        `Gagal                : ${summary.failed.length} ${summary.failed.join(", ")}`,
        "",
      ].join("\n"),
    );
    return summary.failed.length > 0 ? 1 : 0;
  } finally {
    await worker.close();
    await runtime.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    // Hanya pesan konfigurasi/penolakan yang aman dicetak; galat lain hanya tipenya (N-14).
    const message =
      e instanceof EnvValidationError || e instanceof CliRefusedError
        ? e.message
        : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    process.stderr.write(`Gagal: ${message}\n`);
    process.exit(1);
  });
