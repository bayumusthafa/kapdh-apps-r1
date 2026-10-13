import { Module } from "@nestjs/common";

/**
 * Bagian modul content yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): `content.announce` (setiap menit, sekali per post terjadwal; ARCHITECTURE §4.8), beserta layanan domain yang mereka pakai.
 * Diimpor modul content (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 * Diisi agen modul content (Tahap C).
 */
@Module({})
export class ContentJobsModule {}
