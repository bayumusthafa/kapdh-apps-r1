import { Module } from "@nestjs/common";
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
 * modul membership (domain admin-members). Job worker ada di AdminJobsModule.
 */
@Module({
  imports: [AdminJobsModule],
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
