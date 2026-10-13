import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { otpCodes, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { AppException, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { safeEqualHex } from "../../core/identity/crypto.js";
import { normalizeEmail } from "../../core/identity/email.js";
import { PasswordVerifier } from "../../core/identity/password-verifier.js";
import { TokenService } from "../../core/identity/token.service.js";
import { revokeDeviceTokens } from "../../core/notifications-kernel/device-tokens.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import { OtpChallengeService, otpExpired, PURPOSE_ACCOUNT_STATES } from "./otp-challenge.service.js";
import { notifySecurityEvent } from "./security-notices.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type PasswordResetGrant = components["schemas"]["PasswordResetGrant"];

const resetTokenExpired = () =>
  otpExpired("Izin pemulihan sandi tidak berlaku lagi. Ulangi lupa sandi atau masuk dengan sandi baru.");

/**
 * Pemulihan dan penggantian sandi alumni (F-02, AC F02-4; PRD 2.5; kontrak forgotPassword, verifyPasswordResetOtp,
 * resetPassword, changePassword).
 */
@Injectable()
export class PasswordService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly otp: OtpChallengeService,
    private readonly passwords: PasswordVerifier,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeService,
  ) {}

  private now() {
    return this.clock.now();
  }

  /**
   * Pengikat reset_token ke password_hash saat OTP diverifikasi (pola otp_codes.binding; kontrak PasswordResetGrant):
   * HMAC secret server, sehingga klaim yang terbaca di JWT tidak membocorkan apa pun tentang hash sandi. Sandi berganti
   * lewat jalur apa pun → pengikat tidak cocok → token mati (sekali pakai tanpa tabel token).
   */
  private passwordBinding(passwordHash: string): string {
    return createHmac("sha256", this.env.OTP_HMAC_SECRET)
      .update(`password-reset:${passwordHash}`)
      .digest("hex");
  }

  /**
   * Lupa sandi tanpa enumerasi (PRD 2.5; kontrak forgotPassword): akun alumni `active` (termasuk anggota suspended)
   * mendapat challenge `password_reset` nyata (baris users terkunci, challenge lama dibatalkan, kode ke email
   * terverifikasi); email lain (tidak terdaftar, pending_otp, disabled, deletion_pending, admin) mendapat challenge
   * pengganti berbentuk sama tanpa email. Keduanya memakai cooldown, kuota kirim per email/IP dan jalur kode yang sama;
   * email kode nyata dikirim tanpa ditunggu sehingga waktu respons tidak membedakan keadaan akun. Permintaan ulang
   * dalam cooldown 60 detik mengembalikan challenge aktif yang sama tanpa email baru (ketuk ganda). Cooldown kegagalan
   * login tidak menutup alur ini.
   */
  async forgot(emailRaw: string): Promise<OtpChallenge> {
    const email = normalizeEmail(emailRaw);
    const account = await this.passwords.findAccount(this.db, email, "alumni");
    if (account && PURPOSE_ACCOUNT_STATES.password_reset.includes(account.status)) {
      try {
        return await this.otp.issueForAccount(account.id, "password_reset", { reuseActive: true });
      } catch (error) {
        // Keadaan akun berubah sebelum baris dikunci: perlakukan seperti email yang tidak memenuhi syarat.
        if (!(error instanceof AppException && error.code === "OTP_EXPIRED")) throw error;
      }
    }
    return this.otp.issueDecoy(email, "password_reset", { reuseActive: true });
  }

  /**
   * Tukar kode `password_reset` dengan reset_token sekali pakai (AC F02-4; kontrak verifyPasswordResetOtp). Batas IP
   * dan satu percobaan dicadangkan atomik sebelum kode dinilai; challenge pengganti selalu "kode salah" sampai
   * percobaan habis. Kode benar dikonsumsi sekali (UPDATE bersyarat dengan seluruh predikat) di dalam transaksi dengan
   * baris users terkunci dan akun masih `active`. Token: JWT audience kapdh-password-reset 10 menit, `sub` akun, `cid`
   * challenge, `bnd` pengikat password_hash.
   */
  async verifyResetCode(challengeId: string, code: string): Promise<PasswordResetGrant> {
    const matched = await this.otp.verifyCode(challengeId, code, ["password_reset"]);
    const now = this.now();
    const binding = await this.db.transaction(async (tx) => {
      const user = await this.otp.lockUser(tx, matched.userId);
      if (!user || user.kind !== "alumni" || user.status !== "active") throw otpExpired();
      if (!(await this.otp.consume(tx, matched, now))) throw otpExpired();
      return this.passwordBinding(user.passwordHash);
    });
    const grant = await this.tokens.signOneTime("password_reset", {
      userId: matched.userId,
      challengeId: matched.id,
      bindings: { bnd: binding },
    });
    return { reset_token: grant.token, expires_at: grant.expiresAt.toISOString() };
  }

  /**
   * Simpan sandi baru dengan reset_token (AC F02-4, F16-4; kontrak resetPassword). Dalam satu transaksi dengan baris
   * users terkunci FOR UPDATE: token dinilai (tanda tangan, audience, kedaluwarsa, challenge `cid` milik akun bertujuan
   * password_reset dan sudah dikonsumsi, akun `active`, pengikat = password_hash saat ini), lalu UPDATE bersyarat
   * `WHERE password_hash = <hash terikat>` (nol baris → 410; token yang sama tidak pernah berhasil dua kali, termasuk
   * dua request bersamaan), session_version naik, SEMUA sesi dan token push dicabut, challenge pemulihan lain dibatalkan,
   * audit, dan notifikasi keamanan; setelah commit seluruh socket diputus dan cooldown kegagalan login email itu dibuka
   * (jalur pemulihan, PRD 2.5).
   */
  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const claims = await this.tokens.verifyOneTime(resetToken, "password_reset");
    const bound = claims?.bindings.bnd;
    if (!claims || typeof bound !== "string") throw resetTokenExpired();
    // bcrypt di luar kunci baris; hanya untuk token bertanda tangan sah.
    const newHash = await bcrypt.hash(newPassword, this.env.BCRYPT_COST);
    const now = this.now();
    const email = await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, claims.userId)).for("update");
      if (
        !user ||
        user.kind !== "alumni" ||
        user.status !== "active" ||
        !safeEqualHex(this.passwordBinding(user.passwordHash), bound)
      )
        throw resetTokenExpired();
      const [challenge] = await tx
        .select({ userId: otpCodes.userId, purpose: otpCodes.purpose, consumedAt: otpCodes.consumedAt })
        .from(otpCodes)
        .where(eq(otpCodes.id, claims.challengeId));
      if (
        !challenge ||
        challenge.userId !== user.id ||
        challenge.purpose !== "password_reset" ||
        !challenge.consumedAt
      )
        throw resetTokenExpired();
      const updated = await tx
        .update(users)
        .set({
          passwordHash: newHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash), eq(users.status, "active")),
        )
        .returning({ id: users.id });
      if (updated.length === 0) throw resetTokenExpired();
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await revokeDeviceTokens(tx, { userId: user.id }, now);
      await this.otp.supersedeActive(tx, user.id, ["password_reset"], now);
      await this.audit.write(tx, {
        actor: { kind: "alumni", userId: user.id, adminId: null, adminRole: null },
        action: "account.password_reset",
        entityType: "user",
        entityId: user.id,
        after: { sessions_revoked: revoked.length, challenge_id: claims.challengeId },
      });
      await notifySecurityEvent(this.notifications, tx, user.id, "password_reset", now);
      // Setelah commit: semua socket menerima session.revoked lalu diputus.
      this.realtime.disconnectUser(user.id, "password_reset");
      return user.email;
    });
    // Pemulihan berhasil membuka cooldown kegagalan login email ini (PRD 2.5 "jalur pemulihan tetap tersedia").
    await this.limits.reset(`login:${email}`);
  }

  /**
   * Ganti sandi alumni (AC F02-4; kontrak changePassword): sandi saat ini wajib; jatah kegagalan login dicadangkan
   * atomik sebelum bcrypt (sandi lama salah → 400 `field_errors.current_password`, tetap tercatat; 429 setelah
   * ambang). Dalam satu transaksi dengan baris users terkunci: UPDATE bersyarat pada hash yang dinilai, semua sesi
   * LAIN dan token push-nya dicabut (sesi saat ini tetap berlaku, session_version tidak naik), challenge pemulihan
   * dibatalkan, audit, notifikasi keamanan; setelah commit socket sesi lain diputus.
   */
  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user || user.status !== "active") throw unauthenticated();
    const wrongCurrent = () =>
      new AppException(400, "VALIDATION_ERROR", "Sandi saat ini salah.", {
        fieldErrors: { current_password: ["Sandi saat ini salah."] },
      });
    const attempt = await this.passwords.beginAttempt(user.email);
    let matches: boolean;
    try {
      matches = await this.passwords.comparePassword(currentPassword, user.passwordHash);
    } catch (error) {
      await attempt.cancel().catch(() => undefined);
      throw error;
    }
    if (!matches) throw wrongCurrent();
    await attempt.succeeded();

    const newHash = await bcrypt.hash(newPassword, this.env.BCRYPT_COST);
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      if (!locked || locked.status !== "active") throw unauthenticated();
      // Sandi berganti bersamaan (perangkat lain/pemulihan): sandi yang dinilai tidak lagi sandi saat ini.
      if (locked.passwordHash !== user.passwordHash) throw wrongCurrent();
      const updated = await tx
        .update(users)
        .set({ passwordHash: newHash, updatedAt: now })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
        .returning({ id: users.id });
      if (updated.length === 0) throw wrongCurrent();
      const others = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), ne(sessions.familyId, auth.familyId)),
        )
        .returning({ familyId: sessions.familyId });
      const families = [...new Set(others.map((row) => row.familyId))];
      await revokeDeviceTokens(tx, { userId: user.id, familyIds: families }, now);
      await this.otp.supersedeActive(tx, user.id, ["password_reset"], now);
      await this.audit.write(tx, {
        action: "account.password_changed",
        entityType: "user",
        entityId: user.id,
        after: { other_sessions_revoked: families.length },
      });
      await notifySecurityEvent(this.notifications, tx, user.id, "password_changed", now);
      // Setelah commit: socket perangkat lain menerima session.revoked lalu diputus.
      for (const familyId of families) this.realtime.disconnectSession(familyId, "password_changed");
    });
  }
}
