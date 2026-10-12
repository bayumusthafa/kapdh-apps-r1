import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { ServerEnv } from "@kapdh/config";
import { checkPassword } from "@kapdh/shared";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { AppException } from "../common/app-exception.js";
import { validate } from "../common/validate.js";
import { CLOCK, type Clock } from "../infra/clock.js";
import { ENV } from "../infra/tokens.js";
import { COHORT_BASE_YEAR } from "../membership/member-number.js";
import { AuthGuard, type AuthedRequest, RequireAuth } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";

export const ADMIN_REFRESH_COOKIE = "kapdh_admin_rt";

const passwordSchema = z.string().refine((v) => checkPassword(v).valid, {
  message: "Password 8 sampai 72 byte dengan huruf besar, huruf kecil, angka, dan simbol.",
});

@Controller("auth")
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post("register")
  @HttpCode(201)
  register(@Body() body: unknown) {
    const latestCohort = this.clock.now().getUTCFullYear() - COHORT_BASE_YEAR;
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
          accept_policy_version: z.string().trim().min(1, "Setujui kebijakan privasi dan ketentuan"),
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
  verify(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = validate(
      z.object({
        challenge_id: z.string().uuid(),
        code: z.string().regex(/^\d{6}$/, "Kode 6 digit"),
        device_name: z.string().max(80).optional(),
      }),
      body,
    );
    return this.auth.verifyOtp(input.challenge_id, input.code, input.device_name, String(req.id));
  }

  @Post("otp/resend")
  @HttpCode(200)
  resend(@Body() body: unknown) {
    const input = validate(z.object({ challenge_id: z.string().uuid() }), body);
    return this.auth.resendOtp(input.challenge_id);
  }

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = validate(
      z.object({
        email: z.string().trim().min(3).max(254),
        password: z.string().min(1).max(128),
        device_name: z.string().max(80).optional(),
      }),
      body,
    );
    return this.auth.login(input.email, input.password, input.device_name, req.ip);
  }

  /** Mobile mengirim refresh_token di body; web admin memakai cookie HttpOnly dengan pemeriksaan Origin (PRD 5.2). */
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = validate(z.object({ refresh_token: z.string().min(10).optional() }), body);
    if (input.refresh_token) {
      const issued = await this.auth.refresh(input.refresh_token, "mobile");
      return issued.pair;
    }
    const cookie = req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!cookie) throw new AppException(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
    if (req.headers.origin !== this.env.ADMIN_ORIGIN)
      throw new AppException(403, "FORBIDDEN", "Asal permintaan tidak diizinkan.");
    const issued = await this.auth.refresh(cookie, "admin");
    setAdminRefreshCookie(
      reply,
      issued.refreshToken,
      issued.refreshExpiresAt,
      this.env.NODE_ENV !== "development" && this.env.NODE_ENV !== "test",
    );
    return issued.pair;
  }

  @Post("logout")
  @HttpCode(204)
  @RequireAuth("any")
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.auth!.sessionId);
    if (req.auth!.audience === "admin") reply.clearCookie(ADMIN_REFRESH_COOKIE, { path: "/api/v1/auth" });
  }

  @Post("logout-all")
  @HttpCode(204)
  @RequireAuth("any")
  async logoutAll(@Req() req: AuthedRequest) {
    await this.auth.logoutAll(req.auth!.userId);
  }
}

export function setAdminRefreshCookie(reply: FastifyReply, token: string, expires: Date, secure: boolean) {
  reply.setCookie(ADMIN_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/api/v1/auth",
    expires,
  });
}
