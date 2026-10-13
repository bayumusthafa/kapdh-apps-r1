import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { otpCodes, users } from "@kapdh/database";
import { and, eq, gt, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer } from "../../core/adapters/mailer.js";
import { tryCtx } from "../../core/context/request-context.js";
import type { Db, Tx } from "../../core/db/types.js";
import { AppException, versionConflict } from "../../core/errors/app-exception.js";
import { generateOtp, otpHmac, safeEqualHex } from "../../core/identity/crypto.js";
import { maskEmail, normalizeEmail } from "../../core/identity/email.js";
import { TokenService } from "../../core/identity/token.service.js";
import { safeError } from "../../core/logging/safe-error.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV, MAILER, ROOT_LOGGER } from "../../core/tokens.js";
import { DISCLOSURE_CHANGED } from "./account-deletion.service.js";
import { DeletionDisclosureService } from "./deletion-disclosure.service.js";
import { toAccountDeletion } from "./deletion-policy.js";
import { DeletionRequestService } from "./deletion-request.service.js";
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_MS,
  OTP_TTL_MS,
  OTP_VERIFY_FAILS_PER_IP,
  OTP_VERIFY_WINDOW_MS,
  otpExpired,
  OtpQuota,
} from "./otp-policy.js";
import { WebDeletionDecoys } from "./web-deletion-decoys.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type WebDeletionVerification = components["schemas"]["WebDeletionVerification"];
type AccountDeletion = components["schemas"]["AccountDeletion"];
type OtpRow = typeof otpCodes.$inferSelect;

/** Status akun alumni yang menerima challenge `deletion` nyata (kontrak startWebDeletion). */
const CHALLENGE_STATES: readonly AccountStatus[] = ["active", "pending_otp", "deletion_pending", "disabled"];
/** Status akun yang dapat dikonfirmasi penghapusannya lewat web (`st` pada deletion_token). */
const DELETABLE_STATES = ["active", "pending_otp"] as const;
type DeletableState = (typeof DELETABLE_STATES)[number];
/** Batas konfirmasi per IP (kontrak confirmWebDeletion 429). */
const CONFIRM_PER_IP = 30;

const tokenInvalid = () =>
  new AppException(410, "OTP_EXPIRED", "Tautan konfirmasi tidak berlaku lagi. Ulangi verifikasi email.");

/**
 * Penghapusan akun lewat situs /delete-account tanpa aplikasi (F-14, PRD 2.2, R2; kontrak startWebDeletion,
 * verifyWebDeletion, confirmWebDeletion):
 * 1. challenge: OTP `deletion` ke email akun yang memenuhi syarat, atau challenge pengganti (decoy) untuk email lain,
 *    dengan respons, waktu dan batas 429 yang sama (non-enumerasi, PRD 2.5);
 * 2. verify: kode dikonsumsi sekali secara atomik; hasilnya status permintaan terbuka (challenge terbatas, tanpa sesi)
 *    dan, bila dapat dihapus, pengungkapan + deletion_token 10 menit;
 * 3. confirm: token diverifikasi dengan baris users terkunci; transisi bersyarat ke deletion_pending membuat token
 *    sekali pakai tanpa tabel token.
 */
