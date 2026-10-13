import { Module } from "@nestjs/common";
import { AdminMembersController } from "./admin-members.controller.js";
import { AdminMembersService } from "./admin-members.service.js";
import { KtaVerifyController } from "./kta-verify.controller.js";
import { KtaVerifyService } from "./kta-verify.service.js";
import { MastersController } from "./masters.controller.js";
import { MeController } from "./me.controller.js";
import { MemberCardService } from "./member-card.service.js";
import { MemberPasswordResetService } from "./member-password-reset.service.js";
import { MemberProfileService } from "./member-profile.service.js";
import { MembershipJobsModule } from "./membership-jobs.module.js";

/**
 * F-05, F-06, F-07, F-15 (anggota), F-16 (pemulihan sandi alumni): /me, profil, kartu (KTA), periode keanggotaan,
 * master (baca), verifikasi KTA publik, anggota untuk pengurus, pengingat kedaluwarsa (ARCHITECTURE §4.1). Fungsi
 * murni nomor anggota/periode/effective_status dan MembershipKernel ada di core/membership.
 */
@Module({
  imports: [MembershipJobsModule],
  controllers: [MeController, MastersController, KtaVerifyController, AdminMembersController],
  providers: [
    MemberProfileService,
    MemberCardService,
    KtaVerifyService,
    AdminMembersService,
    MemberPasswordResetService,
  ],
  exports: [MemberProfileService],
})
export class MembershipModule {}
