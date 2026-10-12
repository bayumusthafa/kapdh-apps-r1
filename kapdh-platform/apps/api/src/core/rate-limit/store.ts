import { createHash } from "node:crypto";

/**
 * Penyimpanan rate limit sliding window (PRD 2.5, D1). Waktu (`nowMs`) dikirim pemanggil dari Clock aplikasi.
 * Semua nilai kembalian dalam milidetik tunggu; 0 berarti boleh.
 */
export interface RateLimitStore {
  /** Atomik: bila jumlah hit dalam jendela < limit, catat satu hit dan kembalikan 0; selain itu ms tunggu. */
  consume(key: string, limit: number, windowMs: number, nowMs: number): Promise<number>;
  /** Seperti consume tetapi tanpa mencatat hit (mis. memeriksa kuota gagal login sebelum mencoba). */
  peek(key: string, limit: number, windowMs: number, nowMs: number): Promise<number>;
  /** Mencatat satu hit tanpa syarat (mis. setiap kegagalan login). */
  hit(key: string, windowMs: number, nowMs: number): Promise<void>;
  /** Menghapus seluruh hit sebuah kunci (mis. login berhasil). */
  reset(key: string): Promise<void>;
}

/** Batas hit yang disimpan per kunci; cukup untuk semua limit PRD dan menjaga memori/Redis terbatas. */
export const MAX_HITS_PER_KEY = 1000;

/**
 * Nama kunci penyimpanan: material kunci (email, IP) di-hash agar Redis/memori tidak menyimpan PII mentah
 * (PRD 5.5). Awalan semantik (`otp`, `login`) tetap terbaca untuk diagnosis.
 */
export function storageKey(key: string): string {
  const separator = key.indexOf(":");
  const scope = separator > 0 ? key.slice(0, separator) : "rl";
  const digest = createHash("sha256").update(key).digest("base64url").slice(0, 32);
  return `kapdh:rl:${scope}:${digest}`;
}

interface Bucket {
  /** Waktu hit, urut naik. */
  hits: number[];
  windowMs: number;
}

/**
 * Implementasi memori (development/test, satu instance). Kunci yang kosong atau seluruh hit-nya kedaluwarsa
 * dibuang saat diakses dan lewat sapuan berkala, sehingga memori tidak tumbuh tanpa batas oleh kunci acak
 * (perbaikan audit core: Map lama tidak pernah dipangkas).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private operations = 0;

  constructor(private readonly sweepEvery = 500) {}

  private prune(key: string, nowMs: number, windowMs?: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) return undefined;
    if (windowMs !== undefined) bucket.windowMs = Math.max(bucket.windowMs, windowMs);
    const cutoff = nowMs - bucket.windowMs;
    let drop = 0;
    while (drop < bucket.hits.length && bucket.hits[drop]! <= cutoff) drop++;
    if (drop > 0) bucket.hits.splice(0, drop);
    if (bucket.hits.length === 0) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private maybeSweep(nowMs: number) {
    if (++this.operations % this.sweepEvery !== 0) return;
    for (const key of [...this.buckets.keys()]) this.prune(key, nowMs);
  }

  private wait(bucket: Bucket | undefined, limit: number, windowMs: number, nowMs: number): number {
    if (!bucket) return 0;
    const cutoff = nowMs - windowMs;
    let first = 0;
    while (first < bucket.hits.length && bucket.hits[first]! <= cutoff) first++;
    if (bucket.hits.length - first < limit) return 0;
    // Saat hit ke-(n - limit) kedaluwarsa, jumlah dalam jendela turun di bawah limit.
    const pivot = bucket.hits[bucket.hits.length - limit]!;
    return Math.max(1, pivot + windowMs - nowMs);
  }

  private record(key: string, windowMs: number, nowMs: number) {
    const bucket = this.buckets.get(key) ?? { hits: [], windowMs };
    bucket.windowMs = Math.max(bucket.windowMs, windowMs);
    bucket.hits.push(nowMs);
    if (bucket.hits.length > 1 && bucket.hits[bucket.hits.length - 2]! > nowMs)
      bucket.hits.sort((a, b) => a - b);
    if (bucket.hits.length > MAX_HITS_PER_KEY) bucket.hits.splice(0, bucket.hits.length - MAX_HITS_PER_KEY);
    this.buckets.set(key, bucket);
  }

  async consume(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    this.maybeSweep(nowMs);
    const id = storageKey(key);
    const wait = this.wait(this.prune(id, nowMs, windowMs), limit, windowMs, nowMs);
    if (wait === 0) this.record(id, windowMs, nowMs);
    return wait;
  }

  async peek(key: string, limit: number, windowMs: number, nowMs: number): Promise<number> {
    this.maybeSweep(nowMs);
    const id = storageKey(key);
    return this.wait(this.prune(id, nowMs, windowMs), limit, windowMs, nowMs);
  }

  async hit(key: string, windowMs: number, nowMs: number): Promise<void> {
    this.maybeSweep(nowMs);
    const id = storageKey(key);
    this.prune(id, nowMs, windowMs);
    this.record(id, windowMs, nowMs);
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(storageKey(key));
  }

  /** Untuk uji: kosongkan semua kunci (reset per tes oleh harness). */
  clear(): void {
    this.buckets.clear();
  }

  /** Untuk uji: jumlah kunci yang masih disimpan. */
  get size(): number {
    return this.buckets.size;
  }
}
