import { Module } from "@nestjs/common";
import { PaymentsJobsModule } from "../payments/payments-jobs.module.js";
import { EventsJobsService } from "./events-jobs.service.js";
import { TicketLedger } from "./ticket-ledger.js";
import { TicketPaymentHandler } from "./ticket-payment.handler.js";

/**
 * Bagian modul events yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): `reservations.expire`, `events.lifecycle`,
 * `events.reminders`, handler topik `event.cancelled` (`events.cancelled.fanout`), dan handler pembayaran `ticket`
 * (PaymentHandlerRegistry.register di onModuleInit) karena job lain dapat memicu hook-nya, beserta layanan domain yang
 * mereka pakai (TicketLedger; PaymentsKernel lewat PaymentsJobsModule).
 * Diimpor modul events (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 * Layanan yang juga dipakai controller modul utama diekspor dari sini (`exports`).
 */
@Module({
  imports: [PaymentsJobsModule],
  providers: [TicketLedger, TicketPaymentHandler, EventsJobsService],
  exports: [TicketLedger, EventsJobsService, PaymentsJobsModule],
})
export class EventsJobsModule {}
