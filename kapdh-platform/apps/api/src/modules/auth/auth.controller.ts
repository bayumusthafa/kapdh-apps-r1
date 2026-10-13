import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext, AuthedRequest } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess, Public } from "../../core/guards/decorators.js";
import { assertTrustedOrigin } from "../../core/http/origin.js";
import {
  ADMIN_REFRESH_COOKIE,
  clearAdminRefreshCookie,
  secureCookies,
  setAdminRefreshCookie,
} from "../../core/identity/admin-refresh-cookie.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { COHORT_BASE_YEAR } from "../../core/membership/member-number.js";
import { jakartaYear } from "../../core/membership/period.js";
import { CLOCK, ENV } from "../../core/tokens.js";
import { validate } from "../../core/validation/validate.js";
import { AuthService } from "./auth.service.js";
import { passwordRuleSchema } from "./password-rules.js";

/** Kode OTP 6 digit (kontrak OtpVerifyRequest, PasswordResetVerifyRequest). */
export const otpCodeSchema = z.string().regex(/^\d{6}$/, "Kode 6 digit");
/** Email masukan (kontrak `format: email`, maxLength 254); dinormalisasi di layanan. */
export const emailSchema = z.string().trim().email("Email tidak valid").max(254);

/**
 * Alumni: pendaftaran, OTP, koreksi email, login, refresh, logout (F-01, F-02; kontrak auth.yaml). Admin memakai
 * refresh/logout yang sama.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post("register")
  @HttpCode(201)
  @Public()
  @Idempotent()
  register(@Body() body: unknown) {
    // Angkatan terbaru mengikuti tahun Asia/Jakarta (PRD 2.1), bukan tahun UTC.
    const latestCohort = jakartaYear(this.clock.now()) - COHORT_BASE_YEAR;
    const input = validate(
      z
        .object({
          full_name: z.string().trim().min(2, "Isi nama lengkap").max(120),
          gender: z.enum(["male", "female"], { message: "Pilih jenis kelamin" }),
          email: emailSchema,
          password: passwordRuleSchema,
          cohort: z.number().int().min(1).max(latestCohort, `Angkatan maksimal ${latestCohort}`),
          class_in: z.number().int().min(1).max(6),
          class_out: z.number().int().min(1).max(6),
          // LegalConsentVersions.policy_version dari GET /public/pages (F-01); dibandingkan server dengan
          // app_settings.legal terkini (409 VERSION_CONFLICT bila usang).
          accept_policy_version: z
            .string()
            .max(64)
            .regex(
              /^privacy:[1-9][0-9]*;terms:[1-9][0-9]*$/,
              "Setujui kebijakan privasi dan ketentuan layanan",
            ),
        })
        .refine((v) => v.class_out >= v.class_in, {
          message: "Kelas keluar tidak boleh sebelum kelas masuk",
          path: ["class_out"],
        }),
      body,
    );
    return this.auth.register(input);
  }

  @Post("otp/verify")
  @HttpCode(200)
  @Public()
  verify(@Body() body: unknown) {
    const input = validate(
      z.object({
        challenge_id: z.uuid(),
        code: otpCodeSchema,
        device_name: z.string().max(80).optional(),
      }),
      body,
    );
    return this.auth.verifyOtp(input.challenge_id, input.code, input.device_name);
  }

  @Post("otp/resend")
  @HttpCode(200)
  @Public()
  resend(@Body() body: unknown) {
    const input = validate(z.object({ challenge_id: z.uuid() }), body);
    return this.auth.resendOtp(input.challenge_id);
  }

  /** Keadaan challenge tanpa mengirim/mengganti kode (kontrak getOtpChallengeStatus; AC F16-4, F01-3). */
  @Post("otp/status")
  @HttpCode(200)
  @Public()
  status(@Body() body: unknown) {
    const input = validate(z.object({ challenge_id: z.uuid() }), body);
    return this.auth.otpStatus(input.challenge_id);
  }

  /** "Salah email? Ubah alamat email" pada layar OTP (PRD 2.2; kontrak correctPendingEmail). */
  @Post("email-correction")
  @HttpCode(200)
  @Public()
  correctEmail(@Body() body: unknown) {
    const input = validate(
      z.object({
        challenge_id: z.uuid(),
        password: z.string().min(1, "Masukkan sandi").max(128),
        new_email: emailSchema,
      }),
      body,
    );
    return this.auth.correctPendingEmail(input);
  }

  @Post("login")
  @HttpCode(200)
  @Public()
  login(@Body() body: unknown) {
    const input = validate(
      z.object({
        email: z.string().trim().min(3).max(254),
        // Kontrak LoginRequest: maksimal 128 karakter; sandi > 72 byte UTF-8 ditolak dengan 401 yang sama (PRD 2.5).
        password: z.string().min(1).max(128),
        device_name: z.string().max(80).optional(),
      }),
      body,
    );
    return this.auth.login(input.email, input.password, input.device_name);
  }

  /** Mobile mengirim refresh_token di body; web admin memakai cookie HttpOnly dengan pemeriksaan Origin (PRD 5.2). */
  @Post("refresh")
  @HttpCode(200)
  @Public()
  async refresh(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = validate(z.object({ refresh_token: z.string().min(10).max(512).optional() }), body);
    if (input.refresh_token) {
      const issued = await this.auth.refresh(input.refresh_token, "mobile");
      return issued.pair;
    }
    const cookie = req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!cookie) throw unauthenticated();
    // Mutasi berbasis cookie wajib Origin web admin (CSRF, PRD 5.2). ADMIN_ORIGIN sudah dinormalisasi config.
    assertTrustedOrigin(req, this.env.ADMIN_ORIGIN);
    const issued = await this.auth.refresh(cookie, "admin");
    setAdminRefreshCookie(reply, issued.refreshToken, issued.refreshExpiresAt, secureCookies(this.env));
    return issued.pair;
  }

  @Post("logout")
  @HttpCode(204)
  @Audience("any")
  // Semua status keanggotaan (termasuk suspended) tetap bisa keluar (PRD 2.2).
  @MemberAccess("any")
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(auth);
    if (auth.audience === "admin") clearAdminRefreshCookie(reply, secureCookies(this.env));
  }

  @Post("logout-all")
  @HttpCode(204)
  @Audience("any")
  @MemberAccess("any")
  async logoutAll(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logoutAll(auth);
    if (auth.audience === "admin") clearAdminRefreshCookie(reply, secureCookies(this.env));
  }
}
