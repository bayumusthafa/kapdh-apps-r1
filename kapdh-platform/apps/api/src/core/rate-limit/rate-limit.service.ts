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

  /** peek, lalu 429 RATE_LIMITED bila sudah melewati batas (tanpa mencatat hit). */
  async assertNotLimited(key: string, limit: number, windowMs: number, message?: string): Promise<void> {
    const wait = await this.peek(key, limit, windowMs);
    if (wait > 0) throw rateLimited(wait, message);
  }
}
