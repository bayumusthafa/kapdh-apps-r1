import { Module } from "@nestjs/common";
import { ExpiryRemindersService } from "./expiry-reminders.service.js";
import { PasswordResetNoticeHandler } from "./password-reset-notice.js";

/**
 * Bagian modul membership yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): job `membership.expiry-reminders` (setiap jam,
 * satu pengingat per periode dan satu pemberitahuan saat habis; AC F07-5, F13-6) dan handler topik outbox
 * `member.password_reset_initiated` (AC F16-4). Diimpor modul membership (sehingga job juga terdaftar di aplikasi
 * API/uji: `jobs.runScheduled(name)`) dan oleh createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di
 * sini TIDAK BOLEH bergantung pada layanan khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService,
 * SessionValidator, AuthGuard, RequestGate, RealtimeGateway) karena worker memakai WorkerEnv tanpa secret
 * JWT/OTP/TOTP/QR (least privilege). Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 */
@Module({
  providers: [ExpiryRemindersService, PasswordResetNoticeHandler],
  exports: [ExpiryRemindersService, PasswordResetNoticeHandler],
})
export class MembershipJobsModule {}
