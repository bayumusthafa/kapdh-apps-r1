import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { otpCodes, otpDecoys, users } from "@kapdh/database";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { Mailer, OtpPurpose } from "../../core/adapters/mailer.js";
import { tryCtx } from "../../core/context/request-context.js";
import { ADVISORY_LOCK_NAMESPACES, advisoryXactLockFor } from "../../core/db/locks.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException } from "../../core/errors/app-exception.js";
import { generateOtp, otpHmac, safeEqualHex, sha256 } from "../../core/identity/crypto.js";
import { maskEmail, normalizeEmail } from "../../core/identity/email.js";
import { otpEmailKey } from "../../core/identity/otp-quota.js";
import { LOGIN_WINDOW_MS } from "../../core/identity/password-verifier.js";
import { safeError } from "../../core/logging/safe-error.js";
import type { AccountStatus } from "../../core/membership/effective-status.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB, ENV, MAILER, ROOT_LOGGER } from "../../core/tokens.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];
export type OtpRow = typeof otpCodes.$inferSelect;
export type OtpDecoyRow = typeof otpDecoys.$inferSelect;
type UserRow = typeof users.$inferSelect;

const HOUR_MS = 3600_000;
/** PRD 2.5: kode berlaku 10 menit, kirim ulang paling cepat 60 detik, maksimal 5 percobaan. */
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_RESEND_MS = 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** PRD 2.5 (Usulan D1): 5 pengiriman OTP per jam per email, ditambah pembatasan IP. */
export const OTP_SENDS_PER_HOUR = 5;
/** Usulan D1: longgar agar pendaftaran massal di satu Wi-Fi acara reuni tidak terblokir. */
export const OTP_SENDS_PER_IP_PER_HOUR = 60;
/** Usulan D1: kegagalan verifikasi OTP per IP per 15 menit (menahan tebakan lintas banyak challenge). */
export const OTP_VERIFY_FAILS_PER_IP = 50;
/** Batas baca keadaan challenge per IP per 15 menit (kontrak getOtpChallengeStatus; terpisah dari batas kirim). */
export const OTP_STATUS_PER_IP = 60;
/**
 * Challenge (nyata maupun pengganti) yang lebih tua dari ini diperlakukan seperti tidak dikenal oleh status dan kirim
 * ulang (410), dan baris pengganti setua ini dibersihkan. Batas yang sama untuk keduanya membuat keduanya tidak dapat
 * dibedakan dari umurnya, terlepas dari jadwal job pembersihan otp_codes (PRD 2.5).
 */
export const OTP_CHALLENGE_RETENTION_MS = 24 * HOUR_MS;
/** Baris pengganti kedaluwarsa yang dibersihkan per penerbitan (bertahap, tanpa job terpisah). */
const DECOY_CLEANUP_BATCH = 100;

/**
 * Challenge aktivasi (kontrak C1, AC F01-3): `signup` dan `email_change` berbagi SATU slot; penerbitan salah satunya
 * membatalkan challenge aktif kedua tujuan dengan baris users terkunci.
 */
export const ACTIVATION_PURPOSES = ["signup", "email_change"] as const satisfies readonly OtpPurpose[];
/**
 * Tujuan yang alurnya tidak boleh mengungkap keadaan email (PRD 2.5; kontrak forgotPassword, startWebDeletion): email
 * yang tidak memenuhi syarat mendapat challenge pengganti, dan email kode nyata dikirim tanpa ditunggu agar waktu
 * respons tidak bergantung pada SMTP.
 */
export const NON_ENUMERATING_PURPOSES = [
  "password_reset",
  "deletion",
] as const satisfies readonly OtpPurpose[];
export type NonEnumeratingPurpose = (typeof NON_ENUMERATING_PURPOSES)[number];

export const isActivation = (purpose: OtpPurpose) =>
  (ACTIVATION_PURPOSES as readonly OtpPurpose[]).includes(purpose);
export const isNonEnumerating = (purpose: OtpPurpose): purpose is NonEnumeratingPurpose =>
  (NON_ENUMERATING_PURPOSES as readonly OtpPurpose[]).includes(purpose);

/**
 * Keadaan akun alumni yang sesuai tujuan challenge (kontrak resendOtp/getOtpChallengeStatus); selain itu 410
 * OTP_EXPIRED. Juga dipakai penerbit: forgotPassword hanya untuk akun `active` (termasuk anggota suspended), hapus akun
 * web untuk akun yang belum selesai dihapus (kontrak startWebDeletion).
 */
