import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { accountDeletions, admins, alumni, otpCodes, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer, OtpPurpose } from "../../core/adapters/mailer.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { tryCtx } from "../../core/context/request-context.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext, SessionAudience } from "../../core/guards/auth-context.js";
import { ADMIN_IDLE_MS } from "../../core/guards/auth.guard.js";
import { generateOtp, otpHmac, safeEqualHex, sha256 } from "../../core/identity/crypto.js";
import { maskEmail, normalizeEmail } from "../../core/identity/email.js";
import { LOGIN_WINDOW_MS, PasswordVerifier } from "../../core/identity/password-verifier.js";
import { type IssuedSession, SessionIssuer } from "../../core/identity/session-issuer.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import {
  moveDeviceTokensToSession,
  revokeDeviceTokens,
} from "../../core/notifications-kernel/device-tokens.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { legalConsentVersions } from "../../core/settings/legal-consent.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB, ENV, MAILER } from "../../core/tokens.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type LoginResponse = components["schemas"]["LoginResponse"];
type AccountDeletion = components["schemas"]["AccountDeletion"];
type OtpRow = typeof otpCodes.$inferSelect;

/**
 * Challenge aktivasi (kontrak C1, AC F01-3): `signup` dan `email_change` berbagi SATU slot; penerbitan salah satunya
 * membatalkan challenge aktif kedua tujuan dengan baris users terkunci.
 */
const ACTIVATION_PURPOSES = ["signup", "email_change"] as const satisfies readonly OtpPurpose[];
const isActivation = (purpose: OtpPurpose) =>
  (ACTIVATION_PURPOSES as readonly OtpPurpose[]).includes(purpose);

/** Keadaan akun yang sesuai tujuan challenge (POST /auth/otp/resend); selain itu 410 OTP_EXPIRED. */
const PURPOSE_ACCOUNT_STATES: Readonly<Record<OtpPurpose, readonly AccountStatus[]>> = {
  signup: ["pending_otp"],
  email_change: ["pending_otp"],
  password_reset: ["active"],
  deletion: ["active", "pending_otp", "deletion_pending", "disabled"],
};

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
/**
 * Anggaran percobaan registrasi per IP per jam yang dicadangkan SEBELUM bcrypt (PRD 2.5, D1; PRD 5.1): kuota kirim
 * OTP baru diperiksa di dalam transaksi sesudah hash dihitung, sehingga tanpa anggaran ini permintaan yang pasti
 * ditolak 429 tetap menghabiskan CPU bcrypt tanpa batas. Dua kali batas kirim OTP per IP agar koreksi data dan
 * pengulangan di satu Wi-Fi acara reuni tetap lolos.
 */
const REGISTER_ATTEMPTS_PER_IP_PER_HOUR = OTP_SENDS_PER_IP_PER_HOUR * 2;
/** Keadaan akun alumni yang lolos pemeriksaan sandi login; hanya `active` memperoleh sesi (PRD 2.2, 4.2). */
const LOGIN_PASSWORD_STATES: readonly AccountStatus[] = [
  "active",
  "pending_otp",
  "disabled",
  "deletion_pending",
];

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