@Injectable()
export class WebDeletionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly quota: OtpQuota,
    private readonly decoys: WebDeletionDecoys,
    private readonly disclosure: DeletionDisclosureService,
    private readonly requests: DeletionRequestService,
  ) {}

  // ------------------------------------------------------------------ challenge

  /**
   * Akun alumni berstatus active (termasuk suspended: deletion-only), pending_otp, deletion_pending atau disabled
   * menerima challenge `deletion` nyata; challenge `deletion` lama dibatalkan di bawah kunci baris users, challenge
   * aktivasi tidak disentuh. Email lain mendapat decoy. Kedua jalur memakai kuota kirim yang sama (per IP lalu per
   * email), pekerjaan database yang setara, dan email OTP dikirim TANPA ditunggu (galat dicatat; pengguna dapat
   * mengirim ulang) sehingga waktu respons tidak membedakan email terdaftar (PRD 2.5).
   */
  async startChallenge(emailRaw: string): Promise<OtpChallenge> {
    const email = normalizeEmail(emailRaw);
    const now = this.clock.now();
    const [account] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), eq(users.kind, "alumni"), ne(users.status, "deleted")))
      .limit(1);
    const issued = await this.db.transaction(async (tx) => {
      const locked = await this.requests.lockUser(tx, account?.id ?? uuidv7());
      if (!locked || !CHALLENGE_STATES.includes(locked.status as AccountStatus)) {
        // Pekerjaan setara jalur nyata: kuota yang sama lalu pembatalan challenge lama (tidak menemukan baris).
        await this.quota.consume(email);
        await this.supersedeDeletionChallenges(tx, uuidv7(), now);
        return null;
      }
      await this.quota.consume(locked.email);
      await this.supersedeDeletionChallenges(tx, locked.id, now);
      const code = generateOtp();
      const id = uuidv7();
      const [row] = await tx
        .insert(otpCodes)
        .values({
          id,
          userId: locked.id,
          purpose: "deletion",
          codeHmac: otpHmac(this.env.OTP_HMAC_SECRET, id, code),
          binding: null,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
          resendAvailableAt: new Date(now.getTime() + OTP_RESEND_MS),
          createdAt: now,
        })
        .returning();
      return { row: row!, code, email: locked.email };
    });
    if (!issued) return this.decoys.issue(email);
    this.sendOtpInBackground(issued.email, issued.code);
    return this.toChallenge(issued.row, issued.email);
  }

  private sendOtpInBackground(email: string, code: string) {
    const requestId = tryCtx()?.requestId;
    this.mailer.sendOtp(email, code, "deletion").catch((error: unknown) => {
      this.logger.warn(
        { request_id: requestId, error: safeError(error) },
        "email OTP penghapusan akun gagal dikirim; pengguna dapat mengirim ulang",
      );
    });
  }

  private async supersedeDeletionChallenges(tx: Tx, userId: string, now: Date) {
    await tx
      .update(otpCodes)
      .set({ supersededAt: now })
      .where(
        and(
          eq(otpCodes.userId, userId),
          eq(otpCodes.purpose, "deletion"),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ),
      );
  }

  private toChallenge(row: OtpRow, email: string): OtpChallenge {
    return {
      challenge_id: row.id,
      purpose: "deletion",
      email_masked: maskEmail(email),
      expires_at: row.expiresAt.toISOString(),
      resend_available_at: row.resendAvailableAt.toISOString(),
      attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts),
      max_attempts: OTP_MAX_ATTEMPTS,
    };
  }

  // ------------------------------------------------------------------ verify

  /**
   * Satu percobaan dicadangkan atomik SEBELUM kode dibandingkan (`attempts < 5` pada predikat UPDATE) dan jatah gagal
   * per IP juga dicadangkan lebih dahulu (dikembalikan bila kode benar atau challenge tidak dapat dicoba), sama dengan
   * verifikasi OTP modul auth (PRD 2.5, D1). Decoy selalu "kode salah" sampai percobaan habis.
   */
  async verify(challengeId: string, code: string): Promise<WebDeletionVerification> {
    const now = this.clock.now();
    const ip = tryCtx()?.ip ?? null;
    const ipSlot = ip
      ? await this.limits.reserveOrThrow(
          `otp-verify-ip:${ip}`,
          OTP_VERIFY_FAILS_PER_IP,
          OTP_VERIFY_WINDOW_MS,
          "Terlalu banyak percobaan kode dari jaringan ini. Coba lagi nanti.",
        )
      : null;
    let reserved: OtpRow | undefined;
    try {
      [reserved] = await this.db
        .update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(
          and(
            eq(otpCodes.id, challengeId),
            eq(otpCodes.purpose, "deletion"),
            isNull(otpCodes.consumedAt),
            isNull(otpCodes.supersededAt),
            gt(otpCodes.expiresAt, now),
            lt(otpCodes.attempts, OTP_MAX_ATTEMPTS),
          ),
        )
        .returning();
    } catch (error) {
      await ipSlot?.release();
      throw error;
    }
    if (!reserved) {
      const decoy = await this.decoys.verify(challengeId);
      if (!decoy?.counted) await ipSlot?.release();
      throw decoy?.error ?? otpExpired();
    }
    if (!safeEqualHex(reserved.codeHmac, otpHmac(this.env.OTP_HMAC_SECRET, reserved.id, code))) {
      const left = OTP_MAX_ATTEMPTS - reserved.attempts;
      if (left <= 0) throw otpExpired();
      throw new AppException(400, "VALIDATION_ERROR", `Kode salah. Sisa percobaan ${left}.`, {
        fieldErrors: { code: [`Kode salah. Sisa percobaan ${left}.`] },
      });
    }
    await ipSlot?.release();
    return this.completeVerification(reserved);
  }

  /** Kode benar: konsumsi sekali dengan baris users terkunci, lalu status/pengungkapan sesuai keadaan akun. */
  private async completeVerification(challenge: OtpRow): Promise<WebDeletionVerification> {
    const now = this.clock.now();
    const outcome = await this.db.transaction(async (tx) => {
      const user = await this.requests.lockUser(tx, challenge.userId);
      const consumed = await tx
        .update(otpCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(otpCodes.id, challenge.id),
            isNull(otpCodes.consumedAt),
            isNull(otpCodes.supersededAt),
            gt(otpCodes.expiresAt, now),
          ),
        )
        .returning({ id: otpCodes.id });
      if (consumed.length === 0 || !user || user.kind !== "alumni") throw otpExpired();
      const status = user.status as AccountStatus;
      const base = { email_masked: maskEmail(user.email) };
      if (status === "active" || status === "pending_otp")
        return {
          ...base,
          deletable: true as const,
          registration_pending: status === "pending_otp",
          blocked_reason: null,
          deletion: null,
          disclosure: await this.disclosure.compute(tx, { id: user.id, status }),
          user,
          status,
        };
      if (status === "deletion_pending") {
        const open = await this.requests.openRequest(tx, user.id);
        return {
          ...base,
          deletable: false as const,
          registration_pending: false,
          blocked_reason: "deletion_in_progress" as const,
          deletion: open ? toAccountDeletion(open) : null,
          disclosure: null,
        };
      }
      if (status === "disabled")
        return {
          ...base,
          deletable: false as const,
          registration_pending: false,
          blocked_reason: "account_disabled" as const,
          deletion: null,
          disclosure: null,
        };
      // Akun selesai dihapus sesudah challenge dibuat: diperlakukan seperti challenge yang tidak berlaku.
      throw otpExpired();
    });
    if (!outcome.deletable) return { ...outcome, deletion_token: null, deletion_token_expires_at: null };
    const signed = await this.tokens.signOneTime("web_deletion", {
      userId: outcome.user.id,
      challengeId: challenge.id,
      bindings: { sv: outcome.user.sessionVersion, st: outcome.status },
    });
    return {
      email_masked: outcome.email_masked,
      deletable: true,
      registration_pending: outcome.registration_pending,
      blocked_reason: null,
      deletion: null,
      disclosure: outcome.disclosure,
      deletion_token: signed.token,
      deletion_token_expires_at: signed.expiresAt.toISOString(),
    };
  }

  // ------------------------------------------------------------------ confirm

  /**
   * Konfirmasi dengan deletion_token (kontrak confirmWebDeletion). Semua kegagalan token/keadaan akun → 410 yang sama
   * (tidak dibedakan); pengungkapan berubah → 409 VERSION_CONFLICT dengan `current` (token tetap berlaku).
   */
  async confirm(token: string, acknowledgedVersion: string): Promise<AccountDeletion> {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `deletion-confirm-ip:${ip}`,
        CONFIRM_PER_IP,
        OTP_VERIFY_WINDOW_MS,
        "Terlalu banyak percobaan. Coba lagi nanti.",
      );
    const claims = await this.tokens.verifyOneTime(token, "web_deletion");
    const state = claims?.bindings.st;
    const version = claims?.bindings.sv;
    if (
      !claims ||
      typeof version !== "number" ||
      typeof state !== "string" ||
      !(DELETABLE_STATES as readonly string[]).includes(state)
    )
      throw tokenInvalid();
    const expected = state as DeletableState;
    return this.db.transaction(async (tx) => {
      const user = await this.requests.lockUser(tx, claims.userId);
      if (!user || user.kind !== "alumni" || user.status !== expected || user.sessionVersion !== version)
        throw tokenInvalid();
      const [challenge] = await tx
        .select({ id: otpCodes.id })
        .from(otpCodes)
        .where(
          and(
            eq(otpCodes.id, claims.challengeId),
            eq(otpCodes.userId, user.id),
            eq(otpCodes.purpose, "deletion"),
            isNotNull(otpCodes.consumedAt),
          ),
        );
      if (!challenge) throw tokenInvalid();
      const current = await this.disclosure.compute(tx, { id: user.id, status: expected });
      if (current.version !== acknowledgedVersion) throw versionConflict(current, DISCLOSURE_CHANGED);
      const deletion = await this.requests.create(tx, user, {
        source: "web",
        expectedStatus: expected,
        // Pemilik membuktikan kendali email lewat OTP; dicatat sebagai aktor alumni akun itu (F-17).
        actor: { kind: "alumni", userId: user.id, adminId: null, adminRole: null },
      });
      return toAccountDeletion(deletion);
    });
  }
}