export const PURPOSE_ACCOUNT_STATES: Readonly<Record<OtpPurpose, readonly AccountStatus[]>> = {
  signup: ["pending_otp"],
  email_change: ["pending_otp"],
  password_reset: ["active"],
  deletion: ["active", "pending_otp", "deletion_pending", "disabled"],
};

export const otpExpired = (message = "Kode tidak berlaku lagi. Minta kode baru.") =>
  new AppException(410, "OTP_EXPIRED", message);

const resendCooldown = (availableAt: Date, now: Date) => {
  const wait = Math.max(1, Math.ceil((availableAt.getTime() - now.getTime()) / 1000));
  return new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
    retryAfterSeconds: wait,
  });
};

/** Hasil reservasi satu percobaan kode: challenge nyata (punya kode) atau pengganti (tidak pernah cocok). */
export type ReservedAttempt = { kind: "real"; row: OtpRow } | { kind: "decoy"; row: OtpDecoyRow };

/**
 * Siklus hidup challenge OTP untuk semua tujuan (PRD 2.5, AC F01-3; kontrak C1 kepala auth.yaml dan account.yaml):
 * penerbitan dengan baris users terkunci, satu challenge aktif per akun+tujuan (otp_codes_active_key; slot aktivasi
 * signup/email_change), kuota kirim per email dan IP SEBELUM penulisan, cooldown kirim ulang, reservasi percobaan
 * atomik SEBELUM kode dibandingkan, konsumsi dengan seluruh predikat, serta challenge pengganti (otp_decoys) untuk alur
 * non-enumerasi yang berperilaku persis seperti challenge nyata. Dipakai modul auth (registrasi, lupa sandi, koreksi
 * email) dan diekspor untuk alur lain yang memakai OTP yang sama (hapus akun web F-14 tujuan `deletion`, pemulihan
 * sandi oleh Super Admin AC F16-4 tujuan `password_reset`).
 */
