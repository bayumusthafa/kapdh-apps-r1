import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

/**
 * F-01, F-02 (alumni): registrasi, OTP, login, sesi, pemulihan/ganti sandi, reautentikasi, koreksi email
 * (ARCHITECTURE §4.1). TokenService, SessionIssuer, PasswordVerifier dan cookie refresh admin milik core
 * (core/identity, disediakan CoreModule global) karena AuthGuard, gateway realtime dan modul admin-auth ikut memakainya.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
