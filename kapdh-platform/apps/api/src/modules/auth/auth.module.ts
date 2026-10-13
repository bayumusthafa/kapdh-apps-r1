import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { OtpChallengeService } from "./otp-challenge.service.js";
import { PasswordController } from "./password.controller.js";
import { PasswordService } from "./password.service.js";
import { SessionsController } from "./sessions.controller.js";
import { SessionsService } from "./sessions.service.js";

/**
 * F-01, F-02 (alumni): registrasi, OTP, login, sesi, pemulihan/ganti sandi, reautentikasi, koreksi email
 * (ARCHITECTURE §4.1). TokenService, SessionIssuer, PasswordVerifier dan cookie refresh admin milik core
 * (core/identity, disediakan CoreModule global) karena AuthGuard, gateway realtime dan modul admin-auth ikut memakainya.
 * OtpChallengeService diekspor untuk alur lain yang memakai challenge OTP yang sama: hapus akun web (modul account,
 * tujuan `deletion`, termasuk challenge pengganti non-enumerasi) dan pemulihan sandi oleh Super Admin (AC F16-4,
 * tujuan `password_reset`).
 */
@Module({
  controllers: [AuthController, PasswordController, SessionsController],
  providers: [AuthService, OtpChallengeService, PasswordService, SessionsService],
  exports: [AuthService, OtpChallengeService],
})
export class AuthModule {}
