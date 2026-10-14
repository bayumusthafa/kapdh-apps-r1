import { Module } from "@nestjs/common";
import { AccountDeletionProcessor } from "./deletion-processor.js";
import { DeletionLedgerService } from "./deletion-ledger.service.js";
import { DeletionRequestService } from "./deletion-request.service.js";
import { DeletionSteps } from "./deletion-steps.js";
import { OffsiteDeletionLedger } from "./offsite-deletion-ledger.js";

/**
 * Bagian modul account yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): job `account.deletion` (topik
 * `account.deletion.requested` + sapuan ulang 10 menit), langkah penghapusan, penerapan ulang deletion ledger
 * (AC F14-6), deletion ledger luar VPS (D5-07), dan transisi permintaan yang juga dipakai controller modul utama.
 * Diimpor modul account (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 */
@Module({
  providers: [
    DeletionRequestService,
    DeletionSteps,
    AccountDeletionProcessor,
    DeletionLedgerService,
    OffsiteDeletionLedger,
  ],
  exports: [DeletionRequestService, AccountDeletionProcessor, DeletionLedgerService, OffsiteDeletionLedger],
})
export class AccountJobsModule {}
