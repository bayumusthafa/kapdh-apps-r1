import { Module } from "@nestjs/common";

/**
 * Bagian modul files yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): job berkas milik modul files bila ada (job `files.cleanup-temp` sudah didaftarkan FilesService core), beserta layanan domain yang mereka pakai.
 * Diimpor modul files (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 * Diisi pemilik modul files (Tahap C).
 */
@Module({})
export class FilesJobsModule {}
