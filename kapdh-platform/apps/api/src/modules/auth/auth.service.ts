import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { accountDeletions, admins, alumni, otpCodes, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { tryCtx } from "../../core/context/request-context.js";
import { isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, rateLimited, unauthenticated } from "../../core/errors/app-exception.js";
import type { AuthContext, SessionAudience } from "../../core/guards/auth-context.js";
import { ADMIN_IDLE_MS } from "../../core/guards/auth.guard.js";
import { sha256 } from "../../core/identity/crypto.js";
import { maskEmail, normalizeEmail } from "../../core/identity/email.js";
import {
  type LoginAttempt,
  LOGIN_WINDOW_MS,
  PasswordVerifier,
} from "../../core/identity/password-verifier.js";
import { type IssuedSession, SessionIssuer } from "../../core/identity/session-issuer.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import {
  moveDeviceTokensToSession,
  revokeDeviceTokens,
} from "../../core/notifications-kernel/device-tokens.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { legalConsentVersions } from "../../core/settings/legal-consent.js";
import { SettingsService } from "../../core/settings/settings.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import {
  ACTIVATION_PURPOSES,
  isActivation,
  OTP_MAX_ATTEMPTS,
  OtpChallengeService,
  type OtpRow,
  otpExpired,
} from "./otp-challenge.service.js";
import { notifySecurityEvent } from "./security-notices.js";
import { lockOwnerForRevocation, lockOwnerForRotation } from "./session-locks.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
type LoginResponse = components["schemas"]["LoginResponse"];
type AccountDeletion = components["schemas"]["AccountDeletion"];

const HOUR_MS = 3600_000;
/**
 * Anggaran percobaan registrasi per IP per jam yang dicadangkan SEBELUM bcrypt (PRD 2.5, D1; PRD 5.1): kuota kirim
 * OTP baru diperiksa di dalam transaksi sesudah hash dihitung, sehingga tanpa anggaran ini permintaan yang pasti
 * ditolak 429 tetap menghabiskan CPU bcrypt tanpa batas. Dua kali batas kirim OTP per IP agar koreksi data dan
 * pengulangan di satu Wi-Fi acara reuni tetap lolos.
 */
const REGISTER_ATTEMPTS_PER_IP_PER_HOUR = 120;
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

export interface EmailCorrectionInput {
  challenge_id: string;
  password: string;
  new_email: string;
}

const emailTaken = () =>
  new AppException(
    409,
    "VALIDATION_ERROR",
    "Email sudah terdaftar. Silakan masuk atau gunakan lupa password.",
    {
      fieldErrors: { email: ["Email sudah terdaftar"] },
    },
  );

const newEmailTaken = () =>
  new AppException(409, "VALIDATION_ERROR", "Email baru sudah terdaftar. Gunakan email lain atau masuk.", {
    fieldErrors: { new_email: ["Email sudah terdaftar"] },
  });

const wrongPasswordField = () =>
  new AppException(400, "VALIDATION_ERROR", "Sandi salah.", { fieldErrors: { password: ["Sandi salah."] } });

/** Penanda internal: rotasi refresh kalah dari rotasi bersamaan dengan token yang sama (lihat {@link AuthService.refresh}). */
class RotationLost extends Error {
  constructor() {
    super("rotasi refresh kalah");
  }
}