@Injectable()
export class OtpChallengeService {
  /** HMAC pembanding untuk challenge pengganti: waktu perbandingan setara challenge nyata. */
  private readonly decoyHmac = randomBytes(32).toString("hex");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly limits: RateLimitService,
  ) {}

  private now() {
    return this.clock.now();
  }

  /**
   * Kunci email untuk kuota kirim dan slot challenge pengganti: HMAC-SHA256 secret server atas email ternormalisasi.
   * Challenge nyata dan pengganti untuk email yang sama memakai kunci yang sama sehingga batas 5 kirim per jam identik
   * (PRD 2.5), tanpa menyimpan email mentah orang yang tidak terdaftar (N-09).
   */
  emailKey(email: string): string {
    return otpEmailKey(this.env.OTP_HMAC_SECRET, email);
  }

  toChallenge(row: OtpRow | OtpDecoyRow, emailMasked: string): OtpChallenge {
    return {
      challenge_id: row.id,
      purpose: row.purpose,
      email_masked: emailMasked,
      expires_at: row.expiresAt.toISOString(),
      resend_available_at: row.resendAvailableAt.toISOString(),
      attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts),
      // Label "Sisa percobaan n dari 5" (prototype screen_1_otp, PRD 2.5).
      max_attempts: OTP_MAX_ATTEMPTS,
    };
  }

  /**
   * Kuota kirim OTP per IP dan per email (PRD 2.5, D1); 429 RATE_LIMITED bila habis. Dipanggil SEBELUM challenge
   * ditulis (tidak ada penulisan bila kuota habis), sama untuk challenge nyata dan pengganti.
   */
  async consumeSendQuota(emailKey: string): Promise<void> {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `otp-ip:${ip}`,
        OTP_SENDS_PER_IP_PER_HOUR,
        HOUR_MS,
        "Terlalu banyak permintaan kode dari jaringan ini. Coba lagi nanti.",
      );
    // Kunci sama dengan otpSendQuotaKey (core): satu bucket per email untuk semua modul (PRD 2.5).
    await this.limits.consumeOrThrow(
      `otp:${emailKey}`,
      OTP_SENDS_PER_HOUR,
      HOUR_MS,
      "Terlalu banyak permintaan kode. Coba lagi nanti.",
    );
  }

  /** Mengunci baris users (FOR NO KEY UPDATE): penerbit challenge bersamaan untuk akun yang sama berurutan. */
  async lockUser(tx: Tx, userId: string): Promise<UserRow | undefined> {
    const [locked] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
    return locked;
  }

  /**
   * Challenge aktif (belum dipakai/diganti/kedaluwarsa) terbaru untuk akun dan salah satu tujuan. Challenge aktivasi
   * dicari pada kedua tujuan slot aktivasi.
   */
  async activeChallenge(db: DbOrTx, userId: string, purposes: readonly OtpPurpose[], now: Date) {
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
   * UPDATE) atau baru menyisipkannya di transaksi yang sama, dan sudah memakai kuota kirim ({@link consumeSendQuota}).
   */
  async createChallenge(
    tx: Tx,
    user: { id: string; passwordHash: string },
    purpose: OtpPurpose,
    now: Date,
  ): Promise<{ row: OtpRow; code: string }> {
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

  /**
   * Mengirim kode ke email akun. Alur non-enumerasi tidak menunggu SMTP agar waktu respons tidak membedakan email
   * terdaftar dari challenge pengganti (PRD 2.5); kegagalan kirim dicatat tanpa email/kode (N-14) dan pengguna dapat
   * meminta kirim ulang. Alur lain menunggu pengiriman (ADR-004: OTP dikirim sinkron oleh API).
   */
  async deliver(email: string, code: string, purpose: OtpPurpose, challengeId: string): Promise<void> {
    if (!isNonEnumerating(purpose)) {
      await this.mailer.sendOtp(email, code, purpose);
      return;
    }
    void this.mailer.sendOtp(email, code, purpose).catch((error: unknown) => {
      this.logger.error(
        { error: safeError(error), purpose, challenge_id: challengeId },
        "pengiriman email OTP gagal; pengguna dapat meminta kirim ulang",
      );
    });
  }

  /**
   * Menerbitkan challenge untuk akun alumni yang sudah ada dalam satu transaksi dengan baris users terkunci.
   * - `replacing`: kirim ulang challenge itu (kontrak resendOtp): sudah diganti/dipakai oleh permintaan bersamaan →
   *   410 seperti permintaan berurutan; sebelum `resend_available_at` → 429.
   * - `reuseActive`: challenge aktif bertujuan sama yang masih dalam cooldown 60 detik dikembalikan apa adanya tanpa
   *   email baru (permintaan ganda tidak mengirim kode baru); percobaannya habis → 429 sampai cooldown lewat.
   * Akun yang tidak lagi pada keadaan yang sesuai tujuan → 410. Kuota kirim dipakai sebelum challenge ditulis.
   */
  async issueForAccount(
    userId: string,
    purpose: OtpPurpose,
    options: { replacing?: string; reuseActive?: boolean } = {},
  ): Promise<OtpChallenge> {
    const now = this.now();
    const issued = await this.db.transaction(async (tx) => {
      const locked = await this.lockUser(tx, userId);
      if (!locked || locked.kind !== "alumni" || !PURPOSE_ACCOUNT_STATES[purpose].includes(locked.status))
        throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang atau masuk kembali.");
      if (options.replacing) {
        const [current] = await tx
          .select({
            consumedAt: otpCodes.consumedAt,
            supersededAt: otpCodes.supersededAt,
            resendAvailableAt: otpCodes.resendAvailableAt,
          })
          .from(otpCodes)
          .where(and(eq(otpCodes.id, options.replacing), eq(otpCodes.userId, locked.id)));
        if (!current || current.consumedAt || current.supersededAt)
          throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
        if (current.resendAvailableAt > now) throw resendCooldown(current.resendAvailableAt, now);
      } else if (options.reuseActive) {
        const active = await this.activeChallenge(
          tx,
          locked.id,
          isActivation(purpose) ? ACTIVATION_PURPOSES : [purpose],
          now,
        );
        if (active && active.resendAvailableAt > now) {
          if (active.attempts >= OTP_MAX_ATTEMPTS) throw resendCooldown(active.resendAvailableAt, now);
          return { row: active, code: null, email: locked.email };
        }
      }
      await this.consumeSendQuota(this.emailKey(locked.email));
      if (isNonEnumerating(purpose)) await this.cleanupDecoys(tx, now);
      const created = await this.createChallenge(tx, locked, purpose, now);
      // Email dari baris terkunci: koreksi email bersamaan tidak membuat kode terkirim ke alamat lama.
      return { ...created, email: locked.email };
    });
    if (issued.code) await this.deliver(issued.email, issued.code, purpose, issued.row.id);
    return this.toChallenge(issued.row, maskEmail(issued.email));
  }

  /**
   * Challenge pengganti untuk email yang tidak memenuhi syarat (kontrak forgotPassword, startWebDeletion, resendOtp):
   * bentuk, cooldown, kuota kirim per email/IP, percobaan dan waktu respons sama dengan challenge nyata, tetapi tidak
   * ada email yang dikirim dan tidak ada kode yang pernah cocok. Penerbit bersamaan untuk (email, tujuan) yang sama
   * berurutan lewat kunci advisory, cermin kunci baris users pada challenge nyata.
   */
  async issueDecoy(
    email: string,
    purpose: NonEnumeratingPurpose,
    options: { replacing?: string; reuseActive?: boolean } = {},
  ): Promise<OtpChallenge> {
    const normalized = normalizeEmail(email);
    return this.issueDecoyByKey(this.emailKey(normalized), maskEmail(normalized), purpose, options);
  }

  private async issueDecoyByKey(
    emailKey: string,
    emailMasked: string,
    purpose: NonEnumeratingPurpose,
    options: { replacing?: string; reuseActive?: boolean },
  ): Promise<OtpChallenge> {
    const now = this.now();
    const row = await this.db.transaction(async (tx) => {
      await advisoryXactLockFor(tx, ADVISORY_LOCK_NAMESPACES.otpDecoy, `${purpose}:${emailKey}`);
      if (options.replacing) {
        const [current] = await tx
          .select({ supersededAt: otpDecoys.supersededAt, resendAvailableAt: otpDecoys.resendAvailableAt })
          .from(otpDecoys)
          .where(eq(otpDecoys.id, options.replacing));
        if (!current || current.supersededAt)
          throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
        if (current.resendAvailableAt > now) throw resendCooldown(current.resendAvailableAt, now);
      } else if (options.reuseActive) {
        const [active] = await tx
          .select()
          .from(otpDecoys)
          .where(
            and(
              eq(otpDecoys.emailKey, emailKey),
              eq(otpDecoys.purpose, purpose),
              isNull(otpDecoys.supersededAt),
              gt(otpDecoys.expiresAt, now),
            ),
          )
          .limit(1);
        if (active && active.resendAvailableAt > now) {
          if (active.attempts >= OTP_MAX_ATTEMPTS) throw resendCooldown(active.resendAvailableAt, now);
          return active;
        }
      }
      await this.consumeSendQuota(emailKey);
      await this.cleanupDecoys(tx, now);
      await tx
        .update(otpDecoys)
        .set({ supersededAt: now })
        .where(
          and(
            eq(otpDecoys.emailKey, emailKey),
            eq(otpDecoys.purpose, purpose),
            isNull(otpDecoys.supersededAt),
          ),
        );
      const [inserted] = await tx
        .insert(otpDecoys)
        .values({
          id: uuidv7(),
          purpose,
          emailKey,
          emailMasked,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
          resendAvailableAt: new Date(now.getTime() + OTP_RESEND_MS),
          createdAt: now,
        })
        .returning();
      return inserted!;
    });
    return this.toChallenge(row, row.emailMasked);
  }

  /**
   * Membersihkan bertahap baris pengganti yang melewati masa simpan (tanpa job terpisah). SKIP LOCKED: pembersih
   * bersamaan tidak saling menunggu atau deadlock. Dijalankan pada penerbitan nyata maupun pengganti (waktu setara).
   */
  private async cleanupDecoys(tx: Tx, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - OTP_CHALLENGE_RETENTION_MS);
    const stale = tx
      .select({ id: otpDecoys.id })
      .from(otpDecoys)
      .where(lt(otpDecoys.createdAt, cutoff))
      .orderBy(otpDecoys.createdAt)
      .limit(DECOY_CLEANUP_BATCH)
      .for("update", { skipLocked: true });
    await tx.delete(otpDecoys).where(inArray(otpDecoys.id, stale));
  }

  /** Akun alumni masih pada keadaan yang sesuai tujuan challenge (dan, untuk aktivasi, sandinya belum berubah). */
  private challengeStillValidFor(row: OtpRow, user: UserRow | undefined): user is UserRow {
    if (!user || user.kind !== "alumni" || !PURPOSE_ACCOUNT_STATES[row.purpose].includes(user.status))
      return false;
    return !isActivation(row.purpose) || row.binding === sha256(user.passwordHash);
  }

  private async findReal(challengeId: string, now: Date): Promise<OtpRow | undefined> {
    return this.db.query.otpCodes.findFirst({
      where: and(
        eq(otpCodes.id, challengeId),
        gt(otpCodes.createdAt, new Date(now.getTime() - OTP_CHALLENGE_RETENTION_MS)),
      ),
    });
  }

  private async findDecoy(challengeId: string, now: Date): Promise<OtpDecoyRow | undefined> {
    return this.db.query.otpDecoys.findFirst({
      where: and(
        eq(otpDecoys.id, challengeId),
        gt(otpDecoys.createdAt, new Date(now.getTime() - OTP_CHALLENGE_RETENTION_MS)),
      ),
    });
  }

  /**
   * Keadaan challenge tanpa mengirim, mengganti, atau mengonsumsi kode (kontrak getOtpChallengeStatus; AC F16-4,
   * F01-3). 200 tepat ketika kirim ulang masih dapat menerima challenge ini (termasuk yang kedaluwarsa atau
   * percobaannya habis); 410 tepat ketika kirim ulang juga 410. Challenge pengganti tidak dapat dibedakan. Batas per IP
   * terpisah dari batas kirim OTP.
   */
  async status(challengeId: string): Promise<OtpChallenge> {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `otp-status-ip:${ip}`,
        OTP_STATUS_PER_IP,
        LOGIN_WINDOW_MS,
        "Terlalu banyak permintaan dari jaringan ini. Coba lagi nanti.",
      );
    const now = this.now();
    const real = await this.findReal(challengeId, now);
    if (real) {
      if (real.consumedAt || real.supersededAt) throw otpExpired();
      const user = await this.db.query.users.findFirst({ where: eq(users.id, real.userId) });
      if (!this.challengeStillValidFor(real, user)) throw otpExpired();
      return this.toChallenge(real, maskEmail(user.email));
    }
    const decoy = await this.findDecoy(challengeId, now);
    if (decoy && !decoy.supersededAt) return this.toChallenge(decoy, decoy.emailMasked);
    throw otpExpired();
  }

  /**
   * Kirim ulang (PRD 2.5, AC F01-3; kontrak resendOtp) untuk semua tujuan: challenge baru bertujuan sama menggantikan
   * yang lama secara atomik. 410 bila challenge sudah dipakai/diganti/tidak dikenal, sandi akun berubah sejak challenge
   * aktivasi dibuat, atau akun tidak lagi pada keadaan yang sesuai tujuan; 429 sebelum `resend_available_at` atau bila
   * batas kirim habis. Challenge pengganti menghasilkan challenge pengganti baru dengan aturan yang sama tanpa email.
   */
  async resend(challengeId: string): Promise<OtpChallenge> {
    const now = this.now();
    const real = await this.findReal(challengeId, now);
    if (real) {
      if (real.consumedAt) throw otpExpired("Mulai ulang pendaftaran atau masuk kembali.");
      if (real.supersededAt) throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
      const user = await this.db.query.users.findFirst({ where: eq(users.id, real.userId) });
      if (!this.challengeStillValidFor(real, user))
        throw otpExpired("Kode ini tidak berlaku lagi. Mulai ulang atau masuk kembali.");
      if (real.resendAvailableAt > now) throw resendCooldown(real.resendAvailableAt, now);
      return this.issueForAccount(user.id, real.purpose, { replacing: real.id });
    }
    const decoy = await this.findDecoy(challengeId, now);
    if (!decoy || decoy.supersededAt || !isNonEnumerating(decoy.purpose))
      throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    if (decoy.resendAvailableAt > now) throw resendCooldown(decoy.resendAvailableAt, now);
    return this.issueDecoyByKey(decoy.emailKey, decoy.emailMasked, decoy.purpose, { replacing: decoy.id });
  }

  /**
   * Mencadangkan SATU percobaan secara atomik SEBELUM kode dibandingkan (`attempts < 5` di predikat UPDATE ...
   * RETURNING, PRD 2.5): permintaan paralel tidak dapat menilai lebih dari 5 kode per challenge dan tidak pernah
   * melanggar CHECK attempts. Hanya challenge aktif (belum dipakai/diganti/kedaluwarsa) dengan tujuan yang diminta;
   * selain itu null (410 di pemanggil, tanpa memakai jatah challenge tujuan lain).
   */
  async reserveAttempt(
    challengeId: string,
    purposes: readonly OtpPurpose[],
    now: Date,
  ): Promise<ReservedAttempt | null> {
    const [real] = await this.db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(
        and(
          eq(otpCodes.id, challengeId),
          inArray(otpCodes.purpose, [...purposes]),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
          gt(otpCodes.expiresAt, now),
          lt(otpCodes.attempts, OTP_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (real) return { kind: "real", row: real };
    const decoyPurposes = purposes.filter(isNonEnumerating);
    if (decoyPurposes.length === 0) return null;
    const [decoy] = await this.db
      .update(otpDecoys)
      .set({ attempts: sql`${otpDecoys.attempts} + 1` })
      .where(
        and(
          eq(otpDecoys.id, challengeId),
          inArray(otpDecoys.purpose, decoyPurposes),
          isNull(otpDecoys.supersededAt),
          gt(otpDecoys.expiresAt, now),
          lt(otpDecoys.attempts, OTP_MAX_ATTEMPTS),
        ),
      )
      .returning();
    return decoy ? { kind: "decoy", row: decoy } : null;
  }

  /**
   * Menilai kode untuk salah satu tujuan (PRD 2.5): jatah kegagalan per IP dicadangkan atomik sebelum kode dinilai
   * (dikembalikan bila kode benar atau challenge tidak dapat dicoba), lalu satu percobaan challenge dicadangkan atomik.
   * Kode salah → 400 VALIDATION_ERROR `field_errors.code` dengan sisa percobaan; percobaan terakhir salah atau challenge
   * tidak berlaku → 410 OTP_EXPIRED. Challenge pengganti selalu salah. Mengembalikan baris challenge nyata yang kodenya
   * cocok; pemanggil WAJIB mengonsumsinya ({@link consume}) di dalam transaksi perubahan keadaan.
   */
  async verifyCode(challengeId: string, code: string, purposes: readonly OtpPurpose[]): Promise<OtpRow> {
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
    let reserved: ReservedAttempt | null;
    try {
      reserved = await this.reserveAttempt(challengeId, purposes, now);
    } catch (error) {
      await ipSlot?.release();
      throw error;
    }
    if (!reserved) {
      // Tidak ada kode yang dinilai: bukan kegagalan tebakan.
      await ipSlot?.release();
      throw otpExpired();
    }
    const expected = reserved.kind === "real" ? reserved.row.codeHmac : this.decoyHmac;
    const matches = safeEqualHex(expected, otpHmac(this.env.OTP_HMAC_SECRET, reserved.row.id, code));
    if (reserved.kind === "decoy" || !matches) {
      // Kode salah: jatah IP tetap tercatat sebagai kegagalan.
      const left = OTP_MAX_ATTEMPTS - reserved.row.attempts;
      if (left <= 0) throw otpExpired();
      const message = `Kode salah. Sisa percobaan ${left}.`;
      throw new AppException(400, "VALIDATION_ERROR", message, { fieldErrors: { code: [message] } });
    }
    await ipSlot?.release();
    return reserved.row;
  }

  /**
   * Konsumsi sekali secara atomik dengan seluruh predikat (milik akun, tujuan, belum dipakai/diganti/kedaluwarsa;
   * PRD 2.5). false bila challenge diganti/kedaluwarsa/dipakai di antara verifikasi dan konsumsi.
   */
  async consume(tx: Tx, row: Pick<OtpRow, "id" | "userId" | "purpose">, now: Date): Promise<boolean> {
    const consumed = await tx
      .update(otpCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(otpCodes.id, row.id),
          eq(otpCodes.userId, row.userId),
          eq(otpCodes.purpose, row.purpose),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
          gt(otpCodes.expiresAt, now),
        ),
      )
      .returning({ id: otpCodes.id });
    return consumed.length > 0;
  }

  /** Membatalkan challenge aktif bertujuan tertentu milik akun (mis. setelah sandi berganti). */
  async supersedeActive(tx: Tx, userId: string, purposes: readonly OtpPurpose[], now: Date): Promise<void> {
    await tx
      .update(otpCodes)
      .set({ supersededAt: now })
      .where(
        and(
          eq(otpCodes.userId, userId),
          inArray(otpCodes.purpose, [...purposes]),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ),
      );
  }
}
