import { Module } from "@nestjs/common";
import { PaymentLedger } from "./payment-ledger.js";
import { PaymentsKernel } from "./payments.kernel.js";

/**
 * Bagian modul payments yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): PaymentsKernel (API lintas modul: payment tiket,
 * pembatalan payment tiket/iuran, refund sistem D6, ringkasan antrean) yang dipakai job modul events dan account, serta
 * PaymentLedger (primitif tulis domain pembayaran) yang juga dipakai controller modul utama.
 * Diimpor modul payments (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 *
 * Modul lain memakai kernel dengan mengimpor modul ini: `@Module({ imports: [PaymentsJobsModule] })` lalu
 * menginjeksi `PaymentsKernel`.
 */
@Module({
  providers: [PaymentLedger, PaymentsKernel],
  exports: [PaymentLedger, PaymentsKernel],
})
export class PaymentsJobsModule {}
