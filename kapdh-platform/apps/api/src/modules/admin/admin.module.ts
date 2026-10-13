import { Module } from "@nestjs/common";
import { AdminJobsModule } from "./admin-jobs.module.js";

/**
 * F-15, F-16, F-17 (ARCHITECTURE §4.1): dasbor, administrasi anggota, admin dan izin, pencarian/ekspor audit,
 * pengaturan aplikasi (SettingsService.update + @RequireReauth). Diisi agen modul admin (Tahap C).
 */
@Module({ imports: [AdminJobsModule] })
export class AdminModule {}
