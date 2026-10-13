import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import {
  Audience,
  CurrentAuth,
  MemberAccess,
  Public,
  RequireReauth,
} from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { validate } from "../../core/validation/validate.js";
import { AccountDeletionService } from "./account-deletion.service.js";
import { WebDeletionService } from "./web-deletion.service.js";

const confirmSchema = z.literal(true, { message: "Centang konfirmasi penghapusan akun untuk melanjutkan." });
const disclosureVersion = z.string().min(1, "Versi pengungkapan wajib diisi").max(128);

/**
 * Penghapusan akun dari aplikasi (F-14, AC F14-1; kontrak account.yaml). Tersedia untuk semua effective_status
 * termasuk suspended (deletion-only, F-14); token sesi admin ditolak 403 (audience mobile).
 */
@Controller("me/deletion")
export class AccountDeletionController {
  constructor(private readonly deletions: AccountDeletionService) {}

  /** GET /me/deletion/disclosure (getAccountDeletionDisclosure; N-15: dijelaskan sebelum persetujuan). */
  @Get("disclosure")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  disclosure(@CurrentAuth() auth: AuthContext) {
    return this.deletions.disclosureFor(auth);
  }

  /** POST /me/deletion (requestAccountDeletion): reautentikasi <= 10 menit + konfirmasi eksplisit. */
  @Post()
  @HttpCode(202)
  @Audience("mobile")
  @MemberAccess("any")
  @RequireReauth()
  @Idempotent()
  request(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = validate(
      z.object({ confirm: confirmSchema, acknowledged_disclosure_version: disclosureVersion }),
      body,
    );
    return this.deletions.request(auth, input.acknowledged_disclosure_version);
  }
}

/**
 * Penghapusan akun dari situs /delete-account tanpa aplikasi (F-14, PRD 2.2, R2; kontrak account.yaml): challenge
 * email non-enumerasi -> OTP `deletion` -> konfirmasi dengan deletion_token.
 */
@Controller("public/deletion")
export class WebDeletionController {
  constructor(private readonly web: WebDeletionService) {}

  /** POST /public/deletion/challenge (startWebDeletion): respons sama apa pun keadaan email (PRD 2.5). */
  @Post("challenge")
  @HttpCode(202)
  @Public()
  challenge(@Body() body: unknown) {
    const input = validate(
      z.object({ email: z.string().trim().email("Email tidak valid").max(254) }),
      body,
    );
    return this.web.startChallenge(input.email);
  }

  /** POST /public/deletion/verify (verifyWebDeletion): challenge terbatas tanpa sesi (PRD 2.2). */
  @Post("verify")
  @HttpCode(200)
  @Public()
  verify(@Body() body: unknown) {
    const input = validate(
      z.object({
        challenge_id: z.uuid("Challenge tidak valid"),
        code: z.string().regex(/^\d{6}$/, "Kode 6 digit"),
      }),
      body,
    );
    return this.web.verify(input.challenge_id, input.code);
  }

  /** POST /public/deletion/confirm (confirmWebDeletion): halaman web benar-benar menerima permintaan (F-14). */
  @Post("confirm")
  @HttpCode(202)
  @Public()
  @Idempotent()
  confirm(@Body() body: unknown) {
    const input = validate(
      z.object({
        deletion_token: z.string().min(16).max(512),
        confirm: confirmSchema,
        acknowledged_disclosure_version: disclosureVersion,
      }),
      body,
    );
    return this.web.confirm(input.deletion_token, input.acknowledged_disclosure_version);
  }
}
