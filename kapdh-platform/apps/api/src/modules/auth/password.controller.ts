import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess, Public } from "../../core/guards/decorators.js";
import { validate } from "../../core/validation/validate.js";
import { emailSchema, otpCodeSchema } from "./auth.controller.js";
import { passwordRuleSchema } from "./password-rules.js";
import { PasswordService } from "./password.service.js";

/** Pemulihan dan penggantian sandi alumni (F-02, AC F02-4; PRD 2.5; kontrak auth.yaml /auth/password/*). */
@Controller("auth/password")
export class PasswordController {
  constructor(private readonly passwords: PasswordService) {}

  /** Respons selalu 202 dengan challenge, apa pun keadaan email (non-enumerasi, PRD 2.5). */
  @Post("forgot")
  @HttpCode(202)
  @Public()
  forgot(@Body() body: unknown) {
    const input = validate(z.object({ email: emailSchema }), body);
    return this.passwords.forgot(input.email);
  }

  @Post("forgot/verify")
  @HttpCode(200)
  @Public()
  verify(@Body() body: unknown) {
    const input = validate(z.object({ challenge_id: z.uuid(), code: otpCodeSchema }), body);
    return this.passwords.verifyResetCode(input.challenge_id, input.code);
  }

  @Post("reset")
  @HttpCode(204)
  @Public()
  async reset(@Body() body: unknown) {
    const input = validate(
      z.object({
        reset_token: z.string().min(10).max(512),
        new_password: passwordRuleSchema,
      }),
      body,
    );
    await this.passwords.resetPassword(input.reset_token, input.new_password);
  }

  /** Token sesi admin ditolak 403 (audience mobile); admin memakai POST /admin/auth/password/change. */
  @Post("change")
  @HttpCode(204)
  @Audience("mobile")
  // Semua effective_status, termasuk suspended dan expired, tetap dapat mengamankan akunnya (PRD 2.2).
  @MemberAccess("any")
  async change(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = validate(
      z.object({
        current_password: z.string().min(1, "Masukkan sandi saat ini").max(128),
        new_password: passwordRuleSchema,
      }),
      body,
    );
    await this.passwords.changePassword(auth, input.current_password, input.new_password);
  }
}
