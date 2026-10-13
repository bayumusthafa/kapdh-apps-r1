import { Module } from "@nestjs/common";

/**
 * Bagian modul payments yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): layanan pembayaran yang dibutuhkan job modul lain (mis. pembatalan payment saat penghapusan akun) dan handler topik pembayaran, beserta layanan domain yang mereka pakai.
 * Diimpor modul payments (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 * Diisi agen modul payments (Tahap C).
 */
@Module({})
export class PaymentsJobsModule {}
