import { Module } from "@nestjs/common";
import { AdminReportsController } from "./admin-reports.controller.js";
import { AdminReportsService } from "./admin-reports.service.js";
import { BlocksController } from "./blocks.controller.js";
import { BlocksService } from "./blocks.service.js";
import { EvidenceFilePolicyRegistrar } from "./evidence-file-policy.js";
import { ModerationVisibility } from "./moderation-visibility.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

/**
 * F-12 (ARCHITECTURE §4.1; PRD 3.12): blokir dua arah dan laporan/banding anggota (moderation.yaml), antrean, bukti,
 * klaim dan keputusan pengurus (admin-moderation.yaml). Moderasi hanya di web admin. Modul ini tidak memiliki job
 * sehingga tidak dimuat worker; retensi berkas bukti ada di core/files (FilesService.discard) agar berlaku juga di
 * worker.
 *
 * Diekspor untuk modul lain: {@link ModerationVisibility} (aturan konflik kepentingan bersama untuk hitungan laporan
 * di dasbor/lencana menu dan AdminMemberDetail.moderation, kontrak admin-moderation aturan domain butir c).
 */
@Module({
  controllers: [BlocksController, ReportsController, AdminReportsController],
  providers: [
    BlocksService,
    ReportsService,
    AdminReportsService,
    ModerationVisibility,
    EvidenceFilePolicyRegistrar,
  ],
  exports: [ModerationVisibility],
})
export class ModerationModule {}
