import { Body, Controller, Get, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { ADMIN_IDLE_MS } from "../../core/guards/auth.guard.js";
import { Audience, CurrentAuth, Public } from "../../core/guards/decorators.js";
import { secureCookies, setAdminRefreshCookie } from "../../core/identity/admin-refresh-cookie.js";
import { ENV } from "../../core/tokens.js";
import { validate } from "../../core/validation/validate.js";
import { AdminAuthService } from "./admin-auth.service.js";

/** Login admin dua tahap: sandi lalu TOTP/backup code (F-02, AC F02-2), profil admin (F-16). */
@Controller("admin")
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post("auth/login")
  @HttpCode(200)
  @Public()
  login(@Body() body: unknown) {
    const input = validate(
      z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) }),
      body,
    );
    return this.auth.adminLogin(input.email, input.password);
  }

  @Post("auth/mfa")
  @HttpCode(200)
  @Public()
  async mfa(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = validate(
      z
        .object({
          mfa_token: z.string().min(10).max(2048),
          totp_code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
          backup_code: z.string().min(6).max(32).optional(),
        })
        // Tepat satu dari totp_code atau backup_code (kontrak AdminMfaRequest).
        .refine((v) => Boolean(v.totp_code) !== Boolean(v.backup_code), {
          message: "Masukkan kode autentikator atau backup code (salah satu).",
          path: ["totp_code"],
        }),
      body,
    );
    const issued = await this.auth.adminVerifyMfa(input.mfa_token, input.totp_code, input.backup_code);
    setAdminRefreshCookie(reply, issued.refreshToken, issued.refreshExpiresAt, secureCookies(this.env));
    return {
      access_token: issued.pair.access_token,
      access_expires_at: issued.pair.access_expires_at,
      idle_timeout_seconds: ADMIN_IDLE_MS / 1000,
    };
  }

  @Get("me")
  @Audience("admin")
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.adminProfile(auth);
  }
}
