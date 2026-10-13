import { Module } from "@nestjs/common";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminCredentialsService } from "./admin-credentials.service.js";
import { AdminOnboardingService } from "./admin-onboarding.service.js";

/**
 * F-02 (admin): login sandi + TOTP/backup code, penerimaan undangan, pendaftaran TOTP, backup code, ganti sandi admin
 * (F-16, PRD 8.2; ARCHITECTURE §4.1). Pemeriksaan sandi, penerbitan sesi, token dan cookie refresh admin memakai
 * primitif core (core/identity), sehingga modul ini tidak bergantung pada modul auth. Refresh dan logout admin
 * dilayani POST /auth/refresh dan /auth/logout (modul auth). Super Admin pertama dibuat lewat CLI
 * `src/cli/bootstrap-admin.ts` (PRD 8.2 langkah 3), tidak pernah lewat HTTP.
 */
@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminOnboardingService, AdminCredentialsService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
