import { Module } from "@nestjs/common";
import { ModerationModule } from "../moderation/moderation.module.js";
import { PaymentsJobsModule } from "../payments/payments-jobs.module.js";
import { AdminJobsModule } from "./admin-jobs.module.js";
import { AdminsController, PermissionsController } from "./admins.controller.js";
import { AdminsService } from "./admins.service.js";
import { AuditController } from "./audit.controller.js";
import { AuditExportService } from "./audit-export.service.js";
import { AuditSearchService } from "./audit.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";
import { SettingsController } from "./settings.controller.js";
import { AdminSettingsService } from "./settings.service.js";

/**
 * F-15, F-16, F-17 (ARCHITECTURE §4.1): dasbor sesuai izin, admin dan izin (undangan, peran, status, pemulihan),
 * pencarian/ekspor audit, pengaturan aplikasi (SettingsService.update + @RequireReauth). Administrasi anggota ada di
 * modul membership (domain admin-members). Job worker ada di AdminJobsModule. Hitungan antrean dasbor memakai fungsi
 * bersama modul pemilik domain: PaymentsKernel (PaymentsJobsModule) dan ModerationVisibility (ModerationModule).
 */
@Module({
  imports: [AdminJobsModule, PaymentsJobsModule, ModerationModule],
  controllers: [
    DashboardController,
    AdminsController,
    PermissionsController,
    AuditController,
    SettingsController,
  ],
  providers: [DashboardService, AdminsService, AuditSearchService, AuditExportService, AdminSettingsService],
})
export class AdminModule {}
