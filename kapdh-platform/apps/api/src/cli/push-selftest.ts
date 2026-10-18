/**
 * CLI uji mandiri push FCM (F-13; docs/runbooks/push-fcm.md). Dijalankan di kontainer API production setelah
 * FCM_PROJECT_ID/FCM_SERVICE_ACCOUNT_JSON diisi atau kuncinya dirotasi:
 *
 *   docker exec <kontainer-api> node dist/cli/push-selftest.js
 *   <perintah yang mencetak satu token> | docker exec -i <kontainer-api> node dist/cli/push-selftest.js --token-from-stdin
 *
 * Memeriksa isi JSON akun layanan (boolean saja), menukar token akses OAuth dengan kode yang sama dengan pengirim push
 * (`fetchFcmAccessToken`), lalu memanggil FCM HTTP v1 messages:send dengan `validate_only: true` ke token dummy
 * (dan, bila diminta, ke satu token perangkat nyata dari stdin). Tidak ada notifikasi yang terkirim. Keluaran tidak
 * pernah memuat private key, token akses, atau token FCM. Kode keluar: 0 LULUS, 1 GAGAL, 2 argumen/konfigurasi
 * salah, 3 galat teknis.
 */
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { resolve } from "node:path";
import { PUSH_SELFTEST_EXIT, runPushSelftestCommand } from "./push-selftest-command.js";

async function main(): Promise<number> {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  return runPushSelftestCommand(process.argv.slice(2), {
    env,
    now: new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Pesan galat konfigurasi aman dicetak (hanya nama variabel); galat lain hanya tipenya (N-14).
    const config = e instanceof EnvValidationError;
    process.stderr.write(`Gagal: ${config ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`}\n`);
    process.exitCode = config ? PUSH_SELFTEST_EXIT.usage : PUSH_SELFTEST_EXIT.error;
  },
);
