import { EnvValidationError, loadDevelopmentEnvFile, loadWorkerEnv } from "@kapdh/config";
import { createRootLogger, safeError } from "@kapdh/api/worker";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { bootWorker, type WorkerService } from "./runtime.js";
import { resolveWorkerSettings } from "./settings.js";

/**
 * Entry worker KAPDH (ARCHITECTURE §4.8, PRD 5.1, 5.5): dispatcher outbox, antrean, penjadwal ber-leader, health.
 * Migrasi TIDAK dijalankan di sini (job deployment tunggal dengan lock, PRD 5.5). SIGTERM/SIGINT memicu shutdown halus;
 * sinyal kedua atau batas waktu keras menghentikan proses segera (job yang belum selesai dipulihkan lewat lease).
 */

/** Tenggang tambahan di atas WORKER_SHUTDOWN_TIMEOUT_MS untuk menutup pool sebelum proses dipaksa keluar. */
const HARD_EXIT_GRACE_MS = 10_000;

function fatalLine(msg: string, error: unknown): void {
  // Galat konfigurasi aman dicetak (hanya nama variabel); galat lain hanya bentuk aman (N-14).
  const detail =
    error instanceof EnvValidationError ? { type: error.name, message: error.message } : safeError(error);
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", time: new Date().toISOString(), service: "kapdh-worker", msg, error: detail })}\n`,
  );
}

function installSignalHandlers(worker: WorkerService, logger: Logger, shutdownTimeoutMs: number): void {
  let stopping = false;
  const shutdown = (reason: string, exitCode: number) => {
    if (stopping) {
      logger.warn({ reason }, "sinyal kedua saat shutdown; keluar paksa");
      process.exit(1);
    }
    stopping = true;
    const hardExit = setTimeout(() => {
      logger.error({ reason }, "shutdown melewati batas waktu keras; keluar paksa");
      process.exit(1);
    }, shutdownTimeoutMs + HARD_EXIT_GRACE_MS);
    hardExit.unref();
    void worker
      .stop(reason)
      .then((result) => process.exit(result.graceful ? exitCode : 1))
      .catch((error: unknown) => {
        logger.error({ error: safeError(error) }, "shutdown gagal");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
  // Galat tak tertangani: catat aman lalu berhenti halus (orkestrator menjalankan ulang container).
  process.on("uncaughtException", (error) => {
    logger.fatal({ error: safeError(error) }, "galat tak tertangani");
    shutdown("uncaught_exception", 1);
  });
  process.on("unhandledRejection", (error) => {
    logger.fatal({ error: safeError(error) }, "promise ditolak tanpa penanganan");
    shutdown("unhandled_rejection", 1);
  });
}

async function main(): Promise<void> {
  // Development: `cp .env.example .env` di kapdh-platform/ lalu `pnpm --filter @kapdh/worker start` (README).
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadWorkerEnv();
  if (!env.SMTP_URL && env.NODE_ENV !== "development")
    throw new EnvValidationError(
      "SMTP_URL wajib di luar development; email transaksional tidak boleh hanya dicetak ke log (N-14)",
    );
  const logger = createRootLogger({ level: env.LOG_LEVEL, service: "kapdh-worker" });
  const worker = await bootWorker(env, { logger });
  installSignalHandlers(worker, logger, resolveWorkerSettings(env).shutdownTimeoutMs);
}

main().catch((error: unknown) => {
  fatalLine("worker gagal start", error);
  process.exit(1);
});
