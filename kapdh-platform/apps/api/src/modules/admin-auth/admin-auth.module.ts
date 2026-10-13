import { Module } from "@nestjs/common";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthService } from "./admin-auth.service.js";

/**
 * F-02 (admin): login sandi + TOTP/backup code, penerimaan undangan, pendaftaran TOTP, backup code (F-16;
 * ARCHITECTURE §4.1). Pemeriksaan sandi, penerbitan sesi, token dan cookie refresh admin memakai primitif core
 * (core/identity), sehingga modul ini tidak bergantung pada modul auth. Refresh dan logout admin dilayani
 * POST /auth/refresh dan /auth/logout (modul auth).
 */
@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
