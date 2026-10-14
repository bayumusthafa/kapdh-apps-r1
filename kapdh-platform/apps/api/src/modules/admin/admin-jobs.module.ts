import { Module } from "@nestjs/common";
import { AdminMailJob } from "./admin-mail.job.js";
import { AuditExportJob } from "./audit-export.job.js";
import { MaintenanceCleanupJob } from "./maintenance-cleanup.job.js";

/**
 * Bagian modul admin yang DIMUAT WORKER (ARCHITECTURE §1, §4.8): `audit.export` (topik `audit.export.requested`),
 * email pengurus (topik `admin.invitation.requested` dan `admin.security_notice`, F-16) dan `maintenance.cleanup`
 * harian, beserta layanan domain yang mereka pakai.
 * Diimpor modul admin (sehingga job juga terdaftar di aplikasi API/uji: `jobs.runScheduled(name)`) dan oleh
 * createWorkerContext lewat WORKER_MODULES. Tanpa controller. Provider di sini TIDAK BOLEH bergantung pada layanan
 * khusus API (TokenService, SessionIssuer, PasswordVerifier, QrTokenService, SessionValidator, AuthGuard, RequestGate,
 * RealtimeGateway) karena worker memakai WorkerEnv tanpa secret JWT/OTP/TOTP/QR (least privilege); controller dan
 * layanan yang memerlukannya tetap di modul utama. Uji `test/core/jobs.e2e.test.ts` gagal bila aturan ini dilanggar.
 */
@Module({
  providers: [AuditExportJob, AdminMailJob, MaintenanceCleanupJob],
  exports: [AuditExportJob, AdminMailJob, MaintenanceCleanupJob],
})
export class AdminJobsModule {}
