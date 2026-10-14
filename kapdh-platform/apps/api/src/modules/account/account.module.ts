import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AccountJobsModule } from "./account-jobs.module.js";
import { AccountDeletionController, WebDeletionController } from "./account.controller.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { DeletionDecoyOtpInterceptor } from "./deletion-decoy-otp.interceptor.js";
import { DeletionDisclosureService } from "./deletion-disclosure.service.js";
import { DeletionLedgerGate } from "./deletion-ledger-gate.js";
import { OtpQuota } from "./otp-policy.js";
import { WebDeletionDecoys } from "./web-deletion-decoys.js";
import { WebDeletionService } from "./web-deletion.service.js";

/**
 * F-14 (ARCHITECTURE §4.1): penghapusan akun di aplikasi (GET /me/deletion/disclosure, POST /me/deletion) dan web
 * (/public/deletion/challenge, /verify, /confirm), job penghapusan dan deletion ledger (modul job).
 * Challenge pengganti penghapusan web pada POST /auth/otp/resend dan /auth/otp/status dijawab
 * {@link DeletionDecoyOtpInterceptor} (non-enumerasi, PRD 2.5); `WebDeletionDecoys` tetap diekspor agar modul auth
 * dapat mendelegasikan langsung. `DeletionLedgerGate` diekspor untuk readiness GET /health/ready (AC F14-6).
 */
@Module({
  imports: [AccountJobsModule],
  controllers: [AccountDeletionController, WebDeletionController],
  providers: [
    AccountDeletionService,
    DeletionDisclosureService,
    WebDeletionService,
    WebDeletionDecoys,
    OtpQuota,
    DeletionLedgerGate,
    { provide: APP_INTERCEPTOR, useClass: DeletionDecoyOtpInterceptor },
  ],
  exports: [WebDeletionDecoys, DeletionLedgerGate],
})
export class AccountModule {}
