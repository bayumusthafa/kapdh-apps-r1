import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { clearAdminRefreshCookie, secureCookies } from "../../core/identity/admin-refresh-cookie.js";
import { ENV } from "../../core/tokens.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import { SessionsService } from "./sessions.service.js";

/**
 * Sesi perangkat dan reautentikasi (F-02, N-08; kontrak listSessions, revokeSession, reauthenticate). Alumni dan admin
 * memakai rute yang sama untuk sesinya sendiri; anggota suspended tetap dapat mengelola sesi dan reautentikasi untuk
 * penghapusan akun (PRD 2.2).
 */
@Controller("auth")
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get("sessions")
  @Audience("any")
  @MemberAccess("any")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown) {
    return this.sessions.list(auth, query);
  }

  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @Audience("any")
  @MemberAccess("any")
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param("sessionId", UuidParamOrValidationError) sessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { current } = await this.sessions.revoke(auth, sessionId);
    // Mencabut sesi saat ini = logout: cookie refresh admin dihapus.
    if (current && auth.audience === "admin") clearAdminRefreshCookie(reply, secureCookies(this.env));
  }

  @Post("reauth")
  @HttpCode(200)
  @Audience("any")
  @MemberAccess("any")
  reauth(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = validate(
      z.object({
        password: z.string().min(1, "Masukkan sandi").max(128),
        totp_code: z
          .string()
          .regex(/^\d{6}$/, "Kode autentikator 6 digit")
          .optional(),
        backup_code: z.string().min(6).max(32).optional(),
      }),
      body,
    );
    return this.sessions.reauthenticate(auth, input);
  }
}