/**
 * Alumni: registrasi, OTP aktivasi, koreksi email, login, rotasi refresh, logout (F-01, F-02). Siklus challenge OTP
 * di OtpChallengeService; pemeriksaan sandi + batas kegagalan (PasswordVerifier) dan penerbitan sesi (SessionIssuer)
 * milik core, dipakai bersama modul admin-auth.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly otp: OtpChallengeService,
    private readonly passwords: PasswordVerifier,
    private readonly sessionIssuer: SessionIssuer,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly membership: MembershipKernel,
    private readonly realtime: RealtimeService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
  ) {}

  private now() {
    return this.clock.now();
  }

  // ------------------------------------------------------------------ F-01 Registrasi

  /**
   * Registrasi (F-01, AC F01-1, F01-4). Satu transaksi dengan baris users terkunci:
   * - email aktif → 409; email pending_otp → akun yang sama dilanjutkan (tanpa akun ganda),
   * - sandi sama dan challenge masih berlaku → challenge itu dikembalikan (permintaan ganda/ulang tidak mengirim kode
   *   baru dan tidak membatalkan kode yang sudah diterima), profil terbaru tetap disimpan,
   * - selain itu hanya setelah cooldown kirim ulang 60 detik (PRD 2.5) dan kuota kirim per email/IP dipakai SEBELUM
   *   penulisan apa pun; lalu sandi, profil, dan challenge baru (binding baru membatalkan challenge lama) ditulis atomik
   *   dengan predikat `status = 'pending_otp'`,
   * - registrasi baru bersamaan untuk email yang sama: indeks unik users_kind_email_key menjamin satu akun; yang
   *   kalah mengulang dan melanjutkan akun pemenang.
   * Persetujuan (F-01): `accept_policy_version` dibandingkan dengan versi persetujuan yang disusun ulang dari
   * app_settings.legal SEBELUM email diperiksa, lalu sekali lagi di dalam transaksi dengan baris pengaturan dikunci
   * FOR SHARE; berbeda atau dokumen belum terbit → 409 VERSION_CONFLICT dengan `current` LegalConsentVersions.
   * Sebelum keberadaan email dinilai (dan sebelum bcrypt pertama), satu jatah anggaran registrasi per IP dicadangkan
   * atomik (429 bila habis), sehingga permintaan anonim tidak dapat menghabiskan CPU tanpa batas dan jawaban 409 email
   * terdaftar tidak dapat dipakai sebagai oracle tanpa batas (PRD 2.5, 5.1); untuk akun pending_otp yang sudah ada,
   * perbandingan sandi juga memakai jatah batas kegagalan login (lihat {@link beginReRegisterAttempt}). Idempotency-Key
   * ditangani interceptor @Idempotent (PRD 4.3).
   */
  async register(input: RegisterInput, attempt = 0): Promise<OtpChallenge> {
    await this.assertConsent(this.db, input.accept_policy_version, false);
    const email = normalizeEmail(input.email);
    // Anggaran per IP dicadangkan SEBELUM keberadaan email dinilai: jawaban 409 "Email sudah terdaftar" ikut memakai
    // anggaran yang sama sehingga registrasi bukan oracle email terdaftar tanpa batas (PRD 2.5, ASVS 2.2.1).
    if (attempt === 0) await this.consumeRegisterBudget();
    const existing = await this.passwords.findAccount(this.db, email, "alumni");
    if (existing && existing.status !== "pending_otp") throw emailTaken();
    // Registrasi ulang akun pending_otp MENILAI sandi tersimpan (challenge dipakai ulang hanya bila sandi sama), jadi
    // respons membedakan sandi benar dan salah. Agar tidak menjadi oracle sandi di luar batas PRD 2.5, satu jatah
    // kegagalan login `login:<email>` (+ IP) dicadangkan atomik SEBELUM bcrypt: sandi sama → penghitung direset;
    // sandi berbeda (data baru yang sah maupun tebakan) → jatah tetap tercatat; habis → 429 tanpa penulisan.
    const guess = existing ? await this.beginReRegisterAttempt(email) : null;
    // Selalu satu bcrypt.compare (hash tiruan bila akun belum ada) dan satu bcrypt.hash dengan BCRYPT_COST, sehingga
    // waktu respons 201 tidak membedakan email baru dari akun pending_otp yang sudah ada (PRD 2.5).
    let samePassword: boolean;
    try {
      samePassword = await this.passwords.comparePassword(input.password, existing?.passwordHash ?? null);
    } catch (error) {
      await guess?.cancel().catch(() => undefined);
      throw error;
    }
    if (samePassword) await guess?.succeeded();
    const newHash = await bcrypt.hash(input.password, this.env.BCRYPT_COST);
    const now = this.now();
    const policy = { policyVersion: input.accept_policy_version, policyAcceptedAt: now, updatedAt: now };

    try {
      const outcome = await this.db.transaction(async (tx): Promise<{ row: OtpRow; code: string | null }> => {
        // Versi yang disimpan di users.policy_version adalah versi terkini saat transaksi ini (F-01).
        await this.assertConsent(tx, input.accept_policy_version, true);
        if (!existing) {
          // Kuota kirim lebih dulu: tidak ada penulisan bila 429 (PRD 2.5).
          await this.otp.consumeSendQuota(this.otp.emailKey(email));
          const id = uuidv7();
          await tx.insert(users).values({
            id,
            email,
            passwordHash: newHash,
            status: "pending_otp",
            kind: "alumni",
            ...policy,
            createdAt: now,
          });
          await tx.insert(alumni).values({ userId: id, ...this.alumniProfile(input, now), createdAt: now });
          return this.otp.createChallenge(tx, { id, passwordHash: newHash }, "signup", now);
        }

        const locked = await this.otp.lockUser(tx, existing.id);
        if (!locked || locked.kind !== "alumni" || locked.status !== "pending_otp") throw emailTaken();
        // Hash berubah sejak dibaca (registrasi ulang bersamaan): bandingkan ulang terhadap hash terkunci.
        const same =
          locked.passwordHash === existing.passwordHash
            ? samePassword
            : await this.passwords.comparePassword(input.password, locked.passwordHash);
        const active = await this.otp.activeChallenge(tx, locked.id, ACTIVATION_PURPOSES, now);
        const reusable =
          same &&
          active !== undefined &&
          active.binding === sha256(locked.passwordHash) &&
          active.attempts < OTP_MAX_ATTEMPTS;
        if (!reusable) {
          if (active && active.resendAvailableAt > now) {
            const wait = Math.ceil((active.resendAvailableAt.getTime() - now.getTime()) / 1000);
            throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
              retryAfterSeconds: wait,
            });
          }
          await this.otp.consumeSendQuota(this.otp.emailKey(locked.email));
        }
        await tx.update(alumni).set(this.alumniProfile(input, now)).where(eq(alumni.userId, locked.id));
        // Sandi sama: hash lama dipertahankan agar binding challenge aktif tetap berlaku.
        const passwordHash = same ? locked.passwordHash : newHash;
        const updated = await tx
          .update(users)
          .set({ ...policy, passwordHash })
          .where(and(eq(users.id, locked.id), eq(users.status, "pending_otp")))
          .returning({ id: users.id });
        if (updated.length === 0) throw emailTaken();
        if (reusable) return { row: active, code: null };
        return this.otp.createChallenge(tx, { id: locked.id, passwordHash }, "signup", now);
      });
      if (outcome.code) await this.otp.deliver(email, outcome.code, "signup", outcome.row.id);
      return this.otp.toChallenge(outcome.row, maskEmail(email));
    } catch (e) {
      // Registrasi baru bersamaan: pemenang membuat akun; yang kalah melanjutkan akun itu (AC F01-4).
      if (!existing && attempt === 0 && isUniqueViolation(e, "users_kind_email_key"))
        return this.register(input, 1);
      throw e;
    }
  }

  /**
   * Jatah kegagalan sandi untuk registrasi ulang akun pending_otp (PRD 2.5: 10 kegagalan per email dalam 15 menit,
   * dibagi dengan login, koreksi email dan ganti sandi). Pesan 429 khusus pendaftaran ulang.
   */
  private async beginReRegisterAttempt(email: string): Promise<LoginAttempt> {
    try {
      return await this.passwords.beginAttempt(email);
    } catch (error) {
      if (error instanceof AppException && error.code === "RATE_LIMITED")
        throw rateLimited(
          error.extra.retryAfterSeconds ?? LOGIN_WINDOW_MS / 1000,
          "Terlalu banyak percobaan pendaftaran ulang untuk email ini. Coba lagi nanti.",
        );
      throw error;
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
   * Verifikasi OTP aktivasi (PRD 2.5, AC F01-2, F01-3): batas kegagalan per IP dan satu percobaan challenge
   * dicadangkan atomik SEBELUM kode dibandingkan (OtpChallengeService.verifyCode), sehingga permintaan paralel tidak
   * dapat mencoba lebih dari 5 kode per challenge dan tidak pernah berakhir 500. Hanya challenge `signup` dan
   * `email_change`; tujuan lain ditolak 410 tanpa memakai jatah percobaannya (kontrak verifyOtp).
   */
  async verifyOtp(challengeId: string, code: string, deviceName: string | undefined) {
    const matched = await this.otp.verifyCode(challengeId, code, ACTIVATION_PURPOSES);
    return this.completeActivation(matched, deviceName);
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
      const user = await this.otp.lockUser(tx, challenge.userId);
      if (!user || user.status !== "pending_otp" || challenge.binding !== sha256(user.passwordHash))
        throw otpExpired();
      if (!(await this.otp.consume(tx, challenge, now))) throw otpExpired();
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
        after: { member_number: allocated, via: challenge.purpose },
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

  /** Kirim ulang untuk semua tujuan (kontrak resendOtp; PRD 2.5, AC F01-3). */
  resendOtp(challengeId: string): Promise<OtpChallenge> {
    return this.otp.resend(challengeId);
  }

  /** Baca keadaan challenge tanpa efek samping (kontrak getOtpChallengeStatus; AC F16-4, F01-3). */
  otpStatus(challengeId: string): Promise<OtpChallenge> {
    return this.otp.status(challengeId);
  }

  /**
   * Koreksi email akun pending_otp lewat alur terverifikasi (PRD 2.2, F-01; kontrak correctPendingEmail). Pemilik
   * membuktikan kepemilikan dengan challenge aktivasi miliknya yang belum dikonsumsi (boleh kedaluwarsa) dan sandi akun;
   * kegagalan sandi dicadangkan ke batas kegagalan login SEBELUM bcrypt (PRD 2.5). Dalam satu transaksi dengan baris
   * users terkunci: email diganti (unik per jenis identitas), slot aktivasi lama dibatalkan sehingga email lama tidak
   * dapat lagi mengaktifkan akun, challenge `email_change` baru dibuat untuk email baru (kuota kirim email baru dipakai
   * sebelum penulisan), dan perubahan diaudit tanpa kode. Akun baru aktif setelah kode email baru diverifikasi.
   */
  async correctPendingEmail(input: EmailCorrectionInput): Promise<OtpChallenge> {
    const challenge = await this.db.query.otpCodes.findFirst({ where: eq(otpCodes.id, input.challenge_id) });
    if (!challenge || !isActivation(challenge.purpose) || challenge.consumedAt)
      throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang pendaftaran atau masuk kembali.");
    const user = await this.db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (!user || user.kind !== "alumni" || user.status !== "pending_otp")
      throw otpExpired("Akun sudah terverifikasi. Silakan masuk.");

    const attempt = await this.passwords.beginAttempt(user.email);
    let matches: boolean;
    try {
      matches = await this.passwords.comparePassword(input.password, user.passwordHash);
    } catch (error) {
      await attempt.cancel().catch(() => undefined);
      throw error;
    }
    // Sandi salah: jatah kegagalan login tetap tercatat (kontrak: dihitung ke batas kegagalan login).
    if (!matches) throw wrongPasswordField();
    await attempt.succeeded();

    const newEmail = normalizeEmail(input.new_email);
    const now = this.now();
    let issued: { row: OtpRow; code: string; email: string };
    try {
      issued = await this.db.transaction(async (tx) => {
        const locked = await this.otp.lockUser(tx, user.id);
        if (!locked || locked.status !== "pending_otp")
          throw otpExpired("Akun sudah terverifikasi. Silakan masuk.");
        const [current] = await tx
          .select({ consumedAt: otpCodes.consumedAt })
          .from(otpCodes)
          .where(and(eq(otpCodes.id, challenge.id), eq(otpCodes.userId, locked.id)));
        if (!current || current.consumedAt)
          throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang pendaftaran atau masuk kembali.");
        // Sandi berganti bersamaan (registrasi ulang): bukti kepemilikan dinilai ulang terhadap hash terkunci.
        if (
          locked.passwordHash !== user.passwordHash &&
          !(await this.passwords.comparePassword(input.password, locked.passwordHash))
        )
          throw wrongPasswordField();
        if (newEmail === locked.email)
          throw new AppException(400, "VALIDATION_ERROR", "Email baru sama dengan email saat ini.", {
            fieldErrors: { new_email: ["Email baru sama dengan email saat ini"] },
          });
        // Kuota kirim OTP (per IP lalu per email baru) dipakai SEBELUM keberadaan email baru dinilai: jawaban 409
        // "Email baru sudah terdaftar" ikut terbatas, sehingga akun pending milik penyerang (sandinya diketahui) tidak
        // menjadi oracle email terdaftar tanpa batas (PRD 2.5).
        await this.otp.consumeSendQuota(this.otp.emailKey(newEmail));
        const taken = await this.passwords.findAccount(tx, newEmail, "alumni");
        if (taken && taken.id !== locked.id) throw newEmailTaken();
        const updated = await tx
          .update(users)
          .set({ email: newEmail, updatedAt: now })
          .where(and(eq(users.id, locked.id), eq(users.status, "pending_otp")))
          .returning({ id: users.id });
        if (updated.length === 0) throw otpExpired("Akun sudah terverifikasi. Silakan masuk.");
        // Membatalkan slot aktivasi (signup + email_change) lalu challenge email_change baru ke email baru.
        const created = await this.otp.createChallenge(
          tx,
          { id: locked.id, passwordHash: locked.passwordHash },
          "email_change",
          now,
        );
        await this.audit.write(tx, {
          actor: { kind: "alumni", userId: locked.id, adminId: null, adminRole: null },
          action: "account.email_corrected",
          entityType: "user",
          entityId: locked.id,
          before: { email_masked: maskEmail(locked.email) },
          after: { email_masked: maskEmail(newEmail) },
        });
        return { ...created, email: newEmail };
      });
    } catch (e) {
      // Email baru didaftarkan akun lain di antara pemeriksaan dan penulisan.
      if (isUniqueViolation(e, "users_kind_email_key")) throw newEmailTaken();
      throw e;
    }
    await this.otp.deliver(issued.email, issued.code, "email_change", issued.row.id);
    return this.otp.toChallenge(issued.row, maskEmail(issued.email));
  }

  // ------------------------------------------------------------------ F-02 Login dan sesi

  /**
   * Login alumni (F-02, AC F02-1; kontrak login). Pemeriksaan sandi lewat PasswordVerifier (batas kegagalan per email
   * dan IP dicadangkan atomik sebelum bcrypt, PRD 2.5/D1; sandi > 72 byte ditolak dengan 401 yang sama; hash tiruan
   * dengan BCRYPT_COST yang sama sehingga waktu respons email tidak terdaftar setara). Semua akun alumni yang belum
   * `deleted` lolos pemeriksaan sandi. Sandi benar, lalu menurut users.status (PRD 2.2, 4.2):
   * - active → `home` + sesi mobile;
   * - pending_otp → `verify_otp` + challenge aktivasi (yang masih aktif dipakai ulang agar tidak memakan batas kirim;
   *   selain itu satu challenge baru bertujuan sama dengan challenge aktivasi terakhir, slot signup/email_change);
   * - deletion_pending → `deletion_pending` + status permintaan penghapusan, tanpa sesi (F-14);
   * - disabled → `account_disabled` tanpa sesi (pemulihan hanya lewat pengurus).
   *
   * Penerbitan sesi menilai ulang kredensial DI BAWAH KUNCI baris users (AC F02-4, N-08): bcrypt berjalan di luar
   * transaksi, jadi reset/ganti sandi dapat commit di antaranya. UPDATE bersyarat `WHERE password_hash = <hash yang
   * dinilai> AND status = 'active'` menunggu kunci FOR UPDATE reset/ganti sandi lalu menilai ulang baris terbaru: sandi
   * sudah diganti → nol baris → 401 generik yang sama, tanpa sesi. Sebaliknya bila login commit lebih dulu, reset/ganti
   * sandi (yang mengunci users lebih dulu) melihat sesi baru itu dan ikut mencabutnya.
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
      const current = await tx
        .update(users)
        .set({ lastLoginAt: now })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.kind, "alumni"),
            eq(users.passwordHash, user.passwordHash),
            eq(users.status, "active"),
          ),
        )
        .returning({ id: users.id });
      // Sandi atau status berubah sejak bcrypt (reset/ganti sandi/penonaktifan bersamaan): kredensial tidak berlaku.
      if (current.length === 0) throw unauthenticated("Email atau password salah.");
      return this.sessionIssuer.issue(tx, { userId: user.id, audience: "mobile", mfaLevel: 1, deviceName });
    });
    return { next: "home", session: issued.pair };
  }

  /** Challenge aktivasi untuk login akun pending_otp (kontrak login, AC F01-3). */
  private async activationChallengeFor(
    user: { id: string; email: string; passwordHash: string },
    now: Date,
  ): Promise<OtpChallenge> {
    const active = await this.otp.activeChallenge(this.db, user.id, ACTIVATION_PURPOSES, now);
    if (active && active.binding === sha256(user.passwordHash) && active.attempts < OTP_MAX_ATTEMPTS)
      return this.otp.toChallenge(active, maskEmail(user.email));
    // Tujuan sama dengan challenge aktivasi terakhir: email_change bila email pernah dikoreksi, selain itu signup.
    const [last] = await this.db
      .select({ purpose: otpCodes.purpose })
      .from(otpCodes)
      .where(and(eq(otpCodes.userId, user.id), inArray(otpCodes.purpose, [...ACTIVATION_PURPOSES])))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);
    return this.otp.issueForAccount(user.id, last?.purpose === "email_change" ? "email_change" : "signup");
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
   * Rotasi refresh token (AC F02-3; kontrak refreshSession). Satu transaksi: baris sesi baru dalam keluarga yang sama,
   * lalu baris lama ditandai `revoked_at` + `replaced_by` dengan UPDATE bersyarat (`replaced_by IS NULL AND revoked_at
   * IS NULL`). Semantik pemakaian ganda (didokumentasikan di kontrak):
   * - Token yang SUDAH DIROTASI (`replaced_by` terisi) lalu dipakai lagi, berurutan maupun BERSAMAAN, adalah
   *   pemakaian ulang: seluruh keluarga dicabut (termasuk baris hasil rotasi pemenang), token push keluarga dicabut,
   *   socketnya diputus, dan kejadian keamanan diaudit. Pada dua refresh bersamaan dengan token yang sama, tepat satu
   *   rotasi berhasil; yang kalah melihat `replaced_by` terisi setelah menunggu kunci baris, sehingga pencuri yang
   *   berlomba dengan klien sah tidak pernah mempertahankan keluarga sesi. Klien sah mengoordinasikan satu refresh per
   *   perangkat/tab (PRD 5.2), jadi pemakaian ganda hanya terjadi pada klien rusak atau token dicuri.
   * - Token yang dicabut TANPA rotasi (logout, idle admin, pencabutan sesi, logout semua, reset sandi) cukup ditolak
   *   401 tanpa kejadian keamanan, sehingga tab admin kedua atau pengulangan klien setelah idle tidak mencemari audit.
   * Refresh admin tidak memperpanjang aktivitas; sesi admin idle 30 menit tidak bisa diperbarui dan seluruh keluarganya
   * dicabut (AC F02-5). Akun selain `active` (disabled, deletion_pending, deleted) dan admin nonaktif ditolak 401.
   *
   * Pencabutan yang berlomba dengan rotasi yang sedang berjalan (logout, logout semua, pencabutan sesi, deteksi
   * pemakaian ulang, reset/ganti sandi) diserialkan lewat kunci baris users (session-locks.ts): pencabutan selalu ikut
   * mencabut baris hasil rotasi, atau rotasi kalah dan menjawab 401.
   */
  async refresh(refreshToken: string, expectedAudience: SessionAudience): Promise<IssuedSession> {
    const now = this.now();
    const hash = sha256(refreshToken);
    const unauth = unauthenticated();
    const current = await this.db.query.sessions.findFirst({ where: eq(sessions.refreshHash, hash) });
    if (!current || current.audience !== expectedAudience) throw unauth;
    if (current.replacedBy) {
      await this.revokeFamilyOnReuse(current, false);
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
    try {
      return await this.db.transaction(async (tx) => {
        // Pernyataan PERTAMA: baris users pemilik FOR SHARE (session-locks.ts). Pencabutan sesi dan perubahan akun
        // bersamaan menunggu rotasi ini atau membuatnya gagal, sehingga baris hasil rotasi tidak pernah lolos dari
        // logout semua/pencabutan sesi/deteksi pemakaian ulang (AC F02-3, F02-6). Status dinilai di bawah kunci itu.
        const owner = await lockOwnerForRotation(tx, current.userId);
        if (
          !owner ||
          owner.status !== "active" ||
          owner.kind !== (expectedAudience === "admin" ? "admin" : "alumni")
        )
          throw unauth;
        if (expectedAudience === "admin") {
          const admin = await tx.query.admins.findFirst({ where: eq(admins.userId, current.userId) });
          if (admin?.status !== "active") throw unauth;
        }
        const issued = await this.sessionIssuer.issue(tx, {
          userId: current.userId,
          audience: current.audience as SessionAudience,
          mfaLevel: current.mfaLevel,
          deviceName: current.deviceName ?? undefined,
          familyId: current.familyId,
          // Umur absolut keluarga (PRD 5.2, N-08): baris baru mewarisi batas baris yang dirotasi.
          familyExpiresAt: current.expiresAt,
        });
        const rotated = await tx
          .update(sessions)
          .set({ revokedAt: now, replacedBy: issued.sessionId })
          .where(and(eq(sessions.id, current.id), isNull(sessions.replacedBy), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        if (rotated.length === 0) throw new RotationLost();
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
    } catch (error) {
      if (!(error instanceof RotationLost)) throw error;
      // Kalah dari rotasi bersamaan: token ini sudah dipakai → pemakaian ulang (AC F02-3). Dicabut tanpa rotasi
      // (logout/idle bersamaan) → 401 biasa.
      const [latest] = await this.db
        .select({ replacedBy: sessions.replacedBy })
        .from(sessions)
        .where(eq(sessions.id, current.id));
      if (latest?.replacedBy) await this.revokeFamilyOnReuse(current, true);
      throw unauth;
    }
  }

  /**
   * Refresh token yang sudah DIROTASI dipakai lagi: indikasi token dicuri (AC F02-3). Seluruh keluarga sesi dicabut dan
   * kejadian keamanan diaudit dalam transaksi yang sama (F-17). Aktor = pemanggil anonim (pemegang token tidak
   * terautentikasi); entitas = pemilik akun. `concurrent` = pemakaian ganda bersamaan (kalah rotasi).
   */
  private async revokeFamilyOnReuse(
    session: { userId: string; familyId: string; audience: string },
    concurrent: boolean,
  ) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      // Pernyataan pertama: kunci pemilik (session-locks.ts) — rotasi pencuri yang sedang berjalan di keluarga ini
      // selesai dulu, lalu baris hasil rotasinya ikut dicabut dan terhitung di audit.
      await lockOwnerForRevocation(tx, session.userId);
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
        after: { audience: session.audience, sessions_revoked: revoked.length, concurrent },
      });
      // Setelah commit: socket keluarga sesi yang dicabut diputus (AC F02-3, F02-6).
      this.realtime.disconnectSession(session.familyId, "refresh_reuse_detected");
    });
  }

  /**
   * Logout (F-02, AC F13-5): keluarga sesi pemanggil dicabut dan token push perangkat sesi itu dinonaktifkan dalam satu
   * transaksi (pengiriman push yang belum terkirim dibatalkan), lalu socket keluarga itu diputus setelah commit. Baris
   * users dikunci lebih dulu (session-locks.ts) agar rotasi refresh keluarga ini yang sedang berjalan ikut dicabut.
   */
  async logout(auth: Pick<AuthContext, "userId" | "familyId">) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await lockOwnerForRevocation(tx, auth.userId);
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
      // Socket realtime keluarga sesi ini menerima session.revoked lalu diputus setelah commit (ARCHITECTURE §4.9).
      this.realtime.disconnectSession(auth.familyId, "logout");
    });
  }

  /**
   * Keluar semua perangkat (AC F02-6): dalam satu transaksi semua sesi dicabut dan session_version naik sehingga
   * access token lama ditolak, token push semua perangkat berhenti menerima notifikasi akun ini (AC F13-5), kejadian
   * diaudit, dan alumni menerima notifikasi keamanan; setelah commit semua socket pengguna diputus. Pernyataan pertama
   * mengunci baris users FOR UPDATE (session-locks.ts): rotasi refresh atau login yang sedang berjalan di perangkat
   * lain selesai dulu dan sesinya ikut dicabut, atau menunggu lalu gagal; tidak ada perangkat yang tertinggal masuk.
   */
  async logoutAll(auth: Pick<AuthContext, "userId" | "audience">) {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await lockOwnerForRevocation(tx, auth.userId);
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
        .where(eq(users.id, auth.userId));
      await revokeDeviceTokens(tx, { userId: auth.userId }, now);
      await this.audit.write(tx, {
        action: "session.logout_all",
        entityType: "user",
        entityId: auth.userId,
        after: { sessions_revoked: revoked.length },
      });
      // Inbox/email/push hanya untuk identitas alumni (aplikasi anggota); admin cukup audit.
      if (auth.audience === "mobile")
        await notifySecurityEvent(this.notifications, tx, auth.userId, "logout_all", now);
      // Setelah commit: semua socket pengguna menerima session.revoked lalu diputus (AC F02-6).
      this.realtime.disconnectUser(auth.userId, "logout_all");
    });
  }
}
