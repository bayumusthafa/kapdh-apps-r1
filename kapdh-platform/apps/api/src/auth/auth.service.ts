import { Inject, Injectable } from "@nestjs/common";
import { type components, PERMISSION_VALUES } from "@kapdh/contracts";
import type { ServerEnv } from "@kapdh/config";
import { adminPermissions, admins, alumni, mfaTotp, otpCodes, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { AppException } from "../common/app-exception.js";
import { writeAudit } from "../common/audit.js";
import { CLOCK, type Clock } from "../infra/clock.js";
import type { Db, Tx } from "../infra/db.js";
import type { Mailer, OtpPurpose } from "../infra/mailer.js";
import { RateLimiter } from "../infra/rate-limiter.js";
import { DB, ENV, MAILER } from "../infra/tokens.js";
import { memberNumber } from "../membership/member-number.js";
import {
  decryptSecret,
  generateOtp,
  otpHmac,
  randomToken,
  safeEqualHex,
  sha256,
  verifyTotp,
} from "./crypto.js";
import { type Audience, TokenService } from "./token.service.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type TokenPair = components["schemas"]["TokenPair"];

const OTP_TTL_MS = 10 * 60_000;
const OTP_RESEND_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SENDS_PER_HOUR = 5; // Usulan D1
const LOGIN_FAILS_LIMIT = 10; // dalam 15 menit, Usulan D1
const LOGIN_WINDOW_MS = 15 * 60_000;
export const ADMIN_IDLE_MS = 30 * 60_000; // N-08
/** TTL refresh (D1, dikunci pengembang Tahap 0): mobile 60 hari, admin 12 jam. */
const REFRESH_TTL_MS: Record<Audience, number> = { mobile: 60 * 24 * 3600_000, admin: 12 * 3600_000 };

export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

export interface RegisterInput {
  full_name: string;
  gender: "male" | "female";
  email: string;
  password: string;
  cohort: number;
  class_in: number;
  class_out: number;
  accept_policy_version: string;
}

export interface IssuedSession {
  pair: TokenPair;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly limiter: RateLimiter,
  ) {}

  private now() {
    return this.clock.now();
  }

  // ------------------------------------------------------------------ OTP

  private toChallenge(row: typeof otpCodes.$inferSelect, email: string): OtpChallenge {
    // Tujuan email_change (koreksi email, PRD 2.2) belum memiliki alur dan bentuk kontrak di irisan ini.
    if (row.purpose === "email_change")
      throw new AppException(400, "VALIDATION_ERROR", "Tujuan kode belum didukung.");
    return {
      challenge_id: row.id,
      purpose: row.purpose,
      email_masked: maskEmail(email),
      expires_at: row.expiresAt.toISOString(),
      resend_available_at: row.resendAvailableAt.toISOString(),
      attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts),
    };
  }

  /**
   * Membuat challenge baru dan membatalkan challenge lain untuk tujuan yang sama (PRD 2.5). Baris users dikunci lebih
   * dahulu sehingga penerbit bersamaan untuk akun yang sama (registrasi ganda AC F01-4, resend ganda, login pending)
   * berjalan berurutan: yang kedua melihat challenge yang pertama dan menggantikannya, bukan bentrok pada
   * otp_codes_active_key (satu challenge aktif per akun/tujuan). `replacing` = challenge yang diminta dikirim ulang;
   * bila sudah diganti/dipakai oleh permintaan bersamaan, ditolak seperti permintaan berurutan (410).
   */
  private async issueOtp(
    user: { id: string; email: string; passwordHash: string },
    purpose: OtpPurpose,
    replacing?: string,
  ): Promise<OtpChallenge> {
    const now = this.now();
    const wait = this.limiter.check(`otp:${user.email}`, OTP_SENDS_PER_HOUR, 3600_000, now.getTime());
    if (wait > 0)
      throw new AppException(429, "RATE_LIMITED", "Terlalu banyak permintaan kode. Coba lagi nanti.", {
        retryAfterSeconds: wait,
      });

    const code = generateOtp();
    const id = uuidv7();
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${users} where ${users.id} = ${user.id} for no key update`);
      if (replacing) {
        const [current] = await tx
          .select({ consumedAt: otpCodes.consumedAt, supersededAt: otpCodes.supersededAt })
          .from(otpCodes)
          .where(eq(otpCodes.id, replacing));
        if (!current || current.consumedAt || current.supersededAt)
          throw new AppException(410, "OTP_EXPIRED", "Kode ini sudah diganti kode yang lebih baru.");
      }
      await tx
        .update(otpCodes)
        .set({ supersededAt: now })
        .where(
          and(
            eq(otpCodes.userId, user.id),
            eq(otpCodes.purpose, purpose),
            isNull(otpCodes.consumedAt),
            isNull(otpCodes.supersededAt),
          ),
        );
      const [inserted] = await tx
        .insert(otpCodes)
        .values({
          id,
          userId: user.id,
          purpose,
          codeHmac: otpHmac(this.env.OTP_HMAC_SECRET, id, code),
          binding: purpose === "signup" ? sha256(user.passwordHash) : null,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
          resendAvailableAt: new Date(now.getTime() + OTP_RESEND_MS),
        })
        .returning();
      return inserted!;
    });
    this.limiter.hit(`otp:${user.email}`, now.getTime());
    await this.mailer.sendOtp(user.email, code, purpose);
    return this.toChallenge(row, user.email);
  }

  // ------------------------------------------------------------------ F-01 Registrasi

  async register(input: RegisterInput): Promise<OtpChallenge> {
    const email = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, this.env.BCRYPT_COST);
    // Email unik per jenis identitas selama akun belum terhapus (users_kind_email_key, PRD 2.3).
    const existing = await this.db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.kind, "alumni"), ne(users.status, "deleted")),
    });

    if (existing && (existing.status !== "pending_otp" || existing.kind !== "alumni")) {
      throw new AppException(
        409,
        "VALIDATION_ERROR",
        "Email sudah terdaftar. Silakan masuk atau gunakan lupa password.",
        {
          fieldErrors: { email: ["Email sudah terdaftar"] },
        },
      );
    }

    const now = this.now();
    let user: { id: string; email: string; passwordHash: string };
    if (existing) {
      // Akun masih pending_otp: lanjutkan akun yang sama, tanpa akun ganda (AC F01-4).
      // Sandi dan data terbaru menggantikan yang lama; challenge lama batal karena binding sandi berubah.
      await this.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            passwordHash,
            policyVersion: input.accept_policy_version,
            policyAcceptedAt: now,
            updatedAt: now,
          })
          .where(eq(users.id, existing.id));
        await tx.update(alumni).set(this.alumniProfile(input, now)).where(eq(alumni.userId, existing.id));
      });
      user = { id: existing.id, email, passwordHash };
    } else {
      const id = uuidv7();
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(users).values({
            id,
            email,
            passwordHash,
            status: "pending_otp",
            kind: "alumni",
            policyVersion: input.accept_policy_version,
            policyAcceptedAt: now,
          });
          await tx.insert(alumni).values({ userId: id, ...this.alumniProfile(input, now) });
        });
      } catch (e) {
        // Request ganda bersamaan: email unik menjamin satu akun (AC F01-4).
        // Drizzle membungkus galat driver; nama constraint ada di `cause` (postgres-js/PGlite).
        const cause = (e as { cause?: { constraint_name?: string; constraint?: string } })?.cause;
        if ((cause?.constraint_name ?? cause?.constraint) === "users_kind_email_key")
          return this.register(input);
        throw e;
      }
      user = { id, email, passwordHash };
    }
    return this.issueOtp(user, "signup");
  }

  private alumniProfile(input: RegisterInput, now: Date) {
    return {
      fullName: input.full_name.trim(),
      gender: input.gender,
      cohort: input.cohort,
      classIn: input.class_in,
      classOut: input.class_out,
      updatedAt: now,
    };
  }

  async verifyOtp(challengeId: string, code: string, deviceName: string | undefined, requestId: string) {
    const now = this.now();
    const challenge = await this.db.query.otpCodes.findFirst({ where: eq(otpCodes.id, challengeId) });
    const expired = new AppException(410, "OTP_EXPIRED", "Kode tidak berlaku lagi. Minta kode baru.");
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.supersededAt ||
      challenge.expiresAt <= now ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    ) {
      throw expired;
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (!user) throw expired;

    if (!safeEqualHex(challenge.codeHmac, otpHmac(this.env.OTP_HMAC_SECRET, challenge.id, code))) {
      const [updated] = await this.db
        .update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(eq(otpCodes.id, challenge.id))
        .returning({ attempts: otpCodes.attempts });
      const left = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? OTP_MAX_ATTEMPTS));
      if (left === 0) throw expired;
      throw new AppException(400, "VALIDATION_ERROR", `Kode salah. Sisa percobaan ${left}.`, {
        fieldErrors: { code: [`Kode salah. Sisa percobaan ${left}.`] },
      });
    }

    if (challenge.purpose === "signup") {
      if (challenge.binding !== sha256(user.passwordHash)) throw expired;
      return this.completeSignup(challenge.id, user.id, deviceName, requestId);
    }
    throw new AppException(400, "VALIDATION_ERROR", "Tujuan kode belum didukung.");
  }

  /** OTP signup benar: akun aktif, nomor anggota dialokasikan sekali, KTA Tidak Aktif (AC F01-2, F05-1). */
  private async completeSignup(
    challengeId: string,
    userId: string,
    deviceName: string | undefined,
    requestId: string,
  ) {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const consumed = await tx
        .update(otpCodes)
        .set({ consumedAt: now })
        .where(and(eq(otpCodes.id, challengeId), isNull(otpCodes.consumedAt)))
        .returning({ id: otpCodes.id });
      if (consumed.length === 0)
        throw new AppException(410, "OTP_EXPIRED", "Kode tidak berlaku lagi. Minta kode baru.");

      await tx
        .update(users)
        .set({ status: "active", emailVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, userId));
      const profile = await tx.query.alumni.findFirst({ where: eq(alumni.userId, userId) });
      const allocated = profile ? await this.allocateMemberNumber(tx, profile) : null;
      await writeAudit(tx, {
        actorUserId: userId,
        effectiveRole: "alumni",
        action: "account.activated",
        entityType: "user",
        entityId: userId,
        requestId,
        after: { member_number: allocated },
      });
      const issued = await this.createSession(tx, userId, "mobile", 1, deviceName);
      return { session: issued.pair };
    });
  }

  private async allocateMemberNumber(tx: Tx, profile: typeof alumni.$inferSelect): Promise<string> {
    if (profile.memberNumber) return profile.memberNumber;
    const result = await tx.execute<{ seq: string }>(
      sql`select nextval('app.membership_no_seq')::text as seq`,
    );
    const rows =
      (result as unknown as { rows?: { seq: string }[] }).rows ?? (result as unknown as { seq: string }[]);
    const seq = Number(rows[0]!.seq);
    const number = memberNumber({
      cohort: profile.cohort,
      classIn: profile.classIn,
      classOut: profile.classOut,
      gender: profile.gender,
      seq,
    });
    await tx
      .update(alumni)
      .set({ memberSeq: seq, memberNumber: number, updatedAt: this.now() })
      .where(eq(alumni.userId, profile.userId));
    return number;
  }

  async resendOtp(challengeId: string): Promise<OtpChallenge> {
    const now = this.now();
    const challenge = await this.db.query.otpCodes.findFirst({ where: eq(otpCodes.id, challengeId) });
    if (!challenge || challenge.consumedAt)
      throw new AppException(410, "OTP_EXPIRED", "Mulai ulang pendaftaran atau masuk kembali.");
    if (challenge.supersededAt)
      throw new AppException(410, "OTP_EXPIRED", "Kode ini sudah diganti kode yang lebih baru.");
    if (challenge.resendAvailableAt > now) {
      const wait = Math.ceil((challenge.resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
        retryAfterSeconds: wait,
      });
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (!user) throw new AppException(410, "OTP_EXPIRED", "Mulai ulang pendaftaran.");
    if (challenge.purpose === "signup" && challenge.binding !== sha256(user.passwordHash)) {
      throw new AppException(410, "OTP_EXPIRED", "Kode ini sudah diganti kode yang lebih baru.");
    }
    if (challenge.purpose === "email_change")
      throw new AppException(400, "VALIDATION_ERROR", "Tujuan kode belum didukung.");
    return this.issueOtp(user, challenge.purpose, challenge.id);
  }

  // ------------------------------------------------------------------ F-02 Login dan sesi

  private assertLoginAllowed(email: string, ip: string) {
    const now = this.now().getTime();
    const wait = Math.max(
      this.limiter.check(`login:${email}`, LOGIN_FAILS_LIMIT, LOGIN_WINDOW_MS, now),
      this.limiter.check(`login-ip:${ip}`, LOGIN_FAILS_LIMIT * 5, LOGIN_WINDOW_MS, now),
    );
    if (wait > 0) {
      throw new AppException(
        429,
        "RATE_LIMITED",
        "Terlalu banyak percobaan masuk. Coba lagi nanti atau gunakan lupa password.",
        {
          retryAfterSeconds: wait,
        },
      );
    }
  }

  private recordLoginFailure(email: string, ip: string) {
    const now = this.now().getTime();
    this.limiter.hit(`login:${email}`, now);
    this.limiter.hit(`login-ip:${ip}`, now);
  }

  private async checkPassword(emailRaw: string, password: string, ip: string, kind: "alumni" | "admin") {
    const email = normalizeEmail(emailRaw);
    this.assertLoginAllowed(email, ip);
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.kind, kind), ne(users.status, "deleted")),
    });
    // Bandingkan dengan hash tiruan bila user tidak ada agar waktu respons serupa.
    const ok = await bcrypt.compare(
      password,
      user?.passwordHash ?? "$2b$10$CwTycUXWue0Thq9StjUM0uJ8XJ9hG5DkqQ1vT8d1Xg2bJ0R3S0W2a",
    );
    if (!user || !ok || user.kind !== kind || user.status === "disabled" || user.status === "deleted") {
      this.recordLoginFailure(email, ip);
      throw new AppException(401, "UNAUTHENTICATED", "Email atau password salah.");
    }
    this.limiter.reset(`login:${email}`);
    return user;
  }

  async login(emailRaw: string, password: string, deviceName: string | undefined, ip: string) {
    const user = await this.checkPassword(emailRaw, password, ip, "alumni");
    if (user.status === "pending_otp") {
      // Pakai challenge yang masih berlaku agar tidak memicu batas kirim; selain itu buat baru.
      const active = await this.db.query.otpCodes.findFirst({
        where: and(
          eq(otpCodes.userId, user.id),
          eq(otpCodes.purpose, "signup"),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
          gt(otpCodes.expiresAt, this.now()),
        ),
        orderBy: desc(otpCodes.createdAt),
      });
      const challenge =
        active && active.binding === sha256(user.passwordHash) && active.attempts < OTP_MAX_ATTEMPTS
          ? this.toChallenge(active, user.email)
          : await this.issueOtp(user, "signup");
      return { next: "verify_otp" as const, challenge };
    }
    const issued = await this.createSession(this.db, user.id, "mobile", 1, deviceName);
    return { next: "home" as const, session: issued.pair };
  }

  async createSession(
    tx: Db | Tx,
    userId: string,
    audience: Audience,
    mfaLevel: number,
    deviceName?: string,
    familyId?: string,
  ): Promise<IssuedSession> {
    const now = this.now();
    const user = await tx.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { sessionVersion: true },
    });
    const sessionId = uuidv7();
    const refreshToken = randomToken();
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS[audience]);
    await tx.insert(sessions).values({
      id: sessionId,
      userId,
      familyId: familyId ?? uuidv7(),
      refreshHash: sha256(refreshToken),
      audience,
      mfaLevel,
      deviceName: deviceName ?? null,
      lastSeenAt: now,
      lastActivityAt: now,
      expiresAt: refreshExpiresAt,
    });
    const access = await this.tokens.signAccess({
      userId,
      sessionId,
      sessionVersion: user?.sessionVersion ?? 1,
      audience,
      mfaLevel,
    });
    return {
      sessionId,
      refreshToken,
      refreshExpiresAt,
      pair: {
        access_token: access.token,
        access_expires_at: access.expiresAt.toISOString(),
        ...(audience === "mobile"
          ? { refresh_token: refreshToken, refresh_expires_at: refreshExpiresAt.toISOString() }
          : {}),
      },
    };
  }

  /**
   * Rotasi refresh token. Token yang sudah dipakai mencabut seluruh keluarga sesi (AC F02-3).
   * Refresh admin tidak memperpanjang aktivitas; sesi admin idle 30 menit tidak bisa diperbarui (AC F02-5).
   */
  async refresh(refreshToken: string, expectedAudience: Audience): Promise<IssuedSession> {
    const now = this.now();
    const hash = sha256(refreshToken);
    const unauth = new AppException(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
    const current = await this.db.query.sessions.findFirst({ where: eq(sessions.refreshHash, hash) });
    if (!current || current.audience !== expectedAudience) throw unauth;
    if (current.revokedAt || current.replacedBy) {
      await this.revokeFamily(current.familyId);
      throw unauth;
    }
    if (current.expiresAt <= now) throw unauth;
    if (current.audience === "admin" && now.getTime() - current.lastActivityAt.getTime() > ADMIN_IDLE_MS) {
      await this.db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, current.id));
      throw unauth;
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, current.userId) });
    if (
      !user ||
      user.status === "disabled" ||
      user.status === "deleted" ||
      user.status === "deletion_pending"
    )
      throw unauth;

    return this.db.transaction(async (tx) => {
      const issued = await this.createSession(
        tx,
        current.userId,
        current.audience as Audience,
        current.mfaLevel,
        current.deviceName ?? undefined,
        current.familyId,
      );
      const rotated = await tx
        .update(sessions)
        .set({ revokedAt: now, replacedBy: issued.sessionId })
        .where(and(eq(sessions.id, current.id), isNull(sessions.replacedBy), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      if (rotated.length === 0) {
        // Dua refresh bersamaan dengan token yang sama: perlakukan sebagai reuse.
        throw unauth;
      }
      // Sesi baru mewarisi waktu aktivitas terakhir; refresh bukan aktivitas pengguna.
      await tx
        .update(sessions)
        .set({ lastActivityAt: current.lastActivityAt })
        .where(eq(sessions.id, issued.sessionId));
      return issued;
    });
  }

  private async revokeFamily(familyId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
  }

  async logout(sessionId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /** Keluar semua perangkat: semua sesi dicabut dan session_version naik sehingga access token lama ditolak (AC F02-6). */
  async logoutAll(userId: string) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(eq(users.id, userId));
    });
  }

  // ------------------------------------------------------------------ Admin (F-02, F-16)

  async adminLogin(emailRaw: string, password: string, ip: string) {
    const user = await this.checkPassword(emailRaw, password, ip, "admin");
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.userId, user.id) });
    if (!admin || admin.status !== "active" || user.status !== "active")
      throw new AppException(401, "UNAUTHENTICATED", "Email atau password salah.");
    const totpRow = await this.db.query.mfaTotp.findFirst({ where: eq(mfaTotp.userId, user.id) });
    const mfa = await this.tokens.signMfa(user.id);
    return {
      mfa_token: mfa.token,
      mfa_expires_at: mfa.expiresAt.toISOString(),
      totp_enrollment_required: !totpRow?.verifiedAt,
    };
  }

  async adminVerifyMfa(
    mfaToken: string,
    totpCode: string | undefined,
    backupCode: string | undefined,
    requestId: string,
    ip: string,
  ) {
    const unauth = new AppException(
      401,
      "UNAUTHENTICATED",
      "Kode autentikator salah atau sesi masuk kedaluwarsa.",
    );
    const userId = await this.tokens.verifyMfa(mfaToken);
    if (!userId) throw unauth;
    const now = this.now();
    const wait = this.limiter.check(`mfa:${userId}`, 5, LOGIN_WINDOW_MS, now.getTime());
    if (wait > 0)
      throw new AppException(429, "RATE_LIMITED", "Terlalu banyak percobaan kode. Coba lagi nanti.", {
        retryAfterSeconds: wait,
      });

    const [admin, totpRow] = await Promise.all([
      this.db.query.admins.findFirst({ where: eq(admins.userId, userId) }),
      this.db.query.mfaTotp.findFirst({ where: eq(mfaTotp.userId, userId) }),
    ]);
    if (!admin || admin.status !== "active" || !totpRow?.verifiedAt) throw unauth;

    let ok = false;
    if (totpCode)
      ok = verifyTotp(decryptSecret(totpRow.secretEncrypted, this.env.TOTP_ENC_KEY), totpCode, now);
    else if (backupCode) {
      const h = sha256(backupCode.trim().toUpperCase());
      if (totpRow.backupCodeHashes.includes(h)) {
        // Backup code sekali pakai.
        await this.db
          .update(mfaTotp)
          .set({ backupCodeHashes: totpRow.backupCodeHashes.filter((x) => x !== h) })
          .where(eq(mfaTotp.userId, userId));
        ok = true;
      }
    }
    if (!ok) {
      this.limiter.hit(`mfa:${userId}`, now.getTime());
      this.limiter.hit(`login-ip:${ip}`, now.getTime());
      throw unauth;
    }
    return this.db.transaction(async (tx) => {
      const issued = await this.createSession(tx, userId, "admin", 2, "Web admin");
      await writeAudit(tx, {
        actorAdminId: admin.id,
        actorUserId: userId,
        effectiveRole: admin.role,
        action: "admin.login",
        entityType: "admin",
        entityId: admin.id,
        requestId,
      });
      return issued;
    });
  }

  async adminProfile(userId: string) {
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.userId, userId) });
    if (!admin || admin.status !== "active")
      throw new AppException(403, "FORBIDDEN", "Akun admin tidak aktif.");
    const perms = await this.db
      .select({ p: adminPermissions.permission })
      .from(adminPermissions)
      .where(eq(adminPermissions.adminId, admin.id));
    return {
      admin_id: admin.id,
      display_name: admin.displayName,
      role: admin.role,
      // Super Admin memiliki semua izin.
      permissions:
        admin.role === "super_admin"
          ? ALL_PERMISSIONS
          : (perms.map((r) => r.p) as components["schemas"]["Permission"][]),
      permissions_version: admin.permissionsVersion,
    };
  }
}

/** Semua izin kontrak (ARCHITECTURE §4.5, 15 izin) yang dimiliki super_admin; sumbernya enum Permission kontrak. */
export const ALL_PERMISSIONS: components["schemas"]["Permission"][] = [...PERMISSION_VALUES];
