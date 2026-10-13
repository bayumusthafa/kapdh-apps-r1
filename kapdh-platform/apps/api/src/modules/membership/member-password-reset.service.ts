import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { otpCodes, sessions, users } from "@kapdh/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer } from "../../core/adapters/mailer.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { AppException, forbidden, notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { generateOtp, otpHmac } from "../../core/identity/crypto.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ENV, MAILER } from "../../core/tokens.js";
import { PASSWORD_RESET_NOTICE, passwordResetDedupKey } from "./password-reset-notice.js";

type AdminMemberPasswordResetResult = components["schemas"]["AdminMemberPasswordResetResult"];

const HOUR_MS = 3600_000;
/** PRD 2.5: OTP 10 menit, kirim ulang paling cepat 60 detik (sama dengan challenge modul auth). */
const OTP_TTL_MS = 10 * 60_000;
const OTP_RESEND_MS = 60_000;
/** PRD 2.5 (Usulan D1): 5 pengiriman OTP per jam per email; kunci yang SAMA dengan modul auth (`otp:<email>`). */
const OTP_SENDS_PER_HOUR = 5;

/**
 * Pemulihan sandi alumni oleh Super Admin (F-16, AC F16-4, PRD 2.3: "tidak melihat sandi"). Satu transaksi dengan
 * baris users terkunci: challenge OTP `password_reset` baru (challenge aktif tujuan sama disupersede,
 * otp_codes_active_key), seluruh sesi dicabut dan session_version naik, token push perangkat dicabut (AC F13-5),
 * notifikasi keamanan wajib, audit `member.password_reset_initiated` tanpa kode, outbox
 * `member.password_reset_initiated`. Setelah commit socket diputus (`session.revoked` password_reset) dan email OTP
 * dikirim sinkron ke email terverifikasi (ADR-004) dengan tautan kanonik `kapdh://app/forgot/otp?challenge_id=`.
 * Kode tidak pernah ada di respons, log, audit atau URL (ARCHITECTURE §2).
 */
@Injectable()
export class MemberPasswordResetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async initiate(
    auth: AuthContext,
    userId: string,
    input: { reason: string },
  ): Promise<AdminMemberPasswordResetResult> {
    const now = this.clock.now();
    const issued = await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
      if (!user || user.kind !== "alumni" || user.status === "deleted") throw notFound("Anggota tidak ditemukan.");
      // Akun alumni pelaku sendiri memakai alur lupa sandi mandiri (konflik kepentingan, PRD 2.3).
      if (auth.linkedAlumniUserId === userId)
        throw forbidden("Gunakan alur lupa sandi mandiri untuk akun alumni Anda sendiri.");
      // Hanya akun aktif (termasuk suspended: pemulihan akun diizinkan, PRD 2.2).
      if (user.status !== "active")
        throw new AppException(
          400,
          "VALIDATION_ERROR",
          "Pemulihan sandi hanya untuk akun aktif yang emailnya sudah terverifikasi.",
          { fieldErrors: { _: ["Pemulihan sandi hanya untuk akun aktif yang emailnya sudah terverifikasi."] } },
        );
      await this.limits.consumeOrThrow(
        `otp:${user.email}`,
        OTP_SENDS_PER_HOUR,
        HOUR_MS,
        "Terlalu banyak permintaan kode untuk akun ini. Coba lagi nanti.",
      );

      // Challenge sebelumnya untuk tujuan yang sama dibatalkan (PRD 2.5); baris users terkunci di atas.
      await tx
        .update(otpCodes)
        .set({ supersededAt: now })
        .where(
          and(
            eq(otpCodes.userId, userId),
            eq(otpCodes.purpose, "password_reset"),
            isNull(otpCodes.consumedAt),
            isNull(otpCodes.supersededAt),
          ),
        );
      const code = generateOtp();
      const challengeId = uuidv7();
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
      await tx.insert(otpCodes).values({
        id: challengeId,
        userId,
        purpose: "password_reset",
        codeHmac: otpHmac(this.env.OTP_HMAC_SECRET, challengeId, code),
        binding: null,
        expiresAt,
        resendAvailableAt: new Date(now.getTime() + OTP_RESEND_MS),
        createdAt: now,
      });

      // Seluruh sesi target dicabut; access token lama langsung ditolak lewat session_version (AC F16-4, F02-6).
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(eq(users.id, userId));

      const dedupKey = passwordResetDedupKey(challengeId);
      // Pemberitahuan keamanan (kategori wajib) ditulis sebelum token push dicabut; push ke perangkat lama tidak
      // dikirim lagi, inbox dan email pemberitahuan tetap (kanal terverifikasi).
      await this.notifications.notify(tx, {
        userId,
        category: "security",
        title: PASSWORD_RESET_NOTICE.title,
        body: PASSWORD_RESET_NOTICE.body,
        dedupKey,
      });
      await revokeDeviceTokens(tx, { userId }, now);
      await this.audit.write(tx, {
        action: "member.password_reset_initiated",
        entityType: "alumni",
        entityId: userId,
        reason: input.reason,
        after: { sessions_revoked: revoked.length, challenge_expires_at: expiresAt },
      });
      await this.outbox.publish(tx, {
        topic: "member.password_reset_initiated",
        dedupKey,
        payload: { user_id: userId, initiated_by_admin_id: auth.adminId! },
      });
      // Ditunda RealtimeService sampai commit: socket menerima session.revoked (password_reset) lalu diputus.
      this.realtime.disconnectUser(userId, "password_reset");
      return { email: user.email, code, challengeId, expiresAt, sessionsRevoked: revoked.length };
    });

    // Email OTP sinkron ke email terverifikasi (ADR-004) dengan kode dan tautan kanonik; email dari baris terkunci.
    await this.mailer.sendOtp(issued.email, issued.code, "password_reset", {
      adminInitiatedChallengeId: issued.challengeId,
    });
    return {
      initiated_at: now.toISOString(),
      sessions_revoked: issued.sessionsRevoked,
      challenge_expires_at: issued.expiresAt.toISOString(),
    };
  }
}
