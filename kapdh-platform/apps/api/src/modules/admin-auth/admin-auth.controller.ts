import { Body, Controller, Get, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { checkPassword } from "@kapdh/shared";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, Public, RequireReauth } from "../../core/guards/decorators.js";
import { secureCookies, setAdminRefreshCookie } from "../../core/identity/admin-refresh-cookie.js";
import type { IssuedSession } from "../../core/identity/session-issuer.js";
import { ENV } from "../../core/tokens.js";
import { validate } from "../../core/validation/validate.js";
import { toAdminSession } from "./admin-auth.shared.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminCredentialsService } from "./admin-credentials.service.js";
import { AdminOnboardingService } from "./admin-onboarding.service.js";

type AdminTotpEnrollmentResult = components["schemas"]["AdminTotpEnrollmentResult"];

/** Aturan sandi PRD 2.5 (8 sampai 72 byte UTF-8, huruf besar, kecil, angka, simbol; server menolak, tidak memotong). */
const passwordSchema = z.string().refine((v) => checkPassword(v).valid, {
  message: "Sandi 8 sampai 72 byte dengan huruf besar, huruf kecil, angka, dan simbol.",
});
/** Token undangan dari fragmen `/invite#t=<token>` (kontrak AdminInvitationTokenRequest; tidak pernah dari path/query). */
const inviteTokenSchema = z.string().min(16).max(512);
/** mfa_token login atau pendaftaran (kontrak AdminMfaRequest/AdminTotpEnrollmentRequest). */
const mfaTokenSchema = z.string().min(10).max(2048);
const totpCodeSchema = z.string().regex(/^\d{6}$/, "Kode autentikator 6 digit.");

/**
 * Admin Auth (kontrak C1 admin-auth.yaml; F-02 admin, F-16, PRD 8.2, N-08): login dua tahap sandi lalu TOTP/backup
 * code (AC F02-2), penerimaan undangan dan pendaftaran TOTP sebelum aktivasi, profil admin, backup code dan ganti
 * sandi. Refresh dan logout admin dilayani POST /auth/refresh dan /auth/logout (modul auth). Header
 * X-Background-Request dihormati AuthGuard pada setiap operasi admin (AC F02-5).
 */
@Controller("admin")
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly onboarding: AdminOnboardingService,
    private readonly credentials: AdminCredentialsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  private setRefreshCookie(reply: FastifyReply, issued: IssuedSession) {
    // Refresh token admin hanya di cookie HttpOnly SameSite=Strict, tidak pernah di body (PRD 5.2).
    setAdminRefreshCookie(reply, issued.refreshToken, issued.refreshExpiresAt, secureCookies(this.env));
  }

  /** adminLogin: tahap sandi; hanya admin aktif dengan TOTP terverifikasi (AC F02-2). */
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

  /** adminVerifyMfa: TOTP atau backup code; mfa_token sekali pakai (AC F02-2). */
  @Post("auth/mfa")
  @HttpCode(200)
  @Public()
  async mfa(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = validate(
      z
        .object({
          mfa_token: mfaTokenSchema,
          totp_code: totpCodeSchema.optional(),
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
    this.setRefreshCookie(reply, issued);
    return toAdminSession(issued);
  }

  /** adminPreviewInvitation: tidak mengonsumsi token (F-16, PRD 8.2). */
  @Post("auth/invitations/preview")
  @HttpCode(200)
  @Public()
  previewInvitation(@Body() body: unknown) {
    const input = validate(z.object({ invite_token: inviteTokenSchema }), body);
    return this.onboarding.previewInvitation(input.invite_token);
  }

  /** adminAcceptInvitation: token sekali pakai, sandi awal diganti, mfa_token pendaftaran 30 menit (PRD 8.2). */
  @Post("auth/invitations/accept")
  @HttpCode(200)
  @Public()
  acceptInvitation(@Body() body: unknown) {
    const input = validate(z.object({ invite_token: inviteTokenSchema, password: passwordSchema }), body);
    return this.onboarding.acceptInvitation(input.invite_token, input.password);
  }

  /** adminStartTotpEnrollment: secret + otpauth URI; hanya dengan mfa_token pendaftaran (F-16). */
  @Post("auth/totp/enroll")
  @HttpCode(200)
  @Public()
  startTotpEnrollment(@Body() body: unknown) {
    const input = validate(z.object({ mfa_token: mfaTokenSchema }), body);
    return this.onboarding.startEnrollment(input.mfa_token);
  }

  /** adminConfirmTotpEnrollment: admin aktif, backup code sekali tampil, sesi admin (F-16, PRD 8.2). */
  @Post("auth/totp/confirm")
  @HttpCode(200)
  @Public()
  async confirmTotpEnrollment(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminTotpEnrollmentResult> {
    const input = validate(z.object({ mfa_token: mfaTokenSchema, totp_code: totpCodeSchema }), body);
    const confirmed = await this.onboarding.confirmEnrollment(input.mfa_token, input.totp_code);
    this.setRefreshCookie(reply, confirmed.session);
    return {
      session: toAdminSession(confirmed.session),
      backup_codes: confirmed.backupCodes,
      backup_codes_generated_at: confirmed.generatedAt.toISOString(),
    };
  }

  /** getAdminMe: identitas dan izin efektif dari database (AC F15-1, F16-3). */
  @Get("me")
  @Audience("admin")
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.adminProfile(auth);
  }

  /** adminRegenerateBackupCodes: perlu X-Reauth-Token tingkat 2 (sandi + TOTP), F-02. */
  @Post("auth/backup-codes")
  @HttpCode(200)
  @Audience("admin")
  @RequireReauth()
  regenerateBackupCodes(@CurrentAuth() auth: AuthContext) {
    return this.credentials.regenerateBackupCodes(auth);
  }

  /** adminChangePassword: sandi lama wajib; sesi admin lain dicabut (AC F02-4, N-08). */
  @Post("auth/password/change")
  @HttpCode(204)
  @Audience("admin")
  async changePassword(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    const input = validate(
      z.object({ current_password: z.string().min(1).max(128), new_password: passwordSchema }),
      body,
    );
    await this.credentials.changePassword(auth, input.current_password, input.new_password);
  }
}
