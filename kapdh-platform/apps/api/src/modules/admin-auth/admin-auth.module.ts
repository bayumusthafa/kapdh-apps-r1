import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminAuthController } from "./admin-auth.controller.js";

/** F-02 (admin): login sandi + TOTP/backup code, penerimaan undangan, pendaftaran TOTP, backup code (F-16). */
@Module({
  imports: [AuthModule],
  controllers: [AdminAuthController],
})
export class AdminAuthModule {}
