import { Module } from "@nestjs/common";

/**
 * Bagian modul admin yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): `audit.export` (topik `audit.export.requested`) dan `maintenance.cleanup` harian (ARCHITECTURE §4.8), beserta layanan domain yang mereka pakai.
 * Diimpor modul admin (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 * Diisi agen modul admin (Tahap C).
 */
@Module({})
export class AdminJobsModule {}
