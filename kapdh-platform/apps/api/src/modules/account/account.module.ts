import { Module } from "@nestjs/common";
import { AccountJobsModule } from "./account-jobs.module.js";
import { AccountDeletionController, WebDeletionController } from "./account.controller.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { DeletionDisclosureService } from "./deletion-disclosure.service.js";
import { OtpQuota } from "./otp-policy.js";
import { WebDeletionDecoys } from "./web-deletion-decoys.js";
import { WebDeletionService } from "./web-deletion.service.js";

/**
 * F-14 (ARCHITECTURE §4.1): penghapusan akun di aplikasi (GET /me/deletion/disclosure, POST /me/deletion) dan web
 * (/public/deletion/challenge, /verify, /confirm), job penghapusan dan deletion ledger (modul job).
 * `WebDeletionDecoys` diekspor agar modul auth dapat mendelegasikan POST /auth/otp/resend dan /auth/otp/status untuk
 * challenge pengganti penghapusan web (non-enumerasi, PRD 2.5).
 */
@Module({
  imports: [AccountJobsModule],
  controllers: [AccountDeletionController, WebDeletionController],
  providers: [AccountDeletionService, DeletionDisclosureService, WebDeletionService, WebDeletionDecoys, OtpQuota],
  exports: [WebDeletionDecoys],
})
export class AccountModule {}
