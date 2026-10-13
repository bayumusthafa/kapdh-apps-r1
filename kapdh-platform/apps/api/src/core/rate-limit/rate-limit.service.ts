import { Inject, Injectable } from "@nestjs/common";
import type { Clock } from "../adapters/clock.js";
import { rateLimited } from "../errors/app-exception.js";
import { CLOCK, RATE_LIMIT_STORE } from "../tokens.js";
import type { RateLimitStore } from "./store.js";

const toSeconds = (ms: number) => (ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 1000)));

/**
 * Rate limit async (PRD 2.5, D1; ARCHITECTURE §4.2): penyimpanan memori di development/test, Redis bila REDIS_URL
 * diisi (wajib di production). Semua nilai kembalian dalam DETIK tunggu (0 = boleh), siap untuk Retry-After.
 *
 * Kunci berbentuk `<cakupan>:<identitas>`, mis. `otp:<email>`, `login-ip:<ip>`; identitas di-hash oleh store.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private now(): number {
    return this.clock.now().getTime();
  }

  /** Mengambil satu jatah. 0 = diizinkan dan tercatat; > 0 = detik tunggu (tidak tercatat). */
  async consume(key: string, limit: number, windowMs: number): Promise<number> {
    return toSeconds(await this.store.consume(key, limit, windowMs, this.now()));
  }

  /** Memeriksa tanpa mencatat. */
  async peek(key: string, limit: number, windowMs: number): Promise<number> {
    return toSeconds(await this.store.peek(key, limit, windowMs, this.now()));
  }

  /** Mencatat satu hit tanpa syarat (mis. kegagalan login); mengembalikan jumlah hit dalam jendela sesudahnya. */
  async hit(key: string, windowMs: number): Promise<number> {
    return this.store.hit(key, windowMs, this.now());
  }

  async reset(key: string): Promise<void> {
    await this.store.reset(key);
  }

  /** consume, lalu 429 RATE_LIMITED + Retry-After bila habis. */
  async consumeOrThrow(key: string, limit: number, windowMs: number, message?: string): Promise<void> {
    const wait = await this.consume(key, limit, windowMs);
    if (wait > 0) throw rateLimited(wait, message);
  }

  /**
   * peek, lalu 429 RATE_LIMITED bila sudah melewati batas (tanpa mencatat hit). HANYA untuk pemeriksaan murah yang
   * tidak melindungi verifikasi rahasia: pola peek → verifikasi → hit dapat dilewati permintaan paralel (semua lolos
   * peek sebelum kegagalan pertama tercatat). Batas kegagalan (login, TOTP, OTP) memakai {@link reserveOrThrow}.
   */
  async assertNotLimited(key: string, limit: number, windowMs: number, message?: string): Promise<void> {
    const wait = await this.peek(key, limit, windowMs);
    if (wait > 0) throw rateLimited(wait, message);
  }

  /**
   * Reservasi atomik satu jatah SEBELUM verifikasi mahal/rahasia (PRD 2.5, D1; ARCHITECTURE §2 butir 11): jatah sudah
   * tercatat ketika verifikasi berjalan, sehingga N permintaan paralel menilai paling banyak `limit` percobaan. Hasil:
   * `wait` detik (> 0 = ditolak, tidak tercatat), atau slot dengan `count` (jumlah dalam jendela termasuk slot ini)
   * dan `release()` untuk mengembalikan jatah bila percobaan ternyata bukan kegagalan.
   *
   *   const slot = await limits.reserveOrThrow(`mfa:${userId}`, 5, 15 * 60_000, "Terlalu banyak percobaan.");
   *   if (await codeIsValid()) await slot.release(); // berhasil: tidak dihitung gagal
   *   else throw wrongCode(5 - slot.count);          // gagal: jatah tetap tercatat
   */
  async reserve(key: string, limit: number, windowMs: number): Promise<RateLimitReservation> {
    const acquired = await this.store.acquire(key, limit, windowMs, this.now());
    if (acquired.waitMs > 0 || acquired.ticket === null)
      return { wait: toSeconds(Math.max(1, acquired.waitMs)), slot: null };
    const ticket = acquired.ticket;
    let released = false;
    return {
      wait: 0,
      slot: {
        count: acquired.count,
        release: async () => {
          if (released) return;
          released = true;
          await this.store.release(key, ticket);
        },
      },
    };
  }

  /** {@link reserve}, lalu 429 RATE_LIMITED + Retry-After bila habis. */
  async reserveOrThrow(
    key: string,
    limit: number,
    windowMs: number,
    message?: string,
  ): Promise<RateLimitSlot> {
    const { wait, slot } = await this.reserve(key, limit, windowMs);
    if (!slot) throw rateLimited(wait, message);
    return slot;
  }
}

/** Jatah yang sudah tercatat oleh {@link RateLimitService.reserve}. */
export interface RateLimitSlot {
  /** Jumlah hit dalam jendela termasuk slot ini (untuk "sisa percobaan n"). */
  count: number;
  /** Mengembalikan jatah (idempoten), mis. percobaan berhasil atau tidak ada kredensial yang dinilai. */
  release(): Promise<void>;
}

export interface RateLimitReservation {
  /** Detik tunggu; 0 bila slot diperoleh. */
  wait: number;
  slot: RateLimitSlot | null;
}
