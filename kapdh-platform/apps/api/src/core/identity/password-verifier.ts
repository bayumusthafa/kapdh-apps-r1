import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import { users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, ne } from "drizzle-orm";
import { tryCtx } from "../context/request-context.js";
import type { Db, DbOrTx } from "../db/types.js";
import { unauthenticated } from "../errors/app-exception.js";
import { RateLimitService, type RateLimitSlot } from "../rate-limit/rate-limit.service.js";
import { DB, ENV } from "../tokens.js";
import { normalizeEmail } from "./email.js";
import { randomToken } from "./crypto.js";

/** PRD 2.5 / D1: 10 kegagalan login per email dalam 15 menit memicu cooldown 15 menit. */
export const LOGIN_FAILS_LIMIT = 10;
/** D1: batas kegagalan login per IP (lima kali batas per email) dalam jendela yang sama. */
export const LOGIN_FAILS_PER_IP = LOGIN_FAILS_LIMIT * 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** PRD 2.5: sandi maksimal 72 byte UTF-8 (batas bcrypt); server menolak, bukan memotong. */
export const PASSWORD_MAX_BYTES = 72;

const TOO_MANY_LOGINS = "Terlalu banyak percobaan masuk. Coba lagi nanti atau gunakan lupa password.";

export type UserRow = typeof users.$inferSelect;
export type IdentityKind = "alumni" | "admin";

/** Percobaan login yang jatahnya sudah dicadangkan (lihat {@link PasswordVerifier.beginAttempt}). */
export interface LoginAttempt {
  /** Kredensial benar: penghitung kegagalan email direset dan jatah IP dikembalikan. */
  succeeded(): Promise<void>;
  /** Tidak ada kredensial yang dinilai tuntas (galat infrastruktur): kedua jatah dikembalikan. */
  cancel(): Promise<void>;
}

/**
 * Pemeriksaan sandi bersama login alumni (modul auth) dan tahap sandi admin (modul admin-auth), milik core agar kedua
 * modul tidak menyunting berkas yang sama (ARCHITECTURE §4.1, §4.2).
 *
 * Batas kegagalan (PRD 2.5, D1; AC F02-2) memakai RESERVASI ATOMIK sebelum bcrypt: jatah `login:<email>` dan
 * `login-ip:<ip>` sudah tercatat ketika sandi dibandingkan, sehingga permintaan paralel tidak dapat menilai lebih dari
 * batas (pola lama peek → bcrypt → hit dapat dilewati). Sandi benar mereset penghitung email dan mengembalikan jatah
 * IP; sandi salah membiarkan jatah tercatat sebagai kegagalan. Waktu respons email terdaftar/tidak terdaftar setara
 * (hash tiruan dengan cost yang sama, anti enumerasi).
 */
@Injectable()
export class PasswordVerifier {
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly limits: RateLimitService,
  ) {}

  /** Hash tiruan dengan BCRYPT_COST yang sama dengan hash asli (anti enumerasi lewat waktu, PRD 2.5). */
  private dummyPasswordHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(randomToken(), this.env.BCRYPT_COST);
    return this.dummyHash;
  }

  /** Akun belum terhapus untuk email (sudah dinormalisasi) dan jenis identitas (users_kind_email_key, PRD 2.3). */
  findAccount(db: DbOrTx, email: string, kind: IdentityKind): Promise<UserRow | undefined> {
    return db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.kind, kind), ne(users.status, "deleted")),
    });
  }

  /**
   * Mencadangkan satu jatah kegagalan per email dan per IP (IP dari konteks request) SEBELUM verifikasi; 429
   * RATE_LIMITED bila salah satu habis. Dipakai juga oleh alur lain yang menghitung ke batas login (mis. sandi lama
   * salah pada ganti sandi, kontrak changePassword).
   */
  async beginAttempt(email: string, ip: string | null = tryCtx()?.ip ?? null): Promise<LoginAttempt> {
    const normalized = normalizeEmail(email);
    const emailSlot = await this.limits.reserveOrThrow(
      `login:${normalized}`,
      LOGIN_FAILS_LIMIT,
      LOGIN_WINDOW_MS,
      TOO_MANY_LOGINS,
    );
    let ipSlot: RateLimitSlot | null = null;
    if (ip) {
      try {
        ipSlot = await this.limits.reserveOrThrow(
          `login-ip:${ip}`,
          LOGIN_FAILS_PER_IP,
          LOGIN_WINDOW_MS,
          TOO_MANY_LOGINS,
        );
      } catch (error) {
        await emailSlot.release();
        throw error;
      }
    }
    return {
      succeeded: async () => {
        await this.limits.reset(`login:${normalized}`);
        await ipSlot?.release();
      },
      cancel: async () => {
        await emailSlot.release();
        await ipSlot?.release();
      },
    };
  }

  /** bcrypt.compare dengan penolakan sandi > 72 byte (waktu tetap setara karena hash tiruan dibandingkan). */
  async comparePassword(password: string, hash: string | null | undefined): Promise<boolean> {
    const tooLong = Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES;
    const matches = await bcrypt.compare(password, hash && !tooLong ? hash : await this.dummyPasswordHash());
    return matches && !tooLong && !!hash;
  }

  /**
   * Login dengan email + sandi untuk satu jenis identitas. `isAllowed` menilai keadaan akun sesudah sandi cocok (mis.
   * admin `active` dengan TOTP terverifikasi); akun yang tidak diizinkan diperlakukan PERSIS seperti sandi salah
   * (401 yang sama, kegagalan tetap tercatat) agar keabsahan sandi tidak dapat ditebak dari perilaku rate limit.
   *
   *   const user = await passwords.verify(body.email, body.password, "alumni", (u) => u.status !== "deleted");
   */
  async verify(
    emailRaw: string,
    password: string,
    kind: IdentityKind,
    isAllowed: (user: UserRow) => boolean | Promise<boolean>,
  ): Promise<UserRow> {
    const email = normalizeEmail(emailRaw);
    const attempt = await this.beginAttempt(email);
    let user: UserRow | undefined;
    let allowed = false;
    try {
      user = await this.findAccount(this.db, email, kind);
      const matches = await this.comparePassword(password, user?.passwordHash);
      allowed = !!user && matches && (await isAllowed(user));
    } catch (error) {
      await attempt.cancel().catch(() => undefined);
      throw error;
    }
    // Gagal: jatah yang sudah dicadangkan tetap tercatat sebagai kegagalan.
    if (!user || !allowed) throw unauthenticated("Email atau password salah.");
    await attempt.succeeded();
    return user;
  }
}
