import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { checkPassword } from "@kapdh/shared";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext, AuthedRequest } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess, Public } from "../../core/guards/decorators.js";
import { assertTrustedOrigin } from "../../core/http/origin.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { COHORT_BASE_YEAR } from "../../core/membership/member-number.js";
import { jakartaYear } from "../../core/membership/period.js";
import { CLOCK, ENV } from "../../core/tokens.js";
import { validate } from "../../core/validation/validate.js";
import { AuthService } from "./auth.service.js";

export const ADMIN_REFRESH_COOKIE = "kapdh_admin_rt";
export const ADMIN_REFRESH_COOKIE_PATH = "/api/v1/auth";

const passwordSchema = z.string().refine((v) => checkPassword(v).valid, {
  message: "Password 8 sampai 72 byte dengan huruf besar, huruf kecil, angka, dan simbol.",
});

/** Alumni: pendaftaran, OTP, login, refresh, logout (F-01, F-02). Admin memakai refresh/logout yang sama. */
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
          email: z.string().trim().email("Email tidak valid").max(254),
          password: passwordSchema,
          cohort: z.number().int().min(1).max(latestCohort, `Angkatan maksimal ${latestCohort}`),
          class_in: z.number().int().min(1).max(6),
          class_out: z.number().int().min(1).max(6),
          accept_policy_version: z.string().trim().min(1, "Setujui kebijakan privasi dan ketentuan").max(64),
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
        code: z.string().regex(/^\d{6}$/, "Kode 6 digit"),
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

  @Post("login")
  @HttpCode(200)
  @Public()
  login(@Body() body: unknown) {
    const input = validate(
      z.object({
        email: z.string().trim().min(3).max(254),
        password: z.string().min(1).max(256),
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
    setAdminRefreshCookie(reply, issued.refreshToken, issued.refreshExpiresAt, this.secureCookies());
    return issued.pair;
  }

  @Post("logout")
  @HttpCode(204)
  @Audience("any")
  // Semua status keanggotaan (termasuk suspended) tetap bisa keluar (PRD 2.2).
  @MemberAccess("any")
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(auth.sessionId);
    if (auth.audience === "admin")
      reply.clearCookie(ADMIN_REFRESH_COOKIE, {
        path: ADMIN_REFRESH_COOKIE_PATH,
        httpOnly: true,
        secure: this.secureCookies(),
        sameSite: "strict",
      });
  }

  @Post("logout-all")
  @HttpCode(204)
  @Audience("any")
  @MemberAccess("any")
  async logoutAll(@CurrentAuth() auth: AuthContext) {
    await this.auth.logoutAll(auth.userId);
  }

  private secureCookies(): boolean {
    return this.env.NODE_ENV !== "development" && this.env.NODE_ENV !== "test";
  }
}

export function setAdminRefreshCookie(reply: FastifyReply, token: string, expires: Date, secure: boolean) {
  reply.setCookie(ADMIN_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: ADMIN_REFRESH_COOKIE_PATH,
    expires,
  });
}
