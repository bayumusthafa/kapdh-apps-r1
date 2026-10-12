import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

/**
 * F-01, F-02 (alumni): registrasi, OTP, login, sesi, pemulihan/ganti sandi, reautentikasi, koreksi email
 * (ARCHITECTURE §4.1). TokenService disediakan CoreModule (global) karena AuthGuard memakainya setiap request.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
