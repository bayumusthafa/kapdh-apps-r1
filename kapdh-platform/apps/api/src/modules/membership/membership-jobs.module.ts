import { Module } from "@nestjs/common";

/**
 * Bagian modul membership yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): `membership.expiry-reminders` (setiap jam, satu per periode; ARCHITECTURE §4.8), beserta layanan domain yang mereka pakai.
 * Diimpor modul membership (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 * Diisi agen modul membership (Tahap C).
 */
@Module({})
export class MembershipJobsModule {}