/**
 * Alumni: registrasi, OTP aktivasi, login, rotasi refresh, logout (F-01, F-02). Pemeriksaan sandi + batas kegagalan
 * (PasswordVerifier) dan penerbitan sesi (SessionIssuer) milik core, dipakai bersama modul admin-auth.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly passwords: PasswordVerifier,
    private readonly sessionIssuer: SessionIssuer,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly membership: MembershipKernel,
    private readonly realtime: RealtimeService,
    private readonly settings: SettingsService,
  ) {}

  private now() {
    return this.clock.now();
  }

  // ------------------------------------------------------------------ OTP

  private toChallenge(row: OtpRow, email: string): OtpChallenge {
    return {
      challenge_id: row.id,
      purpose: row.purpose,
      email_masked: maskEmail(email),
      expires_at: row.expiresAt.toISOString(),
      resend_available_at: row.resendAvailableAt.toISOString(),
      attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts),
      // Label "Sisa percobaan n dari 5" (prototype screen_1_otp, PRD 2.5).
      max_attempts: OTP_MAX_ATTEMPTS,
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

  /**
   * Challenge aktif (belum dipakai/diganti/kedaluwarsa) terbaru untuk akun dan salah satu tujuan. Challenge aktivasi
   * dicari pada kedua tujuan slot aktivasi (signup dan email_change).
   */
  private async activeChallenge(db: DbOrTx, userId: string, purposes: readonly OtpPurpose[], now: Date) {
    return db.query.otpCodes.findFirst({
      where: and(
        eq(otpCodes.userId, userId),
        inArray(otpCodes.purpose, [...purposes]),
        isNull(otpCodes.consumedAt),
        isNull(otpCodes.supersededAt),
        gt(otpCodes.expiresAt, now),
      ),
      orderBy: desc(otpCodes.createdAt),
    });
  }

  /**
   * Membuat challenge baru dan membatalkan challenge lain untuk tujuan yang sama (PRD 2.5); untuk challenge aktivasi
   * kedua tujuan slot aktivasi dibatalkan bersama (kontrak C1). Pemanggil WAJIB sudah mengunci baris users (FOR NO KEY
   * UPDATE) atau baru menyisipkannya di transaksi yang sama, sehingga penerbit bersamaan berurutan dan tidak bentrok
   * pada otp_codes_active_key. Kuota kirim dikonsumsi di sini, sebelum commit.
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
          inArray(otpCodes.purpose, isActivation(purpose) ? [...ACTIVATION_PURPOSES] : [purpose]),
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
        // Aktivasi: challenge terikat hash sandi saat dibuat (anti pre-account hijacking); sandi berubah → 410.
        binding: isActivation(purpose) ? sha256(user.passwordHash) : null,
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
      // Akun tidak lagi pada keadaan yang sesuai tujuan (mis. sudah aktif untuk signup) → 410 (kontrak resendOtp).
      if (!locked || !PURPOSE_ACCOUNT_STATES[purpose].includes(locked.status))
        throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang atau masuk kembali.");
      if (replacing) {
        const [current] = await tx
          .select({ consumedAt: otpCodes.consumedAt, supersededAt: otpCodes.supersededAt })
          .from(otpCodes)
          .where(eq(otpCodes.id, replacing));
        if (!current || current.consumedAt || current.supersededAt)
          throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
      }
      const created = await this.createChallenge(
        tx,
        { id: locked.id, email: locked.email, passwordHash: locked.passwordHash },
        purpose,
        now,
      );
      // Email dari baris terkunci: koreksi email bersamaan tidak membuat kode terkirim ke alamat lama.
      return { ...created, email: locked.email };
    });
    await this.mailer.sendOtp(issued.email, issued.code, purpose);
    return this.toChallenge(issued.row, issued.email);
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
   * Persetujuan (F-01): `accept_policy_version` dibandingkan dengan versi persetujuan yang disusun ulang dari
   * app_settings.legal SEBELUM email diperiksa, lalu sekali lagi di dalam transaksi dengan baris pengaturan dikunci
   * FOR SHARE; berbeda atau dokumen belum terbit → 409 VERSION_CONFLICT dengan `current` LegalConsentVersions.
   * Sebelum bcrypt pertama, satu jatah anggaran registrasi per IP dicadangkan atomik (429 bila habis), sehingga
   * permintaan anonim tidak dapat menghabiskan CPU tanpa batas (PRD 2.5, 5.1).
   */
  async register(input: RegisterInput, attempt = 0): Promise<OtpChallenge> {
    await this.assertConsent(this.db, input.accept_policy_version, false);
    const email = normalizeEmail(input.email);
    const existing = await this.passwords.findAccount(this.db, email, "alumni");
    if (existing && existing.status !== "pending_otp") throw emailTaken();
    if (attempt === 0) await this.consumeRegisterBudget();
    const samePassword = existing ? await bcrypt.compare(input.password, existing.passwordHash) : false;
    const newHash = samePassword ? null : await bcrypt.hash(input.password, this.env.BCRYPT_COST);
    const now = this.now();
    const policy = { policyVersion: input.accept_policy_version, policyAcceptedAt: now, updatedAt: now };

    try {
      const outcome = await this.db.transaction(async (tx): Promise<{ row: OtpRow; code: string | null }> => {
        // Versi yang disimpan di users.policy_version adalah versi terkini saat transaksi ini (F-01).
        await this.assertConsent(tx, input.accept_policy_version, true);
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
        const active = await this.activeChallenge(tx, locked.id, ACTIVATION_PURPOSES, now);
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

  /** Anggaran registrasi per IP (lihat REGISTER_ATTEMPTS_PER_IP_PER_HOUR), dicadangkan sebelum bcrypt. */
  private async consumeRegisterBudget(): Promise<void> {
    const ip = tryCtx()?.ip;
    if (!ip) return;
    await this.limits.consumeOrThrow(
      `register-ip:${ip}`,
      REGISTER_ATTEMPTS_PER_IP_PER_HOUR,
      HOUR_MS,
      "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.",
    );
  }

  /**
   * Persetujuan privasi + ketentuan (F-01, kontrak register): nilai klien hanya diterima bila sama persis dengan
   * `LegalConsentVersions.policy_version` terkini. `lock` = FOR SHARE pada baris app_settings legal (di dalam
   * transaksi) agar versi tidak berubah sampai commit.
   */
  private async assertConsent(db: DbOrTx, accepted: string, lock: boolean): Promise<void> {
    const { value } = await this.settings.getEntry("legal", { tx: db, lock });
    const consent = legalConsentVersions(value);
    if (consent.policy_version !== null && consent.policy_version === accepted) return;
    throw new AppException(
      409,
      "VERSION_CONFLICT",
      consent.policy_version === null
        ? "Pendaftaran belum dibuka. Coba lagi nanti."
        : "Kebijakan privasi atau ketentuan layanan telah diperbarui. Baca dan setujui versi terbaru.",
      { current: consent },
    );
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
   * Verifikasi OTP aktivasi (PRD 2.5, AC F01-2, F01-3): satu percobaan dicadangkan secara atomik SEBELUM kode
   * dibandingkan (`attempts < 5` dalam predikat UPDATE), sehingga permintaan paralel tidak dapat mencoba lebih dari 5
   * kode per challenge dan tidak pernah melanggar CHECK otp_codes_attempts_chk. Hanya challenge `signup` dan
   * `email_change`; tujuan lain (pemulihan sandi, hapus akun) tidak disentuh dan ditolak 410 seperti challenge yang
   * tidak dikenal (kontrak verifyOtp). Batas kegagalan per IP juga dicadangkan atomik SEBELUM kode dibandingkan
   * (jatah dikembalikan bila kode benar atau challenge tidak dapat dicoba), sehingga tebakan paralel lintas banyak
   * challenge tidak melewati batas (PRD 2.5, D1).
   */
  async verifyOtp(challengeId: string, code: string, deviceName: string | undefined) {
    const now = this.now();
    const ip = tryCtx()?.ip ?? null;
    const ipSlot = ip
      ? await this.limits.reserveOrThrow(
          `otp-verify-ip:${ip}`,
          OTP_VERIFY_FAILS_PER_IP,
          LOGIN_WINDOW_MS,
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
            inArray(otpCodes.purpose, [...ACTIVATION_PURPOSES]),
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
      // Tidak ada kode yang dinilai: bukan kegagalan tebakan.
      await ipSlot?.release();
      throw otpExpired();
    }

    if (!safeEqualHex(reserved.codeHmac, otpHmac(this.env.OTP_HMAC_SECRET, reserved.id, code))) {
      // Kode salah: jatah IP tetap tercatat sebagai kegagalan.
      const left = OTP_MAX_ATTEMPTS - reserved.attempts;
      if (left <= 0) throw otpExpired();
      throw new AppException(400, "VALIDATION_ERROR", `Kode salah. Sisa percobaan ${left}.`, {
        fieldErrors: { code: [`Kode salah. Sisa percobaan ${left}.`] },
      });
    }

    await ipSlot?.release();
    return this.completeActivation(reserved, deviceName);
  }

  /**
   * OTP aktivasi benar: dalam SATU transaksi dengan baris users terkunci, challenge dikonsumsi dengan seluruh predikat
   * (belum dipakai/diganti/kedaluwarsa), binding sandi diperiksa ulang terhadap hash terkunci, akun pending_otp
   * menjadi active, nomor anggota dialokasikan sekali, audit, dan sesi diterbitkan (AC F01-2, F05-1). Registrasi
   * ulang bersamaan tidak dapat mengaktifkan akun dengan sandi penyerang.
   */
  private async completeActivation(challenge: OtpRow, deviceName: string | undefined) {
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
      // Nomor AA.SS.JK.N dialokasikan sekali oleh MembershipKernel (nextval di transaksi yang sama, AC F05-1).
      const allocated = await this.membership.allocateMemberNumber(tx, user.id);
      await this.audit.write(tx, {
        actor: { kind: "alumni", userId: user.id, adminId: null, adminRole: null },
        action: "account.activated",
        entityType: "user",
        entityId: user.id,
        after: { member_number: allocated },
      });
      const issued = await this.sessionIssuer.issue(tx, {
        userId: user.id,
        audience: "mobile",
        mfaLevel: 1,
        deviceName,
      });
      return { session: issued.pair };
    });
  }

  /**
   * Kirim ulang (PRD 2.5, AC F01-3): challenge baru bertujuan sama menggantikan yang lama secara atomik. 410 bila
   * challenge sudah dipakai/diganti/tidak dikenal, sandi akun berubah sejak challenge aktivasi dibuat, atau akun tidak
   * lagi pada keadaan yang sesuai tujuan; 429 sebelum `resend_available_at` atau bila batas kirim habis.
   */
  async resendOtp(challengeId: string): Promise<OtpChallenge> {
    const now = this.now();
    const challenge = await this.db.query.otpCodes.findFirst({ where: eq(otpCodes.id, challengeId) });
    if (!challenge || challenge.consumedAt) throw otpExpired("Mulai ulang pendaftaran atau masuk kembali.");
    if (challenge.supersededAt) throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    const user = await this.db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (!user || !PURPOSE_ACCOUNT_STATES[challenge.purpose].includes(user.status))
      throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang atau masuk kembali.");
    if (isActivation(challenge.purpose) && challenge.binding !== sha256(user.passwordHash))
      throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    if (challenge.resendAvailableAt > now) {
      const wait = Math.ceil((challenge.resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
        retryAfterSeconds: wait,
      });
    }
    return this.issueOtp(user, challenge.purpose, challenge.id);
  }

  // ------------------------------------------------------------------ F-02 Login dan sesi

  /**
   * Login alumni (F-02, AC F02-1; kontrak login). Pemeriksaan sandi lewat PasswordVerifier (batas kegagalan per email
   * dan IP dicadangkan atomik sebelum bcrypt, PRD 2.5/D1; sandi > 72 byte ditolak; waktu respons setara untuk email
   * tidak terdaftar). Semua akun alumni yang belum `deleted` lolos pemeriksaan sandi. Sandi benar, lalu menurut
   * users.status (PRD 2.2, 4.2):
   * - active → `home` + sesi mobile;
   * - pending_otp → `verify_otp` + challenge aktivasi (yang masih aktif dipakai ulang agar tidak memakan batas kirim;
   *   selain itu satu challenge baru bertujuan sama dengan challenge aktivasi terakhir, slot signup/email_change);
   * - deletion_pending → `deletion_pending` + status permintaan penghapusan, tanpa sesi (F-14);
   * - disabled → `account_disabled` tanpa sesi (pemulihan hanya lewat pengurus).
   */
  async login(emailRaw: string, password: string, deviceName: string | undefined): Promise<LoginResponse> {
    const user = await this.passwords.verify(emailRaw, password, "alumni", (account) =>
      LOGIN_PASSWORD_STATES.includes(account.status),
    );
    const now = this.now();
    switch (user.status) {
      case "pending_otp":
        return { next: "verify_otp", challenge: await this.activationChallengeFor(user, now) };
      case "deletion_pending": {
        const deletion = await this.latestDeletionOf(user.id);
        return deletion ? { next: "deletion_pending", deletion } : { next: "deletion_pending" };
      }
      case "disabled":
        return { next: "account_disabled" };
      case "active":
        break;
      default:
        // `deleted` tidak pernah lolos findAccount; pengaman bila status baru ditambahkan.
        throw unauthenticated("Email atau password salah.");
    }
    const issued = await this.db.transaction(async (tx) => {
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      return this.sessionIssuer.issue(tx, { userId: user.id, audience: "mobile", mfaLevel: 1, deviceName });
    });
    return { next: "home", session: issued.pair };
  }

  /** Challenge aktivasi untuk login akun pending_otp (kontrak login, AC F01-3). */
  private async activationChallengeFor(
    user: { id: string; email: string; passwordHash: string },
    now: Date,
  ): Promise<OtpChallenge> {
    const active = await this.activeChallenge(this.db, user.id, ACTIVATION_PURPOSES, now);
    if (active && active.binding === sha256(user.passwordHash) && active.attempts < OTP_MAX_ATTEMPTS)
      return this.toChallenge(active, user.email);
    // Tujuan sama dengan challenge aktivasi terakhir: email_change bila email pernah dikoreksi, selain itu signup.
    const [last] = await this.db
      .select({ purpose: otpCodes.purpose })
      .from(otpCodes)
      .where(and(eq(otpCodes.userId, user.id), inArray(otpCodes.purpose, [...ACTIVATION_PURPOSES])))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);
    return this.issueOtp(user, last?.purpose === "email_change" ? "email_change" : "signup");
  }

  /** Status permintaan penghapusan terbaru tanpa data pribadi (AC F14-1) untuk respons login deletion_pending. */
  private async latestDeletionOf(userId: string): Promise<AccountDeletion | null> {
    const [row] = await this.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, userId))
      .orderBy(desc(accountDeletions.requestedAt))
      .limit(1);
    if (!row) return null;
    return {
      request_number: row.requestNumber,
      status: row.status as AccountDeletion["status"],
      source: row.source as AccountDeletion["source"],
      requested_at: row.requestedAt.toISOString(),
      estimated_completion_at: row.deadlineAt.toISOString(),
      completed_at: row.completedAt?.toISOString() ?? null,
    };
  }

  /**
   * Rotasi refresh token (AC F02-3; kontrak refreshSession). Hanya token yang SUDAH DIROTASI (`replaced_by` terisi)
   * lalu dipakai lagi yang dianggap pencurian: seluruh keluarga dicabut dan kejadian keamanan diaudit. Token yang
   * dicabut tanpa rotasi (logout, idle admin, pencabutan sesi, logout semua) cukup ditolak 401 tanpa kejadian keamanan,
   * sehingga tab admin kedua atau pengulangan klien setelah idle tidak mencemari jejak audit F-17.
   * Refresh admin tidak memperpanjang aktivitas; sesi admin idle 30 menit tidak bisa diperbarui dan seluruh keluarganya
   * dicabut (AC F02-5).
   */
  async refresh(refreshToken: string, expectedAudience: SessionAudience): Promise<IssuedSession> {
    const now = this.now();
    const hash = sha256(refreshToken);
    const unauth = unauthenticated();
    const current = await this.db.query.sessions.findFirst({ where: eq(sessions.refreshHash, hash) });
    if (!current || current.audience !== expectedAudience) throw unauth;
    if (current.replacedBy) {
      await this.revokeFamilyOnReuse(current);
      throw unauth;
    }
    if (current.revokedAt || current.expiresAt <= now) throw unauth;
    if (current.audience === "admin" && now.getTime() - current.lastActivityAt.getTime() > ADMIN_IDLE_MS) {
      await this.db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, current.familyId), isNull(sessions.revokedAt)));
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
      const issued = await this.sessionIssuer.issue(tx, {
        userId: current.userId,
        audience: current.audience as SessionAudience,
        mfaLevel: current.mfaLevel,
        deviceName: current.deviceName ?? undefined,
        familyId: current.familyId,
      });
      const rotated = await tx
        .update(sessions)
        .set({ revokedAt: now, replacedBy: issued.sessionId })
        .where(and(eq(sessions.id, current.id), isNull(sessions.replacedBy), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      // Dua refresh bersamaan dengan token yang sama (klien ganda yang sah): yang kalah ditolak tanpa mencabut
      // keluarga; pemakaian ulang SETELAH rotasi tetap mencabut seluruh keluarga (cabang di atas).
      if (rotated.length === 0) throw unauth;
      // Keadaan keluarga sesi dibawa ke baris baru (kontrak C1 "Keluarga sesi"): waktu aktivitas terakhir (refresh
      // bukan aktivitas pengguna, AC F02-5), waktu reautentikasi (X-Reauth-Token yang masih berlaku tetap diterima),
      // serta platform/versi aplikasi bila header X-App-* tidak dikirim.
      const context = tryCtx();
      await tx
        .update(sessions)
        .set({
          lastActivityAt: current.lastActivityAt,
          reauthenticatedAt: current.reauthenticatedAt,
          ...(current.audience === "mobile"
            ? {
                platform: context?.appPlatform ?? current.platform,
                appVersion: context?.appVersion ?? current.appVersion,
              }
            : {}),
        })
        .where(eq(sessions.id, issued.sessionId));
      // Ikatan token push pindah ke baris sesi baru dalam transaksi rotasi (kontrak C7 registerDevice).
      await moveDeviceTokensToSession(tx, current.id, issued.sessionId, now);
      return issued;
    });
  }

  /**
   * Refresh token yang sudah DIROTASI dipakai lagi: indikasi token dicuri (AC F02-3). Seluruh keluarga sesi dicabut dan
   * kejadian keamanan diaudit dalam transaksi yang sama (F-17). Aktor = pemanggil anonim (pemegang token tidak
   * terautentikasi); entitas = pemilik akun.
   */
  private async revokeFamilyOnReuse(session: { userId: string; familyId: string; audience: string }) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      // Token push keluarga yang dicabut berhenti menerima notifikasi (AC F13-5).
      await revokeDeviceTokens(tx, { userId: session.userId, familyIds: [session.familyId] }, now);
      await this.audit.write(tx, {
        action: "session.refresh_reuse_detected",
        entityType: "user",
        entityId: session.userId,
        after: { audience: session.audience, sessions_revoked: revoked.length },
      });
    });
    // Setelah commit: socket keluarga sesi yang dicabut diputus (AC F02-3, F02-6).
    this.realtime.disconnectSession(session.familyId, "refresh_reuse_detected");
  }

  /**
   * Logout (F-02, AC F13-5): keluarga sesi pemanggil dicabut dan token push perangkat sesi itu dinonaktifkan dalam satu
   * transaksi (pengiriman push yang belum terkirim dibatalkan), lalu socket keluarga itu diputus setelah commit.
   */
  async logout(auth: Pick<AuthContext, "userId" | "familyId">) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(sessions.familyId, auth.familyId),
            eq(sessions.userId, auth.userId),
            isNull(sessions.revokedAt),
          ),
        );
      await revokeDeviceTokens(tx, { userId: auth.userId, familyIds: [auth.familyId] }, now);
    });
    // Socket realtime keluarga sesi ini menerima session.revoked lalu diputus (ARCHITECTURE §4.9).
    this.realtime.disconnectSession(auth.familyId, "logout");
  }

  /**
   * Keluar semua perangkat: semua sesi dicabut dan session_version naik sehingga access token lama ditolak (AC F02-6);
   * token push semua perangkat berhenti menerima notifikasi akun ini dalam transaksi yang sama (AC F13-5).
   */
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
      await revokeDeviceTokens(tx, { userId }, now);
      await this.audit.write(tx, {
        action: "session.logout_all",
        entityType: "user",
        entityId: userId,
        after: { sessions_revoked: revoked.length },
      });
    });
    // Setelah commit: semua socket pengguna menerima session.revoked lalu diputus (AC F02-6).
    this.realtime.disconnectUser(userId, "logout_all");
  }
}
