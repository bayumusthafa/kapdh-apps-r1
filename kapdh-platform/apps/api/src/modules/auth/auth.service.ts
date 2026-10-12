import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { type components, PERMISSION_VALUES } from "@kapdh/contracts";
import { admins, alumni, mfaTotp, otpCodes, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, desc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer, OtpPurpose } from "../../core/adapters/mailer.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { tryCtx } from "../../core/context/request-context.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import { rows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { ADMIN_IDLE_MS } from "../../core/guards/auth.guard.js";
import { memberNumber } from "../../core/membership/member-number.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV, MAILER } from "../../core/tokens.js";
import {
  backupCodeHash,
  decryptSecret,
  generateOtp,
  matchTotpStep,
  otpHmac,
  randomToken,
  safeEqualHex,
  sha256,
} from "./crypto.js";
import { type Audience, TokenService } from "./token.service.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type TokenPair = components["schemas"]["TokenPair"];
type OtpRow = typeof otpCodes.$inferSelect;

const HOUR_MS = 3600_000;
const OTP_TTL_MS = 10 * 60_000;
const OTP_RESEND_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;
/** PRD 2.5 (Usulan D1): 5 pengiriman OTP per jam per email, ditambah pembatasan IP. */
const OTP_SENDS_PER_HOUR = 5;
/** Usulan D1: longgar agar pendaftaran massal di satu Wi-Fi acara reuni tidak terblokir. */
const OTP_SENDS_PER_IP_PER_HOUR = 60;
/** Usulan D1: kegagalan verifikasi OTP per IP per 15 menit (menahan tebakan lintas banyak challenge). */
const OTP_VERIFY_FAILS_PER_IP = 50;
const LOGIN_FAILS_LIMIT = 10; // dalam 15 menit, PRD 2.5 / D1
const LOGIN_WINDOW_MS = 15 * 60_000;
const MFA_FAILS_LIMIT = 5;
/** PRD 2.5: sandi maksimal 72 byte UTF-8 (batas bcrypt); server menolak, bukan memotong. */
const PASSWORD_MAX_BYTES = 72;
/** TTL refresh (D1, dikunci pengembang Tahap 0): mobile 60 hari, admin 12 jam. */
const REFRESH_TTL_MS: Record<Audience, number> = { mobile: 60 * 24 * HOUR_MS, admin: 12 * HOUR_MS };

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

const otpExpired = (message = "Kode tidak berlaku lagi. Minta kode baru.") =>
  new AppException(410, "OTP_EXPIRED", message);

const emailTaken = () =>
  new AppException(
    409,
    "VALIDATION_ERROR",
    "Email sudah terdaftar. Silakan masuk atau gunakan lupa password.",
    {
      fieldErrors: { email: ["Email sudah terdaftar"] },
    },
  );

/** Penanda internal kode MFA salah; diubah menjadi 401 setelah transaksi dibatalkan. */
class InvalidMfaCode extends Error {}

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  private now() {
    return this.clock.now();
  }

  /**
   * Hash tiruan dengan cost yang SAMA dengan hash asli (BCRYPT_COST) agar waktu respons login untuk email yang tidak
   * terdaftar tidak berbeda (anti enumerasi, PRD 2.5). Sebelumnya cost 10 tetap vs cost 12 asli.
   */
  private dummyPasswordHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(randomToken(), this.env.BCRYPT_COST);
    return this.dummyHash;
  }

  private findAccount(db: DbOrTx, email: string, kind: "alumni" | "admin") {
    // Email unik per jenis identitas selama akun belum terhapus (users_kind_email_key, PRD 2.3).
    return db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.kind, kind), ne(users.status, "deleted")),
    });
  }

  // ------------------------------------------------------------------ OTP

  private toChallenge(row: OtpRow, email: string): OtpChallenge {
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

  /** Kuota kirim OTP per email dan per IP (PRD 2.5). Dipanggil di dalam transaksi sebelum challenge dibuat. */
  private async consumeOtpQuota(email: string) {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `otp-ip:${ip}`,
        OTP_SENDS_PER_IP_PER_HOUR,
        HOUR_MS,
        "Terlalu banyak permintaan kode dari jaringan ini. Coba lagi nanti.",
      );
    await this.limits.consumeOrThrow(
      `otp:${email}`,
      OTP_SENDS_PER_HOUR,
      HOUR_MS,
      "Terlalu banyak permintaan kode. Coba lagi nanti.",
    );
  }

  /** Challenge aktif (belum dipakai/diganti/kedaluwarsa) untuk akun dan tujuan. */
  private async activeChallenge(db: DbOrTx, userId: string, purpose: OtpPurpose, now: Date) {
    return db.query.otpCodes.findFirst({
      where: and(
        eq(otpCodes.userId, userId),
        eq(otpCodes.purpose, purpose),
        isNull(otpCodes.consumedAt),
        isNull(otpCodes.supersededAt),
        gt(otpCodes.expiresAt, now),
      ),
      orderBy: desc(otpCodes.createdAt),
    });
  }

  /**
   * Membuat challenge baru dan membatalkan challenge lain untuk tujuan yang sama (PRD 2.5). Pemanggil WAJIB sudah
   * mengunci baris users (FOR NO KEY UPDATE) atau baru menyisipkannya di transaksi yang sama, sehingga penerbit
   * bersamaan berurutan dan tidak bentrok pada otp_codes_active_key. Kuota kirim dikonsumsi di sini, sebelum commit.
   */
  private async createChallenge(
    tx: Tx,
    user: { id: string; email: string; passwordHash: string },
    purpose: OtpPurpose,
    now: Date,
  ): Promise<{ row: OtpRow; code: string }> {
    await this.consumeOtpQuota(user.email);
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
    const code = generateOtp();
    const id = uuidv7();
    const [row] = await tx
      .insert(otpCodes)
      .values({
        id,
        userId: user.id,
        purpose,
        codeHmac: otpHmac(this.env.OTP_HMAC_SECRET, id, code),
        // Signup: challenge terikat hash sandi saat dibuat (anti pre-account hijacking).
        binding: purpose === "signup" ? sha256(user.passwordHash) : null,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        resendAvailableAt: new Date(now.getTime() + OTP_RESEND_MS),
        createdAt: now,
      })
      .returning();
    return { row: row!, code };
  }

  private async lockUser(tx: Tx, userId: string) {
    const [locked] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
    return locked;
  }

  /**
   * Menerbitkan challenge untuk akun yang sudah ada (kirim ulang, login akun pending). `replacing` = challenge yang
   * diminta dikirim ulang; bila sudah diganti/dipakai oleh permintaan bersamaan, ditolak seperti permintaan
   * berurutan (410).
   */
  private async issueOtp(
    user: { id: string; email: string },
    purpose: OtpPurpose,
    replacing?: string,
  ): Promise<OtpChallenge> {
    const now = this.now();
    const issued = await this.db.transaction(async (tx) => {
      const locked = await this.lockUser(tx, user.id);
      if (!locked || locked.status === "deleted") throw otpExpired("Mulai ulang pendaftaran.");
      if (replacing) {
        const [current] = await tx
          .select({ consumedAt: otpCodes.consumedAt, supersededAt: otpCodes.supersededAt })
          .from(otpCodes)
          .where(eq(otpCodes.id, replacing));
        if (!current || current.consumedAt || current.supersededAt)
          throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
      }
      return this.createChallenge(
        tx,
        { id: locked.id, email: locked.email, passwordHash: locked.passwordHash },
        purpose,
        now,
      );
    });
    await this.mailer.sendOtp(user.email, issued.code, purpose);
    return this.toChallenge(issued.row, user.email);
  }

  // ------------------------------------------------------------------ F-01 Registrasi

  /**
   * Registrasi (F-01, AC F01-1, F01-4). Satu transaksi dengan baris users terkunci:
   * - email aktif → 409; email pending_otp → akun yang sama dilanjutkan (tanpa akun ganda),
   * - sandi sama dan challenge masih berlaku → challenge itu dikembalikan (permintaan ganda/ulang tidak mengirim kode
   *   baru dan tidak membatalkan kode yang sudah diterima), profil terbaru tetap disimpan,
   * - sandi berbeda → hanya setelah cooldown kirim ulang 60 detik (PRD 2.5); sandi, profil, dan challenge baru
   *   (binding baru membatalkan challenge lama) ditulis atomik dan kuota kirim diperiksa sebelum commit,
   * - registrasi baru bersamaan untuk email yang sama: indeks unik users_kind_email_key menjamin satu akun; yang
   *   kalah mengulang dan melanjutkan akun pemenang.
   */
  async register(input: RegisterInput, attempt = 0): Promise<OtpChallenge> {
    const email = normalizeEmail(input.email);
    const existing = await this.findAccount(this.db, email, "alumni");
    if (existing && existing.status !== "pending_otp") throw emailTaken();
    const samePassword = existing ? await bcrypt.compare(input.password, existing.passwordHash) : false;
    const newHash = samePassword ? null : await bcrypt.hash(input.password, this.env.BCRYPT_COST);
    const now = this.now();
    const policy = { policyVersion: input.accept_policy_version, policyAcceptedAt: now, updatedAt: now };

    try {
      const outcome = await this.db.transaction(async (tx): Promise<{ row: OtpRow; code: string | null }> => {
        if (!existing) {
          const id = uuidv7();
          await tx.insert(users).values({
            id,
            email,
            passwordHash: newHash!,
            status: "pending_otp",
            kind: "alumni",
            ...policy,
            createdAt: now,
          });
          await tx.insert(alumni).values({ userId: id, ...this.alumniProfile(input, now), createdAt: now });
          return this.createChallenge(tx, { id, email, passwordHash: newHash! }, "signup", now);
        }

        const locked = await this.lockUser(tx, existing.id);
        if (!locked || locked.status !== "pending_otp") throw emailTaken();
        // Hash berubah sejak dibaca (registrasi ulang bersamaan): bandingkan ulang terhadap hash terkunci.
        const same =
          locked.passwordHash === existing.passwordHash
            ? samePassword
            : await bcrypt.compare(input.password, locked.passwordHash);
        const active = await this.activeChallenge(tx, locked.id, "signup", now);
        const reusable =
          same &&
          active &&
          active.binding === sha256(locked.passwordHash) &&
          active.attempts < OTP_MAX_ATTEMPTS;
        if (!reusable && active && active.resendAvailableAt > now) {
          const wait = Math.ceil((active.resendAvailableAt.getTime() - now.getTime()) / 1000);
          throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
            retryAfterSeconds: wait,
          });
        }
        await tx.update(alumni).set(this.alumniProfile(input, now)).where(eq(alumni.userId, locked.id));
        const passwordHash = same
          ? locked.passwordHash
          : (newHash ?? (await bcrypt.hash(input.password, this.env.BCRYPT_COST)));
        await tx
          .update(users)
          .set({ ...policy, passwordHash })
          .where(and(eq(users.id, locked.id), eq(users.status, "pending_otp")));
        if (reusable) return { row: active, code: null };
        return this.createChallenge(tx, { id: locked.id, email, passwordHash }, "signup", now);
      });
      if (outcome.code) await this.mailer.sendOtp(email, outcome.code, "signup");
      return this.toChallenge(outcome.row, email);
    } catch (e) {
      // Registrasi baru bersamaan: pemenang membuat akun; yang kalah melanjutkan akun itu (AC F01-4).
      if (!existing && attempt === 0 && isUniqueViolation(e, "users_kind_email_key"))
        return this.register(input, 1);
      throw e;
    }
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

  /**
   * Verifikasi OTP (PRD 2.5, AC F01-3): satu percobaan dicadangkan secara atomik SEBELUM kode dibandingkan
   * (`attempts < 5` dalam predikat UPDATE), sehingga permintaan paralel tidak dapat mencoba lebih dari 5 kode per
   * challenge dan tidak pernah melanggar CHECK otp_codes_attempts_chk.
   */
  async verifyOtp(challengeId: string, code: string, deviceName: string | undefined) {
    const now = this.now();
    const ip = tryCtx()?.ip ?? null;
    if (ip)
      await this.limits.assertNotLimited(
        `otp-verify-ip:${ip}`,
        OTP_VERIFY_FAILS_PER_IP,
        LOGIN_WINDOW_MS,
        "Terlalu banyak percobaan kode dari jaringan ini. Coba lagi nanti.",
      );
    const [reserved] = await this.db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(
        and(
          eq(otpCodes.id, challengeId),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
          gt(otpCodes.expiresAt, now),
          lt(otpCodes.attempts, OTP_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!reserved) throw otpExpired();

    if (!safeEqualHex(reserved.codeHmac, otpHmac(this.env.OTP_HMAC_SECRET, reserved.id, code))) {
      if (ip) await this.limits.hit(`otp-verify-ip:${ip}`, LOGIN_WINDOW_MS);
      const left = OTP_MAX_ATTEMPTS - reserved.attempts;
      if (left <= 0) throw otpExpired();
      throw new AppException(400, "VALIDATION_ERROR", `Kode salah. Sisa percobaan ${left}.`, {
        fieldErrors: { code: [`Kode salah. Sisa percobaan ${left}.`] },
      });
    }

    if (reserved.purpose === "signup") return this.completeSignup(reserved, deviceName);
    throw new AppException(400, "VALIDATION_ERROR", "Tujuan kode belum didukung.");
  }

  /**
   * OTP signup benar: dalam SATU transaksi dengan baris users terkunci, challenge dikonsumsi dengan seluruh predikat
   * (belum dipakai/diganti/kedaluwarsa), binding sandi diperiksa ulang terhadap hash terkunci, akun pending_otp
   * menjadi active, nomor anggota dialokasikan sekali, audit, dan sesi diterbitkan (AC F01-2, F05-1). Registrasi
   * ulang bersamaan tidak dapat mengaktifkan akun dengan sandi penyerang.
   */
  private async completeSignup(challenge: OtpRow, deviceName: string | undefined) {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const user = await this.lockUser(tx, challenge.userId);
      if (!user || user.status !== "pending_otp" || challenge.binding !== sha256(user.passwordHash))
        throw otpExpired();
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
      if (consumed.length === 0) throw otpExpired();

      const activated = await tx
        .update(users)
        .set({ status: "active", emailVerifiedAt: now, updatedAt: now })
        .where(and(eq(users.id, user.id), eq(users.status, "pending_otp")))
        .returning({ id: users.id });
      if (activated.length === 0) throw otpExpired();
      const profile = await tx.query.alumni.findFirst({ where: eq(alumni.userId, user.id) });
      const allocated = profile ? await this.allocateMemberNumber(tx, profile) : null;
      await this.audit.write(tx, {
        actor: { kind: "alumni", userId: user.id, adminId: null, adminRole: null },
        action: "account.activated",
        entityType: "user",
        entityId: user.id,
        after: { member_number: allocated },
      });
      const issued = await this.createSession(tx, user.id, "mobile", 1, deviceName);
      return { session: issued.pair };
    });
  }

  /** N dari nextval di transaksi yang sama, lalu UPDATE nomor sekaligus (alumni_member_seq_source_chk, PRD 3.5). */
  private async allocateMemberNumber(tx: Tx, profile: typeof alumni.$inferSelect): Promise<string> {
    if (profile.memberNumber) return profile.memberNumber;
    const [next] = rows<{ seq: string }>(
      await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
    );
    const seq = Number(next!.seq);
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
    if (!challenge || challenge.consumedAt) throw otpExpired("Mulai ulang pendaftaran atau masuk kembali.");
    if (challenge.supersededAt) throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    if (challenge.resendAvailableAt > now) {
      const wait = Math.ceil((challenge.resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
        retryAfterSeconds: wait,
      });
    }
    const user = await this.db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (!user) throw otpExpired("Mulai ulang pendaftaran.");
    if (challenge.purpose === "signup" && challenge.binding !== sha256(user.passwordHash))
      throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    if (challenge.purpose === "email_change")
      throw new AppException(400, "VALIDATION_ERROR", "Tujuan kode belum didukung.");
    return this.issueOtp(user, challenge.purpose, challenge.id);
  }

  // ------------------------------------------------------------------ F-02 Login dan sesi

  private async assertLoginAllowed(email: string, ip: string | null) {
    const message = "Terlalu banyak percobaan masuk. Coba lagi nanti atau gunakan lupa password.";
    await this.limits.assertNotLimited(`login:${email}`, LOGIN_FAILS_LIMIT, LOGIN_WINDOW_MS, message);
    if (ip)
      await this.limits.assertNotLimited(`login-ip:${ip}`, LOGIN_FAILS_LIMIT * 5, LOGIN_WINDOW_MS, message);
  }

  private async recordLoginFailure(email: string, ip: string | null) {
    await this.limits.hit(`login:${email}`, LOGIN_WINDOW_MS);
    if (ip) await this.limits.hit(`login-ip:${ip}`, LOGIN_WINDOW_MS);
  }

  /**
   * Pemeriksaan sandi dengan waktu respons serupa untuk email terdaftar/tidak (PRD 2.5). Sandi > 72 byte ditolak
   * (bukan dipotong bcrypt). Hanya akun yang boleh login: alumni active/pending_otp, admin active; disabled dan
   * deletion_pending tidak memperoleh sesi biasa (PRD 2.2).
   */
  private async checkPassword(emailRaw: string, password: string, kind: "alumni" | "admin") {
    const email = normalizeEmail(emailRaw);
    const ip = tryCtx()?.ip ?? null;
    await this.assertLoginAllowed(email, ip);
    const user = await this.findAccount(this.db, email, kind);
    const tooLong = Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES;
    const hash = user && !tooLong ? user.passwordHash : await this.dummyPasswordHash();
    const matches = await bcrypt.compare(password, hash);
    const allowed =
      !!user &&
      !tooLong &&
      matches &&
      (kind === "alumni"
        ? user.status === "active" || user.status === "pending_otp"
        : user.status === "active");
    if (!user || !allowed) {
      await this.recordLoginFailure(email, ip);
      throw unauthenticated("Email atau password salah.");
    }
    await this.limits.reset(`login:${email}`);
    return user;
  }

  async login(emailRaw: string, password: string, deviceName: string | undefined) {
    const user = await this.checkPassword(emailRaw, password, "alumni");
    const now = this.now();
    if (user.status === "pending_otp") {
      // Pakai challenge yang masih berlaku agar tidak memicu batas kirim; selain itu buat baru.
      const active = await this.activeChallenge(this.db, user.id, "signup", now);
      const challenge =
        active && active.binding === sha256(user.passwordHash) && active.attempts < OTP_MAX_ATTEMPTS
          ? this.toChallenge(active, user.email)
          : await this.issueOtp(user, "signup");
      return { next: "verify_otp" as const, challenge };
    }
    const issued = await this.db.transaction(async (tx) => {
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      return this.createSession(tx, user.id, "mobile", 1, deviceName);
    });
    return { next: "home" as const, session: issued.pair };
  }

  async createSession(
    tx: DbOrTx,
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
    const context = tryCtx();
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
      // Daftar sesi perangkat (F-02): platform dari X-App-Platform; web admin = web.
      platform: audience === "admin" ? "web" : (context?.appPlatform ?? null),
      appVersion: audience === "admin" ? null : (context?.appVersion ?? null),
      lastSeenAt: now,
      lastActivityAt: now,
      expiresAt: refreshExpiresAt,
      createdAt: now,
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
    const unauth = unauthenticated();
    const current = await this.db.query.sessions.findFirst({ where: eq(sessions.refreshHash, hash) });
    if (!current || current.audience !== expectedAudience) throw unauth;
    if (current.revokedAt || current.replacedBy) {
      await this.revokeFamilyOnReuse(current);
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
      user.status !== "active" ||
      user.kind !== (expectedAudience === "admin" ? "admin" : "alumni")
    )
      throw unauth;
    if (expectedAudience === "admin") {
      const admin = await this.db.query.admins.findFirst({ where: eq(admins.userId, user.id) });
      if (admin?.status !== "active") throw unauth;
    }

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
      // Dua refresh bersamaan dengan token yang sama (klien ganda yang sah): yang kalah ditolak tanpa mencabut
      // keluarga; pemakaian ulang SETELAH rotasi tetap mencabut seluruh keluarga (cabang di atas).
      if (rotated.length === 0) throw unauth;
      // Sesi baru mewarisi waktu aktivitas terakhir; refresh bukan aktivitas pengguna.
      await tx
        .update(sessions)
        .set({ lastActivityAt: current.lastActivityAt })
        .where(eq(sessions.id, issued.sessionId));
      return issued;
    });
  }

  /**
   * Refresh token yang sudah dirotasi/dicabut dipakai lagi: indikasi token dicuri (AC F02-3). Seluruh keluarga sesi
   * dicabut dan kejadian keamanan diaudit dalam transaksi yang sama (F-17). Aktor = pemanggil anonim (pemegang token
   * tidak terautentikasi); entitas = pemilik akun.
   */
  private async revokeFamilyOnReuse(session: { userId: string; familyId: string; audience: string }) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await this.audit.write(tx, {
        action: "session.refresh_reuse_detected",
        entityType: "user",
        entityId: session.userId,
        after: { audience: session.audience, sessions_revoked: revoked.length },
      });
    });
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
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(eq(users.id, userId));
      await this.audit.write(tx, {
        action: "session.logout_all",
        entityType: "user",
        entityId: userId,
        after: { sessions_revoked: revoked.length },
      });
    });
  }

  // ------------------------------------------------------------------ Admin (F-02, F-16)

  async adminLogin(emailRaw: string, password: string) {
    const user = await this.checkPassword(emailRaw, password, "admin");
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.userId, user.id) });
    if (!admin || admin.status !== "active" || user.status !== "active")
      throw unauthenticated("Email atau password salah.");
    const totpRow = await this.db.query.mfaTotp.findFirst({ where: eq(mfaTotp.userId, user.id) });
    const mfa = await this.tokens.signMfa(user.id);
    return {
      mfa_token: mfa.token,
      mfa_expires_at: mfa.expiresAt.toISOString(),
      totp_enrollment_required: !totpRow?.verifiedAt,
    };
  }

  /**
   * Tahap TOTP admin (AC F02-2). Baris mfa_totp dikunci sehingga percobaan bersamaan berurutan: kode TOTP hanya
   * berlaku untuk langkah waktu yang lebih baru dari last_used_step (anti replay, RFC 6238 §5.2) dan backup code
   * dikonsumsi atomik sekali pakai.
   */
  async adminVerifyMfa(mfaToken: string, totpCode: string | undefined, backupCode: string | undefined) {
    const unauth = unauthenticated("Kode autentikator salah atau sesi masuk kedaluwarsa.");
    const userId = await this.tokens.verifyMfa(mfaToken);
    if (!userId) throw unauth;
    const ip = tryCtx()?.ip ?? null;
    await this.limits.assertNotLimited(
      `mfa:${userId}`,
      MFA_FAILS_LIMIT,
      LOGIN_WINDOW_MS,
      "Terlalu banyak percobaan kode. Coba lagi nanti.",
    );
    const now = this.now();
    try {
      return await this.db.transaction(async (tx) => {
        const [totpRow] = await tx.select().from(mfaTotp).where(eq(mfaTotp.userId, userId)).for("update");
        const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
        const admin = await tx.query.admins.findFirst({ where: eq(admins.userId, userId) });
        if (
          !totpRow?.verifiedAt ||
          !user ||
          user.status !== "active" ||
          user.kind !== "admin" ||
          admin?.status !== "active"
        )
          throw new InvalidMfaCode();

        let method: "totp" | "backup_code";
        if (totpCode) {
          const step = matchTotpStep(
            decryptSecret(totpRow.secretEncrypted, this.env.TOTP_ENC_KEY),
            totpCode,
            now,
          );
          if (step === null || (totpRow.lastUsedStep !== null && step <= totpRow.lastUsedStep))
            throw new InvalidMfaCode();
          await tx
            .update(mfaTotp)
            .set({ lastUsedStep: step, updatedAt: now })
            .where(eq(mfaTotp.userId, userId));
          method = "totp";
        } else if (backupCode) {
          const hash = backupCodeHash(this.env.OTP_HMAC_SECRET, backupCode);
          const consumed = await tx
            .update(mfaTotp)
            .set({ backupCodeHashes: sql`${mfaTotp.backupCodeHashes} - ${hash}::text`, updatedAt: now })
            .where(
              and(
                eq(mfaTotp.userId, userId),
                sql`${mfaTotp.backupCodeHashes} @> ${JSON.stringify([hash])}::jsonb`,
              ),
            )
            .returning({ userId: mfaTotp.userId });
          if (consumed.length === 0) throw new InvalidMfaCode();
          method = "backup_code";
        } else throw new InvalidMfaCode();

        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
        const issued = await this.createSession(tx, userId, "admin", 2, "Web admin");
        await this.audit.write(tx, {
          actor: { kind: "admin", userId, adminId: admin.id, adminRole: admin.role },
          action: "admin.login",
          entityType: "admin",
          entityId: admin.id,
          after: { mfa_method: method },
        });
        return issued;
      });
    } catch (e) {
      if (!(e instanceof InvalidMfaCode)) throw e;
      await this.limits.hit(`mfa:${userId}`, LOGIN_WINDOW_MS);
      if (ip) await this.limits.hit(`login-ip:${ip}`, LOGIN_WINDOW_MS);
      throw unauth;
    }
  }

  /** Profil admin dari AuthContext yang dievaluasi guard pada request ini (izin dari database, AC F16-3). */
  async adminProfile(auth: AuthContext) {
    const admin = await this.db.query.admins.findFirst({ where: eq(admins.id, auth.adminId!) });
    if (!admin || admin.status !== "active")
      throw new AppException(403, "FORBIDDEN", "Akun admin tidak aktif.");
    return {
      admin_id: admin.id,
      display_name: admin.displayName,
      role: admin.role,
      permissions: PERMISSION_VALUES.filter((p) => auth.permissions.has(p)),
      permissions_version: admin.permissionsVersion,
    };
  }
}
