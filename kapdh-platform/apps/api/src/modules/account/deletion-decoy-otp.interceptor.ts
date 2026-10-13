import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyRequest } from "fastify";
import { catchError, from, type Observable } from "rxjs";
import { AppException } from "../../core/errors/app-exception.js";
import { WebDeletionDecoys } from "./web-deletion-decoys.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];

/**
 * Operasi kontrak auth.yaml yang menerima `challenge_id` di body: resendOtp (POST /auth/otp/resend) dan
 * getOtpChallengeStatus (POST /auth/otp/status), dengan prefiks global `api/v1` (bootstrap.ts). Path kontrak tidak
 * pernah diganti nama (aturan kontrak), sehingga pencocokan rute stabil terhadap perubahan implementasi modul auth.
 */
export const DECOY_OTP_ROUTES: Readonly<Record<string, "resend" | "status">> = {
  "POST /api/v1/auth/otp/resend": "resend",
  "POST /api/v1/auth/otp/status": "status",
};

/**
 * Non-enumerasi penghapusan akun web (PRD 2.5; kontrak account.yaml startWebDeletion "kirim ulang memakai POST
 * /auth/otp/resend", auth.yaml getOtpChallengeStatus "challenge pengganti ... menghasilkan bentuk dan nilai yang sama").
 * Challenge pengganti (decoy) tidak memiliki baris otp_codes, sehingga modul auth menjawabnya 410 sedangkan challenge
 * nyata dikirim ulang (200): pembeda email terdaftar. Interceptor global ini menutup celah itu tanpa mengubah modul
 * auth:
 * - hanya untuk dua rute di atas dan hanya bila `challenge_id` bertanda HMAC decoy (OTP_HMAC_SECRET);
 * - handler auth tetap dijalankan LEBIH DAHULU (batas laju, validasi dan pencarian yang sama dengan challenge nyata);
 *   hanya jawaban 410 OTP_EXPIRED-nya untuk id decoy yang diganti jawaban {@link WebDeletionDecoys} (cooldown 429,
 *   kuota kirim per IP/email yang sama, decoy baru menggantikan yang lama, 410 untuk id lama);
 * - bila modul auth kelak mendelegasikan sendiri ke `resendIfDecoy`/`statusIfDecoy`, handler tidak lagi 410 dan
 *   interceptor tidak melakukan apa pun.
 */
@Injectable()
export class DeletionDecoyOtpInterceptor implements NestInterceptor {
  constructor(private readonly decoys: WebDeletionDecoys) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const operation = DECOY_OTP_ROUTES[`${request.method} ${request.routeOptions?.url ?? ""}`];
    if (!operation) return next.handle();
    const body = request.body as { challenge_id?: unknown } | null | undefined;
    const challengeId = body && typeof body === "object" ? body.challenge_id : undefined;
    if (typeof challengeId !== "string" || !this.decoys.isDecoy(challengeId)) return next.handle();
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof AppException) || error.code !== "OTP_EXPIRED") throw error;
        return from(this.answer(operation, challengeId, error));
      }),
    );
  }

  private async answer(
    operation: "resend" | "status",
    challengeId: string,
    original: AppException,
  ): Promise<OtpChallenge> {
    const result =
      operation === "resend"
        ? await this.decoys.resendIfDecoy(challengeId)
        : await this.decoys.statusIfDecoy(challengeId);
    if (!result) throw original;
    return result;
  }
}
