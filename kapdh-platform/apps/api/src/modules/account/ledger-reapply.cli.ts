/**
 * CLI penerapan ulang deletion ledger setelah restore backup (AC F14-6, PRD 5.5, 8.4; docs/runbooks/backup-restore.md).
 * Dijalankan pengelola infra (infra/backup/restore.sh) SETELAH database dan berkas dipulihkan dan SEBELUM API/worker
 * dibuka:
 *
 *   image API  : node dist/modules/account/ledger-reapply.cli.js --dir /restore/ledger-offsite --dir /restore/ledger-backup
 *   image worker: node node_modules/@kapdh/api/dist/modules/account/ledger-reapply.cli.js --dir ...
 *   (repo dev: `pnpm --filter @kapdh/api account:ledger-reapply -- --dir <folder> [--dir <folder> ...]`)
 *
 * Folder `--dir` wajib dapat dibaca pengguna proses (image: `node`, uid 1000). Redis TIDAK dibutuhkan: CLI berjalan
 * saat layanan mati (sebelum Redis pulihan menyala), jadi klien Redis tidak dibuat walau REDIS_URL ada di env worker;
 * event realtime menjadi no-op karena belum ada klien tersambung.
 *
 * `--dir` (boleh diulang) menunjuk salinan ledger TERBARU, bukan hanya ledger dari backup yang dipulihkan:
 *   1. salinan bucket deletion ledger LUAR VPS (DELETION_LEDGER_S3_*, append-only; `rclone copy` oleh restore.sh), dan
 *   2. folder `ledger/account-deletions` dari backup berkas/manifest (entri sebelum bucket luar VPS dipakai).
 * Entri dari semua folder digabung per permintaan (completed mengalahkan requested, object key digabung). Tanpa
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
import { LEDGER_PREFIX, mergeLedgerEntries, readLedgerDirectory } from "./deletion-ledger.js";
import { DeletionLedgerService } from "./deletion-ledger.service.js";
import { argValues, CliRefusedError } from "./ledger-reapply-args.js";

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadWorkerEnv();
  const dirs = argValues(process.argv.slice(2), "dir");
  if (dirs.length === 0 && env.STORAGE_DRIVER === "local")
    dirs.push(resolve(process.cwd(), env.STORAGE_LOCAL_ROOT, LEDGER_PREFIX));
  if (dirs.length === 0)
    throw new CliRefusedError(
      "Pakai: --dir <folder salinan ledger/account-deletions terbaru> (boleh diulang)",
    );
  const entries = mergeLedgerEntries(dirs.flatMap((dir) => readLedgerDirectory(dir)));
  const runtime = createWorkerDeps(env, { redis: false });
  const worker = await createWorkerContext(runtime.deps);
  try {
    const jobId = `ledger-reapply:${uuidv7()}`;
    const summary = await runAsSystem(() => worker.app.get(DeletionLedgerService).reapply(entries), {
      jobId,
    });
    process.stdout.write(
      [
        `Folder ledger        : ${dirs.length}`,
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

// Penolakan promise yang lolos dari efek samping (mis. adapter pihak ketiga yang tidak menangkap galatnya sendiri)
// tidak boleh mematikan proses tanpa jejak di tengah penerapan ulang: catat tipenya saja (N-14) dan keluar 1 agar
// restore.sh berhenti dan layanan tetap tertutup. CLI idempoten, jadi dijalankan ulang setelah penyebabnya diperbaiki.
process.on("unhandledRejection", (e: unknown) => {
  process.stderr.write(`Gagal: penolakan tak tertangani ${(e as Error)?.name ?? "tidak dikenal"}\n`);
  process.exit(1);
});

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
